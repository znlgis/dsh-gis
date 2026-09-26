/**
 * Connecting to a profile (T3.2).
 *
 * Three properties are established HERE rather than left to every caller:
 *
 * 1. **Read-only by default.** The session is opened with
 *    \`default_transaction_read_only = on\`, so a write fails in the DATABASE, not
 *    in a code review. Reading a viewer's connection should not be able to modify
 *    the source of truth even if a later query is wrong.
 * 2. **A statement cap.** \`statement_timeout\` comes from the profile, so a slow
 *    query is cut off by the server instead of holding a UI open (T3.3 turns the
 *    resulting error into \`SQL_TIMEOUT\`).
 * 3. **Secrets never travel outward.** Every error this module raises has been
 *    through the profile's redactor, because driver errors quote the connection
 *    string and a log line is as public as a screenshot.
 */
import type { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg'
import { GisError } from '@znlgis/dsh-gis-core'
import type { PostgisProfiles, ResolvedConnection } from './profiles.ts'

/** The slice of the driver this module needs; a pool and a client both satisfy it. */
export interface Queryable {
  /**
   * @param text - the SQL text.
   * @param values - bound parameters, never interpolated.
   * @returns the driver result.
   */
  query<R extends QueryResultRow = QueryResultRow>(text: string, values?: readonly unknown[]): Promise<QueryResult<R>>
}

/** A connection that must be released. */
export interface LeasedClient {
  /** The client to run queries on. */
  readonly client: PoolClient
  /** Return it to the pool. */
  release(): void
}

/** Opens connections for one profile. */
export class PostgisConnection {
  private pool: Pool | undefined

  /**
   * @param connection - the resolved connection, including its secret.
   * @param profiles - the redactor, so no error leaves here with a secret in it.
   */
  constructor(
    private readonly connection: ResolvedConnection,
    private readonly profiles: PostgisProfiles,
  ) {}

  /** The profile this connection belongs to. */
  get profile(): string {
    return this.connection.profile
  }

  /** Whether the pool has been opened. */
  get open(): boolean {
    return this.pool !== undefined
  }

  /**
   * Open the pool.
   *
   * \`options\` rather than \`options\`-per-query: the read-only default and the
   * statement cap belong to the session, and setting them here means every query
   * this pool ever runs inherits them.
   * @returns the pool.
   */
  private async connect(): Promise<Pool> {
    if (this.pool !== undefined) return this.pool
    const { Pool: PgPool } = await import('pg')
    const pool = new PgPool({
      host: this.connection.host,
      port: this.connection.port,
      database: this.connection.database,
      user: this.connection.user,
      ...this.connection.password === undefined ? {} : { password: this.connection.password },
      ssl: this.connection.ssl ? { rejectUnauthorized: false } : false,
      connectionTimeoutMillis: this.connection.connectTimeoutMs,
      max: 4,
      options: '-c default_transaction_read_only=on -c statement_timeout=' + String(this.connection.statementTimeoutMs),
    })
    // A pool emits errors on idle clients; without a listener Node treats them as
    // unhandled and the process dies.
    pool.on('error', () => {})
    this.pool = pool
    return pool
  }

  /**
   * Run one query.
   * @param text - SQL text with $1-style placeholders.
   * @param values - bound parameters.
   * @returns the driver result.
   * @throws GisError \`PG_CONNECT_FAILED\` or \`PG_QUERY_FAILED\`, with the secret redacted.
   */
  async query<R extends QueryResultRow = QueryResultRow>(text: string, values: readonly unknown[] = []): Promise<QueryResult<R>> {
    const pool = await this.connect()
    try {
      return await pool.query<R>(text, values as unknown[])
    } catch (error) {
      throw this.wrap(error)
    }
  }

  /** Check that the connection works, without leaking why it did not. */
  async ping(): Promise<{ readonly ok: true; readonly serverVersion: string } | { readonly ok: false; readonly reason: string }> {
    try {
      const result = await this.query<{ version: string }>('SELECT version() AS version')
      return { ok: true, serverVersion: String(result.rows[0]?.version ?? 'unknown') }
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : String(error) }
    }
  }

  /** Close the pool. */
  async close(): Promise<void> {
    const pool = this.pool
    this.pool = undefined
    if (pool !== undefined) await pool.end().catch(() => {})
  }

  /**
   * Turn a driver failure into a redacted GIS error.
   * @param error - whatever the driver threw.
   * @returns the error to throw.
   */
  private wrap(error: unknown): GisError {
    const raw = error instanceof Error ? error.message : String(error)
    // A statement cap is not a failure of the query but of its cost, and callers
    // need to tell them apart (T3.3 reports SQL_TIMEOUT).
    const timedOut = /statement timeout|canceling statement due to statement timeout/iu.test(raw)
    const redacted = this.profiles.redact(raw, [this.connection.password])
    return timedOut
      ? new GisError('SQL_TIMEOUT', 'the query exceeded this profile\'s statement timeout: ' + redacted)
      : new GisError('PG_QUERY_FAILED', redacted)
  }
}

/** One connection per profile, opened on demand and closed together. */
export class PostgisConnections {
  private readonly byProfile = new Map<string, PostgisConnection>()

  /**
   * @param profiles - the profile resolver.
   */
  constructor(private readonly profiles: PostgisProfiles) {}

  /**
   * The connection for one profile, opening it on first use.
   * @param profile - the profile name.
   * @returns the connection.
   * @throws PostgisProfileError when the profile or its credential is missing.
   */
  async forProfile(profile: string): Promise<PostgisConnection> {
    const existing = this.byProfile.get(profile)
    if (existing !== undefined) return existing
    const resolved = await this.profiles.resolve(profile)
    const connection = new PostgisConnection(resolved, this.profiles)
    this.byProfile.set(profile, connection)
    return connection
  }

  /** Close every open connection. */
  async closeAll(): Promise<void> {
    const open = [...this.byProfile.values()]
    this.byProfile.clear()
    await Promise.all(open.map(connection => connection.close()))
  }
}

/**
 * Resolving a PostGIS profile into a describable connection (T3.1).
 *
 * Two rules govern everything here:
 *
 * 1. **describe() never touches the secret.** It asks the credentials service
 *    whether the reference is CONFIGURED, not what it is, so a settings surface
 *    cannot leak a value it never read.
 * 2. **Every string that leaves this module goes through {@link PostgisProfiles.redact}.**
 *    Driver errors quote the connection string, and a log line is as public as a
 *    screenshot: the secret is replaced before anything is returned or thrown.
 */
import type { PostgisConfig, PostgisProfileSettings } from './config.ts'

/** What a profile's credential reference currently resolves to. */
export type CredentialState =
  /** The reference resolves to a value. */
  | 'configured'
  /** The reference exists but nothing is stored for it yet. */
  | 'missing'
  /** No credentials service is mounted in this profile. */
  | 'unavailable'
  /** The profile needs no secret. */
  | 'not-required'

/** The connection halves of one profile, safe to show. */
export interface PostgisProfileDescription {
  /** Profile name a dataset refers to. */
  readonly profile: string
  /** Host or socket directory. */
  readonly host: string
  /** TCP port. */
  readonly port: number
  /** Database name. */
  readonly database: string
  /** Role to connect as. */
  readonly user: string
  /** Whether TLS is negotiated. */
  readonly ssl: boolean
  /** Credential reference, when the profile has one. */
  readonly credential?: string
  /** Whether that reference currently resolves. */
  readonly credentialState: CredentialState
  /** Statement cap applied to this profile's queries. */
  readonly statementTimeoutMs: number
}

/** A connection ready to hand to the driver. */
export interface ResolvedConnection {
  /** Profile this connection came from. */
  readonly profile: string
  /** Host or socket directory. */
  readonly host: string
  /** TCP port. */
  readonly port: number
  /** Database name. */
  readonly database: string
  /** Role to connect as. */
  readonly user: string
  /** The secret, when one was resolved. */
  readonly password?: string
  /** Whether to negotiate TLS. */
  readonly ssl: boolean
  /** How long to wait for a connection. */
  readonly connectTimeoutMs: number
  /** Statement cap applied to this profile's queries. */
  readonly statementTimeoutMs: number
}

/**
 * The slice of the credentials service this plugin needs.
 *
 * Declared STRUCTURALLY, so the plugin does not hard-depend on the credentials
 * package: the service is optional (a profile may have none), and the shapes are
 * the published ones.
 */
export interface CredentialsResolver {
  /**
   * @param ref - the reference to resolve.
   * @returns the value and its source, or undefined while unconfigured.
   */
  resolve(ref: never): Promise<{ readonly value: string } | undefined>
  /**
   * @param ref - the reference to describe.
   * @returns configured state, without the value.
   */
  describe(ref: never): Promise<{ readonly configured: boolean }>
}

/** Cast a profile name to the credentials service's branded reference type. */
function asRef(value: string): never {
  return value as never
}

/** A profile that cannot be used, with a reason fit for a user. */
export class PostgisProfileError extends Error {
  /**
   * @param profile - the profile name that failed.
   * @param reason - why it cannot be used.
   */
  constructor(public readonly profile: string, reason: string) {
    super('postgis profile "' + profile + '": ' + reason)
    this.name = 'PostgisProfileError'
  }
}

/** Named connection profiles and their credential state. */
export class PostgisProfiles {
  /**
   * @param config - validated configuration.
   * @param credentials - the credentials service, when the profile mounts one.
   */
  constructor(
    private readonly config: PostgisConfig,
    private readonly credentials: CredentialsResolver | undefined = undefined,
  ) {}

  /** Every configured profile name, in configuration order. */
  get names(): readonly string[] {
    return Object.keys(this.config.profiles)
  }

  /** Whether one profile exists. */
  has(profile: string): boolean {
    return Object.hasOwn(this.config.profiles, profile)
  }

  /** One profile's settings, or undefined. */
  settingsOf(profile: string): PostgisProfileSettings | undefined {
    return this.config.profiles[profile]
  }

  /**
   * Describe one profile WITHOUT reading its secret.
   * @param profile - the profile name.
   * @returns the safe summary, or undefined when no such profile exists.
   */
  async describe(profile: string): Promise<PostgisProfileDescription | undefined> {
    const settings = this.settingsOf(profile)
    if (settings === undefined) return undefined
    const credentialState = await this.credentialState(settings)
    return {
      profile,
      host: settings.host,
      port: settings.port,
      database: settings.database,
      user: settings.user,
      ssl: settings.ssl,
      ...settings.credential === undefined ? {} : { credential: settings.credential },
      credentialState,
      statementTimeoutMs: settings.statementTimeoutMs,
    }
  }

  /** Every profile's safe summary. */
  async describeAll(): Promise<readonly PostgisProfileDescription[]> {
    const described = []
    for (const name of this.names) {
      const one = await this.describe(name)
      if (one !== undefined) described.push(one)
    }
    return described
  }

  /**
   * Resolve one profile into everything but the secret.
   * @param profile - the profile name.
   * @returns the connection halves.
   * @throws PostgisProfileError when the profile does not exist.
   */
  connectionOf(profile: string): Omit<ResolvedConnection, 'password'> {
    const settings = this.settingsOf(profile)
    if (settings === undefined) throw new PostgisProfileError(profile, 'no such profile is configured')
    return {
      profile,
      host: settings.host,
      port: settings.port,
      database: settings.database,
      user: settings.user,
      ssl: settings.ssl,
      connectTimeoutMs: settings.connectTimeoutMs,
      statementTimeoutMs: settings.statementTimeoutMs,
    }
  }

  /**
   * Resolve one profile INCLUDING its secret.
   *
   * The only method that reads a value. Its result must never be logged, which is
   * why {@link redact} exists and why callers pass messages through it.
   * @param profile - the profile name.
   * @returns the connection, with a password when the profile needs one.
   * @throws PostgisProfileError when the profile is missing or its secret is not configured.
   */
  async resolve(profile: string): Promise<ResolvedConnection> {
    const base = this.connectionOf(profile)
    const settings = this.settingsOf(profile) as PostgisProfileSettings
    if (settings.credential === undefined) return base
    if (this.credentials === undefined) {
      throw new PostgisProfileError(profile, 'its credential "' + settings.credential + '" cannot be resolved because this profile mounts no credentials service')
    }
    const resolved = await this.credentials.resolve(asRef(settings.credential))
    if (resolved === undefined) {
      throw new PostgisProfileError(profile, 'its credential "' + settings.credential + '" is not configured')
    }
    return { ...base, password: resolved.value }
  }

  /**
   * Remove a secret from any text that may carry one.
   * @param text - a message, an error, a connection string.
   * @param secrets - values to strip; callers pass what they resolved.
   * @returns the text with every secret replaced.
   */
  redact(text: string, secrets: readonly (string | undefined)[]): string {
    let redacted = text
    for (const secret of secrets) {
      if (secret === undefined || secret.length === 0) continue
      redacted = redacted.split(secret).join('***')
    }
    return redacted
  }

  /** Whether one profile's credential reference is currently satisfied. */
  private async credentialState(settings: PostgisProfileSettings): Promise<CredentialState> {
    if (settings.credential === undefined) return 'not-required'
    if (this.credentials === undefined) return 'unavailable'
    const info = await this.credentials.describe(asRef(settings.credential))
    return info.configured ? 'configured' : 'missing'
  }
}

/**
 * PostGIS connection profiles (T3.1).
 *
 * THE POINT OF THIS FILE: a password cannot be configured. Not "should not" --
 * the schema is STRICT and has no such key, so a patch that carries
 * \`password: hunter2\` fails to load and says which key it did not expect. A
 * plaintext secret is therefore not a mistake a user can make, which is a
 * stronger guarantee than a warning in the documentation (and stronger than
 * "we only read it from the environment": that still lets it be written down).
 *
 * The connection halves that ARE configuration are here (host, port, database,
 * user, ssl, timeouts); the secret half is a REFERENCE resolved through
 * \`ctx.credentials\` at use time, and never stored in this plugin's config.
 */
import { z } from 'zod'

/** One connection profile, without any way to spell a secret. */
export const postgisProfileSchema = z.strictObject({
  /** Host or socket directory. */
  host: z.string().min(1),
  /** TCP port. */
  port: z.number().int().min(1).max(65_535).default(5432),
  /** Database name. */
  database: z.string().min(1),
  /** Role to connect as. */
  user: z.string().min(1),
  /**
   * Credentials REFERENCE to resolve through \`ctx.credentials\`.
   *
   * Omitted means "this profile needs no secret" -- a trust/peer authenticated
   * database, or a password already supplied by the environment. It never means
   * "the password is written here".
   */
  credential: z.string().min(1).optional(),
  /** Whether to negotiate TLS. */
  ssl: z.boolean().default(false),
  /** How long to wait for a connection before failing. */
  connectTimeoutMs: z.number().int().positive().max(120_000).default(10_000),
  /** Statement cap applied to every query this profile runs (T3.3). */
  statementTimeoutMs: z.number().int().positive().max(600_000).default(15_000),
})

/** The plugin's configuration: named profiles and nothing else. */
export const postgisConfigSchema = z.strictObject({
  /** Profiles by name; a dataset refers to one by this name. */
  profiles: z.record(z.string().min(1), postgisProfileSchema).default({}),
})

/** Validated profile settings. */
export type PostgisProfileSettings = z.infer<typeof postgisProfileSchema>
/** Validated plugin configuration. */
export type PostgisConfig = z.infer<typeof postgisConfigSchema>

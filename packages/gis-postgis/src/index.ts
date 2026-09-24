/**
 * \`@znlgis/dsh-gis-postgis\` host half (T3.1).
 *
 * T3.1 is deliberately small: it settles WHERE a connection's halves live and
 * proves that the secret half cannot be configured. Connecting, cataloguing and
 * querying arrive in T3.2+. The service is published as \`ctx.gisPostgis\` so
 * those tasks have one place to ask, and so a profile without the credentials
 * service still degrades to "unavailable" rather than failing to load.
 */
import { Service, type Context } from '@deepseek-ai/cordis'
import { postgisConfigSchema, type PostgisConfig } from './config.ts'
import { PostgisProfiles, type CredentialsResolver } from './profiles.ts'

export { postgisConfigSchema, postgisProfileSchema, type PostgisConfig, type PostgisProfileSettings } from './config.ts'
export {
  PostgisProfileError,
  PostgisProfiles,
  type CredentialState,
  type CredentialsResolver,
  type PostgisProfileDescription,
  type ResolvedConnection,
} from './profiles.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** PostGIS connection profiles, when this plugin is mounted. */
    gisPostgis: PostgisService
  }
}

/** Connection profiles, with credential resolution when the profile has one. */
export default class PostgisService extends Service {
  /** The resolved configuration. */
  readonly config: PostgisConfig
  /** The profile resolver, published for the tasks that will connect. */
  readonly profiles: PostgisProfiles

  /**
   * @param ctx - owning context; the service is published as \`ctx.gisPostgis\`.
   * @param config - the row's configuration, validated here.
   */
  constructor(ctx: Context, config: PostgisConfig) {
    super(ctx, 'gisPostgis')
    // `?? {}`: a row that configures nothing must produce an empty profile set
    // rather than throwing inside the loader.
    this.config = postgisConfigSchema.parse(config ?? {})
    // \`credentials\` is read LATE and PER CALL, not injected and not captured:
    // this row may activate BEFORE the credentials row does, and a profile without
    // the credentials plugin must still have working GIS tools (contract #19).
    // Capturing the service here made every profile report "unavailable" in a real
    // instance while the same configuration passed every unit test.
    this.profiles = new PostgisProfiles(this.config, () => this.credentialsResolver())
  }

  /** How many profiles are configured, for a settings surface. */
  get size(): number {
    return this.profiles.names.length
  }

  /** The credentials service as this plugin needs it, at the moment it is needed. */
  private credentialsResolver(): CredentialsResolver | undefined {
    try {
      return this.ctx.get('credentials') as CredentialsResolver | undefined
    } catch {
      // \`ctx.get\` throws for a name no row ever provided; "this profile mounts no
      // credentials service" is a normal state, not an error.
      return undefined
    }
  }

  /**
   * Describe one profile for a surface that must not see its secret.
   * @param profile - the profile name.
   * @returns the safe summary, or undefined.
   */
  async describe(profile: string) {
    return await this.profiles.describe(profile)
  }

  /** Every profile's safe summary. */
  async describeAll() {
    return await this.profiles.describeAll()
  }
}

/** Service name, for tests and diagnostics. */
export const POSTGIS_SERVICE = 'gisPostgis'

// No `apply` export: the default-exported Service IS the plugin (see the note at
// the top). Exporting both invited the loader to pick the wrong one.

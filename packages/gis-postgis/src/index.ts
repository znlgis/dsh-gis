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
import { PostgisConnections } from './connect.ts'
import { readCatalog, readLayerMetadata, type CatalogLayer } from './catalog.ts'
import { readPage, type PageRequest } from './query.ts'

export { postgisConfigSchema, postgisProfileSchema, type PostgisConfig, type PostgisProfileSettings } from './config.ts'
export { PostgisConnection, PostgisConnections, type Queryable } from './connect.ts'
export {
  buildPageSql,
  normalizeLimit,
  normalizeOffset,
  orderKeyOf,
  PAGE_LIMITS,
  readPage,
  readPrimaryKey,
  toFeature,
  type Page,
  type PageFeature,
  type PageRequest,
} from './query.ts'
export {
  CATALOG_SQL,
  estimatedExtentSql,
  literal,
  readCatalog,
  readLayerMetadata,
  toLayer,
  type CatalogLayer,
  type EstimatedExtent,
  type LayerMetadata,
  type SpatialKind,
} from './catalog.ts'
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
  /** Open connections by profile; closed with the plugin. */
  private readonly connections: PostgisConnections

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
    this.connections = new PostgisConnections(this.profiles)
    // The pool owns sockets; without a teardown they outlive the plugin.
    this.ctx.effect(() => () => this.close(), 'gis-postgis: connection pool')
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

  /**
   * The catalogue of one profile: every spatial column, with row and extent
   * ESTIMATES from the statistics (never `count(*)` -- see catalog.ts).
   * @param profile - the profile name.
   * @returns the layers, in schema/table/column order.
   */
  async catalog(profile: string) {
    const connection = await this.connections.forProfile(profile)
    return await readCatalog(connection)
  }

  /**
   * One layer's metadata: its catalogue entry plus its estimated extent.
   * @param profile - the profile name.
   * @param layer - the layer to describe.
   * @returns the metadata, with a reason when the extent is unknown.
   */
  async layerMetadata(profile: string, layer: CatalogLayer) {
    const connection = await this.connections.forProfile(profile)
    return await readLayerMetadata(connection, layer)
  }

  /**
   * One page of features from a layer (T3.3): bound LIMIT/OFFSET, ordered, with
   * geometry encoded by the DATABASE.
   * @param profile - the profile name.
   * @param layer - the layer to read.
   * @param request - page size and offset.
   * @returns the page.
   */
  async page(profile: string, layer: CatalogLayer, request: PageRequest = {}) {
    const connection = await this.connections.forProfile(profile)
    return await readPage(connection, layer, request)
  }

  /** Close every open connection; also the plugin's teardown. */
  async close(): Promise<void> {
    await this.connections.closeAll()
  }
}

/** Service name, for tests and diagnostics. */
export const POSTGIS_SERVICE = 'gisPostgis'

// No `apply` export: the default-exported Service IS the plugin (see the note at
// the top). Exporting both invited the loader to pick the wrong one.

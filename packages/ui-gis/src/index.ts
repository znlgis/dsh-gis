/**
 * dsh-ui-gis host half: the byte routes the browser half reads through.
 *
 * The browser half renders maps; the bytes it renders have to arrive inside the
 * host's authentication fence, which is what `ctx.connection.fetch` is for
 * (design 3.5). One route for now:
 *
 *   GET/HEAD /api/gis/blob?id=<opaque id>   -- Range-capable dataset bytes
 *
 * The security boundary is the resolver, not the handler: the route accepts an
 * ID and nothing else, and the id is looked up through `ctx.gis.resolveFresh`.
 * A client cannot name a path, so no request can turn this into an arbitrary
 * file read (design 12), and an id whose source has changed is dropped before
 * its bytes are served (T1a.2).
 */
import type { Context } from '@deepseek-ai/cordis'
// Type-only: the declaration merge is what makes `ctx.connection` visible here
// (runtime contract #6).
import type {} from '@deepseek-ai/dsh-client-connection'
import { GisError, sourcePathOf, type Dataset } from '@znlgis/dsh-gis-core'
import { createBlobHandler, type BlobTarget } from './server/blob.ts'

/** Stable Loader identity. */
export const name = 'dsh-ui-gis'

/**
 * Both services must exist before `apply` runs.
 *
 * `connection` is a web-app row: in a profile without a browser surface this
 * half simply waits, which is correct -- there is no browser to serve.
 */
export const inject = ['connection', 'gis']

/** The byte route (design 3.5 route table). */
const BLOB_PATH = '/api/gis/blob'

/** Register the byte route inside the authentication fence. */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.connection.fetch.register({
    path: BLOB_PATH,
    methods: ['GET', 'HEAD'],
    requestBody: 'buffered',
    fetch: createBlobHandler({
      resolve: async (id: string): Promise<BlobTarget> => {
        const dataset = await ctx.gis.resolveFresh(id)
        const path = sourcePathOf(dataset)
        if (path === undefined) {
          throw new GisError(
            'DATASET_NOT_FOUND',
            'dataset ' + id + ' is a connection, not bytes on disk, so it has no byte route',
            'read features through the query tools instead of fetching the dataset',
          )
        }
        return { path, contentType: contentTypeOf(dataset), etag: '"' + dataset.id + '"' }
      },
    }),
  }), 'ui-gis: blob route')
}

/**
 * Media type for a dataset's bytes.
 * @param dataset - the resolved dataset.
 * @returns the type the route reports.
 */
function contentTypeOf(dataset: Dataset): string {
  switch (dataset.kind) {
    case 'geojson': return 'application/geo+json'
    case 'ndjson': return 'application/x-ndjson'
    case 'wkt': return 'text/plain; charset=utf-8'
    // `image/tiff` is what a COG is; the browser ranges-reads it, and a wrong
    // type here would make a reader refuse bytes it can actually use.
    case 'cog': return 'image/tiff'
    // No media type worth naming for the two self-indexed containers: the client
    // decides by the LAYER KIND it was given, and a wrong type would only invite
    // a reader that cannot parse these to try.
    case 'flatgeobuf':
    case 'pmtiles': return 'application/octet-stream'
    // Containers and shapefile members have no meaningful media type of their
    // own; the browser decides by the layer kind it was given, not by this.
    case 'shapefile':
    case 'gdb':
    case 'postgis': return 'application/octet-stream'
  }
}

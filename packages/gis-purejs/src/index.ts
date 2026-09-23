/**
 * `@znlgis/dsh-gis-purejs` -- the always-available GIS provider.
 *
 * It needs no external tools, so the plugin is useful on a machine with no
 * GDAL and no QGIS. It is also the provider that keeps working when the
 * sandbox refuses to execute anything: pure-JS reads stay inside the process.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Dataset, GisOpener } from '@znlgis/dsh-gis-core'
import { createHandler } from './handler.ts'
import { absolutePath, describeDataset, kindOf } from './io.ts'

/** Stable Loader identity. */
export const name = 'gis-purejs'

/** The GIS service must exist before `apply` runs. */
export const inject = ['gis']

/** Register the pure-JS handler and opener. */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.gis.registerHandler(createHandler()), 'gis-purejs: handler')

  const opener: GisOpener = {
    name: 'gis-purejs',
    canOpen: (path: string) => kindOf(path) !== undefined,
    async open(path: string): Promise<Dataset> {
      return describeDataset(absolutePath(path, process.cwd()))
    },
  }
  ctx.effect(() => ctx.gis.registerOpener(opener), 'gis-purejs: opener')
}

/**
 * Where a dataset's bytes actually live.
 *
 * `Dataset.title` is a DISPLAY name -- for a shapefile it is the bare file
 * name, extension included -- and must never be used to address a file: GDAL
 * takes whatever it is given and looks for it in the working directory, so a
 * title-as-path fails with "No such file or directory". Everything that needs
 * a real path asks by kind, through here. (Runtime contract #15; found by
 * running a real binary, invisible to any mock.)
 */
import type { Dataset } from './types.ts'

/**
 * The filesystem path a dataset is read from.
 * @param dataset - any registered dataset.
 * @returns the path, or `undefined` for datasets with no local source
 *   (a connection dataset is addressed by profile name, not by path).
 */
export function sourcePathOf(dataset: Dataset): string | undefined {
  switch (dataset.kind) {
    case 'geojson':
    case 'ndjson':
    case 'wkt':
    case 'cog':
      return dataset.path
    case 'shapefile':
      return dataset.main
    case 'gdb':
      return dataset.dir
    case 'postgis':
      return undefined
  }
}

/**
 * dsh-ui-gis browser half (M0).
 *
 * Two registrations: a `tool.call.toolview` card keyed by the `gis_probe` wire
 * tool name, and a `plugins.bundle.config` card keyed by the bundle package
 * name. Together they prove the bundle loads, renders, takes the right
 * settings seat, and stays HMR-safe.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
// TYPE-ONLY contract imports: erased at build time. Importing the package that
// *declares* a slot is what puts its key into SlotMap.
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-tool/client'
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import { GisProbeRow } from './GisProbeRow.tsx'
import { GisRenderCardRow } from './GisRenderCardRow.tsx'
import { GisSettingsCard } from './GisSettingsCard.tsx'
import { GisGdalCard } from './GisGdalCard.tsx'
import { setConfigForms } from './config-access.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  /** This plugin's user-facing copy, addressed by the `uiGis` namespace. */
  interface LocaleNamespaceMap {
    uiGis:
      | 'probe.title'
      | 'map.loading'
      | 'map.empty'
      | 'map.failed'
      | 'render.running'
      | 'render.orphan'
      | 'render.failed'
      | 'render.unavailable'
      | 'render.checking'
      | 'render.missing'
  }
}

/** Namespace for this plugin's user-facing copy. */
const NS = 'uiGis'

/** The bundle package whose configuration page this half fills. */
const BUNDLE = '@znlgis/dsh-gis'

/**
 * The GDAL runtime row's SLOT KEY.
 *
 * THREE different ids are in play for one row, and confusing any two fails
 * silently -- no error, the slot just never dispatches:
 *
 *   slot key              '@znlgis/dsh-gis#gis-gdal'   <- `${bundle}#${rowId}`
 *   configForms namespace 'include:gis-gdal'           <- the Loader entry id
 *   data-plugin-row       'include:gis-gdal'           <- same entry id
 *
 * The slot key comes from `rowConfigKey(bundle, rowId)` in the page's own
 * config-ledger module, which builds its `rows` set from the keys plugins
 * registered into `plugins.row.config` -- so a wrong key means the page never
 * even renders the configure affordance for the row.
 */
const GDAL_ROW = '@znlgis/dsh-gis#gis-gdal'

/** Browser services this half needs. */
export const inject = ['slots', 'locale', 'configForms']

/** Register the dictionaries, the probe toolview, and the settings card. */
export function apply(ctx: ClientContext): void {
  // The settings card resolves its own form; the page supplies none (see the card).
  setConfigForms(ctx.configForms)

  ctx.effect(() => ctx.locale.register(NS, {
    en: {
      'probe.title': 'dsh-gis probe',
      'map.loading': 'loading map…',
      'map.empty': 'nothing to draw yet',
      'map.failed': 'the map could not start',
      'render.running': 'rendering…',
      'render.orphan': 'this render was replayed without its call, so only its result is known',
      'render.failed': 'the render failed',
      'render.unavailable': 'this result carries no map description',
      'render.checking': 'checking the data…',
      'render.missing': 'this data is no longer available',
    },
    zh: {
      'probe.title': 'dsh-gis 探针',
      'map.loading': '地图加载中…',
      'map.empty': '暂无可绘制的图层',
      'map.failed': '地图无法启动',
      'render.running': '正在渲染…',
      'render.orphan': '这条渲染没有配对调用（回放窗口裁掉了），只能显示结果',
      'render.failed': '渲染失败',
      'render.unavailable': '这条结果没有携带地图描述',
      'render.checking': '正在确认数据…',
      'render.missing': '数据已不可用',
    },
  }), 'ui-gis: dictionaries')

  ctx.effect(() => ctx.slots.inject('tool.call.toolview', () => ctx.slots.register(
    { name: 'tool.call.toolview', key: 'gis_probe', locale: NS },
    GisProbeRow,
  )), 'ui-gis: probe toolview')

  // The map card for gis_render. The registered component is the eager SHIM;
  // the card itself (and MapLibre under it) arrives in a lazy chunk.
  ctx.effect(() => ctx.slots.inject('tool.call.toolview', () => ctx.slots.register(
    { name: 'tool.call.toolview', key: 'gis_render', locale: NS },
    GisRenderCardRow,
  )), 'ui-gis: render toolview')

  ctx.effect(() => ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register(
    { name: 'plugins.bundle.config', key: BUNDLE, locale: NS },
    GisSettingsCard,
  )), 'ui-gis: settings card')

  // gis-gdal declares no `dsh.bundle`, so it is a ROW of the dsh-gis bundle and
  // NOT a bundle of its own. Its settings therefore belong to `plugins.row.config`
  // keyed by the ROW id -- `plugins.bundle.config` is keyed by a BUNDLE's package
  // name and would never be consulted for a row. (Learned by driving the real UI:
  // the gdal package does not appear in the Installed list at all.)
  ctx.effect(() => ctx.slots.inject('plugins.row.config', () => ctx.slots.register(
    { name: 'plugins.row.config', key: GDAL_ROW, locale: NS },
    GisGdalCard,
  )), 'ui-gis: gdal row config')
}

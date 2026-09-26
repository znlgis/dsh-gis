/**
 * T3.6: the \`layer\` parameter reaches the service, on every call that needs it.
 *
 * The tools are registered through \`ctx.tools.register\`, so a context that records
 * what was registered lets the REAL execute functions run -- no host, no mocks of
 * the tool runtime, just the code a host would call.
 *
 * The interesting assertion is the RENDER one. \`gis_render\` makes TWO calls: it
 * describes the dataset to frame the picture, then reads features to fill it. If
 * the layer reached only one of them, the picture would be framed on one layer's
 * extent and filled with another's features -- a wrong map that looks like a right
 * one, which is the failure this test exists to prevent.
 */
import { describe, expect, it } from 'vitest'
import type { Dataset, InspectResult, QueryResult } from '@znlgis/dsh-gis-core'
import { apply } from '../src/index.ts'

/** What a registered tool looks like from the outside. */
interface RegisteredTool {
  readonly name: string
  readonly parameters: Readonly<Record<string, { readonly type?: string }>>
  execute(args: Record<string, unknown>): Promise<unknown>
}

/** A gis service that records every request and answers minimally. */
function recordingGis() {
  const calls: { readonly method: string; readonly layer: unknown }[] = []
  const dataset: Dataset = {
    id: 'ds_multi',
    kind: 'gdb',
    title: 'multi.gdb',
    dir: 'C:/data/multi.gdb',
    layers: [{ name: 'cities' }, { name: 'projected_areas' }],
  }
  const service = {
    resolve: async () => dataset,
    list: () => [dataset],
    inspect: async (id: string, layer?: string) => {
      calls.push({ method: 'inspect', layer })
      return {
        datasetId: id,
        kind: 'gdb',
        layers: [{ name: layer ?? 'cities' }],
        crs: { epsg: 4326, source: 'native' },
        fields: [],
        bbox: [100, 30, 101, 31],
        capabilities: { read: true, write: false, tiles: false },
        issues: [],
      } satisfies InspectResult
    },
    query: async (_id: string, request: { readonly layer?: string }) => {
      calls.push({ method: 'query', layer: request.layer })
      return {
        columns: ['name'],
        rows: [{ attributes: { name: 'a' }, geometry: { type: 'Point', coordinates: [100.5, 30.5] } }],
        total: 1,
        limit: 500,
        offset: 0,
      } satisfies QueryResult
    },
  }
  return { service, calls }
}

/** Register the tools against a recording context and hand back the registry. */
function host(service: unknown) {
  const registered = new Map<string, RegisteredTool>()
  const ctx = {
    tools: { register: (tool: RegisteredTool) => { registered.set(tool.name, tool) } },
    gis: service,
    get: () => undefined,
    logger: { warn: () => {}, info: () => {}, debug: () => {} },
  }
  apply(ctx as never)
  return registered
}

describe('the layer parameter', () => {
  it('is offered by the tools that read a dataset', () => {
    const { service } = recordingGis()
    const registered = host(service)
    // `parameters` is the JSON Schema the model sees, so the property is what a
    // caller can actually pass -- asserting on it is asserting on the contract.
    for (const name of ['gis_inspect', 'gis_query', 'gis_render']) {
      const schema = registered.get(name)?.parameters as { readonly properties?: Record<string, unknown> } | undefined
      expect(schema?.properties?.layer, name + ' should offer a layer parameter').toBeDefined()
    }
  })

  it('reaches gis_query', async () => {
    const { service, calls } = recordingGis()
    await host(service).get('gis_query')?.execute({ id: 'ds_multi', layer: 'projected_areas', limit: 5 })
    expect(calls).toEqual([{ method: 'query', layer: 'projected_areas' }])
  })

  it('reaches BOTH calls gis_render makes', async () => {
    const { service, calls } = recordingGis()
    const tool = host(service).get('gis_render')
    // The render itself may fail on this stub (no real rasterizer input); what
    // matters is which layer the two calls carried BEFORE that.
    await tool?.execute({
      id: 'ds_multi',
      layer: 'projected_areas',
      width: 128,
      height: 128,
      output: 'tests/.cache/t36-render.png',
    }).catch(() => undefined)
    expect(calls.length).toBeGreaterThanOrEqual(2)
    expect(calls.map(call => call.layer)).toEqual(['projected_areas', 'projected_areas'])
  })

  it('is absent when the caller does not name one', async () => {
    const { service, calls } = recordingGis()
    await host(service).get('gis_query')?.execute({ id: 'ds_multi', limit: 5 })
    expect(calls).toEqual([{ method: 'query', layer: undefined }])
  })
})

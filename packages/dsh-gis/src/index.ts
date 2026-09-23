/**
 * dsh-gis host half (M0).
 *
 * Registers the probe tool and one `.volatile()` configuration field. The
 * volatile field is what T0.7 verifies: DSH's settings service turns it into a
 * revisioned form descriptor and persists writes into the active profile's
 * Cordis patch, so a plugin needs no settings storage of its own.
 */
import type { Context, Volatile } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'

/** Stable Loader identity. */
export const name = 'dsh-gis'

/** The tool registry must be ready before `apply` runs. */
export const inject = ['tools']

/** Configuration this bundle accepts from the active profile. */
export interface Config {
  /** Label the probe echoes; a live field the settings page can edit. */
  probeLabel: Volatile<string>
}

/**
 * Configuration schema. `.volatile()` is what makes a field live-editable;
 * the annotation is intentionally omitted so the schema's own inference line
 * up with the `Volatile<T>` references in `Config` (settings-card cookbook).
 */
export const Config = z.object({
  probeLabel: z.string().default('dsh-gis probe').volatile(),
})

/** Register the M0 probe tool. */
export function apply(ctx: Context, config: Config): void {
  ctx.tools.register(defineTool({
    name: 'gis_probe',
    description: 'Report that the dsh-gis plugin is loaded and which runtime facts it can see.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          plugin: { type: 'string', required: true },
          label: { type: 'string', required: true },
          node: { type: 'string', required: true },
          platform: { type: 'string', required: true },
          cwd: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `${value.label}: dsh-gis loaded (${value.plugin}) on node ${value.node}/${value.platform}; cwd=${value.cwd}`,
      }],
    },
    async execute() {
      return {
        plugin: 'dsh-gis@0.1.0',
        // Read through .get() so a live settings edit is visible immediately.
        label: config.probeLabel.get(),
        node: process.version,
        platform: String(process.platform),
        cwd: process.cwd(),
      }
    },
  }))
}

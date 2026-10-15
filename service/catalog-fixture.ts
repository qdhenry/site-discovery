/** Explicit offline model metadata; never a fallback for the Anthropic API. */
import type { Models } from '@earendil-works/pi-ai/models'

import type { ApiModel, CatalogOptions } from './model-catalog.ts'
import { analysisModels } from './settings.ts'

export function fixtureModelRows(models: Models): ApiModel[] {
  return [
    ...analysisModels(models).map(model => ({
      id: model.id,
      display_name: `${model.label} (fixture metadata)`,
      created_at: '2026-01-01T00:00:00Z',
      lifecycle: 'active',
      max_input_tokens: model.effectiveContextWindow,
      max_tokens: model.effectiveMaxOutputTokens,
      capabilities: {
        thinking: {
          supported: true,
          types: {
            adaptive: { supported: model.thinkingMode === 'adaptive' },
            enabled: { supported: model.thinkingMode === 'budget' },
            disabled: { supported: model.reasoningLevels.includes('off') },
          },
        },
        effort: {
          supported: model.thinkingMode === 'adaptive',
          low: { supported: model.reasoningLevels.includes('low') },
          medium: { supported: model.reasoningLevels.includes('medium') },
          high: { supported: model.reasoningLevels.includes('high') },
          xhigh: { supported: model.reasoningLevels.includes('xhigh') },
          max: { supported: model.reasoningLevels.includes('max') },
        },
        image_input: { supported: model.supportsImages },
      },
    })),
    {
      id: 'claude-haiku-5-5',
      display_name: 'Claude Haiku 5.5 (unsupported fixture)',
      lifecycle: 'active',
      max_input_tokens: 200000,
      max_tokens: 64000,
    },
  ]
}
export function fixtureCatalogOptions(
  models: Models,
  source: 'fixture' | 'anthropic-api' = 'fixture',
): CatalogOptions {
  const rows = fixtureModelRows(models)
  return {
    source,
    fetch: Object.assign(
      async () =>
        Response.json({
          data: rows,
          has_more: false,
          last_id: rows.at(-1)?.id ?? null,
        }),
      { preconnect: globalThis.fetch.preconnect },
    ),
  }
}

import { Schema as S } from 'effect'
import { createHash } from 'node:crypto'

import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import type { Models } from '@earendil-works/pi-ai/models'
import { type Harness, defineDoc } from '@earendil-works/pi-durable'

import type { AnalysisModel, ModelCatalogStatus } from '../src/contract.ts'
import { analysisModels } from './settings.ts'

const Support = S.Struct({ supported: S.Boolean })
const Capabilities = S.Struct({
  effort: S.optional(
    S.Struct({
      supported: S.Boolean,
      low: S.optional(Support),
      medium: S.optional(Support),
      high: S.optional(Support),
      xhigh: S.optional(Support),
      max: S.optional(Support),
    }),
  ),
  thinking: S.optional(
    S.Struct({
      supported: S.Boolean,
      types: S.optional(
        S.Struct({
          adaptive: S.optional(Support),
          enabled: S.optional(Support),
          disabled: S.optional(Support),
        }),
      ),
    }),
  ),
  image_input: S.optional(Support),
})
const ApiModel = S.Struct({
  id: S.String,
  display_name: S.String,
  created_at: S.optional(S.String),
  lifecycle: S.optional(S.String),
  deprecated_at: S.optional(S.NullOr(S.String)),
  retires_at: S.optional(S.NullOr(S.String)),
  max_input_tokens: S.optional(S.NullOr(S.Int)),
  max_tokens: S.optional(S.NullOr(S.Int)),
  capabilities: S.optional(S.NullOr(Capabilities)),
})
export type ApiModel = typeof ApiModel.Type
const ApiPage = S.Struct({
  data: S.Array(ApiModel),
  has_more: S.Boolean,
  last_id: S.NullOr(S.String),
})
const Rows = S.Array(ApiModel)
export const CATALOG_TTL_MS = 4 * 60 * 60 * 1000
const FAILURE_BACKOFF_MS = 60000
type CacheState = {
  credentialHash: string
  revision: number
  payload: string
  fetchedAt: number | null
  expiresAt: number | null
  lastAttemptAt: number | null
  nextRetryAt: number | null
  error: string
  source: ModelCatalogStatus['source']
}
const emptyCache = (): CacheState => ({
  credentialHash: '',
  revision: 0,
  payload: '',
  fetchedAt: null,
  expiresAt: null,
  lastAttemptAt: null,
  nextRetryAt: null,
  error: '',
  source: 'anthropic-api',
})
const CatalogDocument = defineDoc<CacheState>({
  kind: 'discovery.anthropic-model-catalog',
  version: 1,
  scope: 'session',
  initial: emptyCache,
})
export type CatalogView = {
  models: readonly AnalysisModel[]
  status: ModelCatalogStatus
}
export type CatalogOptions = {
  fetch?: typeof globalThis.fetch
  now?: () => number
  source?: ModelCatalogStatus['source']
}
const iso = (value: number | null) =>
  value === null ? null : new Date(value).toISOString()

export function mergeApiModels(
  rows: readonly ApiModel[],
  models: Models,
): AnalysisModel[] {
  const pinned = analysisModels(models)
  return rows.map(row => {
    const sdk = pinned.find(m => m.id === row.id)
    const caps = row.capabilities
    const lifecycle =
      row.lifecycle === 'active' ||
      row.lifecycle === 'deprecated' ||
      row.lifecycle === 'retired'
        ? row.lifecycle
        : 'unknown'
    const contextWindow = row.max_input_tokens ?? null
    const maxOutputTokens = row.max_tokens ?? null
    const effectiveContextWindow = sdk
      ? Math.min(
          contextWindow ?? sdk.effectiveContextWindow,
          sdk.effectiveContextWindow,
        )
      : 0
    const effectiveMaxOutputTokens = sdk
      ? Math.min(
          maxOutputTokens ?? sdk.effectiveMaxOutputTokens,
          sdk.effectiveMaxOutputTokens,
        )
      : 0
    let levels = sdk ? [...sdk.reasoningLevels] : []
    const mode = sdk?.thinkingMode ?? 'unsupported'
    levels = levels.filter(level => {
      if (level === 'off')
        return (
          !caps?.thinking || caps.thinking.types?.disabled?.supported === true
        )
      if (
        caps?.thinking &&
        (!caps.thinking.supported ||
          (mode === 'budget'
            ? caps.thinking.types?.enabled?.supported !== true
            : caps.thinking.types?.adaptive?.supported !== true))
      )
        return false
      if (mode === 'adaptive' && caps?.effort)
        return (
          level !== 'minimal' &&
          caps.effort.supported &&
          caps.effort[level]?.supported === true
        )
      return true
    })
    const reasons = [
      !sdk &&
        'The pinned adapter and pricing metadata do not support this API model',
      lifecycle === 'retired' && 'Anthropic reports this model retired',
      sdk &&
        !levels.length &&
        'API reasoning capabilities do not match the verified adapter',
      sdk &&
        (effectiveContextWindow <= 0 || effectiveMaxOutputTokens <= 0) &&
        'The API returned unusable token limits',
    ].filter((x): x is string => !!x)
    const defaultReasoning =
      sdk && levels.includes(sdk.defaultReasoning ?? 'off')
        ? sdk.defaultReasoning
        : levels.includes('high')
          ? 'high'
          : (levels[0] ?? null)
    return {
      id: row.id,
      label: row.display_name,
      contextWindow,
      maxOutputTokens,
      effectiveContextWindow,
      effectiveMaxOutputTokens,
      reasoningLevels: levels,
      defaultReasoning,
      thinkingMode: mode,
      supportsTemperature: sdk?.supportsTemperature ?? false,
      supportsImages:
        !!sdk?.supportsImages && caps?.image_input?.supported !== false,
      cacheRetentions: sdk?.cacheRetentions ?? [],
      selectable: reasons.length === 0,
      disabledReason: reasons.join('; '),
      lifecycle,
      createdAt: row.created_at ?? '',
      deprecatedAt: row.deprecated_at ?? null,
      retiresAt: row.retires_at ?? null,
      pricingSource: sdk ? 'pi-ai-1.0.3' : 'unavailable',
      capabilitySource: caps
        ? !sdk ||
          (caps.thinking &&
            caps.image_input &&
            (mode !== 'adaptive' || caps.effort))
          ? 'anthropic-api'
          : 'anthropic-api+pi-ai-1.0.3'
        : sdk
          ? 'pi-ai-1.0.3'
          : 'unavailable',
    }
  })
}

export class ModelCatalog {
  private pending:
    | { result: Promise<CatalogView>; force: boolean; refresh: boolean }
    | undefined
  private readonly clock: () => number
  private readonly source: ModelCatalogStatus['source']
  private readonly scope: string
  constructor(
    private readonly harness: Harness,
    private readonly models: Models,
    private readonly apiKey: string,
    private readonly options: CatalogOptions = {},
  ) {
    this.clock = options.now ?? Date.now
    this.source = options.source ?? 'anthropic-api'
    this.scope = createHash('sha256')
      .update(`discovery-models-v1\0${this.source}\0${apiKey}`)
      .digest('hex')
  }
  async ensure(force = false): Promise<CatalogView> {
    if (this.pending) {
      const pending = this.pending
      const value = await pending.result
      return force && !pending.force && !pending.refresh
        ? this.ensure(true)
        : value
    }
    const pending = { result: this.load(force), force, refresh: false }
    this.pending = pending
    try {
      return await pending.result
    } finally {
      if (this.pending === pending) this.pending = undefined
    }
  }
  private async read() {
    return (
      (await this.harness.snapshot(CatalogDocument, BACKGROUND_CONTEXT)) ??
      emptyCache()
    )
  }
  private async persist(value: CacheState): Promise<CacheState> {
    return this.harness.commit(async tx => {
      const stored = await tx.doc(CatalogDocument)
      const next = { ...value, revision: stored.revision + 1 }
      Object.assign(stored, next)
      return next
    }, BACKGROUND_CONTEXT)
  }
  private view(value: CacheState): CatalogView {
    const rows = value.payload
      ? S.decodeUnknownSync(Rows)(JSON.parse(value.payload))
      : []
    const fresh =
      value.payload !== '' &&
      value.expiresAt !== null &&
      this.clock() < value.expiresAt
    return {
      models: mergeApiModels(rows, this.models),
      status: {
        source: value.source,
        status: fresh ? 'fresh' : value.payload ? 'stale' : 'unavailable',
        revision: value.revision,
        fetchedAt: iso(value.fetchedAt),
        expiresAt: iso(value.expiresAt),
        lastAttemptAt: iso(value.lastAttemptAt),
        nextRetryAt: iso(value.nextRetryAt),
        error: value.error,
        ttlSeconds: CATALOG_TTL_MS / 1000,
        modelCount: rows.length,
      },
    }
  }
  private async load(force: boolean): Promise<CatalogView> {
    let cache = await this.read()
    if (cache.credentialHash !== this.scope)
      cache = await this.persist({
        ...emptyCache(),
        credentialHash: this.scope,
        source: this.source,
      })
    if (!this.apiKey && this.source !== 'fixture') {
      if (!cache.error)
        cache = await this.persist({
          ...cache,
          error:
            'ANTHROPIC_API_KEY is required to load the Anthropic model catalog',
        })
      return this.view(cache)
    }
    const at = this.clock()
    if (
      !force &&
      cache.payload &&
      cache.expiresAt !== null &&
      at < cache.expiresAt
    )
      return this.view(cache)
    if (!force && cache.nextRetryAt !== null && at < cache.nextRetryAt)
      return this.view(cache)
    try {
      if (this.pending) this.pending.refresh = true
      const rows = await this.fetchAll()
      const fetchedAt = this.clock()
      cache = await this.persist({
        ...cache,
        payload: JSON.stringify(rows),
        fetchedAt,
        expiresAt: fetchedAt + CATALOG_TTL_MS,
        lastAttemptAt: at,
        nextRetryAt: null,
        error: '',
      })
    } catch (error) {
      const message =
        error instanceof CatalogFetchError
          ? error.message
          : 'The Anthropic Models API request failed; retry later'
      cache = await this.persist({
        ...cache,
        lastAttemptAt: at,
        nextRetryAt: this.clock() + FAILURE_BACKOFF_MS,
        error: message,
      })
    }
    return this.view(cache)
  }
  private async fetchAll(): Promise<readonly ApiModel[]> {
    const rows: ApiModel[] = []
    const ids = new Set<string>()
    const cursors = new Set<string>()
    const signal = AbortSignal.timeout(15000)
    let cursor = ''
    let remainingBytes = 2000000
    for (let page = 0; page < 20; page++) {
      const url = new URL('https://api.anthropic.com/v1/models')
      url.searchParams.set('limit', '100')
      if (cursor) url.searchParams.set('after_id', cursor)
      const response = await (this.options.fetch ?? globalThis.fetch)(url, {
        method: 'GET',
        headers: {
          'x-api-key': this.apiKey,
          'anthropic-version': '2023-06-01',
        },
        signal,
        redirect: 'error',
      })
      if (!response.ok)
        throw new CatalogFetchError(
          `Anthropic Models API returned HTTP ${response.status}`,
        )
      if (!response.body)
        throw new CatalogFetchError(
          'Anthropic Models API returned an empty response body',
        )
      const reader = response.body.getReader()
      const parts: Uint8Array[] = []
      while (true) {
        const part = await reader.read()
        if (part.done) break
        remainingBytes -= part.value.byteLength
        if (remainingBytes < 0) {
          await reader.cancel()
          throw new CatalogFetchError(
            'Anthropic Models API response exceeded the 2 MB limit',
          )
        }
        parts.push(part.value)
      }
      let data: typeof ApiPage.Type
      try {
        data = S.decodeUnknownSync(ApiPage)(
          JSON.parse(Buffer.concat(parts).toString('utf8')),
        )
      } catch {
        throw new CatalogFetchError(
          'Anthropic Models API returned invalid model metadata',
        )
      }
      for (const row of data.data) {
        if (
          !row.id ||
          row.id.length > 200 ||
          !row.display_name ||
          row.display_name.length > 300 ||
          ids.has(row.id) ||
          (row.max_input_tokens !== null &&
            row.max_input_tokens !== undefined &&
            row.max_input_tokens <= 0) ||
          (row.max_tokens !== null &&
            row.max_tokens !== undefined &&
            row.max_tokens <= 0)
        )
          throw new CatalogFetchError(
            'Anthropic Models API returned invalid or duplicate models',
          )
        ids.add(row.id)
        rows.push(row)
        if (rows.length > 2000)
          throw new CatalogFetchError(
            'Anthropic Models API exceeded the 2000-model limit',
          )
      }
      if (!data.has_more) return rows
      if (
        !data.last_id ||
        !data.data.length ||
        cursors.has(data.last_id) ||
        data.last_id !== data.data.at(-1)?.id
      )
        throw new CatalogFetchError(
          'Anthropic Models API returned invalid pagination',
        )
      cursors.add(data.last_id)
      cursor = data.last_id
    }
    throw new CatalogFetchError(
      'Anthropic Models API exceeded the pagination limit',
    )
  }
}
class CatalogFetchError extends Error {}

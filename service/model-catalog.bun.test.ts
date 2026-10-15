import { expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { AnalysisSettingsSnapshot, CaptureInput } from '../src/contract.ts'
import { fixtureModelRows } from './catalog-fixture.ts'
import { readConfig } from './config.ts'
import { DiscoveryEngine } from './engine.ts'
import {
  type ApiModel,
  CATALOG_TTL_MS,
  mergeApiModels,
} from './model-catalog.ts'
import { type Providers, createProviders } from './providers.ts'

const configFor = (stateDir: string, key = 'test-model-key') =>
  readConfig({
    DISCOVERY_STATE_DIR: stateDir,
    DISCOVERY_FIXTURES: '1',
    ANTHROPIC_API_KEY: key,
    CLOUDFLARE_ACCOUNT_ID: 'test',
    CLOUDFLARE_BROWSER_API_TOKEN: 'test',
    CLOUDFLARE_AI_GATEWAY_ID: 'test',
    AI_GATEWAY_API_TOKEN: 'test',
    DISCOVERY_RUN_LIMIT_USD: '100',
    DISCOVERY_MONTHLY_LIMIT_USD: '1000',
    DISCOVERY_ATTEMPT_RESERVATION_USD: '20',
  })
const models = createProviders(configFor('/tmp/unused-catalog')).models
const row = (id = 'claude-sonnet-4-6'): ApiModel =>
  fixtureModelRows(models).find(m => m.id === id)!
const page = (
  data: readonly ApiModel[],
  more = false,
  last = data.at(-1)?.id ?? null,
) => Response.json({ data, has_more: more, last_id: last })
const transport = (
  callback: (
    request: RequestInfo | URL,
    init?: RequestInit,
  ) => Promise<Response> | Response,
): typeof globalThis.fetch =>
  Object.assign(
    async (request: RequestInfo | URL, init?: RequestInit) =>
      callback(request, init),
    { preconnect: globalThis.fetch.preconnect },
  )
const captureInput: CaptureInput = {
  mode: 'batch',
  source: 'https://example.com/a\nhttps://example.com/b',
  depth: 1,
  maxPages: 2,
  desktop: true,
  mobile: false,
  targetCms: 'generic',
  evidenceMode: 'fixture',
}

test('Models API cache is persisted, coalesced, exactly four hours, credential-scoped, and manual refresh survives a concurrent cache read', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'discovery-model-cache-'))
  const config = configFor(dir)
  let at = Date.parse('2026-01-01T00:00:00Z')
  let calls = 0
  const fetch = transport((url, init) => {
    calls++
    expect(new URL(String(url)).origin).toBe('https://api.anthropic.com')
    expect(init?.redirect).toBe('error')
    expect(new Headers(init?.headers).get('anthropic-version')).toBe(
      '2023-06-01',
    )
    return page([row()])
  })
  let engine = await DiscoveryEngine.open(config, {
    catalog: { fetch, now: () => at },
  })
  try {
    const first = await Promise.all([
      engine.getSettings(),
      engine.getSettings(),
      engine.workspace('owner'),
    ])
    expect(calls).toBe(1)
    expect(first[0].catalog.status).toBe('fresh')
    const revision = first[0].catalog.revision
    const fetchedAt = first[0].catalog.fetchedAt
    await engine.close()
    engine = await DiscoveryEngine.open(config, {
      catalog: { fetch, now: () => at },
    })
    expect((await engine.getSettings()).catalog.fetchedAt).toBe(fetchedAt)
    expect(calls).toBe(1)
    at += CATALOG_TTL_MS - 1
    await engine.workspace('owner')
    expect(calls).toBe(1)
    at++
    expect((await engine.getSettings()).catalog.revision).toBeGreaterThan(
      revision,
    )
    expect(calls).toBe(2)
    await Promise.all([
      engine.getSettings(),
      engine.getSettings(true),
      engine.getSettings(true),
    ])
    expect(calls).toBe(3)
    await engine.close()
    engine = await DiscoveryEngine.open(configFor(dir, 'changed-key'), {
      catalog: {
        now: () => at,
        fetch: transport(() => {
          calls++
          throw new Error('never expose secret detail')
        }),
      },
    })
    const rotated = await engine.getSettings()
    expect(rotated.models).toEqual([])
    expect(rotated.catalog.status).toBe('unavailable')
    expect(rotated.catalog.fetchedAt).toBeNull()
    expect(rotated.catalog.error).not.toContain('secret detail')
    expect(JSON.stringify(rotated)).not.toContain('credentialHash')
    expect(JSON.stringify(rotated)).not.toContain('changed-key')
  } finally {
    await engine.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('pagination publishes atomically; stale failures keep timestamps, back off for sixty seconds, and block new live analysis', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'discovery-model-pages-'))
  const config = configFor(dir)
  const fixture = createProviders(config)
  let at = 1000000
  let calls = 0
  let invalid = false
  const fetch = transport(url => {
    calls++
    const cursor = new URL(String(url)).searchParams.get('after_id')
    if (!cursor) return page([row()], true)
    expect(cursor).toBe(row().id)
    return invalid
      ? Response.json({ data: [], has_more: true, last_id: cursor })
      : page([row('claude-sonnet-5-5')])
  })
  const engine = await DiscoveryEngine.open(config, {
    catalog: { fetch, now: () => at },
    providers: {
      ...fixture,
      capture: (p, v, s) =>
        fixture.capture(
          { ...p, provenance: { ...p.provenance, mode: 'fixture' } },
          v,
          s,
        ),
    },
  })
  try {
    const fresh = await engine.getSettings()
    expect(fresh.models).toHaveLength(2)
    expect(calls).toBe(2)
    invalid = true
    const failedEarly = await engine.getSettings(true)
    expect(failedEarly.catalog.status).toBe('fresh')
    expect(failedEarly.catalog.expiresAt).toBe(fresh.catalog.expiresAt)
    expect(failedEarly.catalog.error).toContain('pagination')
    at += CATALOG_TTL_MS
    const stale = await engine.getSettings()
    expect(stale.models).toEqual(fresh.models)
    expect(stale.catalog.status).toBe('stale')
    expect(stale.catalog.fetchedAt).toBe(fresh.catalog.fetchedAt)
    expect(stale.evaluation.analysisReady).toBe(false)
    const callCount = calls
    await engine.getSettings()
    at += 59999
    await engine.getSettings()
    expect(calls).toBe(callCount)
    at++
    await engine.getSettings()
    expect(calls).toBe(callCount + 2)
    const created = await engine.createCapture({
      projectId: 'default',
      commandId: crypto.randomUUID(),
      input: { ...captureInput, evidenceMode: 'live' },
    })
    await engine.idle()
    const captured = await engine.getRun('default', created.run.id)
    await expect(
      engine.analyze({
        projectId: 'default',
        runId: created.run.id,
        commandId: crypto.randomUUID(),
        expectedRevision: captured.run.revision,
        pageIds: captured.pages.map(p => p.id),
      }),
    ).rejects.toThrow('fresh Anthropic')
    invalid = false
    expect((await engine.getSettings(true)).catalog.status).toBe('fresh')
    expect(calls).toBe(callCount + 4)
  } finally {
    await engine.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('missing credentials and an empty API catalog never manufacture pinned availability; fixture metadata is explicit and cannot authorize live work', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'discovery-model-empty-'))
  let calls = 0
  const fetch = transport(() => {
    calls++
    return page([])
  })
  let engine = await DiscoveryEngine.open(configFor(dir, ''), {
    catalog: { fetch },
  })
  try {
    expect((await engine.getSettings()).models).toEqual([])
    expect(calls).toBe(0)
    await engine.close()
    engine = await DiscoveryEngine.open(configFor(dir), { catalog: { fetch } })
    const empty = await engine.getSettings()
    expect(empty.catalog.status).toBe('fresh')
    expect(empty.models).toEqual([])
    expect(empty.evaluation.analysisReady).toBe(false)
    expect(calls).toBe(1)
    await expect(engine.previewSettings(empty.settings.values)).rejects.toThrow(
      'available',
    )
    await engine.close()
    const config = { ...configFor(dir), modelCatalogFixture: true }
    const fixture = createProviders(config)
    engine = await DiscoveryEngine.open(config, {
      providers: {
        ...fixture,
        capture: (p, v, s) =>
          fixture.capture(
            { ...p, provenance: { ...p.provenance, mode: 'fixture' } },
            v,
            s,
          ),
      },
    })
    const explicit = await engine.getSettings()
    expect(explicit.catalog.source).toBe('fixture')
    expect(explicit.evaluation.analysisReady).toBe(false)
    expect(
      explicit.models.find(m => m.id === 'claude-haiku-5-5')?.selectable,
    ).toBe(false)
    const created = await engine.createCapture({
      projectId: 'default',
      commandId: crypto.randomUUID(),
      input: { ...captureInput, evidenceMode: 'live' },
    })
    await engine.idle()
    const captured = await engine.getRun('default', created.run.id)
    await expect(
      engine.analyze({
        projectId: 'default',
        runId: created.run.id,
        commandId: crypto.randomUUID(),
        expectedRevision: captured.run.revision,
        pageIds: captured.pages.map(p => p.id),
      }),
    ).rejects.toThrow('fresh Anthropic')
    expect(
      readConfig({ DISCOVERY_MODEL_CATALOG_FIXTURE: '1' }).modelCatalogFixture,
    ).toBe(false)
  } finally {
    await engine.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('API limits and partial effort restrictions constrain verified SDK support without inventing prices or absent capability claims', () => {
  const five = row('claude-sonnet-5-5')
  const partial: ApiModel = {
    ...five,
    display_name: 'Official API label',
    max_input_tokens: 200000,
    max_tokens: 16000,
    capabilities: {
      effort: {
        supported: true,
        low: { supported: false },
        medium: { supported: false },
        high: { supported: true },
        xhigh: { supported: false },
        max: { supported: false },
      },
    },
  }
  const merged = mergeApiModels([partial], models)[0]!
  expect(merged.label).toBe('Official API label')
  expect(merged.effectiveContextWindow).toBe(200000)
  expect(merged.effectiveMaxOutputTokens).toBe(16000)
  expect(merged.reasoningLevels).toEqual(['high'])
  expect(merged.capabilitySource).toBe('anthropic-api+pi-ai-1.0.3')
  expect(merged.pricingSource).toBe('pi-ai-1.0.3')
  const missing = mergeApiModels(
    [{ id: five.id, display_name: 'Missing details' }],
    models,
  )[0]!
  expect(missing.maxOutputTokens).toBeNull()
  expect(missing.contextWindow).toBeNull()
  expect(missing.capabilitySource).toBe('pi-ai-1.0.3')
  const unknown = mergeApiModels(
    [
      {
        id: 'unpriced-api-model',
        display_name: 'New model',
        max_tokens: 100000,
        max_input_tokens: 1000000,
      },
    ],
    models,
  )[0]!
  expect(unknown.selectable).toBe(false)
  expect(unknown.pricingSource).toBe('unavailable')
  expect(unknown.disabledReason).toContain('pricing')
  const noEffort = mergeApiModels(
    [{ ...five, capabilities: { effort: { supported: false } } }],
    models,
  )[0]!
  expect(noEffort.selectable).toBe(false)
  const retired = mergeApiModels(
    [{ ...five, lifecycle: 'retired' }],
    models,
  )[0]!
  expect(retired.selectable).toBe(false)
})

test('refresh during a multi-page job preserves admitted execution model and settings; public views and export exclude private model metadata', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'discovery-model-job-'))
  const config = configFor(dir)
  const fixture = createProviders(config)
  let apiRow = row()
  const seen: { settings: AnalysisSettingsSnapshot; model: string }[] = []
  let ready!: () => void
  let release!: () => void
  const first = new Promise<void>(resolve => {
    ready = resolve
  })
  const barrier = new Promise<void>(resolve => {
    release = resolve
  })
  const providers: Providers = {
    ...fixture,
    analyze: async (p, h, i, s, settings, model) => {
      seen.push({ settings: settings!, model: model! })
      if (seen.length === 1) {
        ready()
        await barrier
      }
      return fixture.analyze(p, h, i, s, settings, model)
    },
  }
  const engine = await DiscoveryEngine.open(config, {
    providers,
    catalog: { fetch: transport(() => page([apiRow])) },
  })
  try {
    const created = await engine.createCapture({
      projectId: 'default',
      commandId: crypto.randomUUID(),
      input: captureInput,
    })
    await engine.idle()
    const captured = await engine.getRun('default', created.run.id)
    await engine.analyze({
      projectId: 'default',
      runId: created.run.id,
      commandId: crypto.randomUUID(),
      expectedRevision: captured.run.revision,
      pageIds: captured.pages.map(p => p.id),
    })
    await first
    apiRow = { ...apiRow, max_input_tokens: 200000, max_tokens: 4096 }
    const refreshed = await engine.getSettings(true)
    expect(refreshed.models[0]!.effectiveMaxOutputTokens).toBe(4096)
    expect(refreshed.evaluation.analysisReady).toBe(false)
    release()
    await engine.idle()
    expect(seen).toHaveLength(2)
    expect(seen[1]).toEqual(seen[0])
    expect(JSON.parse(seen[0]!.model).maxTokens).toBeGreaterThan(4096)
    const complete = await engine.getRun('default', created.run.id)
    expect(complete.run.phase).toBe('completed')
    expect(complete.analysisAttempts![1]!.settings!.catalogRevision).toBe(
      seen[0]!.settings.catalogRevision,
    )
    expect(JSON.stringify(complete)).not.toContain('executionModelJson')
    const exported = await engine.exportProject('default')
    expect(exported.json).not.toContain('executionModelJson')
    expect(exported.json).not.toContain('credentialHash')
    expect(exported.json).not.toContain('allowedFallbackModels')
  } finally {
    release()
    await engine.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('malformed metadata and oversized responses never replace the last complete catalog or expose provider bodies', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'discovery-model-invalid-'))
  let response: () => Response = () => page([row()])
  const engine = await DiscoveryEngine.open(configFor(dir), {
    catalog: { fetch: transport(() => response()) },
  })
  try {
    const initial = await engine.getSettings()
    for (const malformed of [
      () =>
        Response.json({ data: [row()], has_more: 'true', last_id: row().id }),
      () =>
        Response.json({
          data: [{ ...row(), capabilities: { effort: { supported: 'true' } } }],
          has_more: false,
          last_id: row().id,
        }),
      () => page([{ ...row(), max_tokens: -1 }]),
      () => new Response('private-provider-error-body', { status: 401 }),
      () => new Response('x'.repeat(2000001)),
    ]) {
      response = malformed
      const rejected = await engine.getSettings(true)
      expect(rejected.models).toEqual(initial.models)
      expect(rejected.catalog.fetchedAt).toBe(initial.catalog.fetchedAt)
      expect(rejected.catalog.error).not.toBe('')
      expect(rejected.catalog.error).not.toContain(
        'private-provider-error-body',
      )
    }
  } finally {
    await engine.close()
    await rm(dir, { recursive: true, force: true })
  }
})

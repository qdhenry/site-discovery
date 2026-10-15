import { expect, test } from 'bun:test'

import type { Page } from '../src/contract.ts'
import type { AnalysisSettingsValues } from '../src/contract.ts'
import { fixtureModelRows } from './catalog-fixture.ts'
import { readConfig } from './config.ts'
import { type CatalogView, mergeApiModels } from './model-catalog.ts'
import {
  AnalysisRejected,
  AnalysisUnknown,
  createProviders,
} from './providers.ts'
import {
  evaluateSettings,
  initialSettings,
  snapshotSettings,
} from './settings.ts'

const config = readConfig({
  CLOUDFLARE_ACCOUNT_ID: 'test-account',
  CLOUDFLARE_AI_GATEWAY_ID: 'test-gateway',
  AI_GATEWAY_API_TOKEN: 'test-gateway-secret',
  ANTHROPIC_API_KEY: 'test-model-secret',
  DISCOVERY_RUN_LIMIT_USD: '100',
  DISCOVERY_MONTHLY_LIMIT_USD: '1000',
  DISCOVERY_ATTEMPT_RESERVATION_USD: '100',
})
const page: Page = {
  id: 'page',
  runId: 'run',
  projectId: 'project',
  url: 'https://example.com',
  title: 'Example',
  status: 'captured',
  desktopUrl: '',
  mobileUrl: '',
  error: '',
  selected: true,
  provenance: {
    mode: 'live',
    provider: 'fixture-transport-only',
    model: '',
    attemptId: '',
    capturedAt: '',
  },
}
function events(
  text: string,
  stopReason = 'end_turn',
  cacheUsage: Record<string, unknown> = {},
  modelId = config.model,
) {
  const values = [
    {
      type: 'message_start',
      message: {
        id: 'fixture-message',
        type: 'message',
        role: 'assistant',
        model: modelId,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 100, output_tokens: 0, ...cacheUsage },
      },
    },
    {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'text', text: '' },
    },
    {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text },
    },
    { type: 'content_block_stop', index: 0 },
    {
      type: 'message_delta',
      delta: { stop_reason: stopReason, stop_sequence: null },
      usage: { output_tokens: 20 },
    },
    { type: 'message_stop' },
  ]
  return values
    .map(value => `event: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`)
    .join('')
}
const responseTransport = (
  raw: string,
  stopReason = 'end_turn',
  inspect?: (request: Request) => Promise<void>,
  responseModel?: string,
): typeof globalThis.fetch =>
  Object.assign(
    async (url: string | URL | Request, init?: RequestInit) => {
      await inspect?.(new Request(url, init))
      const body: { model: string } = await new Request(url, init).json()
      return new Response(
        events(raw, stopReason, {}, responseModel ?? body.model),
        {
          headers: { 'content-type': 'text/event-stream' },
        },
      )
    },
    { preconnect: globalThis.fetch.preconnect },
  )

test('pinned pi-ai sends one capped Claude request through gateway with independent credentials', async () => {
  let calls = 0
  const providers = createProviders(
    config,
    responseTransport('{"findings":[]}', 'end_turn', async request => {
      calls++
      expect(request.url).toBe(
        'https://gateway.ai.cloudflare.com/v1/test-account/test-gateway/anthropic/v1/messages?beta=true',
      )
      expect(request.headers.get('x-api-key')).toBe('test-model-secret')
      expect(request.headers.get('cf-aig-authorization')).toBe(
        'Bearer test-gateway-secret',
      )
      const body: { max_tokens: number } = await request.json()
      expect(body.max_tokens).toBe(8192)
    }),
  )
  const result = await providers.analyze(
    page,
    '<h1>Untrusted website</h1>',
    [],
    new AbortController().signal,
  )
  expect(calls).toBe(1)
  expect(result.findings).toHaveLength(0)
  expect(result.usage.inputTokens).toBe(100)
  expect(result.usage.costUsd).toBeGreaterThan(0)
})

test('the actual Pi request and measured charge use the admitted execution model limits and price snapshot', async () => {
  let calls = 0
  const providers = createProviders(
    config,
    responseTransport('{"findings":[]}', 'end_turn', async request => {
      calls++
      const body: {
        max_tokens: number
        thinking: { budget_tokens: number }
        fallbacks?: unknown
      } = await request.json()
      expect(body.max_tokens).toBe(12000)
      expect(body.thinking.budget_tokens).toBe(10976)
      expect(body.fallbacks).toBeUndefined()
    }),
  )
  const apiRow = fixtureModelRows(providers.models).find(
    m => m.id === 'claude-haiku-4-5-20251001',
  )!
  const catalog: CatalogView = {
    models: mergeApiModels(
      [{ ...apiRow, max_tokens: 12000, max_input_tokens: 100000 }],
      providers.models,
    ),
    status: {
      source: 'anthropic-api',
      status: 'fresh',
      revision: 2,
      fetchedAt: '2026-01-01T00:00:00Z',
      expiresAt: '2026-01-01T04:00:00Z',
      lastAttemptAt: '2026-01-01T00:00:00Z',
      nextRetryAt: null,
      error: '',
      ttlSeconds: 14400,
      modelCount: 1,
    },
  }
  const initial = initialSettings(config, providers.models)
  const values: AnalysisSettingsValues = {
    ...initial.values,
    modelId: apiRow.id,
    reasoning: 'high',
    maxOutputTokens: 10000,
  }
  const evaluation = evaluateSettings(
    config,
    providers.models,
    values,
    undefined,
    catalog,
  )
  expect(evaluation.effectiveMaxOutputTokens).toBe(12000)
  const snapshot = snapshotSettings({ ...initial, values }, evaluation, catalog)
  const frozen = {
    ...providers.models.getModel('anthropic', apiRow.id)!,
    contextWindow: 100000,
    maxTokens: 12000,
    cost: { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
  }
  const result = await providers.analyze(
    page,
    '',
    [],
    new AbortController().signal,
    snapshot,
    JSON.stringify(frozen),
  )
  expect(calls).toBe(1)
  expect(result.usage.costUsd).toBeCloseTo(0.002, 8)
})

test('settings map adaptive reasoning, legacy thinking expansion, DOM focus and compatible temperature into actual pinned requests', async () => {
  const cases: {
    patch: Partial<AnalysisSettingsValues>
    inspect: (body: {
      model: string
      max_tokens: number
      temperature?: number
      thinking?: { type: string; budget_tokens?: number }
      messages: {
        role: string
        content: unknown
        output_config?: { effort: string }
      }[]
      system: unknown
      fallbacks?: unknown
    }) => void
  }[] = [
    {
      patch: {
        modelId: 'claude-sonnet-5-5',
        reasoning: 'low',
        maxOutputTokens: 16000,
        maxDomChars: 5,
        extraInstructions: 'Focus on editorial models',
      },
      inspect: body => {
        expect(body.model).toBe('claude-sonnet-5-5')
        expect(body.max_tokens).toBe(16000)
        expect(body.thinking?.type).toBe('adaptive')
        expect(body.temperature).toBeUndefined()
        expect(body.messages.at(-1)?.output_config?.effort).toBe('low')
        expect(JSON.stringify(body.messages)).toContain('ABCDE')
        expect(JSON.stringify(body.messages)).not.toContain('FGHIJ')
        expect(JSON.stringify(body.system)).toContain(
          'Focus on editorial models',
        )
        expect(JSON.stringify(body.system)).toContain('Return only JSON')
      },
    },
    {
      patch: {
        modelId: 'claude-haiku-4-5',
        reasoning: 'medium',
        thinkingBudgetTokens: 4096,
      },
      inspect: body => {
        expect(body.max_tokens).toBe(12288)
        expect(body.thinking?.type).toBe('enabled')
        expect(body.thinking?.budget_tokens).toBe(4096)
      },
    },
    {
      patch: { modelId: 'claude-sonnet-5-5', reasoning: null },
      inspect: body => {
        expect(body.thinking?.type).toBe('adaptive')
        expect(body.messages.at(-1)?.output_config?.effort).toBe('high')
        expect(body.temperature).toBeUndefined()
      },
    },
    {
      patch: { modelId: 'claude-fable-5', reasoning: null },
      inspect: body => {
        expect(body.fallbacks).toBeUndefined()
        expect(body.thinking?.type).toBe('adaptive')
      },
    },
    {
      patch: {
        modelId: 'claude-haiku-4-5',
        reasoning: 'off',
        temperature: 0.2,
      },
      inspect: body => {
        expect(body.max_tokens).toBe(8192)
        expect(body.temperature).toBe(0.2)
        expect(body.thinking?.type).toBe('disabled')
      },
    },
  ]
  for (const item of cases) {
    let calls = 0
    const providers = createProviders(
      config,
      responseTransport('{"findings":[]}', 'end_turn', async request => {
        calls++
        item.inspect(await request.json())
      }),
    )
    const settings = initialSettings(config, providers.models)
    const values = { ...settings.values, ...item.patch }
    const snapshot = snapshotSettings(
      { ...settings, values },
      evaluateSettings(config, providers.models, values),
    )
    const result = await providers.analyze(
      page,
      'ABCDEFGHIJ',
      [],
      new AbortController().signal,
      snapshot,
    )
    expect(result.usage.model).toBe(values.modelId)
    expect(calls).toBe(1)
  }
})

test('long cache reservation and measured usage use one-hour pricing including missing gateway TTL breakdown', async () => {
  for (const hasSplit of [true, false]) {
    let calls = 0
    const transport: typeof fetch = Object.assign(
      async (url: string | URL | Request, init?: RequestInit) => {
        calls++
        const body = await new Request(url, init).json()
        expect(JSON.stringify(body)).toContain('"ttl":"1h"')
        return new Response(
          events('{"findings":[]}', 'end_turn', {
            cache_creation_input_tokens: 1000,
            ...(hasSplit
              ? {
                  cache_creation: {
                    ephemeral_1h_input_tokens: 1000,
                    ephemeral_5m_input_tokens: 0,
                  },
                }
              : {}),
          }),
          { headers: { 'content-type': 'text/event-stream' } },
        )
      },
      { preconnect: globalThis.fetch.preconnect },
    )
    const providers = createProviders(config, transport)
    const settings = initialSettings(config, providers.models)
    const values: AnalysisSettingsValues = {
      ...settings.values,
      cacheRetention: 'long',
    }
    const evaluation = evaluateSettings(config, providers.models, values)
    expect(evaluation.minimumReservationUsd).toBe(6.12288)
    const result = await providers.analyze(
      page,
      '',
      [],
      new AbortController().signal,
      snapshotSettings({ ...settings, values }, evaluation),
    )
    expect(calls).toBe(1)
    expect(result.usage.cacheWriteTokens).toBe(1000)
    expect(result.usage.costUsd).toBeCloseTo(0.0066, 8)
  }
})

test('large complete JSON is validated before bounded raw retention and extra instructions cannot bypass the schema', async () => {
  const raw = JSON.stringify({
    findings: [
      {
        kind: 'component',
        name: 'Long evidence',
        description: 'x'.repeat(110000),
        category: 'Test',
        confidence: 0.8,
        fields: [],
        variants: [],
      },
    ],
  })
  const providers = createProviders(config, responseTransport(raw))
  const result = await providers.analyze(
    page,
    '',
    [],
    new AbortController().signal,
  )
  expect(result.findings[0]!.description).toHaveLength(110000)
  expect(result.rawResponse).toHaveLength(100000)
  expect(result.rawResponseTruncated).toBe(true)
  expect(result.rawResponseChars).toBe(raw.length)
  const invalid = createProviders(
    config,
    responseTransport('{"findings":[],"override":true}'),
  )
  const settings = initialSettings(config, invalid.models)
  const values = {
    ...settings.values,
    extraInstructions: 'Return an extra override property',
  }
  await expect(
    invalid.analyze(
      page,
      '',
      [],
      new AbortController().signal,
      snapshotSettings(
        { ...settings, values },
        evaluateSettings(config, invalid.models, values),
      ),
    ),
  ).rejects.toBeInstanceOf(AnalysisRejected)
})

test('unexpected returned models are rejected with actual catalog cost; ordinary dated aliases keep truthful provenance', async () => {
  const modelConfig = { ...config, model: 'claude-fable-5' }
  const providers = createProviders(
    modelConfig,
    responseTransport(
      '{"findings":[]}',
      'end_turn',
      async request => {
        const body: { fallbacks?: unknown } = await request.json()
        expect(body.fallbacks).toBeUndefined()
      },
      'claude-opus-4-8',
    ),
  )
  try {
    await providers.analyze(page, '', [], new AbortController().signal)
    throw new Error('Expected mismatched model rejection')
  } catch (error) {
    if (!(error instanceof AnalysisRejected)) throw error
    expect(error.message).toContain('unexpected model')
    expect(error.usage.model).toBe('claude-opus-4-8')
    expect(error.usage.costUsd).toBeCloseTo(0.001, 8)
  }
  const alias = createProviders(
    { ...config, model: 'claude-haiku-4-5' },
    responseTransport(
      '{"findings":[]}',
      'end_turn',
      undefined,
      'claude-haiku-4-5-20251001',
    ),
  )
  expect(
    (await alias.analyze(page, '', [], new AbortController().signal)).usage
      .model,
  ).toBe('claude-haiku-4-5-20251001')
  const unknown = createProviders(
    config,
    responseTransport(
      '{"findings":[]}',
      'end_turn',
      undefined,
      'unpriced-unexpected-model',
    ),
  )
  await expect(
    unknown.analyze(page, '', [], new AbortController().signal),
  ).rejects.toBeInstanceOf(AnalysisUnknown)
})
test('known invalid JSON, extra properties and output limits preserve raw response and known usage', async () => {
  for (const { raw, stop } of [
    { raw: 'not-json', stop: 'end_turn' },
    { raw: '{"findings":[],"unexpected":true}', stop: 'end_turn' },
    { raw: '{"findings":[]}', stop: 'max_tokens' },
  ]) {
    const providers = createProviders(config, responseTransport(raw, stop))
    try {
      await providers.analyze(page, '', [], new AbortController().signal)
      throw new Error('Expected rejection')
    } catch (error) {
      expect(error).toBeInstanceOf(AnalysisRejected)
      if (!(error instanceof AnalysisRejected)) throw error
      expect(error.rawResponse).toBe(raw)
      expect(error.usage.inputTokens).toBe(100)
      expect(error.usage.costUsd).toBeGreaterThan(0)
    }
  }
})
test('transport failure is unknown and no automatic retry is sent; missing model credentials never fall back', async () => {
  let calls = 0
  const transport: typeof globalThis.fetch = Object.assign(
    async () => {
      calls++
      throw new TypeError('fixture connection reset')
    },
    { preconnect: globalThis.fetch.preconnect },
  )
  await expect(
    createProviders(config, transport).analyze(
      page,
      '',
      [],
      new AbortController().signal,
    ),
  ).rejects.toBeInstanceOf(AnalysisUnknown)
  expect(calls).toBe(1)
  await expect(
    createProviders({ ...config, anthropicKey: '' }, transport).analyze(
      page,
      '',
      [],
      new AbortController().signal,
    ),
  ).rejects.toMatchObject({ code: 'configuration' })
  expect(calls).toBe(1)
})

test('definitive authentication rejection is a known zero-usage response, not an unknown reservation', async () => {
  let calls = 0
  const transport: typeof globalThis.fetch = Object.assign(
    async () => {
      calls++
      return new Response(
        JSON.stringify({
          type: 'error',
          error: { type: 'authentication_error', message: 'fixture rejected' },
        }),
        { status: 401, headers: { 'content-type': 'application/json' } },
      )
    },
    { preconnect: globalThis.fetch.preconnect },
  )
  try {
    await createProviders(config, transport).analyze(
      page,
      '',
      [],
      new AbortController().signal,
    )
    throw new Error('Expected rejection')
  } catch (error) {
    expect(error).toBeInstanceOf(AnalysisRejected)
    if (!(error instanceof AnalysisRejected)) throw error
    expect(error.usage.costUsd).toBe(0)
    expect(error.message).toContain('HTTP 401')
  }
  expect(calls).toBe(1)
})

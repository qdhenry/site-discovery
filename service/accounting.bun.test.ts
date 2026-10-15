import { expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { CaptureInput, Usage } from '../src/contract.ts'
import { readConfig } from './config.ts'
import { DiscoveryEngine } from './engine.ts'
import {
  AnalysisRejected,
  type Providers,
  createProviders,
} from './providers.ts'
import { openTestEngine } from './test-fixtures/engine.ts'

const input: CaptureInput = {
  mode: 'single',
  source: 'https://example.com',
  depth: 1,
  maxPages: 1,
  desktop: true,
  mobile: false,
  targetCms: 'generic',
  evidenceMode: 'live',
}
const usage: Usage = {
  model: 'mock-model',
  inputTokens: 100,
  outputTokens: 20,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  costUsd: 0.002,
  reservedUsd: 0,
  analyzedPages: 0,
  durationMs: 1,
}
async function use(
  overrides: Partial<Providers>,
  fn: (engine: DiscoveryEngine) => Promise<void>,
  runLimit = '1',
) {
  const dir = await mkdtemp(join(tmpdir(), 'discovery-accounting-'))
  const config = readConfig({
    DISCOVERY_STATE_DIR: dir,
    DISCOVERY_FIXTURES: '1',
    CLOUDFLARE_ACCOUNT_ID: 'fixture',
    CLOUDFLARE_BROWSER_API_TOKEN: 'fixture',
    CLOUDFLARE_AI_GATEWAY_ID: 'fixture',
    AI_GATEWAY_API_TOKEN: 'fixture',
    ANTHROPIC_API_KEY: 'fixture',
    DISCOVERY_RUN_LIMIT_USD: runLimit,
    DISCOVERY_MONTHLY_LIMIT_USD: '1',
    DISCOVERY_ATTEMPT_RESERVATION_USD: '0.01',
  })
  const fixture = createProviders(config)
  const engine = await openTestEngine(config, {
    providers: {
      ...fixture,
      reservationBoundUsd: 0.001,
      capture: (page, viewport, signal) =>
        fixture.capture(
          { ...page, provenance: { ...page.provenance, mode: 'fixture' } },
          viewport,
          signal,
        ),
      ...overrides,
    },
  })
  try {
    await fn(engine)
  } finally {
    await engine.close()
    await rm(dir, { recursive: true, force: true })
  }
}
async function capture(engine: DiscoveryEngine) {
  const created = await engine.createCapture({
    projectId: 'default',
    commandId: crypto.randomUUID(),
    input,
  })
  await engine.idle()
  return engine.getRun('default', created.run.id)
}
async function analyze(
  engine: DiscoveryEngine,
  run: Awaited<ReturnType<typeof capture>>,
) {
  await engine.analyze({
    projectId: 'default',
    runId: run.run.id,
    commandId: crypto.randomUUID(),
    expectedRevision: run.run.revision,
    pageIds: run.pages.map(p => p.id),
  })
  await engine.idle()
  return engine.getRun('default', run.run.id)
}

test('known invalid response retains bounded response and measured usage, charges once and releases only that reservation', () =>
  use(
    {
      analyze: async () => {
        throw new AnalysisRejected(
          'Invalid JSON fixture',
          usage,
          'not JSON but a known final response',
        )
      },
    },
    async engine => {
      const result = await analyze(engine, await capture(engine))
      expect(result.run.phase).toBe('requires_retry')
      expect(result.budget.reservedUsd).toBe(0)
      expect(result.budget.spentUsd).toBe(0.002)
      expect(result.run.usage.inputTokens).toBe(100)
      const exported = JSON.parse((await engine.exportProject('default')).json)
      expect(exported.analysisEvidence[0].rawResponse).toBe(
        'not JSON but a known final response',
      )
      expect(exported.analysisEvidence[0].status).toBe('completed')
      await engine.idle()
      expect((await engine.workspace('s')).budget.spentUsd).toBe(0.002)
    },
  ))
test('oversized image is a preflight failure with zero model calls and zero liabilities', async () => {
  let calls = 0
  await use(
    {
      capture: async () => ({
        bytes: new Uint8Array(5_000_001),
        html: '<h1>fixture</h1>',
        title: 'Large fixture',
        extension: 'png',
      }),
      analyze: async () => {
        calls++
        return { findings: [], usage, rawResponse: '{}' }
      },
    },
    async engine => {
      const result = await analyze(engine, await capture(engine))
      expect(result.run.phase).toBe('requires_retry')
      expect(calls).toBe(0)
      expect(result.budget.reservedUsd).toBe(0)
      expect(result.budget.spentUsd).toBe(0)
    },
  )
})
test('spending cap refuses before dispatch and one active run serializes admission', async () => {
  let calls = 0
  await use(
    {
      analyze: async () => {
        calls++
        return { findings: [], usage, rawResponse: '{}' }
      },
    },
    async engine => {
      const created = await engine.createCapture({
        projectId: 'default',
        commandId: crypto.randomUUID(),
        input,
      })
      await expect(
        engine.createCapture({
          projectId: 'default',
          commandId: crypto.randomUUID(),
          input,
        }),
      ).rejects.toMatchObject({ code: 'busy' })
      await engine.idle()
      await expect(
        analyze(engine, await engine.getRun('default', created.run.id)),
      ).rejects.toMatchObject({ code: 'configuration' })
      const result = await engine.getRun('default', created.run.id)
      expect(result.run.phase).toBe('captured')
      expect(calls).toBe(0)
      expect(result.budget.reservedUsd).toBe(0)
    },
    '0.005',
  )
})

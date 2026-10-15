import { expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import {
  Harness,
  type JsonObject,
  ROOT_CONVERSATION_ID,
  createRegistry,
  defineDoc,
  defineTask,
} from '@earendil-works/pi-durable'

import type { AnalysisSettingsSnapshot, CaptureInput } from '../src/contract.ts'
import { type Config, readConfig } from './config.ts'
import { DiscoveryEngine } from './engine.ts'
import {
  AnalysisUnknown,
  type Providers,
  createProviders,
} from './providers.ts'
import {
  analysisModels,
  evaluateSettings,
  initialSettings,
  validateSettings,
} from './settings.ts'
import { openStorage } from './sqlite.ts'
import { openTestEngine } from './test-fixtures/engine.ts'

const input: CaptureInput = {
  mode: 'batch',
  source: 'https://example.com/a\nhttps://example.com/b',
  depth: 1,
  maxPages: 2,
  desktop: true,
  mobile: true,
  targetCms: 'generic',
  evidenceMode: 'fixture',
}
const configFor = (dir: string): Config =>
  readConfig({
    DISCOVERY_STATE_DIR: dir,
    DISCOVERY_FIXTURES: '1',
    CLOUDFLARE_ACCOUNT_ID: 'test',
    CLOUDFLARE_BROWSER_API_TOKEN: 'test',
    CLOUDFLARE_AI_GATEWAY_ID: 'test',
    AI_GATEWAY_API_TOKEN: 'test',
    ANTHROPIC_API_KEY: 'test',
    DISCOVERY_RUN_LIMIT_USD: '100',
    DISCOVERY_MONTHLY_LIMIT_USD: '1000',
    DISCOVERY_ATTEMPT_RESERVATION_USD: '20',
  })
const capture = async (engine: DiscoveryEngine, live = false) => {
  const created = await engine.createCapture({
    projectId: 'default',
    commandId: crypto.randomUUID(),
    input: { ...input, evidenceMode: live ? 'live' : 'fixture' },
  })
  await engine.idle()
  return engine.getRun('default', created.run.id)
}
const start = (
  engine: DiscoveryEngine,
  run: Awaited<ReturnType<typeof capture>>,
) =>
  engine.analyze({
    projectId: 'default',
    runId: run.run.id,
    commandId: crypto.randomUUID(),
    expectedRevision: run.run.revision,
    pageIds: run.pages.map(p => p.id),
  })

test('pinned model capabilities reject incompatible options and include expanded thinking and long-cache reservation', () => {
  const config = configFor('/tmp/unused-discovery-settings')
  const models = createProviders(config).models
  const catalog = analysisModels(models)
  const five = catalog.find(m => m.id === 'claude-sonnet-5-5')!
  expect(five.reasoningLevels).toEqual([
    'low',
    'medium',
    'high',
    'xhigh',
    'max',
  ])
  expect(five.defaultReasoning).toBe('high')
  expect(five.supportsTemperature).toBe(false)
  expect(
    catalog.find(m => m.id === 'claude-sonnet-5')!.supportsTemperature,
  ).toBe(false)
  const defaults = initialSettings(config, models).values
  expect(defaults.maxOutputTokens).toBe(8192)
  expect(() =>
    validateSettings(models, {
      ...defaults,
      modelId: five.id,
      reasoning: 'off',
    }),
  ).toThrow('reasoning')
  expect(() =>
    validateSettings(models, {
      ...defaults,
      modelId: five.id,
      reasoning: 'high',
      temperature: 0.2,
    }),
  ).toThrow('Temperature')
  expect(() =>
    validateSettings(models, { ...defaults, maxOutputTokens: 128001 }),
  ).toThrow('Output')
  expect(() =>
    validateSettings(models, {
      ...defaults,
      screenshotEvidence: 'none',
      maxDomChars: 0,
    }),
  ).toThrow('evidence')
  expect(() =>
    validateSettings(models, {
      ...defaults,
      extraInstructions: 'x'.repeat(8001),
    }),
  ).toThrow('8000')
  expect(() =>
    validateSettings(models, { ...defaults, thinkingBudgetTokens: 2048 }),
  ).toThrow('thinking')
  const legacy = {
    ...defaults,
    modelId: 'claude-haiku-4-5',
    reasoning: 'medium' as const,
    thinkingBudgetTokens: 4096,
  }
  const evaluation = evaluateSettings(config, models, legacy)
  expect(evaluation.effectiveMaxOutputTokens).toBe(12288)
  expect(evaluation.effectiveThinkingBudgetTokens).toBe(4096)
  const long = evaluateSettings(config, models, {
    ...legacy,
    cacheRetention: 'long',
  })
  expect(long.minimumReservationUsd).toBe(0.46144)
  expect(long.minimumReservationUsd).toBeGreaterThan(
    evaluation.minimumReservationUsd,
  )
  expect(
    evaluateSettings(config, models, { ...defaults, runLimitUsd: null })
      .analysisReady,
  ).toBe(false)
  const tooSmall = evaluateSettings(config, models, {
    ...defaults,
    runLimitUsd: 1,
    monthlyLimitUsd: 1,
  })
  expect(tooSmall.analysisReady).toBe(false)
  expect(tooSmall.issues).toContain(
    'Attempt reservation exceeds the run spending limit',
  )
  expect(tooSmall.issues).toContain(
    'Attempt reservation exceeds the monthly spending limit',
  )
})

test('settings CAS, command replay, preview and restart preserve explicit values without invoking providers', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'discovery-settings-'))
  const config = configFor(dir)
  let calls = 0
  let engine = await openTestEngine(config, {
    providers: {
      ...createProviders(config),
      analyze: async () => {
        calls++
        throw new Error('Must not call')
      },
    },
  })
  try {
    const first = await engine.getSettings()
    const command = {
      commandId: crypto.randomUUID(),
      expectedRevision: first.settings.revision,
      values: {
        ...first.settings.values,
        maxOutputTokens: 12000,
        runLimitUsd: null,
      },
    }
    const saved = await engine.saveSettings(command)
    expect(saved.settings.revision).toBe(1)
    expect(saved.evaluation.analysisReady).toBe(false)
    expect(
      (
        await engine.previewSettings({
          ...saved.settings.values,
          runLimitUsd: 30,
        })
      ).analysisReady,
    ).toBe(true)
    await engine.saveSettings({
      commandId: crypto.randomUUID(),
      expectedRevision: 1,
      values: {
        ...saved.settings.values,
        extraInstructions: 'Focus on editorial content',
      },
    })
    expect(await engine.saveSettings(command)).toEqual(saved)
    await expect(
      engine.saveSettings({ ...command, commandId: crypto.randomUUID() }),
    ).rejects.toMatchObject({ code: 'conflict' })
    await expect(
      engine.saveSettings({
        ...command,
        values: { ...command.values, modelId: 'invented-model' },
      }),
    ).rejects.toMatchObject({ code: 'conflict' })
    await expect(
      engine.previewSettings({ ...command.values, temperature: -1 }),
    ).rejects.toMatchObject({ code: 'validation' })
    expect(calls).toBe(0)
    await engine.close()
    engine = await openTestEngine({
      ...config,
      model: 'claude-haiku-4-5',
      runLimitUsd: 999,
    })
    const after = await engine.getSettings()
    expect(after.settings.revision).toBe(2)
    expect(after.settings.values.modelId).toBe(config.model)
    expect(after.settings.values.maxOutputTokens).toBe(12000)
    expect(after.settings.values.runLimitUsd).toBeNull()
  } finally {
    await engine.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('one admitted multi-page job keeps its settings while retry uses latest values and retains uncertainty', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'discovery-settings-job-'))
  const config = configFor(dir)
  const fixture = createProviders(config)
  const seen: AnalysisSettingsSnapshot[] = []
  let notifyFirst = () => {}
  let releaseFirst = () => {}
  const first = new Promise<void>(resolve => {
    notifyFirst = resolve
  })
  const release = new Promise<void>(resolve => {
    releaseFirst = resolve
  })
  const providers: Providers = {
    ...fixture,
    analyze: async (page, html, images, signal, settings) => {
      seen.push(settings!)
      if (seen.length === 1) {
        notifyFirst()
        await release
      }
      if (seen.length === 2)
        throw new AnalysisUnknown('Unknown fixture transport', '', null)
      return fixture.analyze(page, html, images, signal, settings)
    },
  }
  const engine = await openTestEngine(config, { providers })
  try {
    const run = await capture(engine)
    await start(engine, run)
    await first
    const original = await engine.getSettings()
    await engine.saveSettings({
      commandId: crypto.randomUUID(),
      expectedRevision: 0,
      values: {
        ...original.settings.values,
        modelId: 'claude-sonnet-5-5',
        reasoning: 'low',
        maxOutputTokens: 16000,
        extraInstructions: 'Focus on forms',
        screenshotEvidence: 'none',
        maxDomChars: 1000,
      },
    })
    releaseFirst()
    await engine.idle()
    expect(seen).toHaveLength(2)
    expect(seen[1]).toEqual(seen[0])
    const failed = await engine.getRun('default', run.run.id)
    expect(failed.run.phase).toBe('requires_retry')
    expect(failed.analysisAttempts![1]!.settings!.values.maxOutputTokens).toBe(
      8192,
    )
    await engine.retry({
      projectId: 'default',
      runId: run.run.id,
      commandId: crypto.randomUUID(),
      expectedRevision: failed.run.revision,
    })
    await engine.idle()
    expect(seen[2]!.settingsRevision).toBe(1)
    expect(seen[2]!.values.extraInstructions).toBe('Focus on forms')
    expect(seen[2]!.values.maxOutputTokens).toBe(16000)
    expect(
      (await engine.getRun('default', run.run.id)).analysisAttempts![1]!.status,
    ).toBe('unknown')
  } finally {
    releaseFirst()
    await engine.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('lowering current caps blocks the next page without changing the job snapshot or erasing spent liability', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'discovery-settings-limit-'))
  const config = configFor(dir)
  const fixture = createProviders(config)
  let calls = 0
  let engine: DiscoveryEngine
  const providers: Providers = {
    ...fixture,
    capture: (p, v, s) =>
      fixture.capture(
        { ...p, provenance: { ...p.provenance, mode: 'fixture' } },
        v,
        s,
      ),
    analyze: async (p, h, i, s, settings) => {
      calls++
      const current = await engine.getSettings()
      await engine.saveSettings({
        commandId: crypto.randomUUID(),
        expectedRevision: current.settings.revision,
        values: { ...current.settings.values, monthlyLimitUsd: 1 },
      })
      const result = await fixture.analyze(
        { ...p, provenance: { ...p.provenance, mode: 'fixture' } },
        h,
        i,
        s,
        settings,
      )
      return { ...result, usage: { ...result.usage, costUsd: 0.25 } }
    },
  }
  engine = await openTestEngine(config, { providers })
  try {
    const run = await capture(engine, true)
    await start(engine, run)
    await engine.idle()
    const result = await engine.getRun('default', run.run.id)
    expect(calls).toBe(1)
    expect(result.run.phase).toBe('requires_retry')
    expect(result.budget.spentUsd).toBe(0.25)
    expect(result.budget.monthlyLimitUsd).toBe(1)
    expect(result.analysisAttempts![0]!.settings!.values.monthlyLimitUsd).toBe(
      1000,
    )
  } finally {
    await engine.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('evidence settings select only requested screenshots and unavailable image-only evidence blocks before dispatch', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'discovery-settings-evidence-'))
  const config = configFor(dir)
  const fixture = createProviders(config)
  const observed: string[][] = []
  const engine = await openTestEngine(config, {
    providers: {
      ...fixture,
      analyze: (p, h, images, signal, settings) => {
        observed.push(
          images.map(image => new TextDecoder().decode(image.bytes)),
        )
        return fixture.analyze(p, h, images, signal, settings)
      },
    },
  })
  try {
    for (const screenshotEvidence of ['desktop', 'mobile', 'none'] as const) {
      const current = await engine.getSettings()
      await engine.saveSettings({
        commandId: crypto.randomUUID(),
        expectedRevision: current.settings.revision,
        values: {
          ...current.settings.values,
          screenshotEvidence,
          maxDomChars: screenshotEvidence === 'none' ? 100 : 0,
        },
      })
      const run = await capture(engine)
      await start(engine, run)
      await engine.idle()
      const received = observed.at(-1)!
      expect(received).toHaveLength(screenshotEvidence === 'none' ? 0 : 1)
      if (screenshotEvidence !== 'none')
        expect(received[0]).toContain(screenshotEvidence.toUpperCase())
    }
    const current = await engine.getSettings()
    await engine.saveSettings({
      commandId: crypto.randomUUID(),
      expectedRevision: current.settings.revision,
      values: {
        ...current.settings.values,
        screenshotEvidence: 'desktop',
        maxDomChars: 0,
      },
    })
    const created = await engine.createCapture({
      projectId: 'default',
      commandId: crypto.randomUUID(),
      input: { ...input, desktop: false },
    })
    await engine.idle()
    const calls = observed.length
    await start(engine, await engine.getRun('default', created.run.id))
    await engine.idle()
    const blocked = await engine.getRun('default', created.run.id)
    expect(observed).toHaveLength(calls)
    expect(blocked.run.error).toContain('evidence is unavailable')
    expect(blocked.analysisAttempts).toHaveLength(0)
    expect(blocked.budget.reservedUsd).toBe(0)
  } finally {
    await engine.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('real version-one Pi document delta chain migrates library, receipts, commands and inflight task without replay', async () => {
  const originalDir = await mkdtemp(
    join(tmpdir(), 'discovery-settings-v1-source-'),
  )
  const dir = await mkdtemp(join(tmpdir(), 'discovery-settings-v1-target-'))
  const config = configFor(dir)
  const original = await openTestEngine(configFor(originalDir))
  let legacyValue: JsonObject = {}
  let runId = ''
  let pageId = ''
  let expectedLibrary: Awaited<ReturnType<DiscoveryEngine['library']>> = []
  try {
    const run = await capture(original)
    await start(original, run)
    await original.idle()
    const result = await original.getRun('default', run.run.id)
    await original.save({
      projectId: 'default',
      runId: run.run.id,
      commandId: 'legacy-save-command',
      expectedRevision: result.run.revision,
      expectedProjectRevision: 0,
      choices: result.findings.map(f => ({
        findingId: f.id,
        action: 'create',
        targetId: '',
      })),
    })
    expectedLibrary = await original.library('default')
    const token = defineDoc<JsonObject>({
      kind: 'discovery.application',
      version: 2,
      scope: 'session',
      initial: () => ({}),
    })
    legacyValue = JSON.parse(
      JSON.stringify(
        await original.harness.snapshot(token, BACKGROUND_CONTEXT),
      ),
    )
    delete legacyValue.settings
    runId = run.run.id
    pageId = result.pages[0]!.id
    const runs: Record<string, JsonObject> = JSON.parse(
      JSON.stringify(legacyValue.runs),
    )
    for (const r of Object.values(runs)) delete r.analysisSettings
    legacyValue.runs = runs
    const attempts: Record<string, JsonObject> = JSON.parse(
      JSON.stringify(legacyValue.attempts),
    )
    for (const a of Object.values(attempts)) {
      delete a.analysisSettings
      delete a.rawResponseChars
      delete a.rawResponseTruncated
    }
    attempts['legacy-inflight'] = {
      id: 'legacy-inflight',
      projectId: 'default',
      runId,
      pageId,
      stage: 'analysis',
      status: 'inflight',
      rawResponse: '',
      diagnostic: '',
      measuredUsage: null,
      reservedMicros: 13000,
      spentMicros: 0,
      month: new Date().toISOString().slice(0, 7),
    }
    legacyValue.attempts = attempts
    legacyValue.activeRunId = runId
  } finally {
    await original.close()
  }
  const legacy = defineDoc<JsonObject>({
    kind: 'discovery.application',
    version: 1,
    scope: 'session',
    initial: () => legacyValue,
  })
  const task = defineTask<
    { runId: string; stage: 'analysis' },
    {
      phase: 'inflight'
      step: number
      pageId: string
      viewport: 'desktop'
      attemptId: string
    },
    { runId: string }
  >({
    name: 'discovery.work',
    version: 1,
    initial: () => ({
      phase: 'inflight',
      step: 0,
      pageId,
      viewport: 'desktop',
      attemptId: 'legacy-inflight',
    }),
    phases: {
      inflight: async () => {
        throw new Error('Legacy harness must not resume')
      },
    },
    abort: async () => {
      throw new Error('Legacy harness must not abort')
    },
  })
  const registry = createRegistry()
  registry.install({ name: 'legacy', tasks: [task] })
  const providers = createProviders(config)
  const harness = await Harness.open(
    await openStorage(join(dir, 'harness.sqlite')),
    { models: providers.models, registry },
    BACKGROUND_CONTEXT,
  )
  await harness.root(BACKGROUND_CONTEXT)
  await harness.commit(async tx => {
    await tx.doc(legacy)
  }, BACKGROUND_CONTEXT)
  await harness.commit(async tx => {
    const value = await tx.doc(legacy)
    value['legacy-marker'] = 'delta-one'
  }, BACKGROUND_CONTEXT)
  await harness.commit(async tx => {
    const value = await tx.doc(legacy)
    value['legacy-marker'] = 'delta-two'
    await tx.createTask(
      task,
      { runId, stage: 'analysis' as const },
      {
        ownership: { kind: 'conversation' },
        conversationId: ROOT_CONVERSATION_ID,
      },
    )
  }, BACKGROUND_CONTEXT)
  await harness.close(BACKGROUND_CONTEXT)
  let calls = 0
  const engine = await openTestEngine(config, {
    providers: {
      ...providers,
      analyze: async () => {
        calls++
        throw new Error('Must not replay')
      },
    },
  })
  try {
    await engine.idle()
    expect(calls).toBe(0)
    expect(await engine.library('default')).toEqual(expectedLibrary)
    const run = await engine.getRun('default', runId)
    expect(run.run.phase).toBe('requires_retry')
    expect(run.receipts).toHaveLength(1)
    expect(run.budget.reservedUsd).toBe(0.013)
    expect(run.analysisAttempts!.every(a => a.settings === null)).toBe(true)
    expect(
      run.analysisAttempts!.find(a => a.id === 'legacy-inflight')!.status,
    ).toBe('unknown')
    expect((await engine.getSettings()).settings.values.maxOutputTokens).toBe(
      8192,
    )
    const after = await engine.harness.snapshot(
      defineDoc<JsonObject>({
        kind: 'discovery.application',
        version: 2,
        scope: 'session',
        initial: () => ({}),
      }),
      BACKGROUND_CONTEXT,
    )
    expect(after!['legacy-marker']).toBe('delta-two')
    expect(JSON.stringify(after!.commands)).toContain('legacy-save-command')
  } finally {
    await engine.close()
    await rm(dir, { recursive: true, force: true })
    await rm(originalDir, { recursive: true, force: true })
  }
})

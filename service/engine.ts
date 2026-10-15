import { createHash, randomUUID } from 'node:crypto'
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises'
import { join } from 'node:path'

import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import {
  Harness,
  ROOT_CONVERSATION_ID,
  type RunningTask,
  type TaskRuntime,
  createRegistry,
  defineDoc,
  defineTask,
} from '@earendil-works/pi-durable'

import type {
  AnalysisSettings,
  AnalysisSettingsSnapshot,
  AnalysisSettingsValues,
  Budget,
  CaptureInput,
  Finding,
  LibraryRecord,
  Log,
  Page,
  Project,
  Run,
  RunSnapshot,
  SaveChoice,
  SavePreview,
  SaveReceipt,
  SettingsSnapshot,
  Usage,
  Workspace,
} from '../src/contract.ts'
import { DiscoveryError } from '../src/contract.ts'
import { fixtureCatalogOptions } from './catalog-fixture.ts'
import { type Config, configuration, fail } from './config.ts'
import {
  type CatalogOptions,
  type CatalogView,
  ModelCatalog,
} from './model-catalog.ts'
import {
  AnalysisRejected,
  AnalysisUnknown,
  CaptureRejected,
  type Providers,
  createProviders,
  mapCmsName,
} from './providers.ts'
import {
  evaluateSettings,
  initialSettings,
  snapshotSettings,
  validateSettings,
} from './settings.ts'
import { acquireStorageOwner, openStorage } from './sqlite.ts'
import { discoverUrls, validateInput } from './urls.ts'

type Mutable<T> = T extends readonly (infer U)[]
  ? Mutable<U>[]
  : T extends object
    ? { -readonly [K in keyof T]: Mutable<T[K]> }
    : T
type Artifact = {
  html: string
  desktop: string
  mobile: string
  failed: string[]
}
type StoredRun = {
  run: Mutable<Run>
  pages: Mutable<Page>[]
  findings: Mutable<Finding>[]
  logs: Mutable<Log>[]
  receipts: Mutable<SaveReceipt>[]
  artifacts: Record<string, Artifact>
  selected: string[]
  stage: 'capture' | 'analysis'
  tasks: number[]
  analysisSettings: Mutable<AnalysisSettingsSnapshot> | null
  executionModelJson?: string
}
type Attempt = {
  id: string
  projectId: string
  runId: string
  pageId: string
  stage: 'capture' | 'analysis'
  status: 'inflight' | 'completed' | 'unknown'
  rawResponse: string
  diagnostic: string
  measuredUsage: Mutable<Usage> | null
  reservedMicros: number
  spentMicros: number
  month: string
  analysisSettings: Mutable<AnalysisSettingsSnapshot> | null
  rawResponseTruncated: boolean
  rawResponseChars: number
  executionModelJson?: string
}
type AppState = {
  settings: Mutable<AnalysisSettings> | null
  projects: Record<string, Mutable<Project>>
  runs: Record<string, StoredRun>
  library: Record<string, Mutable<LibraryRecord>>
  libraryAssets: Record<string, Artifact>
  commands: Record<string, { digest: string; response: string }>
  attempts: Record<string, Attempt>
  activeRunId: string
  audits: {
    at: string
    action: string
    projectId: string
    runId: string
    receiptId: string
  }[]
}
const now = () => new Date().toISOString()
const month = () => now().slice(0, 7)
const clone = <T>(value: T): Mutable<T> => JSON.parse(JSON.stringify(value))
const micros = (usd: number) => Math.ceil(usd * 1_000_000)
const initialUsage = (): Mutable<Usage> => ({
  model: '',
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  costUsd: 0,
  reservedUsd: 0,
  analyzedPages: 0,
  durationMs: 0,
})
export const DiscoveryState = defineDoc<AppState>({
  kind: 'discovery.application',
  version: 2,
  migrate(value, fromVersion) {
    if (fromVersion !== 1)
      throw new Error(`Unsupported Discovery state version ${fromVersion}`)
    const state: AppState = JSON.parse(JSON.stringify(value))
    state.settings = null
    for (const run of Object.values(state.runs)) run.analysisSettings = null
    for (const attempt of Object.values(state.attempts)) {
      attempt.analysisSettings = null
      attempt.rawResponseTruncated = attempt.rawResponse.length >= 100000
      attempt.rawResponseChars = attempt.rawResponse.length
    }
    return state
  },
  scope: 'session',
  initial: () => ({
    settings: null,
    projects: {
      default: {
        id: 'default',
        name: 'My project',
        revision: 0,
        createdAt: now(),
      },
    },
    runs: {},
    library: {},
    libraryAssets: {},
    commands: {},
    attempts: {},
    activeRunId: '',
    audits: [],
  }),
})
const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object')
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(',')}}`
  return JSON.stringify(value)
}
const commandDigest = (operation: string, input: unknown) =>
  createHash('sha256')
    .update(operation + canonical(input))
    .digest('hex')
const commandPrevious = <T>(
  state: AppState,
  id: string,
  operation: string,
  input: unknown,
): T | undefined => {
  if (!/^[A-Za-z0-9][A-Za-z0-9:_.-]{7,159}$/.test(id))
    return fail('validation', 'Command ID must be 8–160 safe characters')
  const previous = Object.hasOwn(state.commands, id)
    ? state.commands[id]
    : undefined
  if (!previous) return undefined
  if (previous.digest !== commandDigest(operation, input))
    return fail(
      'conflict',
      'This command ID was already used with different inputs',
    )
  return JSON.parse(previous.response)
}
const recordCommand = (
  state: AppState,
  id: string,
  operation: string,
  input: unknown,
  response: unknown,
) => {
  state.commands[id] = {
    digest: commandDigest(operation, input),
    response: JSON.stringify(response),
  }
}
const requireProject = (state: AppState, id: string) =>
  Object.hasOwn(state.projects, id)
    ? state.projects[id]!
    : fail('not_found', 'Project not found')
const requireRun = (state: AppState, projectId: string, runId: string) => {
  requireProject(state, projectId)
  const r = Object.hasOwn(state.runs, runId) ? state.runs[runId] : undefined
  if (!r || r.run.projectId !== projectId)
    return fail('not_found', 'Run not found in this project')
  return r
}
const checkRevision = (run: StoredRun, revision: number) => {
  if (run.run.revision !== revision)
    fail('conflict', 'Run changed; refresh and review the latest revision')
}
const touch = (stored: StoredRun) => {
  stored.run.revision++
  stored.run.updatedAt = now()
  stored.run.pageCount = stored.pages.length
  stored.run.capturedCount = stored.pages.filter(
    p => !!p.desktopUrl || !!p.mobileUrl,
  ).length
  stored.run.analyzedCount = stored.pages.filter(
    p => p.status === 'analyzed',
  ).length
  stored.run.failedCount = stored.pages.filter(
    p => p.status === 'failed',
  ).length
}
const log = (
  stored: StoredRun,
  message: string,
  detail = '',
  level: Log['level'] = 'info',
) => {
  stored.logs.push({
    seq: stored.logs.length + 1,
    runId: stored.run.id,
    at: now(),
    level,
    message,
    detail,
  })
}
const errorMessage = (error: unknown) =>
  error instanceof DiscoveryError ||
  error instanceof CaptureRejected ||
  error instanceof AnalysisRejected ||
  error instanceof AnalysisUnknown
    ? error.message
    : 'Provider or storage operation failed; explicit retry is required'
const emptyProvenance = (mode: CaptureInput['evidenceMode']) => ({
  mode,
  provider:
    mode === 'fixture' ? 'deterministic-fixture' : 'cloudflare-browser-run',
  model: '',
  attemptId: '',
  capturedAt: '',
})

type WorkInput = { runId: string; stage: 'capture' | 'analysis' }
type WorkCheckpoint =
  | { phase: 'discover' }
  | { phase: 'next'; step: number }
  | {
      phase: 'inflight'
      step: number
      pageId: string
      viewport: 'desktop' | 'mobile'
      attemptId: string
    }
type WorkResult = { runId: string }
type Runtime = TaskRuntime<WorkInput, WorkCheckpoint, WorkResult, object>
type WorkRecord = RunningTask<WorkInput, WorkCheckpoint, WorkResult>
export type EngineOptions = {
  catalog?: CatalogOptions
  providers?: Providers
  afterReservation?: (attempt: Attempt) => Promise<void>
  beforeSaveCommit?: () => void
}

export class DiscoveryEngine {
  private readonly catalog: ModelCatalog
  private constructor(
    readonly config: Config,
    readonly harness: Harness,
    private readonly providers: Providers,
    private readonly releaseOwner: () => void,
    private readonly task: ReturnType<typeof makeWorkTask>,
    private readonly options: EngineOptions,
  ) {
    this.catalog = new ModelCatalog(
      harness,
      providers.models,
      config.anthropicKey,
      options.catalog ??
        (config.modelCatalogFixture
          ? fixtureCatalogOptions(providers.models)
          : {}),
    )
  }
  static async open(
    config: Config,
    options: EngineOptions = {},
  ): Promise<DiscoveryEngine> {
    await mkdir(config.stateDir, { recursive: true, mode: 0o700 })
    await mkdir(join(config.stateDir, 'screenshots'), {
      recursive: true,
      mode: 0o700,
    })
    const release = acquireStorageOwner(
      join(config.stateDir, 'owner-lock.sqlite'),
    )
    try {
      const providers = options.providers ?? createProviders(config)
      const registry = createRegistry()
      let engine: DiscoveryEngine
      const task = makeWorkTask(() => engine)
      registry.install({ name: 'discovery', tasks: [task] })
      const harness = await Harness.open(
        await openStorage(join(config.stateDir, 'harness.sqlite')),
        {
          models: providers.models,
          registry,
          onReport: () => {
            /* Durable task state remains authoritative; no provider secrets enter logs. */
          },
        },
        BACKGROUND_CONTEXT,
      )
      await harness.root(BACKGROUND_CONTEXT)
      await harness.commit(async tx => {
        const state = await tx.doc(DiscoveryState)
        if (state.settings === null)
          state.settings = clone(initialSettings(config, providers.models))
      }, BACKGROUND_CONTEXT)
      engine = new DiscoveryEngine(
        config,
        harness,
        providers,
        release,
        task,
        options,
      )
      harness.resume()
      return engine
    } catch (error) {
      release()
      throw error
    }
  }
  async close() {
    try {
      await this.harness.close(BACKGROUND_CONTEXT)
    } finally {
      this.releaseOwner()
    }
  }
  async idle() {
    await this.harness.waitForIdle(BACKGROUND_CONTEXT)
  }
  private async state(): Promise<AppState> {
    return clone(
      (await this.harness.snapshot(DiscoveryState, BACKGROUND_CONTEXT))!,
    )
  }
  private budget(state: AppState): Budget {
    const attempts = Object.values(state.attempts).filter(
      a => a.month === month() || a.status !== 'completed',
    )
    return {
      spentUsd: attempts.reduce((sum, a) => sum + a.spentMicros, 0) / 1e6,
      reservedUsd: attempts.reduce((sum, a) => sum + a.reservedMicros, 0) / 1e6,
      runLimitUsd: state.settings?.values.runLimitUsd ?? 0,
      monthlyLimitUsd: state.settings?.values.monthlyLimitUsd ?? 0,
    }
  }
  private snapshot(
    state: AppState,
    projectId: string,
    runId: string,
  ): RunSnapshot {
    const stored = clone(requireRun(state, projectId, runId))
    for (const finding of stored.findings) {
      const receipt = stored.receipts.find(r =>
        r.records.some(item => item.findingId === finding.id),
      )
      const item = receipt?.records.find(item => item.findingId === finding.id)
      finding.saveReceiptId = receipt?.id ?? ''
      finding.savedRecordId = item?.recordId ?? ''
      const existing = Object.values(state.library).find(
        item =>
          item.projectId === projectId &&
          item.kind === finding.kind &&
          item.name.replace(/\W/g, '').toLowerCase() ===
            finding.name.replace(/\W/g, '').toLowerCase(),
      )
      finding.existingId = existing?.id ?? ''
      finding.existingName = existing?.name ?? ''
    }
    const reserved =
      Object.values(state.attempts)
        .filter(a => a.runId === runId)
        .reduce((sum, a) => sum + a.reservedMicros, 0) / 1e6
    stored.run.usage.reservedUsd = reserved
    return {
      run: stored.run,
      pages: stored.pages,
      findings: stored.findings,
      logs: stored.logs,
      receipts: stored.receipts,
      budget: this.budget(state),
      analysisAttempts: Object.values(state.attempts)
        .filter(a => a.runId === runId && a.stage === 'analysis')
        .map(a => ({
          id: a.id,
          pageId: a.pageId,
          status: a.status,
          settings: a.analysisSettings,
          usage: a.measuredUsage,
          reservedUsd: a.reservedMicros / 1e6,
          spentUsd: a.spentMicros / 1e6,
          diagnostic: a.diagnostic,
          rawResponseTruncated: a.rawResponseTruncated,
          rawResponseChars: a.rawResponseChars,
        })),
    }
  }
  async workspace(sessionId: string): Promise<Workspace> {
    const catalog = await this.catalog.ensure()
    const state = await this.state()
    const config = clone(configuration(this.config))
    const evaluation = this.readEvaluation(state.settings!.values, catalog)
    config.analysisReady = evaluation.analysisReady
    config.missingAnalysis = [...evaluation.issues]
    config.model = state.settings!.values.modelId
    config.runLimitUsd = state.settings!.values.runLimitUsd ?? 0
    config.monthlyLimitUsd = state.settings!.values.monthlyLimitUsd ?? 0
    config.attemptReservationUsd =
      state.settings!.values.attemptReservationUsd ?? 0
    return {
      projects: Object.values(state.projects),
      configuration: config,
      budget: this.budget(state),
      activeRunId: state.activeRunId,
      sessionId,
    }
  }
  private evaluate(values: AnalysisSettingsValues, catalog?: CatalogView) {
    return evaluateSettings(
      this.config,
      this.providers.models,
      values,
      this.options.providers?.reservationBoundUsd,
      catalog,
    )
  }
  private readEvaluation(values: AnalysisSettingsValues, catalog: CatalogView) {
    try {
      return this.evaluate(values, catalog)
    } catch (error) {
      if (!(error instanceof DiscoveryError)) throw error
      return {
        analysisReady: false,
        issues: [error.message],
        minimumReservationUsd: 0,
        effectiveMaxOutputTokens: values.maxOutputTokens,
        effectiveThinkingBudgetTokens: null,
        effectiveReasoning: values.reasoning ?? ('off' as const),
        catalogRevision: catalog.status.revision,
      }
    }
  }
  private settingsView(
    settings: AnalysisSettings,
    catalog: CatalogView,
  ): SettingsSnapshot {
    return {
      settings,
      models: catalog.models,
      evaluation: this.readEvaluation(settings.values, catalog),
      catalog: catalog.status,
    }
  }
  async getSettings(force = false): Promise<SettingsSnapshot> {
    const catalog = await this.catalog.ensure(force)
    return this.settingsView((await this.state()).settings!, catalog)
  }
  async previewSettings(values: AnalysisSettingsValues) {
    const catalog = await this.catalog.ensure()
    validateSettings(this.providers.models, values, catalog.models)
    return this.evaluate(values, catalog)
  }
  async saveSettings(input: {
    commandId: string
    expectedRevision: number
    values: AnalysisSettingsValues
  }): Promise<SettingsSnapshot> {
    const catalog = await this.catalog.ensure()
    return this.harness.commit(async tx => {
      const state = await tx.doc(DiscoveryState)
      const previous = commandPrevious<SettingsSnapshot>(
        state,
        input.commandId,
        'settings',
        input,
      )
      if (previous) return previous
      if (state.settings!.revision !== input.expectedRevision)
        return fail(
          'conflict',
          'Analysis settings changed. Reload saved settings before saving your edits.',
        )
      const values = validateSettings(
        this.providers.models,
        input.values,
        catalog.models,
      )
      state.settings = clone({
        revision: state.settings!.revision + 1,
        updatedAt: now(),
        values,
      })
      const response = this.settingsView(clone(state.settings), catalog)
      recordCommand(state, input.commandId, 'settings', input, response)
      return response
    }, BACKGROUND_CONTEXT)
  }
  async project(input: { commandId: string; name: string }): Promise<Project> {
    return this.harness.commit(async tx => {
      const state = await tx.doc(DiscoveryState)
      const old = commandPrevious<Project>(
        state,
        input.commandId,
        'project',
        input,
      )
      if (old) return old
      if (!input.name.trim() || input.name.length > 120)
        return fail('validation', 'Project name must contain 1–120 characters')
      const project = {
        id: randomUUID(),
        name: input.name.trim(),
        revision: 0,
        createdAt: now(),
      }
      state.projects[project.id] = project
      recordCommand(state, input.commandId, 'project', input, project)
      return project
    }, BACKGROUND_CONTEXT)
  }
  async history(projectId: string) {
    const state = await this.state()
    requireProject(state, projectId)
    return Object.values(state.runs)
      .filter(r => r.run.projectId === projectId)
      .map(r => this.snapshot(state, projectId, r.run.id).run)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  }
  async getRun(projectId: string, runId: string) {
    return this.snapshot(await this.state(), projectId, runId)
  }
  async logs(projectId: string, runId: string, afterSeq: number) {
    return (await this.getRun(projectId, runId)).logs.filter(
      l => l.seq > afterSeq,
    )
  }
  private requireMode(
    input: CaptureInput,
    analysis = false,
    settings?: AnalysisSettingsSnapshot | null,
  ) {
    if (input.evidenceMode === 'fixture') {
      if (!this.config.fixtureEnabled)
        fail(
          'configuration',
          'Enable DISCOVERY_FIXTURES=1 explicitly to use deterministic fixtures',
        )
      return
    }
    const cfg = configuration(this.config)
    if (analysis) {
      if (!settings)
        return fail(
          'configuration',
          'Legacy analysis has no settings snapshot; explicitly retry to select current settings',
        )
      const values = settings.values
      if (
        !this.config.accountId ||
        !this.config.gatewayId ||
        !this.config.gatewayToken ||
        !this.config.anthropicKey ||
        values.runLimitUsd === null ||
        values.monthlyLimitUsd === null ||
        values.attemptReservationUsd === null ||
        values.attemptReservationUsd < settings.minimumReservationUsd ||
        values.attemptReservationUsd > values.runLimitUsd ||
        values.attemptReservationUsd > values.monthlyLimitUsd ||
        (settings.model &&
          !settings.model.supportsImages &&
          values.screenshotEvidence !== 'none')
      )
        return fail(
          'configuration',
          'Live analysis needs configured credentials, compatible evidence, and spending limits covering the admitted reservation',
        )
    }
    if (!analysis && !cfg.captureReady)
      fail(
        'configuration',
        `Live capture needs ${cfg.missingCapture.join(', ')}`,
      )
  }
  private requireCatalog(input: CaptureInput, catalog: CatalogView) {
    if (
      input.evidenceMode === 'live' &&
      (catalog.status.status !== 'fresh' ||
        catalog.status.source !== 'anthropic-api')
    )
      fail(
        'configuration',
        'Live analysis requires a fresh Anthropic API model catalog; refresh the model catalog before retrying',
      )
  }
  private executionModel(settings: AnalysisSettingsSnapshot) {
    const model = this.providers.models.getModel(
      'anthropic',
      settings.values.modelId,
    )
    if (!model || !settings.model?.selectable)
      return fail(
        'configuration',
        'The selected API model is unavailable to the verified adapter',
      )
    return JSON.stringify({
      ...model,
      contextWindow: settings.model.effectiveContextWindow,
      maxTokens: settings.model.effectiveMaxOutputTokens,
      compat: { ...model.compat, allowedFallbackModels: [] },
    })
  }
  async createCapture(input: {
    projectId: string
    commandId: string
    input: CaptureInput
  }): Promise<RunSnapshot> {
    validateInput(input.input)
    const runId = await this.harness.commit(async tx => {
      const state = await tx.doc(DiscoveryState)
      const old = commandPrevious<{ id: string }>(
        state,
        input.commandId,
        'capture',
        input,
      )
      if (old) return old.id
      requireProject(state, input.projectId)
      this.requireMode(input.input)
      if (state.activeRunId)
        return fail(
          'busy',
          'One run is already active; complete or resolve it first',
        )
      const id = randomUUID()
      const stamp = now()
      state.runs[id] = {
        run: {
          id,
          projectId: input.projectId,
          revision: 0,
          phase: 'queued',
          input: clone(input.input),
          createdAt: stamp,
          updatedAt: stamp,
          pageCount: 0,
          capturedCount: 0,
          analyzedCount: 0,
          failedCount: 0,
          error: '',
          usage: initialUsage(),
        },
        pages: [],
        findings: [],
        logs: [],
        receipts: [],
        artifacts: {},
        selected: [],
        stage: 'capture',
        tasks: [],
        analysisSettings: null,
      }
      state.activeRunId = id
      const root = ROOT_CONVERSATION_ID
      const taskId = await tx.createTask(
        this.task,
        { runId: id, stage: 'capture' },
        { ownership: { kind: 'conversation' }, conversationId: root },
      )
      state.runs[id]!.tasks.push(taskId)
      log(
        state.runs[id]!,
        'Capture queued',
        input.input.evidenceMode === 'fixture'
          ? 'Deterministic fixtures explicitly selected. No live provider calls.'
          : 'Public website capture through Cloudflare.',
      )
      recordCommand(state, input.commandId, 'capture', input, { id })
      return id
    }, BACKGROUND_CONTEXT)
    this.harness.resume()
    return this.getRun(input.projectId, runId)
  }
  async analyze(input: {
    projectId: string
    runId: string
    commandId: string
    expectedRevision: number
    pageIds: readonly string[]
  }): Promise<RunSnapshot> {
    const catalog = await this.catalog.ensure()
    await this.harness.commit(async tx => {
      const state = await tx.doc(DiscoveryState)
      if (commandPrevious(state, input.commandId, 'analysis', input)) return
      const stored = requireRun(state, input.projectId, input.runId)
      checkRevision(stored, input.expectedRevision)
      const settings = snapshotSettings(
        state.settings!,
        this.evaluate(state.settings!.values, catalog),
        catalog,
      )
      this.requireCatalog(stored.run.input, catalog)
      this.requireMode(stored.run.input, true, settings)
      if (state.activeRunId)
        return fail('busy', 'One run is already active; resolve it first')
      if (stored.run.phase !== 'captured')
        return fail('conflict', 'Analysis starts only from captured pages')
      const selected = [...new Set(input.pageIds)]
      if (
        !selected.length ||
        selected.some(
          id =>
            !stored.pages.some(
              p =>
                p.id === id &&
                p.status === 'captured' &&
                (!!p.desktopUrl || !!p.mobileUrl),
            ),
        )
      )
        return fail('validation', 'Select captured pages belonging to this run')
      stored.selected = selected
      stored.stage = 'analysis'
      stored.analysisSettings = clone(settings)
      stored.executionModelJson = this.executionModel(settings)
      stored.run.phase = 'analyzing'
      stored.run.error = ''
      state.activeRunId = input.runId
      for (const page of stored.pages)
        page.selected = selected.includes(page.id)
      const taskId = await tx.createTask(
        this.task,
        { runId: input.runId, stage: 'analysis' as const },
        {
          ownership: { kind: 'conversation' },
          conversationId: ROOT_CONVERSATION_ID,
        },
      )
      stored.tasks.push(taskId)
      touch(stored)
      log(
        stored,
        'Analysis explicitly requested',
        `${selected.length} selected page(s); ${stored.run.input.evidenceMode} evidence.`,
      )
      recordCommand(state, input.commandId, 'analysis', input, {
        accepted: true,
      })
    }, BACKGROUND_CONTEXT)
    this.harness.resume()
    return this.getRun(input.projectId, input.runId)
  }
  async retry(input: {
    projectId: string
    runId: string
    commandId: string
    expectedRevision: number
  }): Promise<RunSnapshot> {
    const catalog = await this.catalog.ensure()
    await this.harness.commit(async tx => {
      const state = await tx.doc(DiscoveryState)
      if (commandPrevious(state, input.commandId, 'retry', input)) return
      const stored = requireRun(state, input.projectId, input.runId)
      checkRevision(stored, input.expectedRevision)
      if (!['requires_retry', 'failed'].includes(stored.run.phase))
        return fail('conflict', 'This run does not require a retry')
      if (state.activeRunId && state.activeRunId !== input.runId)
        return fail('busy', 'Another run is active')
      const settings =
        stored.stage === 'analysis'
          ? snapshotSettings(
              state.settings!,
              this.evaluate(state.settings!.values, catalog),
              catalog,
            )
          : null
      if (stored.stage === 'analysis')
        this.requireCatalog(stored.run.input, catalog)
      this.requireMode(stored.run.input, stored.stage === 'analysis', settings)
      stored.analysisSettings = settings ? clone(settings) : null
      if (settings) stored.executionModelJson = this.executionModel(settings)
      for (const page of stored.pages)
        if (page.status === 'requires_retry' || page.status === 'failed') {
          page.status = stored.stage === 'capture' ? 'queued' : 'captured'
          page.error = ''
          stored.artifacts[page.id]!.failed = []
        }
      stored.run.phase = stored.stage === 'capture' ? 'capturing' : 'analyzing'
      stored.run.error = ''
      state.activeRunId = input.runId
      const taskId = await tx.createTask(
        this.task,
        { runId: input.runId, stage: stored.stage },
        {
          ownership: { kind: 'conversation' },
          conversationId: ROOT_CONVERSATION_ID,
        },
      )
      stored.tasks.push(taskId)
      touch(stored)
      log(
        stored,
        'Explicit retry admitted',
        'Previous unknown attempts retain their reservations. New external attempts have separate identities.',
      )
      recordCommand(state, input.commandId, 'retry', input, { accepted: true })
    }, BACKGROUND_CONTEXT)
    this.harness.resume()
    return this.getRun(input.projectId, input.runId)
  }
  private preview(
    state: AppState,
    input: {
      projectId: string
      runId: string
      expectedRevision: number
      choices: readonly SaveChoice[]
    },
  ): SavePreview {
    const stored = requireRun(state, input.projectId, input.runId)
    checkRevision(stored, input.expectedRevision)
    if (
      !input.choices.length ||
      input.choices.length > 200 ||
      new Set(input.choices.map(c => c.findingId)).size !== input.choices.length
    )
      return fail('validation', 'Choose distinct findings to save')
    const items = input.choices.map(choice => {
      const finding =
        stored.findings.find(f => f.id === choice.findingId) ??
        fail('not_found', 'Finding does not belong to this run')
      if (
        stored.receipts.some(r =>
          r.records.some(item => item.findingId === finding.id),
        ) &&
        choice.action !== 'skip'
      )
        return fail('conflict', 'This finding already has a save receipt')
      const target =
        choice.action === 'merge' &&
        Object.hasOwn(state.library, choice.targetId)
          ? state.library[choice.targetId]
          : undefined
      if (
        choice.action === 'merge' &&
        (!target ||
          target.projectId !== input.projectId ||
          target.kind !== finding.kind)
      )
        return fail(
          'not_found',
          'Merge target does not belong to this project and finding kind',
        )
      if (choice.action !== 'merge' && choice.targetId)
        return fail(
          'validation',
          'Create and skip choices must not name a merge target',
        )
      return {
        findingId: finding.id,
        action: choice.action,
        targetId: target?.id ?? '',
        cmsName: mapCmsName(
          finding.name,
          stored.run.input.targetCms,
          finding.kind,
        ),
        name: finding.name,
        kind: finding.kind,
      }
    })
    return {
      projectId: input.projectId,
      runId: input.runId,
      revision: stored.run.revision,
      projectRevision: requireProject(state, input.projectId).revision,
      items,
    }
  }
  async previewSave(input: {
    projectId: string
    runId: string
    expectedRevision: number
    choices: readonly SaveChoice[]
  }) {
    return this.preview(await this.state(), input)
  }
  async save(input: {
    projectId: string
    runId: string
    commandId: string
    expectedRevision: number
    expectedProjectRevision: number
    choices: readonly SaveChoice[]
  }): Promise<SaveReceipt> {
    return this.harness.commit(async tx => {
      const state = await tx.doc(DiscoveryState)
      const old = commandPrevious<SaveReceipt>(
        state,
        input.commandId,
        'save',
        input,
      )
      if (old) return old
      const preview = this.preview(state, input)
      const project = requireProject(state, input.projectId)
      if (project.revision !== input.expectedProjectRevision)
        return fail('conflict', 'Project library changed; preview again')
      const stored = requireRun(state, input.projectId, input.runId)
      const receipt: Mutable<SaveReceipt> = {
        id: randomUUID(),
        commandId: input.commandId,
        projectId: input.projectId,
        runId: input.runId,
        createdAt: now(),
        records: [],
      }
      for (const item of preview.items) {
        if (item.action === 'skip') continue
        const finding = stored.findings.find(f => f.id === item.findingId)!
        const id = item.action === 'merge' ? item.targetId : randomUUID()
        const previous = state.library[id]
        state.library[id] = {
          id,
          projectId: input.projectId,
          kind: finding.kind,
          name: finding.name,
          cmsName: item.cmsName,
          description: finding.description,
          fields: clone([
            ...new Map(
              [...(previous?.fields ?? []), ...finding.fields].map(field => [
                field.name,
                field,
              ]),
            ).values(),
          ]),
          variants: [
            ...new Set([...(previous?.variants ?? []), ...finding.variants]),
          ],
          revision: (previous?.revision ?? 0) + 1,
          sourceRunId: input.runId,
          designVariants: clone(previous?.designVariants ?? []),
          provenance: clone(finding.provenance),
          createdAt: previous?.createdAt ?? now(),
          updatedAt: now(),
        }
        for (const pageId of finding.pageIds) {
          const page = stored.pages.find(p => p.id === pageId)!
          const artifact = stored.artifacts[pageId]!
          const variantId = randomUUID()
          const prefix = `/private/library/${encodeURIComponent(input.projectId)}/${id}/${variantId}`
          state.library[id]!.designVariants.push({
            id: variantId,
            name: page.title,
            pageId,
            sourceRunId: input.runId,
            desktopUrl: artifact.desktop ? `${prefix}/desktop` : '',
            mobileUrl: artifact.mobile ? `${prefix}/mobile` : '',
            provenance: clone(page.provenance),
          })
          state.libraryAssets[variantId] = clone(artifact)
        }
        receipt.records.push({
          findingId: finding.id,
          recordId: id,
          action: item.action,
          cmsName: item.cmsName,
        })
      }
      if (!receipt.records.length)
        return fail(
          'validation',
          'Select at least one finding to create or merge',
        )
      this.options.beforeSaveCommit?.()
      stored.receipts.push(receipt)
      project.revision++
      touch(stored)
      log(
        stored,
        'Findings saved to project library',
        `${receipt.records.length} record(s), receipt ${receipt.id}`,
      )
      state.audits.push({
        at: now(),
        action: 'save',
        projectId: input.projectId,
        runId: input.runId,
        receiptId: receipt.id,
      })
      recordCommand(state, input.commandId, 'save', input, receipt)
      return clone(receipt)
    }, BACKGROUND_CONTEXT)
  }
  async library(projectId: string) {
    const state = await this.state()
    requireProject(state, projectId)
    return Object.values(state.library).filter(
      item => item.projectId === projectId,
    )
  }
  async exportProject(projectId: string) {
    const state = await this.state()
    const project = requireProject(state, projectId)
    return {
      filename: `discovery-${projectId}.json`,
      json: JSON.stringify(
        {
          schemaVersion: 1,
          exportedAt: now(),
          project,
          library: Object.values(state.library).filter(
            item => item.projectId === projectId,
          ),
          runs: Object.values(state.runs)
            .filter(r => r.run.projectId === projectId)
            .map(r => this.snapshot(state, projectId, r.run.id)),
          analysisEvidence: Object.values(state.attempts)
            .filter(a => a.stage === 'analysis' && a.projectId === projectId)
            .map(
              ({ executionModelJson: _privateModel, ...evidence }) => evidence,
            ),
          audits: state.audits.filter(a => a.projectId === projectId),
        },
        null,
        2,
      ),
    }
  }
  async deleteRun(input: {
    projectId: string
    runId: string
    commandId: string
    expectedRevision: number
  }) {
    const files: string[] = []
    const response = await this.harness.commit(async tx => {
      const state = await tx.doc(DiscoveryState)
      const old = commandPrevious<{ deleted: boolean }>(
        state,
        input.commandId,
        'delete',
        input,
      )
      if (old) return old
      const stored = requireRun(state, input.projectId, input.runId)
      checkRevision(stored, input.expectedRevision)
      if (['queued', 'capturing', 'analyzing'].includes(stored.run.phase))
        return fail(
          'busy',
          'Wait for active service work to settle before deleting',
        )
      const retainedFiles = new Set(
        Object.values(state.libraryAssets).flatMap(a => [a.desktop, a.mobile]),
      )
      for (const artifact of Object.values(stored.artifacts))
        for (const filename of [artifact.desktop, artifact.mobile])
          if (!retainedFiles.has(filename)) files.push(filename)
      delete state.runs[input.runId]
      if (state.activeRunId === input.runId) state.activeRunId = ''
      // Global attempt liabilities deliberately survive history deletion.
      state.audits.push({
        at: now(),
        action: 'delete-run',
        projectId: input.projectId,
        runId: input.runId,
        receiptId: '',
      })
      const response = { deleted: true }
      recordCommand(state, input.commandId, 'delete', input, response)
      return response
    }, BACKGROUND_CONTEXT)
    await Promise.all(
      files
        .filter(Boolean)
        .map(file =>
          unlink(join(this.config.stateDir, 'screenshots', file)).catch(
            () => undefined,
          ),
        ),
    )
    return response
  }
  async screenshot(
    projectId: string,
    runId: string,
    pageId: string,
    viewport: string,
  ) {
    if (viewport !== 'desktop' && viewport !== 'mobile')
      return fail('validation', 'Unknown viewport')
    const state = await this.state()
    const stored = requireRun(state, projectId, runId)
    if (!stored.pages.some(p => p.id === pageId))
      return fail('not_found', 'Screenshot not found')
    const filename = stored.artifacts[pageId]?.[viewport]
    if (!filename || !/^[a-f0-9-]+\.(png|svg)$/.test(filename))
      return fail('not_found', 'Screenshot not found')
    return {
      bytes: await readFile(
        join(this.config.stateDir, 'screenshots', filename),
      ),
      mime: filename.endsWith('.svg') ? 'image/svg+xml' : 'image/png',
    }
  }
  async libraryScreenshot(
    projectId: string,
    recordId: string,
    variantId: string,
    viewport: string,
  ) {
    if (viewport !== 'desktop' && viewport !== 'mobile')
      return fail('validation', 'Unknown viewport')
    const state = await this.state()
    requireProject(state, projectId)
    const record = Object.hasOwn(state.library, recordId)
      ? state.library[recordId]
      : undefined
    if (
      !record ||
      record.projectId !== projectId ||
      !record.designVariants.some(v => v.id === variantId)
    )
      return fail('not_found', 'Saved design variant not found')
    const filename = state.libraryAssets[variantId]?.[viewport]
    if (!filename || !/^[a-f0-9-]+\.(png|svg)$/.test(filename))
      return fail('not_found', 'Saved screenshot not found')
    return {
      bytes: await readFile(
        join(this.config.stateDir, 'screenshots', filename),
      ),
      mime: filename.endsWith('.svg') ? 'image/svg+xml' : 'image/png',
    }
  }
  private async writeScreenshot(
    bytes: Uint8Array,
    extension: string,
  ): Promise<string> {
    const name = `${randomUUID()}.${extension}`
    const file = join(this.config.stateDir, 'screenshots', name)
    const tmp = `${file}.tmp`
    const handle = await open(tmp, 'wx', 0o600)
    try {
      await handle.writeFile(bytes)
      await handle.sync()
    } finally {
      await handle.close()
    }
    await rename(tmp, file)
    return name
  }
  async discover(task: WorkRecord, runtime: Runtime) {
    const state = await this.state()
    const stored = state.runs[task.input.runId]
    if (!stored) return
    try {
      const urls = stored.pages.length
        ? stored.pages.map(p => p.url)
        : await discoverUrls(stored.run.input, runtime.signal)
      await runtime.commit(async tx => {
        const app = await tx.doc(DiscoveryState)
        const current = app.runs[task.input.runId]!
        if (!current.pages.length)
          for (const url of urls) {
            const id = randomUUID()
            current.pages.push({
              id,
              runId: current.run.id,
              projectId: current.run.projectId,
              url,
              title: new URL(url).hostname,
              status: 'queued',
              desktopUrl: '',
              mobileUrl: '',
              error: '',
              selected: false,
              provenance: emptyProvenance(current.run.input.evidenceMode),
            })
            current.artifacts[id] = {
              html: '',
              desktop: '',
              mobile: '',
              failed: [],
            }
          }
        current.run.phase = 'capturing'
        touch(current)
        log(
          current,
          'Public URLs discovered',
          `${current.pages.length} page(s), cap ${current.run.input.maxPages}`,
        )
        return { status: 'running', checkpoint: { phase: 'next', step: 0 } }
      }, BACKGROUND_CONTEXT)
    } catch (error) {
      if (runtime.signal.aborted) throw error
      await this.block(task, runtime, errorMessage(error))
    }
  }
  private async block(
    task: WorkRecord,
    runtime: Runtime,
    message: string,
    attemptId = '',
    pageId = '',
    evidence?: AnalysisRejected | AnalysisUnknown,
  ) {
    await runtime.commit(async tx => {
      const app = await tx.doc(DiscoveryState)
      const stored = app.runs[task.input.runId]!
      if (attemptId && app.attempts[attemptId]) {
        const attempt = app.attempts[attemptId]!
        attempt.status = 'unknown'
        attempt.diagnostic = message
        if (evidence) {
          attempt.rawResponse = evidence.rawResponse
          attempt.rawResponseTruncated = evidence.rawResponseTruncated
          attempt.rawResponseChars = evidence.rawResponseChars
          attempt.measuredUsage = evidence.usage ? clone(evidence.usage) : null
        }
        if (evidence instanceof AnalysisRejected) {
          attempt.status = 'completed'
          attempt.spentMicros = micros(evidence.usage.costUsd)
          attempt.reservedMicros = 0
          stored.run.usage.model = evidence.usage.model
          for (const key of [
            'inputTokens',
            'outputTokens',
            'cacheReadTokens',
            'cacheWriteTokens',
            'costUsd',
            'durationMs',
          ] as const)
            stored.run.usage[key] += evidence.usage[key]
        }
      }
      const page = stored.pages.find(p => p.id === pageId)
      if (page) {
        page.status = 'requires_retry'
        page.error = message
      }
      stored.run.phase = 'requires_retry'
      stored.run.error = message
      touch(stored)
      log(stored, 'Explicit retry required', message, 'warn')
      return {
        status: 'terminal',
        outcome: { status: 'failed', error: { message } },
      }
    }, BACKGROUND_CONTEXT)
  }
  async recover(task: WorkRecord, runtime: Runtime) {
    if (task.state.checkpoint.phase !== 'inflight') return
    await this.block(
      task,
      runtime,
      'The process stopped during an external attempt. Its outcome is unknown; the previous reservation is retained.',
      task.state.checkpoint.attemptId,
      task.state.checkpoint.pageId,
    )
  }
  async next(task: WorkRecord, runtime: Runtime) {
    const state = await this.state()
    const stored = state.runs[task.input.runId]!
    const stage = task.input.stage
    const page = stored.pages.find(p =>
      stage === 'capture'
        ? (!stored.artifacts[p.id]?.desktop &&
            stored.run.input.desktop &&
            !stored.artifacts[p.id]?.failed.includes('desktop')) ||
          (!stored.artifacts[p.id]?.mobile &&
            stored.run.input.mobile &&
            !stored.artifacts[p.id]?.failed.includes('mobile'))
        : stored.selected.includes(p.id) && p.status !== 'analyzed',
    )
    if (!page) {
      await runtime.commit(async tx => {
        const app = await tx.doc(DiscoveryState)
        const current = app.runs[task.input.runId]!
        current.run.phase =
          stage === 'capture'
            ? current.pages.some(p => p.desktopUrl || p.mobileUrl)
              ? 'captured'
              : 'failed'
            : 'completed'
        current.run.error =
          current.run.phase === 'failed'
            ? 'No pages could be captured; inspect the page failures and explicitly retry.'
            : ''
        app.activeRunId = ''
        touch(current)
        log(
          current,
          stage === 'capture'
            ? 'Screenshots ready for review'
            : 'Analysis completed',
          stage === 'capture'
            ? 'Only Analyze selected pages starts model work.'
            : 'Findings are unsaved until a separate save command succeeds.',
        )
        return {
          status: 'terminal',
          outcome: { status: 'completed', result: { runId: task.input.runId } },
        }
      }, BACKGROUND_CONTEXT)
      return
    }
    const step =
      task.state.checkpoint.phase === 'next' ? task.state.checkpoint.step : 0
    const viewport =
      stored.run.input.desktop &&
      !stored.artifacts[page.id]!.desktop &&
      !stored.artifacts[page.id]!.failed.includes('desktop')
        ? 'desktop'
        : 'mobile'
    const attemptId = randomUUID()
    let reserved = false
    try {
      const settings = stored.analysisSettings
      if (stage === 'analysis' && !settings)
        return await this.block(
          task,
          runtime,
          'Legacy analysis has no settings snapshot. Explicitly retry to use current settings.',
          '',
          page.id,
        )
      if (stage === 'analysis' && !stored.executionModelJson)
        return await this.block(
          task,
          runtime,
          'Legacy analysis has no execution model snapshot. Explicitly retry to use current API model metadata.',
          '',
          page.id,
        )
      this.requireMode(stored.run.input, stage === 'analysis', settings)
      const analysisImages =
        stage === 'analysis'
          ? await Promise.all(
              [
                settings!.values.screenshotEvidence === 'both' ||
                settings!.values.screenshotEvidence === 'desktop'
                  ? stored.artifacts[page.id]!.desktop
                  : '',
                settings!.values.screenshotEvidence === 'both' ||
                settings!.values.screenshotEvidence === 'mobile'
                  ? stored.artifacts[page.id]!.mobile
                  : '',
              ]
                .filter(Boolean)
                .map(async filename => ({
                  bytes: await readFile(
                    join(this.config.stateDir, 'screenshots', filename),
                  ),
                  mime: filename.endsWith('.png')
                    ? 'image/png'
                    : 'image/svg+xml',
                })),
            )
          : []
      if (
        stage === 'analysis' &&
        !analysisImages.length &&
        !stored.artifacts[page.id]!.html.slice(
          0,
          settings!.values.maxDomChars,
        ).trim()
      )
        return await this.block(
          task,
          runtime,
          'The selected evidence is unavailable for this page. Choose available screenshots or DOM evidence and explicitly retry. No request was sent.',
          '',
          page.id,
        )
      if (
        stage === 'analysis' &&
        analysisImages.some(image => image.bytes.length > 5_000_000)
      )
        return await this.block(
          task,
          runtime,
          'A screenshot exceeds the 5 MB analysis limit. No model request was sent and no budget was reserved.',
          '',
          page.id,
        )
      await runtime.commit(async tx => {
        const app = await tx.doc(DiscoveryState)
        const current = app.runs[task.input.runId]!
        const reserve =
          stage === 'analysis' && current.run.input.evidenceMode === 'live'
            ? micros(settings!.values.attemptReservationUsd ?? 0)
            : 0
        const budget = this.budget(app)
        const runLiability = Object.values(app.attempts)
          .filter(a => a.runId === task.input.runId)
          .reduce((sum, a) => sum + a.reservedMicros + a.spentMicros, 0)
        if (
          reserve &&
          (micros(budget.spentUsd + budget.reservedUsd) + reserve >
            micros(
              Math.min(
                settings!.values.monthlyLimitUsd ?? 0,
                app.settings!.values.monthlyLimitUsd ?? 0,
              ),
            ) ||
            runLiability + reserve >
              micros(
                Math.min(
                  settings!.values.runLimitUsd ?? 0,
                  app.settings!.values.runLimitUsd ?? 0,
                ),
              ))
        )
          return fail(
            'budget',
            'The next attempt would exceed the configured spending limit; existing reservations remain held',
          )
        app.attempts[attemptId] = {
          id: attemptId,
          projectId: current.run.projectId,
          runId: task.input.runId,
          pageId: page.id,
          stage,
          status: 'inflight',
          rawResponse: '',
          diagnostic: '',
          measuredUsage: null,
          reservedMicros: reserve,
          spentMicros: 0,
          month: month(),
          analysisSettings: stage === 'analysis' ? clone(settings!) : null,
          rawResponseTruncated: false,
          rawResponseChars: 0,
          ...(stage === 'analysis'
            ? { executionModelJson: stored.executionModelJson! }
            : {}),
        }
        const currentPage = current.pages.find(p => p.id === page.id)!
        currentPage.status = stage === 'capture' ? 'capturing' : 'analyzing'
        currentPage.provenance.attemptId = attemptId
        current.run.phase = stage === 'capture' ? 'capturing' : 'analyzing'
        touch(current)
        log(
          current,
          stage === 'capture'
            ? `Capturing ${viewport}`
            : 'Analyzing selected page',
          page.url,
        )
        return {
          status: 'running',
          checkpoint: {
            phase: 'inflight',
            step,
            pageId: page.id,
            viewport,
            attemptId,
          },
        }
      }, BACKGROUND_CONTEXT)
      reserved = true
      await this.options.afterReservation?.(
        (await this.state()).attempts[attemptId]!,
      )
      if (stage === 'capture') {
        const captured = await this.providers.capture(
          page,
          viewport,
          runtime.signal,
        )
        const filename = await this.writeScreenshot(
          captured.bytes,
          captured.extension,
        )
        await runtime.commit(async tx => {
          const app = await tx.doc(DiscoveryState)
          const current = app.runs[task.input.runId]!
          const p = current.pages.find(p => p.id === page.id)!
          const artifact = current.artifacts[p.id]!
          artifact[viewport] = filename
          artifact.html = captured.html
          p.title = captured.title
          p.provenance = { ...p.provenance, attemptId, capturedAt: now() }
          const path = `/private/screenshots/${encodeURIComponent(current.run.projectId)}/${current.run.id}/${p.id}/${viewport}`
          if (viewport === 'desktop') p.desktopUrl = path
          else p.mobileUrl = path
          p.status =
            (!current.run.input.desktop ||
              !!artifact.desktop ||
              artifact.failed.includes('desktop')) &&
            (!current.run.input.mobile ||
              !!artifact.mobile ||
              artifact.failed.includes('mobile'))
              ? 'captured'
              : 'capturing'
          p.selected = p.status === 'captured'
          app.attempts[attemptId]!.status = 'completed'
          touch(current)
          return {
            status: 'running',
            checkpoint: { phase: 'next', step: step + 1 },
          }
        }, BACKGROUND_CONTEXT)
      } else {
        const artifact = stored.artifacts[page.id]!
        const result = await this.providers.analyze(
          page,
          artifact.html,
          analysisImages,
          runtime.signal,
          settings!,
          stored.executionModelJson!,
        )
        await runtime.commit(async tx => {
          const app = await tx.doc(DiscoveryState)
          const current = app.runs[task.input.runId]!
          const p = current.pages.find(p => p.id === page.id)!
          const attempt = app.attempts[attemptId]!
          if (
            !Number.isFinite(result.usage.costUsd) ||
            result.usage.costUsd < 0
          )
            return fail('provider', 'Invalid usage; reservation retained')
          attempt.status = 'completed'
          attempt.rawResponse = result.rawResponse
          attempt.rawResponseTruncated = result.rawResponseTruncated ?? false
          attempt.rawResponseChars =
            result.rawResponseChars ?? result.rawResponse.length
          attempt.measuredUsage = clone(result.usage)
          attempt.spentMicros = micros(result.usage.costUsd)
          attempt.reservedMicros = 0
          p.status = 'analyzed'
          for (const detection of result.findings) {
            const provenance = {
              mode: current.run.input.evidenceMode,
              provider:
                current.run.input.evidenceMode === 'fixture'
                  ? 'deterministic-fixture'
                  : 'anthropic-via-cloudflare',
              model: result.usage.model,
              attemptId,
              capturedAt: now(),
            }
            const evidence = {
              pageId: p.id,
              provenance,
              fields: clone(detection.fields),
              variants: clone(detection.variants),
              confidence: detection.confidence,
              description: detection.description,
            }
            // Conflicting field types remain separate inspectable detections. Compatible evidence unions deterministically.
            const existing = current.findings.find(
              f =>
                f.kind === detection.kind &&
                f.name.toLowerCase() === detection.name.toLowerCase() &&
                detection.fields.every(
                  field =>
                    !f.fields.some(
                      previous =>
                        previous.name.toLowerCase() ===
                          field.name.toLowerCase() &&
                        previous.type !== field.type,
                    ),
                ),
            )
            if (existing) {
              if (!existing.pageIds.includes(p.id)) existing.pageIds.push(p.id)
              for (const field of detection.fields) {
                const previous = existing.fields.find(
                  f => f.name.toLowerCase() === field.name.toLowerCase(),
                )
                if (previous) previous.required ||= field.required
                else existing.fields.push(clone(field))
              }
              existing.variants = [
                ...new Set([...existing.variants, ...detection.variants]),
              ]
              existing.confidence = Math.min(
                existing.confidence,
                detection.confidence,
              )
              existing.evidence.push(evidence)
              continue
            }
            current.findings.push({
              ...clone(detection),
              id: randomUUID(),
              projectId: current.run.projectId,
              runId: current.run.id,
              pageIds: [p.id],
              cmsName: mapCmsName(
                detection.name,
                current.run.input.targetCms,
                detection.kind,
              ),
              existingId: '',
              existingName: '',
              savedRecordId: '',
              saveReceiptId: '',
              evidence: [evidence],
              provenance,
            })
          }
          current.run.usage.model = result.usage.model
          for (const key of [
            'inputTokens',
            'outputTokens',
            'cacheReadTokens',
            'cacheWriteTokens',
            'costUsd',
            'analyzedPages',
            'durationMs',
          ] as const)
            current.run.usage[key] += result.usage[key]
          touch(current)
          log(
            current,
            'Validated detections received',
            `${result.findings.length} findings from ${result.usage.model}; rendered DOM and screenshots retained as evidence.`,
          )
          return {
            status: 'running',
            checkpoint: { phase: 'next', step: step + 1 },
          }
        }, BACKGROUND_CONTEXT)
      }
    } catch (error) {
      if (runtime.signal.aborted) throw error
      if (
        stage === 'capture' &&
        reserved &&
        (error instanceof CaptureRejected ||
          (error instanceof DiscoveryError && error.code === 'validation'))
      ) {
        await runtime.commit(async tx => {
          const app = await tx.doc(DiscoveryState)
          const current = app.runs[task.input.runId]!
          const p = current.pages.find(p => p.id === page.id)!
          app.attempts[attemptId]!.status = 'completed'
          current.artifacts[p.id]!.failed.push(viewport)
          p.status = p.desktopUrl || p.mobileUrl ? 'captured' : 'failed'
          p.error = errorMessage(error)
          touch(current)
          log(current, 'Page capture failed', p.error, 'error')
          return {
            status: 'running',
            checkpoint: { phase: 'next', step: step + 1 },
          }
        }, BACKGROUND_CONTEXT)
      } else
        await this.block(
          task,
          runtime,
          errorMessage(error),
          reserved ? attemptId : '',
          page.id,
          error instanceof AnalysisRejected || error instanceof AnalysisUnknown
            ? error
            : undefined,
        )
    }
  }
  async abort(task: WorkRecord, runtime: Runtime) {
    await runtime.commit(async tx => {
      const app = await tx.doc(DiscoveryState)
      const stored = app.runs[task.input.runId]
      if (stored) {
        stored.run.phase = 'requires_retry'
        stored.run.error = 'Work interrupted; review and explicitly retry'
        for (const attempt of Object.values(app.attempts))
          if (
            attempt.runId === task.input.runId &&
            attempt.status === 'inflight'
          )
            attempt.status = 'unknown'
        touch(stored)
      }
      return { status: 'terminal', outcome: { status: 'aborted' } }
    }, BACKGROUND_CONTEXT)
  }
}
function makeWorkTask(engine: () => DiscoveryEngine) {
  return defineTask<WorkInput, WorkCheckpoint, WorkResult>({
    name: 'discovery.work',
    version: 1,
    initial: input =>
      input.stage === 'capture'
        ? { phase: 'discover' }
        : { phase: 'next', step: 0 },
    phases: {
      discover: (task, runtime) => engine().discover(task, runtime),
      next: (task, runtime) => engine().next(task, runtime),
      inflight: (task, runtime) => engine().recover(task, runtime),
    },
    abort: (task, runtime) => engine().abort(task, runtime),
  })
}

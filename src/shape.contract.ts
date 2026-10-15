import { Schema as S } from 'effect'
import { Rpc, RpcGroup } from 'effect/unstable/rpc'

export class DiscoveryError extends S.TaggedError<DiscoveryError>(
  'DiscoveryError',
)('DiscoveryError', {
  code: S.Literals([
    'unauthorized',
    'forbidden',
    'not_found',
    'validation',
    'conflict',
    'busy',
    'configuration',
    'budget',
    'storage',
    'provider',
  ]),
  message: S.String,
  retryable: S.Boolean,
}) {}
export const InputMode = S.Literals(['single', 'batch', 'domain', 'sitemap'])
export const EvidenceMode = S.Literals(['live', 'fixture'])
export const Viewport = S.Literals(['desktop', 'mobile'])
export const TargetCms = S.Literals([
  'generic',
  'aem',
  'optimizely',
  'sitecore',
  'contentful',
  'sanity',
  'umbraco',
  'wordpress',
])
export const RunPhase = S.Literals([
  'queued',
  'capturing',
  'captured',
  'analyzing',
  'completed',
  'requires_retry',
  'failed',
])
export const CaptureInput = S.Struct({
  mode: InputMode,
  source: S.String,
  depth: S.Int,
  maxPages: S.Int,
  desktop: S.Boolean,
  mobile: S.Boolean,
  targetCms: TargetCms,
  evidenceMode: EvidenceMode,
})
export type CaptureInput = typeof CaptureInput.Type
export const Project = S.Struct({
  id: S.String,
  name: S.String,
  revision: S.Int,
  createdAt: S.String,
})
export type Project = typeof Project.Type
export const Configuration = S.Struct({
  fixtureEnabled: S.Boolean,
  captureReady: S.Boolean,
  analysisReady: S.Boolean,
  missingCapture: S.Array(S.String),
  missingAnalysis: S.Array(S.String),
  model: S.String,
  runLimitUsd: S.Finite,
  monthlyLimitUsd: S.Finite,
  attemptReservationUsd: S.Finite,
})
export type Configuration = typeof Configuration.Type
export const ReasoningLevel = S.Literals([
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
])
export const CacheRetention = S.Literals(['none', 'short', 'long'])
export const AnalysisSettingsValues = S.Struct({
  modelId: S.String,
  maxOutputTokens: S.Int,
  reasoning: S.NullOr(ReasoningLevel),
  thinkingBudgetTokens: S.NullOr(S.Int),
  temperature: S.NullOr(S.Finite),
  requestTimeoutMs: S.Int,
  cacheRetention: CacheRetention,
  maxDomChars: S.Int,
  screenshotEvidence: S.Literals(['both', 'desktop', 'mobile', 'none']),
  extraInstructions: S.String,
  runLimitUsd: S.NullOr(S.Finite),
  monthlyLimitUsd: S.NullOr(S.Finite),
  attemptReservationUsd: S.NullOr(S.Finite),
})
export type AnalysisSettingsValues = typeof AnalysisSettingsValues.Type
export const AnalysisSettings = S.Struct({
  revision: S.Int,
  updatedAt: S.String,
  values: AnalysisSettingsValues,
})
export type AnalysisSettings = typeof AnalysisSettings.Type
export const AnalysisModel = S.Struct({
  id: S.String,
  label: S.String,
  contextWindow: S.NullOr(S.Int),
  maxOutputTokens: S.NullOr(S.Int),
  effectiveContextWindow: S.Int,
  effectiveMaxOutputTokens: S.Int,
  reasoningLevels: S.Array(ReasoningLevel),
  defaultReasoning: S.NullOr(ReasoningLevel),
  thinkingMode: S.Literals(['budget', 'adaptive', 'unsupported']),
  supportsTemperature: S.Boolean,
  supportsImages: S.Boolean,
  cacheRetentions: S.Array(CacheRetention),
  selectable: S.Boolean,
  disabledReason: S.String,
  lifecycle: S.Literals(['active', 'deprecated', 'retired', 'unknown']),
  createdAt: S.String,
  deprecatedAt: S.NullOr(S.String),
  retiresAt: S.NullOr(S.String),
  pricingSource: S.Literals(['pi-ai-1.0.3', 'unavailable']),
  capabilitySource: S.Literals([
    'anthropic-api',
    'anthropic-api+pi-ai-1.0.3',
    'pi-ai-1.0.3',
    'unavailable',
  ]),
})
export type AnalysisModel = typeof AnalysisModel.Type
export const ModelCatalogStatus = S.Struct({
  source: S.Literals(['anthropic-api', 'fixture']),
  status: S.Literals(['fresh', 'stale', 'unavailable']),
  revision: S.Int,
  fetchedAt: S.NullOr(S.String),
  expiresAt: S.NullOr(S.String),
  lastAttemptAt: S.NullOr(S.String),
  nextRetryAt: S.NullOr(S.String),
  error: S.String,
  ttlSeconds: S.Int,
  modelCount: S.Int,
})
export type ModelCatalogStatus = typeof ModelCatalogStatus.Type
export const SettingsEvaluation = S.Struct({
  analysisReady: S.Boolean,
  issues: S.Array(S.String),
  minimumReservationUsd: S.Finite,
  effectiveMaxOutputTokens: S.Int,
  effectiveThinkingBudgetTokens: S.NullOr(S.Int),
  effectiveReasoning: ReasoningLevel,
  catalogRevision: S.optionalKey(S.Int),
})
export type SettingsEvaluation = typeof SettingsEvaluation.Type
export const SettingsSnapshot = S.Struct({
  settings: AnalysisSettings,
  models: S.Array(AnalysisModel),
  evaluation: SettingsEvaluation,
  catalog: ModelCatalogStatus,
})
export type SettingsSnapshot = typeof SettingsSnapshot.Type
export const AnalysisSettingsSnapshot = S.Struct({
  settingsRevision: S.Int,
  settingsUpdatedAt: S.String,
  admittedAt: S.String,
  values: AnalysisSettingsValues,
  effectiveMaxOutputTokens: S.Int,
  effectiveThinkingBudgetTokens: S.NullOr(S.Int),
  effectiveReasoning: ReasoningLevel,
  minimumReservationUsd: S.Finite,
  promptVersion: S.String,
  model: S.optionalKey(AnalysisModel),
  catalogRevision: S.optionalKey(S.Int),
  catalogFetchedAt: S.optionalKey(S.String),
})
export type AnalysisSettingsSnapshot = typeof AnalysisSettingsSnapshot.Type
export const Budget = S.Struct({
  spentUsd: S.Finite,
  reservedUsd: S.Finite,
  runLimitUsd: S.Finite,
  monthlyLimitUsd: S.Finite,
})
export type Budget = typeof Budget.Type
export const Usage = S.Struct({
  model: S.String,
  inputTokens: S.Int,
  outputTokens: S.Int,
  cacheReadTokens: S.Int,
  cacheWriteTokens: S.Int,
  costUsd: S.Finite,
  reservedUsd: S.Finite,
  analyzedPages: S.Int,
  durationMs: S.Int,
})
export type Usage = typeof Usage.Type
export const AnalysisAttempt = S.Struct({
  id: S.String,
  pageId: S.String,
  status: S.Literals(['inflight', 'completed', 'unknown']),
  settings: S.NullOr(AnalysisSettingsSnapshot),
  usage: S.NullOr(Usage),
  reservedUsd: S.Finite,
  spentUsd: S.Finite,
  diagnostic: S.String,
  rawResponseTruncated: S.Boolean,
  rawResponseChars: S.Int,
})
export type AnalysisAttempt = typeof AnalysisAttempt.Type
export const Provenance = S.Struct({
  mode: EvidenceMode,
  provider: S.String,
  model: S.String,
  attemptId: S.String,
  capturedAt: S.String,
})
export type Provenance = typeof Provenance.Type
export const Page = S.Struct({
  id: S.String,
  projectId: S.String,
  runId: S.String,
  url: S.String,
  title: S.String,
  status: S.Literals([
    'queued',
    'capturing',
    'captured',
    'analyzing',
    'analyzed',
    'failed',
    'requires_retry',
  ]),
  desktopUrl: S.String,
  mobileUrl: S.String,
  error: S.String,
  selected: S.Boolean,
  provenance: Provenance,
})
export type Page = typeof Page.Type
export const Field = S.Struct({
  name: S.String,
  type: S.String,
  required: S.Boolean,
})
export type Field = typeof Field.Type
export const FindingEvidence = S.Struct({
  pageId: S.String,
  provenance: Provenance,
  fields: S.Array(Field),
  variants: S.Array(S.String),
  confidence: S.Finite,
  description: S.String,
})
export type FindingEvidence = typeof FindingEvidence.Type
export const Finding = S.Struct({
  id: S.String,
  projectId: S.String,
  runId: S.String,
  kind: S.Literals(['component', 'content-type']),
  name: S.String,
  description: S.String,
  category: S.String,
  confidence: S.Finite,
  pageIds: S.Array(S.String),
  fields: S.Array(Field),
  variants: S.Array(S.String),
  cmsName: S.String,
  existingId: S.String,
  existingName: S.String,
  savedRecordId: S.String,
  saveReceiptId: S.String,
  evidence: S.Array(FindingEvidence),
  provenance: Provenance,
})
export type Finding = typeof Finding.Type
export const Run = S.Struct({
  id: S.String,
  projectId: S.String,
  revision: S.Int,
  phase: RunPhase,
  input: CaptureInput,
  createdAt: S.String,
  updatedAt: S.String,
  pageCount: S.Int,
  capturedCount: S.Int,
  analyzedCount: S.Int,
  failedCount: S.Int,
  error: S.String,
  usage: Usage,
})
export type Run = typeof Run.Type
export const Log = S.Struct({
  seq: S.Int,
  runId: S.String,
  at: S.String,
  level: S.Literals(['info', 'warn', 'error']),
  message: S.String,
  detail: S.String,
})
export type Log = typeof Log.Type
export const SaveChoice = S.Struct({
  findingId: S.String,
  action: S.Literals(['create', 'merge', 'skip']),
  targetId: S.String,
})
export type SaveChoice = typeof SaveChoice.Type
export const SavePreviewItem = S.Struct({
  findingId: S.String,
  action: S.Literals(['create', 'merge', 'skip']),
  targetId: S.String,
  cmsName: S.String,
  name: S.String,
  kind: S.Literals(['component', 'content-type']),
})
export type SavePreviewItem = typeof SavePreviewItem.Type
export const SaveReceipt = S.Struct({
  id: S.String,
  commandId: S.String,
  projectId: S.String,
  runId: S.String,
  createdAt: S.String,
  records: S.Array(
    S.Struct({
      findingId: S.String,
      recordId: S.String,
      action: S.Literals(['create', 'merge']),
      cmsName: S.String,
    }),
  ),
})
export type SaveReceipt = typeof SaveReceipt.Type
export const DesignVariant = S.Struct({
  id: S.String,
  name: S.String,
  pageId: S.String,
  sourceRunId: S.String,
  desktopUrl: S.String,
  mobileUrl: S.String,
  provenance: Provenance,
})
export type DesignVariant = typeof DesignVariant.Type
export const LibraryRecord = S.Struct({
  id: S.String,
  projectId: S.String,
  kind: S.Literals(['component', 'content-type']),
  name: S.String,
  cmsName: S.String,
  description: S.String,
  fields: S.Array(Field),
  variants: S.Array(S.String),
  revision: S.Int,
  sourceRunId: S.String,
  designVariants: S.Array(DesignVariant),
  provenance: Provenance,
  createdAt: S.String,
  updatedAt: S.String,
})
export type LibraryRecord = typeof LibraryRecord.Type
export const RunSnapshot = S.Struct({
  run: Run,
  pages: S.Array(Page),
  findings: S.Array(Finding),
  logs: S.Array(Log),
  receipts: S.Array(SaveReceipt),
  budget: Budget,
  analysisAttempts: S.optional(S.Array(AnalysisAttempt)),
})
export type RunSnapshot = typeof RunSnapshot.Type
export const Workspace = S.Struct({
  projects: S.Array(Project),
  configuration: Configuration,
  budget: Budget,
  activeRunId: S.String,
  sessionId: S.String,
})
export type Workspace = typeof Workspace.Type
export const SessionState = S.Struct({
  authenticated: S.Boolean,
  sessionId: S.String,
})
export type SessionState = typeof SessionState.Type
export const ExportResult = S.Struct({ filename: S.String, json: S.String })
export type ExportResult = typeof ExportResult.Type
export const SavePreview = S.Struct({
  projectId: S.String,
  runId: S.String,
  revision: S.Int,
  projectRevision: S.Int,
  items: S.Array(SavePreviewItem),
})
export type SavePreview = typeof SavePreview.Type
const scope = { projectId: S.String, runId: S.String }
const command = { commandId: S.String, expectedRevision: S.Int }
export const getDiscoverySettingsRpc = Rpc.make('getDiscoverySettings', {
  payload: S.Struct({}),
  success: SettingsSnapshot,
  error: DiscoveryError,
})
export const refreshDiscoveryModelsRpc = Rpc.make('refreshDiscoveryModels', {
  payload: S.Struct({}),
  success: SettingsSnapshot,
  error: DiscoveryError,
})
export const previewDiscoverySettingsRpc = Rpc.make(
  'previewDiscoverySettings',
  {
    payload: S.Struct({ values: AnalysisSettingsValues }),
    success: SettingsEvaluation,
    error: DiscoveryError,
  },
)
export const saveDiscoverySettingsRpc = Rpc.make('saveDiscoverySettings', {
  payload: S.Struct({ ...command, values: AnalysisSettingsValues }),
  success: SettingsSnapshot,
  error: DiscoveryError,
})
export const getDiscoveryWorkspaceRpc = Rpc.make('getDiscoveryWorkspace', {
  payload: S.Struct({}),
  success: Workspace,
  error: DiscoveryError,
})
export const createDiscoveryProjectRpc = Rpc.make('createDiscoveryProject', {
  payload: S.Struct({ commandId: S.String, name: S.String }),
  success: Project,
  error: DiscoveryError,
})
export const getDiscoveryHistoryRpc = Rpc.make('getDiscoveryHistory', {
  payload: S.Struct({ projectId: S.String }),
  success: S.Array(Run),
  error: DiscoveryError,
})
export const getDiscoveryRunRpc = Rpc.make('getDiscoveryRun', {
  payload: S.Struct(scope),
  success: RunSnapshot,
  error: DiscoveryError,
})
export const getDiscoveryLogsRpc = Rpc.make('getDiscoveryLogs', {
  payload: S.Struct({ ...scope, afterSeq: S.Int }),
  success: S.Array(Log),
  error: DiscoveryError,
})
export const createDiscoveryCaptureRpc = Rpc.make('createDiscoveryCapture', {
  payload: S.Struct({
    projectId: S.String,
    commandId: S.String,
    input: CaptureInput,
  }),
  success: RunSnapshot,
  error: DiscoveryError,
})
export const analyzeDiscoveryPagesRpc = Rpc.make('analyzeDiscoveryPages', {
  payload: S.Struct({ ...scope, ...command, pageIds: S.Array(S.String) }),
  success: RunSnapshot,
  error: DiscoveryError,
})
export const retryDiscoveryRunRpc = Rpc.make('retryDiscoveryRun', {
  payload: S.Struct({ ...scope, ...command }),
  success: RunSnapshot,
  error: DiscoveryError,
})
export const previewDiscoverySaveRpc = Rpc.make('previewDiscoverySave', {
  payload: S.Struct({
    ...scope,
    expectedRevision: S.Int,
    choices: S.Array(SaveChoice),
  }),
  success: SavePreview,
  error: DiscoveryError,
})
export const saveDiscoveryFindingsRpc = Rpc.make('saveDiscoveryFindings', {
  payload: S.Struct({
    ...scope,
    ...command,
    expectedProjectRevision: S.Int,
    choices: S.Array(SaveChoice),
  }),
  success: SaveReceipt,
  error: DiscoveryError,
})
export const getDiscoveryLibraryRpc = Rpc.make('getDiscoveryLibrary', {
  payload: S.Struct({ projectId: S.String }),
  success: S.Array(LibraryRecord),
  error: DiscoveryError,
})
export const exportDiscoveryProjectRpc = Rpc.make('exportDiscoveryProject', {
  payload: S.Struct({ projectId: S.String }),
  success: ExportResult,
  error: DiscoveryError,
})
export const deleteDiscoveryRunRpc = Rpc.make('deleteDiscoveryRun', {
  payload: S.Struct({ ...scope, ...command }),
  success: S.Struct({ deleted: S.Boolean }),
  error: DiscoveryError,
})
export const DiscoveryRpcs = RpcGroup.make(
  getDiscoverySettingsRpc,
  refreshDiscoveryModelsRpc,
  previewDiscoverySettingsRpc,
  saveDiscoverySettingsRpc,
  getDiscoveryWorkspaceRpc,
  createDiscoveryProjectRpc,
  getDiscoveryHistoryRpc,
  getDiscoveryRunRpc,
  getDiscoveryLogsRpc,
  createDiscoveryCaptureRpc,
  analyzeDiscoveryPagesRpc,
  retryDiscoveryRunRpc,
  previewDiscoverySaveRpc,
  saveDiscoveryFindingsRpc,
  getDiscoveryLibraryRpc,
  exportDiscoveryProjectRpc,
  deleteDiscoveryRunRpc,
)
export type DiscoveryRpcs = typeof DiscoveryRpcs

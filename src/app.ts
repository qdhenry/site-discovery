import { Array as A, Duration, Effect, Match as M, Option, Schema as S, Stream } from 'effect'
import { AsyncData, Command, Port, Runtime, Subscription } from 'foldkit'
import { type Html, type HtmlBuilder } from 'foldkit/html'
import { taggedStruct } from 'foldkit/schema'
import { evo } from 'foldkit/struct'

import { DiscoveryClient, discoverySession, makeDiscoveryClientLive } from './client.ts'
import {
  AnalysisSettings, AnalysisSettingsValues, type AnalysisModel, SettingsEvaluation, SettingsSnapshot,
  CaptureInput, ExportResult, type Finding, LibraryRecord, Project, Run,
  RunSnapshot, SaveChoice, SavePreview, SaveReceipt, SessionState, Workspace,
} from './contract.ts'

export const WorkspaceData = AsyncData.Schema(Workspace, S.String)
export const SnapshotData = AsyncData.Schema(RunSnapshot, S.String)
export const HistoryData = AsyncData.Schema(S.Array(Run), S.String)
export const LibraryData = AsyncData.Schema(S.Array(LibraryRecord), S.String)
export const SessionData = AsyncData.Schema(SessionState, S.String)
export const PreviewData = AsyncData.Schema(SavePreview, S.String)
export const ExportData = AsyncData.Schema(ExportResult, S.String)
export const SettingsData = AsyncData.Schema(SettingsSnapshot, S.String)
export const EvaluationData = AsyncData.Schema(SettingsEvaluation, S.String)
const SettingsDraft = S.Struct({
  modelId: S.String, maxOutputTokens: S.String, reasoning: S.String, thinkingBudgetTokens: S.String,
  temperature: S.String, requestTimeoutMs: S.String, cacheRetention: S.String, maxDomChars: S.String,
  screenshotEvidence: S.String, extraInstructions: S.String, runLimitUsd: S.String,
  monthlyLimitUsd: S.String, attemptReservationUsd: S.String,
})
export type SettingsDraft = typeof SettingsDraft.Type
const SettingsEditor = S.Struct({ base: AnalysisSettings, draft: SettingsDraft, draftRevision: S.Int, preview: EvaluationData.schema, notice: S.String })
const Scope = { projectId: S.String, runId: S.String, expectedRevision: S.Int }
const CaptureRequest = taggedStruct('CaptureRequest', { projectId: S.String, input: CaptureInput })
const AnalyzeRequest = taggedStruct('AnalyzeRequest', { ...Scope, pageIds: S.Array(S.String) })
const RetryRunRequest = taggedStruct('RetryRunRequest', Scope)
const SaveRequest = taggedStruct('SaveRequest', { ...Scope, expectedProjectRevision: S.Int, choices: S.Array(SaveChoice) })
const ProjectRequest = taggedStruct('ProjectRequest', { name: S.String })
const DeleteRequest = taggedStruct('DeleteRequest', Scope)
const SettingsRequest = taggedStruct('SettingsRequest', { expectedRevision: S.Int, values: AnalysisSettingsValues })
export const Request = S.Union([CaptureRequest, AnalyzeRequest, RetryRunRequest, SaveRequest, ProjectRequest, DeleteRequest, SettingsRequest])
export type Request = typeof Request.Type
const Ready = taggedStruct('Ready')
const Sending = taggedStruct('Sending', { commandId: S.String, request: Request })
const Refused = taggedStruct('Refused', { commandId: S.String, request: Request, retryable: S.Boolean, error: S.String })
const Mutation = S.Union([Ready, Sending, Refused])
export const Model = S.Struct({
  apiUrl: S.String, projectId: S.String, runId: S.String, generation: S.Int,
  instanceId: S.String, sequence: S.Int, session: SessionData.schema,
  workspace: WorkspaceData.schema, history: HistoryData.schema, snapshot: SnapshotData.schema,
  library: LibraryData.schema, preview: PreviewData.schema, exported: ExportData.schema,
  settings: SettingsData.schema, settingsOpen: S.Boolean, settingsEpoch: S.Int, settingsEditor: S.NullOr(SettingsEditor),
  mutation: Mutation, ownerToken: S.String, projectName: S.String,
  input: CaptureInput, pageId: S.String, viewport: S.Literals(['desktop', 'mobile']),
  analysisIds: S.Array(S.String), findingIds: S.Array(S.String), choices: S.Array(SaveChoice),
  findingTab: S.Literals(['component', 'content-type']), selectionRevision: S.Int,
  notice: S.String, deleteConfirmation: S.Boolean, showLibrary: S.Boolean,
})
export type Model = typeof Model.Type
const epoch = { generation: S.Int }
const settingsEpoch = { ...epoch, settingsEpoch: S.Int }
export const RequestedSettings = taggedStruct('RequestedSettings')
export const RequestedModelRefresh = taggedStruct('RequestedModelRefresh')
export const ClosedSettings = taggedStruct('ClosedSettings')
export const RevertedSettings = taggedStruct('RevertedSettings')
export const ReloadedSettings = taggedStruct('ReloadedSettings')
export const ChangedSetting = taggedStruct('ChangedSetting', { key: S.Literals(['modelId', 'maxOutputTokens', 'reasoning', 'thinkingBudgetTokens', 'temperature', 'requestTimeoutMs', 'cacheRetention', 'maxDomChars', 'screenshotEvidence', 'extraInstructions', 'runLimitUsd', 'monthlyLimitUsd', 'attemptReservationUsd']), value: S.String })
export const SucceededSettings = taggedStruct('SucceededSettings', { ...settingsEpoch, snapshot: SettingsSnapshot })
export const FailedSettings = taggedStruct('FailedSettings', { ...settingsEpoch, error: S.String, unauthorized: S.Boolean })
export const RequestedSettingsPreview = taggedStruct('RequestedSettingsPreview')
export const SucceededSettingsPreview = taggedStruct('SucceededSettingsPreview', { ...settingsEpoch, draftRevision: S.Int, evaluation: SettingsEvaluation })
export const FailedSettingsPreview = taggedStruct('FailedSettingsPreview', { ...settingsEpoch, draftRevision: S.Int, error: S.String, unauthorized: S.Boolean })
export const RequestedSettingsSave = taggedStruct('RequestedSettingsSave')
export const SucceededMutationSettings = taggedStruct('SucceededMutationSettings', { ...epoch, snapshot: SettingsSnapshot })
export const Ticked = taggedStruct('Ticked')
export const ChangedContext = taggedStruct('ChangedContext', { key: S.Literals(['api', 'project', 'run']), value: S.String })
export const ChangedField = taggedStruct('ChangedField', { key: S.Literals(['ownerToken', 'projectName', 'source', 'mode', 'depth', 'maxPages', 'targetCms', 'evidenceMode']), value: S.String })
export const ToggledViewport = taggedStruct('ToggledViewport', { viewport: S.Literals(['desktop', 'mobile']) })
export const RequestedLogin = taggedStruct('RequestedLogin')
export const RequestedLogout = taggedStruct('RequestedLogout')
export const RequestedRefresh = taggedStruct('RequestedRefresh')
export const SucceededSession = taggedStruct('SucceededSession', { ...epoch, session: SessionState })
export const FailedSession = taggedStruct('FailedSession', { ...epoch, error: S.String })
export const SucceededWorkspace = taggedStruct('SucceededWorkspace', { ...epoch, workspace: Workspace, history: S.Array(Run), library: S.Array(LibraryRecord) })
export const FailedWorkspace = taggedStruct('FailedWorkspace', { ...epoch, error: S.String, unauthorized: S.Boolean })
export const SucceededSnapshot = taggedStruct('SucceededSnapshot', { ...epoch, snapshot: RunSnapshot })
export const FailedSnapshot = taggedStruct('FailedSnapshot', { ...epoch, error: S.String, unauthorized: S.Boolean })
export const RequestedCapture = taggedStruct('RequestedCapture')
export const RequestedAnalysis = taggedStruct('RequestedAnalysis')
export const RequestedRetryRun = taggedStruct('RequestedRetryRun')
export const RequestedRetryCommand = taggedStruct('RequestedRetryCommand')
export const RequestedProject = taggedStruct('RequestedProject')
export const RequestedNewRun = taggedStruct('RequestedNewRun')
export const SelectedPage = taggedStruct('SelectedPage', { pageId: S.String })
export const SelectedViewport = taggedStruct('SelectedViewport', { viewport: S.Literals(['desktop', 'mobile']) })
export const ToggledAnalysisPage = taggedStruct('ToggledAnalysisPage', { pageId: S.String })
export const SelectedAllPages = taggedStruct('SelectedAllPages', { selected: S.Boolean })
export const SelectedFindingTab = taggedStruct('SelectedFindingTab', { tab: S.Literals(['component', 'content-type']) })
export const ToggledFinding = taggedStruct('ToggledFinding', { findingId: S.String })
export const ChoseDuplicate = taggedStruct('ChoseDuplicate', { findingId: S.String, action: S.Literals(['create', 'merge']) })
export const ClearedFindings = taggedStruct('ClearedFindings')
export const RequestedPreview = taggedStruct('RequestedPreview')
export const SucceededPreview = taggedStruct('SucceededPreview', { ...epoch, selectionRevision: S.Int, preview: SavePreview })
export const FailedPreview = taggedStruct('FailedPreview', { ...epoch, selectionRevision: S.Int, error: S.String })
export const RequestedSave = taggedStruct('RequestedSave')
export const SucceededMutationRun = taggedStruct('SucceededMutationRun', { ...epoch, snapshot: RunSnapshot })
export const SucceededMutationProject = taggedStruct('SucceededMutationProject', { ...epoch, project: Project })
export const SucceededMutationSave = taggedStruct('SucceededMutationSave', { ...epoch, receipt: SaveReceipt })
export const SucceededMutationDelete = taggedStruct('SucceededMutationDelete', epoch)
export const FailedMutation = taggedStruct('FailedMutation', { ...epoch, error: S.String, retryable: S.Boolean, unauthorized: S.Boolean })
export const RequestedExport = taggedStruct('RequestedExport')
export const SucceededExport = taggedStruct('SucceededExport', { ...epoch, exported: ExportResult })
export const FailedExport = taggedStruct('FailedExport', { ...epoch, error: S.String })
export const ToggledLibrary = taggedStruct('ToggledLibrary')
export const RequestedDelete = taggedStruct('RequestedDelete')
export const CancelledDelete = taggedStruct('CancelledDelete')
export const ConfirmedDelete = taggedStruct('ConfirmedDelete')
export const RequestedCopy = taggedStruct('RequestedCopy', { text: S.String })
export const CompletedCopy = taggedStruct('CompletedCopy', { ...epoch, error: S.String })
export const CompletedReport = taggedStruct('CompletedReport')
export const Message = S.Union([
  Ticked, ChangedContext, ChangedField, ToggledViewport, RequestedLogin, RequestedLogout, RequestedRefresh,
  SucceededSession, FailedSession, SucceededWorkspace, FailedWorkspace, SucceededSnapshot, FailedSnapshot,
  RequestedCapture, RequestedAnalysis, RequestedRetryRun, RequestedRetryCommand, RequestedProject, RequestedNewRun,
  SelectedPage, SelectedViewport, ToggledAnalysisPage, SelectedAllPages, SelectedFindingTab, ToggledFinding,
  ChoseDuplicate, ClearedFindings, RequestedPreview, SucceededPreview, FailedPreview, RequestedSave,
  SucceededMutationRun, SucceededMutationProject, SucceededMutationSave, SucceededMutationDelete, FailedMutation,
  RequestedExport, SucceededExport, FailedExport, ToggledLibrary, RequestedDelete, CancelledDelete, ConfirmedDelete,
  RequestedCopy, CompletedCopy, CompletedReport, RequestedSettings, RequestedModelRefresh, ClosedSettings, RevertedSettings, ReloadedSettings,
  ChangedSetting, SucceededSettings, FailedSettings, RequestedSettingsPreview, SucceededSettingsPreview, FailedSettingsPreview, RequestedSettingsSave, SucceededMutationSettings,
])
export type Message = typeof Message.Type
export const ports = {
  inbound: { apiChanged: Port.inbound(S.String), projectChanged: Port.inbound(S.String), runChanged: Port.inbound(S.String) },
  outbound: { runSelected: Port.outbound(Run), projectSelected: Port.outbound(Project), findingsSaved: Port.outbound(SaveReceipt) },
}
const errorMessage = (error: unknown): string => error instanceof Error ? error.message : String(error)
/** HTTP transport refusals wrap their response under reason/cause; RPC refusals carry a code. */
export const unauthorized = (error: unknown, depth = 0): boolean => {
  if (depth > 5 || typeof error !== 'object' || error === null) return false
  if ('code' in error && (error.code === 'unauthorized' || error.code === 'forbidden')) return true
  if ('status' in error && (error.status === 401 || error.status === 403)) return true
  return ('reason' in error && unauthorized(error.reason, depth + 1)) ||
    ('cause' in error && unauthorized(error.cause, depth + 1)) ||
    ('response' in error && unauthorized(error.response, depth + 1))
}
const retryable = (error: unknown): boolean => !(typeof error === 'object' && error !== null && 'retryable' in error) || error.retryable === true
export const LoadSession = Command.define('LoadSession', {
  args: { ...epoch, apiUrl: S.String, method: S.Literals(['GET', 'POST', 'DELETE']), token: S.String },
  messages: [SucceededSession, FailedSession],
  execute: ({ generation, apiUrl, method, token }) => discoverySession(apiUrl, method, token).pipe(
    Effect.map(session => SucceededSession({ generation, session })),
    Effect.catch(error => Effect.succeed(FailedSession({ generation, error }))),
  ),
})
export const LoadWorkspace = Command.define('LoadWorkspace', {
  args: { ...epoch, apiUrl: S.String, projectId: S.String }, messages: [SucceededWorkspace, FailedWorkspace],
  execute: ({ generation, apiUrl, projectId }) => Effect.gen(function* () {
    const client = yield* DiscoveryClient
    const workspace = yield* client.getDiscoveryWorkspace({})
    const history = yield* client.getDiscoveryHistory({ projectId })
    const library = yield* client.getDiscoveryLibrary({ projectId })
    return SucceededWorkspace({ generation, workspace, history, library })
  }).pipe(
    Effect.catch(error => Effect.succeed(FailedWorkspace({ generation, error: errorMessage(error), unauthorized: unauthorized(error) }))),
    Effect.provide(makeDiscoveryClientLive(apiUrl)),
  ),
})
export const LoadSettings = Command.define('LoadSettings', {
  args: { ...settingsEpoch, apiUrl: S.String }, messages: [SucceededSettings, FailedSettings],
  execute: ({ generation, settingsEpoch, apiUrl }) => Effect.gen(function* () {
    const client = yield* DiscoveryClient
    const snapshot = yield* client.getDiscoverySettings({})
    return SucceededSettings({ generation, settingsEpoch, snapshot })
  }).pipe(
    Effect.catch(error => Effect.succeed(FailedSettings({ generation, settingsEpoch, error: errorMessage(error), unauthorized: unauthorized(error) }))),
    Effect.provide(makeDiscoveryClientLive(apiUrl)),
  ),
})
export const RefreshModels = Command.define('RefreshModels', {
  args: { ...settingsEpoch, apiUrl: S.String }, messages: [SucceededSettings, FailedSettings],
  execute: ({ generation, settingsEpoch, apiUrl }) => Effect.gen(function* () {
    const client = yield* DiscoveryClient
    const snapshot = yield* client.refreshDiscoveryModels({})
    return SucceededSettings({ generation, settingsEpoch, snapshot })
  }).pipe(
    Effect.catch(error => Effect.succeed(FailedSettings({ generation, settingsEpoch, error: errorMessage(error), unauthorized: unauthorized(error) }))),
    Effect.provide(makeDiscoveryClientLive(apiUrl)),
  ),
})
export const PreviewSettings = Command.define('PreviewSettings', {
  args: { ...settingsEpoch, apiUrl: S.String, draftRevision: S.Int, values: AnalysisSettingsValues },
  messages: [SucceededSettingsPreview, FailedSettingsPreview],
  execute: ({ generation, settingsEpoch, apiUrl, draftRevision, values }) => Effect.gen(function* () {
    const client = yield* DiscoveryClient
    const evaluation = yield* client.previewDiscoverySettings({ values })
    return SucceededSettingsPreview({ generation, settingsEpoch, draftRevision, evaluation })
  }).pipe(
    Effect.catch(error => Effect.succeed(FailedSettingsPreview({ generation, settingsEpoch, draftRevision, error: errorMessage(error), unauthorized: unauthorized(error) }))),
    Effect.provide(makeDiscoveryClientLive(apiUrl)),
  ),
})
export const LoadSnapshot = Command.define('LoadSnapshot', {
  args: { ...epoch, apiUrl: S.String, projectId: S.String, runId: S.String }, messages: [SucceededSnapshot, FailedSnapshot],
  execute: ({ generation, apiUrl, projectId, runId }) => Effect.gen(function* () {
    const client = yield* DiscoveryClient
    const snapshot = yield* client.getDiscoveryRun({ projectId, runId })
    return SucceededSnapshot({ generation, snapshot })
  }).pipe(
    Effect.catch(error => Effect.succeed(FailedSnapshot({ generation, error: errorMessage(error), unauthorized: unauthorized(error) }))),
    Effect.provide(makeDiscoveryClientLive(apiUrl)),
  ),
})
export const SubmitRequest = Command.define('SubmitRequest', {
  args: { ...epoch, apiUrl: S.String, commandId: S.String, request: Request },
  messages: [SucceededMutationRun, SucceededMutationProject, SucceededMutationSave, SucceededMutationDelete, SucceededMutationSettings, FailedMutation],
  execute: ({ generation, apiUrl, commandId, request }) => Effect.gen(function* () {
    const client = yield* DiscoveryClient
    return yield* M.value(request).pipe(M.tagsExhaustive({
      CaptureRequest: ({ projectId, input }) => client.createDiscoveryCapture({ projectId, commandId, input }).pipe(Effect.map(snapshot => SucceededMutationRun({ generation, snapshot }))),
      AnalyzeRequest: ({ projectId, runId, expectedRevision, pageIds }) => client.analyzeDiscoveryPages({ projectId, runId, expectedRevision, pageIds, commandId }).pipe(Effect.map(snapshot => SucceededMutationRun({ generation, snapshot }))),
      RetryRunRequest: ({ projectId, runId, expectedRevision }) => client.retryDiscoveryRun({ projectId, runId, expectedRevision, commandId }).pipe(Effect.map(snapshot => SucceededMutationRun({ generation, snapshot }))),
      SaveRequest: ({ projectId, runId, expectedRevision, expectedProjectRevision, choices }) => client.saveDiscoveryFindings({ projectId, runId, expectedRevision, expectedProjectRevision, choices, commandId }).pipe(Effect.map(receipt => SucceededMutationSave({ generation, receipt }))),
      ProjectRequest: ({ name }) => client.createDiscoveryProject({ commandId, name }).pipe(Effect.map(project => SucceededMutationProject({ generation, project }))),
      SettingsRequest: ({ expectedRevision, values }) => client.saveDiscoverySettings({ commandId, expectedRevision, values }).pipe(Effect.map(snapshot => SucceededMutationSettings({ generation, snapshot }))),
      DeleteRequest: ({ projectId, runId, expectedRevision }) => client.deleteDiscoveryRun({ projectId, runId, expectedRevision, commandId }).pipe(Effect.as(SucceededMutationDelete({ generation }))),
    }))
  }).pipe(
    Effect.catch(error => Effect.succeed(FailedMutation({ generation, error: errorMessage(error), retryable: retryable(error), unauthorized: unauthorized(error) }))),
    Effect.provide(makeDiscoveryClientLive(apiUrl)),
  ),
})
export const LoadPreview = Command.define('LoadPreview', {
  args: { ...epoch, apiUrl: S.String, ...Scope, selectionRevision: S.Int, choices: S.Array(SaveChoice) },
  messages: [SucceededPreview, FailedPreview],
  execute: ({ generation, apiUrl, projectId, runId, expectedRevision, selectionRevision, choices }) => Effect.gen(function* () {
    const client = yield* DiscoveryClient
    const preview = yield* client.previewDiscoverySave({ projectId, runId, expectedRevision, choices })
    return SucceededPreview({ generation, selectionRevision, preview })
  }).pipe(
    Effect.catch(error => Effect.succeed(FailedPreview({ generation, selectionRevision, error: errorMessage(error) }))),
    Effect.provide(makeDiscoveryClientLive(apiUrl)),
  ),
})
export const LoadExport = Command.define('LoadExport', {
  args: { ...epoch, apiUrl: S.String, projectId: S.String }, messages: [SucceededExport, FailedExport],
  execute: ({ generation, apiUrl, projectId }) => Effect.gen(function* () {
    const client = yield* DiscoveryClient
    const exported = yield* client.exportDiscoveryProject({ projectId })
    return SucceededExport({ generation, exported })
  }).pipe(
    Effect.catch(error => Effect.succeed(FailedExport({ generation, error: errorMessage(error) }))),
    Effect.provide(makeDiscoveryClientLive(apiUrl)),
  ),
})
export const CopyText = Command.define('CopyText', {
  args: { ...epoch, text: S.String }, messages: [CompletedCopy],
  execute: ({ generation, text }) => Effect.tryPromise({
    try: () => navigator.clipboard.writeText(text), catch: () => 'Clipboard access was refused. Select and copy the CMS name manually.',
  }).pipe(Effect.as(CompletedCopy({ generation, error: '' })), Effect.catch(error => Effect.succeed(CompletedCopy({ generation, error })))),
})
export const ReportRun = Command.define('ReportRun', { args: { run: Run }, messages: [CompletedReport], execute: ({ run }) => Port.emit(ports.outbound.runSelected, run).pipe(Effect.as(CompletedReport())) })
export const ReportProject = Command.define('ReportProject', { args: { project: Project }, messages: [CompletedReport], execute: ({ project }) => Port.emit(ports.outbound.projectSelected, project).pipe(Effect.as(CompletedReport())) })
export const ReportSaved = Command.define('ReportSaved', { args: { receipt: SaveReceipt }, messages: [CompletedReport], execute: ({ receipt }) => Port.emit(ports.outbound.findingsSaved, receipt).pipe(Effect.as(CompletedReport())) })

export const Flags = S.Struct({ apiUrl: S.String, projectId: S.String, runId: S.String })
export type Flags = typeof Flags.Type
export const initialModel = (flags: Flags, instanceId = crypto.randomUUID()): Model => ({
  apiUrl: flags.apiUrl.replace(/\/$/, ''), projectId: flags.projectId || 'default', runId: flags.runId,
  generation: 0, instanceId, sequence: 0, session: AsyncData.Loading(), workspace: AsyncData.Idle(),
  history: AsyncData.Idle(), snapshot: AsyncData.Idle(), library: AsyncData.Idle(), preview: AsyncData.Idle(), exported: AsyncData.Idle(),
  settings: AsyncData.Idle(), settingsOpen: false, settingsEpoch: 0, settingsEditor: null,
  mutation: Ready(), ownerToken: '', projectName: '',
  input: { mode: 'single', source: 'https://example.com/', depth: 1, maxPages: 10, desktop: true, mobile: true, targetCms: 'generic', evidenceMode: 'live' },
  pageId: '', viewport: 'desktop', analysisIds: [], findingIds: [], choices: [], findingTab: 'component', selectionRevision: 0,
  notice: '', deleteConfirmation: false, showLibrary: false,
})
export const init: Runtime.ElementInit<Model, Message, Flags> = flags => {
  const model = initialModel(flags)
  return { model, commands: [LoadSession({ generation: model.generation, apiUrl: model.apiUrl, method: 'GET', token: '' })] }
}
type UpdateReturn = { readonly model: Model; readonly commands?: ReadonlyArray<Command.Command<Message>> }
export const snapshotOf = (model: Model) => Option.getOrUndefined(AsyncData.getData(model.snapshot))
export const workspaceOf = (model: Model) => Option.getOrUndefined(AsyncData.getData(model.workspace))
export const settingsOf = (model: Model) => Option.getOrUndefined(AsyncData.getData(model.settings))
const sessionOf = (model: Model) => Option.getOrUndefined(AsyncData.getData(model.session))
const previewOf = (model: Model) => Option.getOrUndefined(AsyncData.getData(model.preview))
const authenticated = (model: Model) => sessionOf(model)?.authenticated === true
const isBusy = (model: Model) => model.mutation._tag === 'Sending'
const unresolvedSettingsSave = (model: Model) => model.mutation._tag === 'Refused' && model.mutation.request._tag === 'SettingsRequest' && model.mutation.retryable
const pending = <T, E>(data: AsyncData.AsyncData<T, E>): AsyncData.AsyncData<T, E> => Option.match(AsyncData.getData(data), { onNone: () => AsyncData.Loading(), onSome: data => AsyncData.Refreshing({ data }) })
const failed = <T>(data: AsyncData.AsyncData<T, string>, error: string): AsyncData.AsyncData<T, string> => Option.match(AsyncData.getData(data), { onNone: () => AsyncData.Failure({ error }), onSome: data => AsyncData.Stale({ data, error }) })
const workspaceCommand = (model: Model) => LoadWorkspace({ generation: model.generation, apiUrl: model.apiUrl, projectId: model.projectId })
const snapshotCommand = (model: Model) => LoadSnapshot({ generation: model.generation, apiUrl: model.apiUrl, projectId: model.projectId, runId: model.runId })
const settingsCommand = (model: Model) => LoadSettings({ generation: model.generation, settingsEpoch: model.settingsEpoch, apiUrl: model.apiUrl })
const refresh = (model: Model): UpdateReturn => ({
  model: evo(model, { workspace: pending, history: pending, library: pending, snapshot: value => model.runId === '' ? value : pending(value), settings: value => model.settingsOpen && value._tag !== 'Loading' && value._tag !== 'Refreshing' ? pending(value) : value }),
  commands: [...(model.runId === '' ? [workspaceCommand(model)] : [workspaceCommand(model), snapshotCommand(model)]), ...(model.settingsOpen && model.settings._tag !== 'Loading' && model.settings._tag !== 'Refreshing' ? [settingsCommand(model)] : [])],
})
const signedOut = (model: Model, notice: string): UpdateReturn => ({ model: evo(model, {
  generation: value => value + 1, session: () => SessionData.Success({ data: { authenticated: false, sessionId: '' } }),
  workspace: () => AsyncData.Idle(), history: () => AsyncData.Idle(), snapshot: () => AsyncData.Idle(), library: () => AsyncData.Idle(),
  settings: () => AsyncData.Idle(), settingsOpen: () => false, settingsEditor: () => null, settingsEpoch: value => value + 1,
  preview: () => AsyncData.Idle(), exported: () => AsyncData.Idle(), mutation: () => Ready(), analysisIds: () => [], findingIds: () => [], choices: () => [], notice: () => notice,
}) })
export const eligiblePageIds = (snapshot: RunSnapshot): ReadonlyArray<string> => A.map(A.filter(snapshot.pages, page => page.status === 'captured' && (page.desktopUrl !== '' || page.mobileUrl !== '')), page => page.id)
const toggle = (ids: ReadonlyArray<string>, id: string) => A.contains(ids, id) ? A.filter(ids, value => value !== id) : A.append(ids, id)
export const saveChoices = (model: Model): ReadonlyArray<SaveChoice> => A.map(model.findingIds, findingId => A.findFirst(model.choices, choice => choice.findingId === findingId).pipe(Option.getOrElse(() => SaveChoice.make({ findingId, action: 'create', targetId: '' }))))
export const savedFindingIds = (snapshot: RunSnapshot): ReadonlyArray<string> => A.flatMap(snapshot.receipts, receipt => A.map(receipt.records, record => record.findingId))
export const validateCapture = (input: CaptureInput): string => {
  if (!input.desktop && !input.mobile) return 'Choose at least one screenshot viewport.'
  if (!Number.isInteger(input.depth) || input.depth < 1 || input.depth > 3) return 'Choose a crawl depth from 1 to 3.'
  if (!Number.isInteger(input.maxPages) || input.maxPages < 1 || input.maxPages > 50) return 'Choose a page limit from 1 to 50.'
  const urls = input.mode === 'batch' ? A.filter(A.map(input.source.split('\n'), value => value.trim()), value => value !== '') : [input.source.trim()]
  if (urls.length === 0 || urls.length > 50) return 'Provide between 1 and 50 public website URLs.'
  for (const value of urls) {
    try { const url = new URL(value); if (!['https:', 'http:'].includes(url.protocol)) return 'Use public HTTP or HTTPS website URLs.' } catch { return 'Enter a complete website URL, including https://.' }
  }
  return ''
}
const acceptSnapshot = (model: Model, snapshot: RunSnapshot): Model => {
  const previous = snapshotOf(model)
  if (snapshot.run.id !== model.runId || snapshot.run.projectId !== model.projectId) return model
  if (previous !== undefined && previous.run.id === snapshot.run.id && previous.run.revision > snapshot.run.revision) return model
  const eligible = eligiblePageIds(snapshot)
  const initializeSelection = previous === undefined || (previous.run.phase !== 'captured' && snapshot.run.phase === 'captured')
  return evo(model, {
    snapshot: () => SnapshotData.Success({ data: snapshot }),
    pageId: current => A.some(snapshot.pages, page => page.id === current) ? current : snapshot.pages[0]?.id ?? '',
    analysisIds: ids => initializeSelection ? eligible : A.filter(ids, id => A.contains(eligible, id)),
    findingIds: ids => A.filter(ids, id => A.some(snapshot.findings, finding => finding.id === id) && !A.contains(savedFindingIds(snapshot), id)),
  })
}
const changeContext = (model: Model, key: 'api' | 'project' | 'run', value: string): UpdateReturn => {
  const nextValue = key === 'api' ? value.replace(/\/$/, '') : key === 'project' ? value || 'default' : value
  if ((key === 'api' ? model.apiUrl : key === 'project' ? model.projectId : model.runId) === nextValue) return { model }
  const next = evo(model, {
    generation: value => value + 1, apiUrl: current => key === 'api' ? nextValue : current,
    projectId: current => key === 'project' ? nextValue : current, runId: current => key === 'run' ? nextValue : key === 'project' || key === 'api' ? '' : current,
    snapshot: () => AsyncData.Idle(), preview: () => AsyncData.Idle(), exported: () => AsyncData.Idle(), mutation: () => Ready(),
    pageId: () => '', analysisIds: () => [], findingIds: () => [], choices: () => [], notice: () => '', deleteConfirmation: () => false,
    workspace: data => key === 'api' ? AsyncData.Idle() : data, history: () => AsyncData.Idle(), library: () => AsyncData.Idle(),
    session: data => key === 'api' ? AsyncData.Loading() : data,
    settings: data => key === 'api' ? AsyncData.Idle() : data, settingsOpen: () => false, settingsEditor: () => null, settingsEpoch: value => value + 1,
  })
  if (key === 'api') return { model: next, commands: [LoadSession({ generation: next.generation, apiUrl: next.apiUrl, method: 'GET', token: '' })] }
  if (!authenticated(next)) return { model: next }
  const refreshed = refresh(next)
  const project = key === 'project' ? workspaceOf(model)?.projects.find(project => project.id === next.projectId) : undefined
  return project === undefined ? refreshed : { model: refreshed.model, commands: [...(refreshed.commands ?? []), ReportProject({ project })] }
}
const submit = (model: Model, request: Request): UpdateReturn => {
  if (isBusy(model) || unresolvedSettingsSave(model) || !authenticated(model)) return { model }
  const sequence = model.sequence + 1
  const commandId = `${model.instanceId}:${sequence}`
  return {
    model: evo(model, { sequence: () => sequence, mutation: () => Sending({ commandId, request }), notice: () => '' }),
    commands: [SubmitRequest({ generation: model.generation, apiUrl: model.apiUrl, commandId, request })],
  }
}
const runScope = (model: Model) => ({ projectId: model.projectId, runId: model.runId, expectedRevision: snapshotOf(model)?.run.revision ?? 0 })
const selectionChanged = (model: Model): Model => evo(model, { selectionRevision: revision => revision + 1, preview: () => AsyncData.Idle(), notice: () => '' })

export const settingsDraft = (values: AnalysisSettingsValues): SettingsDraft => ({
  modelId: values.modelId, maxOutputTokens: String(values.maxOutputTokens), reasoning: values.reasoning ?? 'provider-default',
  thinkingBudgetTokens: values.thinkingBudgetTokens === null ? '' : String(values.thinkingBudgetTokens),
  temperature: values.temperature === null ? '' : String(values.temperature), requestTimeoutMs: String(values.requestTimeoutMs),
  cacheRetention: values.cacheRetention, maxDomChars: String(values.maxDomChars), screenshotEvidence: values.screenshotEvidence,
  extraInstructions: values.extraInstructions, runLimitUsd: values.runLimitUsd === null ? '' : String(values.runLimitUsd),
  monthlyLimitUsd: values.monthlyLimitUsd === null ? '' : String(values.monthlyLimitUsd),
  attemptReservationUsd: values.attemptReservationUsd === null ? '' : String(values.attemptReservationUsd),
})
export const settingsValues = (draft: SettingsDraft): AnalysisSettingsValues | undefined => {
  const nullableNumber = (value: string) => value.trim() === '' ? null : Number(value)
  const candidate = { ...draft, reasoning: draft.reasoning === 'provider-default' ? null : draft.reasoning,
    maxOutputTokens: draft.maxOutputTokens.trim() === '' ? NaN : Number(draft.maxOutputTokens),
    requestTimeoutMs: draft.requestTimeoutMs.trim() === '' ? NaN : Number(draft.requestTimeoutMs),
    maxDomChars: draft.maxDomChars.trim() === '' ? NaN : Number(draft.maxDomChars),
    thinkingBudgetTokens: nullableNumber(draft.thinkingBudgetTokens), temperature: nullableNumber(draft.temperature),
    runLimitUsd: nullableNumber(draft.runLimitUsd), monthlyLimitUsd: nullableNumber(draft.monthlyLimitUsd), attemptReservationUsd: nullableNumber(draft.attemptReservationUsd),
  }
  return S.is(AnalysisSettingsValues)(candidate) ? candidate : undefined
}
export const settingsDirty = (model: Model): boolean => model.settingsEditor !== null && JSON.stringify(model.settingsEditor.draft) !== JSON.stringify(settingsDraft(model.settingsEditor.base.values))
const editorFrom = (snapshot: SettingsSnapshot, draftRevision = 0): typeof SettingsEditor.Type => ({ base: snapshot.settings, draft: settingsDraft(snapshot.settings.values), draftRevision, preview: AsyncData.Idle(), notice: '' })
const settingsConflict = (model: Model) => model.settingsEditor !== null && (settingsOf(model)?.settings.revision ?? model.settingsEditor.base.revision) !== model.settingsEditor.base.revision
const retainNewerSettings = (held: SettingsSnapshot | undefined, snapshot: SettingsSnapshot): SettingsSnapshot => held === undefined ? snapshot : ({
  ...snapshot,
  settings: held.settings.revision > snapshot.settings.revision ? held.settings : snapshot.settings,
  catalog: held.catalog.revision > snapshot.catalog.revision ? held.catalog : snapshot.catalog,
  models: held.catalog.revision > snapshot.catalog.revision ? held.models : snapshot.models,
})
const selectedModel = (model: Model) => settingsOf(model)?.models.find(item => item.id === model.settingsEditor?.draft.modelId)
const canReviewSettings = (model: Model) => settingsOf(model)?.catalog.status === 'fresh' && selectedModel(model)?.selectable === true && model.settings._tag !== 'Loading' && model.settings._tag !== 'Refreshing'
const changedSetting = (model: Model, key: keyof SettingsDraft, value: string): UpdateReturn => {
  const editor = model.settingsEditor
  if (editor === null || isBusy(model) || model.mutation._tag === 'Refused' && model.mutation.request._tag === 'SettingsRequest' && model.mutation.retryable) return { model }
  if (key === 'modelId' && !settingsOf(model)?.models.some(item => item.id === value && item.selectable)) return { model }
  let draft = { ...editor.draft, [key]: value }
  const capability = settingsOf(model)?.models.find(item => item.id === draft.modelId)
  const adjustments: string[] = []
  if (capability !== undefined && (key === 'modelId' || key === 'reasoning')) {
    if (draft.reasoning !== 'provider-default' && !capability.reasoningLevels.some(level => level === draft.reasoning)) {
      draft.reasoning = 'provider-default'; adjustments.push('Reasoning uses the new model’s default.')
    }
    const effectiveReasoning = draft.reasoning === 'provider-default' ? capability.defaultReasoning : draft.reasoning
    if ((!capability.supportsTemperature || effectiveReasoning !== 'off') && draft.temperature !== '') {
      draft.temperature = ''; adjustments.push('Temperature returned to the provider default because it is incompatible with this reasoning mode.')
    }
    if (draft.thinkingBudgetTokens !== '' && (capability.thinkingMode !== 'budget' || effectiveReasoning === 'off' || Number(draft.thinkingBudgetTokens) > capability.effectiveMaxOutputTokens - 1024)) {
      draft.thinkingBudgetTokens = ''; adjustments.push('Custom thinking tokens returned to the model default.')
    }
    if (!capability.cacheRetentions.some(retention => retention === draft.cacheRetention)) {
      draft.cacheRetention = capability.cacheRetentions[0] ?? 'none'; adjustments.push('Cache retention changed to an available option.')
    }
    if (Number(draft.maxOutputTokens) > capability.effectiveMaxOutputTokens) {
      draft.maxOutputTokens = String(capability.effectiveMaxOutputTokens); adjustments.push('Output tokens were reduced to this model’s maximum.')
    }
  }
  return { model: evo(model, { settingsEditor: () => evo(editor, { draft: () => draft, draftRevision: value => value + 1, preview: () => AsyncData.Idle(), notice: () => adjustments.join(' ') }) }) }
}
export const update = (model: Model, message: Message): UpdateReturn => {
  // Every service/session reply belongs to exactly one context. Unmount disposes
  // this UI runtime only; it has no command that cancels a durable service task.
  if ('generation' in message && message.generation !== model.generation) return { model }
  if ('settingsEpoch' in message && message.settingsEpoch !== model.settingsEpoch) return { model }
  return M.value(message).pipe(M.withReturnType<UpdateReturn>(), M.tagsExhaustive({
    RequestedSettings: () => {
      if (!authenticated(model) || model.settingsOpen && (model.settingsEditor !== null || model.settings._tag === 'Loading')) return { model }
      const snapshot = settingsOf(model)
      const next = evo(model, { settingsOpen: () => true, settingsEpoch: value => value + 1, settings: pending, settingsEditor: editor => model.settingsOpen ? editor : snapshot === undefined ? null : editorFrom(snapshot) })
      return { model: next, commands: [settingsCommand(next)] }
    },
    RequestedModelRefresh: () => {
      if (!authenticated(model) || !model.settingsOpen || isBusy(model) || unresolvedSettingsSave(model) || model.settings._tag === 'Loading' || model.settings._tag === 'Refreshing') return { model }
      const next = evo(model, { settingsEpoch: value => value + 1, settings: pending, settingsEditor: editor => editor === null ? null : evo(editor, { draftRevision: value => value + 1, preview: () => AsyncData.Idle(), notice: () => '' }) })
      return { model: next, commands: [RefreshModels({ generation: next.generation, settingsEpoch: next.settingsEpoch, apiUrl: next.apiUrl })] }
    },
    ClosedSettings: () => isBusy(model) || model.mutation._tag === 'Refused' && model.mutation.request._tag === 'SettingsRequest' && model.mutation.retryable ? { model } : { model: evo(model, { settingsOpen: () => false, settingsEpoch: value => value + 1, settingsEditor: () => null }) },
    RevertedSettings: () => {
      const editor = model.settingsEditor
      return editor === null || isBusy(model) || unresolvedSettingsSave(model) ? { model } : { model: evo(model, { settingsEditor: () => evo(editor, { draft: () => settingsDraft(editor.base.values), draftRevision: value => value + 1, preview: () => AsyncData.Idle(), notice: () => '' }) }) }
    },
    ReloadedSettings: () => {
      const snapshot = settingsOf(model)
      if (snapshot === undefined || isBusy(model) || unresolvedSettingsSave(model)) return { model }
      const next = evo(model, { settingsEpoch: value => value + 1, settingsEditor: () => editorFrom(snapshot, (model.settingsEditor?.draftRevision ?? 0) + 1), settings: pending, mutation: mutation => mutation._tag === 'Refused' && mutation.request._tag === 'SettingsRequest' ? Ready() : mutation, notice: () => '' })
      return { model: next, commands: [settingsCommand(next)] }
    },
    ChangedSetting: ({ key, value }) => changedSetting(model, key, value),
    SucceededSettings: ({ snapshot }) => {
      if (!model.settingsOpen) return { model }
      const held = settingsOf(model)
      // Settings and catalog revisions advance independently. Late reads may
      // update one without rolling the other back.
      const accepted = retainNewerSettings(held, snapshot)
      const catalogChanged = held !== undefined && (held.catalog.revision !== accepted.catalog.revision || held.catalog.status !== accepted.catalog.status || held.catalog.source !== accepted.catalog.source)
      return { model: evo(model, { settings: () => SettingsData.Success({ data: accepted }), settingsEditor: editor => {
        if (editor === null || !settingsDirty(model) && editor.base.revision !== accepted.settings.revision) return editorFrom(accepted, (editor?.draftRevision ?? -1) + 1)
        return catalogChanged ? evo(editor, { draftRevision: value => value + 1, preview: () => AsyncData.Idle(), notice: () => 'Model information changed. Your draft is unchanged; review the available options and preview again before saving.' }) : editor
      } }) }
    },
    FailedSettings: ({ error, unauthorized }) => unauthorized ? signedOut(model, 'Your owner session has ended. Sign in again to reconnect.') : { model: evo(model, { settings: data => failed(data, error) }) },
    RequestedSettingsPreview: () => {
      const editor = model.settingsEditor
      if (editor === null || isBusy(model) || unresolvedSettingsSave(model) || !canReviewSettings(model)) return { model }
      const values = settingsValues(editor.draft)
      if (values === undefined) return { model: evo(model, { settingsEditor: () => evo(editor, { preview: () => EvaluationData.Failure({ error: 'Enter valid numbers for output tokens, timeout, evidence and spending limits.' }) }) }) }
      return { model: evo(model, { settingsEditor: () => evo(editor, { preview: () => AsyncData.Loading(), notice: () => '' }) }), commands: [PreviewSettings({ generation: model.generation, settingsEpoch: model.settingsEpoch, apiUrl: model.apiUrl, draftRevision: editor.draftRevision, values })] }
    },
    SucceededSettingsPreview: ({ draftRevision, evaluation }) => {
      if (model.settingsEditor === null || model.settingsEditor.draftRevision !== draftRevision) return { model }
      if (evaluation.catalogRevision !== undefined && evaluation.catalogRevision !== settingsOf(model)?.catalog.revision) {
        const next = evo(model, { settings: pending, settingsEditor: editor => editor === null ? null : evo(editor, { draftRevision: value => value + 1, preview: () => AsyncData.Idle(), notice: () => 'Model information changed while preparing this preview. Review the updated options and preview again.' }) })
        return { model: next, commands: [settingsCommand(next)] }
      }
      return { model: evo(model, { settingsEditor: editor => editor === null ? null : evo(editor, { preview: () => EvaluationData.Success({ data: evaluation }) }) }) }
    },
    FailedSettingsPreview: ({ draftRevision, error, unauthorized }) => unauthorized ? signedOut(model, 'Your owner session has ended. Sign in again to reconnect.') : model.settingsEditor === null || model.settingsEditor.draftRevision !== draftRevision ? { model } : { model: evo(model, { settingsEditor: editor => editor === null ? null : evo(editor, { preview: () => EvaluationData.Failure({ error }) }) }) },
    RequestedSettingsSave: () => {
      const editor = model.settingsEditor
      if (editor === null || editor.preview._tag !== 'Success' || !canReviewSettings(model) || settingsConflict(model) || model.mutation._tag === 'Refused' && model.mutation.request._tag === 'SettingsRequest' && model.mutation.retryable) return { model }
      const values = settingsValues(editor.draft)
      return values === undefined ? { model } : submit(model, SettingsRequest({ expectedRevision: editor.base.revision, values }))
    },
    SucceededMutationSettings: ({ snapshot }) => {
      const accepted = retainNewerSettings(settingsOf(model), snapshot)
      const next = evo(model, { generation: value => value + 1, settings: () => SettingsData.Success({ data: accepted }), settingsEditor: () => editorFrom(accepted, (model.settingsEditor?.draftRevision ?? 0) + 1), preview: data => data._tag === 'Loading' ? AsyncData.Idle() : data, exported: data => data._tag === 'Loading' ? AsyncData.Idle() : data, mutation: () => Ready(), notice: () => accepted.settings.revision > snapshot.settings.revision ? 'Your settings save was confirmed. A newer saved version is now shown.' : 'Agent settings saved. They apply to the next analysis you start or explicitly retry.' })
      return refresh(next)
    },
    Ticked: () => authenticated(model) && !isBusy(model) && model.workspace._tag !== 'Refreshing' && model.workspace._tag !== 'Loading' && model.snapshot._tag !== 'Refreshing' && model.snapshot._tag !== 'Loading' ? refresh(model) : { model },
    RequestedRefresh: () => authenticated(model) ? refresh(model) : { model: evo(model, { session: pending }), commands: [LoadSession({ generation: model.generation, apiUrl: model.apiUrl, method: 'GET', token: '' })] },
    ChangedContext: ({ key, value }) => changeContext(model, key, value),
    ChangedField: ({ key, value }) => {
      if (key === 'ownerToken') return { model: evo(model, { ownerToken: () => value }) }
      if (key === 'projectName') return { model: evo(model, { projectName: () => value }) }
      const candidate = { ...model.input, [key]: key === 'depth' || key === 'maxPages' ? Number(value) : value }
      return S.is(CaptureInput)(candidate) ? { model: evo(model, { input: () => candidate }) } : { model }
    },
    ToggledViewport: ({ viewport }) => ({ model: evo(model, { input: input => viewport === 'desktop' ? evo(input, { desktop: value => !value }) : evo(input, { mobile: value => !value }) }) }),
    RequestedLogin: () => {
      const generation = model.generation + 1
      return { model: evo(model, { generation: () => generation, session: () => AsyncData.Loading(), ownerToken: () => '', notice: () => '' }), commands: [LoadSession({ generation, apiUrl: model.apiUrl, method: 'POST', token: model.ownerToken })] }
    },
    RequestedLogout: () => {
      const next = signedOut(model, '').model
      return { model: evo(next, { session: () => AsyncData.Loading() }), commands: [LoadSession({ generation: next.generation, apiUrl: next.apiUrl, method: 'DELETE', token: '' })] }
    },
    SucceededSession: ({ session }) => {
      if (!session.authenticated) return signedOut(model, '')
      const next = evo(model, { session: () => SessionData.Success({ data: session }) })
      return refresh(next)
    },
    FailedSession: ({ error }) => ({ model: evo(model, { session: () => SessionData.Failure({ error }), notice: () => error }) }),
    SucceededWorkspace: ({ workspace, history, library }) => {
      if (sessionOf(model)?.sessionId !== workspace.sessionId) {
        const next = evo(model, { generation: value => value + 1, session: () => SessionData.Success({ data: { authenticated: true, sessionId: workspace.sessionId } }), settings: () => AsyncData.Idle(), settingsOpen: () => false, settingsEditor: () => null, settingsEpoch: value => value + 1, workspace: () => AsyncData.Idle(), history: () => AsyncData.Idle(), library: () => AsyncData.Idle(), exported: () => AsyncData.Idle(), snapshot: () => AsyncData.Idle(), preview: () => AsyncData.Idle(), mutation: () => Ready(), analysisIds: () => [], findingIds: () => [], choices: () => [] })
        return refresh(next)
      }
      return { model: evo(model, { workspace: () => WorkspaceData.Success({ data: workspace }), history: () => HistoryData.Success({ data: history }), library: () => LibraryData.Success({ data: library }) }) }
    },
    FailedWorkspace: ({ error, unauthorized }) => unauthorized ? signedOut(model, 'Your owner session has ended. Sign in again to reconnect.') : { model: evo(model, { workspace: value => failed(value, error), history: value => failed(value, error), library: value => failed(value, error) }) },
    SucceededSnapshot: ({ snapshot }) => {
      const next = acceptSnapshot(model, snapshot)
      return snapshotOf(model) === undefined && snapshotOf(next) !== undefined
        ? { model: next, commands: [ReportRun({ run: snapshot.run })] }
        : { model: next }
    },
    FailedSnapshot: ({ error, unauthorized }) => unauthorized ? signedOut(model, 'Your owner session has ended. Sign in again to reconnect.') : { model: evo(model, { snapshot: value => failed(value, error) }) },
    RequestedCapture: () => {
      const error = validateCapture(model.input)
      if (error !== '') return { model: evo(model, { notice: () => error }) }
      if (workspaceOf(model)?.activeRunId) return { model: evo(model, { notice: () => 'A run is already active. Open it from history before starting another.' }) }
      return submit(model, CaptureRequest({ projectId: model.projectId, input: model.input }))
    },
    RequestedAnalysis: () => {
      const snapshot = snapshotOf(model)
      if (snapshot === undefined || snapshot.run.phase !== 'captured') return { model }
      const pageIds = A.filter(model.analysisIds, id => A.contains(eligiblePageIds(snapshot), id))
      return pageIds.length === 0 ? { model: evo(model, { notice: () => 'Select at least one captured page to analyze.' }) } : submit(model, AnalyzeRequest({ ...runScope(model), pageIds }))
    },
    RequestedRetryRun: () => ['requires_retry', 'failed'].includes(snapshotOf(model)?.run.phase ?? '') ? submit(model, RetryRunRequest(runScope(model))) : { model },
    RequestedRetryCommand: () => {
      const mutation = model.mutation
      if (mutation._tag !== 'Refused' || !mutation.retryable) return { model }
      return { model: evo(model, { mutation: () => Sending({ commandId: mutation.commandId, request: mutation.request }), notice: () => '' }), commands: [SubmitRequest({ generation: model.generation, apiUrl: model.apiUrl, commandId: mutation.commandId, request: mutation.request })] }
    },
    RequestedProject: () => model.projectName.trim() === '' ? { model: evo(model, { notice: () => 'Give the project a name.' }) } : submit(model, ProjectRequest({ name: model.projectName.trim() })),
    RequestedNewRun: () => changeContext(model, 'run', ''),
    SelectedPage: ({ pageId }) => ({ model: evo(model, { pageId: () => pageId }) }),
    SelectedViewport: ({ viewport }) => ({ model: evo(model, { viewport: () => viewport }) }),
    ToggledAnalysisPage: ({ pageId }) => {
      const snapshot = snapshotOf(model)
      return snapshot !== undefined && snapshot.run.phase === 'captured' && A.contains(eligiblePageIds(snapshot), pageId) ? { model: evo(model, { analysisIds: ids => toggle(ids, pageId) }) } : { model }
    },
    SelectedAllPages: ({ selected }) => {
      const snapshot = snapshotOf(model)
      return snapshot !== undefined && snapshot.run.phase === 'captured' ? { model: evo(model, { analysisIds: () => selected ? eligiblePageIds(snapshot) : [] }) } : { model }
    },
    SelectedFindingTab: ({ tab }) => ({ model: evo(model, { findingTab: () => tab }) }),
    ToggledFinding: ({ findingId }) => {
      const snapshot = snapshotOf(model)
      if (isBusy(model) || snapshot === undefined || A.contains(savedFindingIds(snapshot), findingId)) return { model }
      return { model: selectionChanged(evo(model, { findingIds: ids => toggle(ids, findingId) })) }
    },
    ChoseDuplicate: ({ findingId, action }) => {
      const finding = snapshotOf(model)?.findings.find(item => item.id === findingId)
      if (finding === undefined || isBusy(model) || action === 'merge' && finding.existingId === '') return { model }
      return { model: selectionChanged(evo(model, { choices: choices => A.append(A.filter(choices, choice => choice.findingId !== findingId), { findingId, action, targetId: action === 'merge' ? finding.existingId : '' }) })) }
    },
    ClearedFindings: () => isBusy(model) ? { model } : { model: selectionChanged(evo(model, { findingIds: () => [] })) },
    RequestedPreview: () => model.findingIds.length === 0 || isBusy(model) ? { model } : {
      model: evo(model, { preview: () => AsyncData.Loading(), notice: () => '' }),
      commands: [LoadPreview({ generation: model.generation, apiUrl: model.apiUrl, ...runScope(model), selectionRevision: model.selectionRevision, choices: saveChoices(model) })],
    },
    SucceededPreview: ({ selectionRevision, preview }) => selectionRevision !== model.selectionRevision ? { model } : { model: evo(model, { preview: () => PreviewData.Success({ data: preview }) }) },
    FailedPreview: ({ selectionRevision, error }) => selectionRevision !== model.selectionRevision ? { model } : { model: evo(model, { preview: () => PreviewData.Failure({ error }) }) },
    RequestedSave: () => {
      const preview = previewOf(model)
      return preview === undefined ? { model } : submit(model, SaveRequest({ projectId: model.projectId, runId: model.runId, expectedRevision: preview.revision, expectedProjectRevision: preview.projectRevision, choices: saveChoices(model) }))
    },
    SucceededMutationRun: ({ snapshot }) => {
      const next = evo(model, { generation: value => value + 1, runId: () => snapshot.run.id, mutation: () => Ready(), notice: () => '', snapshot: current => snapshot.run.id === model.runId ? current : AsyncData.Idle(), preview: () => AsyncData.Idle() })
      const accepted = acceptSnapshot(next, snapshot)
      return { model: accepted, commands: [workspaceCommand(accepted), ReportRun({ run: snapshot.run })] }
    },
    SucceededMutationProject: ({ project }) => {
      const result = changeContext(evo(model, { mutation: () => Ready(), projectName: () => '' }), 'project', project.id)
      return { model: result.model, commands: [...(result.commands ?? []), ReportProject({ project })] }
    },
    SucceededMutationSave: ({ receipt }) => {
      const next = evo(model, { generation: value => value + 1, mutation: () => Ready(), findingIds: () => [], choices: () => [], preview: () => AsyncData.Idle(), notice: () => `Saved ${receipt.records.length} reviewed finding${receipt.records.length === 1 ? '' : 's'} to your project.` })
      const result = refresh(next)
      return { model: result.model, commands: [...(result.commands ?? []), ReportSaved({ receipt })] }
    },
    SucceededMutationDelete: () => changeContext(evo(model, { mutation: () => Ready(), deleteConfirmation: () => false }), 'run', ''),
    FailedMutation: ({ error, retryable, unauthorized }) => {
      if (unauthorized) return signedOut(model, 'Your owner session has ended. Sign in again to reconnect.')
      const mutation = model.mutation
      return mutation._tag !== 'Sending' ? { model } : { model: evo(model, { mutation: () => Refused({ request: mutation.request, commandId: mutation.commandId, error, retryable }), notice: () => error }), commands: mutation.request._tag === 'SettingsRequest' ? [settingsCommand(model)] : [] }
    },
    RequestedExport: () => ({ model: evo(model, { exported: () => AsyncData.Loading() }), commands: [LoadExport({ generation: model.generation, apiUrl: model.apiUrl, projectId: model.projectId })] }),
    SucceededExport: ({ exported }) => ({ model: evo(model, { exported: () => ExportData.Success({ data: exported }) }) }),
    FailedExport: ({ error }) => ({ model: evo(model, { exported: () => ExportData.Failure({ error }) }) }),
    ToggledLibrary: () => ({ model: evo(model, { showLibrary: value => !value }) }),
    RequestedDelete: () => ({ model: evo(model, { deleteConfirmation: () => true }) }),
    CancelledDelete: () => ({ model: evo(model, { deleteConfirmation: () => false }) }),
    ConfirmedDelete: () => model.deleteConfirmation ? submit(model, DeleteRequest(runScope(model))) : { model },
    RequestedCopy: ({ text }) => ({ model, commands: [CopyText({ generation: model.generation, text })] }),
    CompletedCopy: ({ error }) => ({ model: evo(model, { notice: () => error === '' ? 'CMS name copied.' : error }) }),
    CompletedReport: () => ({ model }),
  }))
}
export const subscriptions = Subscription.make<Model, Message>()(() => ({
  poll: Subscription.persistent(Stream.tick(Duration.seconds(2)).pipe(Stream.map(Ticked))),
  api: Port.subscription(ports.inbound.apiChanged, value => ChangedContext({ key: 'api', value })),
  project: Port.subscription(ports.inbound.projectChanged, value => ChangedContext({ key: 'project', value })),
  run: Port.subscription(ports.inbound.runChanged, value => ChangedContext({ key: 'run', value })),
}))

const dollars = (value: number) => `$${value.toFixed(4)}`
const displayDate = (value: string) => new Date(value).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
const privateAssetUrl = (model: Model, path: string) => path.startsWith('/') ? `${model.apiUrl}${path}` : path
const statusLabel = (phase: string) => ({ queued: 'Queued', capturing: 'Capturing pages', captured: 'Ready for review', analyzing: 'Analyzing selected pages', completed: 'Analysis complete', requires_retry: 'Needs explicit retry', failed: 'Run failed', analyzed: 'Analyzed' })[phase] ?? phase
const button = (label: string, message: Message, disabled: boolean, tone: 'primary' | 'secondary' | 'quiet' | 'danger', h: HtmlBuilder<Message>): Html =>
  h.button([h.Type('button'), h.Class(`discovery-button discovery-button--${tone}`), h.Disabled(disabled), h.OnClick(message)], [label])
const field = (label: string, key: typeof ChangedField.Type['key'], value: string, type: string, h: HtmlBuilder<Message>): Html =>
  h.label([h.Class('discovery-field')], [h.span([h.Class('discovery-label')], [label]), h.input([h.Class('discovery-input'), h.Type(type), h.Value(value), h.OnInput(value => ChangedField({ key, value })), h.Attribute('autocomplete', key === 'ownerToken' ? 'current-password' : 'off')])])
const select = (label: string, key: typeof ChangedField.Type['key'], value: string, options: ReadonlyArray<{ value: string; label: string }>, h: HtmlBuilder<Message>): Html =>
  h.label([h.Class('discovery-field')], [h.span([h.Class('discovery-label')], [label]), h.select([h.Class('discovery-input'), h.Value(value), h.OnInput(value => ChangedField({ key, value }))], A.map(options, option => h.keyed('option')(option.value, [h.Value(option.value), h.Selected(option.value === value)], [option.label])))])
const empty = (title: string, text: string, h: HtmlBuilder<Message>): Html => h.div([h.Class('discovery-empty')], [h.h3([], [title]), h.p([], [text])])
const badge = (text: string, tone: 'neutral' | 'accent' | 'warning' | 'success', h: HtmlBuilder<Message>): Html => h.span([h.Class(`discovery-badge discovery-badge--${tone}`)], [text])
const asyncError = <T>(value: AsyncData.AsyncData<T, string>): string => value._tag === 'Failure' || value._tag === 'Stale' ? value.error : ''
const errorBanner = (text: string, h: HtmlBuilder<Message>): Html => text === '' ? h.empty : h.div([h.Class('discovery-alert discovery-alert--error'), h.Attribute('role', 'alert')], [text])
const settingField = (label: string, key: keyof SettingsDraft, value: string, help: string, disabled: boolean, h: HtmlBuilder<Message>, bounds?: { min: number; max: number; step?: number }): Html =>
  h.label([h.Class('discovery-field')], [
    h.span([h.Class('discovery-label')], [label]),
    h.input([h.Class('discovery-input'), h.Type('number'), h.Value(value), h.Disabled(disabled), h.OnInput(value => ChangedSetting({ key, value })), h.Attribute('autocomplete', 'off'), h.Attribute('step', String(bounds?.step ?? 1)), ...(bounds === undefined ? [] : [h.Attribute('min', String(bounds.min)), h.Attribute('max', String(bounds.max))])]),
    h.span([h.Class('discovery-help')], [help]),
  ])
const settingSelect = (label: string, key: keyof SettingsDraft, value: string, options: ReadonlyArray<{ value: string; label: string; disabled?: boolean }>, help: string, disabled: boolean, h: HtmlBuilder<Message>): Html =>
  h.label([h.Class('discovery-field')], [
    h.span([h.Class('discovery-label')], [label]),
    h.select([h.Class('discovery-input'), h.Value(value), h.Disabled(disabled), h.OnInput(value => ChangedSetting({ key, value }))], A.map(options, option => h.keyed('option')(option.value, [h.Value(option.value), h.Selected(option.value === value), h.Disabled(option.disabled === true)], [option.label]))),
    help === '' ? h.empty : h.span([h.Class('discovery-help')], [help]),
  ])
const reasoningLabel = (value: string) => value === 'off' ? 'Off' : value === 'xhigh' ? 'Extra high' : value.charAt(0).toUpperCase() + value.slice(1)
const modelDetails = (capability: AnalysisModel, h: HtmlBuilder<Message>): Html => h.details([h.Class('discovery-model-details')], [
  h.summary([], ['Model limits & availability']),
  h.div([h.Class('discovery-model-detail-body')], [
    h.p([], [capability.selectable ? `Usable limits: ${capability.effectiveContextWindow.toLocaleString()} input tokens · ${capability.effectiveMaxOutputTokens.toLocaleString()} output tokens.` : capability.disabledReason]),
    h.p([], [`Capabilities: ${capability.capabilitySource === 'anthropic-api' ? 'Anthropic Models API' : capability.capabilitySource === 'anthropic-api+pi-ai-1.0.3' ? 'Anthropic Models API with installed adapter fallback for missing details' : capability.capabilitySource === 'pi-ai-1.0.3' ? 'Installed model adapter; API capability details were not supplied' : 'Unavailable'}. Image evidence: ${capability.supportsImages ? 'supported' : 'not supported'}.`]),
    h.p([], [capability.pricingSource === 'pi-ai-1.0.3' ? 'Cost estimates use bundled pricing (Pi AI 1.0.3).' : 'Cost estimates are unavailable for this model. The service needs compatible adapter support and pricing before analysis can use it.']),
    h.p([], [`Availability: ${capability.lifecycle === 'unknown' ? 'Not supplied by the API' : reasoningLabel(capability.lifecycle)}${capability.deprecatedAt === null ? '' : ` · deprecated ${displayDate(capability.deprecatedAt)}`}${capability.retiresAt === null ? '' : ` · retires ${displayDate(capability.retiresAt)}`}.`]),
    capability.createdAt === '' ? h.empty : h.p([], [`Released ${displayDate(capability.createdAt)}.`]),
  ]),
])
const catalogView = (model: Model, snapshot: SettingsSnapshot, locked: boolean, h: HtmlBuilder<Message>): Html => {
  const catalog = snapshot.catalog
  const pending = model.settings._tag === 'Loading' || model.settings._tag === 'Refreshing'
  const unavailable = snapshot.models.filter(item => !item.selectable)
  return h.section([h.Class('discovery-model-catalog'), h.Attribute('aria-label', 'Model catalog')], [
    h.div([h.Class('discovery-section-heading')], [
      h.div([], [h.h3([], [catalog.source === 'fixture' ? 'Fixture model catalog' : 'Anthropic model catalog']), h.p([h.Class('discovery-help')], [`${catalog.modelCount} models · cached for ${catalog.ttlSeconds / 3600} hours`])]),
      badge(catalog.status === 'fresh' ? 'Current cache' : catalog.status === 'stale' ? 'Expired cache' : 'Catalog unavailable', catalog.status === 'fresh' ? 'neutral' : 'warning', h),
    ]),
    catalog.source === 'fixture' ? h.p([h.Class('discovery-help')], ['Deterministic catalog for fixture verification. No Anthropic Models API request is made in this mode.']) : h.p([h.Class('discovery-help')], ['Model availability, names and reported limits are loaded from the Anthropic Models API by the service. App loading reuses the cache until it expires.']),
    h.div([h.Class('discovery-catalog-times')], [
      h.span([], [catalog.fetchedAt === null ? 'No catalog has been fetched.' : `Fetched ${displayDate(catalog.fetchedAt)}`]),
      catalog.expiresAt === null ? h.empty : h.span([], [`Expires ${displayDate(catalog.expiresAt)}`]),
    ]),
    catalog.status === 'fresh' ? h.empty : h.div([h.Class('discovery-alert discovery-alert--warning'), h.Attribute('role', 'alert')], [
      h.strong([], [catalog.status === 'stale' ? 'Showing an expired model list.' : 'Model information is unavailable.']),
      h.p([], ['New live analysis is blocked until a current catalog is available. Your saved settings and unsaved draft are preserved.']),
      catalog.error === '' ? h.empty : h.p([], [catalog.error]),
      catalog.nextRetryAt === null ? h.empty : h.p([], [`Automatic refresh can retry after ${displayDate(catalog.nextRetryAt)}. You can request another refresh now.`]),
    ]),
    catalog.status === 'fresh' && catalog.error !== '' ? h.div([h.Class('discovery-alert discovery-alert--warning'), h.Attribute('role', 'alert')], [h.strong([], ['The latest refresh failed.']), h.p([], ['The current cached model list remains valid until its expiry.']), h.p([], [catalog.error])]) : h.empty,
    h.div([h.Class('discovery-catalog-actions')], [h.p([h.Class('discovery-help')], ['Refresh checks model information only. It does not run analysis or change your settings.']), button(pending ? 'Checking model catalog…' : 'Refresh model catalog', RequestedModelRefresh(), locked || pending, 'secondary', h)]),
    snapshot.models.length === 0 ? h.p([h.Class('discovery-help')], [catalog.status === 'fresh' ? 'The API returned no available models for this account. The list is empty; no substitute models have been added.' : 'There is no cached model list to display.']) : h.empty,
    unavailable.length === 0 ? h.empty : h.details([h.Class('discovery-unavailable-models')], [
      h.summary([], [`Unavailable models (${unavailable.length})`]),
      h.ul([], unavailable.map(item => h.keyed('li')(item.id, [], [h.strong([], [item.label]), h.p([], [item.disabledReason || 'This model is not supported by the current service.'])]))),
    ]),
  ])
}

const settingsView = (model: Model, h: HtmlBuilder<Message>): Html => {
  if (!model.settingsOpen) return h.empty
  const snapshot = settingsOf(model)
  const editor = model.settingsEditor
  const header = h.div([h.Class('discovery-section-heading')], [h.div([], [h.p([h.Class('discovery-kicker')], ['Your analysis preferences']), h.h2([h.Id('discovery-settings-title')], ['Agent settings'])]), badge(settingsDirty(model) ? 'Unsaved changes' : 'Saved settings', settingsDirty(model) ? 'warning' : 'neutral', h)])
  const unresolvedSave = model.mutation._tag === 'Refused' && model.mutation.request._tag === 'SettingsRequest' && model.mutation.retryable
  const locked = isBusy(model) || unresolvedSave
  if (snapshot === undefined || editor === null) return h.section([h.Class('discovery-card discovery-settings'), h.Attribute('aria-labelledby', 'discovery-settings-title')], [header, errorBanner(asyncError(model.settings), h), h.p([h.Attribute('role', 'status')], [model.settings._tag === 'Failure' ? 'Settings could not be loaded.' : 'Loading agent settings…']), h.div([h.Class('discovery-inline')], [button('Load settings again', RequestedSettings(), model.settings._tag === 'Loading', 'secondary', h), button('Cancel', ClosedSettings(), locked, 'quiet', h)])])
  const draft = editor.draft
  const capability: AnalysisModel | undefined = snapshot.models.find(item => item.id === draft.modelId)
  const reasoning = draft.reasoning === 'provider-default' ? capability?.defaultReasoning : draft.reasoning
  const temperatureAllowed = capability?.supportsTemperature === true && reasoning === 'off'
  const thinkingAllowed = capability?.thinkingMode === 'budget' && reasoning !== 'off'
  const evaluation = Option.getOrUndefined(AsyncData.getData(editor.preview))
  const conflict = settingsConflict(model)
  const tokenMax = capability?.effectiveMaxOutputTokens ?? 0
  const reviewAvailable = canReviewSettings(model)
  const unavailableReason = capability === undefined ? 'This selected model is absent from the current catalog. Your selection is preserved; choose an available model to continue.' : capability.selectable ? '' : capability.disabledReason || 'This model cannot be used for analysis with the current service.'
  const retainedCache = !capability?.cacheRetentions.some(value => value === draft.cacheRetention) ? [{ value: draft.cacheRetention, label: `${reasoningLabel(draft.cacheRetention)} (unavailable · retained draft)`, disabled: true }] : []
  const retainedReasoning = draft.reasoning !== 'provider-default' && !capability?.reasoningLevels.some(level => level === draft.reasoning) ? [{ value: draft.reasoning, label: `${reasoningLabel(draft.reasoning)} (unavailable · retained draft)`, disabled: true }] : []
  const options = (values: ReadonlyArray<string>) => values.map(value => ({ value, label: capability?.thinkingMode === 'budget' && value !== 'off' ? `${reasoningLabel(value)} · thinking budget preset` : reasoningLabel(value) }))
  return h.section([h.Class('discovery-card discovery-settings'), h.Attribute('aria-labelledby', 'discovery-settings-title')], [
    header,
    h.p([h.Class('discovery-muted')], ['These workspace-wide settings apply to the next analysis you start or explicitly retry. An analysis already running keeps its settings. Saving does not start analysis.']),
    errorBanner(asyncError(model.settings), h),
    catalogView(model, snapshot, locked, h),
    unavailableReason === '' ? h.empty : h.div([h.Class('discovery-alert discovery-alert--warning')], [unavailableReason]),
    conflict ? h.div([h.Class('discovery-alert discovery-alert--warning'), h.Attribute('role', 'alert')], [h.strong([], ['Saved settings changed in another session.']), h.p([], ['Your draft is still here. Reload saved settings to discard this draft and review the latest version before saving.']), button('Reload saved settings', ReloadedSettings(), locked, 'secondary', h)]) : h.empty,
    unresolvedSave ? h.div([h.Class('discovery-alert discovery-alert--warning')], ['The save response was interrupted. Retry the same request above to confirm whether these settings were saved.']) : h.empty,
    editor.notice === '' ? h.empty : h.div([h.Class('discovery-alert'), h.Attribute('role', 'status')], [editor.notice]),
    h.fieldset([h.Class('discovery-settings-group')], [
      h.legend([], ['Model & output']),
      h.div([h.Class('discovery-form-grid')], [
        settingSelect('Analysis model', 'modelId', draft.modelId, [...(capability === undefined ? [{ value: draft.modelId, label: `${draft.modelId} (unavailable · retained selection)`, disabled: true }] : []), ...snapshot.models.map(item => ({ value: item.id, label: item.selectable ? item.label : `${item.label} — unavailable`, disabled: !item.selectable }))], capability === undefined ? 'Choose an available model.' : `${capability.contextWindow === null ? 'Input limit not supplied' : `${capability.contextWindow.toLocaleString()} input tokens`} · ${capability.maxOutputTokens === null ? 'Output limit not supplied' : `${capability.maxOutputTokens.toLocaleString()} output tokens`}`, locked, h),
        settingField('Maximum output tokens', 'maxOutputTokens', draft.maxOutputTokens, capability?.thinkingMode === 'adaptive' ? 'Allow enough output for complete findings. Thinking shares this ceiling for this model.' : 'Allow enough output for complete findings. The preview includes any additional thinking tokens.', locked || capability?.selectable !== true, h, tokenMax > 0 ? { min: thinkingAllowed ? 1024 : 1, max: tokenMax } : undefined),
      ]),
      capability === undefined ? h.empty : modelDetails(capability, h),
    ]),
    h.details([h.Class('discovery-settings-advanced')], [
      h.summary([], ['Reasoning, evidence & advanced options']),
      h.div([h.Class('discovery-settings-advanced-body')], [
        h.fieldset([h.Class('discovery-settings-group')], [
          h.legend([], ['Reasoning & sampling']),
          h.div([h.Class('discovery-form-grid')], [
            settingSelect('Reasoning level', 'reasoning', draft.reasoning, [...retainedReasoning, { value: 'provider-default', label: capability?.defaultReasoning == null ? 'Provider default (unavailable)' : `Provider default (${reasoningLabel(capability.defaultReasoning)})` }, ...options(capability?.reasoningLevels ?? [])], capability?.thinkingMode === 'budget' ? 'These are thinking-token budget presets from the service adapter. The provider receives a token budget.' : capability?.capabilitySource === 'pi-ai-1.0.3' ? 'The API did not supply capability details. These levels come from the installed model adapter.' : capability?.capabilitySource === 'anthropic-api+pi-ai-1.0.3' ? 'Available levels use API details where supplied and installed adapter support for missing details.' : 'Effort levels supported by Anthropic and the installed model adapter.', locked || capability?.selectable !== true, h),
            settingField('Thinking token budget', 'thinkingBudgetTokens', draft.thinkingBudgetTokens, thinkingAllowed ? 'Optional. Leave blank for the default budget for this reasoning level.' : capability?.thinkingMode === 'adaptive' ? 'This model adjusts thinking automatically; a fixed token budget is unavailable.' : 'Turn on reasoning to set a thinking budget.', locked || !thinkingAllowed || capability?.selectable !== true, h, { min: 1024, max: Math.max(1024, tokenMax - 1024) }),
            settingField('Temperature', 'temperature', draft.temperature, temperatureAllowed ? 'Optional, 0–1. Leave blank for the provider default.' : 'Temperature is available only with a compatible model and reasoning off.', locked || !temperatureAllowed || capability?.selectable !== true, h, { min: 0, max: 1, step: .01 }),
            settingSelect('Cache retention', 'cacheRetention', draft.cacheRetention, [...retainedCache, ...(capability?.cacheRetentions ?? []).map(value => ({ value, label: value === 'none' ? 'None' : value === 'short' ? 'Short · 5 minutes' : 'Long · 1 hour' }))], 'Eligible Anthropic prompt content can be cached for the selected duration.', locked || capability?.selectable !== true, h),
          ]),
        ]),
        h.fieldset([h.Class('discovery-settings-group')], [
          h.legend([], ['Request & evidence']),
          h.div([h.Class('discovery-form-grid')], [
            settingField('Request timeout (milliseconds)', 'requestTimeoutMs', draft.requestTimeoutMs, '10–600 seconds (10,000–600,000 ms). An interrupted request may still complete at the provider and will require an explicit retry.', locked, h, { min: 10000, max: 600000, step: 1000 }),
            settingField('DOM character limit', 'maxDomChars', draft.maxDomChars, '0–200,000 characters of page content. Zero excludes DOM content.', locked, h, { min: 0, max: 200000 }),
            settingSelect('Screenshot evidence', 'screenshotEvidence', draft.screenshotEvidence, [{ value: 'both', label: 'Desktop and mobile' }, { value: 'desktop', label: 'Desktop only' }, { value: 'mobile', label: 'Mobile only' }, { value: 'none', label: 'No screenshots' }], 'Use available captures for the selected viewport. Keep screenshot or DOM evidence enabled.', locked, h),
          ]),
        ]),
        h.label([h.Class('discovery-field')], [
          h.span([h.Class('discovery-label')], ['Additional analysis instructions']),
          h.textarea([h.Class('discovery-input discovery-textarea'), h.Value(draft.extraInstructions), h.Disabled(locked), h.Attribute('rows', '4'), h.Attribute('maxlength', '8000'), h.OnInput(value => ChangedSetting({ key: 'extraInstructions', value }))]),
          h.span([h.Class('discovery-help')], [`${draft.extraInstructions.length.toLocaleString()} / 8,000 characters. Guide what to inspect; findings still follow the required structure and saving remains your decision.`]),
        ]),
      ]),
    ]),
    h.fieldset([h.Class('discovery-settings-group')], [
      h.legend([], ['Spending limits · USD']),
      h.p([h.Class('discovery-help')], ['All three limits are required for live analysis. Leaving a limit blank blocks live analysis. Spending limits are checked before each page request. Reservations are held for requests with an unknown outcome.']),
      h.div([h.Class('discovery-settings-budget-grid')], [
        settingField('Run spending limit (USD)', 'runLimitUsd', draft.runLimitUsd, 'Maximum spend and held reservations for one run.', locked, h, { min: .000001, max: 1000000, step: .01 }),
        settingField('Monthly spending limit (USD)', 'monthlyLimitUsd', draft.monthlyLimitUsd, 'Workspace-wide monthly maximum.', locked, h, { min: .000001, max: 1000000, step: .01 }),
        settingField('Attempt reservation (USD)', 'attemptReservationUsd', draft.attemptReservationUsd, 'Reserved before each page request. Review the minimum below.', locked, h, { min: .000001, max: 1000000, step: .01 }),
      ]),
    ]),
    errorBanner(asyncError(editor.preview), h),
    evaluation === undefined ? h.p([h.Class('discovery-help')], ['Preview settings to validate this draft and calculate the minimum reservation before saving.']) : h.div([h.Class('discovery-settings-evaluation'), h.Attribute('role', 'status')], [
      h.div([h.Class('discovery-section-heading')], [h.h3([], ['Settings preview']), badge(evaluation.analysisReady ? 'Live analysis ready' : 'Live analysis blocked', evaluation.analysisReady ? 'success' : 'warning', h)]),
      h.div([h.Class('discovery-usage-grid')], [
        h.div([], [h.span([], ['Minimum reservation / page']), h.strong([], [dollars(evaluation.minimumReservationUsd)])]),
        h.div([], [h.span([], ['Effective output ceiling']), h.strong([], [`${evaluation.effectiveMaxOutputTokens.toLocaleString()} tokens`])]),
        h.div([], [h.span([], ['Effective reasoning']), h.strong([], [reasoningLabel(evaluation.effectiveReasoning)])]),
        h.div([], [h.span([], ['Thinking budget']), h.strong([], [evaluation.effectiveThinkingBudgetTokens === null ? 'No fixed budget' : `${evaluation.effectiveThinkingBudgetTokens.toLocaleString()} tokens`])]),
      ]),
      evaluation.issues.length === 0 ? h.empty : h.div([h.Class('discovery-settings-issues')], [h.p([], ['You can save these settings. Resolve the following before live analysis:']), h.ul([], A.dedupe(evaluation.issues).map(issue => h.keyed('li')(issue, [], [issue])))]),
    ]),
    h.div([h.Class('discovery-settings-actions')], [
      h.p([h.Class('discovery-help')], [`Saved version ${editor.base.revision} · ${displayDate(editor.base.updatedAt)}`]),
      h.div([h.Class('discovery-inline')], [
        button('Cancel', ClosedSettings(), locked, 'quiet', h),
        button('Revert changes', RevertedSettings(), locked || !settingsDirty(model), 'quiet', h),
        button(editor.preview._tag === 'Loading' ? 'Previewing…' : 'Preview settings', RequestedSettingsPreview(), locked || !reviewAvailable || editor.preview._tag === 'Loading' || conflict, 'secondary', h),
        button(isBusy(model) && model.mutation._tag === 'Sending' && model.mutation.request._tag === 'SettingsRequest' ? 'Saving settings…' : 'Save settings', RequestedSettingsSave(), locked || !reviewAvailable || editor.preview._tag !== 'Success' || conflict || !settingsDirty(model), 'primary', h),
      ]),
    ]),
    h.p([h.Class('discovery-help')], ['Provider credentials stay on the service. Changing these preferences never changes your credentials.']),
  ])
}

const configView = (model: Model, h: HtmlBuilder<Message>): Html => {
  const configuration = workspaceOf(model)?.configuration
  if (configuration === undefined) return h.empty
  const missing = A.dedupe([...configuration.missingCapture, ...configuration.missingAnalysis])
  return h.details([h.Class('discovery-config')], [
    h.summary([], [configuration.captureReady && configuration.analysisReady ? 'Live capture and analysis configured' : 'Live provider setup is incomplete']),
    h.div([h.Class('discovery-config-body')], [
      h.p([], [`Model: ${configuration.model}. Gateway authentication and model authentication are checked separately by the service.`]),
      h.p([], [`Analysis limits: ${dollars(configuration.runLimitUsd)} per run · ${dollars(configuration.monthlyLimitUsd)} monthly · ${dollars(configuration.attemptReservationUsd)} reserved per attempt.`]),
      missing.length === 0 ? h.p([], ['All required settings are present.']) : h.div([], [h.p([], ['Review analysis preferences and spending limits in Agent settings. Provider credentials and gateway configuration stay on the service.']), h.ul([], A.map(missing, name => h.keyed('li')(name, [], [name]))), button('Open agent settings', RequestedSettings(), false, 'secondary', h)]),
      configuration.fixtureEnabled ? h.p([], ['Fixture mode is available for local verification. Choose it explicitly; fixture captures and detections are labeled throughout.']) : h.empty,
    ]),
  ])
}
const loginView = (model: Model, h: HtmlBuilder<Message>): Html => h.div([h.Class('discovery-login')], [
  h.div([h.Class('discovery-login-mark')], ['D']),
  h.p([h.Class('overline')], ['Your local workspace']),
  h.h1([], ['Discover a site. Build your library.']),
  h.p([h.Class('discovery-muted')], ['Capture public pages, review screenshots, then choose what Claude should analyze. Your reviewed findings stay in your project library.']),
  h.form([h.Class('discovery-login-form'), h.OnSubmit(RequestedLogin())], [
    field('Local owner token', 'ownerToken', model.ownerToken, 'password', h),
    h.button([h.Type('submit'), h.Class('discovery-button discovery-button--primary'), h.Disabled(model.session._tag === 'Loading' || model.ownerToken.trim() === '')], [model.session._tag === 'Loading' ? 'Connecting…' : 'Open workspace']),
  ]),
  errorBanner(model.notice || asyncError(model.session), h),
  h.p([h.Class('discovery-help')], ['Use the owner token configured on this local service. The session protects both your project data and private screenshots.']),
  button('Check existing session', RequestedRefresh(), model.session._tag === 'Loading', 'quiet', h),
])
const headerView = (model: Model, h: HtmlBuilder<Message>): Html => {
  const projects = workspaceOf(model)?.projects ?? []
  const project = projects.find(project => project.id === model.projectId)
  const exported = Option.getOrUndefined(AsyncData.getData(model.exported))
  return h.header([h.Class('discovery-header')], [
    h.div([h.Class('discovery-brand')], [h.span([h.Class('discovery-brand-mark'), h.Attribute('aria-hidden', 'true')], ['D']), h.div([], [h.p([h.Class('overline')], ['MicroDots / Discovery']), h.h1([], ['Site Discovery'])])]),
    h.div([h.Class('discovery-header-actions')], [
      h.label([h.Class('discovery-field discovery-project-select')], [h.span([h.Class('discovery-sr-only')], ['Project']), h.select([h.Class('discovery-input'), h.Attribute('aria-label', 'Project'), h.Value(model.projectId), h.OnInput(value => ChangedContext({ key: 'project', value }))], projects.length === 0 ? [h.option([h.Value('default')], ['Loading projects…'])] : A.map(projects, project => h.keyed('option')(project.id, [h.Value(project.id), h.Selected(project.id === model.projectId)], [project.name])))]),
      h.button([h.Type('button'), h.Class('discovery-button discovery-button--secondary'), h.Attribute('aria-expanded', String(model.settingsOpen)), h.OnClick(RequestedSettings())], ['Agent settings']),
      button(model.showLibrary ? 'Hide library' : 'Project library', ToggledLibrary(), false, 'secondary', h),
      button(model.exported._tag === 'Loading' ? 'Preparing JSON…' : 'Export JSON', RequestedExport(), model.exported._tag === 'Loading', 'secondary', h),
      button('Sign out', RequestedLogout(), false, 'quiet', h),
    ]),
    h.div([h.Class('discovery-header-bottom')], [
      h.p([h.Class('discovery-muted')], [project?.name ?? 'Loading project', ' · Capture, review, analyze, save. You decide each step.']),
      h.div([h.Class('discovery-inline')], [badge('Local owner', 'neutral', h), isBusy(model) ? badge('Working…', 'accent', h) : h.empty]),
    ]),
    exported === undefined ? h.empty : h.div([h.Class('discovery-export-ready'), h.Attribute('role', 'status')], [
      h.span([], ['Project export is ready.']),
      h.a([h.Class('discovery-button discovery-button--secondary'), h.Href(`data:application/json;charset=utf-8,${encodeURIComponent(exported.json)}`), h.Attribute('download', exported.filename)], ['Download JSON']),
    ]),
    errorBanner(asyncError(model.exported), h),
  ])
}
const setupView = (model: Model, h: HtmlBuilder<Message>): Html => {
  const configuration = workspaceOf(model)?.configuration
  const active = workspaceOf(model)?.activeRunId ?? ''
  const unavailable = model.input.evidenceMode === 'live' ? !configuration?.captureReady : !configuration?.fixtureEnabled
  const modeOptions = [{ value: 'single', label: 'Single URL' }, { value: 'batch', label: 'URL list' }, { value: 'domain', label: 'Crawl domain' }, { value: 'sitemap', label: 'Sitemap' }]
  return h.section([h.Class('discovery-card discovery-setup'), h.Attribute('aria-label', 'New capture')], [
    h.div([h.Class('discovery-section-heading')], [h.div([], [h.p([h.Class('discovery-kicker')], ['01 / Capture']), h.h2([], ['Start with the site'])]), badge('Up to 50 pages', 'neutral', h)]),
    h.p([h.Class('discovery-muted')], ['Capture screenshots first. Analysis starts only when you choose “Analyze selected pages”.']),
    h.div([h.Class('discovery-mode-tabs'), h.Attribute('role', 'group'), h.Attribute('aria-label', 'Capture input mode')], A.map(modeOptions, option => h.keyed('button')(option.value, [h.Type('button'), h.Class(`discovery-mode ${model.input.mode === option.value ? 'is-selected' : ''}`), h.Attribute('aria-pressed', String(model.input.mode === option.value)), h.OnClick(ChangedField({ key: 'mode', value: option.value }))], [option.label]))),
    model.input.mode === 'batch'
      ? h.label([h.Class('discovery-field')], [h.span([h.Class('discovery-label')], ['Website URLs · one per line']), h.textarea([h.Class('discovery-input discovery-textarea'), h.Attribute('rows', '5'), h.Value(model.input.source), h.OnInput(value => ChangedField({ key: 'source', value })), h.Attribute('placeholder', 'https://example.com/\nhttps://example.com/about')])])
      : field(model.input.mode === 'sitemap' ? 'Sitemap URL' : model.input.mode === 'domain' ? 'Domain starting URL' : 'Page URL', 'source', model.input.source, 'url', h),
    h.div([h.Class('discovery-form-grid')], [
      select('Crawl depth', 'depth', String(model.input.depth), [1, 2, 3].map(value => ({ value: String(value), label: `${value} ${value === 1 ? 'level' : 'levels'}` })), h),
      select('Page limit', 'maxPages', String(model.input.maxPages), [10, 25, 50].map(value => ({ value: String(value), label: `${value} pages` })), h),
      select('CMS mapping', 'targetCms', model.input.targetCms, ['generic', 'aem', 'contentful', 'optimizely', 'sanity', 'sitecore', 'umbraco', 'wordpress'].map(value => ({ value, label: ({ generic: 'Generic', aem: 'Adobe Experience Manager', contentful: 'Contentful', optimizely: 'Optimizely', sanity: 'Sanity', sitecore: 'Sitecore', umbraco: 'Umbraco', wordpress: 'WordPress' })[value] ?? value })), h),
      select('Evidence source', 'evidenceMode', model.input.evidenceMode, [{ value: 'live', label: 'Live · Cloudflare + Claude' }, ...(configuration?.fixtureEnabled ? [{ value: 'fixture', label: 'Fixture · deterministic test data' }] : [])], h),
    ]),
    h.fieldset([h.Class('discovery-viewport-options')], [
      h.legend([h.Class('discovery-label')], ['Capture viewports']),
      h.label([h.Class('discovery-check-label')], [h.input([h.Type('checkbox'), h.Checked(model.input.desktop), h.OnClick(ToggledViewport({ viewport: 'desktop' }))]), h.span([], ['Desktop', h.small([], ['1440 px'])])]),
      h.label([h.Class('discovery-check-label')], [h.input([h.Type('checkbox'), h.Checked(model.input.mobile), h.OnClick(ToggledViewport({ viewport: 'mobile' }))]), h.span([], ['Mobile', h.small([], ['390 px'])])]),
    ]),
    model.input.evidenceMode === 'fixture' ? h.div([h.Class('discovery-alert discovery-alert--warning')], ['Fixture mode produces deterministic screenshots and detections for verification. It makes no live capture or Claude request.']) : h.empty,
    active !== '' ? h.div([h.Class('discovery-alert')], ['One run is already active. It will continue if you close this page. Open its project and history to reconnect.']) : h.empty,
    unavailable ? h.p([h.Class('discovery-help')], ['Capture is unavailable until the server configuration above is complete.']) : h.empty,
    h.div([h.Class('discovery-form-footer')], [h.p([h.Class('discovery-help')], ['Public websites only. Screenshots stay private on this computer.']), button(isBusy(model) ? 'Starting capture…' : 'Capture screenshots', RequestedCapture(), isBusy(model) || active !== '' || unavailable, 'primary', h)]),
  ])
}
const historyView = (model: Model, h: HtmlBuilder<Message>): Html => {
  const runs = Option.getOrElse(AsyncData.getData(model.history), () => [])
  return h.section([h.Class('discovery-card discovery-history'), h.Attribute('aria-label', 'Capture history')], [
    h.div([h.Class('discovery-section-heading')], [h.div([], [h.p([h.Class('discovery-kicker')], ['Your work, retained']), h.h2([], ['Capture history'])]), badge(String(runs.length), 'neutral', h)]),
    errorBanner(asyncError(model.history), h),
    runs.length === 0 ? empty(model.history._tag === 'Loading' ? 'Loading history…' : 'No captures yet', 'Your runs stay here until you explicitly delete them. Start a capture to build your first review.', h)
      : h.div([h.Class('discovery-history-list')], A.map(runs, run => h.keyed('button')(run.id, [h.Type('button'), h.Class(`discovery-history-item ${run.id === model.runId ? 'is-selected' : ''}`), h.OnClick(ChangedContext({ key: 'run', value: run.id })), h.Attribute('data-run-id', run.id)], [
        h.span([h.Class('discovery-history-title')], [run.input.source.split('\n')[0] ?? 'Website capture']),
        h.span([h.Class('discovery-history-meta')], [statusLabel(run.phase), ' · ', displayDate(run.createdAt)]),
        h.span([h.Class('discovery-inline')], [h.span([h.Class('discovery-help')], [`${run.pageCount} pages · ${run.input.mode}`]), run.input.evidenceMode === 'fixture' ? badge('Fixture', 'warning', h) : badge('Live', 'neutral', h)]),
      ]))),
    h.details([h.Class('discovery-new-project')], [h.summary([], ['Create another project']), h.form([h.OnSubmit(RequestedProject())], [field('Project name', 'projectName', model.projectName, 'text', h), h.button([h.Type('submit'), h.Class('discovery-button discovery-button--secondary'), h.Disabled(isBusy(model) || model.projectName.trim() === '')], ['Create project'])])]),
  ])
}
const pipelineView = (h: HtmlBuilder<Message>): Html => h.div([h.Class('discovery-pipeline')], [
  h.div([], [h.span([], ['01']), h.strong([], ['Capture']), h.p([], ['Pages and screenshots'])]),
  h.div([], [h.span([], ['02']), h.strong([], ['Review']), h.p([], ['Choose the useful pages'])]),
  h.div([], [h.span([], ['03']), h.strong([], ['Analyze']), h.p([], ['Components and content'])]),
  h.div([], [h.span([], ['04']), h.strong([], ['Save']), h.p([], ['Your reviewed library'])]),
])
const attemptsView = (snapshot: RunSnapshot, h: HtmlBuilder<Message>): Html => {
  const attempts = snapshot.analysisAttempts ?? []
  if (attempts.length === 0) return h.empty
  return h.section([h.Class('discovery-attempts'), h.Attribute('aria-label', 'Analysis attempt settings')], [
    h.h3([], ['Settings used for each attempt']),
    h.p([h.Class('discovery-help')], ['These are the settings saved when each analysis job started. Later preference changes do not change this record.']),
    ...attempts.map(attempt => {
      const frozen = attempt.settings
      const values = frozen?.values
      const nullableDollars = (value: number | null) => value === null ? 'Not set' : dollars(value)
      const item = (label: string, value: string) => h.div([], [h.span([], [label]), h.strong([], [value])])
      return h.keyed('details')(attempt.id, [h.Class('discovery-attempt')], [
        h.summary([], [h.strong([], [snapshot.pages.find(page => page.id === attempt.pageId)?.title || attempt.pageId]), badge(attempt.status === 'inflight' ? 'In progress' : attempt.status === 'unknown' ? 'Outcome unknown' : 'Response received', attempt.status === 'unknown' ? 'warning' : 'neutral', h), h.span([h.Class('discovery-help')], [frozen === null ? 'Settings unavailable for this older attempt' : `Settings version ${frozen.settingsRevision} · ${values?.modelId ?? ''}`])]),
        frozen === null || values === undefined ? h.p([h.Class('discovery-help')], ['This attempt predates saved settings snapshots.']) : h.div([], [
          h.div([h.Class('discovery-usage-grid')], [
            item('Model', values.modelId), item('Requested / effective output tokens', `${values.maxOutputTokens.toLocaleString()} / ${frozen.effectiveMaxOutputTokens.toLocaleString()}`),
            item('Requested / effective reasoning', `${values.reasoning === null ? 'Provider default' : reasoningLabel(values.reasoning)} / ${reasoningLabel(frozen.effectiveReasoning)}`),
            item('Requested / effective thinking tokens', `${values.thinkingBudgetTokens === null ? 'Default' : values.thinkingBudgetTokens.toLocaleString()} / ${frozen.effectiveThinkingBudgetTokens === null ? 'No fixed budget' : frozen.effectiveThinkingBudgetTokens.toLocaleString()}`),
            item('Temperature / timeout', `${values.temperature === null ? 'Provider default' : values.temperature} / ${values.requestTimeoutMs.toLocaleString()} ms`),
            item('Cache retention', reasoningLabel(values.cacheRetention)), item('DOM / screenshot evidence', `${values.maxDomChars.toLocaleString()} characters / ${values.screenshotEvidence}`),
            item('Run / monthly limits', `${nullableDollars(values.runLimitUsd)} / ${nullableDollars(values.monthlyLimitUsd)}`),
            item('Configured / minimum reservation', `${nullableDollars(values.attemptReservationUsd)} / ${dollars(frozen.minimumReservationUsd)}`),
            item('Spent / currently held', `${dollars(attempt.spentUsd)} / ${dollars(attempt.reservedUsd)}`),
            item('Started with these settings', displayDate(frozen.admittedAt)), item('Prompt version', frozen.promptVersion),
            ...(frozen.catalogRevision === undefined ? [] : [item('Model catalog version', String(frozen.catalogRevision))]),
            ...(frozen.catalogFetchedAt === undefined ? [] : [item('Model catalog fetched', displayDate(frozen.catalogFetchedAt))]),
            ...(frozen.model === undefined ? [] : [item('Model metadata / pricing', `${frozen.model.capabilitySource} / ${frozen.model.pricingSource}`)]),
          ]),
          values.extraInstructions === '' ? h.p([h.Class('discovery-help')], ['No additional analysis instructions.']) : h.details([], [h.summary([], ['Additional instructions used']), h.pre([], [values.extraInstructions])]),
        ]),
        attempt.diagnostic === '' ? h.empty : h.p([h.Class('discovery-help')], [attempt.diagnostic]),
        attempt.rawResponseTruncated ? h.p([h.Class('discovery-alert discovery-alert--warning')], [`The stored response excerpt was shortened from ${attempt.rawResponseChars.toLocaleString()} characters. Analysis validation used the full response.`]) : h.empty,
      ])
    }),
  ])
}

const usageView = (snapshot: RunSnapshot, h: HtmlBuilder<Message>): Html => {
  const usage = snapshot.run.usage
  return h.details([h.Class('discovery-usage')], [
    h.summary([], [h.span([], [snapshot.run.input.evidenceMode === 'fixture' ? 'Fixture usage' : 'AI usage']), h.span([h.Class('discovery-mono')], [`${dollars(usage.costUsd)} spent · ${dollars(usage.reservedUsd)} reserved · ${usage.analyzedPages} pages`])]),
    h.div([h.Class('discovery-usage-grid')], [
      h.div([], [h.span([], ['Model']), h.strong([], [usage.model || 'Analysis has not started'])]),
      h.div([], [h.span([], ['Input / output tokens']), h.strong([], [`${usage.inputTokens.toLocaleString()} / ${usage.outputTokens.toLocaleString()}`])]),
      h.div([], [h.span([], ['Cache read / write']), h.strong([], [`${usage.cacheReadTokens.toLocaleString()} / ${usage.cacheWriteTokens.toLocaleString()}`])]),
      h.div([], [h.span([], ['Analysis duration']), h.strong([], [`${(usage.durationMs / 1000).toFixed(1)} s`])]),
      h.div([], [h.span([], ['Run / monthly limits']), h.strong([], [`${dollars(snapshot.budget.runLimitUsd)} / ${dollars(snapshot.budget.monthlyLimitUsd)}`])]),
      h.div([], [h.span([], ['Workspace spent / reserved']), h.strong([], [`${dollars(snapshot.budget.spentUsd)} / ${dollars(snapshot.budget.reservedUsd)}`])]),
    ]),
    attemptsView(snapshot, h),
  ])
}
const pageRailView = (model: Model, snapshot: RunSnapshot, h: HtmlBuilder<Message>): Html => h.section([h.Class('discovery-page-rail'), h.Attribute('aria-label', 'Captured pages')], [
  h.div([h.Class('discovery-pane-heading')], [h.h3([], ['Pages']), badge(String(snapshot.pages.length), 'neutral', h)]),
  snapshot.run.phase === 'captured' ? h.div([h.Class('discovery-rail-actions')], [button('Select all', SelectedAllPages({ selected: true }), false, 'quiet', h), button('Clear', SelectedAllPages({ selected: false }), false, 'quiet', h)]) : h.empty,
  snapshot.pages.length === 0 ? empty('Waiting for pages', 'Capture progress will appear here. You can close this tab and reconnect later.', h) : h.div([h.Class('discovery-page-list')], A.map(snapshot.pages, page => h.keyed('div')(page.id, [h.Class(`discovery-page-row ${model.pageId === page.id ? 'is-selected' : ''}`)], [
    h.button([h.Type('button'), h.Class('discovery-page-open'), h.OnClick(SelectedPage({ pageId: page.id })), h.Attribute('aria-current', String(model.pageId === page.id))], [h.strong([], [page.title || page.url]), h.span([h.Class('discovery-url')], [page.url]), h.span([h.Class('discovery-page-stage')], [statusLabel(page.status)])]),
    snapshot.run.phase === 'captured' && A.contains(eligiblePageIds(snapshot), page.id) ? h.label([h.Class('discovery-page-check')], [h.input([h.Type('checkbox'), h.Checked(A.contains(model.analysisIds, page.id)), h.OnClick(ToggledAnalysisPage({ pageId: page.id })), h.Attribute('aria-label', `Analyze ${page.title || page.url}`)]), h.span([h.Class('discovery-help')], ['Analyze'])]) : h.empty,
    page.error !== '' ? h.p([h.Class('discovery-page-error')], [page.error]) : h.empty,
  ]))),
])
const screenshotView = (model: Model, snapshot: RunSnapshot, h: HtmlBuilder<Message>): Html => {
  const page = snapshot.pages.find(page => page.id === model.pageId)
  if (page === undefined) return h.section([h.Class('discovery-preview')], [empty('No preview available', 'Choose a page after a capture completes.', h)])
  const viewport = model.viewport === 'desktop' && page.desktopUrl !== '' || page.mobileUrl === '' ? 'desktop' : 'mobile'
  const path = viewport === 'desktop' ? page.desktopUrl : page.mobileUrl
  const src = privateAssetUrl(model, path)
  return h.section([h.Class('discovery-preview'), h.Attribute('aria-label', 'Screenshot review')], [
    h.div([h.Class('discovery-pane-heading discovery-preview-heading')], [h.h3([], ['Screenshot review']), h.div([h.Class('discovery-segmented'), h.Attribute('role', 'group'), h.Attribute('aria-label', 'Screenshot viewport')], [
      h.button([h.Type('button'), h.Class(viewport === 'desktop' ? 'is-selected' : ''), h.Disabled(page.desktopUrl === ''), h.Attribute('aria-pressed', String(viewport === 'desktop')), h.OnClick(SelectedViewport({ viewport: 'desktop' }))], ['Desktop']),
      h.button([h.Type('button'), h.Class(viewport === 'mobile' ? 'is-selected' : ''), h.Disabled(page.mobileUrl === ''), h.Attribute('aria-pressed', String(viewport === 'mobile')), h.OnClick(SelectedViewport({ viewport: 'mobile' }))], ['Mobile']),
    ])]),
    h.a([h.Class('discovery-preview-url'), h.Href(page.url), h.Target('_blank'), h.Rel('noopener noreferrer')], [page.url, ' ↗']),
    path === '' ? empty(page.status === 'failed' ? 'Capture failed' : 'Screenshot pending', page.error || 'This page does not have a screenshot yet. Inspect another page while capture continues.', h)
      : h.div([h.Class(`discovery-screenshot discovery-screenshot--${viewport}`)], [h.img([h.Src(src), h.Alt(`${viewport} capture of ${page.title || page.url}`), h.Attribute('data-viewport', viewport), h.Attribute('loading', 'eager')])]),
    h.div([h.Class('discovery-preview-caption')], [badge(page.provenance.mode === 'fixture' ? 'Fixture screenshot' : 'Live screenshot', page.provenance.mode === 'fixture' ? 'warning' : 'neutral', h), h.span([], [page.provenance.provider, ' · ', viewport === 'desktop' ? '1440 px' : '390 px'])]),
  ])
}
const findingView = (model: Model, snapshot: RunSnapshot, finding: Finding, h: HtmlBuilder<Message>): Html => {
  const saved = A.contains(savedFindingIds(snapshot), finding.id)
  const selected = A.contains(model.findingIds, finding.id)
  const choice = model.choices.find(choice => choice.findingId === finding.id)?.action ?? 'create'
  return h.keyed('article')(finding.id, [h.Class(`discovery-finding ${selected ? 'is-selected' : ''}`), h.Attribute('data-finding-id', finding.id)], [
    h.div([h.Class('discovery-finding-title')], [h.label([h.Class('discovery-check-label')], [h.input([h.Type('checkbox'), h.Checked(selected), h.Disabled(saved || isBusy(model)), h.OnClick(ToggledFinding({ findingId: finding.id })), h.Attribute('aria-label', `Select ${finding.name}`)]), h.strong([], [finding.name])]), saved ? badge('Saved to project', 'success', h) : badge(`${Math.round(finding.confidence * 100)}%`, 'neutral', h)]),
    h.p([h.Class('discovery-help')], [finding.category, ' · ', `${finding.pageIds.length} source page${finding.pageIds.length === 1 ? '' : 's'}`]),
    h.p([h.Class('discovery-finding-description')], [finding.description]),
    h.div([h.Class('discovery-cms')], [h.span([h.Class('discovery-label')], ['CMS name']), h.code([], [finding.cmsName]), button('Copy', RequestedCopy({ text: finding.cmsName }), false, 'quiet', h)]),
    finding.fields.length === 0 ? h.empty : h.div([h.Class('discovery-field-chips')], A.map(finding.fields, field => h.keyed('span')(field.name, [h.Class('discovery-field-chip')], [`${field.name}${field.required ? '*' : ''}`, h.small([], [field.type])]))),
    finding.variants.length === 0 ? h.empty : h.p([h.Class('discovery-help')], [`Variants: ${finding.variants.join(', ')}`]),
    finding.existingId === '' || saved ? h.empty : h.div([h.Class('discovery-duplicate')], [
      h.strong([], [`Possible duplicate: ${finding.existingName}`]), h.p([], ['Keep both creates a separate library record. Merge updates this existing record.']),
      h.div([h.Class('discovery-segmented'), h.Attribute('role', 'group'), h.Attribute('aria-label', `Duplicate decision for ${finding.name}`)], [
        h.button([h.Type('button'), h.Class(choice === 'create' ? 'is-selected' : ''), h.Disabled(isBusy(model)), h.Attribute('aria-pressed', String(choice === 'create')), h.OnClick(ChoseDuplicate({ findingId: finding.id, action: 'create' }))], ['Keep both']),
        h.button([h.Type('button'), h.Class(choice === 'merge' ? 'is-selected' : ''), h.Disabled(isBusy(model)), h.Attribute('aria-pressed', String(choice === 'merge')), h.OnClick(ChoseDuplicate({ findingId: finding.id, action: 'merge' }))], ['Merge with existing']),
      ]),
    ]),
    h.details([h.Class('discovery-provenance')], [
      h.summary([], ['Evidence & provenance']),
      h.p([], [`${finding.provenance.mode === 'fixture' ? 'Deterministic fixture' : 'Live provider'} · ${finding.provenance.provider} · ${finding.provenance.model}`]),
      h.p([], [`Captured ${displayDate(finding.provenance.capturedAt)}`]),
      finding.evidence.length === 0
        ? h.div([], A.map(A.filter(snapshot.pages, page => A.contains(finding.pageIds, page.id)), page => h.keyed('button')(page.id, [h.Type('button'), h.Class('discovery-source-link'), h.OnClick(SelectedPage({ pageId: page.id }))], [page.title || page.url])))
        : h.div([], A.map(finding.evidence, evidence => h.keyed('div')(`${evidence.pageId}:${evidence.provenance.attemptId}`, [h.Class('discovery-evidence-page')], [
          h.button([h.Type('button'), h.Class('discovery-source-link'), h.OnClick(SelectedPage({ pageId: evidence.pageId }))], [snapshot.pages.find(page => page.id === evidence.pageId)?.title || 'View source page']),
          h.p([], [evidence.description]),
          h.p([], [`${Math.round(evidence.confidence * 100)}% confidence · ${evidence.provenance.model}`]),
          h.p([], [`Fields: ${evidence.fields.map(field => `${field.name} (${field.type})`).join(', ') || 'None detected'}`]),
          evidence.variants.length === 0 ? h.empty : h.p([], [`Variants: ${evidence.variants.join(', ')}`]),
        ]))),
    ]),
  ])
}
const findingsView = (model: Model, snapshot: RunSnapshot, h: HtmlBuilder<Message>): Html => {
  const findings = A.filter(snapshot.findings, finding => finding.kind === model.findingTab)
  const count = (kind: Finding['kind']) => A.filter(snapshot.findings, finding => finding.kind === kind).length
  return h.section([h.Class('discovery-findings'), h.Attribute('aria-label', 'Discovered findings')], [
    h.div([h.Class('discovery-findings-tabs'), h.Attribute('role', 'tablist'), h.Attribute('aria-label', 'Finding kind')], [
      h.button([h.Type('button'), h.Attribute('role', 'tab'), h.Attribute('aria-selected', String(model.findingTab === 'component')), h.Class(model.findingTab === 'component' ? 'is-selected' : ''), h.OnClick(SelectedFindingTab({ tab: 'component' }))], [`Components (${count('component')})`]),
      h.button([h.Type('button'), h.Attribute('role', 'tab'), h.Attribute('aria-selected', String(model.findingTab === 'content-type')), h.Class(model.findingTab === 'content-type' ? 'is-selected' : ''), h.OnClick(SelectedFindingTab({ tab: 'content-type' }))], [`Content types (${count('content-type')})`]),
    ]),
    findings.length === 0 ? empty(snapshot.run.phase === 'analyzing' ? 'Analysis is running' : snapshot.run.phase === 'completed' ? 'No findings in this category' : 'Ready when you are', snapshot.run.phase === 'analyzing' ? 'Validated detections will appear as analysis completes. Follow the run log for progress.' : snapshot.run.phase === 'completed' ? 'Try another set of pages or a different CMS mapping in a new capture.' : 'Review the screenshots and select pages, then choose Analyze selected pages.', h)
      : h.div([h.Class('discovery-finding-list'), h.Attribute('role', 'tabpanel')], A.map(findings, finding => findingView(model, snapshot, finding, h))),
  ])
}
const saveView = (model: Model, h: HtmlBuilder<Message>): Html => {
  if (model.findingIds.length === 0) return h.empty
  const preview = previewOf(model)
  return h.section([h.Class('discovery-save'), h.Attribute('aria-label', 'Save reviewed findings')], [
    h.div([h.Class('discovery-save-heading')], [h.div([], [h.strong([], [`${model.findingIds.length} findings selected`]), h.p([h.Class('discovery-help')], ['Review the exact CMS names and create/merge actions before saving.'])]), h.div([h.Class('discovery-inline')], [button('Clear', ClearedFindings(), isBusy(model), 'quiet', h), button(model.preview._tag === 'Loading' ? 'Preparing preview…' : 'Preview save', RequestedPreview(), isBusy(model) || model.preview._tag === 'Loading', 'secondary', h)])]),
    errorBanner(asyncError(model.preview), h),
    preview === undefined ? h.empty : h.div([h.Class('discovery-save-preview')], [
      h.h3([], ['Save preview']),
      h.div([h.Class('discovery-save-table')], [
        h.table([], [
          h.thead([], [h.tr([], [h.th([], ['Finding']), h.th([], ['Action']), h.th([], ['Saved CMS name'])])]),
          h.tbody([], A.map(preview.items, item => h.keyed('tr')(item.findingId, [], [
            h.td([], [item.name]),
            h.td([], [item.action === 'create' ? 'Create separate record' : item.action === 'merge' ? 'Merge with existing' : 'Skip']),
            h.td([], [h.code([], [item.cmsName])]),
          ]))),
        ]),
      ]),
      h.div([h.Class('discovery-form-footer')], [h.p([h.Class('discovery-help')], ['Names shown here are the names that will be saved. Changes to the project require a fresh preview.']), button(isBusy(model) ? 'Saving…' : 'Save to project', RequestedSave(), isBusy(model), 'primary', h)]),
    ]),
  ])
}
const logsView = (snapshot: RunSnapshot, h: HtmlBuilder<Message>): Html => h.details([h.Class('discovery-card discovery-logs'), h.Attribute('open', 'true')], [
  h.summary([], [h.strong([], ['Run log']), badge(String(snapshot.logs.length), 'neutral', h)]),
  h.div([h.Class('discovery-log-list'), h.Attribute('aria-live', 'polite')], snapshot.logs.length === 0 ? [h.p([h.Class('discovery-help')], ['Waiting for the first durable event…'])] : A.map(snapshot.logs, log => h.keyed('div')(String(log.seq), [h.Class(`discovery-log discovery-log--${log.level}`)], [
    h.time([h.Attribute('datetime', log.at)], [new Date(log.at).toLocaleTimeString()]),
    h.div([], [h.p([], [log.message]), log.detail === '' ? h.empty : h.details([], [h.summary([], ['Details']), h.pre([], [log.detail])])]),
  ]))),
])
const runView = (model: Model, snapshot: RunSnapshot, h: HtmlBuilder<Message>): Html => {
  const run = snapshot.run
  const configuration = workspaceOf(model)?.configuration
  const canAnalyze = run.input.evidenceMode === 'fixture' ? configuration?.fixtureEnabled : configuration?.analysisReady && (settingsOf(model) === undefined || settingsOf(model)?.catalog.status === 'fresh')
  const progress = run.pageCount === 0 ? 0 : Math.min(100, (run.capturedCount + run.failedCount) / run.pageCount * 100)
  return h.div([h.Class('discovery-run'), h.Attribute('data-run-phase', run.phase)], [
    h.section([h.Class('discovery-card discovery-run-status')], [
      h.div([h.Class('discovery-section-heading')], [h.div([], [h.p([h.Class('discovery-kicker')], [`${run.input.mode} capture · ${run.input.maxPages} page limit · depth ${run.input.depth}`]), h.h2([], [statusLabel(run.phase)])]), h.div([h.Class('discovery-inline')], [badge(run.input.evidenceMode === 'fixture' ? 'Fixture evidence' : 'Live evidence', run.input.evidenceMode === 'fixture' ? 'warning' : 'accent', h), button('New capture', RequestedNewRun(), isBusy(model), 'secondary', h)])]),
      h.p([h.Class('discovery-run-source')], [run.input.source]),
      h.div([h.Class('discovery-metrics')], [h.div([], [h.strong([], [String(run.pageCount)]), h.span([], ['Pages'])]), h.div([], [h.strong([], [String(run.capturedCount)]), h.span([], ['Captured'])]), h.div([], [h.strong([], [String(run.analyzedCount)]), h.span([], ['Analyzed'])]), h.div([], [h.strong([], [String(snapshot.findings.length)]), h.span([], ['Findings'])]), h.div([], [h.strong([], [String(run.failedCount)]), h.span([], ['Failed'])])]),
      h.div([h.Class('discovery-progress'), h.Attribute('role', 'progressbar'), h.Attribute('aria-label', 'Capture progress'), h.Attribute('aria-valuenow', String(Math.round(progress))), h.Attribute('aria-valuemin', '0'), h.Attribute('aria-valuemax', '100')], [h.div([h.Style({ width: `${progress}%` })])]),
      errorBanner(run.error, h),
      run.phase === 'captured' ? h.div([h.Class('discovery-analysis-callout')], [h.div([], [h.strong([], ['Screenshots are ready for review']), h.p([], [`${model.analysisIds.length} captured pages selected. Only selected pages are sent for analysis.`]), !canAnalyze ? h.p([h.Class('discovery-help')], ['Live analysis is blocked until model, gateway and spending settings are complete.']) : h.empty]), button('Analyze selected pages', RequestedAnalysis(), isBusy(model) || model.analysisIds.length === 0 || !canAnalyze, 'primary', h)]) : h.empty,
      run.phase === 'capturing' || run.phase === 'queued' || run.phase === 'analyzing' ? h.p([h.Class('discovery-service-note')], ['The service owns this work. Closing this tab, changing project, or reconnecting does not cancel it.']) : h.empty,
      run.phase === 'requires_retry' ? h.div([h.Class('discovery-alert discovery-alert--warning')], [h.strong([], [run.usage.reservedUsd > 0 ? 'An analysis request has an unknown outcome.' : 'This run needs your decision before retrying.']), h.p([], [run.usage.reservedUsd > 0 ? 'Its budget reservation remains held. Retrying may repeat the external call and requires another reservation. Review the log before continuing.' : 'Review the error and run log before retrying. Retry starts the failed or interrupted work again.']), button('Retry operation', RequestedRetryRun(), isBusy(model), 'secondary', h)]) : h.empty,
      run.phase === 'failed' ? h.div([h.Class('discovery-alert discovery-alert--error')], [h.strong([], ['This run did not complete.']), h.p([], ['Review the failure and run log, correct any configuration or provider issue, then explicitly retry the failed work.']), button('Retry failed operation', RequestedRetryRun(), isBusy(model), 'secondary', h)]) : h.empty,
    ]),
    usageView(snapshot, h),
    h.div([h.Class('discovery-review-grid')], [pageRailView(model, snapshot, h), screenshotView(model, snapshot, h), findingsView(model, snapshot, h)]),
    saveView(model, h), logsView(snapshot, h),
    h.details([h.Class('discovery-run-history')], [h.summary([], ['Browse capture history']), historyView(model, h)]),
    h.div([h.Class('discovery-run-footer')], [h.p([h.Class('discovery-help')], [`Started ${displayDate(run.createdAt)} · History is retained until explicit deletion.`]), button('Delete this run', RequestedDelete(), isBusy(model) || ['queued', 'capturing', 'analyzing'].includes(run.phase), 'quiet', h)]),
    model.deleteConfirmation ? h.div([h.Class('discovery-delete-confirm'), h.Attribute('role', 'alertdialog'), h.Attribute('aria-label', 'Delete run confirmation')], [h.h3([], ['Delete this run and its private screenshots?']), h.p([], ['Saved project library records remain. This removes the capture history and evidence for this run.']), h.div([h.Class('discovery-inline')], [button('Keep run', CancelledDelete(), isBusy(model), 'secondary', h), button('Delete run', ConfirmedDelete(), isBusy(model), 'danger', h)])]) : h.empty,
  ])
}
const libraryView = (model: Model, h: HtmlBuilder<Message>): Html => {
  const records = Option.getOrElse(AsyncData.getData(model.library), () => [])
  return h.section([h.Class('discovery-card discovery-library'), h.Attribute('aria-label', 'Project library')], [
    h.div([h.Class('discovery-section-heading')], [h.div([], [h.p([h.Class('discovery-kicker')], ['Reviewed and saved']), h.h2([], ['Project library'])]), badge(`${records.length} records`, 'success', h)]),
    errorBanner(asyncError(model.library), h),
    records.length === 0 ? empty('Your library is ready for its first finding', 'Analyze captured pages, select findings, review their save preview, then save them here.', h) : h.div([h.Class('discovery-library-grid')], A.map(records, record => h.keyed('article')(record.id, [h.Class('discovery-library-record')], [
      h.div([h.Class('discovery-inline')], [badge(record.kind === 'component' ? 'Component' : 'Content type', 'neutral', h), record.provenance.mode === 'fixture' ? badge('Fixture', 'warning', h) : h.empty]),
      h.h3([], [record.name]), h.code([], [record.cmsName]), h.p([], [record.description]),
      record.fields.length === 0 ? h.empty : h.p([h.Class('discovery-help')], [`Fields: ${record.fields.map(field => `${field.name} (${field.type})`).join(', ')}`]),
      record.variants.length === 0 ? h.empty : h.p([h.Class('discovery-help')], [`Variants: ${record.variants.join(', ')}`]),
      record.designVariants.length === 0 ? h.empty : h.details([h.Class('discovery-library-evidence')], [
        h.summary([], [`Saved design captures (${record.designVariants.length})`]),
        h.div([], A.map(record.designVariants, variant => h.keyed('div')(variant.id, [h.Class('discovery-library-capture')], [
          h.span([], [variant.name]),
          variant.desktopUrl === '' ? h.empty : h.a([h.Href(privateAssetUrl(model, variant.desktopUrl)), h.Target('_blank'), h.Rel('noopener noreferrer')], ['Desktop ↗']),
          variant.mobileUrl === '' ? h.empty : h.a([h.Href(privateAssetUrl(model, variant.mobileUrl)), h.Target('_blank'), h.Rel('noopener noreferrer')], ['Mobile ↗']),
        ]))),
      ]),
      h.p([h.Class('discovery-help')], [`Updated ${displayDate(record.updatedAt)}`]),
    ]))),
  ])
}
export const builderRenderState = (model: Model): 'loading' | 'ready' | 'error' => model.session._tag === 'Loading' || model.workspace._tag === 'Loading' ? 'loading' : model.session._tag === 'Failure' || model.workspace._tag === 'Failure' ? 'error' : 'ready'
export const view = (model: Model, h: HtmlBuilder<Message>): Html => {
  const snapshot = snapshotOf(model)
  return h.div([h.Class('discovery-workspace'), h.Attribute('data-builder-render-state', builderRenderState(model))], authenticated(model) ? [
    headerView(model, h),
    h.main([h.Class('discovery-main')], [
      model.notice === '' ? h.empty : h.div([h.Class(`discovery-alert ${model.mutation._tag === 'Refused' ? 'discovery-alert--error' : ''}`), h.Attribute('role', model.mutation._tag === 'Refused' ? 'alert' : 'status')], [model.notice, model.mutation._tag === 'Refused' && model.mutation.retryable ? button('Retry same request', RequestedRetryCommand(), false, 'secondary', h) : h.empty]),
      errorBanner(asyncError(model.workspace), h), errorBanner(asyncError(model.snapshot), h),
      settingsView(model, h), configView(model, h),
      model.showLibrary ? libraryView(model, h) : h.empty,
      model.runId === '' ? h.div([], [h.div([h.Class('discovery-setup-grid')], [setupView(model, h), historyView(model, h)]), pipelineView(h)])
        : snapshot === undefined ? h.div([h.Class('discovery-card discovery-loading'), h.Attribute('role', 'status')], [empty(model.snapshot._tag === 'Failure' ? 'This run could not be opened' : 'Loading capture review…', model.snapshot._tag === 'Failure' ? 'The service may be offline, or this run may belong to another project. Choose a run from this project’s history.' : 'Reconnecting to saved screenshots, findings and durable progress.', h), h.div([h.Class('discovery-inline')], [button('Try again', RequestedRefresh(), model.snapshot._tag === 'Loading', 'secondary', h), button('Back to capture history', RequestedNewRun(), false, 'quiet', h)])])
          : runView(model, snapshot, h),
    ]),
    h.footer([h.Class('discovery-footer')], [h.span([], ['Site Discovery · MicroDots']), h.span([], ['Review screenshots before analysis. Save only what you choose.'])]),
  ] : [loginView(model, h)])
}
export const makeElement = (container: HTMLElement, flags: Flags) => Runtime.makeElement({
  Model, Flags, flags: Effect.succeed(flags), init, update, view, subscriptions, ports, container, devTools: { Message },
})

// @vitest-environment happy-dom

import { Option } from 'effect'
import { AsyncData } from 'foldkit'
import { Command, given, message, model, story } from 'foldkit/story'
import { all, expect as see, expectAll, given as rendered, scene, selector } from 'foldkit/scene'
import { describe, expect, test } from 'vitest'

import { defineMicroDot } from '@bespokeagentics/microdots-element'

import {
  ChangedSetting, ClosedSettings, FailedSettings, FailedSettingsPreview,
  ReloadedSettings, RequestedSettings, RequestedSettingsPreview, RequestedSettingsSave, RevertedSettings,
  SucceededMutationSettings, SucceededSettings, SucceededSettingsPreview, settingsDirty, settingsDraft, settingsValues,
  ChangedContext, ChangedField, ChoseDuplicate, ClearedFindings, CompletedReport,
  FailedMutation, FailedSnapshot, LoadSnapshot, LoadWorkspace, PreviewData,
  RequestedAnalysis, RequestedCapture, RequestedLogin, RequestedLogout,
  RequestedPreview, RequestedRetryCommand, RequestedRetryRun, RequestedSave, SessionData,
  SnapshotData, SubmitRequest, SucceededMutationRun, SucceededPreview, SucceededSnapshot,
  SucceededWorkspace, Ticked, ToggledAnalysisPage, ToggledFinding,
  WorkspaceData, builderRenderState, eligiblePageIds, initialModel, saveChoices,
  savedFindingIds, unauthorized, update, validateCapture, view, type Model, ReportRun,
} from './app.ts'
import { SettingsSnapshot, type SettingsEvaluation, type CaptureInput, type Provenance, RunSnapshot, SavePreview, Workspace } from './contract.ts'
import { discoverySurface } from './shape.surface.ts'

const input: CaptureInput = { mode: 'single', source: 'https://example.com/', depth: 1, maxPages: 10, desktop: true, mobile: true, targetCms: 'generic', evidenceMode: 'fixture' }
const provenance: Provenance = { mode: 'fixture', provider: 'deterministic-fixture', model: 'fixture', attemptId: 'attempt-1', capturedAt: '2026-10-15T12:00:00.000Z' }
const workspace = Workspace.make({
  projects: [{ id: 'default', name: 'My Discovery', revision: 1, createdAt: '2026-10-15T12:00:00.000Z' }],
  configuration: { fixtureEnabled: true, captureReady: false, analysisReady: false, missingCapture: ['CLOUDFLARE_ACCOUNT_ID'], missingAnalysis: ['ANTHROPIC_API_KEY'], model: 'claude', runLimitUsd: 1, monthlyLimitUsd: 5, attemptReservationUsd: 0.25 },
  budget: { spentUsd: 0, reservedUsd: 0, runLimitUsd: 1, monthlyLimitUsd: 5 }, activeRunId: '', sessionId: 'owner-session',
})
const snapshot = RunSnapshot.make({
  run: { id: 'run-1', projectId: 'default', revision: 2, phase: 'captured', input, createdAt: '2026-10-15T12:00:00.000Z', updatedAt: '2026-10-15T12:01:00.000Z', pageCount: 2, capturedCount: 2, analyzedCount: 0, failedCount: 0, error: '', usage: { model: '', inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0, reservedUsd: 0, analyzedPages: 0, durationMs: 0 } },
  pages: ['one', 'two'].map(id => ({ id, projectId: 'default', runId: 'run-1', url: `https://example.com/${id}`, title: `Page ${id}`, status: 'captured', desktopUrl: `/screenshots/${id}/desktop`, mobileUrl: `/screenshots/${id}/mobile`, error: '', selected: false, provenance })),
  findings: [
    { id: 'finding-1', projectId: 'default', runId: 'run-1', kind: 'component', name: 'Hero', description: 'A hero component', category: 'Marketing', confidence: .95, pageIds: ['one'], fields: [{ name: 'headline', type: 'string', required: true }], variants: ['Image left'], cmsName: 'Hero', existingId: 'existing-hero', existingName: 'Existing hero', savedRecordId: '', saveReceiptId: '', evidence: [], provenance },
    { id: 'finding-2', projectId: 'default', runId: 'run-1', kind: 'content-type', name: 'Article', description: 'An article type', category: 'Content', confidence: .9, pageIds: ['two'], fields: [{ name: 'title', type: 'string', required: true }], variants: [], cmsName: 'Article', existingId: '', existingName: '', savedRecordId: '', saveReceiptId: '', evidence: [], provenance },
  ], logs: [{ seq: 1, runId: 'run-1', at: '2026-10-15T12:01:00.000Z', level: 'info', message: 'Capture completed', detail: '{"fixture":true}' }], receipts: [], budget: workspace.budget,
})
const base = (): Model => ({
  ...initialModel({ apiUrl: '', projectId: 'default', runId: 'run-1' }),
  instanceId: 'ui-instance',
  session: SessionData.Success({ data: { authenticated: true, sessionId: 'owner-session' } }),
  workspace: WorkspaceData.Success({ data: workspace }),
  snapshot: SnapshotData.Success({ data: snapshot }), pageId: 'one', analysisIds: ['one', 'two'],
})
const preview = SavePreview.make({ projectId: 'default', runId: 'run-1', revision: 2, projectRevision: 1, items: [{ findingId: 'finding-1', action: 'create', targetId: '', name: 'Hero', kind: 'component', cmsName: 'Hero2' }] })

describe('explicit workflow and durable reconnect', () => {
  test('a read and a poll never submit analysis', () => {
    const read = update(base(), SucceededSnapshot({ generation: 0, snapshot }))
    expect(read.commands).toBeUndefined()
    story(update, given(base()), message(Ticked()), Command.expectHas(LoadWorkspace), Command.expectHas(LoadSnapshot),
      Command.resolve(LoadWorkspace, SucceededWorkspace.make({ generation: 0, workspace, history: [snapshot.run], library: [] })),
      Command.resolve(LoadSnapshot, SucceededSnapshot({ generation: 0, snapshot })),
      model(next => expect(next.analysisIds).toEqual(['one', 'two'])),
    )
  })
  test('only selected eligible pages enter the explicit analysis request', () => {
    const deselected = update(base(), ToggledAnalysisPage({ pageId: 'two' })).model
    const submitted = update(deselected, RequestedAnalysis())
    expect(submitted.model.mutation._tag).toBe('Sending')
    if (submitted.model.mutation._tag === 'Sending') expect(submitted.model.mutation.request).toMatchObject({ _tag: 'AnalyzeRequest', pageIds: ['one'], expectedRevision: 2 })
    expect(eligiblePageIds(snapshot)).toEqual(['one', 'two'])
  })
  test('definitive failed work has an explicit retry control and stable revision', () => {
    const failed: RunSnapshot = { ...snapshot, run: { ...snapshot.run, phase: 'failed', error: 'Capture provider refused the request' } }
    const current: Model = { ...base(), snapshot: SnapshotData.Success({ data: failed }) }
    const result = update(current, RequestedRetryRun()).model
    expect(result.mutation._tag).toBe('Sending')
    if (result.mutation._tag === 'Sending') expect(result.mutation.request).toMatchObject({ _tag: 'RetryRunRequest', runId: 'run-1', expectedRevision: 2 })
    scene({ update, view }, rendered(current), see(selector('.discovery-run-status')).toHaveText(/Retry failed operation/))
  })
  test('retry copy only claims an unknown analysis outcome when a reservation is retained', () => {
    const known: RunSnapshot = { ...snapshot, run: { ...snapshot.run, phase: 'requires_retry', error: 'Analysis response was invalid; retry explicitly' } }
    scene({ update, view }, rendered({ ...base(), snapshot: SnapshotData.Success({ data: known }) }),
      see(selector('.discovery-run-status .discovery-alert--warning')).toHaveText(/Review the error and run log/),
      see(selector('.discovery-run-status .discovery-alert--warning')).not.toHaveText(/unknown outcome/),
    )
    const unknown: RunSnapshot = { ...known, run: { ...known.run, usage: { ...known.run.usage, reservedUsd: 0.25 } } }
    scene({ update, view }, rendered({ ...base(), snapshot: SnapshotData.Success({ data: unknown }) }),
      see(selector('.discovery-run-status .discovery-alert--warning')).toHaveText(/budget reservation remains held/),
    )
  })
  test('transport and typed session refusals are recognized without guessing message text', () => {
    expect(unauthorized({ code: 'unauthorized' })).toBe(true)
    expect(unauthorized({ reason: { cause: { response: { status: 401 } } } })).toBe(true)
    expect(unauthorized({ reason: { cause: { response: { status: 500 } } } })).toBe(false)
    expect(unauthorized(new Error('401 words in an unrelated message'))).toBe(false)
  })
  test('zero selected pages cannot start analysis', () => {
    const result = update({ ...base(), analysisIds: [] }, RequestedAnalysis())
    expect(result.commands).toBeUndefined()
    expect(result.model.notice).toContain('Select at least one')
  })
  test('a duplicate command retry retains the original payload and command ID', () => {
    const submitted = update(base(), RequestedAnalysis()).model
    const failed = update(submitted, FailedMutation({ generation: 0, error: 'Connection interrupted', retryable: true, unauthorized: false })).model
    const retried = update(failed, RequestedRetryCommand()).model
    expect(retried.mutation).toEqual(submitted.mutation)
    expect(retried.sequence).toBe(submitted.sequence)
  })
  test('a capture success reports the run and does not start analysis', () => {
    story(update, given({ ...base(), runId: '' }), message(RequestedCapture()), Command.expectHas(SubmitRequest),
      Command.resolve(SubmitRequest, SucceededMutationRun({ generation: 0, snapshot })),
      Command.resolve(LoadWorkspace, SucceededWorkspace.make({ generation: 1, workspace, history: [snapshot.run], library: [] })),
      Command.resolve(ReportRun, CompletedReport()),
      model(next => { expect(next.runId).toBe('run-1'); expect(next.analysisIds).toEqual(['one', 'two']); expect(next.mutation._tag).toBe('Ready') }),
    )
  })
  test('live remains the initial mode even when live configuration is missing', () => {
    const initial = initialModel({ apiUrl: '', projectId: '', runId: '' })
    expect(initial.input.evidenceMode).toBe('live')
    const received = update({ ...initial, session: base().session }, SucceededWorkspace.make({ generation: 0, workspace, history: [], library: [] }))
    expect(received.model.input.evidenceMode).toBe('live')
  })
  test('all four modes retain their input and validation constraints', () => {
    for (const mode of ['single', 'batch', 'domain', 'sitemap']) {
      const changed = update(base(), ChangedField({ key: 'mode', value: mode })).model
      expect(changed.input.mode).toBe(mode)
      expect(validateCapture(changed.input)).toBe('')
    }
    expect(validateCapture({ ...snapshot.run.input, desktop: false, mobile: false })).toContain('viewport')
    expect(validateCapture({ ...snapshot.run.input, maxPages: 51 })).toContain('1 to 50')
    expect(validateCapture({ ...snapshot.run.input, depth: 4 })).toContain('1 to 3')
    expect(validateCapture({ ...snapshot.run.input, source: 'not a url' })).toContain('complete website URL')
    expect(validateCapture({ ...snapshot.run.input, mode: 'batch', source: 'https://example.com/\n\n https://example.org/ ' })).toBe('')
  })
})

describe('context and session fences', () => {
  test('project attribute changes drop sensitive old data and ignore old replies', () => {
    const changed = update(base(), ChangedContext({ key: 'project', value: 'another-project' })).model
    expect(changed.projectId).toBe('another-project')
    expect(changed.runId).toBe('')
    expect(Option.isNone(AsyncData.getData(changed.snapshot))).toBe(true)
    expect(update(changed, SucceededSnapshot({ generation: 0, snapshot })).model).toBe(changed)
    expect(update(changed, FailedSnapshot({ generation: 0, error: 'late failure', unauthorized: true })).model).toBe(changed)
  })
  test('run and API URL attribute changes fence earlier replies', () => {
    for (const key of ['run', 'api'] satisfies Array<'run' | 'api'>) {
      const changed = update(base(), ChangedContext({ key, value: key === 'run' ? 'run-2' : 'http://127.0.0.1:3128' })).model
      expect(changed.generation).toBe(1)
      expect(update(changed, SucceededSnapshot({ generation: 0, snapshot })).model).toBe(changed)
    }
  })
  test('old revisions cannot overwrite a newer checkpoint', () => {
    const older: RunSnapshot = { ...snapshot, run: { ...snapshot.run, revision: 1, phase: 'queued' } }
    const current = base()
    expect(update(current, SucceededSnapshot({ generation: 0, snapshot: RunSnapshot.make(older) })).model).toBe(current)
  })
  test('a failed refresh retains review data with an explicit stale error', () => {
    const result = update(base(), FailedSnapshot({ generation: 0, error: 'Service offline', unauthorized: false })).model
    expect(result.snapshot._tag).toBe('Stale')
    expect(Option.getOrUndefined(AsyncData.getData(result.snapshot))?.run.id).toBe('run-1')
  })
  test('logout and new login invalidate in-flight replies', () => {
    const current = base()
    const logout = update(current, RequestedLogout()).model
    expect(logout.generation).toBe(1)
    expect(Option.isNone(AsyncData.getData(logout.snapshot))).toBe(true)
    expect(update(logout, SucceededSnapshot({ generation: 0, snapshot })).model).toBe(logout)
    const login = update({ ...logout, ownerToken: 'test-only-token' }, RequestedLogin()).model
    expect(login.generation).toBe(2)
    expect(login.ownerToken).toBe('')
  })
  test('mount starts with an owner-session read, never a durable task mutation', () => {
    const remounted = initialModel({ apiUrl: '', projectId: 'default', runId: 'run-1' })
    expect(remounted.mutation._tag).toBe('Ready')
    expect(remounted.session._tag).toBe('Loading')
    expect(remounted.runId).toBe('run-1')
    expect(builderRenderState(remounted)).toBe('loading')
  })
})

describe('reviewed transactional save UI', () => {
  test('Keep both explicitly sends create, while merge names its target', () => {
    const selected = update(base(), ToggledFinding({ findingId: 'finding-1' })).model
    expect(saveChoices(selected)).toEqual([{ findingId: 'finding-1', action: 'create', targetId: '' }])
    const merged = update(selected, ChoseDuplicate({ findingId: 'finding-1', action: 'merge' })).model
    expect(saveChoices(merged)).toEqual([{ findingId: 'finding-1', action: 'merge', targetId: 'existing-hero' }])
    const kept = update(merged, ChoseDuplicate({ findingId: 'finding-1', action: 'create' })).model
    expect(saveChoices(kept)).toEqual([{ findingId: 'finding-1', action: 'create', targetId: '' }])
  })
  test('save requires a current preview and carries both revisions', () => {
    const selected = update(base(), ToggledFinding({ findingId: 'finding-1' })).model
    expect(update(selected, RequestedSave()).commands).toBeUndefined()
    const ready = update(selected, SucceededPreview({ generation: 0, selectionRevision: selected.selectionRevision, preview })).model
    const saved = update(ready, RequestedSave()).model
    expect(saved.mutation._tag).toBe('Sending')
    if (saved.mutation._tag === 'Sending') expect(saved.mutation.request).toMatchObject({ _tag: 'SaveRequest', expectedRevision: 2, expectedProjectRevision: 1 })
  })
  test('selection changes invalidate previews and late preview responses', () => {
    const selected = update(base(), ToggledFinding({ findingId: 'finding-1' })).model
    const loading = update(selected, RequestedPreview()).model
    const changed = update(loading, ChoseDuplicate({ findingId: 'finding-1', action: 'merge' })).model
    expect(changed.preview._tag).toBe('Idle')
    expect(update(changed, SucceededPreview({ generation: 0, selectionRevision: selected.selectionRevision, preview })).model).toBe(changed)
    expect(update(changed, ClearedFindings()).model.findingIds).toEqual([])
  })
  test('only durable receipts mark a finding saved', () => {
    const claims = RunSnapshot.make({ ...snapshot, findings: snapshot.findings.map(finding => ({ ...finding, savedRecordId: 'claimed-record', saveReceiptId: 'claimed-receipt' })) })
    expect(savedFindingIds(claims)).toEqual([])
    const receipted = RunSnapshot.make({ ...claims, receipts: [{ id: 'receipt-1', commandId: 'cmd-1', projectId: 'default', runId: 'run-1', createdAt: '2026-10-15T12:03:00.000Z', records: [{ findingId: 'finding-1', recordId: 'library-1', action: 'create', cmsName: 'Hero2' }] }] })
    expect(savedFindingIds(receipted)).toEqual(['finding-1'])
  })
})

describe('rendered workflow and public surface', () => {
  test('setup renders four input modes, fixture labeling and server configuration gates', () => {
    scene({ update, view }, rendered({ ...base(), runId: '' }),
      expectAll(all.selector('.discovery-mode')).toHaveCount(4),
      see(selector('.discovery-setup')).toHaveText(/Capture screenshots/),
      see(selector('.discovery-setup')).toHaveText(/Analysis starts only/),
      see(selector('.discovery-config')).toHaveText(/Live provider setup is incomplete/),
    )
  })
  test('review has screenshots, explicit page selection, both result tabs and run logs', () => {
    scene({ update, view }, rendered(base()),
      see(selector('img[data-viewport="desktop"]')).toExist(),
      see(selector('.discovery-analysis-callout')).toHaveText(/Analyze selected pages/),
      see(selector('.discovery-findings-tabs')).toHaveText(/Components/),
      see(selector('.discovery-findings-tabs')).toHaveText(/Content types/),
      see(selector('.discovery-duplicate')).toHaveText(/Keep both/),
      see(selector('.discovery-logs')).toHaveText(/Capture completed/),
    )
  })
  test('CMS save preview displays the exact server-produced saved name', () => {
    scene({ update, view }, rendered({ ...base(), findingIds: ['finding-1'], preview: PreviewData.Success({ data: preview }) }),
      see(selector('.discovery-save-preview')).toHaveText(/Hero2/),
      see(selector('.discovery-save-preview')).toHaveText(/Create separate record/),
      see(selector('.discovery-save-preview')).toHaveText(/Save to project/),
    )
  })
  test('the declared live surface registers without runtime validation errors', () => {
    const subscribe = (): void => undefined
    expect(() => defineMicroDot<{ dispose: () => void }, typeof discoverySurface>({
      surface: discoverySurface, embed: () => ({ dispose: () => undefined }),
      publish: { 'run-selected': () => ({ subscribe }), 'project-selected': () => ({ subscribe }), 'findings-saved': () => ({ subscribe }) },
      receive: { 'api-url': () => undefined, 'project-id': () => undefined, 'run-id': () => undefined },
    })).not.toThrow()
  })
})


const agentSettings = SettingsSnapshot.make({
  settings: { revision: 1, updatedAt: '2026-10-15T12:00:00.000Z', values: {
    modelId: 'claude-budget', maxOutputTokens: 8192, reasoning: 'off', thinkingBudgetTokens: null,
    temperature: null, requestTimeoutMs: 120000, cacheRetention: 'short', maxDomChars: 30000,
    screenshotEvidence: 'both', extraInstructions: '', runLimitUsd: 5, monthlyLimitUsd: 100, attemptReservationUsd: 3,
  } },
  models: [
    { id: 'claude-budget', label: 'Claude with thinking budget', contextWindow: 200000, maxOutputTokens: 64000, reasoningLevels: ['off', 'low', 'high'], defaultReasoning: 'off', thinkingMode: 'budget', supportsTemperature: true, cacheRetentions: ['none', 'short', 'long'] },
    { id: 'claude-adaptive', label: 'Claude adaptive', contextWindow: 200000, maxOutputTokens: 32000, reasoningLevels: ['high', 'max'], defaultReasoning: 'high', thinkingMode: 'adaptive', supportsTemperature: false, cacheRetentions: ['none', 'short'] },
  ],
  evaluation: { analysisReady: true, issues: [], minimumReservationUsd: 2.4, effectiveMaxOutputTokens: 8192, effectiveThinkingBudgetTokens: null, effectiveReasoning: 'off' },
})
const openSettings = (): Model => {
  const opened = update(base(), RequestedSettings()).model
  return update(opened, SucceededSettings({ generation: opened.generation, settingsEpoch: opened.settingsEpoch, snapshot: agentSettings })).model
}
const editSetting = (current: Model, key: typeof ChangedSetting.Type['key'], value: string) => update(current, ChangedSetting({ key, value })).model
const previewSettings = (current: Model, evaluation: SettingsEvaluation = agentSettings.evaluation) => update(current, SucceededSettingsPreview({ generation: current.generation, settingsEpoch: current.settingsEpoch, draftRevision: current.settingsEditor?.draftRevision ?? 0, evaluation })).model

describe('agent settings preferences and request evidence', () => {
  test('opening settings reads only; every editable control is available with current budgets intact', () => {
    const result = update(base(), RequestedSettings())
    expect(result.commands).toHaveLength(1)
    expect(result.model.mutation._tag).toBe('Ready')
    const current = openSettings()
    expect(current.settingsEditor?.draft).toMatchObject({ maxOutputTokens: '8192', runLimitUsd: '5', monthlyLimitUsd: '100', attemptReservationUsd: '3' })
    scene({ update, view }, rendered(current),
      see(selector('.discovery-settings')).toHaveText(/An analysis already running keeps its settings/),
      see(selector('.discovery-settings')).toHaveText(/Additional analysis instructions/),
      expectAll(all.selector('.discovery-settings input')).toHaveCount(8),
      expectAll(all.selector('.discovery-settings select')).toHaveCount(4),
      see(selector('.discovery-settings-actions .discovery-button--primary')).toBeDisabled(),
    )
  })
  test('dirty values and their preview survive normal polling, while pristine values adopt newer saved settings', () => {
    const dirty = previewSettings(editSetting(openSettings(), 'extraInstructions', 'Inspect navigation and hero variants.'))
    const refreshed = update(dirty, SucceededSettings({ generation: 0, settingsEpoch: dirty.settingsEpoch, snapshot: agentSettings })).model
    expect(refreshed.settingsEditor).toEqual(dirty.settingsEditor)
    expect(settingsDirty(refreshed)).toBe(true)
    const fresh = { ...agentSettings, settings: { ...agentSettings.settings, revision: 2, values: { ...agentSettings.settings.values, maxOutputTokens: 16000 } } }
    const pristine = openSettings()
    const adopted = update(pristine, SucceededSettings({ generation: 0, settingsEpoch: pristine.settingsEpoch, snapshot: fresh })).model
    expect(adopted.settingsEditor?.draft.maxOutputTokens).toBe('16000')
    expect(settingsDirty(adopted)).toBe(false)
  })
  test('a draft conflict preserves edits, blocks saving, and reload explicitly discards them', () => {
    const dirty = previewSettings(editSetting(openSettings(), 'maxOutputTokens', '16000'))
    const newer = { ...agentSettings, settings: { ...agentSettings.settings, revision: 2, values: { ...agentSettings.settings.values, maxOutputTokens: 24000 } } }
    const conflicted = update(dirty, SucceededSettings({ generation: 0, settingsEpoch: dirty.settingsEpoch, snapshot: newer })).model
    expect(conflicted.settingsEditor?.draft.maxOutputTokens).toBe('16000')
    expect(conflicted.settingsEditor?.base.revision).toBe(1)
    expect(update(conflicted, RequestedSettingsSave()).commands).toBeUndefined()
    scene({ update, view }, rendered(conflicted), see(selector('.discovery-settings')).toHaveText(/Your draft is still here/), see(selector('.discovery-settings')).toHaveText(/Reload saved settings/))
    const reloaded = update(conflicted, ReloadedSettings()).model
    expect(reloaded.settingsEditor?.draft.maxOutputTokens).toBe('24000')
    expect(reloaded.settingsEditor?.base.revision).toBe(2)
    expect(reloaded.settingsEditor?.preview._tag).toBe('Idle')
  })
  test('preview and read replies are fenced across edits, close/reopen, project, API and session changes', () => {
    const current = openSettings()
    const previewReply = SucceededSettingsPreview({ generation: 0, settingsEpoch: current.settingsEpoch, draftRevision: current.settingsEditor!.draftRevision, evaluation: agentSettings.evaluation })
    const edited = editSetting(current, 'maxOutputTokens', '16000')
    expect(update(edited, previewReply).model).toBe(edited)
    const closed = update(edited, ClosedSettings()).model
    const reopened = update(closed, RequestedSettings()).model
    expect(update(reopened, previewReply).model).toBe(reopened)
    for (const key of ['project', 'api', 'run'] as const) {
      const moved = update(current, ChangedContext({ key, value: key === 'api' ? 'http://localhost:9999' : 'other' })).model
      expect(moved.settingsOpen).toBe(false)
      expect(update(moved, previewReply).model).toBe(moved)
    }
    const signedOut = update(current, RequestedLogout()).model
    expect(signedOut.settingsEditor).toBeNull()
    expect(signedOut.settings._tag).toBe('Idle')
    expect(update(signedOut, SucceededSettings({ generation: 0, settingsEpoch: current.settingsEpoch, snapshot: agentSettings })).model).toBe(signedOut)
  })
  test('server preview is explicit and invalid input or a stale preview cannot save', () => {
    const dirty = editSetting(openSettings(), 'maxOutputTokens', '16000')
    expect(update(dirty, RequestedSettingsSave()).commands).toBeUndefined()
    const requested = update(dirty, RequestedSettingsPreview())
    expect(requested.commands).toHaveLength(1)
    expect(requested.model.settingsEditor?.preview._tag).toBe('Loading')
    expect(requested.model.mutation._tag).toBe('Ready')
    const invalid = update(editSetting(dirty, 'maxOutputTokens', ''), RequestedSettingsPreview())
    expect(invalid.commands).toBeUndefined()
    expect(invalid.model.settingsEditor?.preview._tag).toBe('Failure')
    const valid = previewSettings(dirty)
    expect(editSetting(valid, 'maxDomChars', '10000').settingsEditor?.preview._tag).toBe('Idle')
    expect(settingsValues({ ...settingsDraft(agentSettings.settings.values), reasoning: 'provider-default', temperature: '', runLimitUsd: '' })).toMatchObject({ reasoning: null, temperature: null, runLimitUsd: null })
    expect(settingsValues({ ...settingsDraft(agentSettings.settings.values), maxOutputTokens: 'Infinity' })).toBeUndefined()
  })
  test('unsupported fields reset on model change with explanation; compatible preferences and budgets remain', () => {
    let current = openSettings()
    current = editSetting(current, 'temperature', '.3')
    current = editSetting(current, 'cacheRetention', 'long')
    current = editSetting(current, 'maxOutputTokens', '64000')
    current = editSetting(current, 'extraInstructions', 'Focus on content models.')
    const changed = editSetting(current, 'modelId', 'claude-adaptive')
    expect(changed.settingsEditor?.draft).toMatchObject({ modelId: 'claude-adaptive', reasoning: 'provider-default', temperature: '', cacheRetention: 'none', maxOutputTokens: '32000', extraInstructions: 'Focus on content models.', runLimitUsd: '5', monthlyLimitUsd: '100', attemptReservationUsd: '3' })
    expect(changed.settingsEditor?.notice).toContain('Temperature returned')
    scene({ update, view }, rendered(changed),
      see(selector('.discovery-settings select')).toHaveValue('claude-adaptive'),
      expectAll(all.selector('.discovery-settings option[value="off"]')).toHaveCount(0),
    )
  })
  test('reasoning turns off incompatible temperature and thinking budget only when necessary', () => {
    const sampling = editSetting(openSettings(), 'temperature', '.3')
    const thinking = editSetting(sampling, 'reasoning', 'high')
    expect(thinking.settingsEditor?.draft.temperature).toBe('')
    const budget = editSetting(thinking, 'thinkingBudgetTokens', '4096')
    expect(editSetting(budget, 'reasoning', 'low').settingsEditor?.draft.thinkingBudgetTokens).toBe('4096')
    expect(editSetting(budget, 'reasoning', 'off').settingsEditor?.draft.thinkingBudgetTokens).toBe('')
  })
  test('settings save carries reviewed values and revision; success does not submit analysis or retry', () => {
    const dirty = previewSettings(editSetting(openSettings(), 'maxOutputTokens', '16000'))
    const submitted = update(dirty, RequestedSettingsSave()).model
    expect(submitted.mutation._tag).toBe('Sending')
    if (submitted.mutation._tag === 'Sending') expect(submitted.mutation.request).toMatchObject({ _tag: 'SettingsRequest', expectedRevision: 1, values: { maxOutputTokens: 16000, runLimitUsd: 5, monthlyLimitUsd: 100, attemptReservationUsd: 3 } })
    const saved = { ...agentSettings, settings: { ...agentSettings.settings, revision: 2, values: { ...agentSettings.settings.values, maxOutputTokens: 16000 } } }
    const result = update(submitted, SucceededMutationSettings({ generation: 0, snapshot: saved }))
    expect(result.commands).toHaveLength(3)
    expect(result.model.mutation._tag).toBe('Ready')
    expect(AsyncData.getData(result.model.snapshot)).toEqual(AsyncData.getData(submitted.snapshot))
    expect(settingsDirty(result.model)).toBe(false)
    expect(result.model.notice).toContain('next analysis')
  })
  test('saving while a run poll is pending reissues the snapshot in the new generation', () => {
    const pending = { ...previewSettings(editSetting(openSettings(), 'maxOutputTokens', '16000')), snapshot: SnapshotData.Refreshing({ data: snapshot }) }
    const submitted = update(pending, RequestedSettingsSave()).model
    const saved = { ...agentSettings, settings: { ...agentSettings.settings, revision: 2, values: { ...agentSettings.settings.values, maxOutputTokens: 16000 } } }
    const success = update(submitted, SucceededMutationSettings({ generation: 0, snapshot: saved }))
    expect(success.commands).toHaveLength(3)
    expect(success.model.generation).toBe(1)
    const received = update(success.model, SucceededSnapshot({ generation: 1, snapshot })).model
    const ready = update(received, SucceededWorkspace({ generation: 1, workspace, history: [snapshot.run], library: [] })).model
    expect(ready.snapshot._tag).toBe('Success')
    expect(update(ready, Ticked()).commands?.length).toBeGreaterThan(0)
  })
  test('settings-save generation changes release unrelated pending export and finding-preview buttons', () => {
    const pending: Model = { ...previewSettings(editSetting(openSettings(), 'maxOutputTokens', '16000')), exported: AsyncData.Loading(), preview: AsyncData.Loading() }
    const submitted = update(pending, RequestedSettingsSave()).model
    const result = update(submitted, SucceededMutationSettings({ generation: 0, snapshot: agentSettings })).model
    expect(result.exported._tag).toBe('Idle')
    expect(result.preview._tag).toBe('Idle')
    const completed: Model = { ...submitted, preview: PreviewData.Success({ data: preview }), exported: AsyncData.Success({ data: { filename: 'project.json', json: '{}' } }) }
    const preserved = update(completed, SucceededMutationSettings({ generation: 0, snapshot: agentSettings })).model
    expect(preserved.preview).toEqual(completed.preview)
    expect(preserved.exported).toEqual(completed.exported)
  })
  test('an interrupted save retains exact command ID and payload and cannot be replaced by edits or analysis', () => {
    const submitted = update(previewSettings(editSetting(openSettings(), 'maxOutputTokens', '16000')), RequestedSettingsSave()).model
    const refused = update(submitted, FailedMutation({ generation: 0, error: 'Connection interrupted', retryable: true, unauthorized: false })).model
    expect(editSetting(refused, 'maxOutputTokens', '32000')).toBe(refused)
    expect(update(refused, ReloadedSettings()).model).toBe(refused)
    expect(update(refused, ClosedSettings()).model).toBe(refused)
    expect(update(refused, RequestedAnalysis()).model).toBe(refused)
    expect(update(refused, RequestedRetryCommand()).model.mutation).toEqual(submitted.mutation)
  })
  test('a rejected save retains its draft and can recover after explicit reload', () => {
    const submitted = update(previewSettings(editSetting(openSettings(), 'maxOutputTokens', '16000')), RequestedSettingsSave()).model
    const rejected = update(submitted, FailedMutation({ generation: 0, error: 'Analysis settings changed. Reload saved settings.', retryable: false, unauthorized: false })).model
    expect(rejected.settingsEditor?.draft.maxOutputTokens).toBe('16000')
    const newer = { ...agentSettings, settings: { ...agentSettings.settings, revision: 2 } }
    const received = update(rejected, SucceededSettings({ generation: 0, settingsEpoch: rejected.settingsEpoch, snapshot: newer })).model
    expect(update(received, ReloadedSettings()).model.mutation._tag).toBe('Ready')
  })
  test('an initial settings load failure has an explicit working retry', () => {
    const opened = update(base(), RequestedSettings()).model
    const failed = update(opened, FailedSettings({ generation: 0, settingsEpoch: opened.settingsEpoch, error: 'Service offline', unauthorized: false })).model
    expect(failed.settingsEditor).toBeNull()
    const retried = update(failed, RequestedSettings())
    expect(retried.commands).toHaveLength(1)
    expect(retried.model.settings._tag).toBe('Loading')
    expect(retried.model.settingsEpoch).toBe(failed.settingsEpoch + 1)
  })
  test('revert and cancel discard only unsaved edits, while load errors keep the editor recoverable', () => {
    const dirty = editSetting(openSettings(), 'extraInstructions', 'Draft')
    expect(settingsDirty(update(dirty, RevertedSettings()).model)).toBe(false)
    const failed = update(dirty, FailedSettings({ generation: 0, settingsEpoch: dirty.settingsEpoch, error: 'Service offline', unauthorized: false })).model
    expect(failed.settingsEditor?.draft.extraInstructions).toBe('Draft')
    expect(failed.settings._tag).toBe('Stale')
    const refused = update(dirty, FailedSettingsPreview({ generation: 0, settingsEpoch: dirty.settingsEpoch, draftRevision: dirty.settingsEditor!.draftRevision, error: 'Evidence cannot be empty', unauthorized: false })).model
    expect(refused.settingsEditor?.preview._tag).toBe('Failure')
    expect(update(dirty, ClosedSettings()).model.settingsEditor).toBeNull()
  })
  test('attempt details display frozen settings and disclose shortened stored response excerpts', () => {
    const attempt = { id: 'attempt-settings', pageId: 'one', status: 'completed' as const, settings: { settingsRevision: 1, settingsUpdatedAt: agentSettings.settings.updatedAt, admittedAt: agentSettings.settings.updatedAt, values: agentSettings.settings.values, effectiveMaxOutputTokens: 8192, effectiveThinkingBudgetTokens: null, effectiveReasoning: 'off' as const, minimumReservationUsd: 2.4, promptVersion: 'discovery-json-v1' }, usage: null, reservedUsd: 0, spentUsd: .02, diagnostic: '', rawResponseTruncated: true, rawResponseChars: 50000 }
    scene({ update, view }, rendered({ ...base(), snapshot: SnapshotData.Success({ data: { ...snapshot, analysisAttempts: [attempt] } }) }),
      see(selector('.discovery-attempts')).toHaveText(/Settings version 1/),
      see(selector('.discovery-attempts')).toHaveText(/8,192/),
      see(selector('.discovery-attempts')).toHaveText(/Analysis validation used the full response/),
    )
  })
})

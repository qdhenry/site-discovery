import {
  CapabilityHandlersLive,
  CapabilityRpcs,
  CapabilityServicesLive,
} from './capabilities.ts'
import { DomainHandlersLive } from './domain.handlers.ts'
import { DomainRpcs } from '../src/contract.ts'
import { Effect, Layer } from 'effect'
import { RpcSerialization, RpcServer } from 'effect/unstable/rpc'

import { DiscoveryError, DiscoveryRpcs } from '../src/contract.ts'
import type { RequestHeaders } from './auth.ts'
import { currentRuntime } from './runtime.ts'

const guarded = <T>(
  headers: RequestHeaders,
  action: (
    runtime: Awaited<ReturnType<typeof currentRuntime>>,
    sessionId: string,
  ) => Promise<T>,
) =>
  Effect.tryPromise({
    try: async () => {
      const runtime = await currentRuntime()
      const sessionId = runtime.sessions.require(headers)
      return action(runtime, sessionId)
    },
    catch: error =>
      error instanceof DiscoveryError
        ? error
        : new DiscoveryError({
            code: 'storage',
            message:
              'Discovery storage operation failed; refresh before retrying',
            retryable: true,
          }),
  })
export const HandlersLive = DiscoveryRpcs.toLayer(
  Effect.succeed({
    getDiscoverySettings: (_input, options) =>
      guarded(options.headers, runtime => runtime.engine.getSettings()),
    refreshDiscoveryModels: (_input, options) =>
      guarded(options.headers, runtime => runtime.engine.getSettings(true)),
    previewDiscoverySettings: (input, options) =>
      guarded(options.headers, runtime =>
        runtime.engine.previewSettings(input.values),
      ),
    saveDiscoverySettings: (input, options) =>
      guarded(options.headers, runtime => runtime.engine.saveSettings(input)),
    getDiscoveryWorkspace: (_input, options) =>
      guarded(options.headers, (runtime, id) => runtime.engine.workspace(id)),
    createDiscoveryProject: (input, options) =>
      guarded(options.headers, runtime => runtime.engine.project(input)),
    getDiscoveryHistory: (input, options) =>
      guarded(options.headers, runtime =>
        runtime.engine.history(input.projectId),
      ),
    getDiscoveryRun: (input, options) =>
      guarded(options.headers, runtime =>
        runtime.engine.getRun(input.projectId, input.runId),
      ),
    getDiscoveryLogs: (input, options) =>
      guarded(options.headers, runtime =>
        runtime.engine.logs(input.projectId, input.runId, input.afterSeq),
      ),
    createDiscoveryCapture: (input, options) =>
      guarded(options.headers, runtime => runtime.engine.createCapture(input)),
    analyzeDiscoveryPages: (input, options) =>
      guarded(options.headers, runtime => runtime.engine.analyze(input)),
    retryDiscoveryRun: (input, options) =>
      guarded(options.headers, runtime => runtime.engine.retry(input)),
    previewDiscoverySave: (input, options) =>
      guarded(options.headers, runtime => runtime.engine.previewSave(input)),
    saveDiscoveryFindings: (input, options) =>
      guarded(options.headers, runtime => runtime.engine.save(input)),
    getDiscoveryLibrary: (input, options) =>
      guarded(options.headers, runtime =>
        runtime.engine.library(input.projectId),
      ),
    exportDiscoveryProject: (input, options) =>
      guarded(options.headers, runtime =>
        runtime.engine.exportProject(input.projectId),
      ),
    deleteDiscoveryRun: (input, options) =>
      guarded(options.headers, runtime => runtime.engine.deleteRun(input)),
  }),
)
export const RpcAppLayer = RpcServer.layerHttp({
  group: DiscoveryRpcs.merge(DomainRpcs).merge(CapabilityRpcs),
  path: '/rpc',
  protocol: 'http',
}).pipe(
  Layer.provide(Layer.mergeAll(HandlersLive, DomainHandlersLive, CapabilityHandlersLive)),
  Layer.provide(CapabilityServicesLive),
  Layer.provide(RpcSerialization.layerNdjson),
)

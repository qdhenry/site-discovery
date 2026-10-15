import {
  makeRpcService,
  rpcServiceOptionsForBuilderPreview,
  runRpcService,
} from '@bespokeagentics/microdots-runtime/service'

import { RpcAppLayer } from './handlers.ts'
import { ExtraRoutes, ROUTE_OWNED_CORS_PREFIXES } from './routes.ts'
import { closeRuntime, initializeRuntime } from './runtime.ts'

const PORT = 3193
await initializeRuntime(PORT)
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.once(signal, () => {
    void closeRuntime().finally(() => process.exit(0))
  })
console.log(
  `Site Discovery: http://127.0.0.1:${PORT}/ — local owner token: ${process.env.DISCOVERY_STATE_DIR || '.local/discovery'}/owner-token`,
)
runRpcService(
  makeRpcService({
    rpcLayer: RpcAppLayer,
    ...rpcServiceOptionsForBuilderPreview(PORT),
    host: '127.0.0.1',
    extraRoutes: ExtraRoutes,
    allowedOrigins: [`http://127.0.0.1:${PORT}`, `http://localhost:${PORT}`],
    allowedMethods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
    routeOwnedCorsPrefixes: ROUTE_OWNED_CORS_PREFIXES,
    trace: 'off',
  }),
)

// Browser-safe surface ONLY.
export * from './evidence.ts'
//
// The Node service helpers live behind "@bespokeagentics/microdots-runtime/service" on purpose: a
// single barrel that re-exported them would drag @effect/platform-node and
// node:http into every MicroDot's browser bundle.
// The storage failure a D1 adapter raises. Schema-only — `./d1` also exports
// `d1Try`, which no browser bundle should pull in — so a MicroDot CONTRACT
// imports it from here, exactly as it imports `IngestRejected` below. Importing
// it from the subpath breaks the browser build: every dot's `vite.config.ts`
// aliases the BARE package specifier to this file, and rollup rewrites the
// subpath under that match to `.../src/index.ts/d1`.
export { StorageFailure } from './d1.ts'
export {
  LlmMonetaryEvidence,
  LlmMonetarySummary,
} from './llmMonetaryEvidence.ts'
// The refusal a front shows when a PIN gate says no, and the policy it states.
// Plain data and a string function: the gate itself stays behind `./secret`.
export { SECRET_ATTEMPT_POLICY, secretRefusalSentence } from './secretPolicy.ts'
// The marker a CONTRACT puts on an RPC it publishes, and the one list the REST
// facade and the OpenAPI deriver both read. Effect core and `unstable/rpc`
// only, so a contract imports it from here like `StorageFailure` above.
export {
  DEFAULT_PUBLIC_API_STATUS,
  PUBLIC_API_PREFIX,
  PayloadRejected,
  PublicApi,
  type PublicApiAnnotation,
  type PublicApiRefusal,
  type PublicApiRefusalReason,
  type PublicApiStatus,
  type PublicOperation,
  type PublicOperations,
  type PublishableGroup,
  type PublishableRpc,
  publicOperationPath,
  publicOperations,
} from './publicApi.ts'
export {
  identityRpcProtocolLayer,
  makeIdentityRpcClientLive,
  makeRpcClientLive,
  rpcProtocolLayer,
  RpcSerialization,
} from './client.ts'
// The contract half of the identity gate: the middleware tag a contract marks
// an RPC with, the identity a gated handler reads and the wire error. The
// verifier is server-only and lives in ./identity.
export {
  Authenticated,
  CurrentIdentity,
  IDENTITY_HEADER,
  type Identity,
  Unauthenticated,
  UnauthenticatedReason,
  hasRole,
} from './identityContract.ts'
export {
  DEPLOYED_HOST_ORIGIN,
  DEPLOYED_SHELL_ORIGINS,
  HOST_SHELL_ORIGIN,
  PLATFORM_SERVICE_ORIGINS,
  PLATFORM_SHELL_ORIGIN,
  MICRODOT_ORIGINS,
  microDotCors,
} from './cors.ts'
// The collector's wire format and the attribute-key vocabulary. Schema-only, so
// a MicroDot contract can import it from here without the browser bundle ever
// seeing the emitter in ./trace.
export {
  AGENT_TURNS_KEY,
  AGENT_TURN_KEY,
  ARGS_KEY,
  ATTRIBUTES_EVENT,
  COST_USD_KEY,
  CollectorEventSchema,
  type CollectorEvent,
  IngestRejected,
  IngestRpcs,
  ingestEventsRpc,
  isSeverity,
  isTraceEvent,
  LogEvent,
  MODEL_KEY,
  RESULT_KEY,
  SEVERITY_ORDER,
  Severity,
  severityAtLeast,
  STEP_KEY,
  SpanEndEvent,
  SpanEventEvent,
  SpanStartEvent,
  DURATION_MS_KEY,
  TOKENS_IN_KEY,
  TOKENS_OUT_KEY,
  TOOL_CALLS_KEY,
  TOOL_KEY,
  TOOL_NAME_KEY,
  TTFT_MS_KEY,
  TraceEndEvent,
  TraceEventSchema,
  type TraceEvent,
  TraceScope,
  TraceStartEvent,
} from './traceEvent.ts'

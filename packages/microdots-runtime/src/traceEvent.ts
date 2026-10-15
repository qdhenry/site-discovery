import { Schema as S } from 'effect'
import { Rpc, RpcGroup } from 'effect/unstable/rpc'

import { StorageFailure } from './d1.ts'

// The collector's wire format. Effect Schema and `effect/unstable/rpc` only, so
// this file is safe in a browser bundle, a Bun service and a Workers isolate
// alike — it is re-exported from BOTH the bare entry and `./trace` for that
// reason. A MicroDot's `src/contract.ts` imports it from the bare entry: every
// MicroDot vite config aliases only `@bespokeagentics/microdots-runtime`, and a
// subpath import from browser code would prefix-match into `src/index.ts/trace`.
//
// The five trace variants are livetrace's wire format, declared here rather than
// imported from the library. livetrace 0.1.2 is built against effect beta.84 and
// pulling its entry point into a browser bundle renders a blank panel with a
// clean console (`wiki/patterns-and-traps/livetrace-import-poisons-the-browser-bundle.md`).
// `microdots/bespoke-chat/service/traceFormat.test.ts` runs the real tracer and
// proves every event it emits still decodes here.

/** Effect's own log levels, minus the `All` / `None` sentinels a log line never carries. */
export const Severity = S.Literals([
  'Fatal',
  'Error',
  'Warn',
  'Info',
  'Debug',
  'Trace',
])
export type Severity = typeof Severity.Type

/** Most severe first, so "at least `Warn`" is an index comparison. */
export const SEVERITY_ORDER: ReadonlyArray<Severity> = [
  'Fatal',
  'Error',
  'Warn',
  'Info',
  'Debug',
  'Trace',
]

export const isSeverity = (value: string): value is Severity =>
  SEVERITY_ORDER.some(level => level === value)

/** `true` when `level` is at least as severe as `floor`. */
export const severityAtLeast = (level: Severity, floor: Severity): boolean =>
  SEVERITY_ORDER.indexOf(level) <= SEVERITY_ORDER.indexOf(floor)

/**
 * livetrace's scope, plus `service` — the collector's own scope for a trace a
 * MicroDot service emitted about itself rather than on behalf of a user.
 */
export const TraceScope = S.Struct({
  type: S.Literals(['team', 'org', 'user', 'service']),
  id: S.String,
})
export type TraceScope = typeof TraceScope.Type

export const TraceStartEvent = S.Struct({
  _tag: S.tag('TraceStart'),
  traceId: S.String,
  label: S.String,
  scope: TraceScope,
  timestamp: S.Number,
})

export const SpanStartEvent = S.Struct({
  _tag: S.tag('SpanStart'),
  traceId: S.String,
  spanId: S.String,
  parentSpanId: S.optional(S.String),
  name: S.String,
  attributes: S.Record(S.String, S.Unknown),
  timestamp: S.Number,
})

export const SpanEndEvent = S.Struct({
  _tag: S.tag('SpanEnd'),
  traceId: S.String,
  spanId: S.String,
  status: S.Literals(['ok', 'error']),
  durationMs: S.Number,
  timestamp: S.Number,
})

export const SpanEventEvent = S.Struct({
  _tag: S.tag('SpanEvent'),
  traceId: S.String,
  spanId: S.String,
  name: S.String,
  level: S.optional(S.Literals(['Debug', 'Info', 'Warning', 'Error'])),
  attributes: S.optional(S.Record(S.String, S.Unknown)),
  timestamp: S.Number,
})

export const TraceEndEvent = S.Struct({
  _tag: S.tag('TraceEnd'),
  traceId: S.String,
  status: S.Literals(['completed', 'failed']),
  durationMs: S.Number,
  error: S.optional(S.String),
  timestamp: S.Number,
})

/**
 * A log line. Its own variant rather than a `SpanEvent` with a level: a log
 * written outside any span has no span to hang on, and inventing ids for it
 * would put phantom rows into every span fold. When a span IS current its ids
 * ride along so the inspector can show the line beside the span's cards.
 */
export const LogEvent = S.Struct({
  _tag: S.tag('Log'),
  level: Severity,
  message: S.String,
  timestamp: S.Number,
  traceId: S.optional(S.String),
  spanId: S.optional(S.String),
  attributes: S.Record(S.String, S.Unknown),
})
export type LogEvent = typeof LogEvent.Type

/** livetrace's five variants — what `withTrace` / `step` emit. */
export const TraceEventSchema = S.Union([
  TraceStartEvent,
  SpanStartEvent,
  SpanEndEvent,
  SpanEventEvent,
  TraceEndEvent,
])
export type TraceEvent = typeof TraceEventSchema.Type

/** Everything the collector accepts: the five trace variants plus `Log`. */
export const CollectorEventSchema = S.Union([
  TraceStartEvent,
  SpanStartEvent,
  SpanEndEvent,
  SpanEventEvent,
  TraceEndEvent,
  LogEvent,
])
export type CollectorEvent = typeof CollectorEventSchema.Type

export const isTraceEvent = (event: CollectorEvent): event is TraceEvent =>
  event._tag !== 'Log'

// ATTRIBUTE KEYS
//
// The vocabulary an emitter writes and an inspector reads. One list, shared by
// both sides, so a key renamed on one side is a type error on the other rather
// than a card that quietly renders with no chips.

/** Marks a span the inspector should draw as a step card. */
export const STEP_KEY = 'ui.step'
/** Marks a step card as a tool call. */
export const TOOL_KEY = 'ui.tool'
export const MODEL_KEY = 'llm.model'
export const TOKENS_IN_KEY = 'tokens.in'
export const TOKENS_OUT_KEY = 'tokens.out'
export const ARGS_KEY = 'tool.args'
export const RESULT_KEY = 'tool.result'
export const COST_USD_KEY = 'cost.usd'
export const TTFT_MS_KEY = 'ttft.ms'
/**
 * Agent-shaped spans. These five were emitted and read across three MicroDots
 * — `bespoke-chat` writes all of them, `livetrace` reads `tool.name` and
 * `agent.turn` to decide which chips a card already shows, and `workbench`'s
 * build pipeline writes `tool.name` — while living nowhere but as bare string
 * literals at each site. They belong on this list for the same reason the nine
 * above do: the vocabulary is shared, so it is declared once.
 */
export const TOOL_NAME_KEY = 'tool.name'
/** Which model call within the turn this span belongs to. */
export const AGENT_TURN_KEY = 'agent.turn'
/** How many model calls the finished turn took. */
export const AGENT_TURNS_KEY = 'agent.turns'
/** Wall-clock duration the agent reported for the finished turn. */
export const DURATION_MS_KEY = 'duration.ms'
/** How many tool calls the finished turn made. */
export const TOOL_CALLS_KEY = 'tool.calls'
/**
 * The name of the `SpanEvent` the runtime tracer emits on `end` carrying every
 * attribute set after the span opened. A `SpanStart` goes out the moment the
 * span is constructed, before `Effect.withSpan` has applied its own attributes,
 * and a `SpanEnd` has no attribute field to carry them.
 */
export const ATTRIBUTES_EVENT = 'attributes'

// INGEST

export class IngestRejected extends S.TaggedError<IngestRejected>(
  'IngestRejected',
)('IngestRejected', {
  reason: S.Literals(['unauthorized', 'source-disabled']),
}) {}

/**
 * One batch from one source. `source` rides on the envelope, not on every
 * event, because a batch is always from exactly one emitter; `key` is the
 * shared ingest secret the collector verifies per call.
 *
 * The error channel carries `StorageFailure` beside `IngestRejected` because
 * the collector genuinely can fail to STORE a batch, and neither
 * `IngestRejected` reason can say so — `unauthorized` and `source-disabled`
 * are a closed literal union, and answering with either would send an operator
 * to check a key that is fine. Without it the collector's only recourse is
 * `Effect.die`, which the RPC server sends as a connection-level `Defect`
 * frame no `Effect.catch` can reach (see `./d1.ts`). Emitters are unaffected:
 * `makeTraceTransport` discharges anything that is not `IngestRejected` with
 * `Effect.catchCause` (`./trace.ts:130`), warning once and dropping the batch.
 */
export const ingestEventsRpc = Rpc.make('ingestEvents', {
  payload: S.Struct({
    source: S.NonEmptyString,
    key: S.String,
    events: S.Array(CollectorEventSchema),
  }),
  success: S.Struct({ accepted: S.Number, dropped: S.Number }),
  error: S.Union([IngestRejected, StorageFailure]),
})

/** The group an emitter speaks. The collector merges it into its own. */
export const IngestRpcs = RpcGroup.make(ingestEventsRpc)
export type IngestRpcs = typeof IngestRpcs

import {
  Cause,
  Context,
  Effect,
  Exit,
  Layer,
  Logger,
  type LogLevel,
  Option,
  References,
  Tracer,
} from 'effect'
import { RpcClient } from 'effect/unstable/rpc'

import { rpcProtocolLayer } from './client'
import {
  ATTRIBUTES_EVENT,
  type CollectorEvent,
  type IngestRejected,
  IngestRpcs,
  isSeverity,
  type Severity,
} from './traceEvent'

export * from './traceEvent'

// The emitter half of the universal logger.
//
// Platform-neutral on purpose: Effect core, `effect/unstable/rpc` and the fetch
// client — nothing from `node:*` or `@effect/platform-node`. `service.ts` (Bun)
// and `worker.ts` (Workers) both install it from their environment, so a
// MicroDot service becomes a source by setting three variables and changing no
// code: every `Effect.withSpan` becomes a span, every `Effect.log*` a log line,
// and every RPC call already runs inside a span the server opens
// (`effect/unstable/rpc/RpcServer.ts` wraps each request in `withSpan`).

/**
 * Where events go. `emit` is synchronous because `Tracer.span` and
 * `Logger.log` are synchronous — the sink buffers and a forked fiber ships.
 */
export type LiveTraceSinkShape = {
  readonly source: string
  readonly emit: (event: CollectorEvent) => void
  /** Ships everything buffered. Never fails. */
  readonly flush: Effect.Effect<void>
}

export class LiveTraceSink extends Context.Service<
  LiveTraceSink,
  LiveTraceSinkShape
>()('@bespokeagentics/microdots-runtime/LiveTraceSink') {}

export type TraceTransportOptions = {
  readonly collectorUrl: string
  /** The name the collector files these events under. */
  readonly source: string
  /** The shared ingest secret. */
  readonly key: string
  /** How often the buffer ships. Default 250ms. */
  readonly flushIntervalMs?: number
  /** Largest single ingest call. Default 200 events. */
  readonly maxBatch?: number
  /** Buffered events kept while the collector is unreachable; oldest drop first. Default 5000. */
  readonly capacity?: number
}

const DEFAULT_FLUSH_INTERVAL_MS = 250
const DEFAULT_MAX_BATCH = 200
const DEFAULT_CAPACITY = 5_000
const INGEST_TIMEOUT_MS = 2_000

/**
 * Batches events to the collector's `ingestEvents` RPC.
 *
 * The host program never fails because the collector is down: a failed ship
 * drops that batch and warns once to the console. The flush loop is forked on
 * the layer's scope, and a finalizer flushes on teardown — in a Worker that is
 * the per-request `dispose()`, which is what gets a short request's events out
 * before the isolate moves on.
 */
export const makeTraceTransport = (
  options: TraceTransportOptions,
): Layer.Layer<LiveTraceSink> => {
  const flushIntervalMs = options.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS
  const maxBatch = options.maxBatch ?? DEFAULT_MAX_BATCH
  const capacity = options.capacity ?? DEFAULT_CAPACITY

  const program = Effect.gen(function* () {
    const client = yield* RpcClient.make(IngestRpcs, { disableTracing: true })
    const buffer: Array<CollectorEvent> = []
    let warned = false

    const warnOnce = (message: string): Effect.Effect<void> =>
      Effect.sync(() => {
        if (warned) {
          return
        }
        warned = true
        console.warn(`livetrace: ${message}`)
      })

    // Two different situations, two different sentences: a collector that
    // refused the batch is configured and reachable — the key is wrong or an
    // admin disabled this source — and "could not reach" would send someone
    // checking the network.
    const unreachable = (cause: Cause.Cause<unknown>): Effect.Effect<void> =>
      warnOnce(
        `could not reach the collector at ${options.collectorUrl} — dropping events (${Cause.pretty(cause).split('\n')[0] ?? 'unknown cause'})`,
      )
    const refused = (rejection: IngestRejected): Effect.Effect<void> =>
      warnOnce(
        rejection.reason === 'source-disabled'
          ? `the collector at ${options.collectorUrl} has source "${options.source}" disabled — dropping events until an admin enables it`
          : `the collector at ${options.collectorUrl} rejected the ingest key for source "${options.source}" — dropping events; check LIVETRACE_INGEST_KEY on both sides`,
      )

    const shipOne: Effect.Effect<void> = Effect.suspend(() => {
      if (buffer.length === 0) {
        return Effect.void
      }
      const batch = buffer.splice(0, maxBatch)
      return client
        .ingestEvents({ source: options.source, key: options.key, events: batch })
        .pipe(
          Effect.timeout(INGEST_TIMEOUT_MS),
          Effect.asVoid,
          Effect.withTracerEnabled(false),
          Effect.catchTag('IngestRejected', refused),
          Effect.catchCause(unreachable),
        )
    })

    const flush: Effect.Effect<void> = shipOne.pipe(
      Effect.andThen(
        Effect.suspend(() => (buffer.length > 0 ? flush : Effect.void)),
      ),
    )

    yield* Effect.forkScoped(
      Effect.forever(Effect.sleep(flushIntervalMs).pipe(Effect.andThen(shipOne))),
    )
    yield* Effect.addFinalizer(() => flush)

    return {
      source: options.source,
      emit: (event: CollectorEvent) => {
        if (buffer.length >= capacity) {
          buffer.shift()
        }
        buffer.push(event)
      },
      flush,
    }
  })

  return Layer.effect(LiveTraceSink, program).pipe(
    Layer.provide(rpcProtocolLayer(options.collectorUrl)),
  )
}

/** An in-memory sink for tests: what would have shipped, in emission order. */
export const makeCollectingSink = (
  source = 'test',
): {
  readonly layer: Layer.Layer<LiveTraceSink>
  readonly events: () => ReadonlyArray<CollectorEvent>
} => {
  const collected: Array<CollectorEvent> = []
  return {
    layer: Layer.succeed(LiveTraceSink, {
      source,
      emit: (event: CollectorEvent) => {
        collected.push(event)
      },
      flush: Effect.void,
    }),
    events: () => collected,
  }
}

// TRACER

const NANOS_PER_MILLI = 1_000_000n

const toMillis = (nanos: bigint): number => Number(nanos / NANOS_PER_MILLI)

/**
 * A root, as the collector sees it: a span whose parent is not one this tracer
 * reported. That covers no parent, an `ExternalSpan` (a `traceparent` header
 * the server was handed), AND a native span opened above the emitter — the
 * HTTP middleware's `http.server` span, for one, which `HttpServer.serve` opens
 * outside any MicroDot layer. Reporting that as the parent would point every
 * RPC trace at a span the collector never receives.
 */
const reportedParent = (
  parent: Option.Option<Tracer.AnySpan>,
): Option.Option<EmittingSpan> =>
  Option.flatMap(parent, span =>
    span instanceof EmittingSpan ? Option.some(span) : Option.none(),
  )

const isRoot = (parent: Option.Option<Tracer.AnySpan>): boolean =>
  Option.isNone(reportedParent(parent))

/**
 * `NativeSpan` with the wire events bolted on. The parent class owns ids,
 * status and the attribute map; this one only reports.
 *
 * `SpanStart` leaves in the constructor, BEFORE `Effect.withSpan` applies its
 * `attributes` option (that happens via `attribute()` right after
 * construction), so the attributes set during the span's life go out on `end`
 * as one `SpanEvent` named `ATTRIBUTES_EVENT`. `event()` is deliberately a
 * no-op: the only thing that calls it is Effect's default `tracerLogger`,
 * and the log line it would duplicate already reaches the sink through the
 * logger below.
 */
class EmittingSpan extends Tracer.NativeSpan {
  readonly #sink: LiveTraceSinkShape

  constructor(
    options: ConstructorParameters<typeof Tracer.NativeSpan>[0],
    sink: LiveTraceSinkShape,
  ) {
    super(options)
    this.#sink = sink
    const timestamp = toMillis(options.startTime)
    if (isRoot(options.parent)) {
      sink.emit({
        _tag: 'TraceStart',
        traceId: this.traceId,
        label: options.name,
        scope: { type: 'service', id: sink.source },
        timestamp,
      })
    }
    sink.emit({
      _tag: 'SpanStart',
      traceId: this.traceId,
      spanId: this.spanId,
      ...Option.match(reportedParent(options.parent), {
        onNone: () => ({}),
        onSome: parent => ({ parentSpanId: parent.spanId }),
      }),
      name: options.name,
      attributes: {},
      timestamp,
    })
  }

  override end(endTime: bigint, exit: Exit.Exit<unknown, unknown>): void {
    super.end(endTime, exit)
    const timestamp = toMillis(endTime)
    const durationMs = Number(endTime - this.startTime) / 1_000_000
    if (this.attributes.size > 0) {
      this.#sink.emit({
        _tag: 'SpanEvent',
        traceId: this.traceId,
        spanId: this.spanId,
        name: ATTRIBUTES_EVENT,
        attributes: Object.fromEntries(this.attributes),
        timestamp,
      })
    }
    const failed = Exit.isFailure(exit)
    this.#sink.emit({
      _tag: 'SpanEnd',
      traceId: this.traceId,
      spanId: this.spanId,
      status: failed ? 'error' : 'ok',
      durationMs,
      timestamp,
    })
    if (isRoot(this.parent)) {
      this.#sink.emit({
        _tag: 'TraceEnd',
        traceId: this.traceId,
        status: failed ? 'failed' : 'completed',
        durationMs,
        ...(failed
          ? { error: Cause.pretty(exit.cause).split('\n')[0] ?? 'failed' }
          : {}),
        timestamp,
      })
    }
  }

  override event(): void {}
}

const makeEmittingTracer = (sink: LiveTraceSinkShape): Tracer.Tracer =>
  Tracer.make({ span: options => new EmittingSpan(options, sink) })

/** Replaces the fiber's tracer with one that reports every span to the sink. */
export const TraceTracerLive: Layer.Layer<never, never, LiveTraceSink> =
  Layer.effect(Tracer.Tracer, Effect.map(LiveTraceSink, makeEmittingTracer))

/**
 * Effect's default tracer, as a layer. livetrace's `LiveTraceLayer` wraps
 * whatever tracer is current; a service that runs livetrace INSIDE an emitting
 * shell provides this beneath it so livetrace's own spans are not also
 * reported by the emitting tracer — once is enough.
 */
export const NativeTracerLive: Layer.Layer<never> = Layer.succeed(
  Tracer.Tracer,
  Tracer.make({ span: options => new Tracer.NativeSpan(options) }),
)

// LOGGER

const toSeverity = (level: LogLevel.LogLevel): Severity =>
  isSeverity(level) ? level : 'Info'

const renderPart = (part: unknown): string => {
  if (typeof part === 'string') {
    return part
  }
  if (part instanceof Error) {
    return part.message
  }
  try {
    return JSON.stringify(part) ?? String(part)
  } catch {
    return String(part)
  }
}

const renderMessage = (message: unknown): string =>
  Array.isArray(message)
    ? message.map(renderPart).join(' ')
    : renderPart(message)

const makeEmittingLogger = (
  sink: LiveTraceSinkShape,
): Logger.Logger<unknown, void> =>
  Logger.make(({ message, logLevel, cause, fiber, date }) => {
    const annotations = fiber.getRef(References.CurrentLogAnnotations)
    const attributes: Record<string, unknown> = {
      ...annotations,
      'effect.fiberId': fiber.id,
    }
    if (cause.reasons.length > 0) {
      attributes['effect.cause'] = Cause.pretty(cause)
    }
    const span = fiber.currentSpan
    sink.emit({
      _tag: 'Log',
      level: toSeverity(logLevel),
      message: renderMessage(message),
      timestamp: date.getTime(),
      ...(span !== undefined && span._tag === 'Span'
        ? { traceId: span.traceId, spanId: span.spanId }
        : {}),
      attributes,
    })
  })

/** Adds a logger that reports every `Effect.log*` to the sink, keeping the existing loggers. */
export const TraceLoggerLive: Layer.Layer<never, never, LiveTraceSink> =
  Logger.layer([Effect.map(LiveTraceSink, makeEmittingLogger)], {
    mergeWithExisting: true,
  })

/** Both halves. Provide a sink beneath it. */
export const TraceEmitterLive: Layer.Layer<never, never, LiveTraceSink> =
  Layer.mergeAll(TraceTracerLive, TraceLoggerLive)

// ENVIRONMENT

export type TraceEnv = {
  readonly collectorUrl: string
  readonly source: string
  readonly key: string
}

export const TRACE_ENV_KEYS = {
  url: 'LIVETRACE_URL',
  source: 'LIVETRACE_SOURCE',
  key: 'LIVETRACE_INGEST_KEY',
}

const stringAt = (env: object, key: string): Option.Option<string> => {
  const value: unknown = Reflect.get(env, key)
  if (typeof value !== 'string') {
    return Option.none()
  }
  const trimmed = value.trim()
  return trimmed.length > 0 ? Option.some(trimmed) : Option.none()
}

/**
 * Reads the three variables from `process.env` or a Worker's bindings. All
 * three or nothing: a URL with no source or key is `None`, and the shells say
 * so at startup rather than emitting under a blank name.
 */
export const readTraceEnv = (env: unknown): Option.Option<TraceEnv> => {
  if (typeof env !== 'object' || env === null) {
    return Option.none()
  }
  return Option.all({
    collectorUrl: stringAt(env, TRACE_ENV_KEYS.url),
    source: stringAt(env, TRACE_ENV_KEYS.source),
    key: stringAt(env, TRACE_ENV_KEYS.key),
  })
}

/** The emitter, wired to a transport built from `env`, or `None` when unconfigured. */
export const traceEmitterFromEnv = (
  env: unknown,
): Option.Option<Layer.Layer<never>> =>
  Option.map(readTraceEnv(env), config =>
    TraceEmitterLive.pipe(Layer.provide(makeTraceTransport(config))),
  )

/** One line for a startup banner: what the shell decided. */
export const describeTraceEnv = (env: unknown): string =>
  Option.match(readTraceEnv(env), {
    onNone: () =>
      `livetrace: off (set ${TRACE_ENV_KEYS.url}, ${TRACE_ENV_KEYS.source} and ${TRACE_ENV_KEYS.key} to emit)`,
    onSome: config =>
      `livetrace: emitting to ${config.collectorUrl} as ${config.source}`,
  })

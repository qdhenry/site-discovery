import { Effect, Layer, Option, pipe } from 'effect'
import { HttpRouter, HttpServer, HttpServerRequest, type HttpServerResponse } from 'effect/unstable/http'
import { createServer } from 'node:http'

import { NodeHttpServer, NodeRuntime } from '@effect/platform-node'

import { MICRODOT_ORIGINS, microDotCors } from './cors'
import { describeTraceEnv, traceEmitterFromEnv } from './trace'
import type { RpcAppLayer } from './worker'

export {
  MICRODOT_ALIVE_URL_VARIABLE,
  keepAwakeWhile,
} from './containerActivity'
export { ALLOWED_ORIGINS_ENV_KEY, readAllowedOrigins } from './cors'
export {
  MICRODOT_STATE_ROOT_VARIABLE,
  resolveMicroDotStatePath,
  resolveMicroDotStateRoot,
} from './serviceState'

/**
 * Everything a MicroDot service needs after its RpcGroup, handlers and
 * serialization have been composed into one layer.
 *
 * The group/handler composition stays in the MicroDot, where the types are
 * concrete. Only the generic HTTP shell lives here.
 *
 * `RpcAppLayer` is defined in worker.ts — the platform-neutral module — so the
 * node and Cloudflare shells cannot drift apart. The import is type-only, so no
 * worker code reaches the node bundle.
 */
export type { RpcAppLayer }

export type RpcServiceOptions = {
  /** `RpcServer.layerHttp(...)` with handlers and serialization provided. */
  readonly rpcLayer: RpcAppLayer
  readonly port: number
  /** Omitted for existing fleet services; pass `127.0.0.1` for local-only tools. */
  readonly host?: string
  /** Defaults to the shared MicroDot origin list. */
  readonly allowedOrigins?: ReadonlyArray<string>
  /**
   * Extra `HttpRouter` route layers (`HttpRouter.add(...)` compositions) merged
   * with `rpcLayer` before the router is built — both register into the same
   * `HttpRouter` service, exactly the way `RpcServer.layerHttp` registers its
   * own `/rpc` route. Omitted by every RPC-only service.
   */
  readonly extraRoutes?: RpcAppLayer
  /**
   * Forwarded to the CORS preflight's `access-control-allow-methods`.
   * Defaults to `['POST', 'OPTIONS']` — widen it when `extraRoutes` serves GET.
   */
  readonly allowedMethods?: ReadonlyArray<string>
  /**
   * Extra CORS request headers, forwarded to {@link microDotCors}.
   * The RPC-client headers are always included.
   */
  readonly allowedHeaders?: ReadonlyArray<string>
  /** Exact slash-delimited path prefixes whose routes enforce their own CORS,
   * including credentialed preflight. Defaults to none; existing RPC CORS is unchanged. */
  readonly routeOwnedCorsPrefixes?: ReadonlyArray<string>
  /**
   * Whether to install the livetrace emitter from `process.env`
   * (`LIVETRACE_URL`, `LIVETRACE_SOURCE`, `LIVETRACE_INGEST_KEY`). Defaults to
   * `'env'`: every service becomes a source the moment the variables are set,
   * and stays inert when they are not. The collector itself passes `'off'` so
   * it never reports to itself.
   */
  readonly trace?: 'env' | 'off'
}

/**
 * Builder-owned launch inputs shared by every generated-service band. They are
 * preview control data, not application deployment requirements.
 */
export const BUILDER_PREVIEW_SERVICE_ENVIRONMENT = {
  Mode: 'BUILDER_PREVIEW_MODE',
  Host: 'BUILDER_PREVIEW_HOST',
  Port: 'BUILDER_PREVIEW_PORT',
  BuilderOrigin: 'BUILDER_PREVIEW_BUILDER_ORIGIN',
  AllowedOrigins: 'BUILDER_PREVIEW_ALLOWED_ORIGINS',
  PinEnvironmentName: 'BUILDER_PREVIEW_PIN_ENV_NAME',
} as const

export type BuilderPreviewServiceEnvironment = Readonly<
  Record<string, string | undefined>
>

export type RpcServiceLaunchOptions = Pick<
  RpcServiceOptions,
  'port' | 'host' | 'allowedOrigins'
>

/**
 * Resolve the one fail-closed preview launch protocol. With no preview mode,
 * the MicroDot keeps its declared port and normal shared CORS policy.
 */
export const rpcServiceOptionsForBuilderPreview = (
  defaultPort: number,
  environment: BuilderPreviewServiceEnvironment = process.env,
): RpcServiceLaunchOptions => {
  const names = BUILDER_PREVIEW_SERVICE_ENVIRONMENT
  const mode = environment[names.Mode]
  if (mode === undefined) return { port: defaultPort }
  if (mode !== '1') throw new Error('Invalid builder preview mode')

  const host = environment[names.Host]
  const port = Number(environment[names.Port])
  const builderOrigin = environment[names.BuilderOrigin]
  let parsedBuilderOrigin: URL | undefined
  try {
    parsedBuilderOrigin =
      builderOrigin === undefined ? undefined : new URL(builderOrigin)
  } catch {
    throw new Error('Invalid builder preview launch configuration')
  }
  let allowedOrigins: unknown
  try {
    allowedOrigins = JSON.parse(environment[names.AllowedOrigins] ?? '')
  } catch {
    throw new Error('Invalid builder preview launch configuration')
  }
  if (
    host !== '127.0.0.1' ||
    !Number.isSafeInteger(port) ||
    port < 3900 ||
    port > 65_535 ||
    builderOrigin === undefined ||
    parsedBuilderOrigin === undefined ||
    parsedBuilderOrigin.protocol !== 'http:' ||
    (parsedBuilderOrigin.hostname !== '127.0.0.1' &&
      parsedBuilderOrigin.hostname !== 'localhost' &&
      parsedBuilderOrigin.hostname !== '[::1]') ||
    parsedBuilderOrigin.origin !== builderOrigin ||
    !Array.isArray(allowedOrigins) ||
    allowedOrigins.length !== 2 ||
    allowedOrigins[0] !== builderOrigin ||
    allowedOrigins[1] !== 'null'
  ) {
    throw new Error('Invalid builder preview launch configuration')
  }
  return {
    host,
    port,
    allowedOrigins: [builderOrigin, 'null'],
  }
}

/**
 * The emitter, when configured, provided BENEATH the router layers so every
 * handler fiber inherits the reporting tracer and logger. `Layer<never>` in,
 * `RpcAppLayer` out — the type does not change, so nothing downstream does.
 */
const withTraceEmitter = (
  layer: RpcAppLayer,
  emitter: Option.Option<Layer.Layer<never>>,
): RpcAppLayer =>
  Option.match(emitter, {
    onNone: () => layer,
    onSome: trace => Layer.provide(layer, trace),
  })

// Deliberately NOT bare `HttpMiddleware.cors()` — see cors.ts for why an empty
// allowed-headers value breaks the preflight in Chrome.
export const rpcServiceCorsMiddleware = (
  allowedOrigins: ReadonlyArray<string> | undefined,
  allowedMethods: ReadonlyArray<string> | undefined,
  allowedHeaders: ReadonlyArray<string> | undefined,
  routeOwnedCorsPrefixes: ReadonlyArray<string> = [],
) => {
  if (routeOwnedCorsPrefixes.some(prefix => !/^\/[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/u.test(prefix))) throw new Error('Route-owned CORS requires exact non-root path prefixes')
  const standard = microDotCors(allowedOrigins ?? MICRODOT_ORIGINS, {
    ...(allowedMethods === undefined ? {} : { allowedMethods }),
    ...(allowedHeaders === undefined ? {} : { allowedHeaders }),
  })
  return <E, R>(app: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>) => Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest
    const path = request.url.split('?')[0] ?? ''
    const ownsCors = routeOwnedCorsPrefixes.some(prefix => path === prefix || path.startsWith(`${prefix}/`))
    return yield* (ownsCors ? app : standard(app))
  })
}

const assertListenerHost = (expectedHost: string) =>
  Effect.gen(function* () {
    const server = yield* HttpServer.HttpServer
    const address = server.address
    if (address._tag !== 'TcpAddress' || address.hostname !== expectedHost) {
      const actual =
        address._tag === 'TcpAddress'
          ? address.hostname
          : `unix:${address.path}`
      return yield* Effect.die(
        new Error(
          `RPC listener host mismatch: expected ${expectedHost}, bound ${actual}`,
        ),
      )
    }
  })

const nodeServerLayer = (options: RpcServiceOptions) => {
  const server =
    options.host === undefined
      ? NodeHttpServer.layer(createServer, { port: options.port })
      : NodeHttpServer.layer(createServer, {
          host: options.host,
          port: options.port,
        })

  return options.host === undefined
    ? server
    : Layer.effectDiscard(assertListenerHost(options.host)).pipe(
        Layer.provideMerge(server),
      )
}

/** Wraps a composed RPC layer in an HTTP server bound to `port`. */
export const makeRpcService = (options: RpcServiceOptions) => {
  const emitter =
    options.trace === 'off' ? Option.none() : traceEmitterFromEnv(process.env)
  if (options.trace !== 'off') {
    console.log(describeTraceEnv(process.env))
  }
  const rpcLayer = withTraceEmitter(options.rpcLayer, emitter)
  const extraRoutes =
    options.extraRoutes === undefined
      ? undefined
      : withTraceEmitter(options.extraRoutes, emitter)
  return Layer.unwrap(
    pipe(
      HttpRouter.toHttpEffect(
        extraRoutes === undefined
          ? rpcLayer
          : Layer.merge(rpcLayer, extraRoutes),
      ),
      Effect.map(
        HttpServer.serve(
          rpcServiceCorsMiddleware(
            options.allowedOrigins,
            options.allowedMethods,
            options.allowedHeaders,
            options.routeOwnedCorsPrefixes,
          ),
        ),
      ),
    ),
  ).pipe(HttpServer.withLogAddress, Layer.provide(nodeServerLayer(options)))
}

/** Boots a service built by `makeRpcService`. Call this at the end of `service/main.ts`. */
export const runRpcService = <E>(service: Layer.Layer<never, E>): void => {
  NodeRuntime.runMain(Layer.launch(service))
}

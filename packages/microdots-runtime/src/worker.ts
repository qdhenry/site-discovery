import { Layer, Option } from 'effect'
import { HttpRouter } from 'effect/unstable/http'

import {
  type OriginAllowlist,
  allowsOrigin,
  microDotCors,
  readAllowedOrigins,
} from './cors'
import { asksForOwnAddress, landingResponse } from './landing'
import { traceEmitterFromEnv } from './trace'

export { DEPLOYED_HOST_ORIGIN } from './cors'

/** An RPC layer that still needs the router provided — what `RpcServer.layerHttp` yields. */
export type RpcAppLayer = Layer.Layer<never, never, HttpRouter.HttpRouter>

/**
 * `Env` is the Worker's bindings object — D1 databases, KV namespaces, secrets.
 *
 * A MicroDot with no bindings leaves it inferred as `unknown` and ignores the
 * argument; one that needs D1 declares its own binding type. Cloudflare passes a
 * third `ctx` argument that nothing here needs, and an extra argument is
 * harmless, so it is left off the signature rather than typed and discarded.
 */
export type MicroDotWorker<Env> = {
  readonly fetch: (request: Request, env: Env) => Promise<Response>
}

export type MicroDotWorkerOptions<Env> = {
  /**
   * Builds `RpcServer.layerHttp(...)`, with handlers and serialization provided,
   * from the request's bindings.
   *
   * A function rather than a value because bindings do not exist until a request
   * arrives: `env` is an argument to `fetch`, never a module-scope import. A
   * service backed by D1 therefore cannot construct its layer ahead of time, and
   * a static layer would have no way to reach the database at all.
   *
   * MicroDots with no bindings pass `() => SomeLayer` and ignore the argument.
   */
  readonly rpcLayer: (env: Env) => RpcAppLayer
  /**
   * Extra `HttpRouter` layers merged with `rpcLayer` before the handler is
   * built — the Worker half of `makeRpcService`'s `extraRoutes`. Omitted by
   * every RPC-only service. Built from `env` for the same reason `rpcLayer` is.
   */
  readonly extraRoutes?: (env: Env) => RpcAppLayer
  /**
   * Origins allowed when the `MICRODOT_ALLOWED_ORIGINS` binding is absent or
   * blank — the LOCAL and TEST default, never the production answer.
   *
   * A deployed service reads its real list from the binding, so adding an
   * embedding customer is a `vars` change and a redeploy of ONE service rather
   * than an edit to a constant in a shared package followed by a rebuild of all
   * eight. Keep this populated with `MICRODOT_ORIGINS` for every config that
   * does not declare the var yet. The deploy path does carry `vars` now, as
   * `PlainText` bindings (`microdots/deploy/service/lifecycle.ts:895-899`). An
   * upload still replaces the whole binding set per version, so a config
   * without the block reaches a Platform-deployed Worker with no list at all.
   *
   * Omitted entirely means "answer no cross-origin request", which is the safe
   * direction: `[]` denies everything here, where the same empty array handed
   * straight to Effect's cors would open the service to `*`.
   */
  readonly fallbackOrigins?: OriginAllowlist
  /** Defaults to `['POST', 'OPTIONS']`. Widen when `extraRoutes` serves GET. */
  readonly allowedMethods?: ReadonlyArray<string>
  /** Extra CORS request headers, merged onto the RPC-client allow-list. */
  readonly allowedHeaders?: ReadonlyArray<string>
  /**
   * Whether to install the livetrace emitter from the bindings
   * (`LIVETRACE_URL`, `LIVETRACE_SOURCE` as vars, `LIVETRACE_INGEST_KEY` as a
   * secret). Defaults to `'env'`. The collector itself passes `'off'`.
   */
  readonly trace?: 'env' | 'off'
  /**
   * What `GET /` answers when no route does. Defaults to `'on'`: the MicroDots
   * "running" page from `./landing`, so an address opened in a browser no
   * longer reads as a broken deploy. `'off'` keeps the bare 404.
   *
   * A route on `/` from `extraRoutes` always wins, and a Worker that ships
   * static files never reaches this code for a path a file answers.
   */
  readonly landingPage?: 'on' | 'off'
}

/**
 * Statuses the Fetch spec forbids a body on. Passing even a zero-length body for
 * one of these to the `Response` constructor throws, and a CORS preflight is a
 * 204 — so the happy path hits this immediately.
 */
const NULL_BODY_STATUSES: ReadonlySet<number> = new Set([
  101, 103, 204, 205, 304,
])

/**
 * Adds `Origin` to `Vary` without clobbering it and without duplicating it.
 *
 * Effect's cors sets `vary: Origin` only on the ALLOW path, so a denied
 * cross-origin request comes back varying on nothing — and a shared cache in
 * front of a service whose `extraRoutes` serve cacheable GETs (the auction and
 * app-header image routes) can then hand one origin's allow decision to
 * another. The previous version of this used `append` unconditionally, which
 * could emit `vary: Origin, Origin`.
 */
const varyOnOrigin = (headers: Headers): void => {
  const existing = headers.get('vary')
  if (existing === null) {
    headers.set('vary', 'Origin')
    return
  }
  const named = existing
    .split(',')
    .some(entry => entry.trim().toLowerCase() === 'origin')
  if (!named) {
    headers.append('vary', 'Origin')
  }
}

/**
 * Re-reads the body inside the current request's I/O context.
 *
 * `dispose` tears the layer down; returning a still-streaming body and disposing
 * in the same tick truncates the response. These RPCs answer with a single ndjson
 * message, so buffering costs nothing and makes teardown deterministic. A
 * streaming RPC would need the scope held open until the body drains instead.
 */
const bufferResponse = async (
  response: Response,
  request: Request,
  allowlist: OriginAllowlist,
): Promise<Response> => {
  const headers = new Headers(response.headers)
  varyOnOrigin(headers)
  // The cors middleware only decorates responses the router itself produced. A
  // failure raised while the layer is still being BUILT short-circuits to a bare
  // 500 that never passes through it, so the browser sees a CORS violation
  // instead of the actual defect. Backfill the header rather than lose the cause.
  const origin = request.headers.get('origin')
  if (
    !headers.has('access-control-allow-origin') &&
    origin !== null &&
    allowsOrigin(allowlist)(origin)
  ) {
    headers.set('access-control-allow-origin', origin)
  }
  const init = {
    status: response.status,
    statusText: response.statusText,
    headers,
  }
  return NULL_BODY_STATUSES.has(response.status) || response.body === null
    ? new Response(null, init)
    : new Response(await response.arrayBuffer(), init)
}

/**
 * A failure response that still carries CORS headers.
 *
 * When a Worker throws, Cloudflare serves its own 500 page, and that page has no
 * `Access-Control-Allow-Origin`. The browser then reports a CORS violation for
 * what is really a server-side crash, which sends you auditing CORS config that
 * was correct all along. Answering the error ourselves keeps the real cause
 * visible in the console.
 */
const failureResponse = (
  cause: unknown,
  request: Request,
  allowlist: OriginAllowlist,
): Response => {
  const headers = new Headers({
    'content-type': 'text/plain; charset=utf-8',
    vary: 'Origin',
  })
  const origin = request.headers.get('origin')
  if (origin !== null && allowsOrigin(allowlist)(origin)) {
    headers.set('access-control-allow-origin', origin)
  }
  const message = cause instanceof Error ? cause.message : String(cause)
  return new Response(`MicroDot service failed: ${message}`, {
    status: 500,
    headers,
  })
}

/**
 * The Cloudflare Workers shell for a MicroDot RPC service.
 *
 * The handler is built PER REQUEST, and that is the whole point.
 * `HttpRouter.toWebHandler` builds its layer lazily on the first `handler()`
 * call, so hoisting it to module scope means the runtime, its scope and its
 * fibers are all constructed inside the *first* request's I/O context. Cloudflare
 * forbids reusing I/O objects across requests, so every later request into that
 * warm isolate can never make progress and the runtime kills it with "your
 * Worker's code had hung and would never generate a response" — a 1101, which
 * again surfaces in the browser as a bogus CORS error.
 *
 * The symptom is nastily intermittent: a cold isolate answers its first request
 * correctly, so the service looks healthy right up until it is polled twice.
 *
 * Rebuilding per request keeps the scope inside the request that created it.
 * These layers are pure in-memory value plumbing with no sockets to reopen, so
 * the rebuild is cheap.
 *
 * `rpcLayer` is invoked per request for the same reason, which is also what lets
 * a binding-backed service exist at all: the D1 handle comes from this request's
 * `env`, so the layer that closes over it cannot outlive the request either.
 *
 * `GET /` is the one request the shell answers itself: where the router says
 * 404 for the service's own address, it returns the "running" page from
 * `./landing`. The router still runs first, so a layer that cannot be built is
 * still the 500 below and never a page that says "running".
 */
export const makeMicroDotWorker = <Env>(
  options: MicroDotWorkerOptions<Env>,
): MicroDotWorker<Env> => ({
  fetch: async (request: Request, env: Env): Promise<Response> => {
    const extra = options.extraRoutes
    const routes =
      extra === undefined
        ? options.rpcLayer(env)
        : Layer.merge(options.rpcLayer(env), extra(env))
    // Resolved per request from the bindings, like everything else here.
    const allowlist = Option.getOrElse(
      readAllowedOrigins(env),
      () => options.fallbackOrigins ?? [],
    )
    // Built per request like everything else here: the transport's flush fiber
    // lives on this request's scope and its finalizer ships the buffer in
    // `dispose()`, so a short request's events leave before the isolate moves on.
    const emitter =
      options.trace === 'off' ? Option.none() : traceEmitterFromEnv(env)
    const layer = Option.match(emitter, {
      onNone: () => routes,
      onSome: trace => Layer.provide(routes, trace),
    })
    const { handler, dispose } = HttpRouter.toWebHandler(layer, {
      middleware: microDotCors(allowlist, {
        ...(options.allowedMethods === undefined
          ? {}
          : { allowedMethods: options.allowedMethods }),
        ...(options.allowedHeaders === undefined
          ? {}
          : { allowedHeaders: options.allowedHeaders }),
      }),
    })
    try {
      const answered = await handler(request)
      // Only where the router had nothing to say, and only for a browser's
      // own request for the address. `/rpc` and every other path are returned
      // exactly as the router answered them.
      if (
        options.landingPage !== 'off' &&
        answered.status === 404 &&
        asksForOwnAddress(request)
      ) {
        await answered.body?.cancel()
        return await bufferResponse(
          landingResponse(request),
          request,
          allowlist,
        )
      }
      return await bufferResponse(answered, request, allowlist)
    } catch (cause) {
      return failureResponse(cause, request, allowlist)
    } finally {
      await dispose()
    }
  },
})

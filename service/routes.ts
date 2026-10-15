import { Effect, Layer } from 'effect'
import {
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
} from 'effect/unstable/http'
import { readFile, readdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { DiscoveryError } from '../src/contract.ts'
import { MINI_HOST_ORIGIN } from './auth.ts'
import { currentRuntime } from './runtime.ts'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const json = HttpServerResponse.jsonUnsafe
const html = (body: string, options: HttpServerResponse.Options = {}) =>
  HttpServerResponse.text(body, { ...options, contentType: 'text/html' })
const failure = (error: unknown) => {
  const known = error instanceof DiscoveryError
  return json(
    {
      error: known ? error.code : 'storage',
      message: known ? error.message : 'Request failed',
    },
    {
      status: known
        ? error.code === 'unauthorized'
          ? 401
          : error.code === 'forbidden'
            ? 403
            : error.code === 'not_found'
              ? 404
              : error.code === 'validation'
                ? 400
                : 409
        : 500,
      headers: { 'cache-control': 'no-store' },
    },
  )
}
const route =
  (
    run: (
      request: HttpServerRequest.HttpServerRequest,
    ) => Promise<HttpServerResponse.HttpServerResponse>,
  ) =>
  (request: HttpServerRequest.HttpServerRequest) =>
    Effect.tryPromise({ try: () => run(request), catch: failure }).pipe(
      Effect.catch(response => Effect.succeed(response)),
    )

/** Paths whose CORS this module answers instead of the runtime's standard,
 * credential-less CORS (see `routeOwnedCorsPrefixes` in shape-main.ts). The
 * mini-host's cross-origin requests carry the owner cookie, so they need
 * `access-control-allow-credentials`, which the standard CORS never sends. */
export const ROUTE_OWNED_CORS_PREFIXES = ['/rpc', '/session', '/private']
const ownsCors = (path: string) =>
  ROUTE_OWNED_CORS_PREFIXES.some(
    prefix => path === prefix || path.startsWith(`${prefix}/`),
  )
/** The runtime's RPC client headers (microdots-runtime cors.ts); the methods
 * cover the session and screenshot routes as well as RPC. */
const CORS_ALLOWED_HEADERS =
  'content-type, traceparent, tracestate, b3, x-b3-traceid, x-b3-spanid, x-b3-sampled'
const CORS_ALLOWED_METHODS = 'GET, POST, DELETE, OPTIONS'
/** Echo only the mini-host origin. Same-origin requests need no CORS, and any
 * other origin is rejected by the transport check before a route runs. */
const credentialedCors = (
  path: string,
  origin: string | undefined,
): Record<string, string> =>
  ownsCors(path) && origin === MINI_HOST_ORIGIN
    ? {
        'access-control-allow-origin': origin,
        'access-control-allow-credentials': 'true',
        vary: 'Origin',
      }
    : {}

/** Actual HTTP headers are checked before RPC frame headers can override metadata. */
export const TransportGuard = HttpRouter.middleware(
  httpEffect =>
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest
      const path = request.url.split('?')[0]!
      const cors = credentialedCors(path, request.headers.origin)
      // A preflight never carries the cookie: check the transport only, then
      // answer it here, before any session requirement.
      if (request.method === 'OPTIONS' && ownsCors(path)) {
        const rejected = yield* Effect.tryPromise({
          try: async () =>
            (await currentRuntime()).sessions.validateTransport(
              request.headers,
              true,
            ),
          catch: failure,
        }).pipe(
          Effect.asVoid,
          Effect.catch(response => Effect.succeed(response)),
        )
        return (
          rejected ??
          HttpServerResponse.empty({
            status: 204,
            headers: {
              ...cors,
              'access-control-allow-methods': CORS_ALLOWED_METHODS,
              'access-control-allow-headers': CORS_ALLOWED_HEADERS,
              'access-control-max-age': '600',
            },
          })
        )
      }
      const check = yield* Effect.tryPromise({
        try: async () => {
          const { sessions } = await currentRuntime()
          // Only a top-level document load of the shell; frames and fetches
          // carry another Sec-Fetch-Dest/Mode and stay same-site only.
          const shellNavigation =
            path === '/' &&
            request.method === 'GET' &&
            request.headers['sec-fetch-mode'] === 'navigate' &&
            request.headers['sec-fetch-dest'] === 'document'
          sessions.validateTransport(
            request.headers,
            request.method !== 'GET' &&
              request.method !== 'HEAD' &&
              request.method !== 'OPTIONS',
            shellNavigation,
          )
          const publicRoute =
            (path === '/' && request.method === 'GET') ||
            (path === '/session' &&
              ['GET', 'POST', 'DELETE'].includes(request.method)) ||
            (request.method === 'GET' &&
              /^\/assets\/[A-Za-z0-9_.-]+\.(js|css|woff2?)$/.test(path))
          if (!publicRoute) {
            if (request.method === 'GET' || request.method === 'HEAD')
              sessions.requireRead(request.headers)
            else sessions.require(request.headers)
          }
        },
        catch: failure,
      }).pipe(
        Effect.asVoid,
        Effect.catch(response => Effect.succeed(response)),
      )
      // Rejections carry CORS too, so the mini-host can read a 401 as "sign in"
      // rather than as an opaque network failure.
      return HttpServerResponse.setHeaders(check ?? (yield* httpEffect), cors)
    }),
  { global: true },
)

const SessionGet = HttpRouter.add(
  'GET',
  '/session',
  route(async request =>
    json((await currentRuntime()).sessions.status(request.headers), {
      headers: { 'cache-control': 'no-store' },
    }),
  ),
)
const SessionPost = HttpRouter.add('POST', '/session', request =>
  Effect.gen(function* () {
    const body = yield* request.json.pipe(
      Effect.catch(() => Effect.succeed(null)),
    )
    return yield* route(async req => {
      if (
        !body ||
        typeof body !== 'object' ||
        !('token' in body) ||
        typeof body.token !== 'string' ||
        body.token.length > 512
      )
        return json(
          { message: 'Supply the local owner token' },
          { status: 400 },
        )
      const result = (await currentRuntime()).sessions.login(
        req.headers,
        body.token,
      )
      return json(result.state, {
        headers: { 'set-cookie': result.cookie, 'cache-control': 'no-store' },
      })
    })(request)
  }),
)
const SessionDelete = HttpRouter.add(
  'DELETE',
  '/session',
  route(async request => {
    const result = (await currentRuntime()).sessions.logout(request.headers)
    return json(result.state, {
      headers: { 'set-cookie': result.cookie, 'cache-control': 'no-store' },
    })
  }),
)
const Screenshots = HttpRouter.add(
  'GET',
  '/private/screenshots/*',
  route(async request => {
    const { engine, sessions } = await currentRuntime()
    sessions.requireRead(request.headers)
    const parts = request.url.split('?')[0]!.split('/').filter(Boolean)
    if (parts.length !== 6)
      return json({ message: 'Not found' }, { status: 404 })
    const result = await engine.screenshot(
      decodeURIComponent(parts[2]!),
      parts[3]!,
      parts[4]!,
      parts[5]!,
    )
    return HttpServerResponse.uint8Array(result.bytes, {
      contentType: result.mime,
      headers: {
        'cache-control': 'private, no-store',
        'x-content-type-options': 'nosniff',
        'content-security-policy':
          "default-src 'none'; style-src 'unsafe-inline'; sandbox",
      },
    })
  }),
)
const LibraryScreenshots = HttpRouter.add(
  'GET',
  '/private/library/*',
  route(async request => {
    const { engine, sessions } = await currentRuntime()
    sessions.requireRead(request.headers)
    const parts = request.url.split('?')[0]!.split('/').filter(Boolean)
    if (parts.length !== 6)
      return json({ message: 'Not found' }, { status: 404 })
    const result = await engine.libraryScreenshot(
      decodeURIComponent(parts[2]!),
      parts[3]!,
      parts[4]!,
      parts[5]!,
    )
    return HttpServerResponse.uint8Array(result.bytes, {
      contentType: result.mime,
      headers: {
        'cache-control': 'private, no-store',
        'x-content-type-options': 'nosniff',
        'content-security-policy':
          "default-src 'none'; style-src 'unsafe-inline'; sandbox",
      },
    })
  }),
)
const App = HttpRouter.add(
  'GET',
  '/',
  route(async () => {
    const manifest: { microdot?: { tag?: string } } = JSON.parse(
      await readFile(join(root, 'package.json'), 'utf8'),
    )
    const tag = manifest.microdot?.tag
    if (!tag || !/^[a-z][a-z0-9-]+$/.test(tag))
      throw new Error('Invalid MicroDot tag')
    let files: string[] = []
    try {
      files = await readdir(join(root, 'dist'))
    } catch {
      return html(
        '<h1>Build the Discovery interface first</h1><p>Run bun run build in the application directory, then reload.</p>',
        { status: 503 },
      )
    }
    const entry = files.find(
      file => file.endsWith('.js') && !file.includes('.map'),
    )
    if (!entry)
      return html(
        '<h1>Discovery bundle is missing</h1><p>Run bun run build.</p>',
        { status: 503 },
      )
    const css = files
      .filter(file => file.endsWith('.css'))
      .map(
        file =>
          `<link rel="stylesheet" href="/assets/${encodeURIComponent(file)}">`,
      )
      .join('')
    return html(
      `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Site Discovery</title>${css}<style>body{margin:0;background:#f6f8f7} ${tag}{display:block;min-height:100vh}</style></head><body><${tag} api-url="" project-id="default"></${tag}><script type="module" src="/assets/${encodeURIComponent(entry)}"></script></body></html>`,
      {
        headers: {
          'cache-control': 'no-store',
          'x-content-type-options': 'nosniff',
          'referrer-policy': 'no-referrer',
        },
      },
    )
  }),
)
const Assets = HttpRouter.add(
  'GET',
  '/assets/*',
  route(async request => {
    const name = decodeURIComponent(
      request.url.split('?')[0]!.slice('/assets/'.length),
    )
    if (!/^[A-Za-z0-9_.-]+\.(js|css|woff2?)$/.test(name))
      return json({ message: 'Not found' }, { status: 404 })
    try {
      return HttpServerResponse.uint8Array(
        await readFile(join(root, 'dist', name)),
        {
          contentType: name.endsWith('.js')
            ? 'text/javascript'
            : name.endsWith('.css')
              ? 'text/css'
              : 'font/woff2',
          headers: {
            'cache-control': 'no-cache',
            'x-content-type-options': 'nosniff',
          },
        },
      )
    } catch {
      return json({ message: 'Not found' }, { status: 404 })
    }
  }),
)
export const ExtraRoutes = Layer.mergeAll(
  SessionGet,
  SessionPost,
  SessionDelete,
  Screenshots,
  LibraryScreenshots,
  App,
  Assets,
  TransportGuard,
)

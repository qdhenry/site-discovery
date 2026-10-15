import { Option } from 'effect'
import { HttpMiddleware } from 'effect/unstable/http'

/**
 * CORS for a MicroDot service.
 *
 * Do NOT use bare `HttpMiddleware.cors()` for a browser-facing service:
 * `allowedHeaders` defaults to `[]`, which emits an EMPTY
 * `access-control-allow-headers:` value. Chrome flags that as a malformed CORS
 * response ("Ensure CORS response header values are valid"), rejects the
 * preflight, and then reports the actual request as having no
 * `Access-Control-Allow-Origin` — which sends you hunting for the wrong bug.
 *
 * The allow-list must cover every header the RPC client actually sends:
 * `content-type`, plus the W3C/B3 trace-propagation headers Effect attaches when
 * a span is active. Omitting `traceparent` fails the preflight with "Request
 * header field traceparent is not allowed by Access-Control-Allow-Headers" —
 * and it only shows up once tracing is live, so it can pass locally and fail
 * deployed.
 */
const RPC_CLIENT_HEADERS = [
  'content-type',
  'traceparent',
  'tracestate',
  'b3',
  'x-b3-traceid',
  'x-b3-spanid',
  'x-b3-sampled',
]

/**
 * The RPC-only method surface every existing service runs with. A service that
 * also serves GET routes (static pages, preview assets, downloads) widens the
 * list via {@link MicroDotCorsOptions.allowedMethods}; note the actual-request
 * path of Effect's cors never filters by method — this list only feeds the
 * preflight's `access-control-allow-methods` header.
 */
const DEFAULT_ALLOWED_METHODS: ReadonlyArray<string> = ['POST', 'OPTIONS']

/**
 * The exact origins a service answers.
 *
 * FULL origins (`https://host.example`), never bare hostnames: this is
 * exact-matched against the `Origin` header a BROWSER sends, which always
 * carries scheme and, when non-default, port. A trailing slash never matches.
 */
export type OriginAllowlist = ReadonlyArray<string>

export type MicroDotCorsOptions = {
  /** Defaults to `['POST', 'OPTIONS']` — the RPC-only surface. */
  readonly allowedMethods?: ReadonlyArray<string>
  /**
   * Extra request headers merged onto the RPC-client allow-list.
   * Needed when a service's `extraRoutes` read a custom header (an upload PIN).
   */
  readonly allowedHeaders?: ReadonlyArray<string>
}

/**
 * Whether one origin is on the list — and the ONLY thing ever handed to
 * `HttpMiddleware.cors` as `allowedOrigins`.
 *
 * This is not a style choice. `cors` selects its allow-origin strategy from the
 * SHAPE of `allowedOrigins`, and two of the three branches are wrong for a
 * browser-facing service. From `HttpMiddleware.ts:333-352`:
 *
 * | passed              | what it emits                                              |
 * | ------------------- | ---------------------------------------------------------- |
 * | `[]`                | `access-control-allow-origin: *`, no `Vary` — OPEN         |
 * | `[x]`               | `constant(x)` for EVERY request, strangers included        |
 * | `[x, y, …]`         | echoes the request origin when it matches, omits when not  |
 * | `Predicate<string>` | the echo branch, UNCONDITIONALLY, at any length            |
 *
 * The middle two are the dangerous ones and they are not hypothetical: the
 * deployed fleet ran on `[x]` for its whole life, so `effect-microapps-readout`
 * answered `evil.example` — and a request with no `Origin` header at all — with
 * the same constant header naming the host Worker. It checked nothing; the
 * browser did all the rejecting. And `[]` is exactly where an absent binding
 * lands, which is why {@link readAllowedOrigins} returns `Option.none()` rather
 * than an empty array.
 *
 * A function reaches the correct branch at length zero and one as well, so
 * passing one is the whole fix.
 *
 * `Array.includes` is deliberately doing the guarding: `cors` types this
 * `(origin: string) => boolean` but calls it with `undefined` when the request
 * carries no `Origin` header, and `includes(undefined)` is simply `false`.
 */
export const allowsOrigin =
  (allowlist: OriginAllowlist): ((origin: string) => boolean) =>
  origin =>
    allowlist.includes(origin)

export const microDotCors = (
  allowedOrigins: OriginAllowlist,
  options?: MicroDotCorsOptions,
) =>
  HttpMiddleware.cors({
    allowedOrigins: allowsOrigin(allowedOrigins),
    allowedMethods: options?.allowedMethods ?? DEFAULT_ALLOWED_METHODS,
    allowedHeaders:
      options?.allowedHeaders === undefined
        ? RPC_CLIENT_HEADERS
        : [...RPC_CLIENT_HEADERS, ...options.allowedHeaders],
  })

/**
 * The binding a deployed MicroDot service reads its allow-list from.
 *
 * A `vars` entry rather than a compiled-in constant, because
 * [[configuration-arrives-as-attributes]] applies to the service half too: an
 * allow-list baked into the artifact means one artifact per embedding customer,
 * which destroys the "publish once to a CDN" premise the architecture rests on.
 * Adding a customer origin must be a binding change plus a redeploy of ONE
 * service, never an edit to a shared package followed by a rebuild of all eight.
 */
export const ALLOWED_ORIGINS_ENV_KEY = 'MICRODOT_ALLOWED_ORIGINS'

/**
 * Comma-separated full origins off the Worker's bindings.
 *
 * Returns `Option.none()` — **never `[]`** — when the binding is absent, blank,
 * or not a string. An empty array is the one value that must not reach
 * `HttpMiddleware.cors` as an array, because that is its `*` branch; returning
 * it from here would invite exactly that at the one moment it is most likely to
 * happen, a fresh deploy whose binding was never set. The caller decides what a
 * missing binding means, and in `worker.ts` it means the service answers no
 * cross-origin request at all rather than answering every one.
 */
export const readAllowedOrigins = (
  env: unknown,
): Option.Option<OriginAllowlist> => {
  if (typeof env !== 'object' || env === null) {
    return Option.none()
  }
  const value: unknown = Reflect.get(env, ALLOWED_ORIGINS_ENV_KEY)
  if (typeof value !== 'string') {
    return Option.none()
  }
  const origins = value
    .split(',')
    .map(entry => entry.trim())
    .filter(entry => entry.length > 0)
  return origins.length > 0 ? Option.some(origins) : Option.none()
}

/**
 * The deployed host origin.
 *
 * Still a constant because the hostname migration is a separate, staged change:
 * the allow-list can hold the old and the new origin at once, which is the only
 * reason the switch can be made without a window where the host cannot reach
 * its own services.
 */
export const DEPLOYED_HOST_ORIGIN =
  'https://effect-microapps-host.qdhenry.workers.dev'

/** The demo host shell on its own hostname. See {@link DEPLOYED_SHELL_ORIGINS}. */
export const HOST_SHELL_ORIGIN = 'https://host.microdots.cloud'

/**
 * Every origin a DEPLOYED service should answer, and the value that belongs in
 * a `wrangler.jsonc` `vars.MICRODOT_ALLOWED_ORIGINS`.
 *
 * Both entries, deliberately. `workers.dev` is what is live now;
 * `host.microdots.cloud` is where the shell is going. An allow-list that holds
 * the old and the new at once is the only reason the hostname can move without
 * a window where the shell cannot reach its own services — and the reason the
 * cors branch defect had to be fixed first, since the old code path answered
 * every caller with a constant header no matter what this list said.
 *
 * **`localhost` is not here on purpose.** Those origins belong to the node
 * entry and to {@link MICRODOT_ORIGINS}; a deployed service answering
 * `http://localhost:5173` would let any page on any developer's machine call
 * production, which is a different decision from "the dev loop works".
 *
 * `scripts/repo-joins.test.ts` asserts that a config which declares
 * `MICRODOT_ALLOWED_ORIGINS` carries exactly this list, because the config is a
 * hand-edited string that cannot import it. A config without the var is unchecked.
 */
export const DEPLOYED_SHELL_ORIGINS: ReadonlyArray<string> = [
  DEPLOYED_HOST_ORIGIN,
  HOST_SHELL_ORIGIN,
]

/**
 * The Platform shell on its own hostname. Published behind a sign-in on
 * 2026-10-04: `wiki/plans/active/publish-the-platform.md`.
 */
export const PLATFORM_SHELL_ORIGIN = 'https://platform.microdots.cloud'

/**
 * What a deployed service answers when THE PLATFORM MOUNTS ITS MICRODOT: the
 * demo host's origins and the Platform's.
 *
 * A separate list on purpose. A MicroDot the Platform does not mount has no
 * reason to answer a page on the Platform's address, so the Platform's origin
 * is not added to {@link DEPLOYED_SHELL_ORIGINS} for every service to carry.
 * `scripts/repo-joins.test.ts` holds each config to the list that is its own:
 * this one when `apps/platform/src/registry.ts` names the MicroDot's bundle,
 * the shorter one otherwise.
 *
 * The sign-in guards the Platform's pages, not these services. A service on
 * this list is as public as it was; what changes is that a browser on the
 * Platform's address may read its answers.
 */
export const PLATFORM_SERVICE_ORIGINS: ReadonlyArray<string> = [
  ...DEPLOYED_SHELL_ORIGINS,
  PLATFORM_SHELL_ORIGIN,
]

/**
 * Local dev origins, used by the node entry and as the Worker's fallback.
 *
 * The 5180-5182 block is `apps/cross-origin-demo`, which embeds one MicroDot
 * pair across two ORIGINS to show the same wiring surviving the move off a
 * single page. A missing entry here is not a subtle failure and not an obvious
 * one either: the preflight is rejected, every RPC dies, and the MicroDot
 * reports that it could not reach the service — which reads as a dead backend
 * rather than as a line missing from this array. `apps/cross-origin-demo/src/
 * origins.test.ts` asserts the two lists agree so that cannot happen quietly.
 */
export const MICRODOT_ORIGINS: ReadonlyArray<string> = [
  'https://effect-microapps-host.qdhenry.workers.dev',
  // The shell's own hostname, added BEFORE anything routes to it. Both live
  // here at once during the move — see DEPLOYED_SHELL_ORIGINS.
  'https://host.microdots.cloud',
  'http://localhost:5173',
  'http://localhost:5174',
  // apps/website, the marketing site (`astro dev --port 5175`). It mounts no
  // MicroDot today — the element names on its diagrams are string literals, not
  // markup — so this pair is headroom for a live demo, not a current dependency.
  'http://127.0.0.1:5175',
  'http://localhost:5175',
  // The standalone Builder had a pair here. It is gone deliberately: its UI is
  // being retired into the Platform (:5176, below), nothing serves its origin
  // any more, and an allow-listed origin with no server behind it is standing
  // permission for nothing. Ruled 2026-09-01 —
  // see wiki/plans/active/staged-agent-builder.md.
  // Phase 3's generated paired-view mini-host. A generated proof is still a
  // foreign browser origin and must cross the same explicit CORS boundary.
  'http://localhost:5193',
  // apps/platform, the Platform shell. Both spellings: vite binds both, the
  // wizard link is derived from the shell hostname, and a missing origin
  // reads as a dead service rather than a CORS miss.
  'http://127.0.0.1:5176',
  'http://localhost:5176',
  'http://localhost:5180',
  'http://localhost:5181',
  'http://localhost:5182',
]

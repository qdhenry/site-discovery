import {
  Clock,
  Context,
  Deferred,
  Duration,
  Effect,
  Layer,
  Option,
  Schema as S,
} from 'effect'

import {
  Authenticated,
  CurrentIdentity,
  IDENTITY_HEADER,
  type Identity,
  Unauthenticated,
} from './identityContract.ts'

export {
  Authenticated,
  CurrentIdentity,
  IDENTITY_HEADER,
  type Identity,
  Unauthenticated,
  UnauthenticatedReason,
  hasRole,
} from './identityContract.ts'

/**
 * The verifier half of the identity gate: checks a signed identity token and
 * hands a gated handler the identity it proves.
 *
 * Server-only. Effect core, WebCrypto and fetch, so it runs in a Bun service
 * and in a Worker, and it must never be imported by browser code: a MicroDot's
 * contract and client take what they need from the bare entry instead.
 *
 * It verifies; it does not sign users in. A host signs the user in with
 * whatever issues standard signed tokens and passes the token to the element
 * as an attribute. Nothing here is specific to one identity provider.
 */

/** The fixed numbers the verifier runs on. Exported so a test and a page can state them. */
export const IDENTITY_POLICY = {
  /** How far a service's clock may differ from the issuer's before a token is refused. */
  clockSkewSeconds: 30,
  /** How long a key set fetched by URL is trusted before it is fetched again. */
  keySetTtlMillis: 10 * 60_000,
  /** The shortest gap between two fetches, so an unknown key id cannot be used to hammer the issuer. */
  keySetRefetchCooldownMillis: 30_000,
  /** How long a key-set fetch may take before the call is refused. */
  keySetFetchTimeoutMillis: 5_000,
  /** How long a FAILED fetch is believed, so an issuer that is down is not asked again by every call. */
  keySetFailureCooldownMillis: 5_000,
} as const

/**
 * Why the verifier refused, precisely.
 *
 * Service-side only. The caller is told one of three coarse reasons
 * (`Unauthenticated`); this one goes to the log, where it is what an operator
 * needs and nothing a guesser can use.
 */
export const IdentityRefusalReason = S.Literals([
  'not-configured',
  'malformed',
  'unsupported-algorithm',
  'unknown-key',
  'bad-signature',
  'wrong-issuer',
  'wrong-audience',
  'expired',
  'not-yet-valid',
  'keys-unavailable',
])
export type IdentityRefusalReason = typeof IdentityRefusalReason.Type

export class IdentityRefused extends S.TaggedError<IdentityRefused>()(
  'IdentityRefused',
  { reason: IdentityRefusalReason },
) {}

const refused = (reason: IdentityRefusalReason): IdentityRefused =>
  new IdentityRefused({ reason })

/** The public half of one signing key, as an issuer publishes it. */
const PublishedKey = S.Struct({
  kty: S.String,
  kid: S.optionalKey(S.String),
  alg: S.optionalKey(S.String),
  use: S.optionalKey(S.String),
  n: S.optionalKey(S.String),
  e: S.optionalKey(S.String),
  crv: S.optionalKey(S.String),
  x: S.optionalKey(S.String),
  y: S.optionalKey(S.String),
})
type PublishedKey = typeof PublishedKey.Type

const PublishedKeySet = S.Struct({ keys: S.Array(PublishedKey) })

const decodeKeySet = S.decodeUnknownOption(S.fromJsonString(PublishedKeySet))
const decodeJsonRecord = S.decodeUnknownOption(
  S.fromJsonString(S.Record(S.String, S.Unknown)),
)

/** Where the issuer's public keys come from. */
export type IdentityKeySource =
  | { readonly _tag: 'Inline'; readonly keys: ReadonlyArray<PublishedKey> }
  | { readonly _tag: 'Url'; readonly url: string }

export type IdentityConfig = {
  readonly issuer: Option.Option<string>
  readonly audience: Option.Option<string>
  readonly keys: Option.Option<IdentityKeySource>
  /** The claim a role is read from. A string, or a list of strings. */
  readonly roleClaim: string
  /** Injectable transport for tests. Defaults to the platform's fetch. */
  readonly fetch?: KeySetFetch
}

/**
 * How a key set is fetched. `signal` is aborted when the fetch is given up on,
 * so a transport that honours it does not leave a connection open behind a
 * timeout.
 */
export type KeySetFetch = (
  url: string,
  signal: AbortSignal,
) => Promise<globalThis.Response>

const DEFAULT_ROLE_CLAIM = 'role'

const LOOPBACK_HOSTS: ReadonlySet<string> = new Set([
  'localhost',
  '127.0.0.1',
  '[::1]',
])

/**
 * A key set is public, but WHERE it comes from is the whole trust decision:
 * whoever answers that URL decides which tokens verify. So it is HTTPS, with
 * one exception for a developer's own machine.
 */
export const isAllowedKeySetUrl = (value: string): boolean => {
  if (!URL.canParse(value)) return false
  const url = new URL(value)
  return (
    url.protocol === 'https:' ||
    (url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname))
  )
}

/** The names the verifier's settings are read from, in `process.env` or a Worker's bindings. */
export const IDENTITY_ENV_KEYS = {
  issuer: 'IDENTITY_ISSUER',
  audience: 'IDENTITY_AUDIENCE',
  keySet: 'IDENTITY_JWKS',
  keySetUrl: 'IDENTITY_JWKS_URL',
  roleClaim: 'IDENTITY_ROLE_CLAIM',
} as const

/** A setting that is a non-blank string. Anything else is the same as unset. */
const settingAt = (env: unknown, key: string): Option.Option<string> => {
  if (typeof env !== 'object' || env === null) return Option.none()
  const value: unknown = Reflect.get(env, key)
  if (typeof value !== 'string') return Option.none()
  const trimmed = value.trim()
  return trimmed.length > 0 ? Option.some(trimmed) : Option.none()
}

/**
 * Reads the verifier's configuration from wherever the running entry keeps it:
 * `process.env` in a Bun service, the bindings in a Worker. `unknown` in, as
 * `./trace` reads its own settings, so either can be passed as it is.
 *
 * Every value here is public: an issuer, an audience, public keys. Nothing is
 * a secret, and nothing is defaulted. A missing or unusable value stays
 * missing, and `makeIdentityGateLive` then refuses every token.
 *
 * An inline key set wins over a URL when both are set. An inline set that does
 * not parse is NOT skipped in favour of the URL: a half-configured service
 * must fail closed, not quietly trust a different source.
 */
export const identityConfigFrom = (env: unknown): IdentityConfig => {
  const inline = settingAt(env, IDENTITY_ENV_KEYS.keySet)
  const keys: Option.Option<IdentityKeySource> = Option.match(inline, {
    onSome: text =>
      Option.map(decodeKeySet(text), (keySet): IdentityKeySource => ({
        _tag: 'Inline',
        keys: keySet.keys,
      })),
    onNone: () =>
      Option.map(
        Option.filter(
          settingAt(env, IDENTITY_ENV_KEYS.keySetUrl),
          isAllowedKeySetUrl,
        ),
        (url): IdentityKeySource => ({ _tag: 'Url', url }),
      ),
  })
  return {
    issuer: settingAt(env, IDENTITY_ENV_KEYS.issuer),
    audience: settingAt(env, IDENTITY_ENV_KEYS.audience),
    keys,
    roleClaim: Option.getOrElse(
      settingAt(env, IDENTITY_ENV_KEYS.roleClaim),
      () => DEFAULT_ROLE_CLAIM,
    ),
  }
}

/**
 * The signature algorithms the verifier accepts, and how WebCrypto is told to
 * check each.
 *
 * An allow-list, never the token's own word for it. A token names its
 * algorithm in a header an attacker writes, so trusting that header is how
 * `none` and symmetric-key confusion attacks work. Two asymmetric algorithms
 * are listed; anything else is refused before a key is even looked up.
 */
type Algorithm = {
  readonly keyType: 'RSA' | 'EC'
  readonly importParams: RsaHashedImportParams | EcKeyImportParams
  readonly verifyParams: AlgorithmIdentifier | EcdsaParams
}

// A Map, not an object literal. `alg` is text an attacker writes, and an
// object answers `constructor`, `toString` and `__proto__` from its prototype:
// those would have passed the allow-list and been refused only later, by luck.
const ALGORITHMS: ReadonlyMap<string, Algorithm> = new Map<string, Algorithm>([
  [
    'RS256',
    {
      keyType: 'RSA',
      importParams: { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      verifyParams: { name: 'RSASSA-PKCS1-v1_5' },
    },
  ],
  [
    'ES256',
    {
      keyType: 'EC',
      importParams: { name: 'ECDSA', namedCurve: 'P-256' },
      verifyParams: { name: 'ECDSA', hash: 'SHA-256' },
    },
  ],
])

const BASE64URL = /^[A-Za-z0-9_-]+$/

const decodeBase64Url = (
  segment: string,
): Option.Option<Uint8Array<ArrayBuffer>> => {
  // A length of 4n+1 is never valid base64, and `atob` is not asked to judge it.
  if (!BASE64URL.test(segment) || segment.length % 4 === 1) {
    return Option.none()
  }
  const padded =
    segment.replaceAll('-', '+').replaceAll('_', '/') +
    '='.repeat((4 - (segment.length % 4)) % 4)
  return Option.map(Option.liftThrowable(atob)(padded), binary =>
    Uint8Array.from(binary, character => character.charCodeAt(0)),
  )
}

const decodeJsonSegment = (
  segment: string,
): Option.Option<Readonly<Record<string, unknown>>> =>
  Option.flatMap(decodeBase64Url(segment), bytes =>
    decodeJsonRecord(new TextDecoder().decode(bytes)),
  )

type ParsedToken = {
  readonly header: Readonly<Record<string, unknown>>
  readonly claims: Readonly<Record<string, unknown>>
  /** The exact bytes the issuer signed: the first two segments and the dot between them. */
  readonly signed: Uint8Array<ArrayBuffer>
  readonly signature: Uint8Array<ArrayBuffer>
}

const parseToken = (token: string): Option.Option<ParsedToken> => {
  const segments = token.split('.')
  const [headerSegment, claimsSegment, signatureSegment] = segments
  if (
    segments.length !== 3 ||
    headerSegment === undefined ||
    claimsSegment === undefined ||
    signatureSegment === undefined
  ) {
    return Option.none()
  }
  return Option.all({
    header: decodeJsonSegment(headerSegment),
    claims: decodeJsonSegment(claimsSegment),
    signature: decodeBase64Url(signatureSegment),
    signed: Option.some(
      new TextEncoder().encode(`${headerSegment}.${claimsSegment}`),
    ),
  })
}

const stringAt = (
  record: Readonly<Record<string, unknown>>,
  key: string,
): Option.Option<string> => {
  const value = record[key]
  return typeof value === 'string' && value.length > 0
    ? Option.some(value)
    : Option.none()
}

const numberAt = (
  record: Readonly<Record<string, unknown>>,
  key: string,
): Option.Option<number> => {
  const value = record[key]
  return typeof value === 'number' && Number.isFinite(value)
    ? Option.some(value)
    : Option.none()
}

/** A claim that may be one string or a list of them (`aud`, a role claim). */
const stringsAt = (
  record: Readonly<Record<string, unknown>>,
  key: string,
): ReadonlyArray<string> => {
  const value = record[key]
  if (typeof value === 'string') return value.length > 0 ? [value] : []
  if (!Array.isArray(value)) return []
  const items: ReadonlyArray<unknown> = value
  return items.flatMap(item =>
    typeof item === 'string' && item.length > 0 ? [item] : [],
  )
}

/**
 * The key WebCrypto imports: only the fields that ARE the key.
 *
 * A published key also carries `alg`, `use` and `key_ops`. They are not handed
 * to WebCrypto, which words them its own way, but a key that SAYS what it is
 * for is held to it: one published for encryption, or for another algorithm,
 * does not verify a signature here.
 */
const importableKey = (
  key: PublishedKey,
  algorithm: Algorithm,
  algorithmName: string,
): Option.Option<JsonWebKey> => {
  if (key.kty !== algorithm.keyType) return Option.none()
  if (key.use !== undefined && key.use !== 'sig') return Option.none()
  if (key.alg !== undefined && key.alg !== algorithmName) return Option.none()
  if (algorithm.keyType === 'RSA') {
    return key.n === undefined || key.e === undefined
      ? Option.none()
      : Option.some({ kty: 'RSA', n: key.n, e: key.e })
  }
  return key.crv !== 'P-256' || key.x === undefined || key.y === undefined
    ? Option.none()
    : Option.some({ kty: 'EC', crv: 'P-256', x: key.x, y: key.y })
}

const verifySignature = (
  key: JsonWebKey,
  algorithm: Algorithm,
  token: ParsedToken,
): Effect.Effect<void, IdentityRefused> =>
  Effect.tryPromise({
    try: () =>
      crypto.subtle.importKey('jwk', key, algorithm.importParams, false, [
        'verify',
      ]),
    catch: () => refused('unknown-key'),
  }).pipe(
    Effect.flatMap(imported =>
      Effect.tryPromise({
        try: () =>
          crypto.subtle.verify(
            algorithm.verifyParams,
            imported,
            token.signature,
            token.signed,
          ),
        catch: () => refused('bad-signature'),
      }),
    ),
    Effect.flatMap(valid =>
      valid ? Effect.void : Effect.fail(refused('bad-signature')),
    ),
  )

const keyWithId = (
  keys: ReadonlyArray<PublishedKey>,
  keyId: string,
): Option.Option<PublishedKey> =>
  Option.fromNullishOr(keys.find(key => key.kid === keyId))

type KeyResolver = (
  keyId: string,
) => Effect.Effect<PublishedKey, IdentityRefused>

const orRefuse =
  (reason: IdentityRefusalReason) =>
  <A>(option: Option.Option<A>): Effect.Effect<A, IdentityRefused> =>
    Option.match(option, {
      onNone: () => Effect.fail(refused(reason)),
      onSome: value => Effect.succeed(value),
    })

// `redirect: 'error'`: the HTTPS rule was checked on the configured URL, and a
// redirect would move the trust decision to wherever it points. An issuer that
// redirects its key set is refused, not followed.
const defaultFetch: KeySetFetch = (url, signal) =>
  globalThis.fetch(url, {
    headers: { accept: 'application/json' },
    redirect: 'error',
    signal,
  })

const fetchKeySet = (
  url: string,
  fetchKeys: KeySetFetch,
): Effect.Effect<ReadonlyArray<PublishedKey>, IdentityRefused> =>
  Effect.tryPromise({
    // The signal is aborted when the timeout below gives up, so the request
    // does not stay open behind it.
    try: async signal => {
      const response = await fetchKeys(url, signal)
      return response.ok ? Option.some(await response.text()) : Option.none()
    },
    catch: () => refused('keys-unavailable'),
  }).pipe(
    Effect.timeoutOrElse({
      duration: Duration.millis(IDENTITY_POLICY.keySetFetchTimeoutMillis),
      orElse: () => Effect.fail(refused('keys-unavailable')),
    }),
    Effect.flatMap(body => orRefuse('keys-unavailable')(body)),
    Effect.flatMap(text => orRefuse('keys-unavailable')(decodeKeySet(text))),
    Effect.map(keySet => keySet.keys),
  )

/**
 * Resolves a key id against a key set fetched by URL, keeping the set for
 * `keySetTtlMillis`.
 *
 * The set is held HERE, in the layer. In a long-lived service that is the
 * process, and the cache pays off. A Worker shell rebuilds its layers per
 * request, so there it is one fetch for every call that carries a token.
 * Right for an issuer that rotates its own keys; else give it the inline set.
 *
 * An unknown key id is how a rotated key first shows up, so it earns ONE
 * refetch, no more often than the cooldown. A fetch that fails refuses the
 * call: an issuer that cannot be reached is not a reason to keep trusting an
 * expired copy of its keys.
 *
 * A failed fetch is itself remembered, briefly. Anyone can send a token, so
 * without that an issuer that is down turns every unauthenticated request
 * into an outbound fetch that waits out the timeout.
 *
 * And there is only ever ONE fetch in progress. The cooldowns are stamped
 * when a fetch settles, so on their own they do nothing for the calls that
 * arrive while it is still running: twenty at once on a cold start made twenty
 * fetches. Every caller that needs the set while a fetch runs waits for that
 * fetch.
 */
const makeUrlKeyResolver = (
  url: string,
  fetchKeys: KeySetFetch,
): KeyResolver => {
  let held: Option.Option<{
    readonly keys: ReadonlyArray<PublishedKey>
    readonly fetchedAtMillis: number
  }> = Option.none()
  let failedAtMillis: Option.Option<number> = Option.none()
  let inFlight: Option.Option<
    Deferred.Deferred<ReadonlyArray<PublishedKey>, IdentityRefused>
  > = Option.none()

  /**
   * The key set, from the fetch already running or from a new one.
   *
   * The fetch runs in a fiber of its OWN, not in the caller's. A caller that
   * goes away, which any client can do by closing its connection, then cancels
   * nothing: otherwise one abandoned request would fail the fetch for everyone
   * waiting on it and start the failure cooldown.
   *
   * One synchronous step decides between joining and starting, so two callers
   * cannot both start.
   */
  const sharedKeySet: Effect.Effect<
    ReadonlyArray<PublishedKey>,
    IdentityRefused
  > = Effect.suspend(() => {
    if (Option.isSome(inFlight)) return Deferred.await(inFlight.value)
    const shared = Deferred.makeUnsafe<
      ReadonlyArray<PublishedKey>,
      IdentityRefused
    >()
    inFlight = Option.some(shared)
    const settle = fetchKeySet(url, fetchKeys).pipe(
      Effect.matchEffect({
        // Stamped when the fetch SETTLES, not when it started: a fetch that
        // waited out the timeout would otherwise have spent its own cooldown.
        onSuccess: keys =>
          Effect.flatMap(Clock.currentTimeMillis, settledAt => {
            failedAtMillis = Option.none()
            held = Option.some({ keys, fetchedAtMillis: settledAt })
            return Deferred.succeed(shared, keys)
          }),
        onFailure: refusal =>
          Effect.flatMap(Clock.currentTimeMillis, settledAt => {
            failedAtMillis = Option.some(settledAt)
            return Deferred.fail(shared, refusal)
          }),
      }),
      // However it ended, nobody is left waiting. Completing an already
      // completed Deferred does nothing, so this only acts when the fiber was
      // stopped before it could answer, and then it stamps no cooldown.
      Effect.ensuring(
        Effect.suspend(() => {
          inFlight = Option.none()
          return Deferred.fail(shared, refused('keys-unavailable'))
        }),
      ),
    )
    return Effect.flatMap(Effect.forkDetach(settle), () =>
      Deferred.await(shared),
    )
  })

  return keyId =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis
      const fresh = Option.filter(
        held,
        entry => now - entry.fetchedAtMillis < IDENTITY_POLICY.keySetTtlMillis,
      )
      const known = Option.flatMap(fresh, entry => keyWithId(entry.keys, keyId))
      if (Option.isSome(known)) return known.value
      const fetchedRecently = Option.exists(
        fresh,
        entry =>
          now - entry.fetchedAtMillis <
          IDENTITY_POLICY.keySetRefetchCooldownMillis,
      )
      if (fetchedRecently) return yield* refused('unknown-key')
      const failedRecently = Option.exists(
        failedAtMillis,
        at => now - at < IDENTITY_POLICY.keySetFailureCooldownMillis,
      )
      if (failedRecently) return yield* refused('keys-unavailable')
      const keys = yield* sharedKeySet
      return yield* orRefuse('unknown-key')(keyWithId(keys, keyId))
    })
}

const makeKeyResolver = (
  source: IdentityKeySource,
  fetchKeys: KeySetFetch,
): KeyResolver =>
  source._tag === 'Inline'
    ? keyId => orRefuse('unknown-key')(keyWithId(source.keys, keyId))
    : makeUrlKeyResolver(source.url, fetchKeys)

export type IdentityGateShape = {
  /** The identity a token proves, or the precise reason it proves nothing. */
  readonly verify: (token: string) => Effect.Effect<Identity, IdentityRefused>
}

export class IdentityGate extends Context.Service<
  IdentityGate,
  IdentityGateShape
>()('@bespokeagentics/microdots-runtime/IdentityGate') {}

/**
 * Builds the check itself, FAILING CLOSED when anything is unconfigured.
 *
 * No issuer, no audience or no keys refuses every token, exactly as an unset
 * secret refuses every candidate in `./secret`. The opposite default would
 * turn a forgotten setting in a fresh environment into a service that accepts
 * any well-formed token, and it would look like it was working.
 *
 * The order is deliberate: the algorithm is taken from the allow-list, then
 * the signature is checked, and only THEN is a single claim believed. An
 * unsigned claim is an attacker's sentence.
 */
export const makeIdentityGateLive = (
  config: IdentityConfig,
): Layer.Layer<IdentityGate> => {
  const settings = Option.all({
    issuer: config.issuer,
    audience: config.audience,
    resolveKey: Option.map(config.keys, source =>
      makeKeyResolver(source, config.fetch ?? defaultFetch),
    ),
  })
  const verify = (token: string): Effect.Effect<Identity, IdentityRefused> =>
    Effect.gen(function* () {
      const { issuer, audience, resolveKey } =
        yield* orRefuse('not-configured')(settings)
      const parsed = yield* orRefuse('malformed')(parseToken(token))
      const algorithmName = yield* orRefuse('malformed')(
        stringAt(parsed.header, 'alg'),
      )
      const algorithm = yield* orRefuse('unsupported-algorithm')(
        Option.fromNullishOr(ALGORITHMS.get(algorithmName)),
      )
      // `crit` names extensions a verifier MUST understand or refuse. This one
      // understands none, so a token that carries it is refused.
      if (parsed.header['crit'] !== undefined) {
        return yield* refused('malformed')
      }
      const keyId = yield* orRefuse('malformed')(stringAt(parsed.header, 'kid'))
      const published = yield* resolveKey(keyId)
      const key = yield* orRefuse('unknown-key')(
        importableKey(published, algorithm, algorithmName),
      )
      yield* verifySignature(key, algorithm, parsed)

      const { claims } = parsed
      if (!Option.contains(stringAt(claims, 'iss'), issuer)) {
        return yield* refused('wrong-issuer')
      }
      if (!stringsAt(claims, 'aud').includes(audience)) {
        return yield* refused('wrong-audience')
      }
      const expiresAtSeconds = yield* orRefuse('malformed')(
        numberAt(claims, 'exp'),
      )
      const subject = yield* orRefuse('malformed')(stringAt(claims, 'sub'))
      const nowSeconds = Math.floor((yield* Clock.currentTimeMillis) / 1000)
      if (nowSeconds - IDENTITY_POLICY.clockSkewSeconds >= expiresAtSeconds) {
        return yield* refused('expired')
      }
      // Absent is fine. Present and not a number is a malformed token, the
      // same as `exp`: skipping it would accept a token that says it is not
      // valid yet in a shape this code did not expect.
      const notBefore = numberAt(claims, 'nbf')
      if (claims['nbf'] !== undefined && Option.isNone(notBefore)) {
        return yield* refused('malformed')
      }
      if (
        Option.exists(
          notBefore,
          seconds => nowSeconds + IDENTITY_POLICY.clockSkewSeconds < seconds,
        )
      ) {
        return yield* refused('not-yet-valid')
      }
      return {
        subject,
        roles: stringsAt(claims, config.roleClaim),
        expiresAtSeconds,
        claims,
      }
    })
  return Layer.succeed(IdentityGate, { verify })
}

const BEARER = /^Bearer\s+(\S+)\s*$/i

const bearerToken = (header: string | undefined): Option.Option<string> =>
  Option.flatMap(Option.fromNullishOr(header), value =>
    Option.fromNullishOr(BEARER.exec(value)?.[1]),
  )

/**
 * The server half of `Authenticated`: reads the bearer token from the request,
 * verifies it, and runs the handler with `CurrentIdentity` provided.
 *
 * The precise refusal is logged with the RPC's name and never with the token.
 * The caller is told `missing`, `invalid` or `expired`, and only `expired`
 * differs from `invalid` because a client can act on it.
 */
export const AuthenticatedLive: Layer.Layer<
  Authenticated,
  never,
  IdentityGate
> = Layer.effect(
  Authenticated,
  Effect.gen(function* () {
    const gate = yield* IdentityGate
    return Authenticated.of((effect, options) =>
      Option.match(bearerToken(options.headers[IDENTITY_HEADER]), {
        onNone: () => Effect.fail(new Unauthenticated({ reason: 'missing' })),
        onSome: token =>
          gate.verify(token).pipe(
            Effect.tapError(refusal =>
              Effect.logWarning('Identity refused').pipe(
                Effect.annotateLogs({
                  reason: refusal.reason,
                  rpc: options.rpc._tag,
                }),
              ),
            ),
            Effect.mapError(
              refusal =>
                new Unauthenticated({
                  reason: refusal.reason === 'expired' ? 'expired' : 'invalid',
                }),
            ),
            Effect.flatMap(identity =>
              Effect.provideService(effect, CurrentIdentity, identity),
            ),
          ),
      }),
    )
  }),
)

/**
 * The layer a service adds beside its handlers to serve RPCs marked
 * `Authenticated`: `makeAuthenticatedLive(identityConfigFrom(env))`.
 *
 * A service that gates an RPC also allows the request header through CORS:
 * pass `allowedHeaders: [IDENTITY_HEADER]` to `makeRpcService` and
 * `makeMicroDotWorker`. The shared default list is not widened for services
 * that gate nothing.
 */
export const makeAuthenticatedLive = (
  config: IdentityConfig,
): Layer.Layer<Authenticated> =>
  AuthenticatedLive.pipe(Layer.provide(makeIdentityGateLive(config)))

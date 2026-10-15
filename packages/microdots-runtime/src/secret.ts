import { type Clock, Context, Effect, Layer, Option } from 'effect'

import { SECRET_ATTEMPT_POLICY } from './secretPolicy.ts'

export {
  SECRET_ATTEMPT_POLICY,
  type SecretAttemptPolicy,
  secretRefusalSentence,
} from './secretPolicy.ts'

/**
 * A shared-secret gate — a dashboard PIN, an admin token — read from wherever
 * the running entry keeps its secrets.
 *
 * Deliberately a service rather than a bare string so the two rules below live
 * in one testable place instead of being re-derived at each call site.
 */
export type SecretGateShape = {
  readonly verify: (candidate: string) => boolean
}

export class SecretGate extends Context.Service<SecretGate, SecretGateShape>()(
  '@bespokeagentics/microdots-runtime/SecretGate',
) {}

/**
 * Compares without leaking length or position through timing.
 *
 * A PIN is short and the wire is slow, so a timing attack here is not the
 * realistic threat — but an early-exit compare is also the kind of thing that
 * gets copied into somewhere it does matter, and the constant-time version is
 * three lines.
 */
const constantTimeEquals = (left: string, right: string): boolean => {
  if (left.length !== right.length) {
    return false
  }
  let difference = 0
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index)
  }
  return difference === 0
}

/**
 * Builds the check itself, FAILING CLOSED when nothing is configured.
 *
 * An unset or blank secret rejects every candidate rather than accepting any.
 * The opposite default — treating "no secret configured" as "no secret
 * required" — turns a forgotten secret in a fresh environment into a public
 * dump of whatever the gate protects, and it does so silently, because the
 * gated view looks like it is working correctly.
 *
 * Exported apart from the layer for the service that needs a second gate under
 * its own key: declare a `Context.Service` with `SecretGateShape` and reuse
 * this verifier.
 */
export const makeSecretVerifier =
  (configured: string | undefined) =>
  (candidate: string): boolean =>
    Option.match(
      Option.filter(
        Option.fromNullishOr(configured),
        secret => secret.trim().length > 0,
      ),
      {
        onNone: () => false,
        onSome: secret => constantTimeEquals(candidate, secret),
      },
    )

/**
 * Wraps a verifier in `SECRET_ATTEMPT_POLICY`.
 *
 * The answer is only ever `true` or `false`: a paused gate refuses exactly as a
 * wrong candidate does, so neither a caller nor whoever is guessing through it
 * can tell a near miss, a wrong secret and a pause apart. The compare runs on
 * every attempt, paused or not, so the time an answer takes does not tell them
 * apart either.
 *
 * It keeps the readings of the recent FAILURES, never a run length: a right
 * candidate arriving between wrong ones neither counts nor clears them, so an
 * owner's own polling cannot reset a guesser's budget. A failure older than
 * the window stops counting.
 *
 * `nowMillis` is a MONOTONIC reading passed in rather than read here, so the
 * policy is a pure function of its inputs and a TestClock drives it. A reading
 * earlier than the pause began ends the pause rather than stretching it, and a
 * failure recorded after the current reading no longer counts.
 */
export const makeAttemptLimitedVerifier = (
  verify: (candidate: string) => boolean,
): ((candidate: string, nowMillis: number) => boolean) => {
  let failures: ReadonlyArray<number> = []
  let pausedSince: Option.Option<number> = Option.none()
  const paused = (nowMillis: number): boolean =>
    Option.match(pausedSince, {
      onNone: () => false,
      onSome: since =>
        nowMillis >= since &&
        nowMillis - since < SECRET_ATTEMPT_POLICY.pauseMillis,
    })
  return (candidate, nowMillis) => {
    const matched = verify(candidate)
    if (paused(nowMillis)) {
      return false
    }
    pausedSince = Option.none()
    if (matched) {
      return true
    }
    failures = [
      ...failures.filter(
        at =>
          at <= nowMillis &&
          nowMillis - at < SECRET_ATTEMPT_POLICY.failureWindowMillis,
      ),
      nowMillis,
    ]
    if (failures.length >= SECRET_ATTEMPT_POLICY.failuresBeforePause) {
      failures = []
      pausedSince = Option.some(nowMillis)
    }
    return false
  }
}

const NANOS_PER_MILLI = BigInt(1_000_000)

/** Milliseconds on the Clock's monotonic time, which a wall-clock correction does not move. */
export const monotonicMillis = (
  clock: Pick<Clock.Clock, 'monotonicTimeNanosUnsafe'>,
): number => Number(clock.monotonicTimeNanosUnsafe() / NANOS_PER_MILLI)

/**
 * The gate a PERSON types a secret into (a dashboard PIN, an access code),
 * under `SECRET_ATTEMPT_POLICY`.
 *
 * The count is created HERE, once per call, so every layer built from one call
 * shares it: a service that hands the same gate to its RPC layer and its upload
 * routes gives a guesser one budget, not one per route. The time is the
 * monotonic reading of the Clock the layer is built under.
 *
 * A key one service sends another goes through `makeServiceKeyGateLive`.
 */
export const makeSecretGateLive = (
  configured: string | undefined,
): Layer.Layer<SecretGate> => {
  const attempt = makeAttemptLimitedVerifier(makeSecretVerifier(configured))
  return Layer.effect(
    SecretGate,
    Effect.clockWith(clock =>
      Effect.succeed({
        verify: (candidate: string) => attempt(candidate, monotonicMillis(clock)),
      }),
    ),
  )
}

/**
 * The gate for a key one SERVICE sends another (a catalog write key): the bare
 * fail-closed compare, with no pause.
 *
 * Such a key is long and random and no person retries it, so pausing it buys
 * nothing against guessing, and it would hand any stranger a switch that turns
 * the writes it guards off for fifteen minutes while the calling service reads
 * the refusal as a wrong key. Never use it for a secret a person types.
 */
export const makeServiceKeyGateLive = (
  configured: string | undefined,
): Layer.Layer<SecretGate> =>
  Layer.succeed(SecretGate, { verify: makeSecretVerifier(configured) })

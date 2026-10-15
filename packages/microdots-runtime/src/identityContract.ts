import { Context, Schema as S } from 'effect'
import { RpcMiddleware } from 'effect/unstable/rpc'

/**
 * The contract half of the identity gate: what a MicroDot's `src/contract.ts`
 * and its browser client need, and nothing that verifies anything.
 *
 * Schema-only and browser-safe, re-exported from the bare entry. The verifier
 * itself (WebCrypto, fetch, the key set) lives in `./identity`, which browser
 * code must never import: the same split `./trace` and `./secret` make.
 */

/**
 * The header a gated call carries, as `Bearer <token>`.
 *
 * A real HTTP header rather than a payload field, on purpose. Effect redacts
 * `authorization` wherever it prints headers, and a payload field has no such
 * protection: the trace vocabulary can carry a call's arguments.
 */
export const IDENTITY_HEADER = 'authorization'

/** Who is calling, as the verifier established it. Never built from unverified input. */
export type Identity = {
  /** The token's `sub`: the stable id every user-owned row is keyed by. */
  readonly subject: string
  /** The role claim, as a list. Empty when the token carries none. */
  readonly roles: ReadonlyArray<string>
  /** The token's `exp`, in seconds since the epoch. */
  readonly expiresAtSeconds: number
  /** Every verified claim, for a service that needs one this type does not name. */
  readonly claims: Readonly<Record<string, unknown>>
}

/**
 * The identity a gated handler reads.
 *
 * Only `Authenticated` provides it, so a handler that yields this service
 * cannot be served by an RPC that is not marked with the middleware: the gap is
 * a type error, not a review comment.
 */
export class CurrentIdentity extends Context.Service<
  CurrentIdentity,
  Identity
>()('@bespokeagentics/microdots-runtime/CurrentIdentity') {}

/**
 * Why a gated call was refused, as far as the caller is told.
 *
 * Three values, deliberately coarse. `expired` is the only one a client acts
 * on differently: it asks its host for a fresh token and tries once more.
 * Everything else the verifier knows (a wrong audience, an unknown key, a
 * service with no configuration) stays in the service's log.
 */
export const UnauthenticatedReason = S.Literals([
  'missing',
  'invalid',
  'expired',
])
export type UnauthenticatedReason = typeof UnauthenticatedReason.Type

/** The wire error of every RPC marked with `Authenticated`. */
export class Unauthenticated extends S.TaggedError<Unauthenticated>()('Unauthenticated', {
  reason: UnauthenticatedReason,
}) {}

/**
 * Marks an RPC as needing a verified identity:
 * `Rpc.make('listThreads', { ... }).middleware(Authenticated)`.
 *
 * The server refuses to serve a marked RPC until the verifier half is in its
 * layer (`makeAuthenticatedLive` from `./identity`), and `Unauthenticated`
 * joins that RPC's error union without being listed.
 *
 * Not `requiredForClient`: the client sends the header at the HTTP layer
 * (`makeIdentityRpcClientLive`), so there is no client middleware to install.
 */
export class Authenticated extends RpcMiddleware.Service<
  Authenticated,
  { provides: CurrentIdentity }
>()('@bespokeagentics/microdots-runtime/Authenticated', {
  error: Unauthenticated,
}) {}

/** Whether a verified identity carries a role. Authentication is not authorization. */
export const hasRole = (identity: Identity, role: string): boolean =>
  identity.roles.includes(role)

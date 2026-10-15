/**
 * Which RPCs a MicroDot publishes, and the one list both published forms read.
 *
 * A contract marks an RPC public with `rpc.annotate(PublicApi, { ... })`.
 * `publicOperations` turns a group into the operations that marker selects, and
 * it is the ONLY place that decides the path and the operation id. The REST
 * facade (`./rest`) registers a route per operation and the OpenAPI deriver
 * (`@bespokeagentics/microdots-openapi`) writes a path per operation, so a spec
 * cannot list a URL the service does not answer: both read this list.
 *
 * Platform-free on purpose. A contract imports it from the bare
 * `@bespokeagentics/microdots-runtime` entry, like `StorageFailure`, so nothing
 * here may reach for the router, node or a Worker binding.
 */
import { Context, Option, Schema as S } from 'effect'
import { RpcSchema } from 'effect/unstable/rpc'

/**
 * The `422` body: the request did not decode against the operation's payload
 * schema. The one response the facade adds that no contract declares, so it is
 * stated here once and the deriver publishes this same schema.
 */
export class PayloadRejected extends S.TaggedError<PayloadRejected>()(
  'PayloadRejected',
  { message: S.String },
) {}

/** The `x-fern-availability` vocabulary, which Forge and astro-fern both read. */
export type PublicApiStatus =
  | 'alpha'
  | 'beta'
  | 'preview'
  | 'generally-available'
  | 'deprecated'

export type PublicApiAnnotation = {
  /**
   * What the operation does, for someone who has never seen the contract. The
   * spec, the SDK's doc comment and the docs page all print it, so an empty one
   * is refused rather than published.
   */
  readonly description: string
  /** One plain line for listings. Left out, the docs fall back to the name. */
  readonly summary?: string
  /** Defaults to `beta`. */
  readonly status?: PublicApiStatus
}

export class PublicApi extends Context.Service<
  PublicApi,
  PublicApiAnnotation
>()('microdots/PublicApi') {}

export const DEFAULT_PUBLIC_API_STATUS: PublicApiStatus = 'beta'

/** The mount point of every published operation. */
export const PUBLIC_API_PREFIX = '/api'

/**
 * What `publicOperations` reads from an RPC, and no more.
 *
 * STRUCTURAL ON PURPOSE. An RPC carrying middleware is not assignable to
 * Effect's `Rpc.AnyWithProps`, so typing the input that way turned the
 * middleware refusal into a type error naming a missing service. With this
 * shape the group is accepted and the RPC is refused with its reason, which is
 * what a contract author can act on. `restFacadeLayer` keeps the stricter type.
 */
export type PublishableRpc = {
  readonly _tag: string
  readonly annotations: Context.Context<never>
  readonly payloadSchema: S.Top
  readonly successSchema: S.Top
  readonly errorSchema: S.Top
  readonly middlewares: ReadonlySet<unknown>
}

/** The part of an `RpcGroup` this reads. Every `RpcGroup` has it. */
export type PublishableGroup<R extends PublishableRpc> = {
  readonly requests: ReadonlyMap<string, R>
}

export type PublicOperation<R extends PublishableRpc> = {
  /** The MicroDot's directory name, e.g. `roster`. */
  readonly dot: string
  readonly tag: string
  /** `<dot>.<tag>`. Tags repeat across dots (`getTopology`, `listHosts`). */
  readonly operationId: string
  /** `/api/<dot>/<tag>`, served by the dot's own origin. */
  readonly path: `/${string}`
  readonly description: string
  readonly summary: Option.Option<string>
  readonly status: PublicApiStatus
  readonly rpc: R
}

export type PublicApiRefusalReason =
  | 'invalid-dot'
  | 'invalid-tag'
  | 'no-description'
  | 'streaming'
  | 'middleware'

/** An RPC marked public that cannot be published, and what to do about it. */
export type PublicApiRefusal = {
  readonly operationId: string
  readonly reason: PublicApiRefusalReason
  readonly message: string
}

export type PublicOperations<R extends PublishableRpc> = {
  readonly operations: ReadonlyArray<PublicOperation<R>>
  readonly refusals: ReadonlyArray<PublicApiRefusal>
}

const DOT_NAME = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u
// A tag becomes a URL segment and an SDK method name.
const RPC_TAG = /^[A-Za-z][A-Za-z0-9]*$/u

export const publicOperationPath = (
  dot: string,
  tag: string,
): `/${string}` => `${PUBLIC_API_PREFIX}/${dot}/${tag}`

const refusalMessage = (
  operationId: string,
  reason: PublicApiRefusalReason,
): string => {
  switch (reason) {
    case 'invalid-dot':
      return `${operationId} cannot be published: the MicroDot name must be lower-kebab, like its directory. Pass the directory name to publicOperations.`
    case 'invalid-tag':
      return `${operationId} cannot be published: its RPC tag becomes a URL segment and an SDK method name, so it must be letters and digits starting with a letter. Rename the RPC, or remove its PublicApi annotation.`
    case 'no-description':
      return `${operationId} is marked public with an empty description. Give its PublicApi annotation a description: the spec, the SDK and the docs page all print it.`
    case 'streaming':
      return `${operationId} is a streaming RPC and cannot be published yet: the REST facade answers one JSON body per request. Remove its PublicApi annotation, or publish a non-streaming RPC for the same data.`
    case 'middleware':
      return `${operationId} carries RPC middleware and cannot be published yet: the REST facade calls the handler directly and would skip it, so a gate that lives in middleware would not run. Remove its PublicApi annotation, or move the check into the handler.`
  }
}

const refusalReason = (
  dot: string,
  rpc: PublishableRpc,
  annotation: PublicApiAnnotation,
): Option.Option<PublicApiRefusalReason> => {
  if (!DOT_NAME.test(dot)) return Option.some('invalid-dot')
  if (!RPC_TAG.test(rpc._tag)) return Option.some('invalid-tag')
  if (annotation.description.trim() === '') return Option.some('no-description')
  if (RpcSchema.isStreamSchema(rpc.successSchema))
    return Option.some('streaming')
  if (rpc.middlewares.size > 0) return Option.some('middleware')
  return Option.none()
}

/**
 * The operations a group publishes, in the group's own order, and every RPC
 * that carries the marker but cannot be published. An RPC without the marker is
 * in neither list: it is not public and no one is told about it.
 */
export const publicOperations = <R extends PublishableRpc>(
  dot: string,
  group: PublishableGroup<R>,
): PublicOperations<R> => {
  const operations: Array<PublicOperation<R>> = []
  const refusals: Array<PublicApiRefusal> = []
  for (const rpc of group.requests.values()) {
    const marked = Context.getOption(rpc.annotations, PublicApi)
    if (Option.isNone(marked)) continue
    const annotation = marked.value
    const operationId = `${dot}.${rpc._tag}`
    const refused = refusalReason(dot, rpc, annotation)
    if (Option.isSome(refused)) {
      refusals.push({
        operationId,
        reason: refused.value,
        message: refusalMessage(operationId, refused.value),
      })
      continue
    }
    operations.push({
      dot,
      tag: rpc._tag,
      operationId,
      path: publicOperationPath(dot, rpc._tag),
      description: annotation.description.trim(),
      summary: Option.fromNullishOr(annotation.summary),
      status: annotation.status ?? DEFAULT_PUBLIC_API_STATUS,
      rpc,
    })
  }
  return { operations, refusals }
}

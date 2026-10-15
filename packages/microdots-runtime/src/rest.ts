/**
 * The REST facade: one `POST /api/<dot>/<rpc>` route per RPC a contract marks
 * public, answering plain JSON.
 *
 * WHY IT EXISTS. Every service speaks one `POST /rpc` NDJSON envelope, and an
 * OpenAPI document cannot put many operations on one path and method. A spec of
 * that wire would list URLs no server answers, and a generated SDK would call
 * them. So a published operation gets a route of its own.
 *
 * WHY IT CANNOT DRIFT FROM THE SPEC. The routes come from `publicOperations`,
 * the list `@bespokeagentics/microdots-openapi` derives the document from, and
 * the bodies go through `Schema.toCodecJson`, the codec
 * `Schema.toJsonSchemaDocument` describes. Path, status and shape have one
 * source each.
 *
 * WHAT IT IS NOT. It is not a second implementation: each route calls the
 * handler the RPC server calls, through `group.accessHandler`. An RPC without
 * the marker gets no route, so adding the facade widens nothing.
 *
 * Platform-neutral, like `./worker`: Effect core, `unstable/http` and
 * `unstable/rpc` only, so a dot's `service/handlers.ts` merges it into the
 * layer both of its entries share.
 */
import {
  type Context,
  Effect,
  Exit,
  Layer,
  Option,
  Schema as S,
  Stream,
} from 'effect'
import {
  HttpRouter,
  type HttpServerRequest,
  HttpServerResponse,
} from 'effect/unstable/http'
import { Rpc, type RpcGroup, RpcMessage } from 'effect/unstable/rpc'

import {
  PayloadRejected,
  type PublicOperation,
  publicOperations,
} from './publicApi.ts'

const respond = (
  status: number,
  body: unknown,
): HttpServerResponse.HttpServerResponse =>
  HttpServerResponse.jsonUnsafe(body, { status })

const encodeRejection = S.encodeUnknownExit(S.toCodecJson(PayloadRejected))

/** `422`, in the one shape the spec publishes for it. */
const rejected = (message: string): HttpServerResponse.HttpServerResponse => {
  const body = encodeRejection(new PayloadRejected({ message }))
  return Exit.isSuccess(body)
    ? respond(422, body.value)
    : respond(422, { _tag: 'PayloadRejected', message })
}

/**
 * `500`. Deliberately says nothing about the cause: a defect's message is the
 * service's own detail, and this body crosses a public origin.
 */
const failedInternally = respond(500, {
  _tag: 'InternalFailure',
  message: 'The service failed while handling this request.',
})

// The facade is one caller. The RPC server numbers its clients; this one is 0.
const FACADE_CLIENT = new Rpc.ServerClient(0)

/**
 * A schema the facade can run without services. The facade decodes and encodes
 * synchronously inside a route, where nothing could provide them.
 */
type ServiceFreeSchema = S.Top & {
  readonly DecodingServices: never
  readonly EncodingServices: never
}

/**
 * An RPC whose three schemas are service-free, which is every RPC a contract
 * builds from plain structs, unions and tagged errors. A group holding one that
 * is not fails to compile at `restFacadeLayer`, rather than at a request.
 */
export type RestFacadeRpc = Rpc.AnyWithProps & {
  readonly payloadSchema: ServiceFreeSchema
  readonly successSchema: ServiceFreeSchema
  readonly errorSchema: ServiceFreeSchema
}

const route = <R extends RestFacadeRpc>(
  handlers: Context.Context<Rpc.ToHandler<R>>,
  operation: PublicOperation<R>,
) => {
  const decodePayload = S.decodeUnknownExit(
    S.toCodecJson(operation.rpc.payloadSchema),
  )
  const encodeSuccess = S.encodeUnknownExit(
    S.toCodecJson(operation.rpc.successSchema),
  )
  const encodeFailure = S.encodeUnknownExit(
    S.toCodecJson(operation.rpc.errorSchema),
  )
  // The lookup the RPC server itself makes, by the RPC's key
  // (`repos/effect/packages/effect/src/unstable/rpc/RpcServer.ts:245`). The
  // typed `group.accessHandler` cannot be called with a payload whose type is
  // only known per operation, and this entry takes the decoded value as is.
  // `mapUnsafe` is the public map behind a `Context`; the getter the server
  // uses is stripped from the published types.
  const entry: Rpc.Handler<string> | undefined = handlers.mapUnsafe.get(
    operation.rpc.key,
  )
  let requests = 0

  return (request: HttpServerRequest.HttpServerRequest) =>
    Effect.gen(function* () {
      if (entry === undefined) return failedInternally
      const body = yield* Effect.option(request.json)
      if (Option.isNone(body)) {
        return rejected('The request body is not JSON.')
      }
      const payload = decodePayload(body.value)
      if (Exit.isFailure(payload)) {
        return rejected(
          Option.match(Exit.findErrorOption(payload), {
            onNone: () => 'The request body does not match the payload schema.',
            onSome: error => error.message,
          }),
        )
      }

      requests += 1
      const returned = entry.handler(payload.value, {
        client: FACADE_CLIENT,
        requestId: RpcMessage.RequestId(requests),
        headers: request.headers,
        rpc: operation.rpc,
      })
      // A handler may wrap its result (`Rpc.fork`); the server unwraps it too.
      const result: Effect.Effect<unknown, unknown> | Stream.Stream<unknown> =
        Rpc.isWrapper(returned) ? returned.value : returned
      // `publicOperations` refuses a streaming RPC, so this is unreachable
      // through a derived route. It is checked because the type allows it.
      if (Stream.isStream(result)) return failedInternally

      const outcome = yield* Effect.exit(Effect.provide(result, entry.context))
      if (Exit.isSuccess(outcome)) {
        const encoded = encodeSuccess(outcome.value)
        return Exit.isSuccess(encoded)
          ? respond(200, encoded.value)
          : failedInternally
      }
      const failure = Exit.findErrorOption(outcome)
      if (Option.isNone(failure)) return failedInternally
      const encoded = encodeFailure(failure.value)
      return Exit.isSuccess(encoded)
        ? respond(400, encoded.value)
        : failedInternally
    })
}

/**
 * The routes for every RPC `group` marks public, as a layer to merge beside
 * `RpcServer.layerHttp`. It needs the same handlers that layer needs, so one
 * `Layer.provide(HandlersLive)` over the merged pair serves both.
 *
 * An RPC `publicOperations` refuses gets no route. The refusal is reported by
 * `bun run openapi:check`, which derives from the same list, so a contract that
 * cannot be published fails the gate rather than a request.
 */
export const restFacadeLayer = <R extends RestFacadeRpc>(
  dot: string,
  group: RpcGroup.RpcGroup<R>,
) =>
  Layer.unwrap(
    Effect.gen(function* () {
      // Captured once, when the layer is built: a router route runs per
      // request, outside the layer that provided the handlers.
      const handlers = yield* Effect.context<Rpc.ToHandler<R>>()
      return publicOperations(dot, group).operations.reduce<
        Layer.Layer<never, never, HttpRouter.HttpRouter>
      >(
        (routes, operation) =>
          Layer.merge(
            routes,
            HttpRouter.add('POST', operation.path, route(handlers, operation)),
          ),
        Layer.empty,
      )
    }),
  )

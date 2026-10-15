import { type Context, Layer } from 'effect'
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
} from 'effect/unstable/http'
import {
  type Rpc,
  RpcClient,
  type RpcClientError,
  type RpcGroup,
  RpcSerialization,
} from 'effect/unstable/rpc'

const RPC_PATH = '/rpc'

/**
 * The browser half of the wire. Serialization must match the service, which is
 * why both sides come from this package rather than being chosen per MicroDot.
 *
 * Takes `baseUrl` as an argument on purpose: a MicroDot is mounted by an
 * arbitrary host, so its backend address is runtime configuration (an
 * attribute), never a build-time environment variable.
 */
export const rpcProtocolLayer = (baseUrl: string) =>
  RpcClient.layerProtocolHttp({ url: `${baseUrl}${RPC_PATH}` }).pipe(
    Layer.provide([FetchHttpClient.layer, RpcSerialization.layerNdjson]),
  )

/**
 * Builds a MicroDot's client layer from its service key and RpcGroup.
 *
 * Every MicroDot's client module was the same three moves — alias
 * `RpcClient.FromGroup`, wrap it in a `Context.Service`, `Layer.effect` it over
 * `rpcProtocolLayer` — differing only in names, so the names are all a
 * MicroDot supplies now.
 *
 * Still a function of `baseUrl`, for the same reason `rpcProtocolLayer` is.
 * The residual `Rpc.MiddlewareClient<Rpcs>` requirement reduces to `never` for
 * any group without client middleware — every MicroDot today — so a caller
 * annotates its exported const `(baseUrl: string) => Layer.Layer<XClient>` and
 * the annotation, not a cast, proves it.
 */
export const makeRpcClientLive =
  <Self, Rpcs extends Rpc.Any>(
    service: Context.Key<
      Self,
      RpcClient.RpcClient<Rpcs, RpcClientError.RpcClientError>
    >,
    group: RpcGroup.RpcGroup<Rpcs>,
  ) =>
  (baseUrl: string): Layer.Layer<Self, never, Rpc.MiddlewareClient<Rpcs>> =>
    Layer.effect(service, RpcClient.make(group)).pipe(
      Layer.provide(rpcProtocolLayer(baseUrl)),
    )

/**
 * `rpcProtocolLayer` for a service that gates RPCs with `Authenticated`: every
 * request carries the host-supplied identity token as a bearer token.
 *
 * The header is set on the HTTP request, not inside the RPC envelope, so it is
 * the standard `Authorization` header a proxy, a log redactor and a reader of
 * the network panel all recognise.
 *
 * `token` is `undefined` for a signed-out caller, and blank is treated the
 * same. No header is sent then, and the service answers a gated RPC with
 * `Unauthenticated` (`missing`), which is the signed-out state rather than an
 * error to hide.
 */
export const identityRpcProtocolLayer = (
  baseUrl: string,
  token: string | undefined,
) => {
  const bearer = token?.trim() ?? ''
  return RpcClient.layerProtocolHttp({
    url: `${baseUrl}${RPC_PATH}`,
    transformClient: client =>
      bearer === ''
        ? client
        : HttpClient.mapRequest(client, HttpClientRequest.bearerToken(bearer)),
  }).pipe(Layer.provide([FetchHttpClient.layer, RpcSerialization.layerNdjson]))
}

/**
 * `makeRpcClientLive` for a MicroDot whose contract marks RPCs `Authenticated`.
 *
 * A function of the base URL AND the token, because both are runtime
 * configuration the mounting host supplies as attributes: the token is
 * short-lived and the host replaces it, so the client layer is built per call
 * from the model, exactly as it already is for the base URL.
 */
export const makeIdentityRpcClientLive =
  <Self, Rpcs extends Rpc.Any>(
    service: Context.Key<
      Self,
      RpcClient.RpcClient<Rpcs, RpcClientError.RpcClientError>
    >,
    group: RpcGroup.RpcGroup<Rpcs>,
  ) =>
  (
    baseUrl: string,
    token: string | undefined,
  ): Layer.Layer<Self, never, Rpc.MiddlewareClient<Rpcs>> =>
    Layer.effect(service, RpcClient.make(group)).pipe(
      Layer.provide(identityRpcProtocolLayer(baseUrl, token)),
    )

export { RpcSerialization }

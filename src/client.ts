import { Context, Effect, Layer, Schema as S } from 'effect'
import { FetchHttpClient, HttpClient } from 'effect/unstable/http'
import { RpcClient, type RpcClientError, RpcSerialization } from 'effect/unstable/rpc'

import { DiscoveryRpcs, SessionState } from './contract.ts'

export class DiscoveryClient extends Context.Service<
  DiscoveryClient,
  RpcClient.FromGroup<typeof DiscoveryRpcs, RpcClientError.RpcClientError>
>()('DiscoveryClient') {}

/** Send the owner cookie to `api-url` even when it is another local origin
 * (the :5193 mini-host); same-origin pages behave as before. */
const ownerCredentials: RequestInit = { credentials: 'include' }

/** Preserve an HTTP401 from the session guard before the RPC decoder reads its body. */
const ownerHttpClient = Layer.effect(HttpClient.HttpClient,
  Effect.map(HttpClient.HttpClient, HttpClient.filterStatusOk),
).pipe(Layer.provide(FetchHttpClient.layer.pipe(
  Layer.provide(Layer.succeed(FetchHttpClient.RequestInit, ownerCredentials)),
)))

/** Cookies authorize requests; runtime attributes only select their context. */
export const makeDiscoveryClientLive = (baseUrl: string): Layer.Layer<DiscoveryClient> =>
  Layer.effect(DiscoveryClient, RpcClient.make(DiscoveryRpcs)).pipe(Layer.provide(
    RpcClient.layerProtocolHttp({ url: `${baseUrl}/rpc` }).pipe(
      Layer.provide([ownerHttpClient, RpcSerialization.layerNdjson]),
    ),
  ))

export const discoverySession = (baseUrl: string, method: 'GET' | 'POST' | 'DELETE', token = '') =>
  Effect.tryPromise({
    try: async () => {
      const response = await fetch(`${baseUrl}/session`, {
        method,
        ...ownerCredentials,
        headers: { 'Content-Type': 'application/json' },
        ...(method === 'POST' ? { body: JSON.stringify({ token }) } : {}),
      })
      if (!response.ok) throw new Error(response.status === 401 ? 'The owner token was not accepted.' : 'Could not connect to the local owner session.')
      return await response.json()
    },
    catch: error => error instanceof Error ? error.message : 'Could not connect to the local owner session.',
  }).pipe(Effect.flatMap(payload => S.decodeUnknownEffect(SessionState)(payload).pipe(
    Effect.mapError(() => 'The local service returned an invalid session response.'),
  )))

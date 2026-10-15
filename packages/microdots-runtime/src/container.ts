/**
 * The front door of a MicroDot whose service runs in a Cloudflare Container.
 * Workers only: it imports `@cloudflare/containers`, which imports
 * `cloudflare:workers`. Never import it from a widget or a Bun service.
 *
 * A dot that needs a process (a job that outlives its request, a child process,
 * a held connection) runs its ordinary Bun `service/main.ts` in a container.
 * This module is everything on the Worker's side of that, in one call, the way
 * `makeMicroDotWorker` is for a Worker service:
 *
 *  * ONE instance per dot, by name, so jobs held in memory live in one place.
 *  * `d1.internal`: an outbound handler that runs the container's SQL on the
 *    Worker's D1 binding. The container reaches it with `makeRemoteD1Database`
 *    from `/d1`, so the dot's `storeD1.ts` runs unchanged.
 *  * `alive.internal`: an outbound handler that renews the container's activity
 *    timeout; `keepAwakeWhile` from `/service` pings it while a job runs.
 *  * The named Worker secrets and vars, passed in as environment variables.
 *
 * Plan and the documentation it rests on:
 * `wiki/plans/active/long-lived-dot-service-in-a-cloudflare-container.md`.
 */
import { Container, type OutboundHandlerContext } from '@cloudflare/containers'

import { MICRODOT_ALIVE_URL_VARIABLE } from './containerActivity'
import { type D1Database, answerRemoteD1 } from './d1'

export { ContainerProxy } from '@cloudflare/containers'

/** The made-up hostnames the container calls; outbound handlers answer them. */
export const REMOTE_D1_URL = 'http://d1.internal'
export const ALIVE_URL = 'http://alive.internal'
/** Where the container's service finds `REMOTE_D1_URL`. */
export const MICRODOT_D1_URL_VARIABLE = 'MICRODOT_D1_URL'
/** A Worker var that overrides `sleepAfter`, e.g. `90s`. */
export const MICRODOT_SLEEP_AFTER_VARIABLE = 'MICRODOT_SLEEP_AFTER'

export type MicroDotContainerOptions = {
  /** The port `service/main.ts` listens on inside the container. */
  readonly port: number
  /** The Durable Object binding for the container class, e.g. `SERVICE`. */
  readonly binding: string
  /** A D1 binding the container may use through `d1.internal`. */
  readonly d1?: string
  /** Worker secrets or vars to pass into the container, by name. */
  readonly env?: ReadonlyArray<string>
  /**
   * How long with no request before the container sleeps. Default `10m`. A
   * Worker var named `MICRODOT_SLEEP_AFTER` overrides it per deployment, which
   * is how the heartbeat is proven against a short timer.
   */
  readonly sleepAfter?: string
  /** Whether the container may reach the public internet. Default false. */
  readonly internet?: boolean
}

type Bindings = Readonly<Record<string, unknown>>
/** The slice of a Durable Object namespace used here, declared structurally. */
type Namespace = {
  readonly idFromName: (name: string) => unknown
  readonly idFromString: (id: string) => unknown
  readonly get: (id: unknown) => {
    readonly fetch: (request: Request) => Promise<Response>
    readonly renewActivity: () => Promise<void>
  }
}

const isD1 = (value: unknown): value is D1Database =>
  typeof value === 'object' &&
  value !== null &&
  'prepare' in value &&
  'batch' in value
const isNamespace = (value: unknown): value is Namespace =>
  typeof value === 'object' &&
  value !== null &&
  'idFromName' in value &&
  'idFromString' in value &&
  'get' in value
const refusal = (status: number, message: string) =>
  new Response(message, {
    status,
    headers: { 'content-type': 'text/plain; charset=utf-8' },
  })

/**
 * Returns the container class to export under the config's `class_name`, and
 * the Worker's `fetch`. The entry also re-exports `ContainerProxy`, which
 * outbound interception needs.
 *
 *     const service = makeMicroDotContainerWorker({ port: 3127, binding: 'SERVICE', d1: 'DB' })
 *     export const ErrandContainer = service.Container
 *     export { ContainerProxy } from '@bespokeagentics/microdots-runtime/container'
 *     export default { fetch: service.fetch }
 */
export const makeMicroDotContainerWorker = (
  options: MicroDotContainerOptions,
) => {
  const d1Handler = async (request: Request, env: Bindings) => {
    const database = options.d1 === undefined ? undefined : env[options.d1]
    return isD1(database)
      ? answerRemoteD1(request, database)
      : refusal(503, `no D1 binding named ${options.d1 ?? '(none)'}`)
  }
  const aliveHandler = async (
    _request: Request,
    env: Bindings,
    ctx: OutboundHandlerContext,
  ) => {
    const namespace = env[options.binding]
    if (!isNamespace(namespace))
      return refusal(503, `no Durable Object binding named ${options.binding}`)
    await namespace.get(namespace.idFromString(ctx.containerId)).renewActivity()
    return new Response(null, { status: 204 })
  }

  class MicroDotContainer extends Container<Bindings> {
    override defaultPort = options.port
    override sleepAfter = options.sleepAfter ?? '10m'
    override enableInternet = options.internet ?? false

    constructor(ctx: unknown, env: Bindings) {
      super(ctx, env)
      const sleepAfter = env[MICRODOT_SLEEP_AFTER_VARIABLE]
      if (typeof sleepAfter === 'string' && sleepAfter.trim() !== '')
        this.sleepAfter = sleepAfter.trim()
      const passed: Record<string, string> = {}
      for (const name of options.env ?? []) {
        const value = env[name]
        // An unset secret stays unset, so the service fails closed on it.
        if (typeof value === 'string') passed[name] = value
      }
      this.envVars = {
        ...passed,
        [MICRODOT_ALIVE_URL_VARIABLE]: ALIVE_URL,
        ...(options.d1 === undefined
          ? {}
          : { [MICRODOT_D1_URL_VARIABLE]: REMOTE_D1_URL }),
      }
    }

    /** Called by the `alive.internal` handler while a job runs. */
    async renewActivity(): Promise<void> {
      this.renewActivityTimeout()
    }
  }

  // Through the inherited static SETTER, never a `static outboundByHost = …`
  // field: the package keeps handlers in a registry keyed by class name, and
  // only the setter writes to it. A class field defines its own property, the
  // registry stays empty, and the container's call to d1.internal is never
  // intercepted: it fails DNS and the service dies at startup. Found by the
  // scratch proof under `wrangler dev`, 2026-10-10.
  MicroDotContainer.outboundByHost = {
    'd1.internal': d1Handler,
    'alive.internal': aliveHandler,
  }

  const fetch = async (request: Request, env: Bindings): Promise<Response> => {
    const namespace = env[options.binding]
    if (!isNamespace(namespace))
      return refusal(
        503,
        `This service runs in a container, and the Worker has no Durable Object binding named ${options.binding}.`,
      )
    // One instance per dot, by name: its jobs and its memory live in one
    // place. The same addressing `getContainer(binding, name)` performs.
    return namespace.get(namespace.idFromName('service')).fetch(request)
  }

  return { Container: MicroDotContainer, fetch }
}

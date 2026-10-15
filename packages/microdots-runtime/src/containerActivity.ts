import { Effect, Schedule } from 'effect'

/**
 * Where a service in a Cloudflare Container reports that it is still busy.
 *
 * Set by the fronting Worker (`packages/microdots-runtime/src/container.ts`) when
 * it starts the container. Absent everywhere else, which is what makes
 * `keepAwakeWhile` a no-op under `bun run dev`.
 */
export const MICRODOT_ALIVE_URL_VARIABLE = 'MICRODOT_ALIVE_URL'

/** Comfortably inside the container's default ten-minute `sleepAfter`. */
const HEARTBEAT = '60 seconds'

/**
 * Runs `job`, telling the container's Durable Object it is busy while it runs.
 *
 * Code running inside a container is not activity: Cloudflare counts requests
 * to the container, so a job that outlives the request that started it would be
 * stopped at `sleepAfter` mid-flight. This pings the outbound handler at
 * `aliveUrl` at once and then every 60 seconds; the handler calls
 * `renewActivityTimeout()`. A failed ping is ignored, because the next one, or
 * the default timeout, covers it. With no `aliveUrl` the job just runs.
 */
export const keepAwakeWhile = <A, E, R>(
  aliveUrl: string | undefined,
  job: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> => {
  if (aliveUrl === undefined || aliveUrl.trim() === '') return job
  const ping = Effect.tryPromise(() =>
    fetch(aliveUrl, { method: 'POST' }),
  ).pipe(Effect.ignore)
  return Effect.scoped(
    Effect.gen(function* () {
      yield* Effect.forkScoped(
        ping.pipe(Effect.repeat(Schedule.spaced(HEARTBEAT))),
      )
      return yield* job
    }),
  )
}

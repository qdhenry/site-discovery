import { Effect, Option, Schema as S } from 'effect'

/**
 * The slice of D1 MicroDots use, declared structurally.
 *
 * Deliberately NOT `@cloudflare/workers-types`: that package installs a full set
 * of Worker globals, and this repo's single root tsconfig compiles browser code,
 * Node code and Worker code together with `lib: ["ES2022", "DOM"]`. Pulling those
 * globals in would redeclare DOM types for every MicroDot to buy a handful of
 * method signatures. A real `D1Database` satisfies this interface structurally,
 * so `wrangler types` output still assigns to it without a cast.
 */
export type D1Value = string | number | null

/** D1 reports rows affected under `meta`; bun:sqlite reports it at the top level. */
export type D1RunResult = {
  readonly meta?: { readonly changes?: number }
}

export type D1PreparedStatement = {
  readonly bind: (...values: ReadonlyArray<D1Value>) => D1PreparedStatement
  readonly run: () => Promise<D1RunResult>
  readonly all: () => Promise<{ readonly results: ReadonlyArray<unknown> }>
}

export type D1Database = {
  readonly prepare: (query: string) => D1PreparedStatement
  /**
   * Runs several bound statements in ONE round trip and one implicit
   * transaction.
   *
   * Present because a MicroDot that writes a batch of rows — a trace, a log —
   * would otherwise pay a network hop per row to a database that is not local
   * to the isolate. `bun:sqlite` has no equivalent and does not need one: it is
   * in-process, and `Database.transaction` covers the same ground.
   */
  readonly batch: (
    statements: ReadonlyArray<D1PreparedStatement>,
  ) => Promise<ReadonlyArray<D1RunResult>>
}

/** Normalises D1's optional `meta.changes` to a number, `0` when absent. */
export const changesOf = (result: D1RunResult): number =>
  Option.getOrElse(
    Option.flatMap(Option.fromNullishOr(result.meta), meta =>
      Option.fromNullishOr(meta.changes),
    ),
    () => 0,
  )

/**
 * A D1 call that did not answer.
 *
 * Declared in the shared runtime rather than per MicroDot because every D1
 * adapter fails the same way, and because the error has to be **on the wire**
 * to be useful. Effect's RPC server sends a handler that DIES as a
 * connection-level `Defect` frame rather than a per-request `Exit`
 * (`repos/effect/packages/effect/src/unstable/rpc/RpcServer.ts:299-304`), and
 * the client puts that straight back on the defect channel
 * (`RpcClient.ts:592-594`). No `Effect.catch` in a MicroDot's front can reach
 * a defect, so the whole element is replaced by Foldkit's crash view and the
 * failure view the MicroDot actually designed never renders.
 *
 * A declared, tagged error travels as an `Exit` frame instead, and lands in
 * that failure view. Union it into every `Rpc.make({ error })` whose handler
 * can reach a D1-backed store.
 */
export class StorageFailure extends S.TaggedError<StorageFailure>(
  'StorageFailure',
)('StorageFailure', {
  /** The store method that failed — `listProducts`, not the SQL. */
  operation: S.String,
  /** What the driver said, e.g. `D1_ERROR: no such table: products`. */
  detail: S.String,
}) {
  /**
   * `S.TaggedError` does not populate `message`, so without this getter
   * `String(failure)` is the bare word `StorageFailure` and
   * `Cause.squash(cause).message` is the empty string — and EVERY front in this
   * repo renders a caught error with `String(error)`. The typed failure would
   * reach the failure view carrying no reason at all, which is a quieter
   * version of the defect this whole type exists to remove.
   *
   * A getter rather than a field: it stays off the encoded payload (the wire
   * carries `operation` and `detail`, and the message recomposes from them on
   * the far side), and it leaves no own property to shadow it.
   */
  override get message(): string {
    return `storage failed (${this.operation}): ${this.detail}`
  }
}

const detailOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

/**
 * Runs one D1 call with its rejection in the ERROR channel.
 *
 * `Effect.promise` is the wrong constructor for a database. Its error channel
 * is `never` — it asserts the promise cannot reject — so `no such table`,
 * `SQLITE_BUSY`, a constraint violation and a network fault to D1 all become
 * defects, which are uncatchable downstream. D1 rejects on every one of those.
 *
 * Note this deliberately does NOT probe or create the schema. A `CREATE TABLE`
 * here would add a round trip to the hot path and quietly mask a migration that
 * never ran (`microdots/intake/service/storeD1.ts:18-22`); the Worker rebuilds
 * this layer per request (`packages/microdots-runtime/src/worker.ts:180-198`),
 * so a "once at construction" probe is a probe on every request. Reporting the
 * driver's own message costs nothing and says more.
 */
export const d1Try = <Value>(
  operation: string,
  run: () => Promise<Value>,
): Effect.Effect<Value, StorageFailure> =>
  Effect.tryPromise({
    try: run,
    catch: error => new StorageFailure({ operation, detail: detailOf(error) }),
  })

/**
 * A `D1Database` that lives somewhere else, reached over HTTP.
 *
 * Made for a service running in a Cloudflare Container. A container has no
 * bindings; its fronting Worker does, and an outbound handler there answers
 * plain HTTP the container sends to a made-up hostname. This driver is the
 * container's half: a dot's existing `storeD1.ts` runs on it unchanged. The
 * Worker's half is `answerRemoteD1`, below. Plan:
 * `wiki/plans/active/long-lived-dot-service-in-a-cloudflare-container.md`.
 *
 * A failed call rejects with the far side's own message, so `d1Try` turns it
 * into a `StorageFailure` exactly as it does a local D1 rejection.
 */
export const makeRemoteD1Database = (
  baseUrl: string,
  fetcher: (url: string, init: RequestInit) => Promise<Response> = (
    url,
    init,
  ) => fetch(url, init),
): D1Database => {
  const statements = new WeakMap<D1PreparedStatement, RemoteStatement>()
  const call = async (path: string, body: unknown): Promise<unknown> => {
    const response = await fetcher(`${baseUrl}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    const payload: unknown = await response.json().catch(() => undefined)
    if (!response.ok)
      throw new Error(
        S.is(RemoteFailure)(payload)
          ? payload.error
          : `remote D1 answered ${response.status}`,
      )
    return payload
  }
  const statement = (sql: string, params: ReadonlyArray<D1Value>) => {
    const prepared: D1PreparedStatement = {
      bind: (...values) => statement(sql, values),
      run: async () =>
        S.decodeUnknownSync(RemoteRun)(await call('/run', { sql, params })),
      all: async () =>
        S.decodeUnknownSync(RemoteAll)(await call('/all', { sql, params })),
    }
    statements.set(prepared, { sql, params })
    return prepared
  }
  return {
    prepare: sql => statement(sql, []),
    batch: async prepared => {
      const sent = prepared.map(item => {
        const known = statements.get(item)
        if (known === undefined)
          throw new Error(
            'remote D1 batch: a statement was prepared by another database',
          )
        return known
      })
      return S.decodeUnknownSync(S.Array(RemoteRun))(
        await call('/batch', { statements: sent }),
      )
    },
  }
}

const RemoteValue = S.Union([S.String, S.Finite, S.Null])
const RemoteStatement = S.Struct({
  sql: S.String,
  params: S.Array(RemoteValue),
})
type RemoteStatement = typeof RemoteStatement.Type
const RemoteRun = S.Struct({
  meta: S.optionalKey(S.Struct({ changes: S.optionalKey(S.Finite) })),
})
const RemoteAll = S.Struct({ results: S.Array(S.Unknown) })
const RemoteFailure = S.Struct({ error: S.String })

/**
 * The Worker's half of `makeRemoteD1Database`: one request, run on a real D1.
 *
 * `POST /run` and `POST /all` take `{ sql, params }`; `POST /batch` takes
 * `{ statements: [{ sql, params }] }` and runs them as one D1 batch, which is
 * one transaction. A malformed request is a 400; a D1 rejection is a 500 whose
 * body carries D1's message, never a stack.
 *
 * Only an outbound handler should call this. Exposing it on a public route
 * would hand anyone the database: it runs whatever SQL it is sent.
 */
export const answerRemoteD1 = async (
  request: Request,
  database: D1Database,
): Promise<Response> => {
  const path = new URL(request.url).pathname
  const failure = (status: number, error: string) =>
    Response.json({ error }, { status })
  if (request.method !== 'POST') return failure(405, 'remote D1 takes POST')
  const body: unknown = await request.json().catch(() => undefined)
  const prepare = (item: RemoteStatement) =>
    database.prepare(item.sql).bind(...item.params)
  try {
    if (path === '/run' || path === '/all') {
      if (!S.is(RemoteStatement)(body))
        return failure(400, 'remote D1 expects { sql, params }')
      const prepared = prepare(body)
      return Response.json(
        path === '/run' ? await prepared.run() : await prepared.all(),
      )
    }
    if (path === '/batch') {
      if (!S.is(S.Struct({ statements: S.Array(RemoteStatement) }))(body))
        return failure(
          400,
          'remote D1 expects { statements: [{ sql, params }] }',
        )
      return Response.json(await database.batch(body.statements.map(prepare)))
    }
    return failure(404, `remote D1 has no route ${path}`)
  } catch (error) {
    return failure(500, detailOf(error))
  }
}

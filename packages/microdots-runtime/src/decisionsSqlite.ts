/** Bun-only durable owner-side assessment queue. Call enqueue inside the SAME
 * SQLite transaction as the owning record write. No raw text enters telemetry.
 * Decision completion only persists advice; it grants no action authority. */
import type { Database } from 'bun:sqlite'
import { createHash, randomUUID } from 'node:crypto'
import { Data, Effect } from 'effect'
import { decisionJson, decisionSnapshotJson, validateDecisionInput, JEV_MODEL, type DecisionEvaluator, type DecisionInput, type DecisionResult } from './decisions.ts'

export class DecisionStoreFailure extends Data.TaggedError('DecisionStoreFailure')<{
  readonly code: 'storage' | 'invalid-owner-version' | 'invalid-input'
}> {}
export type DecisionOwner = { readonly scope: string; readonly entityId: string; readonly entityVersion: number }
export type OwnedDecisionInput = DecisionOwner & Omit<DecisionInput, 'scope'> & {
  /** Monotonic owner-assigned revision of the reviewed policy, not model text. */
  readonly policyRevision: number
}
export type DecisionJob = DecisionOwner & {
  readonly id: string
  readonly claim: string
  readonly snapshotHash: string
  readonly attempt: number
  readonly policyRevision: number
  readonly input: DecisionInput
}
export type DecisionStatus = 'pending' | 'running' | 'completed' | 'failed' | 'superseded'
/** Whether claimNext would admit another provider attempt now. A daily limit
 * counts attempts started since 00:00 UTC; the minute limit, the last 60 s. */
export type DecisionAdmission = 'open' | 'daily-limit' | 'minute-limit'
export type DecisionRead = DecisionOwner & {
  readonly jobId: string
  readonly status: DecisionStatus
  readonly policyId: string
  readonly policyVersion: string
  readonly policyRevision: number
  readonly attempts: number
  readonly failureCode: string | null
  readonly result: DecisionResult | null
}

const digest = (text: string) => createHash('sha256').update(text).digest('hex')
const storageFailure = () => new DecisionStoreFailure({ code: 'storage' })
const safely = <A>(run: () => A): A => {
  try { return run() } catch (error) { throw error instanceof DecisionStoreFailure ? error : storageFailure() }
}

export const makeSqliteDecisionStore = (db: Database, options: {
  readonly now?: () => number
  readonly leaseMs?: number
  readonly maxAttempts?: number
  /** Persisted admission across restarts; includes failed attempts and retries. */
  readonly maxDailyAttempts?: number
  readonly maxAttemptsPerMinute?: number
  /** Only for policies whose complete semantic context is in state. */
  readonly reuseCompleted?: boolean
} = {}) => {
  const now = options.now ?? Date.now
  const leaseMs = options.leaseMs ?? 10_000
  const maxAttempts = options.maxAttempts ?? 3
  const maxDailyAttempts = options.maxDailyAttempts ?? 1000
  const maxAttemptsPerMinute = options.maxAttemptsPerMinute ?? 1000
  if (!Number.isSafeInteger(maxAttemptsPerMinute) || maxAttemptsPerMinute < 1 || maxAttemptsPerMinute > 1200) throw new DecisionStoreFailure({ code: 'invalid-input' })
  if (!Number.isSafeInteger(maxDailyAttempts) || maxDailyAttempts < 1 || maxDailyAttempts > 100_000) throw new DecisionStoreFailure({ code: 'invalid-input' })
  if (!Number.isSafeInteger(leaseMs) || leaseMs < 1000 || leaseMs > 120_000 || !Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 5) throw new DecisionStoreFailure({ code: 'invalid-input' })
  safely(() => db.exec(`
    CREATE TABLE IF NOT EXISTS semantic_entities (
      scope TEXT NOT NULL, entity_id TEXT NOT NULL, entity_version INTEGER NOT NULL,
      state_hash TEXT NOT NULL, policy_revision INTEGER NOT NULL, policy_hash TEXT NOT NULL,
      job_id TEXT, PRIMARY KEY(scope, entity_id)
    );
    CREATE TABLE IF NOT EXISTS semantic_jobs (
      id TEXT PRIMARY KEY, scope TEXT NOT NULL, entity_id TEXT NOT NULL,
      entity_version INTEGER NOT NULL, snapshot_hash TEXT NOT NULL,
      policy_id TEXT NOT NULL, policy_version TEXT NOT NULL, policy_revision INTEGER NOT NULL, input_json TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('pending','running','completed','failed','superseded')),
      attempts INTEGER NOT NULL DEFAULT 0, due_at INTEGER NOT NULL, claim TEXT,
      lease_until INTEGER, failure_code TEXT, result_json TEXT, created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS semantic_due ON semantic_jobs(status, due_at);
    CREATE TABLE IF NOT EXISTS semantic_attempts (
      job_id TEXT NOT NULL, attempt INTEGER NOT NULL, started_at INTEGER NOT NULL,
      finished_at INTEGER, failure_code TEXT, result_json TEXT,
      PRIMARY KEY(job_id, attempt)
    );
    CREATE TABLE IF NOT EXISTS semantic_outcomes (
      job_id TEXT PRIMARY KEY, scope TEXT NOT NULL, entity_id TEXT NOT NULL,
      entity_version INTEGER NOT NULL, created_at INTEGER NOT NULL
    );
  `))

  const enqueue = (input: OwnedDecisionInput): string => {
    if (!input.scope.trim() || !input.entityId.trim() || input.entityId.length > 256 || !Number.isSafeInteger(input.entityVersion) || input.entityVersion < 1 || !Number.isSafeInteger(input.policyRevision) || input.policyRevision < 1) throw new DecisionStoreFailure({ code: 'invalid-input' })
    const decision: DecisionInput = { scope: input.scope, state: input.state, policy: input.policy }
    try { validateDecisionInput(decision) } catch { throw new DecisionStoreFailure({ code: 'invalid-input' }) }
    const stateHash = digest(decisionJson(input.state))
    const policyHash = digest(decisionJson(input.policy))
    const snapshotHash = digest(decisionSnapshotJson(decision))
    const id = digest(decisionJson({ scope: input.scope, entityId: input.entityId, version: input.entityVersion, policyRevision: input.policyRevision, snapshotHash }))
    return safely(db.transaction(() => {
      const existing = db.query<{ entity_version: number; state_hash: string; policy_revision: number; policy_hash: string; job_id: string | null }, [string, string]>(
        'SELECT entity_version, state_hash, policy_revision, policy_hash, job_id FROM semantic_entities WHERE scope=? AND entity_id=?',
      ).get(input.scope, input.entityId)
      if (existing && (existing.entity_version > input.entityVersion || existing.policy_revision > input.policyRevision ||
        (existing.policy_revision === input.policyRevision && existing.policy_hash !== policyHash) ||
        (existing.entity_version === input.entityVersion && ((existing.policy_revision === input.policyRevision && existing.state_hash !== stateHash) || existing.job_id === null)))) {
        throw new DecisionStoreFailure({ code: 'invalid-owner-version' })
      }
      if (existing?.job_id === id) return id
      if (existing?.job_id) db.query("UPDATE semantic_jobs SET status='superseded', claim=NULL WHERE id=?").run(existing.job_id)
      db.query(`INSERT INTO semantic_jobs(id,scope,entity_id,entity_version,snapshot_hash,policy_id,policy_version,policy_revision,input_json,status,due_at,created_at)
        VALUES(?,?,?,?,?,?,?,?,?,'pending',?,?)`).run(
        id, input.scope, input.entityId, input.entityVersion, snapshotHash,
        input.policy.id, input.policy.version, input.policyRevision, decisionJson(decision), now(), now(),
      )
      db.query(`INSERT INTO semantic_entities(scope,entity_id,entity_version,state_hash,policy_revision,policy_hash,job_id) VALUES(?,?,?,?,?,?,?)
        ON CONFLICT(scope,entity_id) DO UPDATE SET entity_version=excluded.entity_version,state_hash=excluded.state_hash,policy_revision=excluded.policy_revision,policy_hash=excluded.policy_hash,job_id=excluded.job_id`).run(
        input.scope, input.entityId, input.entityVersion, stateHash, input.policyRevision, policyHash, id,
      )
      if (options.reuseCompleted) {
        const prior = db.query<{ result_json: string }, [string, string, string]>(
          'SELECT result_json FROM semantic_jobs WHERE scope=? AND snapshot_hash=? AND id<>? AND result_json IS NOT NULL ORDER BY created_at DESC LIMIT 1',
        ).get(input.scope, snapshotHash, id)
        if (prior) {
          const result: DecisionResult = JSON.parse(prior.result_json)
          db.query("UPDATE semantic_jobs SET status='completed',result_json=? WHERE id=?").run(decisionJson({ ...result, cacheHit: true, elapsedMs: 0 }), id)
          db.query('INSERT INTO semantic_outcomes(job_id,scope,entity_id,entity_version,created_at) VALUES(?,?,?,?,?)').run(id, input.scope, input.entityId, input.entityVersion, now())
        }
      }
      return id
    }))
  }

  const invalidate = (owner: DecisionOwner) => safely(db.transaction(() => {
    if (!owner.scope.trim() || !owner.entityId.trim() || !Number.isSafeInteger(owner.entityVersion) || owner.entityVersion < 1) throw new DecisionStoreFailure({ code: 'invalid-input' })
    const row = db.query<{ job_id: string | null; entity_version: number }, [string, string]>(
      'SELECT job_id,entity_version FROM semantic_entities WHERE scope=? AND entity_id=?',
    ).get(owner.scope, owner.entityId)
    if (!row) {
      db.query("INSERT INTO semantic_entities(scope,entity_id,entity_version,state_hash,policy_revision,policy_hash,job_id) VALUES(?,?,?,'',0,'',NULL)").run(owner.scope, owner.entityId, owner.entityVersion)
      return
    }
    if (owner.entityVersion < row.entity_version) throw new DecisionStoreFailure({ code: 'invalid-owner-version' })
    if (row.job_id) db.query("UPDATE semantic_jobs SET status='superseded',claim=NULL WHERE id=?").run(row.job_id)
    db.query('UPDATE semantic_entities SET job_id=NULL,entity_version=? WHERE scope=? AND entity_id=?').run(owner.entityVersion, owner.scope, owner.entityId)
  }))

  // The one admission rule: claimNext refuses on it and admission() reports it,
  // so a reader can never state a cause claimNext does not enforce.
  const admissionNow = (): DecisionAdmission => {
    const daily = db.query<{ count: number }, [number]>('SELECT count(*) AS count FROM semantic_attempts WHERE started_at>=?').get(Math.floor(now() / 86_400_000) * 86_400_000)
    if ((daily?.count ?? 0) >= maxDailyAttempts) return 'daily-limit'
    const recent = db.query<{ count: number }, [number]>('SELECT count(*) AS count FROM semantic_attempts WHERE started_at>?').get(now() - 60_000)
    if ((recent?.count ?? 0) >= maxAttemptsPerMinute) return 'minute-limit'
    return 'open'
  }
  /** Read-only: claims nothing, counts nothing, recovers no lease. */
  const admission = (): DecisionAdmission => safely(admissionNow)

  const claimNext = (): DecisionJob | null => safely(db.transaction(() => {
    // A crash never leaves a job permanently running. Old claims cannot commit.
    db.query(`UPDATE semantic_attempts SET finished_at=?, failure_code='lease-expired'
      WHERE finished_at IS NULL AND job_id IN (SELECT id FROM semantic_jobs WHERE status='running' AND lease_until<=?)`).run(now(), now())
    db.query(`UPDATE semantic_jobs SET status=CASE WHEN attempts>=? THEN 'failed' ELSE 'pending' END,
      claim=NULL, failure_code='lease-expired', due_at=? WHERE status='running' AND lease_until<=?`).run(maxAttempts, now(), now())
    db.query("UPDATE semantic_jobs SET status='failed',failure_code='attempt-limit' WHERE status='pending' AND attempts>=?").run(maxAttempts)
    if (admissionNow() !== 'open') return null
    const row = db.query<{
      id: string; scope: string; entity_id: string; entity_version: number;
      snapshot_hash: string; attempts: number; input_json: string; policy_revision: number;
    }, [number, number]>("SELECT * FROM semantic_jobs WHERE status='pending' AND due_at<=? AND attempts<? ORDER BY due_at,created_at,id LIMIT 1").get(now(), maxAttempts)
    if (!row) return null
    const claim = randomUUID()
    db.query("UPDATE semantic_jobs SET status='running',claim=?,lease_until=?,attempts=attempts+1 WHERE id=? AND status='pending' AND attempts<?").run(claim, now() + leaseMs, row.id, maxAttempts)
    db.query('INSERT OR REPLACE INTO semantic_attempts(job_id,attempt,started_at) VALUES(?,?,?)').run(row.id, row.attempts + 1, now())
    const input: DecisionInput = JSON.parse(row.input_json)
    return { id: row.id, claim, scope: row.scope, entityId: row.entity_id, entityVersion: row.entity_version, policyRevision: row.policy_revision, snapshotHash: row.snapshot_hash, attempt: row.attempts + 1, input }
  }))

  const currentClaim = (job: DecisionJob) => db.query<{
    id: string; attempts: number; snapshot_hash: string; policy_id: string; policy_version: string;
  }, [string, string, string, string, number, number, string, number]>(
    `SELECT j.id,j.attempts,j.snapshot_hash,j.policy_id,j.policy_version FROM semantic_jobs j
     JOIN semantic_entities e ON e.scope=j.scope AND e.entity_id=j.entity_id AND e.job_id=j.id
     WHERE j.id=? AND j.claim=? AND j.scope=? AND j.entity_id=? AND j.entity_version=? AND j.policy_revision=? AND j.snapshot_hash=? AND j.status='running' AND j.lease_until>?`,
  ).get(job.id, job.claim, job.scope, job.entityId, job.entityVersion, job.policyRevision, job.snapshotHash, now())

  const complete = (job: DecisionJob, result: DecisionResult): boolean => safely(db.transaction(() => {
    const persisted = currentClaim(job)
    if (!persisted) return false
    // Pin provenance; only the evaluator bound to this exact policy can settle it.
    if (result.model !== JEV_MODEL || result.snapshotHash !== persisted.snapshot_hash || result.policyId !== persisted.policy_id || result.policyVersion !== persisted.policy_version) throw new DecisionStoreFailure({ code: 'invalid-input' })
    const json = decisionJson(result)
    db.query("UPDATE semantic_jobs SET status='completed',result_json=?,failure_code=NULL,claim=NULL,lease_until=NULL WHERE id=?").run(json, job.id)
    db.query('UPDATE semantic_attempts SET finished_at=?,result_json=? WHERE job_id=? AND attempt=?').run(now(), json, job.id, persisted.attempts)
    db.query('INSERT OR IGNORE INTO semantic_outcomes(job_id,scope,entity_id,entity_version,created_at) VALUES(?,?,?,?,?)').run(job.id, job.scope, job.entityId, job.entityVersion, now())
    return true
  }))

  const fail = (job: DecisionJob, code: string, retryable: boolean): boolean => safely(db.transaction(() => {
    const persisted = currentClaim(job)
    if (!persisted) return false
    // Codes only, not error text/provider bodies/user state.
    const safeCode = /^[a-z-]{1,40}$/.test(code) ? code : 'provider'
    const retry = retryable && persisted.attempts < maxAttempts
    db.query('UPDATE semantic_jobs SET status=?,due_at=?,failure_code=?,claim=NULL,lease_until=NULL WHERE id=?').run(
      retry ? 'pending' : 'failed', now() + Math.min(30_000, 1_000 * 2 ** (persisted.attempts - 1)), safeCode, job.id,
    )
    db.query('UPDATE semantic_attempts SET finished_at=?,failure_code=? WHERE job_id=? AND attempt=?').run(now(), safeCode, job.id, persisted.attempts)
    return true
  }))

  // These local refusals provably made no provider call. Preserve retries and
  // daily budget; unlike HTTP 429, they are admission delays, not attempts.
  const defer = (job: DecisionJob, code: 'unconfigured' | 'busy' | 'local-rate-limit') => safely(db.transaction(() => {
    const persisted = currentClaim(job)
    if (!persisted) return false
    db.query('DELETE FROM semantic_attempts WHERE job_id=? AND attempt=?').run(job.id, persisted.attempts)
    db.query("UPDATE semantic_jobs SET status='pending',attempts=attempts-1,due_at=?,failure_code=?,claim=NULL,lease_until=NULL WHERE id=?").run(now() + (code === 'busy' ? 1000 : 60_000), code, job.id)
    return true
  }))

  const read = (scope: string, entityId: string): DecisionRead | null => safely(() => {
    const row = db.query<{
      id: string; entity_version: number; status: DecisionStatus; policy_id: string;
      policy_version: string; policy_revision: number; attempts: number; failure_code: string | null; result_json: string | null;
    }, [string, string]>(`SELECT j.* FROM semantic_entities e JOIN semantic_jobs j ON j.id=e.job_id
      WHERE e.scope=? AND e.entity_id=?`).get(scope, entityId)
    if (!row) return null
    const result: DecisionResult | null = row.result_json === null ? null : JSON.parse(row.result_json)
    return { scope, entityId, entityVersion: row.entity_version, jobId: row.id, status: row.status,
      policyId: row.policy_id, policyVersion: row.policy_version, policyRevision: row.policy_revision, attempts: row.attempts,
      failureCode: row.failure_code, result }
  })

  /** Consumers must use this when consuming delayed outcome notifications. */
  const currentOutcome = (scope: string, jobId: string): DecisionRead | null => safely(() => {
    const row = db.query<{ entity_id: string }, [string, string]>(
      `SELECT o.entity_id FROM semantic_outcomes o JOIN semantic_entities e ON e.scope=o.scope AND e.entity_id=o.entity_id AND e.job_id=o.job_id WHERE o.scope=? AND o.job_id=?`,
    ).get(scope, jobId)
    return row ? read(scope, row.entity_id) : null
  })

  return { enqueue, invalidate, claimNext, complete, fail, defer, read, currentOutcome, admission }
}
export type SqliteDecisionStore = ReturnType<typeof makeSqliteDecisionStore>

/** One bounded unit of worker work; startup/interval ownership stays with the
 * service. Interruptions leave a recoverable lease, never fabricate a failure. */
export const processNextDecision = (store: SqliteDecisionStore, evaluator: DecisionEvaluator) =>
  Effect.gen(function* () {
    const job = yield* Effect.try({ try: store.claimNext, catch: storageFailure })
    if (!job) return false
    const outcome = yield* evaluator.evaluate(job.input).pipe(
      Effect.match({ onSuccess: result => ({ result, error: null }), onFailure: error => ({ result: null, error }) }),
    )
    yield* Effect.try({
      try: () => {
        if (outcome.result !== null) return store.complete(job, outcome.result)
        const error = outcome.error!
        return error.code === 'unconfigured' || error.code === 'busy' || error.code === 'local-rate-limit'
          ? store.defer(job, error.code) : store.fail(job, error.code, error.retryable)
      },
      catch: storageFailure,
    })
    return true
  })

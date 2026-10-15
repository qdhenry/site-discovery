/** Bun-only record ownership + durable assessment outbox. The compiler supplies
 * scope and projection; requests cannot choose a tenant, policy or raw prompt. */
import type { Database } from 'bun:sqlite'
import { decisionJson, type DecisionPolicy } from './decisions.ts'
import { makeSqliteDecisionStore, DecisionStoreFailure } from './decisionsSqlite.ts'

export type SemanticRecord = { readonly key: string; readonly value: string; readonly version: number; readonly updatedAt: number }
type Row = { key: string; value: string; version: number; updated_at: number }
const fromRow = (row: Row): SemanticRecord => ({ key: row.key, value: row.value, version: row.version, updatedAt: row.updated_at })
export const makeSemanticRecordsSqlite = (db: Database, options: {
  readonly scope: string
  readonly prefix: string
  readonly policy: DecisionPolicy
  readonly policyRevision: number
  readonly projectionVersion: string
  /** Only this server function selects fields from records under prefix. */
  readonly project: (record: SemanticRecord) => unknown
  readonly maxPending?: number
  readonly maxDailyAttempts?: number
  readonly now?: () => number
}) => {
  const now = options.now ?? Date.now
  const maxPending = options.maxPending ?? 256
  if (!options.scope.trim() || !Number.isSafeInteger(maxPending) || maxPending < 1 || maxPending > 10_000) throw new DecisionStoreFailure({ code: 'invalid-input' })
  const decisions = makeSqliteDecisionStore(db, { now, maxAttempts: 2, maxAttemptsPerMinute: 60, maxDailyAttempts: options.maxDailyAttempts ?? 100, reuseCompleted: true })
  db.exec(`CREATE TABLE IF NOT EXISTS capability_records(key TEXT PRIMARY KEY,value TEXT NOT NULL,version INTEGER NOT NULL,updated_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS semantic_record_versions(key TEXT PRIMARY KEY,version INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS semantic_record_settings(scope TEXT PRIMARY KEY,revision INTEGER NOT NULL,configuration TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS semantic_projection_failures(scope TEXT NOT NULL,key TEXT NOT NULL,version INTEGER NOT NULL,revision INTEGER NOT NULL,PRIMARY KEY(scope,key));
    INSERT OR IGNORE INTO semantic_record_versions SELECT key,version FROM capability_records;`)
  const configuration = decisionJson({ policy: options.policy, prefix: options.prefix, projectionVersion: options.projectionVersion })
  const setting = () => db.query<{ revision: number; configuration: string }, [string]>('SELECT revision,configuration FROM semantic_record_settings WHERE scope=?').get(options.scope)
  db.transaction(() => {
    const current = setting()
    if (!Number.isSafeInteger(options.policyRevision) || options.policyRevision < 1 || !options.projectionVersion.trim() || current && (current.revision > options.policyRevision || current.revision === options.policyRevision && current.configuration !== configuration)) throw new DecisionStoreFailure({ code: 'invalid-owner-version' })
    db.query('INSERT INTO semantic_record_settings VALUES(?,?,?) ON CONFLICT(scope) DO UPDATE SET revision=excluded.revision,configuration=excluded.configuration').run(options.scope, options.policyRevision, configuration)
    db.query("UPDATE semantic_jobs SET status='superseded',claim=NULL WHERE scope=? AND policy_revision<? AND status IN ('pending','running')").run(options.scope, options.policyRevision)
  })()
  const assertCurrent = () => {
    const current = setting()
    if (current?.revision !== options.policyRevision || current.configuration !== configuration) throw new DecisionStoreFailure({ code: 'invalid-owner-version' })
  }
  const read = (key: string): SemanticRecord | null => {
    const row = db.query<Row, [string]>('SELECT * FROM capability_records WHERE key=?').get(key)
    return row ? fromRow(row) : null
  }
  const nextVersion = (key: string) => {
    const row = db.query<{ version: number }, [string]>('INSERT INTO semantic_record_versions VALUES(?,1) ON CONFLICT(key) DO UPDATE SET version=version+1 RETURNING version').get(key)
    if (!row) throw new DecisionStoreFailure({ code: 'storage' })
    return row.version
  }
  const enroll = (record: SemanticRecord) => {
    assertCurrent()
    if (!record.key.startsWith(options.prefix)) return
    const state = options.project(record)
    const pending = db.query<{ count: number }, [string, string]>("SELECT count(*) AS count FROM semantic_jobs WHERE scope=? AND entity_id<>? AND status IN ('pending','running')").get(options.scope, record.key)
    if ((pending?.count ?? 0) >= maxPending) throw new DecisionStoreFailure({ code: 'storage' })
    decisions.enqueue({ scope: options.scope, entityId: record.key, entityVersion: record.version, policyRevision: options.policyRevision, policy: options.policy, state })
  }
  const write = db.transaction((key: string, value: string): SemanticRecord => {
    assertCurrent()
    if (!key.trim() || key.length > 256 || value.length > 65_536) throw new DecisionStoreFailure({ code: 'invalid-input' })
    // Validate JSON without changing its representation or projecting it here.
    try { decisionJson(JSON.parse(value)) } catch { throw new DecisionStoreFailure({ code: 'invalid-input' }) }
    const record = { key, value, version: nextVersion(key), updatedAt: now() }
    db.query('INSERT INTO capability_records VALUES(?,?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,version=excluded.version,updated_at=excluded.updated_at').run(key, value, record.version, record.updatedAt)
    enroll(record)
    return record
  })
  const compareAndSet = db.transaction((key: string, expectedVersion: number | null, value: string) => {
    const current = read(key)
    return (current?.version ?? null) !== expectedVersion
      ? { _tag: 'Conflict' as const, current }
      : { _tag: 'Saved' as const, record: write(key, value) }
  })
  const remove = db.transaction((key: string) => {
    assertCurrent()
    const current = read(key)
    if (!current) return
    decisions.invalidate({ scope: options.scope, entityId: key, entityVersion: nextVersion(key) })
    db.query('DELETE FROM capability_records WHERE key=?').run(key)
  })
  const scan = (prefix: string) => db.query<Row, [string, string]>('SELECT * FROM capability_records WHERE substr(key,1,length(?))=? ORDER BY key').all(prefix, prefix).map(fromRow)
  /** Bounded, individually transactional reconciliation. A bad legacy record
   * stays unknown until edited; it cannot starve valid work behind it. */
  const reconcile = () => {
    assertCurrent()
    const rows = db.query<Row, [string, string, number, string, string, number]>(`SELECT r.* FROM capability_records r LEFT JOIN semantic_entities e ON e.entity_id=r.key AND e.scope=?
      LEFT JOIN semantic_projection_failures f ON f.key=r.key AND f.scope=? AND f.version=r.version AND f.revision=?
      WHERE substr(r.key,1,length(?))=? AND f.key IS NULL AND (e.entity_id IS NULL OR e.policy_revision<?) ORDER BY r.key LIMIT 16`).all(options.scope, options.scope, options.policyRevision, options.prefix, options.prefix, options.policyRevision)
    for (const row of rows) {
      try { db.transaction(() => enroll(fromRow(row)))() } catch (error) {
        if (error instanceof DecisionStoreFailure && error.code === 'storage') break
        db.query('INSERT OR REPLACE INTO semantic_projection_failures VALUES(?,?,?,?)').run(options.scope, row.key, row.version, options.policyRevision)
      }
    }
    return rows.length
  }
  const projectionFailed = (key: string, version: number) => db.query('SELECT 1 FROM semantic_projection_failures WHERE scope=? AND key=? AND version=? AND revision=?').get(options.scope, key, version, options.policyRevision) !== null
  return { read, write, compareAndSet, remove, scan, reconcile, decisions, assertCurrent, projectionFailed }
}

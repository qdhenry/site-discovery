import { Database } from 'bun:sqlite'

import {
  type SqliteDatabase,
  type SqliteExecutor,
  SqliteStorage,
  type SqliteValue,
} from '@earendil-works/pi-durable/storage/sqlite'

export class BunSqliteDatabase implements SqliteDatabase {
  private tail: Promise<unknown> = Promise.resolve()
  private closed = false
  constructor(private readonly db: Database) {}
  private enqueue<T>(fn: () => T | Promise<T>): Promise<T> {
    const result = this.tail.then(fn)
    this.tail = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }
  private executor(active: () => boolean): SqliteExecutor {
    const check = () => {
      if (!active() || this.closed)
        throw new Error('SQLite handle is no longer active')
    }
    return {
      exec: async sql => {
        check()
        this.db.exec(sql)
      },
      run: async (sql, ...params) => {
        check()
        this.db.query(sql).run(...params)
      },
      get: async <T extends object>(sql: string, ...params: SqliteValue[]) => {
        check()
        return this.db.query<T, SqliteValue[]>(sql).get(...params) ?? undefined
      },
      all: async <T extends object>(sql: string, ...params: SqliteValue[]) => {
        check()
        return this.db.query<T, SqliteValue[]>(sql).all(...params)
      },
    }
  }
  exec(sql: string) {
    return this.enqueue(() => this.executor(() => true).exec(sql))
  }
  run(sql: string, ...params: SqliteValue[]) {
    return this.enqueue(() => this.executor(() => true).run(sql, ...params))
  }
  get<T extends object>(sql: string, ...params: SqliteValue[]) {
    return this.enqueue(() => this.executor(() => true).get<T>(sql, ...params))
  }
  all<T extends object>(sql: string, ...params: SqliteValue[]) {
    return this.enqueue(() => this.executor(() => true).all<T>(sql, ...params))
  }
  transaction<T>(callback: (tx: SqliteExecutor) => Promise<T>): Promise<T> {
    return this.enqueue(async () => {
      if (this.closed) throw new Error('SQLite database is closed')
      this.db.exec('BEGIN IMMEDIATE')
      let active = true
      try {
        const value = await callback(this.executor(() => active))
        active = false
        this.db.exec('COMMIT')
        return value
      } catch (error) {
        active = false
        try {
          this.db.exec('ROLLBACK')
        } catch (rollbackError) {
          throw new AggregateError(
            [error, rollbackError],
            'SQLite transaction and rollback failed',
          )
        }
        throw error
      }
    })
  }
  close(): Promise<void> {
    return this.enqueue(() => {
      if (this.closed) return
      this.closed = true
      try {
        this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
      } finally {
        this.db.close()
      }
    })
  }
}

export async function openStorage(path: string) {
  const db = new BunSqliteDatabase(
    new Database(path, { create: true, strict: true }),
  )
  try {
    await db.exec(
      'PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000',
    )
    return await SqliteStorage.open(db)
  } catch (error) {
    await db.close()
    throw error
  }
}

/** Kernel-managed writer lock on a separate file; process death releases it automatically. */
export function acquireStorageOwner(path: string): () => void {
  const lock = new Database(path, { create: true, strict: true })
  try {
    lock.exec(
      'PRAGMA busy_timeout=0; CREATE TABLE IF NOT EXISTS owner (id INTEGER); BEGIN IMMEDIATE',
    )
  } catch (error) {
    lock.close()
    throw new Error('Another process owns the Discovery storage', {
      cause: error,
    })
  }
  let released = false
  return () => {
    if (released) return
    released = true
    try {
      lock.exec('ROLLBACK')
    } finally {
      lock.close()
    }
  }
}

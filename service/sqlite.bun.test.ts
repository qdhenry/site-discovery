import { Database } from 'bun:sqlite'
import { describe, expect, it, test } from 'bun:test'

import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import { registerStorageConformance } from '@earendil-works/pi-durable/testing'

import { BunSqliteDatabase, openStorage } from './sqlite.ts'

registerStorageConformance(
  { describe, expect, it },
  'Discovery Bun SQLite',
  async use => {
    const storage = await openStorage(':memory:')
    try {
      await use(storage)
    } finally {
      await storage.close(BACKGROUND_CONTEXT)
    }
  },
)
test('async transaction isolates queued reads and expires its handle; callback rollback preserves identity', async () => {
  const db = new BunSqliteDatabase(new Database(':memory:'))
  await db.exec('CREATE TABLE sample(value TEXT)')
  let release!: () => void
  let txHandle!: import('@earendil-works/pi-durable/storage/sqlite').SqliteExecutor
  let entered!: () => void
  const ready = new Promise<void>(resolve => {
    entered = resolve
  })
  const barrier = new Promise<void>(resolve => {
    release = resolve
  })
  const transaction = db.transaction(async tx => {
    txHandle = tx
    await tx.run('INSERT INTO sample VALUES (?)', 'atomic')
    entered()
    await barrier
  })
  await ready
  let readComplete = false
  const read = db.all('SELECT * FROM sample').then(rows => {
    readComplete = true
    return rows
  })
  await Promise.resolve()
  expect(readComplete).toBe(false)
  release()
  await transaction
  expect(await read).toEqual([{ value: 'atomic' }])
  await expect(
    txHandle.run('INSERT INTO sample VALUES (?)', 'expired'),
  ).rejects.toThrow('active')
  const fault = new Error('rollback')
  await expect(
    db.transaction(async tx => {
      await tx.run('INSERT INTO sample VALUES (?)', 'bad')
      throw fault
    }),
  ).rejects.toBe(fault)
  expect(await db.all('SELECT * FROM sample')).toEqual([{ value: 'atomic' }])
  await db.close()
})

import { expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { readConfig } from './config.ts'
import { DiscoveryEngine } from './engine.ts'

const script = fileURLToPath(
  new URL('./test-fixtures/restart.ts', import.meta.url),
)
test('actual application crash requires explicit retry, retains reservations, reconciles actual cost and command replay', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'discovery-restart-'))
  const run = (mode: string) => {
    const child = Bun.spawnSync([process.execPath, script, mode, dir])
    if (mode !== 'crash' && child.exitCode !== 0)
      throw new Error(child.stderr.toString())
    return child
  }
  try {
    expect(run('crash').exitCode).toBe(73)
    const recovered = JSON.parse(run('resume').stdout.toString())
    expect(recovered.snapshot.run.phase).toBe('requires_retry')
    expect(recovered.workspace.activeRunId).toBe(recovered.snapshot.run.id)
    expect(recovered.dispatches).toBe(1)
    expect(recovered.workspace.budget.reservedUsd).toBe(0.01)
    const again = JSON.parse(run('resume').stdout.toString())
    expect(again.dispatches).toBe(1)
    expect(again.workspace.budget.reservedUsd).toBe(0.01)
    const retried = JSON.parse(run('retry').stdout.toString())
    expect(retried.snapshot.run.phase).toBe('completed')
    expect(retried.dispatches).toBe(2)
    expect(retried.workspace.budget.reservedUsd).toBe(0.01)
    expect(retried.workspace.budget.spentUsd).toBe(0.002)
    const deleted = JSON.parse(run('delete').stdout.toString())
    expect(deleted.workspace.budget.reservedUsd).toBe(0.01)
    expect(deleted.workspace.budget.spentUsd).toBe(0.002)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
test('storage owner is exclusive and OS releases the lock after forced process death', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'discovery-owner-'))
  const engineModule = fileURLToPath(new URL('./engine.ts', import.meta.url))
  const configModule = fileURLToPath(new URL('./config.ts', import.meta.url))
  const child = Bun.spawn(
    [
      process.execPath,
      '-e',
      `import {DiscoveryEngine} from ${JSON.stringify(engineModule)};import {readConfig} from ${JSON.stringify(configModule)};await DiscoveryEngine.open(readConfig({DISCOVERY_STATE_DIR:${JSON.stringify(dir)}}));console.log('READY');setInterval(()=>{},1000)`,
    ],
    { stdout: 'pipe', stderr: 'pipe' },
  )
  try {
    const reader = child.stdout.getReader()
    const first = await reader.read()
    expect(new TextDecoder().decode(first.value)).toContain('READY')
    reader.releaseLock()
    await expect(
      DiscoveryEngine.open(readConfig({ DISCOVERY_STATE_DIR: dir })),
    ).rejects.toThrow('Another process owns')
    child.kill('SIGKILL')
    await child.exited
    const recovered = await DiscoveryEngine.open(
      readConfig({ DISCOVERY_STATE_DIR: dir }),
    )
    await recovered.close()
  } finally {
    child.kill()
    await rm(dir, { recursive: true, force: true })
  }
})

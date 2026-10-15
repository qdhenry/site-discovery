import { expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative } from 'node:path'

import { OwnerSessions } from './auth.ts'
import { ownerTokenPath, ownerTokenSource, readConfig } from './config.ts'

const PORT = 3193
const browser = {
  host: `127.0.0.1:${PORT}`,
  origin: `http://127.0.0.1:${PORT}`,
}

// Regression: the startup line printed a relative `.local/discovery/owner-token`.
// With another checkout serving :3193, owners read the wrong folder's token and
// every sign-in failed. The printed source must be the exact absolute file the
// service writes and accepts.
test('startup token source is the absolute file the service generates and accepts', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'discovery-auth-'))
  try {
    const config = readConfig({
      DISCOVERY_STATE_DIR: relative(process.cwd(), dir),
    })
    const printed = ownerTokenSource(config)
    expect(isAbsolute(printed)).toBe(true)
    expect(printed).toBe(join(dir, 'owner-token'))
    expect(printed).toBe(ownerTokenPath(config))

    const sessions = await OwnerSessions.open(config, PORT)
    const fileToken = (await readFile(printed, 'utf8')).trim()
    expect(fileToken.length).toBeGreaterThanOrEqual(24)
    expect(sessions.login(browser, fileToken).state.authenticated).toBe(true)
    expect(() => sessions.login(browser, `${fileToken}x`)).toThrow(
      'Local owner token was not accepted',
    )

    // A restart reuses the same file instead of rotating the token.
    const reopened = await OwnerSessions.open(config, PORT)
    expect(reopened.login(browser, fileToken).state.authenticated).toBe(true)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('an environment owner token is reported by name and creates no token file', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'discovery-auth-env-'))
  try {
    const token = 'environment-owner-token-0123456789'
    const config = readConfig({
      DISCOVERY_STATE_DIR: dir,
      DISCOVERY_OWNER_TOKEN: token,
    })
    expect(ownerTokenSource(config)).toBe('DISCOVERY_OWNER_TOKEN')
    const sessions = await OwnerSessions.open(config, PORT)
    expect(existsSync(ownerTokenPath(config))).toBe(false)
    expect(sessions.login(browser, token).state.authenticated).toBe(true)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

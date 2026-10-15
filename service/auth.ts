import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto'
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import type { SessionState } from '../src/contract.ts'
import { type Config, fail } from './config.ts'

export type RequestHeaders = Readonly<Record<string, string | undefined>>
/** The compiler's paired-view mini-host (`mini-host/vite.config.ts`, fixed at
 * :5193 for every generated app) mounts these elements from its own origin.
 * It is the one foreign browser origin admitted; it still needs the owner
 * session cookie, and Host must still be this service. */
export const MINI_HOST_ORIGIN = 'http://localhost:5193'
export const browserOrigins = (port: number) => [
  `http://127.0.0.1:${port}`,
  `http://localhost:${port}`,
  MINI_HOST_ORIGIN,
]
const hash = (value: string) => createHash('sha256').update(value).digest()
const equal = (a: string, b: string) => timingSafeEqual(hash(a), hash(b))
export class OwnerSessions {
  private current: { token: string; id: string; expires: number } | undefined
  private failures = 0
  private failureWindow = 0
  private constructor(
    private readonly bootstrap: string,
    readonly port: number,
  ) {}
  static async open(config: Config, port: number) {
    await mkdir(config.stateDir, { recursive: true, mode: 0o700 })
    const path = join(config.stateDir, 'owner-token')
    let token = config.ownerToken
    if (!token) {
      try {
        token = (await readFile(path, 'utf8')).trim()
      } catch (error) {
        if (
          !(error instanceof Error) ||
          !('code' in error) ||
          error.code !== 'ENOENT'
        )
          throw error
        token = randomBytes(32).toString('base64url')
        await writeFile(path, token + '\n', { flag: 'wx', mode: 0o600 })
      }
      await chmod(path, 0o600)
    }
    if (token.length < 24)
      return fail(
        'configuration',
        'DISCOVERY_OWNER_TOKEN must contain at least 24 characters',
      )
    return new OwnerSessions(token, port)
  }
  validateTransport(headers: RequestHeaders, requireOrigin = false) {
    const hosts = [`127.0.0.1:${this.port}`, `localhost:${this.port}`]
    const host = headers.host?.toLowerCase()
    if (!host || !hosts.includes(host))
      return fail('forbidden', 'Local service Host was rejected')
    const origin = headers.origin
    if (
      (origin && !browserOrigins(this.port).includes(origin)) ||
      (requireOrigin && !origin)
    )
      return fail('forbidden', 'Same-origin local request required')
    if (headers['sec-fetch-site'] === 'cross-site')
      return fail('forbidden', 'Cross-site access was rejected')
  }
  private find(headers: RequestHeaders) {
    const token = /(?:^|;\s*)discovery_owner=([^;]+)/.exec(
      headers.cookie || '',
    )?.[1]
    return token &&
      this.current &&
      this.current.expires > Date.now() &&
      equal(token, this.current.token)
      ? this.current
      : undefined
  }
  status(headers: RequestHeaders): SessionState {
    this.validateTransport(headers)
    const session = this.find(headers)
    return { authenticated: !!session, sessionId: session?.id ?? '' }
  }
  require(headers: RequestHeaders): string {
    this.validateTransport(headers, true)
    return (
      this.find(headers)?.id ??
      fail('unauthorized', 'Sign in with the local owner token')
    )
  }
  requireRead(headers: RequestHeaders): string {
    this.validateTransport(headers)
    return (
      this.find(headers)?.id ??
      fail('unauthorized', 'Sign in with the local owner token')
    )
  }
  login(headers: RequestHeaders, token: string) {
    this.validateTransport(headers, true)
    if (Date.now() - this.failureWindow > 60_000) {
      this.failures = 0
      this.failureWindow = Date.now()
    }
    if (this.failures >= 10)
      return fail('forbidden', 'Too many sign-in attempts; wait one minute')
    if (!equal(token, this.bootstrap)) {
      this.failures++
      return fail('unauthorized', 'Local owner token was not accepted')
    }
    this.current = {
      token: randomBytes(32).toString('base64url'),
      id: randomUUID(),
      expires: Date.now() + 12 * 60 * 60 * 1000,
    }
    return {
      state: { authenticated: true, sessionId: this.current.id },
      cookie: `discovery_owner=${this.current.token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200`,
    }
  }
  logout(headers: RequestHeaders) {
    this.require(headers)
    this.current = undefined
    return {
      state: { authenticated: false, sessionId: '' },
      cookie: 'discovery_owner=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0',
    }
  }
}

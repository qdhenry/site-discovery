import { makeRpcService } from '@bespokeagentics/microdots-runtime/service'
import { expect, test } from 'bun:test'
import { Effect, Fiber, Layer } from 'effect'
import { HttpRouter } from 'effect/unstable/http'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { MINI_HOST_ORIGIN } from './auth.ts'
import { RpcAppLayer } from './handlers.ts'
import { ExtraRoutes, ROUTE_OWNED_CORS_PREFIXES } from './routes.ts'
import { closeRuntime, initializeRuntime } from './runtime.ts'

test('HTTP transport gates sessions, RPC and screenshots; forged RPC headers cannot bypass origin checks', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'discovery-wire-'))
  const before = {
    dir: process.env.DISCOVERY_STATE_DIR,
    fixtures: process.env.DISCOVERY_FIXTURES,
    token: process.env.DISCOVERY_OWNER_TOKEN,
  }
  process.env.DISCOVERY_STATE_DIR = dir
  process.env.DISCOVERY_FIXTURES = '1'
  process.env.DISCOVERY_OWNER_TOKEN = 'deterministic-owner-token-for-wire-test'
  const port = 41328
  const origin = `http://127.0.0.1:${port}`
  const runtime = await initializeRuntime(port)
  const web = HttpRouter.toWebHandler(Layer.merge(RpcAppLayer, ExtraRoutes), {
    disableLogger: true,
  })
  const request = (
    path: string,
    options: {
      method?: string
      body?: string
      cookie?: string
      origin?: string
      host?: string
    } = {},
  ) =>
    web.handler(
      new Request(origin + path, {
        method: options.method ?? 'GET',
        headers: {
          host: options.host ?? `127.0.0.1:${port}`,
          origin: options.origin ?? origin,
          'content-type': 'application/json',
          ...(options.cookie ? { cookie: options.cookie } : {}),
        },
        ...(options.body ? { body: options.body } : {}),
      }),
    )
  const rpc = (
    tag: string,
    payload: unknown,
    cookie = '',
    originOverride = origin,
  ) =>
    request('/rpc', {
      method: 'POST',
      cookie,
      origin: originOverride,
      body:
        JSON.stringify({
          _tag: 'Request',
          id: '1',
          tag,
          payload,
          headers: [['origin', origin]],
        }) + '\n',
    })
  try {
    expect((await request('/session')).status).toBe(200)
    expect((await rpc('getDiscoveryWorkspace', {})).status).toBe(401)
    expect((await rpc('getDiscoverySettings', {})).status).toBe(401)
    expect((await rpc('saveDiscoverySettings', {})).status).toBe(401)
    expect(
      (await request('/session', { host: 'attacker.example' })).status,
    ).toBe(403)
    expect(
      (
        await request('/session', {
          method: 'POST',
          body: JSON.stringify({ token: 'wrong' }),
        })
      ).status,
    ).toBe(401)
    const signedIn = await request('/session', {
      method: 'POST',
      body: JSON.stringify({ token: process.env.DISCOVERY_OWNER_TOKEN }),
    })
    expect(signedIn.status).toBe(200)
    expect(signedIn.headers.get('set-cookie')).toContain('HttpOnly')
    expect(signedIn.headers.get('set-cookie')).toContain('SameSite=Strict')
    const cookie = signedIn.headers.get('set-cookie')!.split(';')[0]!
    const session: { authenticated: boolean } = await request('/session', {
      cookie,
    }).then(r => r.json())
    expect(session.authenticated).toBe(true)
    expect(
      (
        await rpc(
          'getDiscoveryWorkspace',
          {},
          cookie,
          'http://attacker.example',
        )
      ).status,
    ).toBe(403)
    for (const alias of ['/rpc', '/rpc/', '/rpc//', '/rpc%2f']) {
      const forged = await request(alias, {
        method: 'POST',
        body:
          JSON.stringify({
            _tag: 'Request',
            id: '1',
            tag: 'getDiscoveryWorkspace',
            payload: {},
            headers: [
              ['cookie', cookie],
              ['origin', origin],
            ],
          }) + '\n',
      })
      expect(forged.status).toBe(401)
    }
    const workspace = await rpc('getDiscoveryWorkspace', {}, cookie)
    expect(workspace.status).toBe(200)
    expect(await workspace.text()).toContain('fixtureEnabled')
    expect(
      await (await rpc('getDiscoverySettings', {}, cookie)).text(),
    ).toContain('maxOutputTokens')
    const settings = await runtime.engine.getSettings()
    const settingsPayload = {
      commandId: crypto.randomUUID(),
      expectedRevision: settings.settings.revision,
      values: { ...settings.settings.values, maxOutputTokens: 9000 },
    }
    expect(
      (
        await rpc(
          'saveDiscoverySettings',
          settingsPayload,
          cookie,
          'http://attacker.example',
        )
      ).status,
    ).toBe(403)
    expect(
      await (
        await rpc('saveDiscoverySettings', settingsPayload, cookie)
      ).text(),
    ).toContain('Success')
    expect(
      (await runtime.engine.getSettings()).settings.values.maxOutputTokens,
    ).toBe(9000)
    const capture = await rpc(
      'createDiscoveryCapture',
      {
        projectId: 'default',
        commandId: crypto.randomUUID(),
        input: {
          mode: 'single',
          source: 'https://example.com',
          depth: 1,
          maxPages: 1,
          desktop: true,
          mobile: false,
          targetCms: 'generic',
          evidenceMode: 'fixture',
        },
      },
      cookie,
    )
    expect(capture.status).toBe(200)
    expect(await capture.text()).toContain('Success')
    await runtime.engine.idle()
    const run = (await runtime.engine.history('default'))[0]!
    const snapshot = await runtime.engine.getRun('default', run.id)
    const image = snapshot.pages[0]!.desktopUrl
    expect((await request(image)).status).toBe(401)
    const privateImage = await request(image, { cookie })
    expect(privateImage.status).toBe(200)
    expect(privateImage.headers.get('cache-control')).toContain('private')
    expect(
      (await request(image.replace('/default/', '/other/'), { cookie })).status,
    ).toBe(404)
    const loggedOut = await request('/session', { method: 'DELETE', cookie })
    expect(loggedOut.status).toBe(200)
    expect((await rpc('getDiscoveryWorkspace', {}, cookie)).status).toBe(401)
  } finally {
    await web.dispose()
    await closeRuntime()
    for (const [key, value] of [
      ['DISCOVERY_STATE_DIR', before.dir],
      ['DISCOVERY_FIXTURES', before.fixtures],
      ['DISCOVERY_OWNER_TOKEN', before.token],
    ] as const) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    await rm(dir, { recursive: true, force: true })
  }
})

test('the :5193 mini-host crosses credentialed CORS on the real service stack; other origins still fail', async () => {
  // The service entry must hand the route-owned prefixes to the runtime, or its
  // credential-less standard CORS answers the mini-host's preflight instead.
  // The compiler derives a generated app's shape-main.ts from the shape's main.ts.
  const entry = existsSync(join(import.meta.dir, 'shape-main.ts'))
    ? 'shape-main.ts'
    : 'main.ts'
  expect(await readFile(join(import.meta.dir, entry), 'utf8')).toContain(
    'routeOwnedCorsPrefixes: ROUTE_OWNED_CORS_PREFIXES',
  )
  const dir = await mkdtemp(join(tmpdir(), 'discovery-minihost-'))
  const before = {
    dir: process.env.DISCOVERY_STATE_DIR,
    fixtures: process.env.DISCOVERY_FIXTURES,
    token: process.env.DISCOVERY_OWNER_TOKEN,
  }
  process.env.DISCOVERY_STATE_DIR = dir
  process.env.DISCOVERY_FIXTURES = '1'
  process.env.DISCOVERY_OWNER_TOKEN = 'deterministic-owner-token-for-minihost-test'
  const port = 41329
  await initializeRuntime(port)
  // The same options shape-main.ts passes, on a test port.
  const server = Effect.runFork(
    Layer.launch(
      makeRpcService({
        rpcLayer: RpcAppLayer,
        port,
        host: '127.0.0.1',
        extraRoutes: ExtraRoutes,
        allowedOrigins: [`http://127.0.0.1:${port}`, `http://localhost:${port}`],
        allowedMethods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
        routeOwnedCorsPrefixes: ROUTE_OWNED_CORS_PREFIXES,
        trace: 'off',
      }),
    ),
  )
  const base = `http://127.0.0.1:${port}`
  const call = (
    path: string,
    options: {
      method?: string
      origin?: string
      cookie?: string
      body?: string
      headers?: Record<string, string>
    } = {},
  ) =>
    fetch(base + path, {
      method: options.method ?? 'GET',
      headers: {
        ...(options.origin ? { origin: options.origin } : {}),
        ...(options.cookie ? { cookie: options.cookie } : {}),
        ...options.headers,
      },
      ...(options.body ? { body: options.body } : {}),
    })
  const envelope = (tag: string) =>
    JSON.stringify({
      _tag: 'Request',
      id: '1',
      tag,
      payload: {},
      headers: [],
    }) + '\n'
  const rpc = (tag: string, origin: string, cookie = '', path = '/rpc') =>
    call(path, {
      method: 'POST',
      origin,
      cookie,
      body: envelope(tag),
      headers: { 'content-type': 'application/ndjson' },
    })
  const allowOrigin = (response: Response) =>
    response.headers.get('access-control-allow-origin')
  try {
    for (let attempt = 0; ; attempt++) {
      const ready = await call('/session').catch(() => undefined)
      if (ready?.status === 200) break
      if (attempt > 100) throw new Error('service did not start')
      await Bun.sleep(20)
    }

    for (const path of ['/rpc', '/rpc/', '/session']) {
      const preflight = await call(path, {
        method: 'OPTIONS',
        origin: MINI_HOST_ORIGIN,
        headers: {
          'access-control-request-method': 'POST',
          'access-control-request-headers': 'content-type',
        },
      })
      expect(preflight.status).toBe(204)
      expect(allowOrigin(preflight)).toBe(MINI_HOST_ORIGIN)
      expect(preflight.headers.get('access-control-allow-credentials')).toBe(
        'true',
      )
      expect(preflight.headers.get('access-control-allow-methods')).toContain(
        'POST',
      )
      expect(preflight.headers.get('access-control-allow-headers')).toContain(
        'content-type',
      )
    }
    for (const foreign of ['http://localhost:5194', 'https://attacker.example']) {
      const preflight = await call('/rpc', {
        method: 'OPTIONS',
        origin: foreign,
        headers: { 'access-control-request-method': 'POST' },
      })
      expect(preflight.status).toBe(403)
      expect(allowOrigin(preflight)).toBeNull()
    }

    // A 401 must be readable cross-origin, or the UI reports a network error.
    const anonymous = await rpc('getDiscoveryWorkspace', MINI_HOST_ORIGIN)
    expect(anonymous.status).toBe(401)
    expect(allowOrigin(anonymous)).toBe(MINI_HOST_ORIGIN)

    const signedIn = await call('/session', {
      method: 'POST',
      origin: MINI_HOST_ORIGIN,
      body: JSON.stringify({ token: process.env.DISCOVERY_OWNER_TOKEN }),
      headers: { 'content-type': 'application/json' },
    })
    expect(signedIn.status).toBe(200)
    expect(allowOrigin(signedIn)).toBe(MINI_HOST_ORIGIN)
    expect(signedIn.headers.get('access-control-allow-credentials')).toBe('true')
    expect(signedIn.headers.get('set-cookie')).toContain('SameSite=Strict')
    const cookie = signedIn.headers.get('set-cookie')!.split(';')[0]!

    const workspace = await rpc('getDiscoveryWorkspace', MINI_HOST_ORIGIN, cookie)
    expect(workspace.status).toBe(200)
    expect(allowOrigin(workspace)).toBe(MINI_HOST_ORIGIN)
    expect(await workspace.text()).toContain('fixtureEnabled')
    // The generated backend element's health probe posts to `/rpc/`.
    const slashed = await rpc('getDiscoveryWorkspace', MINI_HOST_ORIGIN, cookie, '/rpc/')
    expect(slashed.status).toBe(200)
    expect(allowOrigin(slashed)).toBe(MINI_HOST_ORIGIN)
    expect(await slashed.text()).toContain('fixtureEnabled')

    // The cookie alone never authorizes another origin or a cross-site request.
    const foreign = await rpc('getDiscoveryWorkspace', 'http://localhost:5194', cookie)
    expect(foreign.status).toBe(403)
    expect(allowOrigin(foreign)).toBeNull()
    const crossSite = await call('/rpc', {
      method: 'POST',
      origin: MINI_HOST_ORIGIN,
      cookie,
      body: envelope('getDiscoveryWorkspace'),
      headers: {
        'content-type': 'application/ndjson',
        'sec-fetch-site': 'cross-site',
      },
    })
    expect(crossSite.status).toBe(403)

    // Same-origin traffic is unchanged: no CORS headers at all.
    const sameOrigin = await rpc('getDiscoveryWorkspace', base, cookie)
    expect(sameOrigin.status).toBe(200)
    expect(allowOrigin(sameOrigin)).toBeNull()
  } finally {
    await Effect.runPromise(Fiber.interrupt(server))
    await closeRuntime()
    for (const [key, value] of [
      ['DISCOVERY_STATE_DIR', before.dir],
      ['DISCOVERY_FIXTURES', before.fixtures],
      ['DISCOVERY_OWNER_TOKEN', before.token],
    ] as const) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    await rm(dir, { recursive: true, force: true })
  }
})

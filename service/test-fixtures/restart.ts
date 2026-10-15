/** Subprocess fixture: injected providers make no network requests. */
import { appendFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'

import type { CaptureInput } from '../../src/contract.ts'
import { readConfig } from '../config.ts'
import { DiscoveryEngine } from '../engine.ts'
import { createProviders } from '../providers.ts'

const mode = process.argv[2]!
const dir = process.argv[3]!
const config = readConfig({
  DISCOVERY_STATE_DIR: dir,
  DISCOVERY_FIXTURES: '1',
  CLOUDFLARE_ACCOUNT_ID: 'test',
  CLOUDFLARE_BROWSER_API_TOKEN: 'test',
  CLOUDFLARE_AI_GATEWAY_ID: 'test',
  AI_GATEWAY_API_TOKEN: 'test',
  ANTHROPIC_API_KEY: 'test',
  DISCOVERY_RUN_LIMIT_USD: '1',
  DISCOVERY_MONTHLY_LIMIT_USD: '1',
  DISCOVERY_ATTEMPT_RESERVATION_USD: '0.01',
})
const fixture = createProviders(config)
const engine = await DiscoveryEngine.open(config, {
  providers: {
    ...fixture,
    reservationBoundUsd: 0.001,
    capture: (page, viewport, signal) =>
      fixture.capture(
        { ...page, provenance: { ...page.provenance, mode: 'fixture' } },
        viewport,
        signal,
      ),
    analyze: async (page, html, images, signal) => {
      await appendFile(join(dir, 'dispatches'), 'analysis\n')
      if (mode === 'crash') process.exit(73)
      const result = await fixture.analyze(
        { ...page, provenance: { ...page.provenance, mode: 'fixture' } },
        html,
        images,
        signal,
      )
      return { ...result, usage: { ...result.usage, costUsd: 0.002 } }
    },
  },
})
if (mode === 'crash') {
  const input: CaptureInput = {
    mode: 'single',
    source: 'https://example.com',
    depth: 1,
    maxPages: 1,
    desktop: true,
    mobile: false,
    targetCms: 'generic',
    evidenceMode: 'live',
  }
  const created = await engine.createCapture({
    projectId: 'default',
    commandId: 'stable-capture-command',
    input,
  })
  await engine.idle()
  const run = await engine.getRun('default', created.run.id)
  await engine.analyze({
    projectId: 'default',
    runId: run.run.id,
    commandId: 'stable-analysis-command',
    expectedRevision: run.run.revision,
    pageIds: run.pages.map(p => p.id),
  })
  await engine.idle()
} else {
  await engine.idle()
  const run = (await engine.history('default'))[0]!
  if (mode === 'retry') {
    await engine.retry({
      projectId: 'default',
      runId: run.id,
      commandId: 'stable-explicit-retry',
      expectedRevision: run.revision,
    })
    await engine.idle()
  }
  if (mode === 'delete')
    await engine.deleteRun({
      projectId: 'default',
      runId: run.id,
      commandId: 'stable-delete-command',
      expectedRevision: run.revision,
    })
  const workspace = await engine.workspace('test')
  const snapshot =
    mode === 'delete' ? null : await engine.getRun('default', run.id)
  console.log(
    JSON.stringify({
      workspace,
      snapshot,
      dispatches: (await readFile(join(dir, 'dispatches'), 'utf8'))
        .trim()
        .split('\n').length,
    }),
  )
}
await engine.close()

import { describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { CaptureInput, RunSnapshot } from '../src/contract.ts'
import { readConfig } from './config.ts'
import { DiscoveryEngine } from './engine.ts'
import { CaptureRejected, createProviders, mapCmsName } from './providers.ts'
import { publicUrl } from './urls.ts'

const input: CaptureInput = {
  mode: 'single',
  source: 'https://example.com',
  maxPages: 10,
  depth: 1,
  desktop: true,
  mobile: true,
  evidenceMode: 'fixture',
  targetCms: 'optimizely',
}
const use = async (
  fn: (engine: DiscoveryEngine, dir: string) => Promise<void>,
  options: Parameters<typeof DiscoveryEngine.open>[1] = {},
) => {
  const dir = await mkdtemp(join(tmpdir(), 'discovery-engine-'))
  const engine = await DiscoveryEngine.open(
    readConfig({ DISCOVERY_STATE_DIR: dir, DISCOVERY_FIXTURES: '1' }),
    options,
  )
  try {
    await fn(engine, dir)
  } finally {
    await engine.close()
    await rm(dir, { recursive: true, force: true })
  }
}
const capture = async (
  engine: DiscoveryEngine,
  id = crypto.randomUUID(),
  override: Partial<CaptureInput> = {},
): Promise<RunSnapshot> => {
  const created = await engine.createCapture({
    projectId: 'default',
    commandId: id,
    input: { ...input, ...override },
  })
  await engine.idle()
  return engine.getRun('default', created.run.id)
}
const analyze = async (engine: DiscoveryEngine, run: RunSnapshot) => {
  await engine.analyze({
    projectId: 'default',
    runId: run.run.id,
    commandId: crypto.randomUUID(),
    expectedRevision: run.run.revision,
    pageIds: run.pages.map(p => p.id),
  })
  await engine.idle()
  return engine.getRun('default', run.run.id)
}

describe('Discovery durable application', () => {
  test('capture stays model-free until explicit selection, both private screenshots survive reopen', () =>
    use(async (engine, dir) => {
      const result = await capture(engine)
      expect(result.run.phase).toBe('captured')
      expect(result.findings).toHaveLength(0)
      expect(result.run.usage.analyzedPages).toBe(0)
      expect(result.pages).toHaveLength(1)
      expect(result.pages[0]!.desktopUrl).toContain('/private/screenshots/')
      expect(result.pages[0]!.mobileUrl).not.toBe(result.pages[0]!.desktopUrl)
      const screenshot = await engine.screenshot(
        'default',
        result.run.id,
        result.pages[0]!.id,
        'mobile',
      )
      expect(screenshot.mime).toBe('image/svg+xml')
      expect(new TextDecoder().decode(screenshot.bytes)).toContain('MOBILE')
      await engine.close()
      const reopened = await DiscoveryEngine.open(
        readConfig({ DISCOVERY_STATE_DIR: dir, DISCOVERY_FIXTURES: '1' }),
      )
      try {
        expect(
          (await reopened.getRun('default', result.run.id)).run.phase,
        ).toBe('captured')
      } finally {
        await reopened.close()
      }
    }))
  test('all four inputs; duplicates and whitespace capped; source CMS mappings', () =>
    use(async engine => {
      for (const mode of ['single', 'batch', 'domain', 'sitemap'] as const) {
        const result = await capture(engine, crypto.randomUUID(), {
          mode,
          source:
            mode === 'batch'
              ? '\n https://example.com/a\nhttps://example.com/a\nhttps://example.com/b\n'
              : 'https://example.com',
          maxPages: 2,
        })
        expect(result.run.phase).toBe('captured')
        expect(result.pages.length).toBe(mode === 'single' ? 1 : 2)
      }
      expect(mapCmsName('Hero Banner', 'aem', 'component')).toBe('hero-banner')
      expect(mapCmsName('Hero Banner', 'sitecore', 'component')).toBe(
        'HeroBannerRendering',
      )
      expect(mapCmsName('Article', 'optimizely', 'content-type')).toBe(
        'Article',
      )
    }))
  test('stable commands and revision guards reject changed payload and cross-project references', () =>
    use(async engine => {
      const commandId = crypto.randomUUID()
      const result = await capture(engine, commandId)
      expect(
        (await engine.createCapture({ projectId: 'default', commandId, input }))
          .run.id,
      ).toBe(result.run.id)
      await expect(
        engine.createCapture({
          projectId: 'default',
          commandId,
          input: { ...input, source: 'https://example.org' },
        }),
      ).rejects.toMatchObject({ code: 'conflict' })
      for (const id of ['toString', 'constructor', '__proto__']) {
        await expect(engine.history(id)).rejects.toMatchObject({
          code: 'not_found',
        })
        await expect(engine.getRun('default', id)).rejects.toMatchObject({
          code: 'not_found',
        })
      }
      const project = await engine.project({
        commandId: crypto.randomUUID(),
        name: 'Other',
      })
      await expect(
        engine.getRun(project.id, result.run.id),
      ).rejects.toMatchObject({ code: 'not_found' })
      await expect(
        engine.analyze({
          projectId: 'default',
          runId: result.run.id,
          commandId: crypto.randomUUID(),
          expectedRevision: -1,
          pageIds: result.pages.map(p => p.id),
        }),
      ).rejects.toMatchObject({ code: 'conflict' })
      await expect(
        engine.analyze({
          projectId: 'default',
          runId: result.run.id,
          commandId: crypto.randomUUID(),
          expectedRevision: result.run.revision,
          pageIds: ['not-a-page'],
        }),
      ).rejects.toMatchObject({ code: 'validation' })
      expect((await engine.logs('default', result.run.id, 0))[0]!.seq).toBe(1)
    }))
  test('save is receipt-based, transactional, idempotent; keep-both creates and merge validates ownership', () =>
    use(async engine => {
      const first = await analyze(engine, await capture(engine))
      expect(first.findings).toHaveLength(2)
      const choices = first.findings.map(f => ({
        findingId: f.id,
        action: 'create' as const,
        targetId: '',
      }))
      const preview = await engine.previewSave({
        projectId: 'default',
        runId: first.run.id,
        expectedRevision: first.run.revision,
        choices,
      })
      const saveInput = {
        projectId: 'default',
        runId: first.run.id,
        commandId: crypto.randomUUID(),
        expectedRevision: first.run.revision,
        expectedProjectRevision: preview.projectRevision,
        choices,
      }
      const receipt = await engine.save(saveInput)
      expect(await engine.save(saveInput)).toEqual(receipt)
      expect(receipt.records.map(r => r.cmsName)).toEqual(
        preview.items.map(i => i.cmsName),
      )
      expect(
        (await engine.getRun('default', first.run.id)).findings.every(
          f => f.saveReceiptId === receipt.id,
        ),
      ).toBe(true)
      const second = await analyze(engine, await capture(engine))
      expect(second.findings[0]!.existingId).not.toBe('')
      const keepBoth = [
        {
          findingId: second.findings[0]!.id,
          action: 'create' as const,
          targetId: '',
        },
      ]
      const secondPreview = await engine.previewSave({
        projectId: 'default',
        runId: second.run.id,
        expectedRevision: second.run.revision,
        choices: keepBoth,
      })
      const secondReceipt = await engine.save({
        projectId: 'default',
        runId: second.run.id,
        commandId: crypto.randomUUID(),
        expectedRevision: second.run.revision,
        expectedProjectRevision: secondPreview.projectRevision,
        choices: keepBoth,
      })
      expect(secondReceipt.records[0]!.recordId).not.toBe(
        second.findings[0]!.existingId,
      )
      expect(await engine.library('default')).toHaveLength(3)
      const exported = JSON.parse((await engine.exportProject('default')).json)
      expect(exported.library).toHaveLength(3)
      expect(exported.audits).toHaveLength(2)
      await expect(
        engine.previewSave({
          projectId: 'default',
          runId: second.run.id,
          expectedRevision: (await engine.getRun('default', second.run.id)).run
            .revision,
          choices: [
            {
              findingId: second.findings[1]!.id,
              action: 'merge',
              targetId: 'constructor',
            },
          ],
        }),
      ).rejects.toMatchObject({ code: 'not_found' })
    }))
  test('known page failures preserve later captures and analysis of successful pages', async () => {
    const fixture = createProviders(readConfig({ DISCOVERY_FIXTURES: '1' }))
    await use(
      async engine => {
        const captured = await capture(engine, crypto.randomUUID(), {
          mode: 'batch',
          source: 'https://example.com/blocked\nhttps://example.com/works',
        })
        expect(captured.run.phase).toBe('captured')
        expect(captured.run.failedCount).toBe(1)
        expect(captured.run.capturedCount).toBe(1)
        const selected = captured.pages
          .filter(p => p.status === 'captured')
          .map(p => p.id)
        await engine.analyze({
          projectId: 'default',
          runId: captured.run.id,
          commandId: crypto.randomUUID(),
          expectedRevision: captured.run.revision,
          pageIds: selected,
        })
        await engine.idle()
        expect(
          (await engine.getRun('default', captured.run.id)).run.phase,
        ).toBe('completed')
      },
      {
        providers: {
          ...fixture,
          capture: (page, viewport, signal) => {
            if (page.url.includes('/blocked'))
              throw new CaptureRejected('HTTP 403 fixture rejection')
            return fixture.capture(page, viewport, signal)
          },
        },
      },
    )
  })
  test('repeated detections union fields and variants while retaining each page and attempt', async () => {
    const fixture = createProviders(readConfig({ DISCOVERY_FIXTURES: '1' }))
    await use(
      async engine => {
        const result = await analyze(
          engine,
          await capture(engine, crypto.randomUUID(), {
            mode: 'batch',
            source: 'https://example.com/a\nhttps://example.com/b',
          }),
        )
        const article = result.findings.find(f => f.kind === 'content-type')!
        expect(article.fields.map(f => f.name)).toEqual(['Title', 'Author'])
        expect(article.pageIds).toHaveLength(2)
        expect(article.evidence).toHaveLength(2)
        expect(
          new Set(article.evidence.map(e => e.provenance.attemptId)).size,
        ).toBe(2)
        expect(article.variants).toEqual(['A', 'B'])
      },
      {
        providers: {
          ...fixture,
          analyze: async (page, html, images, signal) => {
            const result = await fixture.analyze(page, html, images, signal)
            return {
              ...result,
              findings: [
                {
                  kind: 'content-type',
                  name: 'Article',
                  category: 'Editorial',
                  description: 'Article',
                  confidence: 0.9,
                  fields: [
                    { name: 'Title', type: 'text', required: true },
                    ...(page.url.endsWith('/b')
                      ? [{ name: 'Author', type: 'text', required: false }]
                      : []),
                  ],
                  variants: [page.url.endsWith('/b') ? 'B' : 'A'],
                },
              ],
            }
          },
        },
      },
    )
  })
  test('a rejected viewport does not prevent the other requested viewport', async () => {
    const fixture = createProviders(readConfig({ DISCOVERY_FIXTURES: '1' }))
    for (const failedViewport of ['desktop', 'mobile']) {
      const calls: string[] = []
      await use(
        async engine => {
          const result = await capture(engine)
          expect(calls).toEqual(['desktop', 'mobile'])
          expect(result.run.phase).toBe('captured')
          expect(result.run.capturedCount).toBe(1)
          const p = result.pages[0]!
          expect(
            failedViewport === 'desktop' ? p.desktopUrl : p.mobileUrl,
          ).toBe('')
          expect(
            failedViewport === 'desktop' ? p.mobileUrl : p.desktopUrl,
          ).not.toBe('')
        },
        {
          providers: {
            ...fixture,
            capture: (page, viewport, signal) => {
              calls.push(viewport)
              if (viewport === failedViewport)
                throw new CaptureRejected('Definitive viewport rejection')
              return fixture.capture(page, viewport, signal)
            },
          },
        },
      )
    }
  })
  test('merge succeeds transactionally, rejects a real foreign target, and saved design evidence survives history deletion', () =>
    use(async engine => {
      const first = await analyze(engine, await capture(engine))
      const finding = first.findings[0]!
      const saved = await engine.save({
        projectId: 'default',
        runId: first.run.id,
        commandId: crypto.randomUUID(),
        expectedRevision: first.run.revision,
        expectedProjectRevision: 0,
        choices: [{ findingId: finding.id, action: 'create', targetId: '' }],
      })
      const recordId = saved.records[0]!.recordId
      const second = await analyze(engine, await capture(engine))
      const targetFinding = second.findings.find(f => f.kind === finding.kind)!
      const preview = await engine.previewSave({
        projectId: 'default',
        runId: second.run.id,
        expectedRevision: second.run.revision,
        choices: [
          { findingId: targetFinding.id, action: 'merge', targetId: recordId },
        ],
      })
      const receipt = await engine.save({
        projectId: 'default',
        runId: second.run.id,
        commandId: crypto.randomUUID(),
        expectedRevision: second.run.revision,
        expectedProjectRevision: preview.projectRevision,
        choices: [
          { findingId: targetFinding.id, action: 'merge', targetId: recordId },
        ],
      })
      expect(receipt.records[0]!.recordId).toBe(recordId)
      expect(await engine.library('default')).toHaveLength(1)
      const library = (await engine.library('default'))[0]!
      expect(library.revision).toBe(2)
      expect(library.designVariants).toHaveLength(2)
      const foreign = await engine.project({
        commandId: crypto.randomUUID(),
        name: 'Foreign',
      })
      const foreignCapture = await engine.createCapture({
        projectId: foreign.id,
        commandId: crypto.randomUUID(),
        input,
      })
      await engine.idle()
      const foreignRun = await engine.getRun(foreign.id, foreignCapture.run.id)
      await engine.analyze({
        projectId: foreign.id,
        runId: foreignRun.run.id,
        commandId: crypto.randomUUID(),
        expectedRevision: foreignRun.run.revision,
        pageIds: foreignRun.pages.map(p => p.id),
      })
      await engine.idle()
      const foreignResult = await engine.getRun(foreign.id, foreignRun.run.id)
      await expect(
        engine.previewSave({
          projectId: foreign.id,
          runId: foreignRun.run.id,
          expectedRevision: foreignResult.run.revision,
          choices: [
            {
              findingId: foreignResult.findings[0]!.id,
              action: 'merge',
              targetId: recordId,
            },
          ],
        }),
      ).rejects.toMatchObject({ code: 'not_found' })
      const latest = await engine.getRun('default', first.run.id)
      await engine.deleteRun({
        projectId: 'default',
        runId: first.run.id,
        commandId: crypto.randomUUID(),
        expectedRevision: latest.run.revision,
      })
      const variant = library.designVariants[0]!
      expect(
        (
          await engine.libraryScreenshot(
            'default',
            recordId,
            variant.id,
            'desktop',
          )
        ).bytes.length,
      ).toBeGreaterThan(0)
      await expect(
        engine.libraryScreenshot(foreign.id, recordId, variant.id, 'desktop'),
      ).rejects.toMatchObject({ code: 'not_found' })
    }))
  test('failed save rolls back library, receipts and command, retry can commit', () => {
    let reject = true
    return use(
      async engine => {
        const run = await analyze(engine, await capture(engine))
        const choices = run.findings.map(f => ({
          findingId: f.id,
          action: 'create' as const,
          targetId: '',
        }))
        const save = {
          projectId: 'default',
          runId: run.run.id,
          commandId: crypto.randomUUID(),
          expectedRevision: run.run.revision,
          expectedProjectRevision: 0,
          choices,
        }
        await expect(engine.save(save)).rejects.toThrow('injected rollback')
        expect(await engine.library('default')).toHaveLength(0)
        expect(
          (await engine.getRun('default', run.run.id)).receipts,
        ).toHaveLength(0)
        reject = false
        expect((await engine.save(save)).records).toHaveLength(2)
      },
      {
        beforeSaveCommit: () => {
          if (reject) throw new Error('injected rollback')
        },
      },
    )
  })
  test('private URLs, disabled fixtures and missing live configuration are refused', () =>
    use(async engine => {
      for (const url of [
        'http://127.0.0.1',
        'http://localhost',
        'http://10.0.0.1',
        'file:///etc/passwd',
        'https://example.com:8443',
        'http://[::1]',
      ])
        expect(() => publicUrl(url)).toThrow()
      await expect(
        engine.createCapture({
          projectId: 'default',
          commandId: crypto.randomUUID(),
          input: { ...input, evidenceMode: 'live' },
        }),
      ).rejects.toMatchObject({ code: 'configuration' })
      expect(
        (await engine.workspace('session')).configuration.analysisReady,
      ).toBe(false)
    }))
})

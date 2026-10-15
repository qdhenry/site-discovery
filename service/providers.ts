import { Schema as S } from 'effect'

import {
  type Models,
  calculateCost,
  createModels,
} from '@earendil-works/pi-ai/models'
import { anthropicProvider } from '@earendil-works/pi-ai/providers/anthropic'

import {
  type AnalysisSettingsSnapshot,
  Field,
  type Finding,
  type Page,
  type Usage,
} from '../src/contract.ts'
import { type Config, configuration, fail } from './config.ts'
import {
  BASE_ANALYSIS_PROMPT,
  evaluateSettings,
  initialSettings,
  snapshotSettings,
} from './settings.ts'
import { publicUrl, resolvePublic, robotsAllowed } from './urls.ts'

const DetectionSchema = S.Struct({
  findings: S.Array(
    S.Struct({
      kind: S.Literals(['component', 'content-type']),
      name: S.String,
      description: S.String,
      category: S.String,
      confidence: S.Finite,
      fields: S.Array(Field),
      variants: S.Array(S.String),
    }),
  ),
})
const SnapshotSchema = S.Struct({
  success: S.Boolean,
  result: S.Struct({ screenshot: S.String, content: S.String }),
  meta: S.optional(S.Struct({ title: S.optional(S.String) })),
})
export type Detection = (typeof DetectionSchema.Type.findings)[number]
export type CaptureResult = {
  html: string
  title: string
  bytes: Uint8Array
  extension: 'png' | 'svg'
}
export type AnalysisResult = {
  findings: readonly Detection[]
  usage: Usage
  rawResponse: string
  rawResponseTruncated?: boolean
  rawResponseChars?: number
}
export type Providers = {
  capture: (
    page: Page,
    viewport: 'desktop' | 'mobile',
    signal: AbortSignal,
  ) => Promise<CaptureResult>
  analyze: (
    page: Page,
    html: string,
    images: readonly { bytes: Uint8Array; mime: string }[],
    signal: AbortSignal,
    settings?: AnalysisSettingsSnapshot,
  ) => Promise<AnalysisResult>
  models: Models
  reservationBoundUsd: number
}
export class CaptureRejected extends Error {}
/** A terminal model response was received and its usage is known, but its content cannot be accepted. */
export class AnalysisRejected extends Error {
  readonly rawResponse: string
  readonly rawResponseTruncated: boolean
  readonly rawResponseChars: number
  constructor(
    message: string,
    readonly usage: Usage,
    rawResponse: string,
  ) {
    super(message)
    this.rawResponse = rawResponse.slice(0, 100000)
    this.rawResponseTruncated = rawResponse.length > 100000
    this.rawResponseChars = rawResponse.length
  }
}
/** A transport/stream interruption cannot establish final cost; preserve evidence without releasing liability. */
export class AnalysisUnknown extends Error {
  readonly rawResponse: string
  readonly rawResponseTruncated: boolean
  readonly rawResponseChars: number
  constructor(
    message: string,
    rawResponse: string,
    readonly usage: Usage | null,
  ) {
    super(message)
    this.rawResponse = rawResponse.slice(0, 100000)
    this.rawResponseTruncated = rawResponse.length > 100000
    this.rawResponseChars = rawResponse.length
  }
}
export function createProviders(
  config: Config,
  transport?: typeof globalThis.fetch,
): Providers {
  const models = createModels()
  models.setProvider({
    ...anthropicProvider(),
    auth: {
      apiKey: {
        name: 'Claude API key through authenticated Cloudflare AI Gateway',
        resolve: async ({ signal }) => {
          signal.throwIfAborted()
          if (
            !config.anthropicKey ||
            !config.gatewayToken ||
            !config.accountId ||
            !config.gatewayId
          )
            return undefined
          return {
            auth: {
              apiKey: config.anthropicKey,
              baseUrl: `https://gateway.ai.cloudflare.com/v1/${encodeURIComponent(config.accountId)}/${encodeURIComponent(config.gatewayId)}/anthropic`,
              headers: {
                'cf-aig-authorization': `Bearer ${config.gatewayToken}`,
              },
            },
            source: 'Discovery server configuration',
          }
        },
      },
    },
  })
  const defaults = initialSettings(config, models)
  const reservationBoundUsd = evaluateSettings(
    config,
    models,
    defaults.values,
  ).minimumReservationUsd
  return {
    models,
    reservationBoundUsd,
    async capture(page, viewport, signal) {
      if (page.provenance.mode === 'fixture') {
        if (!config.fixtureEnabled)
          return fail('configuration', 'Deterministic fixtures are disabled')
        const width = viewport === 'desktop' ? 1440 : 390
        const title =
          new URL(page.url).pathname === '/'
            ? 'Example Studio'
            : new URL(page.url).pathname.split('/').filter(Boolean).join(' · ')
        const safe = title.replace(/[<>&"']/g, '')
        const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="900" viewBox="0 0 ${width} 900"><rect width="100%" height="100%" fill="#f4f0e8"/><rect width="100%" height="68" fill="#162b2a"/><text x="28" y="42" fill="#fff" font-size="22" font-family="sans-serif">EXAMPLE STUDIO</text><rect x="24" y="98" width="${width - 48}" height="370" rx="12" fill="#ccd8ca"/><text x="42" y="150" font-size="16" fill="#264a43" font-family="sans-serif">DETERMINISTIC FIXTURE · ${viewport.toUpperCase()}</text><text x="42" y="218" font-size="${width > 400 ? 54 : 29}" fill="#162b2a" font-family="sans-serif">${safe}</text><text x="42" y="268" font-size="18" fill="#264a43" font-family="sans-serif">Thoughtful spaces. Useful stories.</text><rect x="42" y="320" width="150" height="46" rx="6" fill="#162b2a"/><text x="64" y="349" fill="#fff" font-size="16" font-family="sans-serif">Explore work</text><rect x="24" y="500" width="${width - 48}" height="240" rx="12" fill="#fff"/><text x="42" y="550" font-size="24" fill="#162b2a" font-family="sans-serif">Latest stories</text><text x="42" y="595" font-size="16" fill="#52635c" font-family="sans-serif">Capture evidence for local testing</text><text x="28" y="840" font-size="14" fill="#52635c" font-family="sans-serif">No website or model request was made.</text></svg>`
        await new Promise(resolve => setTimeout(resolve, 25))
        return {
          html: `<html><title>${safe}</title><main><h1>${safe}</h1><section class="hero">Explore work</section><article>Latest stories</article></main></html>`,
          title,
          bytes: new TextEncoder().encode(svg),
          extension: 'svg',
        }
      }
      if (!configuration(config).captureReady)
        return fail(
          'configuration',
          'Configure Cloudflare account and Browser Rendering token',
        )
      const url = publicUrl(page.url)
      await resolvePublic(url)
      if (!(await robotsAllowed(url.href, signal)))
        throw new CaptureRejected('Capture blocked by public robots.txt')
      const response = await (transport ?? fetch)(
        `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(config.accountId)}/browser-run/snapshot`,
        {
          method: 'POST',
          headers: {
            authorization: `Bearer ${config.browserToken}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            url: url.href,
            formats: ['content', 'screenshot'],
            viewport: {
              width: viewport === 'desktop' ? 1440 : 390,
              height: viewport === 'desktop' ? 900 : 844,
              deviceScaleFactor: 1,
            },
            screenshotOptions: { fullPage: true, type: 'png' },
            gotoOptions: { waitUntil: 'networkidle2', timeout: 30_000 },
          }),
          signal: AbortSignal.any([signal, AbortSignal.timeout(40_000)]),
          redirect: 'error',
        },
      )
      if (!response.ok)
        throw new CaptureRejected(
          `Cloudflare capture returned HTTP ${response.status}`,
        )
      const text = await response.text()
      if (text.length > 30_000_000)
        throw new CaptureRejected('Cloudflare snapshot exceeds the 30 MB limit')
      let data: typeof SnapshotSchema.Type
      try {
        data = S.decodeUnknownSync(SnapshotSchema)(JSON.parse(text))
      } catch {
        throw new CaptureRejected('Cloudflare returned an invalid snapshot')
      }
      if (
        !data.success ||
        !data.result?.screenshot ||
        typeof data.result.content !== 'string'
      )
        throw new CaptureRejected('Cloudflare returned an incomplete snapshot')
      const bytes = Buffer.from(data.result.screenshot, 'base64')
      if (
        !bytes
          .subarray(0, 8)
          .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      )
        throw new CaptureRejected('Cloudflare snapshot is not a PNG')
      return {
        html: data.result.content.slice(0, 200_000),
        title:
          data.meta?.title ||
          /<title[^>]*>([^<]*)/i.exec(data.result.content)?.[1] ||
          url.hostname,
        bytes,
        extension: 'png',
      }
    },
    async analyze(page, html, images, signal, settings) {
      if (page.provenance.mode === 'fixture') {
        if (!config.fixtureEnabled)
          return fail('configuration', 'Deterministic fixtures are disabled')
        await new Promise(resolve => setTimeout(resolve, 25))
        return {
          findings: [
            {
              kind: 'component',
              name: 'Hero Banner',
              description:
                'Prominent heading, supporting copy and primary action.',
              category: 'Marketing',
              confidence: 0.94,
              fields: [
                { name: 'Heading', type: 'text', required: true },
                { name: 'Action', type: 'link', required: false },
              ],
              variants: ['Desktop', 'Mobile'],
            },
            {
              kind: 'content-type',
              name: 'Article',
              description: 'Editorial content with a title and body.',
              category: 'Editorial',
              confidence: 0.9,
              fields: [
                { name: 'Title', type: 'text', required: true },
                { name: 'Body', type: 'rich-text', required: true },
              ],
              variants: [],
            },
          ],
          rawResponse:
            'Explicit deterministic fixture findings: Hero Banner and Article',
          usage: {
            model: 'deterministic-fixture',
            inputTokens: 0,
            outputTokens: 0,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            costUsd: 0,
            reservedUsd: 0,
            analyzedPages: 1,
            durationMs: 25,
          },
        }
      }
      const requestSettings =
        settings ??
        snapshotSettings(
          defaults,
          evaluateSettings(config, models, defaults.values),
        )
      const values = requestSettings.values
      const selectedModel = models.getModel('anthropic', values.modelId)
      // Pi's catalog can opt models into server-side refusal fallback. Discovery
      // keeps model selection explicit and never sends that fallback request.
      const model = selectedModel
        ? {
            ...selectedModel,
            compat: { ...selectedModel.compat, allowedFallbackModels: [] },
          }
        : undefined
      const evaluation = evaluateSettings(config, models, values)
      if (!model || !evaluation.analysisReady)
        return fail(
          'configuration',
          `Claude analysis configuration: ${evaluation.issues.join('; ')}`,
        )
      if (images.some(image => image.bytes.length > 5_000_000))
        return fail(
          'validation',
          'A screenshot exceeds the 5 MB analysis limit',
        )
      const started = Date.now()
      let httpStatus = 0
      let cacheTtlReported = false
      const observedFetch: typeof globalThis.fetch = Object.assign(
        async (request: RequestInfo | URL, init?: RequestInit) => {
          const response = await (transport ?? fetch)(request, init)
          httpStatus = response.status
          return response
        },
        { preconnect: globalThis.fetch.preconnect },
      )
      const result = await models.completeSimple(
        model,
        {
          systemPrompt:
            BASE_ANALYSIS_PROMPT +
            (values.extraInstructions
              ? `\nAdditional owner focus (the JSON contract above remains mandatory):\n${values.extraInstructions}`
              : ''),
          messages: [
            {
              role: 'user',
              timestamp: Date.now(),
              content: [
                {
                  type: 'text',
                  text: `Page: ${page.url}\nRendered DOM evidence:\n${html.slice(0, values.maxDomChars)}`,
                },
                ...images
                  .filter(image => image.mime === 'image/png')
                  .map(image => ({
                    type: 'image' as const,
                    data: Buffer.from(image.bytes).toString('base64'),
                    mimeType: 'image/png',
                  })),
              ],
            },
          ],
        },
        {
          fetch: observedFetch,
          signal: AbortSignal.any([
            signal,
            AbortSignal.timeout(values.requestTimeoutMs),
          ]),
          maxRetries: 0,
          maxTokens: values.maxOutputTokens,
          timeoutMs: values.requestTimeoutMs,
          cacheRetention: values.cacheRetention,
          onProviderStreamEvent: event => {
            if (!event || typeof event !== 'object') return
            const message = 'message' in event ? event.message : undefined
            const usage =
              'usage' in event
                ? event.usage
                : message && typeof message === 'object' && 'usage' in message
                  ? message.usage
                  : undefined
            if (
              usage &&
              typeof usage === 'object' &&
              'cache_creation' in usage
            ) {
              const creation = usage.cache_creation
              if (
                creation &&
                typeof creation === 'object' &&
                'ephemeral_1h_input_tokens' in creation &&
                typeof creation.ephemeral_1h_input_tokens === 'number'
              )
                cacheTtlReported = true
            }
          },
          ...(requestSettings.effectiveReasoning !== 'off'
            ? { reasoning: requestSettings.effectiveReasoning }
            : {}),
          ...(values.temperature !== null
            ? { temperature: values.temperature }
            : {}),
          ...(values.thinkingBudgetTokens !== null
            ? {
                thinkingBudgets: {
                  minimal: values.thinkingBudgetTokens,
                  low: values.thinkingBudgetTokens,
                  medium: values.thinkingBudgetTokens,
                  high: values.thinkingBudgetTokens,
                },
              }
            : {}),
        },
      )
      const raw = result.content
        .filter(part => part.type === 'text')
        .map(part => part.text)
        .join('')
      const u = result.usage
      const actualModelId = result.responseModel ?? model.id
      const actualModel = models.getModel('anthropic', actualModelId)
      // A gateway can omit the TTL split. Charge all reported writes at the requested
      // one-hour rate in that case instead of silently using the five-minute rate.
      if (
        values.cacheRetention === 'long' &&
        !cacheTtlReported &&
        u.cacheWrite > 0
      ) {
        u.cacheWrite1h = u.cacheWrite
      }
      if (actualModel) calculateCost(actualModel, u)
      const validUsage = [
        u.cost.total,
        u.input,
        u.output,
        u.cacheRead,
        u.cacheWrite,
      ].every(n => Number.isFinite(n) && n >= 0)
      const usage: Usage = {
        model: actualModelId,
        inputTokens: u.input,
        outputTokens: u.output,
        cacheReadTokens: u.cacheRead,
        cacheWriteTokens: u.cacheWrite,
        costUsd: u.cost.total,
        reservedUsd: 0,
        analyzedPages: 0,
        durationMs: Date.now() - started,
      }
      if (
        result.stopReason === 'error' &&
        [400, 401, 403, 404, 413, 422, 429].includes(httpStatus) &&
        validUsage
      )
        throw new AnalysisRejected(
          `Claude request was definitively rejected (HTTP ${httpStatus}); update configuration or limits before retrying`,
          usage,
          raw,
        )
      if (
        result.stopReason === 'error' ||
        result.stopReason === 'aborted' ||
        !validUsage
      )
        throw new AnalysisUnknown(
          `Claude response is uncertain (${result.stopReason}); explicit retry is required`,
          raw,
          validUsage ? usage : null,
        )
      if (!actualModel)
        throw new AnalysisUnknown(
          `Claude returned unpriced model ${actualModelId}; the reservation remains held`,
          raw,
          null,
        )
      if (
        actualModelId.replace(/-\d{8}$/, '') !==
        values.modelId.replace(/-\d{8}$/, '')
      )
        throw new AnalysisRejected(
          `Claude returned unexpected model ${actualModelId} instead of ${values.modelId}; measured usage retained`,
          usage,
          raw,
        )
      if (result.stopReason === 'length')
        throw new AnalysisRejected(
          'Claude reached the output limit; review the retained response and explicitly retry',
          usage,
          raw,
        )
      let parsed: typeof DetectionSchema.Type
      try {
        parsed = S.decodeUnknownSync(DetectionSchema, {
          onExcessProperty: 'error',
        })(
          JSON.parse(
            raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, ''),
          ),
        )
        if (
          parsed.findings.length > 40 ||
          parsed.findings.some(
            f =>
              !f.name.trim() ||
              f.name.length > 160 ||
              f.confidence < 0 ||
              f.confidence > 1 ||
              f.fields.length > 50 ||
              f.variants.length > 30,
          )
        )
          throw new Error('Invalid finding bounds')
      } catch {
        throw new AnalysisRejected(
          'Claude returned invalid detections; response and measured usage were retained',
          usage,
          raw,
        )
      }
      return {
        findings: parsed.findings,
        rawResponse: raw.slice(0, 100000),
        rawResponseTruncated: raw.length > 100000,
        rawResponseChars: raw.length,
        usage: { ...usage, analyzedPages: 1 },
      }
    },
  }
}
export const mapCmsName = (
  name: string,
  cms: string,
  kind: Finding['kind'],
): string => {
  const words = name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean)
  const pascal =
    words.map(w => w[0]!.toUpperCase() + w.slice(1)).join('') || 'Untitled'
  return cms === 'aem'
    ? words.map(w => w.toLowerCase()).join('-') || 'untitled'
    : `${pascal}${kind === 'component' ? (cms === 'optimizely' ? 'Block' : cms === 'sitecore' ? 'Rendering' : '') : ''}`
}

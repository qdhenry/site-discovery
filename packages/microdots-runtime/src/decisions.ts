/** Server-side semantic judgments. No environment/global credential lookup and
 * no browser barrel export. Policy/state are data; only application code acts. */
import { Context, Data, Effect, Layer } from 'effect'

export const JEV_MODEL = 'jev-1.13.0' as const
export type DecisionQuestion =
  | { readonly type: 'noul'; readonly instructions: string; readonly criteria?: { readonly true: string; readonly false: string } }
  | { readonly type: 'choice'; readonly instructions: string; readonly criteria: Readonly<Record<string, string>> }
  | { readonly type: 'score'; readonly instructions: string; readonly criteria: readonly string[] }
export type DecisionAnswer =
  | { readonly type: 'noul'; readonly noul: number }
  | { readonly type: 'choice'; readonly choice: string; readonly probabilities: Readonly<Record<string, number>>; readonly confidence: number }
  | { readonly type: 'score'; readonly score: number; readonly probabilities: Readonly<Record<string, number>>; readonly legend: Readonly<Record<string, string>>; readonly confidence: number }
export type DecisionPolicy = {
  readonly id: string
  readonly version: string
  readonly questions: Readonly<Record<string, DecisionQuestion>>
}
export type DecisionInput = {
  /** Supplied by the authenticated owning service, never trusted from a client. */
  readonly scope: string
  readonly policy: DecisionPolicy
  readonly state: unknown
}
export type DecisionResult = {
  readonly model: typeof JEV_MODEL
  readonly policyId: string
  readonly policyVersion: string
  /** Includes scope, policy and exact state. Hashes confer no authorization. */
  readonly snapshotHash: string
  readonly answers: Readonly<Record<string, DecisionAnswer>>
  readonly usage: { readonly inputTokens: number; readonly outputTokens: number }
  readonly evaluatedAt: number
  readonly elapsedMs: number
  readonly cacheHit: boolean
}
export type DecisionFailureCode = 'unconfigured' | 'invalid-input' | 'invalid-response' | 'unauthorized' | 'local-rate-limit' | 'rate-limit' | 'busy' | 'timeout' | 'provider'
export class DecisionFailure extends Data.TaggedError('DecisionFailure')<{
  readonly code: DecisionFailureCode
  readonly retryable: boolean
}> {}
const failure = (code: DecisionFailureCode) => new DecisionFailure({
  code, retryable: ['local-rate-limit', 'rate-limit', 'busy', 'timeout', 'provider'].includes(code),
})
export interface DecisionEvaluator {
  readonly evaluate: (input: DecisionInput) => Effect.Effect<DecisionResult, DecisionFailure>
}
export class Decisions extends Context.Service<Decisions, DecisionEvaluator>()('microdots/Decisions') {}

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
const probability = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1
const sameKeys = (value: Record<string, unknown>, keys: readonly string[]) =>
  Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))
const nonempty = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0

/** Stable JSON also rejects lossy JSON (undefined, NaN, Dates, cycles). */
export const decisionJson = (value: unknown): string => {
  const seen = new Set<object>()
  const visit = (item: unknown, depth: number): unknown => {
    if (depth > 20) throw failure('invalid-input')
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return item
    if (typeof item === 'number' && Number.isFinite(item)) return item
    if (typeof item !== 'object' || item === null || seen.has(item)) throw failure('invalid-input')
    seen.add(item)
    let result: unknown
    if (Array.isArray(item)) result = item.map(child => visit(child, depth + 1))
    else {
      if (!record(item) || (Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null)) throw failure('invalid-input')
      result = Object.fromEntries(Object.keys(item).sort().map(key => [key, visit(item[key], depth + 1)]))
    }
    seen.delete(item)
    return result
  }
  return JSON.stringify(visit(value, 0))
}
export const decisionHash = async (json: string): Promise<string> =>
  [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(json)))].map(byte => byte.toString(16).padStart(2, '0')).join('')

/** Local conservative byte limits, deliberately below provider token limits. */
export const validateDecisionInput = (input: DecisionInput): string => {
  if (!nonempty(input.scope) || input.scope.length > 256 || !record(input.policy) ||
      !nonempty(input.policy.id) || !nonempty(input.policy.version) ||
      input.policy.id.length > 128 || input.policy.version.length > 128 || !record(input.policy.questions)) throw failure('invalid-input')
  const questions = Object.entries(input.policy.questions)
  if (questions.length === 0 || questions.length > 64) throw failure('invalid-input')
  for (const [id, question] of questions) {
    if (!/^[a-zA-Z0-9_.-]{1,80}$/.test(id) || !record(question) || !nonempty(question.instructions)) throw failure('invalid-input')
    if (question.type === 'noul') {
      if (question.criteria !== undefined && (!record(question.criteria) || !sameKeys(question.criteria, ['true', 'false']) || !Object.values(question.criteria).every(nonempty))) throw failure('invalid-input')
    } else if (question.type === 'choice') {
      if (!record(question.criteria) || Object.keys(question.criteria).length < 2 || Object.keys(question.criteria).length > 255 || !Object.entries(question.criteria).every(([key, value]) => nonempty(key) && nonempty(value))) throw failure('invalid-input')
    } else if (question.type === 'score') {
      if (!Array.isArray(question.criteria) || question.criteria.length < 2 || question.criteria.length > 10 || !question.criteria.every(nonempty)) throw failure('invalid-input')
    } else throw failure('invalid-input')
  }
  const bytes = (json: string) => new TextEncoder().encode(json).length
  const stateBytes = bytes(decisionJson(input.state))
  if (stateBytes + Math.max(...questions.map(([, question]) => bytes(decisionJson(question)))) > 32_000) throw failure('invalid-input')
  const body = decisionJson({ model: JEV_MODEL, state: input.state, questions: input.policy.questions })
  if (bytes(body) > 64_000) throw failure('invalid-input')
  return body
}

export const decisionSnapshotJson = (input: DecisionInput): string =>
  decisionJson({ scope: input.scope, policy: input.policy, body: validateDecisionInput(input) })

/** Validate the whole answer set before exposing ANY signal to consumers. */
export const decodeDecisionResponse = (value: unknown, questions: DecisionPolicy['questions']) => {
  if (!record(value) || value.model !== JEV_MODEL || !record(value.answers) || !sameKeys(value.answers, Object.keys(questions)) || !record(value.usage)) throw failure('invalid-response')
  const usage = value.usage
  const inputTokens = usage.input_tokens
  const outputTokens = usage.output_tokens
  if (typeof inputTokens !== 'number' || typeof outputTokens !== 'number' || ![inputTokens, outputTokens].every(x => Number.isSafeInteger(x) && x >= 0)) throw failure('invalid-response')
  const answers: Record<string, DecisionAnswer> = Object.create(null)
  for (const [id, question] of Object.entries(questions)) {
    const answer = value.answers[id]
    if (!record(answer) || answer.type !== question.type) throw failure('invalid-response')
    if (question.type === 'noul') {
      if (!probability(answer.noul)) throw failure('invalid-response')
      answers[id] = { type: 'noul', noul: answer.noul }
      continue
    }
    const keys = question.type === 'choice' ? Object.keys(question.criteria) : question.criteria.map((_, index) => String(index))
    if (!record(answer.probabilities) || !sameKeys(answer.probabilities, keys) || !Object.values(answer.probabilities).every(probability) || !probability(answer.confidence)) throw failure('invalid-response')
    const probabilities: Record<string, number> = Object.fromEntries(Object.entries(answer.probabilities).map(([key, value]) => {
      if (!probability(value)) throw failure('invalid-response')
      return [key, value]
    }))
    if (Math.abs(Object.values(probabilities).reduce((sum, p) => sum + p, 0) - 1) > 0.015) throw failure('invalid-response')
    if (question.type === 'choice') {
      if (typeof answer.choice !== 'string' || !keys.includes(answer.choice) || probabilities[answer.choice]! + 0.001 < Math.max(...Object.values(probabilities))) throw failure('invalid-response')
      answers[id] = { type: 'choice', choice: answer.choice, probabilities, confidence: answer.confidence }
    } else {
      const legend = answer.legend
      if (typeof answer.score !== 'number' || !Number.isFinite(answer.score) || answer.score < 0 || answer.score > keys.length - 1 || !record(legend) || !sameKeys(legend, keys) || !keys.every((key, index) => legend[key] === question.criteria[index])) throw failure('invalid-response')
      const weighted = Object.entries(probabilities).reduce((sum, [key, p]) => sum + Number(key) * p, 0)
      if (Math.abs(weighted - answer.score) > 0.05) throw failure('invalid-response')
      answers[id] = { type: 'score', score: answer.score, probabilities, legend: Object.fromEntries(question.criteria.map((description, index) => [String(index), description])), confidence: answer.confidence }
    }
  }
  return { answers, usage: { inputTokens, outputTokens } }
}

export type JevDecisionOptions = {
  readonly apiKey: () => string | undefined
  readonly fetch?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>
  readonly timeoutMs?: number
  readonly maxConcurrent?: number
  readonly maxRequestsPerMinute?: number
  readonly cacheTtlMs?: number
  readonly maxCacheEntries?: number
  readonly now?: () => number
}

/** One attempt, no generative fallback; durable owners schedule bounded retries.
 * The key is captured by the transport only and never enters snapshots/errors. */
export const makeJevDecisionEvaluator = (options: JevDecisionOptions): DecisionEvaluator => {
  const transport = options.fetch ?? globalThis.fetch
  const now = options.now ?? Date.now
  const timeoutMs = options.timeoutMs ?? 800
  const maxConcurrent = options.maxConcurrent ?? 4
  const rpm = options.maxRequestsPerMinute ?? 300
  const ttl = options.cacheTtlMs ?? 60_000
  const maxEntries = options.maxCacheEntries ?? 256
  if (![timeoutMs, maxConcurrent, rpm, ttl, maxEntries].every(Number.isSafeInteger) || timeoutMs < 1 || timeoutMs > 30_000 || maxConcurrent < 1 || maxConcurrent > 32 || rpm < 1 || rpm > 1200 || ttl < 0 || ttl > 3_600_000 || maxEntries < 0 || maxEntries > 4096) throw failure('invalid-input')
  const cache = new Map<string, DecisionResult>()
  let starts: number[] = []
  let active = 0
  return {
    evaluate: input => Effect.tryPromise({
      try: async signal => {
        const started = now()
        const key = options.apiKey()?.trim()
        if (!key) throw failure('unconfigured')
        const body = validateDecisionInput(input)
        // Freeze the request policy for asynchronous validation; callers may edit drafts.
        const policy = structuredClone(input.policy)
        const snapshotHash = await decisionHash(decisionSnapshotJson({ scope: input.scope, policy, state: input.state }))
        if (signal.aborted) throw failure('timeout')
        const cached = cache.get(snapshotHash)
        if (cached && now() - cached.evaluatedAt <= ttl) return { ...structuredClone(cached), cacheHit: true, elapsedMs: now() - started }
        if (cached) cache.delete(snapshotHash)
        if (active >= maxConcurrent) throw failure('busy')
        starts = starts.filter(at => now() - at < 60_000)
        if (starts.length >= rpm) throw failure('local-rate-limit')
        const remaining = timeoutMs - (now() - started)
        if (remaining <= 0) throw failure('timeout')
        starts.push(now())
        active++
        const controller = new AbortController()
        let responseReader: ReadableStreamDefaultReader<Uint8Array> | undefined
        let rejectInterrupted!: (error: DecisionFailure) => void
        const interrupted = new Promise<never>((_, reject) => { rejectInterrupted = reject })
        const interrupt = () => {
          controller.abort()
          void responseReader?.cancel().catch(() => undefined)
          rejectInterrupted(failure('timeout'))
        }
        signal.addEventListener('abort', interrupt, { once: true })
        let timer: ReturnType<typeof setTimeout> | undefined
        try {
          const decoded = await Promise.race([
            interrupted,
            (async () => {
              const response = await transport('https://api.typesafe.ai/v1/systemone', {
                method: 'POST', redirect: 'manual', signal: controller.signal,
                headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body,
              })
              if (controller.signal.aborted) {
                void response.body?.cancel().catch(() => undefined)
                throw failure('timeout')
              }
              if (!response.ok) {
                await response.body?.cancel()
                throw failure(response.status === 401 || response.status === 403 ? 'unauthorized' : response.status === 429 || response.status === 529 ? 'rate-limit' : 'provider')
              }
              // Bounded response reads also protect against malformed upstreams.
              const reader = response.body?.getReader()
              if (!reader) throw failure('invalid-response')
              responseReader = reader
              const chunks: Uint8Array[] = []
              let size = 0
              try {
                while (true) {
                  const part = await reader.read()
                  if (part.done) break
                  size += part.value.byteLength
                  if (size > 256_000) throw failure('invalid-response')
                  chunks.push(part.value)
                }
              } finally { await reader.cancel().catch(() => undefined) }
              const bytes = new Uint8Array(size)
              let offset = 0
              for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
              let value: unknown
              try { value = JSON.parse(new TextDecoder().decode(bytes)) } catch { throw failure('invalid-response') }
              return decodeDecisionResponse(value, policy.questions)
            })(),
            new Promise<never>((_, reject) => {
              timer = setTimeout(() => { interrupt(); reject(failure('timeout')) }, remaining)
            }),
          ])
          if (signal.aborted || controller.signal.aborted || now() - started >= timeoutMs) throw failure('timeout')
          const result: DecisionResult = {
            model: JEV_MODEL, policyId: policy.id, policyVersion: policy.version,
            snapshotHash, ...decoded, evaluatedAt: now(), elapsedMs: now() - started, cacheHit: false,
          }
          if (ttl > 0 && maxEntries > 0) {
            cache.set(snapshotHash, structuredClone(result))
            while (cache.size > maxEntries) cache.delete(cache.keys().next().value!)
          }
          return result
        } finally {
          if (timer !== undefined) clearTimeout(timer)
          interrupt()
          signal.removeEventListener('abort', interrupt)
          active--
        }
      },
      catch: error => error instanceof DecisionFailure ? error : failure('provider'),
    }),
  }
}
export const makeJevDecisionsLive = (options: JevDecisionOptions) =>
  Layer.succeed(Decisions, makeJevDecisionEvaluator(options))

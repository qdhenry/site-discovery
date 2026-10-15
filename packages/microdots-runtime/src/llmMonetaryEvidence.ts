/** Neutral accounting facts. No credentials, provider clients, or display strings. */
import { Schema as S } from 'effect'

const Decimal = S.String.check(S.isPattern(/^(0|[1-9]\d*)(\.\d{1,10})?$/))
const Count = S.Int.check(S.isGreaterThanOrEqualTo(0))
const Attribution = S.Struct({
  requestId: S.String,
  appId: S.String,
  buildId: S.optionalKey(S.String),
  draftId: S.optionalKey(S.String),
  runId: S.optionalKey(S.String),
  stage: S.optionalKey(S.String),
})
const PriceSource = S.Struct({
  url: S.String,
  version: S.String,
  checkedOn: S.String,
})
const TokenUsage = S.Struct({
  inputTokens: S.NullOr(Count),
  outputTokens: S.NullOr(Count),
  cachedInputTokens: S.NullOr(Count),
  cacheCreationTokens: S.NullOr(Count),
  reasoningTokens: S.NullOr(Count),
})
const common = {
  schemaVersion: S.Literal(1),
  currency: S.Literal('USD'),
  provider: S.Literals([
    'openai',
    'anthropic',
    'xai',
    'ollama-cloud',
    'openrouter',
  ]),
  requestedModel: S.String,
  returnedModel: S.NullOr(S.String),
  responseId: S.NullOr(S.String),
  attribution: Attribution,
  attempt: Count,
  usage: TokenUsage,
  /** Completeness of the input/output/cache categories needed for token estimates. */
  usageCompleteness: S.Literals(['complete', 'partial', 'unavailable']),
}

export const LlmMonetaryEvidence = S.Union([
  S.Struct({
    ...common,
    _tag: S.Literal('ProviderReported'),
    amount: Decimal,
    source: PriceSource,
    rawUsdTicks: S.String.check(S.isPattern(/^(0|[1-9]\d*)$/)),
    coverage: S.Literal('request-tokens-and-server-tools'),
  }),
  S.Struct({
    ...common,
    _tag: S.Literal('Estimated'),
    amount: Decimal,
    source: PriceSource,
    ratesUsdPerMillion: S.Struct({
      input: Decimal,
      cachedInput: Decimal,
      output: Decimal,
    }),
    coverage: S.Literal('text-tokens-only'),
    serviceTier: S.NullOr(S.String),
  }),
  S.Struct({
    ...common,
    _tag: S.Literal('Unavailable'),
    amount: S.Null,
    reason: S.Literals([
      'response-unavailable',
      'model-unobserved',
      'price-unverified',
      'usage-incomplete',
      'usage-invalid',
      'provider-charge-invalid',
      'response-id-unobserved',
      'service-tier-unverified',
      'price-context-exceeded',
      /** A stream was cut before the provider reported its final usage. */
      'stream-cut',
    ]),
  }),
])
export type LlmMonetaryEvidence = typeof LlmMonetaryEvidence.Type

/** Evidence belongs to the enclosing request, not merely to some internally
 * consistent attribution. A bad accounting row must not fail model execution. */
export const ownedLlmMonetaryEvidence = (
  evidence: LlmMonetaryEvidence | undefined,
  expected: {
    readonly provider: string
    readonly model: string
    readonly attribution: typeof Attribution.Type
    readonly returnedModel?: string | null | undefined
    readonly responseId?: string | null | undefined
  },
  attempt: number,
): LlmMonetaryEvidence | undefined => {
  if (
    evidence === undefined ||
    verifiedLlmMonetaryEvidence(evidence) === undefined
  )
    return undefined
  if (
    evidence.provider !== expected.provider ||
    evidence.requestedModel !== expected.model ||
    evidence.attempt !== attempt ||
    (expected.returnedModel != null &&
      evidence.returnedModel !== expected.returnedModel) ||
    (expected.responseId != null && evidence.responseId !== expected.responseId)
  )
    return undefined
  const keys = [
    'appId',
    'requestId',
    'buildId',
    'draftId',
    'runId',
    'stage',
  ] as const
  return keys.every(
    key => evidence.attribution[key] === expected.attribution[key],
  )
    ? evidence
    : undefined
}

/** Frozen evidence, not a live price feed. Match returned IDs exactly; never guess aliases. */
export const LLM_PRICE_SNAPSHOT_VERSION = '2026-09-06.v1'
const priceSnapshot = [
  {
    provider: 'openai',
    model: 'gpt-5.3-codex',
    input: '1.75',
    cachedInput: '0.175',
    output: '14',
    url: 'https://developers.openai.com/api/docs/models/gpt-5.3-codex',
  },
  {
    provider: 'xai',
    model: 'grok-4.6',
    input: '2',
    cachedInput: '0.5',
    output: '6',
    url: 'https://docs.x.ai/developers/models/grok-4.6',
  },
  {
    provider: 'ollama-cloud',
    model: 'gpt-oss:20b',
    input: '0.07',
    cachedInput: '0.035',
    output: '0.30',
    url: 'https://ollama.com/pricing',
  },
] as const

const object = (value: unknown): Record<string, unknown> =>
  !Array.isArray(value) && S.is(S.Record(S.String, S.Unknown))(value)
    ? value
    : {}
const count = (value: unknown): number | null =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value
    : null
const identity = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() !== '' ? value : null
const ticks = (value: unknown): bigint | null => {
  if (typeof value === 'number')
    return count(value) === null ? null : BigInt(value)
  if (typeof value === 'string' && /^(0|[1-9]\d{0,39})$/.test(value))
    return BigInt(value)
  return null
}
const usd = (value: bigint): string => {
  const fraction = (value % 10_000_000_000n)
    .toString()
    .padStart(10, '0')
    .replace(/0+$/, '')
  return `${value / 10_000_000_000n}${fraction ? `.${fraction}` : ''}`
}
/** A provider's decimal USD charge, as ticks of 1e-10 USD, rounded half up at
 * the tenth decimal. A number is read through `toFixed`, which never uses an
 * exponent below 1e21; anything negative, non-finite or malformed is null. */
const decimalTicks = (value: unknown): bigint | null => {
  const source =
    typeof value === 'number'
      ? Number.isFinite(value) && value >= 0 && value < 1e21
        ? value.toFixed(12)
        : null
      : typeof value === 'string'
        ? value
        : null
  if (source === null) return null
  const match = /^(0|[1-9]\d{0,20})(?:\.(\d{1,40}))?$/.exec(source)
  if (!match) return null
  const fraction = (match[2] ?? '').padEnd(11, '0')
  const truncated =
    BigInt(match[1]!) * 10_000_000_000n + BigInt(fraction.slice(0, 10))
  return Number(fraction[10]) >= 5 ? truncated + 1n : truncated
}
const rateTicks = (value: string): bigint => {
  const [whole, fraction = ''] = value.split('.')
  return BigInt(whole!) * 10_000_000_000n + BigInt(fraction.padEnd(10, '0'))
}

/** Read safe metadata before validating model content, so a locally rejected answer
 * can still retain its provider charge. Missing/invalid metadata never breaks an answer. */
export const monetaryEvidenceForResponse = (
  request: {
    readonly provider: LlmMonetaryEvidence['provider']
    readonly model: string
    readonly attribution: typeof Attribution.Type
  },
  value: unknown,
  attempt: number,
  /** The body is what a stream had observed when it was cut, not a final response. */
  cut = false,
): LlmMonetaryEvidence => {
  const body = object(value)
  const rawUsage = object(body.usage)
  const ollama = request.provider === 'ollama-cloud'
  const anthropic = request.provider === 'anthropic'
  const openrouter = request.provider === 'openrouter'
  const inputRaw = ollama
    ? body.prompt_eval_count
    : openrouter
      ? rawUsage.prompt_tokens
      : rawUsage.input_tokens
  const outputRaw = ollama
    ? body.eval_count
    : openrouter
      ? rawUsage.completion_tokens
      : rawUsage.output_tokens
  const cachedRaw = ollama
    ? body.prompt_eval_cached_count
    : anthropic
      ? rawUsage.cache_read_input_tokens
      : openrouter
        ? object(rawUsage.prompt_tokens_details).cached_tokens
        : object(rawUsage.input_tokens_details).cached_tokens
  const creationRaw = anthropic
    ? rawUsage.cache_creation_input_tokens
    : undefined
  const reasoningRaw = object(
    openrouter
      ? rawUsage.completion_tokens_details
      : rawUsage.output_tokens_details,
  ).reasoning_tokens
  const usage = {
    inputTokens: count(inputRaw),
    outputTokens: count(outputRaw),
    cachedInputTokens: count(cachedRaw),
    cacheCreationTokens: count(creationRaw),
    reasoningTokens: count(reasoningRaw),
  }
  // Anthropic reports uncached input separately; normalize to the same total convention.
  if (anthropic && usage.inputTokens !== null) {
    usage.inputTokens = count(
      usage.inputTokens +
        (usage.cachedInputTokens ?? 0) +
        (usage.cacheCreationTokens ?? 0),
    )
  }
  const invalidUsage =
    [inputRaw, outputRaw, cachedRaw, creationRaw, reasoningRaw].some(
      metric => metric != null && count(metric) === null,
    ) ||
    (usage.inputTokens !== null &&
      usage.cachedInputTokens !== null &&
      usage.cachedInputTokens > usage.inputTokens) ||
    (usage.outputTokens !== null &&
      usage.reasoningTokens !== null &&
      usage.reasoningTokens > usage.outputTokens)
  const required = [
    usage.inputTokens,
    usage.outputTokens,
    usage.cachedInputTokens,
  ]
  const base = {
    schemaVersion: 1 as const,
    currency: 'USD' as const,
    provider: request.provider,
    requestedModel: request.model,
    returnedModel: identity(body.model),
    responseId: ollama ? null : identity(body.id),
    attribution: request.attribution,
    attempt,
    usage,
    usageCompleteness:
      !invalidUsage && required.every(metric => metric !== null)
        ? ('complete' as const)
        : required.some(metric => metric !== null)
          ? ('partial' as const)
          : ('unavailable' as const),
  }
  const unavailable = (
    reason: Extract<LlmMonetaryEvidence, { _tag: 'Unavailable' }>['reason'],
  ): LlmMonetaryEvidence => ({
    ...base,
    _tag: 'Unavailable',
    amount: null,
    reason,
  })
  if (cut) return unavailable('stream-cut')
  if (value == null) return unavailable('response-unavailable')
  if (base.returnedModel === null) return unavailable('model-unobserved')
  if (openrouter && rawUsage.cost != null) {
    const charge = decimalTicks(rawUsage.cost)
    if (charge === null) return unavailable('provider-charge-invalid')
    if (base.responseId === null) return unavailable('response-id-unobserved')
    return {
      ...base,
      _tag: 'ProviderReported',
      amount: usd(charge),
      rawUsdTicks: charge.toString(),
      source: {
        url: 'https://openrouter.ai/docs/api/reference/overview',
        version: LLM_PRICE_SNAPSHOT_VERSION,
        checkedOn: '2026-10-07',
      },
      coverage: 'request-tokens-and-server-tools',
    }
  }
  if (request.provider === 'xai' && rawUsage.cost_in_usd_ticks != null) {
    const charge = ticks(rawUsage.cost_in_usd_ticks)
    if (charge === null) return unavailable('provider-charge-invalid')
    if (base.responseId === null) return unavailable('response-id-unobserved')
    return {
      ...base,
      _tag: 'ProviderReported',
      amount: usd(charge),
      rawUsdTicks: charge.toString(),
      source: {
        url: 'https://docs.x.ai/developers/cost-tracking',
        version: LLM_PRICE_SNAPSHOT_VERSION,
        checkedOn: '2026-09-06',
      },
      coverage: 'request-tokens-and-server-tools',
    }
  }
  const price = priceSnapshot.find(
    row =>
      row.provider === request.provider && row.model === base.returnedModel,
  )
  if (!price) return unavailable('price-unverified')
  if (invalidUsage) return unavailable('usage-invalid')
  if (base.usageCompleteness !== 'complete')
    return unavailable('usage-incomplete')
  const serviceTier = identity(body.service_tier)
  if (request.provider === 'openai' && serviceTier !== 'default')
    return unavailable('service-tier-unverified')
  if (request.provider === 'xai') {
    if (serviceTier !== 'default') return unavailable('service-tier-unverified')
    // Conservative context applicability: the published higher-context rates are not pinned.
    if (usage.inputTokens! + usage.outputTokens! > 200_000)
      return unavailable('price-context-exceeded')
  }
  const amountTicks =
    (BigInt(usage.inputTokens! - usage.cachedInputTokens!) *
      rateTicks(price.input) +
      BigInt(usage.cachedInputTokens!) * rateTicks(price.cachedInput) +
      // Output already contains reasoning; adding reasoningTokens here would count it twice.
      BigInt(usage.outputTokens!) * rateTicks(price.output)) /
    1_000_000n
  return {
    ...base,
    _tag: 'Estimated',
    amount: usd(amountTicks),
    source: {
      url: price.url,
      version: LLM_PRICE_SNAPSHOT_VERSION,
      checkedOn: '2026-09-06',
    },
    ratesUsdPerMillion: {
      input: price.input,
      cachedInput: price.cachedInput,
      output: price.output,
    },
    coverage: 'text-tokens-only',
    serviceTier,
  }
}

/** Recompute available amounts from retained neutral facts and this supported
 * price snapshot. A syntactically valid amount is not trustworthy accounting.
 * Unavailable evidence remains honest even when its raw response cannot be
 * reconstructed; its nullable amount cannot enter either priced subtotal. */
export const verifiedLlmMonetaryEvidence = (
  value: unknown,
): LlmMonetaryEvidence | undefined => {
  if (!S.is(LlmMonetaryEvidence)(value)) return undefined
  if (!Number.isSafeInteger(value.attempt) || value.attempt < 1)
    return undefined
  if (
    Object.values(value.usage).some(
      metric => metric !== null && count(metric) === null,
    )
  )
    return undefined
  if (value._tag === 'Unavailable') return value
  const usage = value.usage
  const body =
    value.provider === 'ollama-cloud'
      ? {
          model: value.returnedModel,
          prompt_eval_count: usage.inputTokens,
          prompt_eval_cached_count: usage.cachedInputTokens,
          eval_count: usage.outputTokens,
        }
      : value.provider === 'openrouter'
        ? {
            id: value.responseId,
            model: value.returnedModel,
            usage: {
              prompt_tokens: usage.inputTokens,
              completion_tokens: usage.outputTokens,
              prompt_tokens_details: { cached_tokens: usage.cachedInputTokens },
              completion_tokens_details: {
                reasoning_tokens: usage.reasoningTokens,
              },
              ...(value._tag === 'ProviderReported'
                ? { cost: value.amount }
                : {}),
            },
          }
        : {
            id: value.responseId,
            model: value.returnedModel,
            service_tier:
              value._tag === 'Estimated' ? value.serviceTier : undefined,
            usage: {
              input_tokens: usage.inputTokens,
              output_tokens: usage.outputTokens,
              input_tokens_details: { cached_tokens: usage.cachedInputTokens },
              output_tokens_details: {
                reasoning_tokens: usage.reasoningTokens,
              },
              ...(value._tag === 'ProviderReported'
                ? { cost_in_usd_ticks: value.rawUsdTicks }
                : {}),
            },
          }
  const computed = monetaryEvidenceForResponse(
    {
      provider: value.provider,
      model: value.requestedModel,
      attribution: value.attribution,
    },
    body,
    value.attempt,
  )
  const completenessRank = { unavailable: 0, partial: 1, complete: 2 }
  if (
    computed._tag === 'Unavailable' ||
    computed._tag !== value._tag ||
    computed.amount !== value.amount ||
    // Normalization loses whether a null metric was absent or malformed.
    // An independent provider charge survives conservative token completeness.
    (value._tag === 'Estimated'
      ? computed.usageCompleteness !== value.usageCompleteness
      : completenessRank[value.usageCompleteness] >
        completenessRank[computed.usageCompleteness]) ||
    computed.responseId !== value.responseId ||
    computed.returnedModel !== value.returnedModel ||
    computed.usage.inputTokens !== usage.inputTokens ||
    computed.usage.outputTokens !== usage.outputTokens ||
    computed.usage.cachedInputTokens !== usage.cachedInputTokens ||
    computed.usage.cacheCreationTokens !== usage.cacheCreationTokens ||
    computed.usage.reasoningTokens !== usage.reasoningTokens ||
    computed.source.url !== value.source.url ||
    computed.source.version !== value.source.version ||
    computed.source.checkedOn !== value.source.checkedOn ||
    computed.coverage !== value.coverage
  )
    return undefined
  if (
    value._tag === 'Estimated' &&
    computed._tag === 'Estimated' &&
    (computed.ratesUsdPerMillion.input !== value.ratesUsdPerMillion.input ||
      computed.ratesUsdPerMillion.cachedInput !==
        value.ratesUsdPerMillion.cachedInput ||
      computed.ratesUsdPerMillion.output !== value.ratesUsdPerMillion.output)
  )
    return undefined
  return value
}

export const LlmMonetarySummary = S.Struct({
  schemaVersion: S.Literal(1),
  currency: S.Literal('USD'),
  complete: S.Boolean,
  observations: Count,
  providerReported: Count,
  estimated: Count,
  unavailable: Count,
  /** Separate subtotals; neither is the full cost when complete is false. */
  providerReportedSubtotal: Decimal,
  estimatedSubtotal: Decimal,
  reasons: S.Array(
    S.Literals([
      'missing-evidence',
      'unavailable-amount',
      'conflicting-identity',
    ]),
  ),
})
export type LlmMonetarySummary = typeof LlmMonetarySummary.Type

/** Pass the complete attempt inventory, including undefined historical observations.
 * Duplicate receipt projections are counted once; conflicting owner/amount rows fail closed. */
export const aggregateLlmMonetaryEvidence = (
  observations: ReadonlyArray<LlmMonetaryEvidence | undefined>,
): LlmMonetarySummary => {
  const seen = new Map<string, string>()
  const responses = new Map<string, string>()
  const reasons = new Set<LlmMonetarySummary['reasons'][number]>()
  let providerReported = 0,
    estimated = 0,
    unavailable = 0
  let reportedTicks = 0n,
    estimatedTicks = 0n
  for (const evidence of observations) {
    if (!evidence) {
      unavailable++
      reasons.add('missing-evidence')
      continue
    }
    const key = JSON.stringify([
      evidence.provider,
      evidence.attribution.appId,
      evidence.attribution.requestId,
      evidence.attempt,
    ])
    const fingerprint = JSON.stringify(evidence)
    const prior = seen.get(key)
    if (prior !== undefined) {
      if (prior !== fingerprint) reasons.add('conflicting-identity')
      continue
    }
    seen.set(key, fingerprint)
    if (evidence.responseId !== null) {
      const responseKey = JSON.stringify([
        evidence.provider,
        evidence.responseId,
      ])
      if (responses.has(responseKey)) {
        reasons.add('conflicting-identity')
        continue
      }
      responses.set(responseKey, key)
    }
    if (evidence._tag === 'Unavailable') {
      unavailable++
      reasons.add('unavailable-amount')
    } else if (evidence._tag === 'ProviderReported') {
      providerReported++
      reportedTicks += rateTicks(evidence.amount)
    } else {
      estimated++
      estimatedTicks += rateTicks(evidence.amount)
    }
  }
  return {
    schemaVersion: 1,
    currency: 'USD',
    complete: reasons.size === 0,
    observations: providerReported + estimated + unavailable,
    providerReported,
    estimated,
    unavailable,
    providerReportedSubtotal: usd(reportedTicks),
    estimatedSubtotal: usd(estimatedTicks),
    reasons: [...reasons],
  }
}

/** Callers must supply disjoint invocation/round summaries, never both trace
 * projections and their authoritative receipts. Historical summaries stay unknown. */
export const combineLlmMonetarySummaries = (
  summaries: ReadonlyArray<LlmMonetarySummary | undefined>,
): LlmMonetarySummary => {
  const known = summaries.map(
    summary => summary ?? aggregateLlmMonetaryEvidence([undefined]),
  )
  return {
    schemaVersion: 1,
    currency: 'USD',
    complete: known.every(summary => summary.complete),
    observations: known.reduce((sum, summary) => sum + summary.observations, 0),
    providerReported: known.reduce(
      (sum, summary) => sum + summary.providerReported,
      0,
    ),
    estimated: known.reduce((sum, summary) => sum + summary.estimated, 0),
    unavailable: known.reduce((sum, summary) => sum + summary.unavailable, 0),
    providerReportedSubtotal: usd(
      known.reduce(
        (sum, summary) => sum + rateTicks(summary.providerReportedSubtotal),
        0n,
      ),
    ),
    estimatedSubtotal: usd(
      known.reduce(
        (sum, summary) => sum + rateTicks(summary.estimatedSubtotal),
        0n,
      ),
    ),
    reasons: [...new Set(known.flatMap(summary => summary.reasons))],
  }
}

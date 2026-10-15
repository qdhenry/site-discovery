/** Server-only model execution. Import /llm from a service, never a widget. */
import {
  Context,
  Effect,
  Exit,
  Layer,
  Redacted,
  Schema as S,
  Stream,
} from 'effect'
import {
  AiError,
  type Response as AiResponse,
  LanguageModel,
  Prompt,
  Tool,
} from 'effect/unstable/ai'
import { toCodecAnthropic } from 'effect/unstable/ai/AnthropicStructuredOutput'
import { toCodecOpenAI } from 'effect/unstable/ai/OpenAiStructuredOutput'

import { LlmInputEvidence, observeLlmInputBody } from './llmInputEvidence.ts'
import {
  LlmMonetaryEvidence,
  monetaryEvidenceForResponse,
} from './llmMonetaryEvidence.ts'
import {
  type WireEvent,
  type WireFrame,
  WireMalformed,
  type WireReader,
  framerFor,
  wireReaderFor,
} from './llmStreamWire.ts'

export {
  LlmInputEvidence,
  summarizeLlmInputEvidence,
} from './llmInputEvidence.ts'
export {
  LlmMonetaryEvidence,
  LlmMonetarySummary,
  aggregateLlmMonetaryEvidence,
  combineLlmMonetarySummaries,
  monetaryEvidenceForResponse,
  ownedLlmMonetaryEvidence,
  verifiedLlmMonetaryEvidence,
} from './llmMonetaryEvidence.ts'

export type LlmReasoningEffort = 'low' | 'medium' | 'high' | 'xhigh'
export type LlmProvider =
  'openai' | 'anthropic' | 'xai' | 'ollama-cloud' | 'openrouter'
export type LlmModel = {
  readonly provider: LlmProvider
  readonly model: string
}
export type LlmAttribution = {
  readonly requestId: string
  readonly appId: string
  readonly buildId?: string
  readonly draftId?: string
  readonly runId?: string
  readonly stage?: string
}
export type LlmFailureKind =
  | 'invalid-request'
  | 'missing-credential'
  | 'unauthorized'
  | 'unsupported'
  | 'rate-limited'
  | 'provider-unavailable'
  | 'timed-out'
  | 'cancelled'
  | 'invalid-output'
  | 'implementation-defect'

const LlmLocalCleanup = S.Struct({
  status: S.Literals(['completed', 'incomplete']),
  elapsedMs: S.Finite,
  pendingOperations: S.Finite,
  failedOperations: S.Finite,
})
export type LlmLocalCleanup = typeof LlmLocalCleanup.Type

const ProviderSchema = S.Literals([
  'openai',
  'anthropic',
  'xai',
  'ollama-cloud',
  'openrouter',
])
const AttributionSchema = S.Struct({
  requestId: S.String,
  appId: S.String,
  buildId: S.optionalKey(S.String),
  draftId: S.optionalKey(S.String),
  runId: S.optionalKey(S.String),
  stage: S.optionalKey(S.String),
})
const AttemptSchema = S.Struct({
  attempt: S.Finite,
  elapsedMs: S.Finite,
  outcome: S.String,
  usage: S.Literals(['reported', 'unavailable']),
  monetary: S.optionalKey(LlmMonetaryEvidence),
  providerRequestId: S.optionalKey(S.NullOr(S.String)),
  inputEvidence: S.optionalKey(LlmInputEvidence),
})

/**
 * Everything a stream delivered before it was cut: by the caller's signal, a
 * deadline, or a provider or transport failure. Usage holds only what the
 * provider had reported by then; unreported metrics stay null.
 */
export const LlmPartialReceipt = S.Struct({
  requested: S.Struct({ provider: ProviderSchema, model: S.String }),
  returnedModel: S.NullOr(S.String),
  responseId: S.NullOr(S.String),
  attribution: AttributionSchema,
  /** Every text delta yielded, joined. */
  text: S.String,
  /** Completed calls only; a call still arriving when the stream was cut is absent. */
  toolCalls: S.Array(
    S.Struct({ id: S.String, name: S.String, arguments: S.Unknown }),
  ),
  usage: S.Struct({
    inputTokens: S.NullOr(S.Finite),
    outputTokens: S.NullOr(S.Finite),
    cachedInputTokens: S.NullOr(S.Finite),
    cacheCreationTokens: S.NullOr(S.Finite),
    costUsd: S.Null,
    monetary: S.optionalKey(LlmMonetaryEvidence),
    reasoningTokens: S.optionalKey(S.NullOr(S.Finite)),
    completeness: S.Literal('partial'),
  }),
  attempts: S.Array(AttemptSchema),
  elapsedMs: S.Finite,
})
export type LlmPartialReceipt = typeof LlmPartialReceipt.Type

/** Contains only classified, safe metadata. Never retains a raw HTTP/SDK cause. */
export class LlmFailure extends S.TaggedError<LlmFailure>()('LlmFailure', {
  kind: S.Literals([
    'invalid-request',
    'missing-credential',
    'unauthorized',
    'unsupported',
    'rate-limited',
    'provider-unavailable',
    'timed-out',
    'cancelled',
    'invalid-output',
    'implementation-defect',
  ]),
  provider: ProviderSchema,
  message: S.String,
  retryable: S.Boolean,
  attempt: S.Finite,
  model: S.String,
  attribution: S.optionalKey(AttributionSchema),
  attempts: S.optionalKey(S.Array(AttemptSchema)),
  elapsedMs: S.optionalKey(S.Finite),
  httpStatus: S.optionalKey(S.Finite),
  retryAfterMs: S.optionalKey(S.Finite),
  localCleanup: S.optionalKey(LlmLocalCleanup),
  /** A stream that had yielded anything before failing: what it delivered. */
  partial: S.optionalKey(LlmPartialReceipt),
}) {}

export type LlmTool = {
  readonly name: string
  readonly description: string
  readonly parameters: Record<string, unknown>
}
export type LlmToolCall = {
  readonly id: string
  readonly name: string
  readonly arguments: unknown
}
/** Opaque, service-side provider conversation state; send only the new prompt on resume. */
export type LlmContinuation = {
  readonly provider: 'openai' | 'xai' | 'ollama-cloud' | 'openrouter'
  readonly model: string
  readonly items: ReadonlyArray<Record<string, unknown>>
}
export type LlmToolChoice = 'auto' | 'required' | { readonly name: string }
export type LlmRequest = LlmModel & {
  readonly attribution: LlmAttribution
  readonly prompt: Prompt.Prompt
  readonly maxOutputTokens: number
  /** Explicitly supported for xAI grok-4.6 only; other profiles fail closed. */
  readonly reasoningEffort?: LlmReasoningEffort
  /** Includes all attempts, response reading and backoff. */
  readonly timeoutMs: number
  /** Streams only: fail as timed-out when the provider sends nothing for this long. */
  readonly idleTimeoutMs?: number
  /** OpenRouter only: route to providers that retain no data. Others refuse it. */
  readonly routing?: { readonly zeroDataRetention: boolean }
  readonly maxAttempts?: number
  readonly retryDelayMs?: number
  readonly signal?: AbortSignal
  readonly continuation?: LlmContinuation
  readonly tools?: ReadonlyArray<LlmTool>
  readonly toolChoice?: LlmToolChoice
  /** Strict provider enforcement; unsupported schemas remain typed provider failures. */
  readonly output?: {
    readonly name: string
    readonly schema: Record<string, unknown>
  }
}
export type LlmUsage = {
  /** Null means the provider did not report the metric. */
  readonly inputTokens: number | null
  readonly outputTokens: number | null
  readonly cachedInputTokens: number | null
  readonly cacheCreationTokens: number | null
  readonly costUsd: null
  /** Final response only. Use attempts to include earlier failed HTTP requests. */
  readonly monetary?: LlmMonetaryEvidence
  readonly reasoningTokens?: number | null
  /** Set by a stream: `partial` when it was cut before the final usage arrived. */
  readonly completeness?: 'complete' | 'partial'
}
export type LlmAttempt = {
  /** Actual client request body at fetch handoff; absent means unobserved. */
  readonly inputEvidence?: LlmInputEvidence
  readonly attempt: number
  readonly elapsedMs: number
  readonly outcome: 'completed' | LlmFailureKind
  readonly usage: 'reported' | 'unavailable'
  readonly monetary?: LlmMonetaryEvidence
  /** Provider's HTTP request identity, including rejected requests without a response ID. */
  readonly providerRequestId?: string | null
}
export type LlmResult = {
  readonly requested: LlmModel
  readonly returnedModel: string
  readonly responseId: string | null
  readonly continuation?: LlmContinuation
  readonly attribution: LlmAttribution
  readonly text: string
  readonly toolCalls: ReadonlyArray<LlmToolCall>
  readonly finishReason: 'stop' | 'tool-calls' | 'length'
  readonly usage: LlmUsage
  readonly attempts: ReadonlyArray<LlmAttempt>
  readonly elapsedMs: number
  readonly localCleanup?: LlmLocalCleanup
}
/**
 * One step of `ModelExecution.stream`. A stream ends with exactly one `finish` or
 * `stopped`, or fails with an `LlmFailure`.
 */
export type LlmStreamEvent =
  | { readonly _tag: 'text-delta'; readonly text: string }
  /** A complete call, yielded as soon as its arguments have all arrived. */
  | { readonly _tag: 'tool-call'; readonly call: LlmToolCall }
  /** The provider finished. Equal to what `execute` returns for the same response. */
  | { readonly _tag: 'finish'; readonly result: LlmResult }
  /** The request's `signal` fired. Not a failure: the receipt is what arrived. */
  | { readonly _tag: 'stopped'; readonly receipt: LlmPartialReceipt }
export type LlmCompatibility = {
  readonly compatible: boolean
  readonly issues: ReadonlyArray<{
    readonly feature: string
    readonly action: string
  }>
}
export type LlmConfig = {
  readonly credentials: Partial<Record<LlmProvider, Redacted.Redacted<string>>>
  /** Injectable transport for tests; endpoints are fixed to official providers. */
  readonly fetch?: (
    url: string,
    init: RequestInit,
  ) => Promise<globalThis.Response>
}
export const llmConfigFrom = (env: {
  readonly OPENAI_API_KEY?: string | undefined
  readonly ANTHROPIC_API_KEY?: string | undefined
  readonly XAI_API_KEY?: string | undefined
  readonly OLLAMA_API_KEY?: string | undefined
  readonly OPENROUTER_API_KEY?: string | undefined
}): LlmConfig => {
  const credentials: Partial<Record<LlmProvider, Redacted.Redacted<string>>> =
    {}
  for (const [provider, key] of [
    ['openai', env.OPENAI_API_KEY],
    ['anthropic', env.ANTHROPIC_API_KEY],
    ['xai', env.XAI_API_KEY],
    ['ollama-cloud', env.OLLAMA_API_KEY],
    ['openrouter', env.OPENROUTER_API_KEY],
  ] as const) {
    if (key?.trim()) credentials[provider] = Redacted.make(key.trim())
  }
  return { credentials }
}

const endpoints: Record<LlmProvider, string> = {
  openai: 'https://api.openai.com/v1/responses',
  anthropic: 'https://api.anthropic.com/v1/messages',
  xai: 'https://api.x.ai/v1/responses',
  'ollama-cloud': 'https://ollama.com/api/chat',
  openrouter: 'https://openrouter.ai/api/v1/chat/completions',
}
// Exact documented/testable profiles. Unlisted models still permit plain text;
// features requiring model-specific support fail closed until a profile is added.
const toolModels: Record<LlmProvider, ReadonlyArray<string>> = {
  openai: [
    'gpt-5.3-codex',
    'gpt-5.6-sol',
    'gpt-5.6-terra',
    'gpt-5.6-luna',
    'gpt-6-astra',
  ],
  anthropic: [
    'claude-haiku-4-5-20251001',
    'claude-sonnet-4-6',
    'claude-opus-4-6',
  ],
  xai: ['grok-4.6'],
  'ollama-cloud': ['gpt-oss:120b', 'gpt-oss:20b'],
  // The whirl port's tier defaults. Each must pass its live proof before the
  // streaming plan is done (wiki/plans/active/runtime-llm-openrouter-and-streaming.md).
  openrouter: ['openai/gpt-5.4-nano', 'moonshotai/kimi-k2.6', 'x-ai/grok-4.5'],
}

const strictOutputModels: Record<LlmProvider, ReadonlyArray<string>> = {
  openai: [
    'gpt-5.3-codex',
    'gpt-5.6-sol',
    'gpt-5.6-terra',
    'gpt-5.6-luna',
    'gpt-6-astra',
  ],
  anthropic: [
    'claude-haiku-4-5-20251001',
    'claude-sonnet-4-6',
    'claude-opus-4-6',
  ],
  xai: ['grok-4.6'],
  'ollama-cloud': [],
  openrouter: [],
}

export const assessLlmRequest = (
  input: Pick<
    LlmRequest,
    | 'provider'
    | 'model'
    | 'tools'
    | 'toolChoice'
    | 'output'
    | 'reasoningEffort'
    | 'routing'
  > & {
    readonly streaming?: boolean
    readonly confirmedCancellation?: boolean
  },
): LlmCompatibility => {
  const issues: Array<{ feature: string; action: string }> = []
  const known = toolModels[input.provider].includes(input.model)
  if (
    input.reasoningEffort !== undefined &&
    (input.provider !== 'xai' ||
      input.model !== 'grok-4.6' ||
      !['low', 'medium', 'high', 'xhigh'].includes(input.reasoningEffort))
  )
    issues.push({
      feature: 'reasoning-effort',
      action: 'Explicit reasoning effort is implemented for xAI grok-4.6 only.',
    })
  if (input.routing !== undefined && input.provider !== 'openrouter')
    issues.push({
      feature: 'routing',
      action:
        'Zero-data-retention routing is an OpenRouter request option; no other provider accepts it.',
    })
  if (input.confirmedCancellation)
    issues.push({
      feature: 'cancellation',
      action:
        'This HTTP adapter aborts transport; it cannot confirm that remote billing or generation stopped.',
    })
  if ((input.tools?.length ?? 0) > 0 && !known)
    issues.push({
      feature: 'tools',
      action: 'Select a model with an explicit tool-capability profile.',
    })
  if (input.output && !strictOutputModels[input.provider].includes(input.model))
    issues.push({
      feature: 'structured-output',
      action:
        input.provider === 'ollama-cloud'
          ? 'Ollama Cloud does not support strict structured output. Choose a supported provider or explicitly use prompt-guided JSON with caller-owned validation.'
          : 'Select a model with an explicit strict-output profile.',
    })
  if (
    input.provider === 'ollama-cloud' &&
    input.toolChoice &&
    input.toolChoice !== 'auto'
  )
    issues.push({
      feature: 'tool-choice',
      action: 'This Ollama Cloud adapter supports automatic tool choice only.',
    })
  return { compatible: issues.length === 0, issues }
}

const fail = (
  input: LlmModel & { readonly attribution?: LlmAttribution },
  kind: LlmFailureKind,
  message: string,
  attempt = 0,
  extra: {
    readonly retryable?: boolean
    readonly httpStatus?: number
    readonly retryAfterMs?: number
  } = {},
): LlmFailure =>
  new LlmFailure({
    provider: input.provider,
    model: input.model,
    ...(input.attribution ? { attribution: input.attribution } : {}),
    kind,
    message,
    attempt,
    retryable: extra.retryable ?? false,
    ...(extra.httpStatus === undefined ? {} : { httpStatus: extra.httpStatus }),
    ...(extra.retryAfterMs === undefined
      ? {}
      : { retryAfterMs: extra.retryAfterMs }),
  })

const promptMessages = (input: LlmRequest): Array<Record<string, unknown>> => {
  const messages: Array<Record<string, unknown>> = []
  for (const message of input.prompt.content) {
    if (message.role === 'system') {
      messages.push({ role: 'system', content: message.content })
      continue
    }
    const content: Array<Record<string, unknown>> = []
    const calls: Array<Record<string, unknown>> = []
    for (const part of message.content) {
      if (part.type === 'text') content.push({ type: 'text', text: part.text })
      else if (part.type === 'tool-call') {
        if (input.provider === 'anthropic')
          content.push({
            type: 'tool_use',
            id: part.id,
            name: part.name,
            input: part.params,
          })
        else
          calls.push({
            id: part.id,
            type: 'function',
            function: {
              name: part.name,
              // Chat Completions carries arguments as a JSON string.
              arguments:
                input.provider === 'openrouter'
                  ? JSON.stringify(part.params)
                  : part.params,
            },
          })
      } else if (part.type === 'tool-result') {
        if (input.provider === 'anthropic')
          content.push({
            type: 'tool_result',
            tool_use_id: part.id,
            content: JSON.stringify(part.result),
            is_error: part.isFailure,
          })
        else
          messages.push({
            role: 'tool',
            tool_call_id: part.id,
            ...(input.provider === 'openrouter'
              ? {}
              : { tool_name: part.name }),
            content: JSON.stringify(part.result),
          })
      } else {
        throw fail(
          input,
          'unsupported',
          `Prompt part ${part.type} is not supported by this adapter.`,
        )
      }
    }
    if (input.provider === 'anthropic') {
      if (content.length > 0)
        messages.push({
          role: message.role === 'assistant' ? 'assistant' : 'user',
          content,
        })
    } else if (content.length > 0 || calls.length > 0) {
      messages.push({
        role: message.role,
        content: content.map(part => part['text']).join(''),
        ...(calls.length ? { tool_calls: calls } : {}),
      })
    }
  }
  return messages
}

const requestBody = (
  input: LlmRequest,
  stream = false,
): Record<string, unknown> => {
  const messages = promptMessages(input)
  const tools = input.tools ?? []
  if (input.provider === 'anthropic')
    return {
      model: input.model,
      max_tokens: input.maxOutputTokens,
      stream,
      system: messages
        .filter(message => message['role'] === 'system')
        .map(message => message['content'])
        .join('\n\n'),
      messages: messages.filter(message => message['role'] !== 'system'),
      ...(tools.length
        ? {
            tools: tools.map(tool => ({
              name: tool.name,
              description: tool.description,
              input_schema: tool.parameters,
            })),
          }
        : {}),
      ...(input.toolChoice
        ? {
            tool_choice:
              input.toolChoice === 'auto'
                ? { type: 'auto' }
                : input.toolChoice === 'required'
                  ? { type: 'any' }
                  : { type: 'tool', name: input.toolChoice.name },
          }
        : {}),
      ...(input.output
        ? {
            output_config: {
              format: { type: 'json_schema', schema: input.output.schema },
            },
          }
        : {}),
    }
  if (input.provider === 'openrouter')
    return {
      model: input.model,
      messages: [...(input.continuation?.items ?? []), ...messages],
      max_tokens: input.maxOutputTokens,
      stream,
      ...(tools.length
        ? {
            tools: tools.map(tool => ({
              type: 'function',
              function: {
                name: tool.name,
                description: tool.description,
                parameters: tool.parameters,
              },
            })),
            // One call per step, as the whirl port runs its tools.
            parallel_tool_calls: false,
          }
        : {}),
      ...(input.toolChoice
        ? {
            tool_choice:
              typeof input.toolChoice === 'string'
                ? input.toolChoice
                : {
                    type: 'function',
                    function: { name: input.toolChoice.name },
                  },
          }
        : {}),
      ...(input.routing?.zeroDataRetention ? { provider: { zdr: true } } : {}),
    }
  if (input.provider === 'ollama-cloud')
    return {
      model: input.model,
      messages: [...(input.continuation?.items ?? []), ...messages],
      stream,
      options: { num_predict: input.maxOutputTokens },
      ...(tools.length
        ? { tools: tools.map(tool => ({ type: 'function', function: tool })) }
        : {}),
    }
  const responseInput: Array<Record<string, unknown>> = [
    ...(input.continuation?.items ?? []),
  ]
  for (const message of input.prompt.content) {
    if (message.role === 'system') {
      responseInput.push({ role: 'system', content: message.content })
      continue
    }
    for (const part of message.content) {
      if (part.type === 'text')
        responseInput.push({ role: message.role, content: part.text })
      else if (part.type === 'tool-call')
        responseInput.push({
          type: 'function_call',
          call_id: part.id,
          name: part.name,
          arguments: JSON.stringify(part.params),
        })
      else if (part.type === 'tool-result')
        responseInput.push({
          type: 'function_call_output',
          call_id: part.id,
          output: JSON.stringify(part.result),
        })
    }
  }
  return {
    model: input.model,
    input: responseInput,
    ...(input.provider === 'openai'
      ? { include: ['reasoning.encrypted_content'] }
      : {}),
    max_output_tokens: input.maxOutputTokens,
    ...(input.reasoningEffort === undefined
      ? {}
      : { reasoning: { effort: input.reasoningEffort } }),
    stream,
    store: false,
    ...(tools.length
      ? {
          tools: tools.map(tool => ({
            type: 'function',
            ...tool,
            strict: false,
          })),
        }
      : {}),
    ...(input.toolChoice
      ? {
          tool_choice:
            typeof input.toolChoice === 'string'
              ? input.toolChoice
              : { type: 'function', name: input.toolChoice.name },
        }
      : {}),
    ...(input.output
      ? {
          text: {
            format: {
              type: 'json_schema',
              name: input.output.name,
              schema: input.output.schema,
              strict: true,
            },
          },
        }
      : {}),
  }
}

const Count = S.Finite.check(S.isGreaterThanOrEqualTo(0))
const OpenAiEnvelope = S.Struct({
  id: S.String,
  model: S.String,
  status: S.String,
  incomplete_details: S.optionalKey(S.NullOr(S.Struct({ reason: S.String }))),
  output: S.Array(
    S.Struct({
      type: S.String,
      call_id: S.optionalKey(S.String),
      name: S.optionalKey(S.String),
      arguments: S.optionalKey(S.String),
      content: S.optionalKey(
        S.Array(S.Struct({ type: S.String, text: S.optionalKey(S.String) })),
      ),
    }),
  ),
  usage: S.optionalKey(
    S.NullOr(
      S.Struct({
        input_tokens: Count,
        output_tokens: Count,
        output_tokens_details: S.optionalKey(
          S.Struct({ reasoning_tokens: S.optionalKey(Count) }),
        ),
        input_tokens_details: S.optionalKey(
          S.Struct({ cached_tokens: S.optionalKey(Count) }),
        ),
      }),
    ),
  ),
})
const AnthropicEnvelope = S.Struct({
  id: S.String,
  model: S.String,
  stop_reason: S.String,
  content: S.Array(
    S.Struct({
      type: S.String,
      text: S.optionalKey(S.String),
      id: S.optionalKey(S.String),
      name: S.optionalKey(S.String),
      input: S.optionalKey(S.Unknown),
    }),
  ),
  usage: S.Struct({
    input_tokens: Count,
    output_tokens: Count,
    cache_read_input_tokens: S.optionalKey(Count),
    cache_creation_input_tokens: S.optionalKey(Count),
  }),
})
const OllamaEnvelope = S.Struct({
  model: S.String,
  done: S.Literal(true),
  done_reason: S.optionalKey(S.String),
  message: S.Struct({
    content: S.String,
    tool_calls: S.optionalKey(
      S.Array(
        S.Struct({
          id: S.optionalKey(S.String),
          function: S.Struct({ name: S.String, arguments: S.Unknown }),
        }),
      ),
    ),
  }),
  prompt_eval_count: S.optionalKey(Count),
  eval_count: S.optionalKey(Count),
  prompt_eval_cached_count: S.optionalKey(Count),
})

const OpenRouterEnvelope = S.Struct({
  id: S.String,
  model: S.String,
  choices: S.Array(
    S.Struct({
      finish_reason: S.NullOr(S.String),
      message: S.Struct({
        content: S.optionalKey(S.NullOr(S.String)),
        tool_calls: S.optionalKey(
          S.Array(
            S.Struct({
              id: S.optionalKey(S.String),
              function: S.Struct({ name: S.String, arguments: S.String }),
            }),
          ),
        ),
      }),
    }),
  ),
  usage: S.optionalKey(
    S.NullOr(
      S.Struct({
        prompt_tokens: Count,
        completion_tokens: Count,
        prompt_tokens_details: S.optionalKey(
          S.NullOr(S.Struct({ cached_tokens: S.optionalKey(Count) })),
        ),
        completion_tokens_details: S.optionalKey(
          S.NullOr(S.Struct({ reasoning_tokens: S.optionalKey(Count) })),
        ),
      }),
    ),
  ),
})

type DecodedResult = Omit<
  LlmResult,
  'requested' | 'attribution' | 'attempts' | 'elapsedMs'
>
const decodeResponse = (input: LlmRequest, value: unknown): DecodedResult => {
  const emptyUsage: LlmUsage = {
    inputTokens: null,
    outputTokens: null,
    cachedInputTokens: null,
    cacheCreationTokens: null,
    costUsd: null,
  }
  let result: DecodedResult
  if (input.provider === 'anthropic') {
    const body = S.decodeUnknownSync(AnthropicEnvelope)(value)
    const toolCalls = body.content
      .filter(part => part.type === 'tool_use')
      .map(part => {
        if (!part.id || !part.name || part.input === undefined)
          throw fail(
            input,
            'invalid-output',
            'Provider returned an incomplete tool call.',
          )
        return { id: part.id, name: part.name, arguments: part.input }
      })
    if (
      !['end_turn', 'tool_use', 'max_tokens', 'stop_sequence'].includes(
        body.stop_reason,
      )
    )
      throw fail(
        input,
        'invalid-output',
        'Provider did not return a supported successful finish reason.',
      )
    result = {
      returnedModel: body.model,
      responseId: body.id,
      text: body.content
        .filter(part => part.type === 'text')
        .map(part => part.text ?? '')
        .join(''),
      toolCalls,
      finishReason:
        body.stop_reason === 'max_tokens'
          ? 'length'
          : toolCalls.length
            ? 'tool-calls'
            : 'stop',
      usage: {
        ...emptyUsage,
        inputTokens:
          body.usage.input_tokens +
          (body.usage.cache_read_input_tokens ?? 0) +
          (body.usage.cache_creation_input_tokens ?? 0),
        outputTokens: body.usage.output_tokens,
        cachedInputTokens: body.usage.cache_read_input_tokens ?? null,
        cacheCreationTokens: body.usage.cache_creation_input_tokens ?? null,
      },
    }
  } else if (input.provider === 'openrouter') {
    const body = S.decodeUnknownSync(OpenRouterEnvelope)(value)
    const choice = body.choices[0]
    if (
      !choice ||
      !['stop', 'tool_calls', 'length'].includes(choice.finish_reason ?? '')
    )
      throw fail(
        input,
        'invalid-output',
        'Provider did not return a supported successful finish reason.',
      )
    const toolCalls = (choice.message.tool_calls ?? []).map((call, index) => ({
      id: call.id ?? `${input.attribution.requestId}:tool:${index}`,
      name: call.function.name,
      arguments: ((): unknown => {
        const source = call.function.arguments
        if (source.trim() === '') return {}
        const parsed: unknown = JSON.parse(source)
        return parsed
      })(),
    }))
    const returned = S.decodeUnknownSync(
      S.Struct({
        choices: S.NonEmptyArray(
          S.Struct({ message: S.Record(S.String, S.Unknown) }),
        ),
      }),
    )(value).choices[0].message
    result = {
      returnedModel: body.model,
      responseId: body.id,
      continuation: {
        provider: input.provider,
        model: input.model,
        items: [
          ...S.decodeUnknownSync(S.Array(S.Record(S.String, S.Unknown)))(
            requestBody(input)['messages'],
          ),
          returned,
        ],
      },
      text: choice.message.content ?? '',
      toolCalls,
      finishReason:
        choice.finish_reason === 'length'
          ? 'length'
          : toolCalls.length
            ? 'tool-calls'
            : 'stop',
      usage: {
        ...emptyUsage,
        inputTokens: body.usage?.prompt_tokens ?? null,
        outputTokens: body.usage?.completion_tokens ?? null,
        reasoningTokens:
          body.usage?.completion_tokens_details?.reasoning_tokens ?? null,
        cachedInputTokens:
          body.usage?.prompt_tokens_details?.cached_tokens ?? null,
      },
    }
  } else if (input.provider === 'ollama-cloud') {
    const body = S.decodeUnknownSync(OllamaEnvelope)(value)
    if (
      body.done_reason !== undefined &&
      body.done_reason !== 'stop' &&
      body.done_reason !== 'length'
    )
      throw fail(
        input,
        'invalid-output',
        'Provider did not return a supported successful finish reason.',
      )
    const toolCalls = (body.message.tool_calls ?? []).map((call, index) => ({
      id: call.id ?? `${input.attribution.requestId}:tool:${index}`,
      name: call.function.name,
      arguments: call.function.arguments,
    }))
    result = {
      returnedModel: body.model,
      responseId: null,
      continuation: {
        provider: input.provider,
        model: input.model,
        items: [
          ...S.decodeUnknownSync(S.Array(S.Record(S.String, S.Unknown)))(
            requestBody(input)['messages'],
          ),
          S.decodeUnknownSync(
            S.Struct({ message: S.Record(S.String, S.Unknown) }),
          )(value).message,
        ],
      },
      text: body.message.content,
      toolCalls,
      finishReason:
        body.done_reason === 'length'
          ? 'length'
          : toolCalls.length
            ? 'tool-calls'
            : 'stop',
      usage: {
        ...emptyUsage,
        inputTokens: body.prompt_eval_count ?? null,
        outputTokens: body.eval_count ?? null,
        cachedInputTokens: body.prompt_eval_cached_count ?? null,
      },
    }
  } else {
    const body = S.decodeUnknownSync(OpenAiEnvelope)(value)
    if (
      body.status !== 'completed' &&
      !(
        body.status === 'incomplete' &&
        body.incomplete_details?.reason === 'max_output_tokens'
      )
    )
      throw fail(
        input,
        'invalid-output',
        'Provider response did not complete successfully.',
      )
    if (
      body.output.some(
        part =>
          part.type === 'refusal' ||
          part.content?.some(content => content.type === 'refusal'),
      )
    )
      throw fail(
        input,
        'invalid-output',
        'Provider refused the requested output.',
      )
    const toolCalls = body.output
      .filter(part => part.type === 'function_call')
      .map(part => {
        if (!part.call_id || !part.name || part.arguments === undefined)
          throw fail(
            input,
            'invalid-output',
            'Provider returned an incomplete tool call.',
          )
        const parameters: unknown = JSON.parse(part.arguments)
        return { id: part.call_id, name: part.name, arguments: parameters }
      })
    result = {
      returnedModel: body.model,
      responseId: body.id,
      continuation: {
        provider: input.provider,
        model: input.model,
        items: [
          ...S.decodeUnknownSync(S.Array(S.Record(S.String, S.Unknown)))(
            requestBody(input)['input'],
          ),
          ...S.decodeUnknownSync(
            S.Struct({ output: S.Array(S.Record(S.String, S.Unknown)) }),
          )(value).output,
        ],
      },
      text: body.output
        .flatMap(part => part.content ?? [])
        .filter(part => part.type === 'output_text')
        .map(part => part.text ?? '')
        .join(''),
      toolCalls,
      finishReason:
        body.status === 'incomplete'
          ? 'length'
          : toolCalls.length
            ? 'tool-calls'
            : 'stop',
      usage: {
        ...emptyUsage,
        inputTokens: body.usage?.input_tokens ?? null,
        outputTokens: body.usage?.output_tokens ?? null,
        reasoningTokens:
          body.usage?.output_tokens_details?.reasoning_tokens ?? null,
        cachedInputTokens:
          body.usage?.input_tokens_details?.cached_tokens ?? null,
      },
    }
  }
  if (
    result.text === '' &&
    result.toolCalls.length === 0 &&
    result.finishReason !== 'length'
  )
    throw fail(
      input,
      'invalid-output',
      'Provider returned neither text nor tool calls.',
    )
  if (input.output && result.finishReason === 'stop') JSON.parse(result.text)
  const allowed = new Set((input.tools ?? []).map(tool => tool.name))
  const seen = new Set<string>()
  for (const call of result.toolCalls) {
    if (!allowed.has(call.name) || seen.has(call.id))
      throw fail(
        input,
        'invalid-output',
        'Provider returned an unknown tool or duplicate call ID.',
      )
    seen.add(call.id)
  }
  if (input.toolChoice === 'required' && result.toolCalls.length === 0) {
    throw fail(
      input,
      'invalid-output',
      'Provider returned no tool call despite required tool choice.',
    )
  }
  const selectedTool =
    typeof input.toolChoice === 'object' ? input.toolChoice.name : undefined
  if (
    selectedTool !== undefined &&
    (result.toolCalls.length === 0 ||
      result.toolCalls.some(call => call.name !== selectedTool))
  ) {
    throw fail(
      input,
      'invalid-output',
      'Provider did not honor the named tool choice.',
    )
  }
  return result
}

const abortable = async <A>(
  promise: Promise<A>,
  signal: AbortSignal,
): Promise<A> => {
  if (signal.aborted) {
    // The operation already started; an aborted fetch rejects it with the same
    // reason later, and nothing else would be listening.
    promise.catch(() => undefined)
    throw signal.reason
  }
  let listener: (() => void) | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        listener = () => reject(signal.reason)
        signal.addEventListener('abort', listener, { once: true })
        if (signal.aborted) listener()
      }),
    ])
  } finally {
    if (listener) signal.removeEventListener('abort', listener)
  }
}
const readBody = async (
  response: globalThis.Response,
  signal: AbortSignal,
  cancel: (operation: () => Promise<unknown> | undefined) => void,
): Promise<unknown> => {
  const reader = response.body?.getReader()
  if (!reader) throw new Error('Missing body')
  const decoder = new TextDecoder()
  let size = 0
  let source = ''
  try {
    while (true) {
      const chunk = await abortable(reader.read(), signal)
      if (chunk.done) break
      size += chunk.value.byteLength
      if (size > 4 * 1024 * 1024) throw new Error('Response size exceeded')
      source += decoder.decode(chunk.value, { stream: true })
    }
    const parsed: unknown = JSON.parse(source + decoder.decode())
    return parsed
  } finally {
    cancel(() =>
      reader.cancel().catch(error => {
        // Native fetch errors its stream as part of abort. Cancelling that
        // already-errored stream may reject with the same abort; it has settled.
        if (
          signal.aborted &&
          (error === signal.reason ||
            (typeof error === 'object' &&
              error !== null &&
              'name' in error &&
              error.name === 'AbortError'))
        )
          return
        throw error
      }),
    )
    reader.releaseLock()
  }
}
const retryAfter = (response: globalThis.Response): number | undefined => {
  const value = response.headers.get('retry-after')
  if (!value) return undefined
  const numeric = Number(value)
  const ms = Number.isFinite(numeric)
    ? numeric * 1000
    : Date.parse(value) - Date.now()
  return Number.isFinite(ms) ? Math.max(0, ms) : undefined
}

// A supplied transport can ignore abort or stall cancel(). Drain local
// operations within a fixed allowance and retain any incompleteness.
const LOCAL_CLEANUP_LIMIT_MS = 250
const localCleanupTracker = () => {
  const pending = new Set<Promise<unknown>>()
  let failedOperations = 0
  const track = <A>(operation: Promise<A>, cleanup = false): Promise<A> => {
    pending.add(operation)
    void operation.then(
      () => {
        pending.delete(operation)
      },
      () => {
        pending.delete(operation)
        if (cleanup) failedOperations += 1
      },
    )
    return operation
  }
  const cancel = (operation: () => Promise<unknown> | undefined): void => {
    try {
      track(Promise.resolve(operation()), true)
    } catch {
      failedOperations += 1
    }
  }
  const drain = async (): Promise<LlmLocalCleanup> => {
    const started = performance.now()
    let timer: ReturnType<typeof setTimeout> | undefined
    const deadline = new Promise<void>(resolve => {
      timer = setTimeout(resolve, LOCAL_CLEANUP_LIMIT_MS)
    })
    try {
      while (
        pending.size > 0 &&
        performance.now() - started < LOCAL_CLEANUP_LIMIT_MS
      ) {
        await Promise.race([Promise.allSettled([...pending]), deadline])
      }
      return {
        status:
          pending.size === 0 && failedOperations === 0
            ? 'completed'
            : 'incomplete',
        elapsedMs: performance.now() - started,
        pendingOperations: pending.size,
        failedOperations,
      }
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }
  return { track, cancel, drain }
}

/** Every bound, the identity and the selected credential, checked before anything
 * is sent. `execute` and `stream` share it, so both refuse the same requests. */
const admitRequest = (config: LlmConfig, input: LlmRequest): string => {
  if (
    !input.model.trim() ||
    !input.attribution.appId.trim() ||
    !input.attribution.requestId.trim() ||
    !Number.isSafeInteger(input.maxOutputTokens) ||
    input.maxOutputTokens < 1 ||
    input.maxOutputTokens > 128000 ||
    !Number.isSafeInteger(input.timeoutMs) ||
    input.timeoutMs < 1 ||
    input.timeoutMs > 600000 ||
    !Number.isSafeInteger(input.maxAttempts ?? 2) ||
    (input.maxAttempts ?? 2) < 1 ||
    (input.maxAttempts ?? 2) > 5 ||
    !Number.isSafeInteger(input.retryDelayMs ?? 250) ||
    (input.retryDelayMs ?? 250) < 0 ||
    (input.retryDelayMs ?? 250) > 30000 ||
    (input.idleTimeoutMs !== undefined &&
      (!Number.isSafeInteger(input.idleTimeoutMs) ||
        input.idleTimeoutMs < 1 ||
        input.idleTimeoutMs > input.timeoutMs))
  ) {
    throw fail(
      input,
      'invalid-request',
      'Supply explicit model/app/request identity and bounded positive token, time and attempt budgets.',
    )
  }
  if (
    input.continuation &&
    (input.continuation.provider !== input.provider ||
      input.continuation.model !== input.model)
  )
    throw fail(
      input,
      'invalid-request',
      'Continuation must use the same provider and model.',
    )
  const declaredTools = new Set((input.tools ?? []).map(tool => tool.name))
  if (
    (input.toolChoice === 'required' && declaredTools.size === 0) ||
    (typeof input.toolChoice === 'object' &&
      !declaredTools.has(input.toolChoice.name))
  ) {
    throw fail(
      input,
      'invalid-request',
      'Tool choice must reference at least one declared tool.',
    )
  }
  const compatibility = assessLlmRequest(input)
  if (!compatibility.compatible)
    throw fail(
      input,
      'unsupported',
      compatibility.issues.map(issue => issue.action).join(' '),
    )
  const secret = config.credentials[input.provider]
  if (!secret || !Redacted.value(secret).trim())
    throw fail(
      input,
      'missing-credential',
      'Configure the selected provider credential on the service.',
    )
  return Redacted.value(secret).trim()
}
const requestHeaders = (
  provider: LlmProvider,
  key: string,
): Record<string, string> => ({
  'content-type': 'application/json',
  ...(provider === 'anthropic'
    ? { 'x-api-key': key, 'anthropic-version': '2023-06-01' }
    : { authorization: `Bearer ${key}` }),
})
const providerRequestIdOf = (response: globalThis.Response): string | null => {
  const header = response.headers.get('x-request-id')
  return header !== null && /^[A-Za-z0-9:._/-]{1,200}$/.test(header)
    ? header
    : null
}
/** A non-2xx answer, classified. The caller cancels the body. */
const httpFailure = (
  input: LlmRequest,
  response: globalThis.Response,
  attempt: number,
): LlmFailure => {
  const status = response.status
  const retryable = [408, 429, 500, 502, 503, 504].includes(status)
  const after = retryAfter(response)
  return fail(
    input,
    status === 401 || status === 403
      ? 'unauthorized'
      : status === 429
        ? 'rate-limited'
        : retryable
          ? 'provider-unavailable'
          : 'invalid-request',
    status === 401 || status === 403
      ? 'Provider rejected the service credential or model access.'
      : status === 429
        ? 'Provider rate limit reached.'
        : retryable
          ? 'Provider is temporarily unavailable.'
          : 'Provider rejected the request configuration or schema.',
    attempt,
    {
      httpStatus: status,
      retryable,
      ...(after === undefined ? {} : { retryAfterMs: after }),
    },
  )
}

const spanAttributes = (input: LlmRequest): Record<string, string> => ({
  'llm.provider': input.provider,
  'llm.model': input.model,
  ...(input.reasoningEffort === undefined
    ? {}
    : { 'llm.reasoning_effort': input.reasoningEffort }),
  'llm.request_id': input.attribution.requestId,
  'llm.app_id': input.attribution.appId,
  ...(input.attribution.stage ? { 'llm.stage': input.attribution.stage } : {}),
  ...(input.attribution.buildId
    ? { 'llm.build_id': input.attribution.buildId }
    : {}),
  ...(input.attribution.draftId
    ? { 'llm.draft_id': input.attribution.draftId }
    : {}),
  ...(input.attribution.runId ? { 'llm.run_id': input.attribution.runId } : {}),
})

type Fetcher = NonNullable<LlmConfig['fetch']>
/** Abort reasons that end a stream without a failure. */
const CALLER_STOP = Symbol('llm.stream.caller-stop')
const INTERRUPTED = Symbol('llm.stream.interrupted')
const STREAM_BYTE_LIMIT = 4 * 1024 * 1024
type StreamAttempt = {
  readonly number: number
  readonly started: number
  dispatched: boolean
  providerRequestId: string | null
  recorded: boolean
}
const isAbortError = (error: unknown): boolean =>
  typeof error === 'object' &&
  error !== null &&
  'name' in error &&
  error.name === 'AbortError'

/**
 * One streamed model call, pulled one event at a time. An async iterator rather
 * than a generator on purpose: `return()` must abort a read that is in flight,
 * and a generator's `return()` waits behind it.
 *
 * Rules (wiki/plans/active/runtime-llm-openrouter-and-streaming.md, Design):
 * retry only before the first event; the `finish` result comes from the decoder
 * `execute` uses; the caller's signal ends the stream with `stopped`; anything
 * that ends it early keeps a partial receipt.
 */
const openStreamSession = (
  fetcher: Fetcher,
  config: LlmConfig,
  input: LlmRequest,
) => {
  const started = performance.now()
  const attempts: Array<LlmAttempt> = []
  const cleanup = localCleanupTracker()
  const controller = new AbortController()
  const declared = new Set((input.tools ?? []).map(tool => tool.name))
  const named =
    typeof input.toolChoice === 'object' ? input.toolChoice.name : undefined
  const queue: Array<LlmStreamEvent> = []
  const toolCalls: Array<LlmToolCall> = []
  let text = ''
  let bytes = 0
  let delivered = false
  let phase: 'idle' | 'open' | 'ended' = 'idle'
  let outcome: 'finished' | 'stopped' | 'failed' | 'interrupted' | undefined
  let pendingFailure: LlmFailure | undefined
  let finishResult: LlmResult | undefined
  let key = ''
  let body = ''
  let inputSnapshot: () => LlmInputEvidence | undefined = () => undefined
  let deadline: ReturnType<typeof setTimeout> | undefined
  let localCleanup: LlmLocalCleanup | undefined
  let finalizing: Promise<void> | undefined
  let inflight: Promise<unknown> = Promise.resolve()
  let attempt: StreamAttempt | undefined
  let current:
    | {
        readonly reader: ReadableStreamDefaultReader<Uint8Array>
        readonly decoder: TextDecoder
        readonly framer: {
          readonly push: (chunk: string) => ReadonlyArray<WireFrame>
        }
        readonly wire: WireReader
      }
    | undefined
  let lastObserved: Record<string, unknown> = {}
  const signals = input.signal ? [input.signal] : []
  const callerStop = () => controller.abort(CALLER_STOP)
  const committed = () => delivered || queue.length > 0

  const observed = () => current?.wire.observed() ?? lastObserved
  const receipt = (): LlmPartialReceipt => {
    const monetary = monetaryEvidenceForResponse(
      input,
      observed(),
      attempt?.number ?? 1,
      true,
    )
    return {
      requested: { provider: input.provider, model: input.model },
      returnedModel: monetary.returnedModel,
      responseId: monetary.responseId,
      attribution: input.attribution,
      text,
      toolCalls: [...toolCalls],
      usage: {
        inputTokens: monetary.usage.inputTokens,
        outputTokens: monetary.usage.outputTokens,
        cachedInputTokens: monetary.usage.cachedInputTokens,
        cacheCreationTokens: monetary.usage.cacheCreationTokens,
        reasoningTokens: monetary.usage.reasoningTokens,
        costUsd: null,
        monetary,
        completeness: 'partial',
      },
      attempts: [...attempts],
      elapsedMs: performance.now() - started,
    }
  }
  const record = (
    result: LlmAttempt['outcome'],
    monetary: LlmMonetaryEvidence,
    usage: LlmAttempt['usage'],
  ) => {
    if (!attempt || attempt.recorded) return
    attempt.recorded = true
    const evidence = attempt.dispatched ? inputSnapshot() : undefined
    attempts.push({
      ...(evidence === undefined ? {} : { inputEvidence: evidence }),
      attempt: attempt.number,
      elapsedMs: performance.now() - attempt.started,
      outcome: result,
      usage,
      monetary,
      providerRequestId: attempt.providerRequestId,
    })
  }
  /** The attempt ended early: its evidence is what had been observed, marked cut. */
  const recordCut = (result: LlmAttempt['outcome']) =>
    record(
      result,
      current
        ? monetaryEvidenceForResponse(
            input,
            current.wire.observed(),
            attempt?.number ?? 1,
            true,
          )
        : monetaryEvidenceForResponse(input, undefined, attempt?.number ?? 1),
      'unavailable',
    )
  const release = () => {
    if (!current) return
    const { reader, wire } = current
    lastObserved = wire.observed()
    current = undefined
    cleanup.cancel(() =>
      reader.cancel().catch(error => {
        // An aborted fetch errors its body; cancelling it again rejects the same way.
        if (
          controller.signal.aborted &&
          (error === controller.signal.reason || isAbortError(error))
        )
          return
        throw error
      }),
    )
    try {
      reader.releaseLock()
    } catch {
      // A read still settling holds the lock; the cancel above releases the body.
    }
  }
  const finalize = (): Promise<void> => {
    finalizing ??= (async () => {
      clearTimeout(deadline)
      for (const signal of signals)
        signal.removeEventListener('abort', callerStop)
      if (!controller.signal.aborted) controller.abort()
      release()
      localCleanup = await cleanup.drain()
    })()
    return finalizing
  }
  const enrich = (failure: LlmFailure): LlmFailure =>
    new LlmFailure({
      ...failure,
      message: failure.message,
      model: input.model,
      attribution: input.attribution,
      attempts: [...attempts],
      elapsedMs: performance.now() - started,
      ...(localCleanup === undefined ? {} : { localCleanup }),
      ...(committed() ? { partial: receipt() } : {}),
    })
  const classify = (error: unknown, number: number): LlmFailure | symbol => {
    if (controller.signal.aborted) {
      const reason: unknown = controller.signal.reason
      if (reason === CALLER_STOP || reason === INTERRUPTED) return reason
      return reason instanceof LlmFailure
        ? reason
        : fail(input, 'cancelled', 'Model request cancelled.', number)
    }
    if (error instanceof LlmFailure) return error
    if (error instanceof WireMalformed)
      return fail(input, 'invalid-output', error.message, number)
    if (error instanceof TypeError)
      return fail(
        input,
        'provider-unavailable',
        'Provider transport failed.',
        number,
        { retryable: true },
      )
    return fail(
      input,
      'implementation-defect',
      'Model transport failed unexpectedly.',
      number,
    )
  }

  const begin = () => {
    key = admitRequest(config, input)
    body = JSON.stringify(requestBody(input, true))
    inputSnapshot = observeLlmInputBody(body)
    phase = 'open'
    deadline = setTimeout(
      () =>
        controller.abort(
          fail(
            input,
            'timed-out',
            'Model request exceeded its total deadline.',
          ),
        ),
      input.timeoutMs,
    )
    for (const signal of signals) {
      if (signal.aborted) callerStop()
      else signal.addEventListener('abort', callerStop, { once: true })
    }
  }
  const openAttempt = async () => {
    if (controller.signal.aborted) throw controller.signal.reason
    const opening: StreamAttempt = {
      number: (attempt?.number ?? 0) + 1,
      started: performance.now(),
      dispatched: false,
      providerRequestId: null,
      recorded: false,
    }
    attempt = opening
    const pending = cleanup.track(
      Promise.resolve().then(() => {
        opening.dispatched = true
        return fetcher(endpoints[input.provider], {
          method: 'POST',
          redirect: 'manual',
          signal: controller.signal,
          headers: requestHeaders(input.provider, key),
          body,
        })
      }),
    )
    void pending.then(
      response => {
        if (controller.signal.aborted)
          cleanup.cancel(() => response.body?.cancel())
      },
      () => undefined,
    )
    const response = await abortable(pending, controller.signal)
    opening.providerRequestId = providerRequestIdOf(response)
    if (!response.ok) {
      cleanup.cancel(() => response.body?.cancel())
      throw httpFailure(input, response, opening.number)
    }
    const reader = response.body?.getReader()
    if (!reader)
      throw fail(
        input,
        'invalid-output',
        'Provider returned no stream body.',
        opening.number,
      )
    current = {
      reader,
      decoder: new TextDecoder(),
      framer: framerFor(input.provider),
      wire: wireReaderFor(input.provider, input.attribution.requestId),
    }
  }
  const handle = (event: WireEvent, number: number) => {
    if (phase === 'ended') return
    if (event._tag === 'text') {
      text += event.text
      queue.push({ _tag: 'text-delta', text: event.text })
      return
    }
    if (event._tag === 'tool-call') {
      const id =
        event.id ?? `${input.attribution.requestId}:tool:${toolCalls.length}`
      if (!declared.has(event.name) || toolCalls.some(call => call.id === id))
        throw fail(
          input,
          'invalid-output',
          'Provider returned an unknown tool or duplicate call ID.',
          number,
        )
      if (named !== undefined && event.name !== named)
        throw fail(
          input,
          'invalid-output',
          'Provider did not honor the named tool choice.',
          number,
        )
      const call = { id, name: event.name, arguments: event.arguments }
      toolCalls.push(call)
      queue.push({ _tag: 'tool-call', call })
      return
    }
    if (event._tag === 'error')
      throw fail(
        input,
        'provider-unavailable',
        'Provider reported a failure inside the stream.',
        number,
        { retryable: event.retryable },
      )
    const monetary = monetaryEvidenceForResponse(input, event.envelope, number)
    let decoded: DecodedResult
    try {
      decoded = decodeResponse(input, event.envelope)
    } catch (error) {
      throw error instanceof LlmFailure
        ? error
        : fail(
            input,
            'invalid-output',
            'Provider returned an invalid response envelope.',
            number,
          )
    }
    record(
      'completed',
      monetary,
      decoded.usage.inputTokens === null && decoded.usage.outputTokens === null
        ? 'unavailable'
        : 'reported',
    )
    finishResult = {
      ...decoded,
      usage: { ...decoded.usage, monetary },
      requested: { provider: input.provider, model: input.model },
      attribution: input.attribution,
      attempts,
      elapsedMs: performance.now() - started,
    }
    phase = 'ended'
  }
  const readStep = async () => {
    const reading = current!
    const number = attempt!.number
    let idle: ReturnType<typeof setTimeout> | undefined
    if (input.idleTimeoutMs !== undefined)
      idle = setTimeout(
        () =>
          controller.abort(
            fail(
              input,
              'timed-out',
              'Provider stream sent nothing within its idle allowance.',
              number,
            ),
          ),
        input.idleTimeoutMs,
      )
    let chunk: Awaited<ReturnType<typeof reading.reader.read>>
    try {
      chunk = await abortable(reading.reader.read(), controller.signal)
    } finally {
      clearTimeout(idle)
    }
    const decoded = chunk.done
      ? reading.decoder.decode()
      : reading.decoder.decode(chunk.value, { stream: true })
    if (!chunk.done) {
      bytes += chunk.value.byteLength
      if (bytes > STREAM_BYTE_LIMIT)
        throw fail(
          input,
          'invalid-output',
          'Provider stream exceeded its size limit.',
          number,
        )
    }
    // A last frame without its trailing blank line or newline still counts.
    const frames = reading.framer.push(chunk.done ? `${decoded}\n\n` : decoded)
    for (const frame of frames)
      for (const event of reading.wire.push(frame)) handle(event, number)
    if (chunk.done && phase !== 'ended')
      throw fail(
        input,
        'provider-unavailable',
        'Provider stream ended before it finished.',
        number,
        { retryable: true },
      )
  }
  const backoff = async (failure: LlmFailure, number: number) => {
    const delay =
      failure.retryAfterMs ?? (input.retryDelayMs ?? 250) * 2 ** (number - 1)
    if (delay >= input.timeoutMs - (performance.now() - started))
      throw fail(
        input,
        'timed-out',
        'Provider retry delay exceeds the remaining request deadline.',
        number,
      )
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await abortable(
        new Promise<void>(resolve => {
          timer = setTimeout(resolve, delay)
        }),
        controller.signal,
      )
    } finally {
      clearTimeout(timer)
    }
  }
  const stop = async () => {
    recordCut('cancelled')
    await finalize()
    outcome = 'stopped'
    phase = 'ended'
    queue.push({ _tag: 'stopped', receipt: receipt() })
  }
  const settle = async (failure: LlmFailure) => {
    recordCut(failure.kind)
    await finalize()
    outcome = 'failed'
    phase = 'ended'
    pendingFailure = enrich(failure)
  }
  /** What to do with something that ended an attempt. Never throws. */
  const conclude = async (error: unknown): Promise<'retry' | 'done'> => {
    const failure = classify(error, attempt?.number ?? 1)
    if (failure === CALLER_STOP) {
      await stop()
      return 'done'
    }
    if (typeof failure === 'symbol') return 'done'
    if (
      committed() ||
      !failure.retryable ||
      (attempt?.number ?? 1) >= (input.maxAttempts ?? 2)
    ) {
      await settle(failure)
      return 'done'
    }
    recordCut(failure.kind)
    release()
    try {
      await backoff(failure, attempt?.number ?? 1)
      return 'retry'
    } catch (error) {
      return conclude(error)
    }
  }
  /** Fills the queue or ends the session. Never throws. */
  const fill = async (): Promise<void> => {
    if (phase === 'idle') {
      try {
        begin()
      } catch (error) {
        await settle(
          error instanceof LlmFailure
            ? error
            : fail(
                input,
                'invalid-request',
                'Model request could not be encoded.',
              ),
        )
        return
      }
    }
    while (phase === 'open' && queue.length === 0) {
      try {
        if (!current) await openAttempt()
        await readStep()
      } catch (error) {
        if ((await conclude(error)) === 'done') return
      }
    }
    if (phase === 'ended' && finishResult && outcome === undefined) {
      await finalize()
      outcome = 'finished'
      queue.push({
        _tag: 'finish',
        result: {
          ...finishResult,
          ...(localCleanup === undefined ? {} : { localCleanup }),
        },
      })
    }
  }
  const next = async (): Promise<IteratorResult<LlmStreamEvent, undefined>> => {
    if (queue.length === 0 && phase !== 'ended') {
      const filling = fill()
      inflight = filling
      await filling
    }
    const event = queue.shift()
    if (event !== undefined) {
      delivered = true
      return { done: false, value: event }
    }
    if (pendingFailure !== undefined) {
      const failure = pendingFailure
      pendingFailure = undefined
      throw failure
    }
    return { done: true, value: undefined }
  }
  const iterator: AsyncIterator<LlmStreamEvent, undefined> = {
    next,
    return: async () => {
      if (outcome === undefined) {
        controller.abort(INTERRUPTED)
        await inflight
        if (outcome === undefined) {
          recordCut('cancelled')
          await finalize()
          outcome = 'interrupted'
          phase = 'ended'
        }
      }
      return { done: true, value: undefined }
    },
  }
  return {
    [Symbol.asyncIterator]: () => iterator,
    /** Span attributes for however the stream ended. */
    annotations: (interrupted: boolean): Record<string, unknown> => {
      if (outcome === 'finished' && finishResult)
        return {
          'llm.stream_outcome': 'finished',
          'llm.returned_model': finishResult.returnedModel,
          'llm.elapsed_ms': finishResult.elapsedMs,
          'llm.attempts': attempts,
          'llm.usage': finishResult.usage,
          'llm.finish_reason': finishResult.finishReason,
        }
      const partial = receipt()
      return {
        'llm.stream_outcome': interrupted
          ? 'interrupted'
          : (outcome ?? 'ended'),
        'llm.elapsed_ms': partial.elapsedMs,
        'llm.attempts': attempts,
        'llm.partial_usage': partial.usage,
        'llm.partial_text_length': partial.text.length,
      }
    },
  }
}

export type ModelExecutionShape = {
  readonly assess: typeof assessLlmRequest
  readonly execute: (input: LlmRequest) => Effect.Effect<LlmResult, LlmFailure>
}
/**
 * What `makeModelExecution` returns. A separate type, not a new required member
 * of `ModelExecutionShape`, so a caller's own `{ assess, execute }` fake or
 * wrapper keeps compiling.
 */
export type StreamingModelExecutionShape = ModelExecutionShape & {
  /** Incremental: text deltas, each tool call once complete, then `finish` or `stopped`. */
  readonly stream: (
    input: LlmRequest,
  ) => Stream.Stream<LlmStreamEvent, LlmFailure>
}
export class ModelExecution extends Context.Service<
  ModelExecution,
  ModelExecutionShape
>()('@bespokeagentics/microdots-runtime/ModelExecution') {}

export const makeModelExecution = (
  config: LlmConfig,
): StreamingModelExecutionShape => {
  const fetcher = config.fetch ?? globalThis.fetch
  const execute = (input: LlmRequest): Effect.Effect<LlmResult, LlmFailure> =>
    Effect.suspend(() => {
      const started = performance.now()
      const attempts: Array<LlmAttempt> = []
      const cleanup = localCleanupTracker()
      let cleanupReceipt: LlmLocalCleanup | undefined
      let invocationSettled = Promise.resolve()
      let invocationSignal: AbortSignal | undefined
      return Effect.tryPromise({
        try: effectSignal => {
          invocationSignal = effectSignal
          const invocation = (async () => {
            const key = admitRequest(config, input)
            const body = JSON.stringify(requestBody(input))
            const controller = new AbortController()
            const externalAbort = () =>
              controller.abort(
                fail(input, 'cancelled', 'Model request cancelled.'),
              )
            const timer = setTimeout(
              () =>
                controller.abort(
                  fail(
                    input,
                    'timed-out',
                    'Model request exceeded its total deadline.',
                  ),
                ),
              input.timeoutMs,
            )
            const signals = [effectSignal, input.signal].filter(
              (signal): signal is AbortSignal => signal !== undefined,
            )
            for (const signal of signals) {
              if (signal.aborted) externalAbort()
              else
                signal.addEventListener('abort', externalAbort, { once: true })
            }
            try {
              const inputSnapshot = observeLlmInputBody(body)
              for (
                let attempt = 1;
                attempt <= (input.maxAttempts ?? 2);
                attempt++
              ) {
                if (controller.signal.aborted) throw controller.signal.reason
                const attemptStarted = performance.now()
                let failure: LlmFailure
                let providerRequestId: string | null = null
                let requestDispatched = false
                const inputObservation = () => {
                  const evidence = requestDispatched
                    ? inputSnapshot()
                    : undefined
                  return evidence === undefined
                    ? {}
                    : { inputEvidence: evidence }
                }
                let monetary = monetaryEvidenceForResponse(
                  input,
                  undefined,
                  attempt,
                )
                try {
                  const pendingResponse = cleanup.track(
                    Promise.resolve().then(() => {
                      requestDispatched = true
                      return fetcher(endpoints[input.provider], {
                        method: 'POST',
                        redirect: 'manual',
                        signal: controller.signal,
                        headers: requestHeaders(input.provider, key),
                        body,
                      })
                    }),
                  )
                  void pendingResponse.then(
                    response => {
                      if (controller.signal.aborted)
                        cleanup.cancel(() => response.body?.cancel())
                    },
                    () => undefined,
                  )
                  const response = await abortable(
                    pendingResponse,
                    controller.signal,
                  )
                  providerRequestId = providerRequestIdOf(response)
                  if (!response.ok) {
                    cleanup.cancel(() => response.body?.cancel())
                    throw httpFailure(input, response, attempt)
                  }
                  let result: DecodedResult
                  try {
                    const responseBody = await readBody(
                      response,
                      controller.signal,
                      cleanup.cancel,
                    )
                    monetary = monetaryEvidenceForResponse(
                      input,
                      responseBody,
                      attempt,
                    )
                    const decoded = decodeResponse(input, responseBody)
                    result = {
                      ...decoded,
                      usage: { ...decoded.usage, monetary },
                    }
                  } catch (error) {
                    if (controller.signal.aborted)
                      throw controller.signal.reason
                    throw error instanceof LlmFailure
                      ? error
                      : fail(
                          input,
                          'invalid-output',
                          'Provider returned an invalid response envelope.',
                          attempt,
                        )
                  }
                  attempts.push({
                    ...inputObservation(),
                    attempt,
                    elapsedMs: performance.now() - attemptStarted,
                    outcome: 'completed',
                    monetary,
                    providerRequestId,
                    usage:
                      result.usage.inputTokens === null &&
                      result.usage.outputTokens === null
                        ? 'unavailable'
                        : 'reported',
                  })
                  return {
                    ...result,
                    requested: { provider: input.provider, model: input.model },
                    attribution: input.attribution,
                    attempts,
                    elapsedMs: performance.now() - started,
                  }
                } catch (error) {
                  failure = controller.signal.aborted
                    ? controller.signal.reason instanceof LlmFailure
                      ? controller.signal.reason
                      : fail(
                          input,
                          'cancelled',
                          'Model request cancelled.',
                          attempt,
                        )
                    : error instanceof LlmFailure
                      ? error
                      : error instanceof TypeError
                        ? fail(
                            input,
                            'provider-unavailable',
                            'Provider transport failed.',
                            attempt,
                            { retryable: true },
                          )
                        : fail(
                            input,
                            'implementation-defect',
                            'Model transport failed unexpectedly.',
                            attempt,
                          )
                }
                attempts.push({
                  ...inputObservation(),
                  attempt,
                  elapsedMs: performance.now() - attemptStarted,
                  outcome: failure.kind,
                  usage: 'unavailable',
                  monetary,
                  providerRequestId,
                })
                if (
                  controller.signal.aborted ||
                  !failure.retryable ||
                  attempt === (input.maxAttempts ?? 2)
                )
                  throw failure
                const delay =
                  failure.retryAfterMs ??
                  (input.retryDelayMs ?? 250) * 2 ** (attempt - 1)
                if (delay >= input.timeoutMs - (performance.now() - started))
                  throw fail(
                    input,
                    'timed-out',
                    'Provider retry delay exceeds the remaining request deadline.',
                    attempt,
                  )
                let backoffTimer: ReturnType<typeof setTimeout> | undefined
                try {
                  await abortable(
                    new Promise<void>(resolve => {
                      backoffTimer = setTimeout(resolve, delay)
                    }),
                    controller.signal,
                  )
                } finally {
                  if (backoffTimer !== undefined) clearTimeout(backoffTimer)
                }
              }
              throw fail(
                input,
                'implementation-defect',
                'Model attempt loop ended without a result.',
              )
            } finally {
              clearTimeout(timer)
              controller.abort()
              for (const signal of signals)
                signal.removeEventListener('abort', externalAbort)
              cleanupReceipt = await cleanup.drain()
            }
          })()
          invocationSettled = invocation.then(
            () => undefined,
            () => undefined,
          )
          return invocation
        },
        catch: error => {
          const failure =
            error instanceof LlmFailure
              ? error
              : fail(
                  input,
                  'invalid-request',
                  'Model request could not be encoded.',
                )
          return new LlmFailure({
            ...failure,
            message: failure.message,
            model: input.model,
            attribution: input.attribution,
            attempts,
            elapsedMs: performance.now() - started,
            ...(cleanupReceipt === undefined
              ? {}
              : { localCleanup: cleanupReceipt }),
          })
        },
      }).pipe(
        Effect.ensuring(
          Effect.promise(() => invocationSettled).pipe(
            Effect.andThen(
              Effect.suspend(() =>
                cleanupReceipt === undefined
                  ? Effect.void
                  : Effect.annotateCurrentSpan({
                      'llm.local_cleanup': cleanupReceipt,
                    }).pipe(
                      Effect.andThen(
                        cleanupReceipt.status === 'incomplete' &&
                          invocationSignal?.aborted
                          ? Effect.die(
                              new LlmFailure({
                                ...fail(
                                  input,
                                  'implementation-defect',
                                  'Local model transport cleanup did not settle within its 250ms allowance.',
                                ),
                                message:
                                  'Local model transport cleanup did not settle within its 250ms allowance.',
                                attempts,
                                elapsedMs: performance.now() - started,
                                localCleanup: cleanupReceipt,
                              }),
                            )
                          : Effect.void,
                      ),
                    ),
              ),
            ),
          ),
        ),
        Effect.map(result => ({
          ...result,
          ...(cleanupReceipt === undefined
            ? {}
            : { localCleanup: cleanupReceipt }),
        })),
      )
    }).pipe(
      Effect.tap(result =>
        Effect.annotateCurrentSpan({
          'llm.returned_model': result.returnedModel,
          'llm.elapsed_ms': result.elapsedMs,
          'llm.attempts': result.attempts,
          'llm.usage': result.usage,
          'llm.finish_reason': result.finishReason,
        }),
      ),
      Effect.tapError(error =>
        Effect.annotateCurrentSpan({
          'llm.failure_kind': error.kind,
          'llm.elapsed_ms': error.elapsedMs ?? 0,
          'llm.attempts': error.attempts ?? [],
        }),
      ),
      Effect.withSpan('llm.execute', { attributes: spanAttributes(input) }),
    )
  const stream = (
    input: LlmRequest,
  ): Stream.Stream<LlmStreamEvent, LlmFailure> =>
    Stream.suspend(() => {
      const session = openStreamSession(fetcher, config, input)
      return Stream.fromAsyncIterable(session, error =>
        error instanceof LlmFailure
          ? error
          : fail(
              input,
              'implementation-defect',
              'Model stream failed unexpectedly.',
            ),
      ).pipe(
        Stream.onExit(exit =>
          Effect.annotateCurrentSpan(
            session.annotations(Exit.hasInterrupts(exit)),
          ),
        ),
        Stream.withSpan('llm.stream', { attributes: spanAttributes(input) }),
      )
    })
  return { assess: assessLlmRequest, execute, stream }
}
export const makeModelExecutionLive = (
  config: LlmConfig,
): Layer.Layer<ModelExecution> =>
  Layer.succeed(ModelExecution, makeModelExecution(config))

/**
 * Bridge for existing Effect callers. `generateText` calls `execute`. `streamText`
 * streams through `stream` when the execution has one, as `makeModelExecution`'s
 * does; a caller's own `{ assess, execute }` refuses it rather than buffering a
 * reply and relabelling it incremental.
 */
export const llmLanguageModel = (
  execution: ModelExecutionShape & {
    readonly stream?: StreamingModelExecutionShape['stream']
  },
  defaults: Omit<LlmRequest, 'prompt' | 'tools' | 'toolChoice' | 'output'>,
): Effect.Effect<LanguageModel.Service> => {
  const aiFailure =
    (method: 'generateText' | 'streamText') => (error: LlmFailure) =>
      new AiError.AiError({
        module: 'microdots-runtime/llm',
        method,
        reason: new AiError.UnknownError({
          description: `${error.kind}: ${error.message}`,
        }),
      })
  const codecTransformer =
    defaults.provider === 'anthropic' ? toCodecAnthropic : toCodecOpenAI
  /** The request both methods send for one call's tools, choice and output. */
  const prepare = (
    options: LanguageModel.ProviderOptions,
  ): Effect.Effect<LlmRequest, LlmFailure> => {
    if (
      (defaults.provider === 'openai' ||
        defaults.provider === 'xai' ||
        defaults.provider === 'ollama-cloud' ||
        defaults.provider === 'openrouter') &&
      options.tools.length > 0 &&
      options.toolChoice !== 'none'
    )
      return Effect.fail(
        fail(
          defaults,
          'unsupported',
          'Use ModelExecution.execute with continuation for tool conversations; this LanguageModel bridge cannot preserve provider reasoning state.',
        ),
      )
    if (typeof options.toolChoice === 'object' && 'oneOf' in options.toolChoice)
      return Effect.fail(
        fail(
          defaults,
          'unsupported',
          'Tool subsets are not supported by this adapter.',
        ),
      )
    const choice: LlmToolChoice | undefined =
      options.toolChoice === 'none'
        ? undefined
        : typeof options.toolChoice === 'object'
          ? { name: options.toolChoice.tool }
          : options.toolChoice
    return Effect.try({
      try: () => ({
        output:
          options.responseFormat.type === 'json'
            ? {
                name: options.responseFormat.objectName,
                schema: S.decodeSync(S.Record(S.String, S.Unknown))(
                  Tool.getJsonSchemaFromSchema(options.responseFormat.schema, {
                    transformer: codecTransformer,
                  }),
                ),
              }
            : undefined,
        tools:
          options.toolChoice === 'none'
            ? []
            : options.tools.map(tool => ({
                name: tool.name,
                description: Tool.getDescription(tool) ?? '',
                parameters: S.decodeSync(S.Record(S.String, S.Unknown))(
                  Tool.getJsonSchema(tool, { transformer: codecTransformer }),
                ),
              })),
      }),
      catch: error =>
        fail(
          defaults,
          'unsupported',
          defaults.provider === 'anthropic' &&
            error instanceof Error &&
            error.message.includes('Recursive schemas are not supported')
            ? 'Anthropic strict structured output does not support recursive schemas. Use a nonrecursive schema or a provider profile that supports recursion.'
            : 'The requested schema cannot be represented by this provider structured-output profile.',
        ),
    }).pipe(
      Effect.map(({ output, tools }) => ({
        ...defaults,
        prompt: options.prompt,
        tools,
        ...(choice === undefined ? {} : { toolChoice: choice }),
        ...(output === undefined ? {} : { output }),
      })),
    )
  }
  const usageOf = (usage: LlmUsage) => ({
    inputTokens: { total: usage.inputTokens ?? undefined },
    outputTokens: { total: usage.outputTokens ?? undefined },
  })
  return LanguageModel.make({
    codecTransformer,
    generateText: options =>
      prepare(options).pipe(
        Effect.flatMap(request => execution.execute(request)),
        Effect.flatMap(result =>
          options.responseFormat.type === 'json' &&
          result.finishReason !== 'stop'
            ? Effect.fail(
                fail(
                  defaults,
                  'invalid-output',
                  'Structured model output did not finish completely.',
                ),
              )
            : Effect.succeed(result),
        ),
        Effect.map(result => {
          const parts: Array<AiResponse.PartEncoded> = [
            ...(result.text
              ? [{ type: 'text' as const, text: result.text }]
              : []),
            ...result.toolCalls.map(call => ({
              type: 'tool-call' as const,
              id: call.id,
              name: call.name,
              params: call.arguments,
              providerExecuted: false,
            })),
            {
              type: 'finish',
              reason:
                result.finishReason === 'tool-calls'
                  ? 'tool-calls'
                  : result.finishReason,
              usage: usageOf(result.usage),
            },
          ]
          return parts
        }),
        Effect.mapError(aiFailure('generateText')),
      ),
    streamText: options => {
      const stream = execution.stream
      if (stream === undefined)
        return Stream.fail(
          aiFailure('streamText')(
            fail(
              defaults,
              'unsupported',
              'This model execution cannot stream; build it with makeModelExecution.',
            ),
          ),
        )
      return Stream.unwrap(
        prepare(options).pipe(
          Effect.map(request =>
            Stream.suspend(() => {
              // One text part per reply: opened by the first delta, closed
              // before the first tool call or the end.
              const textId = `${request.attribution.requestId}:text`
              let textOpen = false
              const closeText = (): Array<AiResponse.StreamPartEncoded> => {
                if (!textOpen) return []
                textOpen = false
                return [{ type: 'text-end', id: textId }]
              }
              const parts = (
                event: LlmStreamEvent,
              ): Array<AiResponse.StreamPartEncoded> => {
                if (event._tag === 'text-delta') {
                  const opening: Array<AiResponse.StreamPartEncoded> = textOpen
                    ? []
                    : [{ type: 'text-start', id: textId }]
                  textOpen = true
                  return [
                    ...opening,
                    { type: 'text-delta', id: textId, delta: event.text },
                  ]
                }
                if (event._tag === 'tool-call')
                  return [
                    ...closeText(),
                    {
                      type: 'tool-call',
                      id: event.call.id,
                      name: event.call.name,
                      params: event.call.arguments,
                      providerExecuted: false,
                    },
                  ]
                if (event._tag === 'finish')
                  return [
                    ...closeText(),
                    {
                      type: 'finish',
                      reason: event.result.finishReason,
                      usage: usageOf(event.result.usage),
                    },
                  ]
                return [
                  ...closeText(),
                  {
                    type: 'finish',
                    reason: 'other',
                    usage: usageOf(event.receipt.usage),
                  },
                ]
              }
              return stream(request).pipe(
                Stream.flatMap(event => Stream.fromIterable(parts(event))),
              )
            }),
          ),
        ),
      ).pipe(Stream.mapError(aiFailure('streamText')))
    },
  })
}

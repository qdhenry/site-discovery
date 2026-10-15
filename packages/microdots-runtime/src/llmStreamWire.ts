/**
 * Provider stream readers for the server-only model seam. Pure: decoded text in,
 * neutral events out. No credentials, no transport, no Effect.
 *
 * Each reader turns one provider's incremental wire into the same four events and,
 * at the end, the response envelope that provider's buffered API would have
 * returned, so the seam decodes a streamed reply with the decoder `execute` uses.
 */
import { Schema as S } from 'effect'

export type WireProvider =
  'openai' | 'anthropic' | 'xai' | 'ollama-cloud' | 'openrouter'

export type WireEvent =
  | { readonly _tag: 'text'; readonly text: string }
  /** A complete call. `id` is absent when the provider sent none. */
  | {
      readonly _tag: 'tool-call'
      readonly id: string | undefined
      readonly name: string
      readonly arguments: unknown
    }
  /** The provider finished; `envelope` is shaped like its buffered response. */
  | { readonly _tag: 'end'; readonly envelope: Record<string, unknown> }
  /** The provider reported a failure inside the stream. */
  | { readonly _tag: 'error'; readonly retryable: boolean }

/** Thrown for a frame or call that cannot be read. The seam reports invalid output. */
export class WireMalformed extends Error {
  override readonly name = 'WireMalformed'
}

export type WireReader = {
  readonly push: (frame: WireFrame) => ReadonlyArray<WireEvent>
  /**
   * A body shaped like the provider's final response, holding only what has
   * arrived so far: the model, the response id and any usage already reported.
   * Accounting reads it for a stream that was cut short.
   */
  readonly observed: () => Record<string, unknown>
}

export type WireFrame = {
  readonly event: string | undefined
  readonly data: string
}

const record = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' &&
  value !== null &&
  !Array.isArray(value) &&
  S.is(S.Record(S.String, S.Unknown))(value)
    ? value
    : {}
const text = (value: unknown): string | undefined =>
  typeof value === 'string' ? value : undefined
const parseJson = (source: string): unknown => {
  try {
    const parsed: unknown = JSON.parse(source)
    return parsed
  } catch {
    throw new WireMalformed('A stream frame is not JSON.')
  }
}
const toolArguments = (source: string): unknown => {
  // An empty argument string is a call with no parameters.
  if (source.trim() === '') return {}
  try {
    const parsed: unknown = JSON.parse(source)
    return parsed
  } catch {
    throw new WireMalformed(
      'A tool call arrived with arguments that are not JSON.',
    )
  }
}

/**
 * Server-sent events framing. Splits on blank lines, joins multi-line `data`,
 * and drops comment lines (`: OPENROUTER PROCESSING`). A `\r` at a chunk's end
 * is held back so a `\r\n` split across chunks still counts as one line break.
 */
export const sseFramer = () => {
  let buffer = ''
  const push = (chunk: string): ReadonlyArray<WireFrame> => {
    buffer += chunk
    const held = buffer.endsWith('\r') ? '\r' : ''
    const body = (held ? buffer.slice(0, -1) : buffer).replace(/\r\n?/g, '\n')
    const blocks = body.split('\n\n')
    buffer = blocks.pop()! + held
    const frames: Array<WireFrame> = []
    for (const block of blocks) {
      let event: string | undefined
      const data: Array<string> = []
      for (const line of block.split('\n')) {
        if (line === '' || line.startsWith(':')) continue
        const colon = line.indexOf(':')
        const field = colon === -1 ? line : line.slice(0, colon)
        const raw = colon === -1 ? '' : line.slice(colon + 1)
        const value = raw.startsWith(' ') ? raw.slice(1) : raw
        if (field === 'event') event = value
        else if (field === 'data') data.push(value)
      }
      if (data.length > 0) frames.push({ event, data: data.join('\n') })
    }
    return frames
  }
  return { push }
}

/** Newline-delimited JSON framing (Ollama). Each non-blank line is one frame. */
export const ndjsonFramer = () => {
  let buffer = ''
  const push = (chunk: string): ReadonlyArray<WireFrame> => {
    buffer += chunk
    const lines = buffer.split('\n')
    buffer = lines.pop()!
    return lines
      .map(line => line.trim())
      .filter(line => line !== '')
      .map(data => ({ event: undefined, data }))
  }
  return { push }
}

export const framerFor = (provider: WireProvider) =>
  provider === 'ollama-cloud' ? ndjsonFramer() : sseFramer()

/** OpenAI and xAI Responses API events. `response.completed` carries the whole response. */
const responsesReader = (): WireReader => {
  let observed: Record<string, unknown> = {}
  const push = (frame: WireFrame): ReadonlyArray<WireEvent> => {
    const data = record(parseJson(frame.data))
    const type = text(data['type'])
    const response = record(data['response'])
    if (type === 'response.created' || type === 'response.in_progress') {
      observed = { id: response['id'], model: response['model'] }
      return []
    }
    if (type === 'response.output_text.delta') {
      const delta = text(data['delta'])
      return delta ? [{ _tag: 'text', text: delta }] : []
    }
    if (type === 'response.output_item.done') {
      const item = record(data['item'])
      if (item['type'] !== 'function_call') return []
      const name = text(item['name'])
      const args = text(item['arguments'])
      if (!name || args === undefined)
        throw new WireMalformed('A tool call arrived incomplete.')
      return [
        {
          _tag: 'tool-call',
          id: text(item['call_id']),
          name,
          arguments: toolArguments(args),
        },
      ]
    }
    if (type === 'response.completed' || type === 'response.incomplete') {
      observed = response
      return [{ _tag: 'end', envelope: response }]
    }
    if (type === 'response.failed' || type === 'error')
      return [{ _tag: 'error', retryable: true }]
    return []
  }
  return { push, observed: () => observed }
}

/** Anthropic Messages API events, assembled back into a message envelope. */
const anthropicReader = (): WireReader => {
  let id: unknown
  let model: unknown
  let stopReason: unknown
  let usage: Record<string, unknown> = {}
  let outputReported = false
  const blocks = new Map<number, Record<string, unknown>>()
  const json = new Map<number, string>()
  const push = (frame: WireFrame): ReadonlyArray<WireEvent> => {
    const data = record(parseJson(frame.data))
    const type = text(data['type']) ?? frame.event
    if (type === 'message_start') {
      const message = record(data['message'])
      id = message['id']
      model = message['model']
      // The start's output count is a placeholder; only message_delta reports it.
      const { output_tokens: _placeholder, ...input } = record(message['usage'])
      usage = input
      return []
    }
    if (type === 'content_block_start') {
      const index = Number(data['index'])
      const block = { ...record(data['content_block']) }
      blocks.set(index, block)
      if (block['type'] === 'tool_use') {
        json.set(index, '')
        block['input'] = {}
      }
      const initial = text(block['text'])
      return block['type'] === 'text' && initial
        ? [{ _tag: 'text', text: initial }]
        : []
    }
    if (type === 'content_block_delta') {
      const index = Number(data['index'])
      const block = blocks.get(index)
      const delta = record(data['delta'])
      if (!block)
        throw new WireMalformed('A delta arrived for an unknown block.')
      if (delta['type'] === 'text_delta') {
        const piece = text(delta['text']) ?? ''
        block['text'] = (text(block['text']) ?? '') + piece
        return piece ? [{ _tag: 'text', text: piece }] : []
      }
      if (delta['type'] === 'input_json_delta')
        json.set(
          index,
          (json.get(index) ?? '') + (text(delta['partial_json']) ?? ''),
        )
      return []
    }
    if (type === 'content_block_stop') {
      const index = Number(data['index'])
      const block = blocks.get(index)
      if (!block || block['type'] !== 'tool_use') return []
      const name = text(block['name'])
      if (!name) throw new WireMalformed('A tool call arrived incomplete.')
      const input = toolArguments(json.get(index) ?? '')
      block['input'] = input
      return [
        { _tag: 'tool-call', id: text(block['id']), name, arguments: input },
      ]
    }
    if (type === 'message_delta') {
      stopReason = record(data['delta'])['stop_reason']
      const reported = record(data['usage'])
      usage = { ...usage, ...reported }
      if (reported['output_tokens'] !== undefined) outputReported = true
      return []
    }
    if (type === 'message_stop')
      return [
        {
          _tag: 'end',
          envelope: {
            id,
            model,
            stop_reason: stopReason,
            content: [...blocks.entries()]
              .sort(([a], [b]) => a - b)
              .map(([, block]) => block),
            usage,
          },
        },
      ]
    if (type === 'error') {
      const kind = text(record(data['error'])['type'])
      return [
        {
          _tag: 'error',
          retryable:
            kind === 'overloaded_error' ||
            kind === 'api_error' ||
            kind === 'rate_limit_error',
        },
      ]
    }
    return []
  }
  return {
    push,
    observed: () => ({
      id,
      model,
      usage: outputReported ? usage : { ...usage, output_tokens: undefined },
    }),
  }
}

/** Ollama `/api/chat` lines, assembled back into the final chat envelope. */
const ollamaReader = (requestId: string): WireReader => {
  let model: unknown
  let content = ''
  const calls: Array<Record<string, unknown>> = []
  const push = (frame: WireFrame): ReadonlyArray<WireEvent> => {
    const data = record(parseJson(frame.data))
    if (data['error'] !== undefined)
      return [{ _tag: 'error', retryable: false }]
    model = data['model'] ?? model
    const message = record(data['message'])
    const events: Array<WireEvent> = []
    const piece = text(message['content'])
    if (piece) {
      content += piece
      events.push({ _tag: 'text', text: piece })
    }
    const toolCalls = message['tool_calls']
    for (const raw of Array.isArray(toolCalls) ? toolCalls : []) {
      const call = record(raw)
      const fn = record(call['function'])
      const name = text(fn['name'])
      if (!name) throw new WireMalformed('A tool call arrived incomplete.')
      const callId = text(call['id']) ?? `${requestId}:tool:${calls.length}`
      calls.push({ ...call, id: callId })
      events.push({
        _tag: 'tool-call',
        id: callId,
        name,
        arguments: fn['arguments'],
      })
    }
    if (data['done'] === true)
      events.push({
        _tag: 'end',
        envelope: {
          ...data,
          message: {
            role: 'assistant',
            content,
            ...(calls.length ? { tool_calls: calls } : {}),
          },
        },
      })
    return events
  }
  return { push, observed: () => ({ model }) }
}

/**
 * OpenRouter Chat Completions chunks. A call streams its arguments in pieces under
 * an index; it is complete once a later index starts or a finish reason arrives.
 * Usage, with the reported cost, comes in the last chunk before `[DONE]`.
 */
const openRouterReader = (): WireReader => {
  let id: unknown
  let model: unknown
  let usage: unknown
  let finishReason: unknown
  let content = ''
  const open = new Map<number, { id?: string; name: string; args: string }>()
  const done: Array<{ id: string | undefined; name: string; args: string }> = []
  const complete = (below: number): Array<WireEvent> => {
    const events: Array<WireEvent> = []
    for (const index of [...open.keys()].sort((a, b) => a - b)) {
      if (index >= below) continue
      const call = open.get(index)!
      open.delete(index)
      if (!call.name) throw new WireMalformed('A tool call arrived incomplete.')
      done.push({ id: call.id, name: call.name, args: call.args })
      events.push({
        _tag: 'tool-call',
        id: call.id,
        name: call.name,
        arguments: toolArguments(call.args),
      })
    }
    return events
  }
  const push = (frame: WireFrame): ReadonlyArray<WireEvent> => {
    if (frame.data.trim() === '[DONE]')
      return [
        ...complete(Number.POSITIVE_INFINITY),
        {
          _tag: 'end',
          envelope: {
            id,
            model,
            choices: [
              {
                finish_reason: finishReason,
                message: {
                  role: 'assistant',
                  content,
                  ...(done.length
                    ? {
                        tool_calls: done.map(call => ({
                          ...(call.id === undefined ? {} : { id: call.id }),
                          type: 'function',
                          function: { name: call.name, arguments: call.args },
                        })),
                      }
                    : {}),
                },
              },
            ],
            ...(usage === undefined ? {} : { usage }),
          },
        },
      ]
    const data = record(parseJson(frame.data))
    id = data['id'] ?? id
    model = data['model'] ?? model
    if (data['usage'] !== undefined && data['usage'] !== null)
      usage = data['usage']
    const choices = data['choices']
    const choice = record(Array.isArray(choices) ? choices[0] : undefined)
    if (data['error'] !== undefined || choice['finish_reason'] === 'error') {
      const code = Number(record(data['error'])['code'])
      return [{ _tag: 'error', retryable: code === 429 || code >= 500 }]
    }
    const events: Array<WireEvent> = []
    const delta = record(choice['delta'])
    const piece = text(delta['content'])
    if (piece) {
      content += piece
      events.push({ _tag: 'text', text: piece })
    }
    const toolCalls = delta['tool_calls']
    for (const raw of Array.isArray(toolCalls) ? toolCalls : []) {
      const call = record(raw)
      const index = Number(call['index'] ?? 0)
      events.push(...complete(index))
      const fn = record(call['function'])
      const current = open.get(index) ?? { name: '', args: '' }
      const callId = text(call['id'])
      open.set(index, {
        ...((callId ?? current.id) ? { id: callId ?? current.id } : {}),
        name: current.name + (text(fn['name']) ?? ''),
        args: current.args + (text(fn['arguments']) ?? ''),
      })
    }
    if (
      choice['finish_reason'] !== undefined &&
      choice['finish_reason'] !== null
    ) {
      finishReason = choice['finish_reason']
      events.push(...complete(Number.POSITIVE_INFINITY))
    }
    return events
  }
  return {
    push,
    observed: () => ({ id, model, ...(usage === undefined ? {} : { usage }) }),
  }
}

export const wireReaderFor = (
  provider: WireProvider,
  requestId: string,
): WireReader =>
  provider === 'anthropic'
    ? anthropicReader()
    : provider === 'ollama-cloud'
      ? ollamaReader(requestId)
      : provider === 'openrouter'
        ? openRouterReader()
        : responsesReader()

import { Option, Schema as S } from 'effect'

export const LlmInputEvidence = S.Struct({
  schemaVersion: S.Literal(1),
  boundary: S.Literal('client-request-json-utf8'),
  bodyBytes: S.Natural,
  parts: S.Array(
    S.Struct({
      kind: S.Literals(['context', 'tools', 'output-schema']),
      bytes: S.Natural,
      sha256: S.NullOr(S.String),
    }),
  ),
})
export type LlmInputEvidence = typeof LlmInputEvidence.Type

/** Feed one invocation's ordered HTTP attempts, including failed attempts.
 * Unknown call boundaries must be supplied as undefined. Never combine roles,
 * providers or invocations here: each has its own prior-input history. */
export const summarizeLlmInputEvidence = (
  observations: ReadonlyArray<unknown>,
) => {
  const prior = new Set<string>()
  const parts = {
    context: { bytes: 0, repeatedBytes: 0 },
    tools: { bytes: 0, repeatedBytes: 0 },
    'output-schema': { bytes: 0, repeatedBytes: 0 },
  }
  let bodyBytes = 0,
    unavailable = 0,
    unclassifiedPartBytes = 0
  for (const value of observations) {
    const decoded = S.decodeUnknownOption(LlmInputEvidence)(value)
    if (
      Option.isNone(decoded) ||
      decoded.value.parts.some(
        part => part.sha256 !== null && !/^[a-f0-9]{64}$/u.test(part.sha256),
      ) ||
      decoded.value.parts.reduce((sum, part) => sum + part.bytes, 0) >
        decoded.value.bodyBytes
    ) {
      unavailable++
      continue
    }
    const input = decoded.value
    bodyBytes += input.bodyBytes
    const current = new Set<string>()
    for (const part of input.parts) {
      parts[part.kind].bytes += part.bytes
      if (part.sha256 === null) {
        unclassifiedPartBytes += part.bytes
        continue
      }
      const identity = JSON.stringify([part.kind, part.bytes, part.sha256])
      if (prior.has(identity)) parts[part.kind].repeatedBytes += part.bytes
      current.add(identity)
    }
    for (const identity of current) prior.add(identity)
  }
  return {
    schemaVersion: 1,
    scope:
      'One invocation, ordered HTTP attempts. Client JSON bytes, excluding headers; repeated disjoint parts are a lower bound, not tokens, billing, or proof of provider receipt.',
    observations: observations.length,
    observedRequests: observations.length - unavailable,
    unavailableRequests: unavailable,
    complete: unavailable === 0 && unclassifiedPartBytes === 0,
    bodyBytes,
    unclassifiedPartBytes,
    parts,
  }
}

/** Observe the exact serialized request supplied to fetch, excluding headers.
 * Parts are disjoint JSON values, so repeated-part bytes are a lower bound on
 * repeated body bytes. Neither byte measure represents tokens or billed usage.
 * Digests and lengths retain no prompt, tool-result, schema or credential text.
 * Optional measurement failure must never prevent the model request. */
export const observeLlmInputBody = (
  serialized: string,
): (() => LlmInputEvidence | undefined) => {
  try {
    const body: Record<string, unknown> = JSON.parse(serialized)
    const encoder = new TextEncoder()
    const values: Array<{
      kind: LlmInputEvidence['parts'][number]['kind']
      value: unknown
    }> = []
    for (const key of ['input', 'messages'])
      if (Array.isArray(body[key]))
        for (const value of body[key]) values.push({ kind: 'context', value })
    if (typeof body['system'] === 'string' && body['system'].length > 0)
      values.push({ kind: 'context', value: body['system'] })
    if (body['tools'] !== undefined)
      values.push({ kind: 'tools', value: body['tools'] })
    for (const key of ['text', 'output_config', 'format'])
      if (body[key] !== undefined)
        values.push({ kind: 'output-schema', value: body[key] })
    const parts = values.map(({ kind, value }) => {
      const bytes = encoder.encode(JSON.stringify(value))
      const part: {
        kind: LlmInputEvidence['parts'][number]['kind']
        bytes: number
        sha256: string | null
      } = {
        kind,
        bytes: bytes.byteLength,
        sha256: null,
      }
      try {
        // Never await optional crypto on the request or cancellation path.
        // Snapshots copy these objects, so a later digest cannot rewrite a receipt.
        void crypto.subtle.digest('SHA-256', bytes).then(
          digest => {
            part.sha256 = Array.from(new Uint8Array(digest), byte =>
              byte.toString(16).padStart(2, '0'),
            ).join('')
          },
          () => undefined,
        )
      } catch {
        /* Unavailable fingerprint remains null. */
      }
      return part
    })
    const bodyBytes = encoder.encode(serialized).byteLength
    if (parts.reduce((sum, part) => sum + part.bytes, 0) > bodyBytes)
      return () => undefined
    return () => ({
      schemaVersion: 1,
      boundary: 'client-request-json-utf8',
      bodyBytes,
      parts: parts.map(part => ({ ...part })),
    })
  } catch {
    return () => undefined
  }
}

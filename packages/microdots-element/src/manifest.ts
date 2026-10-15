import { Schema as S } from 'effect'

import {
  RENDER_FAILURE_ATTRIBUTE,
  RENDER_FAILURE_EVENT,
} from './renderObservation.ts'

/**
 * Names the framework owns on every element. A surface may not declare them:
 * `theme` is intercepted generically (see THEME_ATTRIBUTE in defineMicroDot),
 * `data-theme` is its mirror, `data-microdot` is the subtree marker
 * `@bespokeagentics/microdots-theme` scopes its element rules to, and
 * `data-microdot-render-failure` is the live sentinel's named-failure state.
 * Rejected at define time so the collision is a loud first-render throw instead
 * of a comment.
 */
export const RESERVED_ATTRIBUTES: ReadonlyArray<string> = [
  'theme',
  'data-theme',
  'data-microdot',
  RENDER_FAILURE_ATTRIBUTE,
]

/**
 * Event names the framework dispatches itself. A surface that declared one
 * would collide with the live sentinel's `microdots:render-failure` (or any
 * later framework event) and silently overwrite it.
 */
export const RESERVED_EVENTS: ReadonlyArray<string> = [RENDER_FAILURE_EVENT]

export type AttributeType = 'string' | 'number' | 'boolean' | 'json' | 'enum'

/**
 * One attribute of a MicroDot's public surface.
 *
 * `type` describes what the string value ENCODES — a DOM attribute physically
 * carries a string, so `number`/`boolean` here is a declared interpretation the
 * wire engine's type-match check compares, not a runtime representation.
 *
 * `live: true` means the attribute reconfigures a running instance; every live
 * attribute must have a `receive` handler and vice versa (checked at define
 * time). `required: true` means a mount without it is a host mistake — the
 * runtime cannot enforce that yet (placement check #3 will), but the manifest
 * carries the contract. `ownership` marks the two special categories from the
 * host-owned-inputs taxonomy: `environment` (host-supplied at create, read
 * once, never observed — `api-url`) and `host-input` (declared by the dot,
 * satisfied by the host — `interview-id`); absent means the dot owns it.
 */
export type AttributeSpec = {
  readonly type?: AttributeType
  readonly required?: boolean
  readonly default?: string
  readonly live?: boolean
  readonly ownership?: 'environment' | 'host-input'
  readonly values?: ReadonlyArray<string>
  readonly description?: string
}

/**
 * One event of a MicroDot's public surface. `payload` is a LIVE Effect Schema
 * that must be a named export of the dot's `contract.ts` — the manifest
 * emitter reverse-matches it by identity and fails the build otherwise, which
 * is what keeps event payload knowledge in the dot instead of in the host.
 */
export type EventSpec = {
  readonly payload: S.Top
  readonly description?: string
}

/**
 * The declared public surface of one custom element: what it takes (attributes)
 * and what it sends (events). This object is the single input to BOTH
 * `defineMicroDot` and the manifest emitter, which is what makes name drift
 * between the manifest and the code structurally impossible.
 */
export type MicroDotSurface = {
  readonly tag: string
  readonly attributes: Readonly<Record<string, AttributeSpec>>
  readonly events: Readonly<Record<string, EventSpec>>
}

/**
 * Identity helper that preserves the literal types of a surface declaration
 * (`live: true` stays `true`, event names stay literal) without a `as const`
 * assertion, so `defineMicroDot`'s receive/publish records can be keyed by the
 * declaration. A dot's `src/surface.ts` wraps its surfaces in this.
 */
export const makeMicroDotSurface = <const Surface extends MicroDotSurface>(
  surface: Surface,
): Surface => surface

/** The attribute names a surface declares `live: true` — exactly the keys its
 *  `receive` record must have. */
export type LiveAttributeNames<Surface extends MicroDotSurface> = {
  [
    Name in keyof Surface['attributes'] & string
  ]: Surface['attributes'][Name] extends {
    readonly live: true
  }
    ? Name
    : never
}[keyof Surface['attributes'] & string]

/* ============================================================
   The emitted manifest — the JSON file `scripts/emit-manifests.ts` writes to
   `dist/<name>.manifest.json` after every build. Build-emitted, never
   hand-written: bundle bytes and the build id can only be known after the
   bundle exists, and a hand-maintained copy would drift into noise.
   ============================================================ */

export const ManifestAttribute = S.Struct({
  name: S.String,
  type: S.Literals(['string', 'number', 'boolean', 'json', 'enum']),
  required: S.Boolean,
  default: S.optional(S.String),
  live: S.Boolean,
  ownership: S.Literals(['dot', 'environment', 'host-input']),
  values: S.optional(S.Array(S.String)),
  description: S.optional(S.String),
})
export type ManifestAttribute = typeof ManifestAttribute.Type

export const ManifestEventPayload = S.Struct({
  /** Stable specifier of the payload schema's contract export, e.g.
   *  `@microdots/readout/contract#Quote`. */
  ref: S.String,
  /** Best-effort JSON Schema document for the payload; omitted when the
   *  generator cannot render the schema. `ref` alone is still enough for
   *  Wiring read mode. */
  jsonSchema: S.optional(S.Unknown),
})
export type ManifestEventPayload = typeof ManifestEventPayload.Type

export const ManifestEvent = S.Struct({
  name: S.String,
  payload: ManifestEventPayload,
  description: S.optional(S.String),
})
export type ManifestEvent = typeof ManifestEvent.Type

export const ManifestTag = S.Struct({
  tag: S.String,
  attributes: S.Array(ManifestAttribute),
  events: S.Array(ManifestEvent),
})
export type ManifestTag = typeof ManifestTag.Type

export const MicroDotManifest = S.Struct({
  /** Directory/package basename: 'price', 'bespoke-contact'. */
  name: S.String,
  /** 8-hex sha256 content hash of the bundle — the immutable build id. */
  build: S.String,
  bundle: S.Struct({
    file: S.String,
    hashedFile: S.String,
    bytes: S.Number,
    gzipBytes: S.Number,
  }),
  service: S.Struct({
    localPort: S.Number,
    /** Absent until the dot has a deployed origin. */
    deployedApiUrl: S.optional(S.String),
  }),
  /** One entry per tag — a MicroDot is ONE deployable unit exposing 1..N tags. */
  tags: S.Array(ManifestTag),
})
export type MicroDotManifest = typeof MicroDotManifest.Type

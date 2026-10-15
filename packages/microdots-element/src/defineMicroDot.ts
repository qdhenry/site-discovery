import { Function, Option, Record } from 'effect'

import {
  type LiveAttributeNames,
  type MicroDotSurface,
  RESERVED_ATTRIBUTES,
} from './manifest.ts'
import { mountPoint } from './mountPoint.ts'

export type Disposable = { readonly dispose: () => void }

/**
 * The shape `handle.ports.<name>` already has: something that calls a listener
 * with each value. Structural, so the framework never imports Foldkit types —
 * and the subscribe return (Foldkit hands back an unsubscribe) is deliberately
 * ignored, matching the pre-surface behaviour: disposal of the runtime tears
 * the ports down with it.
 */
export type PortSubscribable<Value> = {
  readonly subscribe: (listener: (value: Value) => void) => void
}

/**
 * The surface-declaring definition shape — the ONLY shape since the platform
 * programme's Phase 3 retired the pre-surface tag/attributes one. The last
 * holdouts were the workbench's template emitters, migrated in the same change
 * that deleted the legacy union arm; a stale caller now gets the legible throw
 * in `defineMicroDot` instead of a blank panel with a clean console.
 *
 * The surface (see `MicroDotSurface`) is the single declaration the manifest is
 * derived from, and this type keys the runtime wiring to it:
 *
 * - `receive` must have exactly the surface's `live: true` attribute names.
 * - `publish` must have exactly the surface's event names, each selecting the
 *   outbound port that carries the event's payload — the FRAMEWORK does the
 *   `dispatchEvent`, exactly as it already owns `theme`, so an event a dot
 *   declares cannot silently go undispatched (and vice versa).
 *
 * Both are also re-checked at define time so a widened surface type cannot
 * bypass them — the failure is a loud first-render throw.
 *
 * Callers pass both type arguments explicitly
 * (`defineMicroDot<Handle, typeof surface>({ surface, ... })`): TypeScript has
 * no partial type-argument inference, and `Handle` cannot be inferred before
 * `embed` is checked.
 */
export type MicroDotSurfaceDefinition<
  Handle extends Disposable,
  Surface extends MicroDotSurface,
> = {
  readonly surface: Surface
  /**
   * The MicroDot's own compiled CSS, imported with `./styles.css?inline`.
   *
   * A runtime-loaded MicroDot cannot rely on the host having generated its
   * classes, so each bundle carries its own styles and injects them once.
   */
  readonly styles?: string
  /** Start the runtime. The MicroDot owns this so its Foldkit types stay concrete. */
  readonly embed: (
    container: HTMLElement,
    attributes: Readonly<Record<string, string>>,
  ) => Handle
  /** One handler per `live: true` surface attribute. `theme` is intercepted
   *  before this map is consulted and must not appear. */
  readonly receive: Readonly<{
    [Name in LiveAttributeNames<Surface>]: (
      handle: Handle,
      value: string,
    ) => void
  }>
  /** One port selector per surface event; the framework subscribes and
   *  dispatches the bubbling CustomEvent itself. */
  readonly publish: Readonly<{
    [Name in keyof Surface['events'] & string]: (
      handle: Handle,
    ) => PortSubscribable<Surface['events'][Name]['payload']['Type']>
  }>
}

const readAttributes = (
  element: HTMLElement,
  defaults: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> =>
  Record.map(defaults, (fallback, name) =>
    Option.match(Option.fromNullishOr(element.getAttribute(name)), {
      onNone: () => fallback,
      onSome: Function.identity,
    }),
  )

/**
 * The theming attribute every MicroDot gets for free.
 *
 * It is handled entirely here rather than by each MicroDot. Interception
 * happens before the `receive` lookup and this is the only place that can
 * guarantee it for every MicroDot at once — a MicroDot that declared a `theme`
 * handler would still never see one.
 *
 * Historically this interception was load-bearing for a second reason: `receive`
 * was one callback that every implementation routed to a single port, so a
 * `theme="dark"` write would have set the price ticker's SYMBOL to "dark".
 * `receive` is a keyed record now, so that particular hazard is gone — but
 * theming is still infrastructure, and no `app.ts` should have to know it exists.
 */
const THEME_ATTRIBUTE = 'theme'

/**
 * Marks the custom element so `@bespokeagentics/microdots-theme` can scope the handful of element
 * rules a MicroDot bundle is allowed to carry (base typography, the focus ring,
 * the autofill fix) to the subtree the MicroDot owns.
 *
 * It goes on the element rather than the container because `Runtime.embed`
 * REPLACES the mount container, leaving the custom element as the only durable
 * per-instance anchor.
 */
const MICRODOT_ATTRIBUTE = 'data-microdot'

/**
 * A token-set identifier carried by the reserved `theme` attribute.
 *
 * Client identity and mode share this one value (`acme`, `acme-dark`), so an
 * exact light/dark allow-list would erase every project theme before CSS can
 * see it. Keep the vocabulary URL/file-name friendly: lowercase kebab-case,
 * with malformed, blank and removed values meaning "inherit from the page".
 */
const THEME_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/**
 * Mirrors `theme` onto `data-theme`, the selector `@bespokeagentics/microdots-theme` matches.
 *
 * Two names rather than one so a MicroDot's public vocabulary stays plain
 * (`symbol`, `region`, `theme`) while the CSS keeps ONE selector shape that
 * works identically on <html> and on a single element. Custom properties
 * inherit, so setting it here re-themes everything the runtime renders inside.
 */
const applyTheme = (element: HTMLElement, value: string | null): void => {
  if (value !== null && THEME_NAME.test(value)) {
    element.setAttribute('data-theme', value)
    return
  }
  element.removeAttribute('data-theme')
}

const sameMembers = (
  left: ReadonlyArray<string>,
  right: ReadonlyArray<string>,
): boolean =>
  left.length === right.length && left.every(name => right.includes(name))

/**
 * Names the offender in the retired-shape throw. Best-effort: a legacy
 * definition carried its tag at the top level, so read it structurally without
 * trusting the value.
 */
const legacyTagOf = (definition: unknown): string =>
  typeof definition === 'object' &&
  definition !== null &&
  'tag' in definition &&
  typeof definition.tag === 'string'
    ? `<${definition.tag}>`
    : 'a definition with no surface'

/**
 * The define-time cross-checks that make the surface trustworthy as manifest
 * input. Each failure throws with the tag named, so a violation is a loud
 * first-render crash instead of a silently wrong manifest.
 */
const validateSurfaceDefinition = <Handle extends Disposable>(
  definition: MicroDotSurfaceDefinition<Handle, MicroDotSurface>,
): void => {
  const { surface } = definition
  const attributeNames = Object.keys(surface.attributes)
  const eventNames = Object.keys(surface.events)

  const reserved = [...attributeNames, ...eventNames].filter(name =>
    RESERVED_ATTRIBUTES.includes(name),
  )
  if (reserved.length > 0) {
    throw new Error(
      `[microdots] <${surface.tag}> declares reserved name(s) ${reserved.join(', ')} — the framework owns theme/data-theme/data-microdot`,
    )
  }

  const liveNames = attributeNames.filter(
    name => surface.attributes[name]?.live === true,
  )
  const receiveNames = Object.keys(definition.receive)
  if (!sameMembers(liveNames, receiveNames)) {
    throw new Error(
      `[microdots] <${surface.tag}> live attributes [${liveNames.join(', ')}] and receive handlers [${receiveNames.join(', ')}] must match exactly`,
    )
  }

  const publishNames = Object.keys(definition.publish)
  if (!sameMembers(eventNames, publishNames)) {
    throw new Error(
      `[microdots] <${surface.tag}> declared events [${eventNames.join(', ')}] and publish selectors [${publishNames.join(', ')}] must match exactly`,
    )
  }

  for (const name of attributeNames) {
    const spec = surface.attributes[name]
    if (spec === undefined) {
      continue
    }
    if (spec.required === true && spec.default !== undefined) {
      throw new Error(
        `[microdots] <${surface.tag}> attribute "${name}" is required and cannot also carry a default`,
      )
    }
    if ((spec.type === 'enum') !== (spec.values !== undefined)) {
      throw new Error(
        `[microdots] <${surface.tag}> attribute "${name}" must declare values exactly when its type is 'enum'`,
      )
    }
  }
}

/**
 * Wraps a Foldkit program as a custom element with the lifecycle wired up:
 *
 *   connectedCallback        -> embed into a container that has an id
 *   disconnectedCallback     -> dispose the runtime
 *   attributeChangedCallback -> inbound port
 *   outbound port            -> bubbling CustomEvent
 *
 * One definition shape: the surface shape, whose declaration also feeds the
 * build-emitted manifest. The retired pre-surface shape gets a legible throw —
 * see the guard below.
 */
export function defineMicroDot<
  Handle extends Disposable,
  const Surface extends MicroDotSurface,
>(definition: MicroDotSurfaceDefinition<Handle, Surface>): void {
  // The type system cannot protect a JS caller: a pre-migration `.workspace`
  // snapshot rebuilt against the current framework reaches this at RUNTIME
  // (vite strips types without checking them), where the legacy shape used to
  // render nothing with a clean console. Fail loudly and say what to do.
  if (!('surface' in definition)) {
    throw new Error(
      `[microdots] ${legacyTagOf(definition)} uses the retired legacy defineMicroDot shape — re-express it with makeMicroDotSurface; see packages/microdots-element/src/manifest.ts`,
    )
  }

  const tag = definition.surface.tag
  const defaults: Readonly<Record<string, string>> = Record.map(
    definition.surface.attributes,
    spec => spec.default ?? '',
  )
  // Widened once: `receive` is keyed by the surface's literal live attribute
  // names, which cannot be indexed by a runtime string.
  const receiveHandlers: Readonly<
    Record<string, (handle: Handle, value: string) => void>
  > = definition.receive

  validateSurfaceDefinition(definition)

  class MicroDotElement extends HTMLElement {
    /**
     * `theme` is appended for every MicroDot: theming is infrastructure, so no
     * app.ts declares it, handles it, or knows it exists.
     */
    static readonly observedAttributes = [
      ...Object.keys(receiveHandlers).filter(name => name !== THEME_ATTRIBUTE),
      THEME_ATTRIBUTE,
    ]

    #maybeHandle: Option.Option<Handle> = Option.none()

    connectedCallback(): void {
      // Before `embed`, so the very first paint is already marked and themed.
      this.setAttribute(MICRODOT_ATTRIBUTE, '')

      const handle = definition.embed(
        mountPoint(this),
        readAttributes(this, defaults),
      )

      // The framework owns the dispatch: iterate the declared events, so an
      // event in the surface cannot silently go unpublished.
      for (const [eventName, selectPort] of Object.entries(
        definition.publish,
      )) {
        selectPort(handle).subscribe(detail => {
          this.dispatchEvent(
            new CustomEvent(eventName, { detail, bubbles: true }),
          )
        })
      }

      this.#maybeHandle = Option.some(handle)
    }

    disconnectedCallback(): void {
      Option.match(this.#maybeHandle, {
        onNone: Function.constVoid,
        onSome: handle => {
          handle.dispose()
        },
      })
      this.#maybeHandle = Option.none()
      this.replaceChildren()
    }

    attributeChangedCallback(
      name: string,
      _previous: string | null,
      next: string | null,
    ): void {
      // Intercepted BEFORE delegation and never forwarded — see THEME_ATTRIBUTE.
      // This also fires on custom-element upgrade (a foreign host parsing
      // `<readout-view theme="dark">`) and on a setAttribute before connect (the
      // host loader's path), so no connectedCallback re-sync is needed.
      if (name === THEME_ATTRIBUTE) {
        applyTheme(this, next)
        return
      }

      // Looked up by name rather than delegated blind, so a second observed
      // attribute reaches its own port instead of the first one's.
      const handler = receiveHandlers[name]
      if (handler === undefined) {
        return
      }

      const fallback = defaults[name] ?? ''
      Option.match(this.#maybeHandle, {
        onNone: Function.constVoid,
        onSome: handle => {
          handler(handle, next ?? fallback)
        },
      })
    }
  }

  if (customElements.get(tag) === undefined) {
    injectStyles(tag, definition.styles)
    customElements.define(tag, MicroDotElement)
  }
}

const injectStyles = (tag: string, styles: string | undefined): void => {
  if (styles === undefined) {
    return
  }
  const marker = `microdot-styles-${tag}`
  if (document.getElementById(marker) !== null) {
    return
  }
  const element = document.createElement('style')
  element.id = marker
  element.textContent = styles
  document.head.appendChild(element)
}

import { Option } from 'effect'

/**
 * Foldkit keys HMR model preservation off the container's `id` and throws
 * "Runtime container must have an `id`" without one. `Runtime.embed` runs the
 * runtime in a forked fiber, so that defect never reaches the console: the
 * widget just renders nothing, forever, with a clean console.
 *
 * Every MicroDot mounts through here so the invariant holds by construction.
 */
/** Ids handed out so far, per tag. A live-DOM count reused an id the moment
 *  an earlier instance unmounted; a counter never does. */
const handedOut = new Map<string, number>()

export const mountId = (element: HTMLElement): string => {
  const tag = element.tagName.toLowerCase()
  return Option.match(Option.fromNullishOr(element.id || null), {
    onNone: () => {
      const next = handedOut.get(tag) ?? 0
      handedOut.set(tag, next + 1)
      return `${tag}-mount-${String(next)}`
    },
    onSome: hostId => `${hostId}-mount`,
  })
}

/**
 * Creates the container Foldkit renders into.
 *
 * NOTE: `Runtime.embed` *replaces* this node with the rendered root, so this
 * element is detached the moment the runtime starts. Never assert against its
 * `innerHTML` — check the parent instead.
 */
export const mountPoint = (element: HTMLElement): HTMLElement => {
  const container = document.createElement('div')
  container.id = mountId(element)
  element.appendChild(container)
  return container
}

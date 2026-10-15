/**
 * Shared render observation — the five (plus `embed`) reasons `renderGate`
 * classifies, and the parent-is-authority DOM check both the verify probe and
 * the live sentinel use.
 *
 * The live path must not fork a second Foldkit program. It reuses the reasons
 * and the assertion target; it does not reuse `probeProgramStart`.
 */

export type RenderFailureReason =
  | 'environment'
  | 'startup-defect'
  | 'startup-exit'
  | 'blank'
  | 'timeout'
  | 'embed'

const REASONS: ReadonlyArray<RenderFailureReason> = [
  'environment',
  'startup-defect',
  'startup-exit',
  'blank',
  'timeout',
  'embed',
]

export const isRenderFailureReason = (
  value: unknown,
): value is RenderFailureReason =>
  typeof value === 'string' &&
  REASONS.some(reason => reason === value)

/** Same window the verify probe uses before calling a started runtime blank. */
export const RENDER_BLANK_SETTLE_MS = 750

export const RENDER_FAILURE_EVENT = 'microdots:render-failure'

export const RENDER_FAILURE_ATTRIBUTE = 'data-microdot-render-failure'

export const RENDER_FAILURE_SURFACE = 'data-microdot-render-failure-surface'

export type RenderFailureDetail = {
  readonly tag: string
  readonly reason: RenderFailureReason
  readonly detail: string
  readonly at: number
}

export const renderFailureLabel = (reason: RenderFailureReason): string => {
  switch (reason) {
    case 'environment':
      return 'No document to render into'
    case 'startup-defect':
      return 'Failed to start'
    case 'startup-exit':
      return 'Runtime exited'
    case 'blank':
      return 'Rendered nothing'
    case 'timeout':
      return 'Timed out before render'
    case 'embed':
      return 'Failed to embed'
  }
}

/**
 * Runtime.embed replaces the mount container. Inspecting `mount.innerHTML`
 * would certify a stale detached node. A same-tag root may instead patch the
 * original node in place, so the parent remains the authority while the
 * pristine mount is explicitly excluded from success.
 *
 * `isIgnored` lets the live sentinel exclude its own failure surface so the
 * overlay cannot certify itself as a render.
 */
export const hasRenderedDom = (
  parent: HTMLElement,
  originalMount: HTMLElement,
  isIgnored?: (element: Element) => boolean,
): boolean => {
  const ignored = (element: Element): boolean => isIgnored?.(element) === true

  if (parent.contains(originalMount) && !ignored(originalMount)) {
    return (
      originalMount.childNodes.length > 0 || originalMount.attributes.length > 1
    )
  }

  const elements = Array.from(parent.querySelectorAll('*')).filter(
    element => !ignored(element),
  )
  if (elements.length > 0) {
    return true
  }

  if (isIgnored === undefined) {
    return (parent.textContent?.trim().length ?? 0) > 0
  }

  let text = ''
  const walk = (node: Node): void => {
    if (node instanceof Element && ignored(node)) {
      return
    }
    if (node.nodeType === Node.TEXT_NODE) {
      text += node.textContent ?? ''
      return
    }
    node.childNodes.forEach(walk)
  }
  walk(parent)
  return text.trim().length > 0
}

export const isRenderFailureSurface = (element: Element): boolean =>
  element.closest(`[${RENDER_FAILURE_SURFACE}]`) !== null

import {
  RENDER_BLANK_SETTLE_MS,
  RENDER_FAILURE_ATTRIBUTE,
  RENDER_FAILURE_EVENT,
  RENDER_FAILURE_SURFACE,
  type RenderFailureDetail,
  type RenderFailureReason,
  hasRenderedDom,
  isRenderFailureSurface,
  renderFailureLabel,
} from './renderObservation.ts'

const STYLE_ID = 'microdot-styles-render-failure'
const DETAIL_LIMIT = 200

const SURFACE_CSS = `[${RENDER_FAILURE_SURFACE}] {
  box-sizing: border-box;
  margin: var(--sp-3, 12px);
  padding: var(--sp-3, 12px) var(--sp-4, 16px);
  border: var(--bw-default, 1px) solid var(--status-error-border, rgba(220, 38, 38, 0.15));
  border-radius: var(--radius-md, 10px);
  background: var(--status-error-bg, rgba(220, 38, 38, 0.07));
  color: var(--status-error-fg, #b91c1c);
  font-family: var(--font-body, inherit);
  font-size: 0.875rem;
  line-height: 1.4;
  letter-spacing: var(--ls-normal, 0.04em);
}
[${RENDER_FAILURE_SURFACE}] strong {
  display: block;
  font-weight: 600;
  margin-bottom: var(--sp-1, 4px);
}
[${RENDER_FAILURE_SURFACE}] span {
  display: block;
  color: var(--text-secondary, inherit);
  font-family: var(--font-mono, ui-monospace, monospace);
  font-size: 0.75rem;
  word-break: break-word;
}`

export const injectRenderFailureStyles = (): void => {
  if (document.getElementById(STYLE_ID) !== null) {
    return
  }
  const element = document.createElement('style')
  element.id = STYLE_ID
  element.textContent = SURFACE_CSS
  document.head.appendChild(element)
}

const truncate = (value: string): string =>
  value.length <= DETAIL_LIMIT ? value : `${value.slice(0, DETAIL_LIMIT)}…`

const paintSurface = (
  element: HTMLElement,
  reason: RenderFailureReason,
  detail: string,
): void => {
  injectRenderFailureStyles()
  element.setAttribute(RENDER_FAILURE_ATTRIBUTE, reason)

  const existing = element.querySelector(`[${RENDER_FAILURE_SURFACE}]`)
  const surface =
    existing instanceof HTMLElement ? existing : document.createElement('div')
  surface.setAttribute(RENDER_FAILURE_SURFACE, '')
  surface.setAttribute('role', 'status')
  surface.setAttribute('aria-live', 'polite')

  const title = document.createElement('strong')
  title.textContent = renderFailureLabel(reason)
  const body = document.createElement('span')
  body.textContent = truncate(detail)
  surface.replaceChildren(title, body)
  if (surface.parentElement !== element) {
    element.appendChild(surface)
  }
}

const announce = (
  element: HTMLElement,
  tag: string,
  reason: RenderFailureReason,
  detail: string,
): void => {
  paintSurface(element, reason, detail)
  const payload: RenderFailureDetail = {
    tag,
    reason,
    detail,
    at: Date.now(),
  }
  element.dispatchEvent(
    new CustomEvent(RENDER_FAILURE_EVENT, {
      detail: payload,
      bubbles: true,
      composed: true,
    }),
  )
}

const clearSurface = (element: HTMLElement): void => {
  element.removeAttribute(RENDER_FAILURE_ATTRIBUTE)
  element.querySelectorAll(`[${RENDER_FAILURE_SURFACE}]`).forEach(node => {
    node.remove()
  })
}

export const messageFromUnknown = (error: unknown): string => {
  if (error instanceof Error && error.message !== '') {
    return error.message
  }
  if (typeof error === 'string' && error !== '') {
    return error
  }
  return 'embed threw'
}

export type LiveRenderWatch = {
  readonly cancel: () => void
}

/**
 * Cheap live cousin of `runRenderGate`. Watches the already-started mount;
 * never forks a second Foldkit program. A blank after `RENDER_BLANK_SETTLE_MS`
 * is named and dispatched. Content that arrives later removes the overlay.
 */
export const watchLiveRender = (
  element: HTMLElement,
  originalMount: HTMLElement,
  tag: string,
): LiveRenderWatch => {
  let cancelled = false
  let announced = false

  const rendered = (): boolean =>
    hasRenderedDom(element, originalMount, isRenderFailureSurface)

  const failBlank = (): void => {
    if (cancelled || announced || !element.isConnected) {
      return
    }
    if (rendered()) {
      return
    }
    announced = true
    announce(
      element,
      tag,
      'blank',
      'Runtime started but produced no rendered DOM element',
    )
  }

  const onMutate = (): void => {
    if (cancelled || !element.isConnected) {
      return
    }
    if (!rendered()) {
      return
    }
    if (announced) {
      clearSurface(element)
    }
    window.clearTimeout(timer)
  }

  const timer = window.setTimeout(failBlank, RENDER_BLANK_SETTLE_MS)
  const observer = new MutationObserver(onMutate)
  observer.observe(element, {
    childList: true,
    subtree: true,
    characterData: true,
  })
  if (rendered()) {
    window.clearTimeout(timer)
    observer.disconnect()
    return {
      cancel: () => {
        cancelled = true
      },
    }
  }

  return {
    cancel: () => {
      cancelled = true
      window.clearTimeout(timer)
      observer.disconnect()
    },
  }
}

export const announceEmbedFailure = (
  element: HTMLElement,
  tag: string,
  error: unknown,
): void => {
  announce(element, tag, 'embed', messageFromUnknown(error))
}

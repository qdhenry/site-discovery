import { Cause, Effect, Exit, Fiber } from 'effect'
import { Runtime } from 'foldkit'
import type { Ports } from 'foldkit/port'

import {
  RENDER_BLANK_SETTLE_MS,
  type RenderFailureReason,
  hasRenderedDom,
} from './renderObservation.ts'

export type RenderProgram = Runtime.MakeRuntimeReturn<Ports | undefined>

/**
 * The later pipeline dynamically imports generated code and supplies this
 * factory. This module therefore has no compile-time dependency on a workspace.
 * It is called twice so the direct-start probe and Runtime.embed own distinct
 * Foldkit program instances and containers.
 */
export type RenderProgramLoader = (
  container: HTMLElement,
) => Promise<RenderProgram> | RenderProgram

export type RenderGateInput = {
  readonly loadProgram: RenderProgramLoader
  readonly document?: Document
  readonly timeoutMs?: number
  readonly startupProbeMs?: number
  readonly blankSettleMs?: number
}

export type RenderGateResult = {
  readonly elementCount: number
  readonly text: string
}

export class RenderGateFailure extends Error {
  override readonly name = 'RenderGateFailure'

  constructor(
    readonly reason: RenderFailureReason,
    readonly detail: string,
    readonly startExit?: Exit.Exit<void, never>,
    override readonly cause?: unknown,
  ) {
    super(detail)
  }
}

const wait = (milliseconds: number): Promise<void> =>
  new Promise(resolveWait => {
    setTimeout(resolveWait, milliseconds)
  })

const within = <Value>(
  promise: Promise<Value>,
  milliseconds: number,
): Promise<Value> =>
  new Promise((resolveWithin, rejectWithin) => {
    const timeout = setTimeout(
      () => {
        rejectWithin(
          new RenderGateFailure('timeout', 'Render gate exceeded its deadline'),
        )
      },
      Math.max(0, milliseconds),
    )
    promise.then(
      value => {
        clearTimeout(timeout)
        resolveWithin(value)
      },
      error => {
        clearTimeout(timeout)
        rejectWithin(error)
      },
    )
  })

const remaining = (deadline: number): number =>
  Math.max(0, deadline - Date.now())

const makeMount = (
  document: Document,
  suffix: string,
): { readonly parent: HTMLDivElement; readonly mount: HTMLDivElement } => {
  const parent = document.createElement('div')
  const mount = document.createElement('div')
  // globalThis.crypto, not node:crypto — this module must stay browser-clean so
  // the probe can run wherever a MicroDot can (the reason it left the builder).
  mount.id = `microdot-render-${suffix}-${crypto.randomUUID()}`
  parent.appendChild(mount)
  document.body.appendChild(parent)
  return { parent, mount }
}

const probeProgramStart = async (
  program: RenderProgram,
  probeMs: number,
): Promise<void> => {
  const fiber = Effect.runFork(program.start())
  const outcome = await Promise.race([
    Effect.runPromise(Fiber.await(fiber)).then(exit => ({
      _tag: 'Exit' as const,
      exit,
    })),
    wait(probeMs).then(() => ({ _tag: 'StillRunning' as const })),
  ])
  if (outcome._tag === 'StillRunning') {
    await Effect.runPromise(Fiber.interrupt(fiber))
    return
  }
  if (Exit.isFailure(outcome.exit)) {
    throw new RenderGateFailure(
      'startup-defect',
      Cause.pretty(outcome.exit.cause),
      outcome.exit,
    )
  }
  throw new RenderGateFailure(
    'startup-exit',
    'Foldkit program.start exited before establishing its runtime loop',
    outcome.exit,
  )
}

const execute = async (input: RenderGateInput): Promise<RenderGateResult> => {
  const document = input.document ?? globalThis.document
  if (document?.body === undefined) {
    throw new RenderGateFailure(
      'environment',
      'Render gate requires a headless DOM document with a body',
    )
  }
  const timeoutMs = input.timeoutMs ?? 2_000
  const startupProbeMs = Math.min(input.startupProbeMs ?? 100, timeoutMs)
  // Foldkit's development runtime gives the HMR model bridge a bounded chance
  // to answer before its first render. The vendored runtime uses a 500 ms
  // fallback when no Vite plugin is present, so a shorter blank window creates
  // a false negative in the headless Check environment.
  const blankSettleMs = input.blankSettleMs ?? RENDER_BLANK_SETTLE_MS
  const deadline = Date.now() + timeoutMs

  const probe = makeMount(document, 'probe')
  try {
    const program = await within(
      Promise.resolve(input.loadProgram(probe.mount)),
      remaining(deadline),
    )
    await within(
      probeProgramStart(program, Math.min(startupProbeMs, remaining(deadline))),
      remaining(deadline),
    )
  } finally {
    probe.parent.remove()
  }

  const render = makeMount(document, 'embed')
  let handle: Runtime.EmbedHandle<Ports | undefined> | undefined
  try {
    const program = await within(
      Promise.resolve(input.loadProgram(render.mount)),
      remaining(deadline),
    )
    try {
      handle = Runtime.embed(program)
    } catch (error) {
      throw new RenderGateFailure(
        'embed',
        'Runtime.embed rejected the generated program',
        undefined,
        error,
      )
    }

    const embeddedAt = Date.now()
    while (Date.now() <= deadline) {
      // Runtime.embed replaces the mount container. Inspecting mount.innerHTML
      // would certify a stale detached node. A same-tag root may instead patch
      // the original node in place, so the parent remains the authority while
      // the pristine mount is explicitly excluded from success.
      if (hasRenderedDom(render.parent, render.mount)) {
        return {
          elementCount: render.parent.querySelectorAll('*').length,
          text: render.parent.textContent ?? '',
        }
      }
      if (Date.now() - embeddedAt >= blankSettleMs) {
        throw new RenderGateFailure(
          'blank',
          'Runtime started but produced no rendered DOM element',
        )
      }
      await wait(Math.min(5, Math.max(1, remaining(deadline))))
    }
    throw new RenderGateFailure('timeout', 'Generated program did not render')
  } finally {
    handle?.dispose()
    render.parent.remove()
  }
}

export const runRenderGate = (
  input: RenderGateInput,
): Effect.Effect<RenderGateResult, RenderGateFailure> =>
  Effect.tryPromise({
    try: () => execute(input),
    catch: error =>
      error instanceof RenderGateFailure
        ? error
        : new RenderGateFailure(
            'embed',
            'Unexpected render-gate failure',
            undefined,
            error,
          ),
  })

import { isAbsolute, join, resolve } from 'node:path'

export const MICRODOT_STATE_ROOT_VARIABLE = 'MICRODOT_STATE_ROOT'

type EnvironmentLike = Readonly<Record<string, string | undefined>>

const microDotPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const filePattern = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/

const configuredRoot = (environment: EnvironmentLike): string | undefined => {
  const raw = environment[MICRODOT_STATE_ROOT_VARIABLE]
  if (raw === undefined || raw.trim() === '') return undefined
  const trimmed = raw.trim()
  if (trimmed.includes('\0')) {
    throw new Error(`${MICRODOT_STATE_ROOT_VARIABLE} contains NUL`)
  }
  if (!isAbsolute(trimmed)) {
    throw new Error(`${MICRODOT_STATE_ROOT_VARIABLE} must be absolute`)
  }
  const root = resolve(trimmed)
  if (root === '/') {
    throw new Error(
      `${MICRODOT_STATE_ROOT_VARIABLE} must not be the filesystem root`,
    )
  }
  return root
}

const assertMicroDot = (microDot: string): void => {
  if (!microDotPattern.test(microDot)) {
    throw new Error(
      `invalid MicroDot state namespace ${JSON.stringify(microDot)}`,
    )
  }
}

/**
 * Opt-in local state isolation for service processes. With no shared root this
 * returns the existing per-MicroDot default byte for byte. A benchmark or test
 * can set one absolute root and receive a namespaced directory for every local
 * SQLite-backed service without changing deployment bindings.
 */
export const resolveMicroDotStateRoot = (input: {
  readonly microDot: string
  readonly defaultRoot: string
  readonly environment?: EnvironmentLike
}): string => {
  assertMicroDot(input.microDot)
  const root = configuredRoot(input.environment ?? process.env)
  return root === undefined ? input.defaultRoot : join(root, input.microDot)
}

export const resolveMicroDotStatePath = (input: {
  readonly microDot: string
  readonly filename: string
  readonly defaultPath: string
  readonly environment?: EnvironmentLike
}): string => {
  assertMicroDot(input.microDot)
  if (!filePattern.test(input.filename)) {
    throw new Error(
      `invalid MicroDot state filename ${JSON.stringify(input.filename)}`,
    )
  }
  const root = configuredRoot(input.environment ?? process.env)
  return root === undefined
    ? input.defaultPath
    : join(root, input.microDot, input.filename)
}

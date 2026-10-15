import type { Plugin, UserConfig } from 'vite'

export type EmitTarget = {
  readonly repoRoot: string
  readonly name: string
  readonly dotDir: string
}

export declare const emitTargetFor: (dotDir: string) => EmitTarget | undefined

export declare const emitDeclinedMessage: (dotDir: string) => string

export declare const emitMicroDotManifest: (dotDir: string) => Plugin

export declare const emitManifestNow: (dotDir: string) => Promise<void>

export declare const WATCH_SETTLE_MS: number

export declare const watchSettleConfig: (
  config: UserConfig,
) => UserConfig | undefined

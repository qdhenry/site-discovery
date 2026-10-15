import { resolve } from 'node:path'

import { type Configuration, DiscoveryError } from '../src/contract.ts'

export const fail = (
  code: DiscoveryError['code'],
  message: string,
  retryable = false,
): never => {
  throw new DiscoveryError({ code, message, retryable })
}
export type Environment = Readonly<Record<string, string | undefined>>
export type Config = {
  stateDir: string
  fixtureEnabled: boolean
  modelCatalogFixture: boolean
  accountId: string
  browserToken: string
  gatewayToken: string
  gatewayId: string
  anthropicKey: string
  model: string
  runLimitUsd: number
  monthlyLimitUsd: number
  attemptReservationUsd: number
  ownerToken: string
}
const positive = (raw: string | undefined): number => {
  const value = Number(raw)
  return Number.isFinite(value) && value > 0 ? value : 0
}
export const readConfig = (env: Environment = process.env): Config => ({
  stateDir: resolve(env.DISCOVERY_STATE_DIR || '.local/discovery'),
  fixtureEnabled: env.DISCOVERY_FIXTURES === '1',
  modelCatalogFixture:
    env.DISCOVERY_FIXTURES === '1' &&
    env.DISCOVERY_MODEL_CATALOG_FIXTURE === '1',
  accountId: env.CLOUDFLARE_ACCOUNT_ID || '',
  browserToken: env.CLOUDFLARE_BROWSER_API_TOKEN || '',
  gatewayToken: env.AI_GATEWAY_API_TOKEN || '',
  gatewayId: env.CLOUDFLARE_AI_GATEWAY_ID || '',
  anthropicKey: env.ANTHROPIC_API_KEY || '',
  model: env.DISCOVERY_MODEL || 'claude-sonnet-4-6',
  runLimitUsd: positive(env.DISCOVERY_RUN_LIMIT_USD),
  monthlyLimitUsd: positive(env.DISCOVERY_MONTHLY_LIMIT_USD),
  attemptReservationUsd: positive(env.DISCOVERY_ATTEMPT_RESERVATION_USD),
  ownerToken: env.DISCOVERY_OWNER_TOKEN || '',
})
export const configuration = (c: Config): Configuration => {
  const missingCapture = [
    !c.accountId && 'CLOUDFLARE_ACCOUNT_ID',
    !c.browserToken && 'CLOUDFLARE_BROWSER_API_TOKEN',
  ].filter((x): x is string => !!x)
  const missingAnalysis = [
    !c.accountId && 'CLOUDFLARE_ACCOUNT_ID',
    !c.gatewayId && 'CLOUDFLARE_AI_GATEWAY_ID',
    !c.gatewayToken && 'AI_GATEWAY_API_TOKEN',
    !c.anthropicKey && 'ANTHROPIC_API_KEY',
    !c.runLimitUsd && 'DISCOVERY_RUN_LIMIT_USD',
    !c.monthlyLimitUsd && 'DISCOVERY_MONTHLY_LIMIT_USD',
    !c.attemptReservationUsd && 'DISCOVERY_ATTEMPT_RESERVATION_USD',
  ].filter((x): x is string => !!x)
  return {
    fixtureEnabled: c.fixtureEnabled,
    captureReady: missingCapture.length === 0,
    analysisReady: missingAnalysis.length === 0,
    missingCapture,
    missingAnalysis,
    model: c.model,
    runLimitUsd: c.runLimitUsd,
    monthlyLimitUsd: c.monthlyLimitUsd,
    attemptReservationUsd: c.attemptReservationUsd,
  }
}

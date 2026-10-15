/** Unit tests inject deterministic metadata transport; no Anthropic request is made. */
import { fixtureCatalogOptions } from '../catalog-fixture.ts'
import type { Config } from '../config.ts'
import { DiscoveryEngine, type EngineOptions } from '../engine.ts'
import { createProviders } from '../providers.ts'

export function openTestEngine(config: Config, options: EngineOptions = {}) {
  const providers = options.providers ?? createProviders(config)
  return DiscoveryEngine.open(config, {
    ...options,
    catalog:
      options.catalog ??
      fixtureCatalogOptions(
        providers.models,
        config.anthropicKey ? 'anthropic-api' : 'fixture',
      ),
  })
}

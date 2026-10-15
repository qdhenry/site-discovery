import { Schema as S } from 'effect'

// Explicit .ts extensions throughout this package: it can sit on a vite-config
// import chain, where node type-strips and resolves relative TS imports only
// with the extension spelled out — the same rule packages/microdots-host
// follows (wiki/patterns-and-traps/a-workspace-package-import-kills-a-vite-config.md).
import { rawCatalogIndex } from './catalogData.ts'
import {
  CATALOG_VERSION,
  CatalogLeaf,
  SLOT_NAMES,
  type SlotName,
} from './schema.ts'

const CatalogFile = S.Struct({
  catalogVersion: S.Literal(CATALOG_VERSION),
  leaves: S.Array(CatalogLeaf),
})

export const catalogFile = S.decodeUnknownSync(CatalogFile)(rawCatalogIndex)

export const leaves: ReadonlyArray<CatalogLeaf> = catalogFile.leaves

export const leafById = new Map(leaves.map(leaf => [leaf.id, leaf]))

export const implementedLeaves = (): ReadonlyArray<CatalogLeaf> =>
  leaves.filter(leaf => leaf.implemented && !leaf.deprecated)

export const knownSlot = (name: string): name is SlotName =>
  SLOT_NAMES.some(slot => slot === name)

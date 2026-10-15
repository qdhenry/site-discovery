import { Schema as S } from 'effect'

export const CATALOG_VERSION = 1 as const

export const SLOT_NAMES = [
  'readout',
  'list',
  'detail',
  'form',
  'create',
  'update',
  'search',
  'filter',
  'status',
  'empty',
  'disclosure',
  'confirm',
] as const
export type SlotName = (typeof SLOT_NAMES)[number]

export const SlotName = S.Literals(SLOT_NAMES)

export const Density = S.Literals(['compact', 'comfortable'])
export type Density = typeof Density.Type

export const IntentSlots = S.Struct({
  readout: S.Boolean,
  list: S.Boolean,
  detail: S.Boolean,
  form: S.Boolean,
  create: S.Boolean,
  update: S.Boolean,
  search: S.Boolean,
  filter: S.Boolean,
  status: S.Boolean,
  empty: S.Boolean,
  disclosure: S.Boolean,
  confirm: S.Boolean,
  density: Density,
})
export type IntentSlots = typeof IntentSlots.Type

export const IntentV1 = S.Struct({
  catalogVersion: S.Literal(CATALOG_VERSION),
  slots: IntentSlots,
})
export type IntentV1 = typeof IntentV1.Type

export type TreeNode = {
  readonly leafId: string
  readonly children: ReadonlyArray<TreeNode>
}

export const isTreeNode = (value: unknown): value is TreeNode => {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  if (!('leafId' in value) || typeof value.leafId !== 'string') {
    return false
  }
  if (!('children' in value) || !Array.isArray(value.children)) {
    return false
  }
  return value.children.every(isTreeNode)
}

export const TreeNode = S.declare(isTreeNode)

export const RecipeName = S.Literals([
  'empty',
  'form',
  'list',
  'list-detail',
  'readout',
  'fallback',
])
export type RecipeName = typeof RecipeName.Type

export const TreeV1 = S.Struct({
  catalogVersion: S.Literal(CATALOG_VERSION),
  recipe: RecipeName,
  root: TreeNode,
})
export type TreeV1 = typeof TreeV1.Type

export const CatalogLeaf = S.Struct({
  id: S.String,
  implemented: S.Boolean,
  deprecated: S.Boolean,
  covers: S.Array(SlotName),
  hints: S.Array(S.String),
  allowedParents: S.Array(S.String),
})
export type CatalogLeaf = typeof CatalogLeaf.Type

export const emptySlots = (density: Density = 'comfortable'): IntentSlots => ({
  readout: false,
  list: false,
  detail: false,
  form: false,
  create: false,
  update: false,
  search: false,
  filter: false,
  status: false,
  empty: false,
  disclosure: false,
  confirm: false,
  density,
})

export const intentWith = (
  flags: Partial<Omit<IntentSlots, 'density'>>,
  density: Density = 'comfortable',
): IntentV1 => ({
  catalogVersion: CATALOG_VERSION,
  slots: { ...emptySlots(density), ...flags },
})

export const STRUCTURAL_IDS: ReadonlySet<string> = new Set([
  'page',
  'header',
  'card',
])

export const FIELD_IDS: ReadonlyArray<string> = [
  'checkbox',
  'select',
  'text-field',
  'textarea',
]

export const MAX_DEPTH = 6
export const MAX_NODES = 40
export const LIST_ROW_COPIES = 3

import { implementedLeaves, knownSlot, leafById } from './catalog.ts'
import {
  type CatalogLeaf,
  FIELD_IDS,
  type IntentSlots,
  type IntentV1,
  LIST_ROW_COPIES,
  MAX_DEPTH,
  MAX_NODES,
  type RecipeName,
  SLOT_NAMES,
  STRUCTURAL_IDS,
  type SlotName,
  type TreeNode,
  type TreeV1,
  emptySlots,
} from './schema.ts'

export type MapOutcome =
  | { readonly _tag: 'Mapped'; readonly tree: TreeV1 }
  | {
      readonly _tag: 'InventedIds'
      readonly inventedIds: ReadonlyArray<string>
    }
  | { readonly _tag: 'UncoveredSlots'; readonly slots: ReadonlyArray<string> }
  | {
      readonly _tag: 'TreeTooLarge'
      readonly depth: number
      readonly nodes: number
    }
  | { readonly _tag: 'InvalidIntent'; readonly message: string }

const node = (
  leafId: string,
  children: ReadonlyArray<TreeNode> = [],
): TreeNode => ({ leafId, children })

export const assertedSlots = (slots: IntentSlots): ReadonlyArray<SlotName> =>
  SLOT_NAMES.filter(name => slots[name])

const coversSlot = (leaf: CatalogLeaf, slot: SlotName): boolean =>
  leaf.covers.includes(slot)

const coverageOf = (
  group: ReadonlyArray<CatalogLeaf>,
  asserted: ReadonlyArray<SlotName>,
): ReadonlySet<SlotName> => {
  const covered = new Set<SlotName>()
  for (const leaf of group) {
    for (const slot of leaf.covers) {
      if (asserted.includes(slot)) {
        covered.add(slot)
      }
    }
  }
  return covered
}

const optionalCovers = (
  optionals: ReadonlyArray<CatalogLeaf>,
  slot: SlotName,
): boolean => optionals.some(leaf => coversSlot(leaf, slot))

/**
 * Drop an optional leaf (reverse id-sort) only when every slot it covers is
 * still covered by another remaining *optional*. Containers (`page`,
 * `header`, `card`) supply coverage only when no optional exists for that
 * slot — otherwise a form would collapse to an empty card.
 */
export const pruneOptionals = (
  optionals: ReadonlyArray<CatalogLeaf>,
  asserted: ReadonlyArray<SlotName>,
): ReadonlyArray<CatalogLeaf> => {
  const remaining = [...optionals].sort((left, right) =>
    left.id < right.id ? -1 : left.id > right.id ? 1 : 0,
  )
  for (let index = remaining.length - 1; index >= 0; index -= 1) {
    const candidate = remaining[index]
    if (candidate === undefined) {
      continue
    }
    const without = remaining.filter((_, position) => position !== index)
    const stillCovered = asserted.every(
      slot => !coversSlot(candidate, slot) || optionalCovers(without, slot),
    )
    if (stillCovered) {
      remaining.splice(index, 1)
    }
  }
  return remaining
}

const pickRecipe = (slots: IntentSlots): RecipeName => {
  if (slots.list && slots.detail) {
    return 'list-detail'
  }
  if (slots.form && !slots.list) {
    return 'form'
  }
  if (slots.list && !slots.detail) {
    return 'list'
  }
  if (slots.readout && !slots.list && !slots.form && !slots.detail) {
    return 'readout'
  }
  if (
    assertedSlots(slots).length === 0 ||
    (slots.empty &&
      !slots.list &&
      !slots.form &&
      !slots.readout &&
      !slots.detail)
  ) {
    return 'empty'
  }
  return 'fallback'
}

const isTreeNodeValue = (value: TreeNode | null): value is TreeNode =>
  value !== null

const compact = (
  nodes: ReadonlyArray<TreeNode | null>,
): ReadonlyArray<TreeNode> => nodes.filter(isTreeNodeValue)

const listRows = (withBadge: boolean): ReadonlyArray<TreeNode> =>
  Array.from({ length: LIST_ROW_COPIES }, () =>
    withBadge ? node('list-row', [node('badge')]) : node('list-row'),
  )

export const assembleTree = (
  pruned: ReadonlyArray<CatalogLeaf>,
  intent: IntentV1,
): TreeV1 => {
  const recipe = pickRecipe(intent.slots)
  const slots = intent.slots
  const asserted = assertedSlots(slots)
  const used = new Set<string>()

  /**
   * Named-hole placement: a ruled skeleton part taken by id from the
   * implemented catalog rather than from the pruned set. Prune keeps a
   * minimal slot cover (alphabetically-first survivor), so parts like `rail`
   * and `pagination` never survive it — this generalizes the escape the v1
   * `take` granted `page`/`header`/`card`.
   */
  const takeImplemented = (id: string): TreeNode | null => {
    const leaf = leafById.get(id)
    if (leaf === undefined || !leaf.implemented || leaf.deprecated) {
      return null
    }
    used.add(id)
    return node(id)
  }

  const takeWhen = (condition: boolean, id: string): TreeNode | null =>
    condition ? takeImplemented(id) : null

  const headerNode = (withPill: boolean): TreeNode => {
    const pill = takeWhen(withPill && slots.status, 'pill')
    return pill === null ? node('header') : node('header', [pill])
  }

  const fields = pruned
    .filter(leaf => FIELD_IDS.includes(leaf.id))
    .map(leaf => {
      used.add(leaf.id)
      return node(leaf.id)
    })

  /**
   * Extras exist to keep the coverage guarantee: after the named holes are
   * filled, any asserted slot no placed (non-structural) leaf covers is
   * represented by its pruned coverer. A pruned leaf whose every asserted
   * slot is already represented is suppressed — otherwise a named
   * `status-dot` and a pruned `badge` would both appear for one slot.
   */
  const extras = (): ReadonlyArray<TreeNode> => {
    const represented = new Set<SlotName>()
    for (const id of used) {
      if (STRUCTURAL_IDS.has(id)) {
        continue
      }
      const leaf = leafById.get(id)
      if (leaf === undefined) {
        continue
      }
      for (const slot of leaf.covers) {
        if (asserted.includes(slot)) {
          represented.add(slot)
        }
      }
    }
    return pruned
      .filter(leaf => !used.has(leaf.id))
      .filter(leaf =>
        leaf.covers.some(
          slot => asserted.includes(slot) && !represented.has(slot),
        ),
      )
      .map(leaf => node(leaf.id))
  }

  const detailKids = (): ReadonlyArray<TreeNode> =>
    compact([
      ...fields,
      takeWhen(slots.status, 'status-dot'),
      takeWhen(slots.disclosure, 'accordion'),
      takeWhen(slots.confirm, 'banner'),
      takeWhen(slots.create || slots.update, 'button'),
    ])

  const searchAndFilter = (): ReadonlyArray<TreeNode> =>
    compact([
      takeWhen(slots.search, 'search-field'),
      takeWhen(slots.filter, 'filter-chip'),
    ])

  let root: TreeNode
  switch (recipe) {
    case 'empty':
      used.add('empty-state')
      root = node('page', [node('empty-state')])
      break
    case 'form': {
      const kids = compact([
        ...fields,
        takeWhen(slots.create || slots.update, 'button'),
        takeWhen(slots.confirm, 'banner'),
        takeWhen(slots.disclosure, 'accordion'),
        takeWhen(slots.status, 'status-dot'),
      ])
      used.add('card')
      root = node('page', [
        node('header'),
        node('card', [...kids, ...extras()]),
      ])
      break
    }
    case 'list': {
      const header = headerNode(true)
      const top = searchAndFilter()
      const badge = takeWhen(slots.status, 'badge')
      used.add('list-row')
      const rows = listRows(badge !== null)
      const pagination = takeImplemented('pagination')
      const empty = takeWhen(slots.empty, 'empty-state')
      root = node('page', [
        header,
        ...top,
        ...rows,
        ...compact([pagination, empty]),
        ...extras(),
      ])
      break
    }
    case 'list-detail': {
      const header = headerNode(true)
      const top = searchAndFilter()
      const badge = takeWhen(slots.status, 'badge')
      used.add('list-row')
      used.add('card')
      const rows = listRows(badge !== null)
      const kids = detailKids()
      const rail = takeImplemented('rail')
      const inspector = takeImplemented('inspector')
      const card = node('card', [...kids, ...extras()])
      root =
        rail !== null && inspector !== null
          ? node('page', [
              header,
              ...top,
              node('rail', rows),
              node('inspector', [card]),
            ])
          : node('page', [header, ...top, ...rows, card])
      break
    }
    case 'readout': {
      used.add('card')
      const kids = compact([
        takeImplemented('metric'),
        takeWhen(slots.status, 'status-dot'),
        takeWhen(slots.confirm, 'banner'),
      ])
      root = node('page', [
        node('header'),
        node('card', [...kids, ...extras()]),
      ])
      break
    }
    case 'fallback': {
      used.add('card')
      root = node('page', [node('header'), node('card', extras())])
      break
    }
  }

  return {
    catalogVersion: 1,
    recipe,
    root,
  }
}

export const treeStats = (
  tree: TreeNode,
): { readonly depth: number; readonly nodes: number } => {
  const walk = (
    current: TreeNode,
    depth: number,
  ): { depth: number; nodes: number } => {
    if (current.children.length === 0) {
      return { depth, nodes: 1 }
    }
    let maxDepth = depth
    let nodes = 1
    for (const child of current.children) {
      const inner = walk(child, depth + 1)
      if (inner.depth > maxDepth) {
        maxDepth = inner.depth
      }
      nodes += inner.nodes
    }
    return { depth: maxDepth, nodes }
  }
  return walk(tree, 1)
}

export const decodeIntent = (input: unknown): MapOutcome | IntentV1 => {
  if (typeof input !== 'object' || input === null) {
    return { _tag: 'InvalidIntent', message: 'Intent JSON did not decode' }
  }
  if (!('catalogVersion' in input) || input.catalogVersion !== 1) {
    return { _tag: 'InvalidIntent', message: 'catalogVersion must be 1' }
  }
  if (
    !('slots' in input) ||
    typeof input.slots !== 'object' ||
    input.slots === null
  ) {
    return { _tag: 'InvalidIntent', message: 'slots is required' }
  }
  const slotsValue = input.slots
  const raw: { readonly [key: string]: unknown } = Object.fromEntries(
    Object.entries(slotsValue),
  )
  const invented = Object.keys(raw).filter(
    key => key !== 'density' && !knownSlot(key),
  )
  if (invented.length > 0) {
    return { _tag: 'InventedIds', inventedIds: [...invented].sort() }
  }
  const density =
    raw.density === 'compact' || raw.density === 'comfortable'
      ? raw.density
      : 'comfortable'
  const slots = { ...emptySlots(density) }
  for (const name of SLOT_NAMES) {
    if (name in raw) {
      const value = raw[name]
      if (typeof value !== 'boolean') {
        return {
          _tag: 'InvalidIntent',
          message: `slot ${name} must be a boolean`,
        }
      }
      slots[name] = value
    }
  }
  return { catalogVersion: 1, slots }
}

export const mapIntent = (input: unknown): MapOutcome => {
  const decoded = decodeIntent(input)
  if ('_tag' in decoded) {
    return decoded
  }
  const asserted = assertedSlots(decoded.slots)
  if (asserted.length === 0) {
    const tree = assembleTree([], decoded)
    const stats = treeStats(tree.root)
    if (stats.depth > MAX_DEPTH || stats.nodes > MAX_NODES) {
      return { _tag: 'TreeTooLarge', depth: stats.depth, nodes: stats.nodes }
    }
    return { _tag: 'Mapped', tree }
  }

  const implemented = implementedLeaves()
  const matching = implemented.filter(leaf =>
    leaf.covers.some(slot => asserted.includes(slot)),
  )
  const optionals = matching.filter(leaf => !STRUCTURAL_IDS.has(leaf.id))
  const containers = matching.filter(leaf => STRUCTURAL_IDS.has(leaf.id))
  const covered = coverageOf([...optionals, ...containers], asserted)
  const uncovered = asserted.filter(slot => !covered.has(slot))
  if (uncovered.length > 0) {
    return { _tag: 'UncoveredSlots', slots: uncovered }
  }
  const pruned = pruneOptionals(optionals, asserted)
  const tree = assembleTree(pruned, decoded)
  const unknown = collectUnknownLeafIds(tree.root)
  if (unknown.length > 0) {
    return { _tag: 'InventedIds', inventedIds: unknown }
  }
  const stats = treeStats(tree.root)
  if (stats.depth > MAX_DEPTH || stats.nodes > MAX_NODES) {
    return { _tag: 'TreeTooLarge', depth: stats.depth, nodes: stats.nodes }
  }
  return { _tag: 'Mapped', tree }
}

export const collectUnknownLeafIds = (
  root: TreeNode,
): ReadonlyArray<string> => {
  const invented: string[] = []
  const walk = (current: TreeNode): void => {
    const leaf = leafById.get(current.leafId)
    if (leaf === undefined || (!leaf.implemented && !leaf.deprecated)) {
      invented.push(current.leafId)
    }
    for (const child of current.children) {
      walk(child)
    }
  }
  walk(root)
  return [...new Set(invented)].sort()
}

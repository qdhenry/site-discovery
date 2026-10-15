import type { Html, HtmlBuilder } from 'foldkit/html'

import { leafById } from './catalog.ts'
import { collectUnknownLeafIds } from './mapIntent.ts'
import { type Density, type TreeNode } from './schema.ts'

export type LeafRender<Msg> = {
  readonly path: string
  readonly density: Density
  readonly openPaths: ReadonlyArray<string>
  readonly onToggle: (path: string) => Msg
  /** The page title the header leaf shows; absent reads "Untitled" (F14). */
  readonly title?: string
}

const gap = (density: Density): string =>
  density === 'compact' ? 'gap-2' : 'gap-3'

const pad = (density: Density): string =>
  density === 'compact' ? 'p-3' : 'p-4'

type LeafViewArgs<Msg> = {
  readonly children: ReadonlyArray<Html>
  readonly childIds: ReadonlyArray<string>
  readonly ctx: LeafRender<Msg>
  readonly h: HtmlBuilder<Msg>
}

type LeafView = <Msg>(args: LeafViewArgs<Msg>) => Html

/**
 * One view per renderable leaf, as a record rather than a switch so the
 * implemented↔rendered JOIN is checkable: `collectUnknownLeafIds` gates on
 * the `implemented` flag only, so an implemented leaf missing here would
 * otherwise reach the Unknown-leaf fallback silently. mapIntent.test.ts
 * asserts every implemented leaf has an entry.
 */
const leafViews: Readonly<Record<string, LeafView>> = {
  page: <Msg>({ children, childIds, ctx, h }: LeafViewArgs<Msg>): Html => {
    // The ruled list-detail skeleton is two columns; the page is otherwise a
    // stack, so an adjacent rail+inspector pair gets a grid row of its own.
    const kids: Array<Html> = []
    for (let index = 0; index < children.length; index += 1) {
      const child = children[index]
      if (child === undefined) {
        continue
      }
      const inspector = children[index + 1]
      if (
        childIds[index] === 'rail' &&
        childIds[index + 1] === 'inspector' &&
        inspector !== undefined
      ) {
        kids.push(
          h.div(
            [
              h.Class(
                `grid grid-cols-[2fr_3fr] items-start ${gap(ctx.density)}`,
              ),
            ],
            [child, inspector],
          ),
        )
        index += 1
        continue
      }
      kids.push(child)
    }
    return h.div([h.Class(`flex flex-col ${gap(ctx.density)}`)], kids)
  },
  header: <Msg>({ children, ctx, h }: LeafViewArgs<Msg>): Html =>
    h.div(
      [h.Class('flex items-start justify-between gap-2')],
      [
        h.div(
          [h.Class('flex flex-col gap-1')],
          [
            h.p([h.Class('overline')], ['Preview']),
            h.p(
              [h.Class('text-body-m font-semibold text-fg-heading')],
              [ctx.title ?? 'Untitled'],
            ),
          ],
        ),
        ...children,
      ],
    ),
  card: <Msg>({ children, ctx, h }: LeafViewArgs<Msg>): Html =>
    h.div(
      [
        h.Class(
          `flex flex-col ${gap(ctx.density)} rounded-lg border border-border bg-surface ${pad(ctx.density)}`,
        ),
      ],
      children.length === 0
        ? [h.p([h.Class('text-body-s text-fg-muted')], ['Card'])]
        : children,
    ),
  'list-row': <Msg>({ children, h }: LeafViewArgs<Msg>): Html =>
    h.div(
      [
        h.Class(
          'flex items-center justify-between rounded-sm border border-border px-3 py-2',
        ),
      ],
      [
        h.span([h.Class('text-body-s text-fg')], ['Row']),
        h.div(
          [h.Class('flex items-center gap-1.5')],
          [
            ...children,
            h.span(
              [h.Class('font-mono text-mono-sm text-fg-subtle')],
              ['item'],
            ),
          ],
        ),
      ],
    ),
  button: <Msg>({ h }: LeafViewArgs<Msg>): Html =>
    h.span(
      [
        h.Class(
          'inline-flex rounded-sm bg-accent-fill px-3 py-1.5 text-body-s font-medium text-fg-on-brand',
        ),
      ],
      ['Action'],
    ),
  'text-field': <Msg>({ h }: LeafViewArgs<Msg>): Html =>
    h.div(
      [h.Class('flex flex-col gap-1')],
      [
        h.span([h.Class('text-label font-medium text-fg')], ['Field']),
        h.div(
          [
            h.Class(
              'rounded-sm border border-border bg-surface px-2 py-1.5 font-mono text-mono-sm text-fg-subtle',
            ),
          ],
          ['value'],
        ),
      ],
    ),
  textarea: <Msg>({ h }: LeafViewArgs<Msg>): Html =>
    h.div(
      [h.Class('flex flex-col gap-1')],
      [
        h.span([h.Class('text-label font-medium text-fg')], ['Notes']),
        h.div(
          [
            h.Class(
              'min-h-16 rounded-sm border border-border bg-surface px-2 py-1.5 text-body-s text-fg-subtle',
            ),
          ],
          ['…'],
        ),
      ],
    ),
  select: <Msg>({ h }: LeafViewArgs<Msg>): Html =>
    h.div(
      [h.Class('flex flex-col gap-1')],
      [
        h.span([h.Class('text-label font-medium text-fg')], ['Choice']),
        h.div(
          [
            h.Class(
              'rounded-sm border border-border bg-surface px-2 py-1.5 text-body-s text-fg',
            ),
          ],
          ['Option'],
        ),
      ],
    ),
  checkbox: <Msg>({ h }: LeafViewArgs<Msg>): Html =>
    h.div(
      [h.Class('flex items-center gap-2')],
      [
        h.span([
          h.Class('size-3.5 rounded-sm border border-border bg-surface'),
        ]),
        h.span([h.Class('text-body-s text-fg')], ['Flag']),
      ],
    ),
  accordion: <Msg>({ children, ctx, h }: LeafViewArgs<Msg>): Html => {
    const open = ctx.openPaths.includes(ctx.path)
    return h.div(
      [h.Class('flex flex-col rounded-sm border border-border')],
      [
        h.button(
          [
            h.Type('button'),
            h.OnClick(ctx.onToggle(ctx.path)),
            h.Class(
              'flex w-full cursor-pointer items-center justify-between px-3 py-2 text-left text-body-s font-medium text-fg hover:bg-int-hover',
            ),
          ],
          ['Section', open ? '−' : '+'],
        ),
        open
          ? h.div(
              [h.Class(`flex flex-col ${gap(ctx.density)} px-3 pb-3`)],
              children.length === 0
                ? [h.p([h.Class('text-caption text-fg-subtle')], ['Hidden'])]
                : children,
            )
          : h.empty,
      ],
    )
  },
  'status-dot': <Msg>({ h }: LeafViewArgs<Msg>): Html =>
    h.div(
      [h.Class('flex items-center gap-1.5')],
      [
        h.span([h.Class('size-1.5 rounded-full bg-status-success-fg')]),
        h.span([h.Class('font-mono text-mono-sm text-fg-muted')], ['ready']),
      ],
    ),
  'empty-state': <Msg>({ h }: LeafViewArgs<Msg>): Html =>
    h.div(
      [h.Class('flex flex-col gap-1 py-6')],
      [
        // Reader vocabulary, not authoring vocabulary: this leaf is what an
        // end user sees in an empty page (F2).
        h.p([h.Class('text-body-s text-fg-muted')], ['No items yet']),
        h.p(
          [h.Class('text-caption text-fg-subtle')],
          ['Nothing has been added to this page.'],
        ),
      ],
    ),
  banner: <Msg>({ h }: LeafViewArgs<Msg>): Html =>
    h.p(
      [
        h.Class(
          'rounded-sm border border-status-info-border bg-status-info-bg px-3 py-2 text-body-s text-fg',
        ),
      ],
      ['Notice'],
    ),
  'search-field': <Msg>({ h }: LeafViewArgs<Msg>): Html =>
    h.div(
      [
        h.Class(
          'rounded-sm border border-border bg-surface px-2 py-1.5 text-body-s text-fg-subtle',
        ),
      ],
      ['Search…'],
    ),
  'filter-chip': <Msg>({ h }: LeafViewArgs<Msg>): Html =>
    h.span(
      [
        h.Class(
          'inline-flex w-fit items-center rounded-full border border-border px-2.5 py-0.5 text-caption text-fg-muted',
        ),
      ],
      ['Filter'],
    ),
  pagination: <Msg>({ h }: LeafViewArgs<Msg>): Html =>
    h.div(
      [
        h.Class(
          'flex items-center justify-center gap-2 font-mono text-mono-sm text-fg-subtle',
        ),
      ],
      ['‹ 1 2 3 ›'],
    ),
  rail: <Msg>({ children, ctx, h }: LeafViewArgs<Msg>): Html =>
    h.div(
      [
        h.Class(
          `flex flex-col ${gap(ctx.density)} border-r border-border pr-3`,
        ),
      ],
      children.length === 0
        ? [h.p([h.Class('text-caption text-fg-subtle')], ['Rail'])]
        : children,
    ),
  inspector: <Msg>({ children, ctx, h }: LeafViewArgs<Msg>): Html =>
    h.div(
      [h.Class(`flex flex-col ${gap(ctx.density)}`)],
      children.length === 0
        ? [h.p([h.Class('text-caption text-fg-subtle')], ['Detail'])]
        : children,
    ),
  metric: <Msg>({ h }: LeafViewArgs<Msg>): Html =>
    h.div(
      [h.Class('flex flex-col gap-0.5')],
      [
        h.p([h.Class('text-body-m font-semibold text-fg-heading')], ['128']),
        h.p([h.Class('text-caption text-fg-subtle')], ['Metric']),
      ],
    ),
  badge: <Msg>({ h }: LeafViewArgs<Msg>): Html =>
    h.span(
      [
        h.Class(
          'inline-flex w-fit items-center rounded-sm border border-border px-1.5 py-0.5 text-caption text-fg-muted',
        ),
      ],
      ['ready'],
    ),
  pill: <Msg>({ h }: LeafViewArgs<Msg>): Html =>
    h.span(
      [
        h.Class(
          'inline-flex w-fit items-center gap-1.5 rounded-full border border-border px-2.5 py-0.5',
        ),
      ],
      [
        h.span([h.Class('size-1.5 rounded-full bg-status-success-fg')]),
        h.span([h.Class('text-caption text-fg-muted')], ['live']),
      ],
    ),
}

/** True when a leaf id has a real view — the JOIN mapIntent.test.ts checks
 *  against `implementedLeaves()`. */
export const hasLeafView = (leafId: string): boolean => leafId in leafViews

const renderLeaf = <Msg>(
  leafId: string,
  children: ReadonlyArray<Html>,
  childIds: ReadonlyArray<string>,
  ctx: LeafRender<Msg>,
  h: HtmlBuilder<Msg>,
): Html => {
  const view = leafViews[leafId]
  if (view === undefined) {
    return h.p(
      [h.Class('text-body-s text-fg-error')],
      [`Unknown leaf ${leafId}`],
    )
  }
  return view({ children, childIds, ctx, h })
}

export type RenderedTree =
  | { readonly _tag: 'Ok'; readonly html: Html }
  | {
      readonly _tag: 'InventedIds'
      readonly inventedIds: ReadonlyArray<string>
    }

export const renderTree = <Msg>(
  root: TreeNode,
  ctx: Omit<LeafRender<Msg>, 'path'>,
  h: HtmlBuilder<Msg>,
): RenderedTree => {
  const invented = collectUnknownLeafIds(root)
  if (invented.length > 0) {
    return { _tag: 'InventedIds', inventedIds: invented }
  }
  const walk = (current: TreeNode, path: string): Html => {
    const leaf = leafById.get(current.leafId)
    if (leaf === undefined) {
      return h.empty
    }
    const children = current.children.map((child, index) =>
      walk(child, `${path}.${index}`),
    )
    const childIds = current.children.map(child => child.leafId)
    return renderLeaf(current.leafId, children, childIds, { ...ctx, path }, h)
  }
  return { _tag: 'Ok', html: walk(root, '0') }
}

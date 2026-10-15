import { execFile } from 'node:child_process'
import { existsSync, realpathSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'

// The MicroDots build-time vite plugins.
//
// This package exists for ONE mechanical reason: a vite config that registers a
// plugin by RELATIVE path can only be scaffolded at a known depth, and the
// generator (`@bespokeagentics/microdots-generate`) writes MicroDots at three of
// them — `microdots/<name>` in the repo, `microdots/workbench/.workspace/<slug>`
// (and its `..workspace-compose-*` staging sibling) for a composed workspace,
// and `<worktree>/microdots/<slug>` inside the exporter's git worktree. A bare
// specifier has no depth, so it is the only registration a generator can emit.
//
// The single load-bearing declaration is `"@bespokeagentics/microdots-vite-plugin":
// "workspace:*"` in the ROOT `package.json` devDependencies. Bun links a
// workspace package per DECLARED consumer and never by blanket hoisting, so
// declaring at the root is what creates `/node_modules/@bespokeagentics/…`;
// every one of the three depths is under the repo root, so the plain upward
// `node_modules` walk from the config module finds it there. A per-dot
// declaration is NOT a substitute: no `bun install` ever runs inside a composed
// workspace, so a `dependencies` block written into its `package.json` is inert
// text — and `resolve.alias`, which is how `@bespokeagentics/microdots-theme`
// reaches a composed dot, rewrites the built app graph and never the config
// module's own imports.
//
// Scope: this package may import `node:*` and vite's `Plugin` TYPE, nothing
// else. `packages/microdots-vite-plugin/src/imports.bun.test.ts` bundles the
// module and asserts the resulting external set against that rule.
//
// This runtime entry is JavaScript deliberately. In the monorepo, the package
// link realpaths outside node_modules and node can strip TypeScript. A published
// package is physically inside node_modules, where node refuses to strip it.
// Vite configs run under node, so a raw TypeScript entry works in the workspace
// and then dies only for a consumer. `index.d.ts` carries the public types.

const run = promisify(execFile)

/**
 * The repository MicroDot a plugin instance is allowed to emit for.
 *
 * `repoRoot` is derived from `dotDir` rather than from this module's own
 * location, deliberately. Node realpaths symlinks when it resolves an ESM
 * module, so a plugin driven from a composed workspace still loads out of the
 * REAL `packages/` directory and a location-derived root would name the real
 * monorepo — which is exactly the hazard below. Deriving from the directory
 * being built means the root the emit runs against and the root the gate checks
 * are the same value by construction, and a build inside a git worktree stays
 * hermetically inside that worktree.
 *
 * @typedef {object} EmitTarget
 * @property {string} repoRoot
 * @property {string} name
 * @property {string} dotDir
 */

/**
 * @param {string} path
 * @returns {string}
 */
const canonical = path => {
  try {
    return realpathSync(resolve(path))
  } catch {
    return resolve(path)
  }
}

/**
 * IDENTITY GATE. Resolves the directory a build is running in to the repository
 * MicroDot that owns it, or `undefined` when no repository MicroDot does.
 *
 * The emit shells `bun scripts/emit-manifests.ts --only <name>` with
 * `cwd: repoRoot`, and that writes into `<repoRoot>/microdots/<name>/dist`. The
 * name used to be `basename(dotDir)` with no check at all, and the builder's
 * slug validator (`microdots/workbench/service/workspace.ts:20-30`) accepts any
 * lower-kebab string — so a builder workspace named `price` would have made a
 * composed build rewrite the repository's `microdots/readout/dist/`. Confirmed
 * live: every composed-workspace build resolves this module to the real
 * `packages/…` path, so nothing about running outside `microdots/` was visible
 * to the emit.
 *
 * The gate is the SHAPE of the directory, not a name comparison: a repository
 * MicroDot is the child of a directory called `microdots` whose parent is a tree
 * carrying `scripts/emit-manifests.ts` — the very script the emit runs. A
 * composed workspace (`.workspace/<slug>`), its staging sibling
 * (`..workspace-compose-<id>/<slug>`), a preview rebuild directory and the
 * generator's own build probes all fail the first half and never reach the
 * second.
 *
 * (Written `<id>` rather than as a glob on purpose — a star-slash inside a
 * block comment closes it. Same trap as
 * `wiki/patterns-and-traps/a-glob-in-a-css-comment-closes-it.md`.)
 *
 * @param {string} dotDir
 * @returns {EmitTarget | undefined}
 */
export const emitTargetFor = dotDir => {
  const dir = canonical(dotDir)
  const parent = dirname(dir)
  if (basename(parent) !== 'microdots') {
    return undefined
  }
  const repoRoot = dirname(parent)
  if (!existsSync(join(repoRoot, 'scripts', 'emit-manifests.ts'))) {
    return undefined
  }
  return { repoRoot, name: basename(dir), dotDir: dir }
}

/**
 * What the gate says when it declines — one definition, so the plugin and the
 * test that watches it refuse cannot describe the refusal differently.
 *
 * It is a warning rather than silence because a silent no-op is how the
 * identity hazard hid: the old plugin reduced any directory to its basename and
 * emitted, and "a directory that is not under `microdots/` matches no dot and is
 * a no-op" was a comment, not a check.
 *
 * @param {string} dotDir
 * @returns {string}
 */
export const emitDeclinedMessage = dotDir => {
  const dir = canonical(dotDir)
  return `[emit-microdot-manifest] ${dir}: not a repository MicroDot — a manifest is emitted only from <repo>/microdots/<name>. Nothing was written; a staged, composed or probe workspace must never rewrite microdots/${basename(dir)}/dist.`
}

/**
 * Re-emits a MicroDot's manifest after every vite build of its bundle.
 *
 * The manifest is BUILD-emitted — and in dev, `vite build --watch` empties
 * `dist/` on every rebuild, silently wiping the manifest and the hashed bundle
 * a prior `bun run build` (or this plugin) put there. Hanging the emission off
 * `closeBundle` makes the artifact follow the bundle everywhere the bundle is
 * built: one-shot builds, watch rebuilds, and the aggregate `scripts/build.ts`
 * run (whose own `emitManifests` pass stays as the strict all-dots backstop).
 *
 * The emit runs as a `bun` SUBPROCESS, not in-process: vite here executes
 * under node, which cannot dynamically import the dot's `src/surface.ts` —
 * only bun can. And it never throws: a failed emit is a warning, because a
 * watcher that dies on a transient error takes the whole dev stack with it.
 *
 * @param {string} dotDir
 * @returns {import('vite').Plugin}
 */
export const emitMicroDotManifest = dotDir => ({
  name: 'emit-microdot-manifest',
  apply: 'build',
  config: watchSettleConfig,
  closeBundle: () => emitManifestNow(dotDir),
})

/** How long a watch rebuild waits for file events to stop. */
export const WATCH_SETTLE_MS = 750

/**
 * In watch mode only, coalesce a burst of file events into ONE rebuild that
 * starts after the burst ends. A git merge, rebase or checkout writes dozens
 * of files over a second or two; without a delay the watcher began building
 * two seconds into a merge, read the old stylesheet beside the new views,
 * served that half-merged bundle, and never rebuilt
 * (wiki/patterns-and-traps/a-dev-watcher-that-rebuilds-mid-merge-bakes-a-half-merged-bundle.md).
 * A one-shot build is untouched: returning `build.watch` there would turn it
 * INTO a watcher.
 *
 * @param {import('vite').UserConfig} config
 * @returns {import('vite').UserConfig | undefined}
 */
export const watchSettleConfig = config =>
  config.build?.watch
    ? { build: { watch: { buildDelay: WATCH_SETTLE_MS } } }
    : undefined

/**
 * Exactly what `closeBundle` runs, as a plain function.
 *
 * Separated so a test can DRIVE it — vite's hook arrives with a `PluginContext`
 * `this`, and calling it through the plugin object would need a type assertion,
 * which this repository's lint forbids. A gate nothing ever watched refuse is
 * not a gate.
 *
 * @param {string} dotDir
 * @returns {Promise<void>}
 */
export const emitManifestNow = async dotDir => {
  const target = emitTargetFor(dotDir)
  if (target === undefined) {
    const localRoot = canonical(dotDir)
    const localEmitter = join(localRoot, 'scripts', 'emit-manifest.ts')
    if (!existsSync(localEmitter)) {
      console.warn(emitDeclinedMessage(dotDir))
      return
    }
    try {
      const { stdout, stderr } = await run('bun', [localEmitter], {
        cwd: localRoot,
      })
      if (stdout.length > 0) process.stdout.write(stdout)
      if (stderr.length > 0) process.stderr.write(stderr)
    } catch (error) {
      console.warn(
        `[emit-microdot-manifest] ${localRoot}: local emit failed — ${
          error instanceof Error ? error.message : String(error)
        }`,
      )
    }
    return
  }
  try {
    const { stdout, stderr } = await run(
      'bun',
      ['scripts/emit-manifests.ts', '--only', target.name],
      { cwd: target.repoRoot },
    )
    if (stdout.length > 0) {
      process.stdout.write(stdout)
    }
    if (stderr.length > 0) {
      process.stderr.write(stderr)
    }
  } catch (error) {
    console.warn(
      `[emit-microdot-manifest] ${target.name}: emit failed — ${
        error instanceof Error ? error.message : String(error)
      }`,
    )
  }
}

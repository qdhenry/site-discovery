# Releasing

## First public release

1. Create the GitHub repository (private at first, so you can review it):
   `gh repo create qdhenry/site-discovery --private --source . --push`
2. Check that the **CI** workflow passes on `main`.
3. In **Settings → Code security**, turn on **Private vulnerability reporting** (SECURITY.md depends on it), Dependabot alerts and secret scanning.
4. In **Settings → General**, add the description and the topics `cloudflare`, `claude` and `ai-gateway`.
5. Make the repository public: `gh repo edit --visibility public --accept-visibility-change-consequences`.
6. Tag and publish (steps below).

## Every release

1. Move the `Unreleased` entries in `CHANGELOG.md` under a new version and date.
2. Bump `version` in `package.json`.
3. Run `bun install --frozen-lockfile && bun run check && bun run build && bun run test:browser`.
   If the UI changed, refresh `docs/images/screenshot.png` from that run's `03-analysis-save-preview.png`, cropped to the top 1500 px. It's fixture data, so it's safe to publish.
4. Commit, then tag: `git tag -a v0.1.0 -m "v0.1.0" && git push --follow-tags`.
5. `gh release create v0.1.0 --notes-from-tag`, or paste the changelog section as the notes.

This is an application, not an npm package. `"private": true` stays set, and nothing is published to a registry.

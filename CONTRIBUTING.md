# Contributing to Site Discovery

Thanks for helping. Bug reports, fixes and focused features are welcome.

## Set up

```sh
git clone https://github.com/qdhenry/site-discovery.git
cd site-discovery
bun install
DISCOVERY_FIXTURES=1 bun run dev
```

Fixture mode needs no Cloudflare or Anthropic accounts. For live capture and analysis, follow the [README setup](README.md#cloudflare-and-anthropic-setup) with your own accounts and low spending limits.

## Before you open a pull request

1. Run `bun run check` (typecheck plus unit and service tests). It must pass.
2. If you changed the UI or the HTTP/RPC flow, run `bun run test:browser`. It needs port 3193 free and Playwright Chromium installed.
3. Add or update tests for the behavior you changed. A bug fix includes the test that would have caught it.
4. Update the docs in `docs/` or the README when behavior or configuration changes.

## Ground rules

- **Never commit credentials.** `.env` and `.local/` are git-ignored. Keep it that way, and never paste tokens into issues or logs.
- **Keep the safety invariants.** Capture never calls a model. Analysis only runs on an explicit command. Budgets fail closed. Uncertain calls are never resent automatically. The service stays loopback-only. Changes that weaken any of these need a design discussion in an issue first.
- **Pinned dependencies stay pinned.** Versions in `package.json` are exact and mirrored in `overrides`. Bump them deliberately, in their own pull request.
- **Vendored packages.** `packages/microdots-*` are vendored snapshots of the MicroDots libraries. Edit them here like any other source.

## Project layout

| Path | Contents |
|---|---|
| `src/` | Browser UI (Foldkit), the Effect RPC contract and custom elements |
| `service/` | Bun service: auth, handlers, durable engine, providers, SQLite |
| `packages/` | Vendored MicroDots runtime, element, theme, catalog and Vite plugin |
| `tests/` | Playwright browser proof |
| `docs/` | Behavior and architecture reference |

The JSON files at the repository root (`workspace.manifest.json`, `composition.spec.v2.json` and the others) are MicroDots composition metadata from the tool that generated this app. The app doesn't read them at runtime.

## Reporting bugs and security issues

Open an issue using the bug template. For anything security-related, follow [SECURITY.md](SECURITY.md) instead of opening a public issue.

By contributing, you agree that your contributions are licensed under the [Apache License 2.0](LICENSE).

# Run Site Discovery locally

Verified with Bun 1.4.0. The service binds only to loopback at **http://127.0.0.1:3193/** and serves the built UI from that same origin.

```sh
bun install --frozen-lockfile
bun run check
bun run dev
```

Read `.local/discovery/owner-token` locally and paste its value into the sign-in form. The service creates it on first start with mode 0600. Do not put the token in a URL or share it. You can set `DISCOVERY_OWNER_TOKEN` instead of using a generated file. Sessions expire after twelve hours and end when the service restarts. Application data and tasks persist independently of sessions.

The optional mini-host also works. With the service running, start it with `bunx vite --config mini-host/vite.config.ts` and open **http://localhost:5193/**. It mounts the same elements with `api-url="http://localhost:3193"` and calls the service cross-origin. Sign in there separately, because its cookie belongs to `localhost`, not `127.0.0.1`.

Only one process can own a state directory. Stop the previous service before restarting on port 3193. `bun run dev` builds the UI once and starts the service. To iterate on source, run `bun run dev:service` (watches the Bun service) and `bun run dev:bundle` (rebuilds the bundle) in separate terminals.

## Live configuration

Live capture needs `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_BROWSER_API_TOKEN`. Live Claude also needs:

- `CLOUDFLARE_AI_GATEWAY_ID`
- `AI_GATEWAY_API_TOKEN`
- `ANTHROPIC_API_KEY`
- `DISCOVERY_RUN_LIMIT_USD`, `DISCOVERY_MONTHLY_LIMIT_USD` and `DISCOVERY_ATTEMPT_RESERVATION_USD` (or the same limits saved in Agent settings)

`DISCOVERY_MODEL` defaults to `claude-sonnet-4-6`. The Anthropic key and the gateway token authenticate independently. The provider uses Anthropic key-in-request through Cloudflare AI Gateway. Gateway-stored BYOK is not implemented, and there is no direct-to-Anthropic inference fallback. Model metadata is fetched directly from the Anthropic Models API and cached in SQLite for four hours; **Agent settings → Refresh model catalog** refreshes it early. The [README](../README.md#cloudflare-and-anthropic-setup) walks through creating each credential.

Set spending limits deliberately. A reservation must cover the model's accepted context at its highest input/cache rate plus the capped output. The service reports and enforces that minimum before each request. An unknown earlier call keeps its reservation even after a retry or history deletion. Viewing pages or capturing screenshots never calls a model.

## Fixture demo

```sh
DISCOVERY_FIXTURES=1 DISCOVERY_MODEL_CATALOG_FIXTURE=1 bun run dev
```

Choose **Fixture** in the form to try capture, analysis, review, duplicates, save and export without provider calls. Every fixture run is labeled. The optional `DISCOVERY_MODEL_CATALOG_FIXTURE=1` flag supplies an explicitly labeled offline model catalog, requires `DISCOVERY_FIXTURES=1`, and cannot authorize live analysis. Omit that flag to retrieve real model metadata. Live mode never falls back to fixtures.

The repeatable browser acceptance script uses a temporary database and a random token, then shuts down its service:

```sh
bun run test:browser
```

Port 3193 must be free, and Chromium must be installed for Playwright (`bunx playwright install chromium`). The script saves screenshots to `/tmp/site-discovery-ui-proof` by default. Set `DISCOVERY_PROOF_DIR` to change the directory.

## Where the data lives

By default, `.local/discovery/` contains the SQLite store, the exclusive-owner lock, the bootstrap token and private screenshot files. Git ignores it. History stays until you choose **Delete this run**. Saved library captures survive deletion of the run they came from. The JSON export contains project records and evidence references. Image files stay private to this local service.

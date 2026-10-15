# Design decisions

The settled behavior behind Site Discovery, and the tests that check each decision.

| Decision | Settled behavior | Verification required |
|---|---|---|
| Data | Standalone, app-owned SQLite data; no external import or integration | Isolated project data |
| Save | Own project library of components, content types, fields, variants, audits and save receipts; JSON export | Transaction rollback, idempotency, receipt-derived saved state |
| Identity | One local owner session; loopback binding; all service and screenshot access protected | Missing/expired/invalid session; hostile origin; project/run/resource scope |
| Mini-host origin | `http://localhost:5193` is admitted with credentialed CORS on `/rpc`, `/session`, `/private/*`; owner cookie and service Host are still required. Before this, every authenticated mini-host call failed the origin check. Trade-off accepted: any page served at `localhost:5193` can act with an owner session signed in on `localhost` | `wire.bun.test.ts`: mini-host preflight/401/login/RPC/health pass on the real service stack; :5194, `attacker.example` and `sec-fetch-site: cross-site` still get 403 |
| Runtime | Bun service; pinned Pi Durable, pi-ai, Chord 1.0.3; portable SQLite adapter | Upstream conformance, process ownership, durable task restart |
| Capture | Deterministic Pi tasks calling Cloudflare Browser Run; four modes, depth 1–3, 50 pages | Modes, URL constraints, viewport files, progress/partial failures |
| Analysis | Only Analyze selected pages invokes Claude, via Cloudflare AI Gateway | No model call on capture/open/poll; selected IDs and budget claim |
| Recovery | Completed checkpoints reused; safe unfinished work resumed; unknown external outcomes explicit retry with retained reservation | Crash injection before/after checkpoints and external request boundary |
| Assets | Private local screenshot files; never proxied third-party URLs | Authorized routes, path containment, wrong-project access denial |
| Retention | Keep history until explicit deletion | Restart keeps runs/results/assets; no age-based automatic expiry |
| Provider failure | Visible failure; deterministic fixtures only under explicit fixture mode | Configuration rejection, provenance, no implicit fallback |
| Budget | Live analysis fails closed until valid per-run/monthly limits configured | Concurrent/repeated starts and retained uncertain reservations |
| Save rules | Keep both creates a distinct row; merge target must belong to project; saved CMS names exactly match reviewed preview | Create/merge and naming tests |
| UI | Foldkit app with MicroDots styling, full workflow in one panel | Real DOM/service traffic and lifecycle (`bun run test:browser`) |
| Lifecycle | Browser attrs select context only; stale async answers fenced; UI disposal never cancels service tasks | Attribute switch, unmount/remount, service reconnect |

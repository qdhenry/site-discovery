# Agent settings

Open **Agent settings** in the Site Discovery header at http://127.0.0.1:3193/. Edit preferences, choose **Preview settings**, then **Save settings**. Preview validates the combination and shows the minimum reservation before a model request. Saving settings does not start analysis or retry a run.

## Available controls

| Control | Behavior |
|---|---|
| Analysis model | Fetched directly from the Anthropic Models API; cached for four hours. Unsupported adapter/pricing combinations are visible but unavailable |
| Maximum output tokens | Default 8,192; bounded by the selected model's maximum. Adaptive thinking shares this ceiling; legacy thinking expansion is included in preview |
| Reasoning level | Provider default or supported levels; unavailable levels are omitted |
| Thinking token budget | Optional custom budget for models using fixed thinking budgets |
| Temperature | Optional 0–1, only for compatible models with reasoning off |
| Cache retention | None, short (5 minutes), or long (1 hour); reservation accounts for long-cache pricing |
| Request timeout | 10–600 seconds, entered as milliseconds |
| DOM character limit | 0–200,000; default 30,000 |
| Screenshot evidence | Both viewports, desktop, mobile, or no screenshots; at least one available evidence source is required |
| Additional analysis instructions | Up to 8,000 characters; the required findings format and separate save step remain enforced |
| Run spending limit | Maximum spend plus held reservations for a run |
| Monthly spending limit | Workspace-wide monthly spend plus held reservations |
| Attempt reservation | Held before each page analysis; must cover the displayed model/output bound and fit the run/monthly limits |

The advanced disclosure contains reasoning, caching, timeout, evidence and instructions. Model changes clear incompatible controls with an explanation. Blank spending limits can be saved but block live analysis. Preview readiness does not promise remaining budget: prior spend and uncertain reservations are checked again before each request.

## Model catalog

The service calls `GET https://api.anthropic.com/v1/models` with the server-side `ANTHROPIC_API_KEY`. This metadata request does not invoke a model. Claude analysis continues through Cloudflare AI Gateway; credentials and gateway routing never enter the browser.

The catalog persists in its own Pi document in SQLite. Successful results expire after exactly four hours and survive service restarts. Normal reads share an in-flight refresh and reuse fresh data. **Refresh model catalog** requests an immediate refresh. The panel shows source, status, fetch time, expiry and errors. Failed automatic refreshes wait 60 seconds before another attempt. Same-credential expired rows remain visible during an outage, but cannot authorize new live analysis. Changing the key invalidates the old catalog. A valid empty API list stays empty.

Anthropic supplies model names, lifecycle, token limits and reasoning capabilities where available. The app also displays effective limits: these never exceed either the API limit or the verified adapter limit. Pricing is separately labeled **Pi AI 1.0.3**, because the Models API does not return prices. Models absent from that pinned adapter/pricing catalog are shown with a specific unavailable reason. Catalog refreshes do not silently change a draft selection or a running job.

## Persistence and work in progress

Settings are global to this local owner's workspace and persist in SQLite. The existing `DISCOVERY_MODEL`, `DISCOVERY_RUN_LIMIT_USD`, `DISCOVERY_MONTHLY_LIMIT_USD` and `DISCOVERY_ATTEMPT_RESERVATION_USD` initialize settings only once. Later UI saves take precedence, including after restart. Credentials, gateway routing, local-owner access and fixture enablement stay in server configuration.

An explicit **Analyze selected pages** or **Retry operation** snapshots the saved settings and resolved model capabilities, limits and pricing for that whole job. All selected pages keep those settings; each physical attempt records its copy. Changing preferences does not alter a running job. Lowering current spending limits can stop admission of a later page without erasing prior spend or reservations. Retries use the latest saved preferences and retain any earlier uncertain liability.

The usage panel shows attempt settings, actual model usage, diagnostics and retained-response truncation. Older attempts honestly report that a settings snapshot was not recorded. Model responses are validated in full; retained raw response evidence is bounded separately. Automatic SDK retries and model fallback are disabled.

Unsaved drafts survive polling. **Revert changes** restores the last loaded saved values. A conflicting revision keeps the draft and offers **Reload saved settings**. An interrupted save retries the same command ID rather than making an unrelated write.

## Start locally

```sh
bun install
bun run dev
```

The service binds to http://127.0.0.1:3193/. The local owner token is in `.local/discovery/owner-token` unless `DISCOVERY_OWNER_TOKEN` is configured. Do not share it. Service restart requires signing in again; browser remount does not cancel service-owned work.

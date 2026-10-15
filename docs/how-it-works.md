# How Site Discovery works

Detailed behavior reference. For setup, see the [README](../README.md).

## Agent settings

The authenticated settings editor reads the service's pinned Anthropic model catalog and supported options. Preview validates the draft and reports the effective reasoning/output limits, the minimum reservation and missing prerequisites without invoking a model. Save persists one global owner settings revision. A stale revision must be reloaded; repeating the same command is idempotent, while reusing its ID with different values is rejected.

| Setting | Initial value and validation |
| --- | --- |
| Model | `DISCOVERY_MODEL` or `claude-sonnet-4-6`; must be in the pinned Anthropic messages catalog |
| Output tokens | Initially 8,192 requested tokens, capped by the model's maximum; allowed 1 through that limit, or at least 1,024 when budget-based reasoning is enabled |
| Reasoning | A compatible model default; nullable selection uses the model default reported by the service, and explicit levels must be supported |
| Thinking budget | Unset by default; a custom token budget is available only for budget-based reasoning, from 1,024 through the model output limit minus 1,024 |
| Temperature | Unset by default; 0–1 only when the model supports temperature and reasoning is off. The service disables it for Sonnet 5 and Fable 5 |
| Request timeout | 120 seconds by default; 10–600 seconds |
| Cache retention | Short by default; none, short or long where the selected model supports it |
| DOM evidence | 30,000 characters by default; 0–200,000 |
| Screenshot evidence | Both by default; both, desktop, mobile or none. With none selected, the DOM limit must be positive |
| Additional instructions | Empty by default; at most 8,000 characters. They can focus analysis but cannot change the fixed JSON output contract or authorize tools or saving |
| Run/monthly spending limits and attempt reservation | Initialized from the three budget environment names; otherwise unset. Each entered amount must be positive and at most USD 1,000,000 |

**When changes apply:** clicking **Analyze selected pages** or an explicit analysis **Retry** snapshots the saved settings for that whole job, including every selected page. Each physical attempt records that snapshot, effective options and prompt version. Saving a new revision affects the next Analyze/Retry command. It does not rewrite a job already admitted or change an in-flight request. Lowering the current spending caps can still prevent a later page from starting.

The reservation must cover the model's full accepted context window at the highest applicable input/cache price tier plus the effective output ceiling. Budget-based thinking can increase that ceiling; long cache retention can increase the input-side bound. The service displays the required minimum before analysis. Settings can be saved with missing or insufficient limits, but live analysis remains blocked when a required limit is unset, the reservation is too small, or it exceeds either spending cap. Before each call, the service atomically reserves against run and monthly limits. Known usage replaces that attempt's reservation; an unknown result keeps its reservation. Automatic retry is disabled and is not an editable setting. A manual retry reserves a new attempt, so unknown previous spending stays included. Deleting history never removes liabilities. Unknown liabilities from earlier months continue to count conservatively.

The service sends the selected model with automatic model fallback disabled and resolves a nullable reasoning choice to the snapshot's explicit effective level. Returned dated model aliases are recorded as returned. An unexpected known model is rejected while its measured usage is retained; an unpriced model keeps the reservation. If long-cache usage omits its retention split, reported cache writes are charged conservatively at the requested one-hour rate.

Saving settings does not start capture, analysis or retry. Credentials are not settings fields and are never returned to this editor. Existing runs and attempts created before settings snapshots retain their original history; an explicit retry is required when an older pending analysis has no settings snapshot.

## Supported workflow and persistence

Single URL, newline-separated batch, same-origin domain traversal (1–3 link hops), and sitemap URLs support a 50-page cap. Desktop is 1440×900, mobile 390×844. Direct URL discovery uses validated public DNS addresses pinned into each socket, a 2 MB document cap, a timeout and per-redirect validation. Captures run remotely through Cloudflare; private/local URL inputs are refused. Website robots.txt is checked with a basic wildcard disallow-prefix interpretation; unavailable robots files permit capture. Nested sitemap indexes and the full robots exclusion grammar are not implemented.

Cloudflare captures rendered HTML and PNG screenshots. Analysis uses bounded rendered DOM plus the selected page's screenshots. Screenshots and DOM are untrusted evidence; instructions within them do not authorize actions. Only detections passing strict schemas (including rejection of unknown properties) become results. Repeated compatible detections union fields and labels and retain per-page/attempt evidence; conflicting field types remain separate inspectable findings. Known invalid model responses retain their bounded raw response and measured usage, charge once, and permit explicit retry. Transport-uncertain responses retain the reservation. Partial, definitively rejected page captures retain successful pages for inspection and analysis. Timeouts, lost responses and process interruption are shown as **requires retry** and never silently resent.

Pi custom durable tasks and application documents persist run state, attempts, command receipts, project libraries, fields, design variants, logs, audit records and save receipts together in SQLite. Task creation and command admission are one commit. Saves update the library, audit and receipt in one commit. Command IDs reject changed payload reuse; run/project revisions prevent stale saves. **Keep both** always creates a new record; merge targets must match the project and finding kind. Saved CMS names equal the preview. A finding is saved only when a committed save receipt says so.

AEM uses kebab names; Optimizely components append `Block`; Sitecore components append `Rendering`; their content types and other CMSs use Pascal names. Saved design variants own private screenshot references and provenance. Deleting a run removes its unreferenced screenshots, while library-owned screenshots remain accessible through authorized library routes. Export includes library records, concrete variants, reviewed findings, usage, logs, receipts and audit records.

The SQLite adapter serializes asynchronous transactions, expires transaction handles, and uses WAL with FULL synchronization. A separate SQLite writer lock enforces one storage-owning process and is released by the OS after a crash. The UI may reconnect to committed snapshots without owning execution. Only active execution and unresolved uncertain runs occupy the global active-run slot; captured or completed history remains available.

## Verification and boundaries

```sh
bun test service/*.bun.test.ts
```

The Bun tests exercise the published Pi storage conformance suite, async transaction isolation/rollback, actual application process crash/reopen, retained unknown reservations and manual retry, single-owner process exclusion/crash release, explicit analysis, four inputs, CMS names, command replay, revision/project ownership, transactional saves, create versus merge, preserved library screenshots, export, sessions, transport-level origin/host guards, the mini-host's credentialed CORS on the real service stack, and private assets. Settings acceptance additionally checks persistence, validation, revision conflicts, job/attempt snapshots, budget admission and migration of existing state. The HTTP test sends actual Effect RPC envelopes through the router. Fixture/model-transport tests are deterministic evidence, not live Cloudflare or Claude acceptance.

No Worker adapter is provided: the service needs Bun, local SQLite and private local files. There is no deployment or infrastructure provisioning path. Live capture and live Claude must be verified separately after the appropriate existing account/gateway/model credentials and limits are configured.

Provider contracts were checked against [Cloudflare snapshot documentation](https://developers.cloudflare.com/browser-run/quick-actions/snapshot/) and [Anthropic through AI Gateway](https://developers.cloudflare.com/ai-gateway/usage/providers/anthropic/), plus the published pinned Pi packages. Current Cloudflare documentation names the capture path `/browser-run/snapshot`.

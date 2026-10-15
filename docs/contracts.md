# Application contracts and state mapping

The emitted `src/shape.contract.ts` is the catalog-owned Discovery contract; `src/contract.ts` re-exports it with the compiler composition. Browser code imports only Effect contracts and the MicroDots client. Pi task/document types remain inside the Bun service. No Discovery operations are published as public OpenAPI endpoints.

## Local transport

`GET /` serves the built application. `GET /session` reports session status, `POST /session` exchanges the local owner token for an HttpOnly SameSite=Strict cookie, and `DELETE /session` logs out. Browser Effect RPC uses `POST /rpc/`. The transport guard checks the real HTTP host/origin/session before any RPC frame headers are decoded; slash/encoded aliases do not bypass authorization. Only the shell, narrowly matched built assets, and session endpoints are public.

The compiler's paired mini-host, `http://localhost:5193`, is the one foreign origin admitted. `/rpc`, `/session` and `/private/*` answer its preflight. Every response to it, 401/403 included, carries `access-control-allow-origin: http://localhost:5193` and `access-control-allow-credentials: true`, so the client can read a 401 as "sign in". Host must still be the service, and the owner cookie is still required. Any other origin gets 403 and no CORS headers; same-origin responses carry no CORS headers. The browser client sends `credentials: 'include'` so the cookie reaches `api-url` from either origin.

Screenshots use authorized `GET /private/screenshots/{projectId}/{runId}/{pageId}/{viewport}`. Saved library evidence uses `GET /private/library/{projectId}/{recordId}/{variantId}/{viewport}`. Both return private, no-store content and validate ownership; local filenames are not API inputs. Deleting history does not delete library-owned evidence.

## Typed Effect RPCs

Every operation declares `DiscoveryError`. Its codes are unauthorized, forbidden, not_found, validation, conflict, busy, configuration, budget, storage and provider; errors also carry a message and retryable flag. Invalid transport/session access is rejected before the RPC layer and the client clears private state on HTTP 401.

| Operation | Inputs | Result |
|---|---|---|
| getDiscoverySettings | none | Saved settings, API model catalog, cache status and readiness evaluation |
| refreshDiscoveryModels | none | Force metadata refresh and return the settings snapshot; never starts analysis |
| previewDiscoverySettings | values | Validated effective reasoning/output limits, minimum reservation and readiness |
| saveDiscoverySettings | commandId, expectedRevision, values | Idempotent settings update with compare-and-set revision |
| getDiscoveryWorkspace | none | Projects, nonsecret configuration, budget, active run and session ID |
| createDiscoveryProject | commandId, name | Project |
| getDiscoveryHistory | projectId | Run summaries |
| getDiscoveryRun | projectId, runId | Run, pages, findings, logs, receipts and budget |
| getDiscoveryLogs | projectId, runId, afterSeq | Incremental logs |
| createDiscoveryCapture | projectId, commandId, CaptureInput | Run snapshot |
| analyzeDiscoveryPages | projectId, runId, commandId, expectedRevision, pageIds | Run snapshot |
| retryDiscoveryRun | projectId, runId, commandId, expectedRevision | Run snapshot |
| previewDiscoverySave | projectId, runId, expectedRevision, choices | CMS names/actions plus run and project revisions |
| saveDiscoveryFindings | projectId, runId, commandId, expectedRevision, expectedProjectRevision, choices | Committed save receipt |
| getDiscoveryLibrary | projectId | Records with fields and concrete design variants |
| exportDiscoveryProject | projectId | JSON filename and content |
| deleteDiscoveryRun | projectId, runId, commandId, expectedRevision | Deletion acknowledgement |

CaptureInput explicitly chooses single/batch/domain/sitemap, source text, depth, page cap, desktop/mobile, target CMS and live/fixture evidence. The service validates depth 1–3, cap 1–50 and public destinations. Commands retain their IDs on retry; reusing an ID with a different payload is a conflict. Project/run IDs select context and are never credentials.

Save choices are create, merge or skip. Keep both uses create. A preview gives the exact persisted CMS name and revisions; saving with changed revisions refuses rather than silently changing the review. Receipt IDs determine saved status. Compatible repeated detections retain a field/variant union and individual page/attempt evidence; conflicting field types become separate findings for review.

## Durable states and visible behavior

| State | Service behavior | Interface |
|---|---|---|
| queued | Capture task and admission committed atomically | Loading/progress; reconnect permitted |
| capturing | Per-page/viewport checkpoints | Pages and partial screenshots progressively available |
| captured | Task settled; no Claude call | Inspect screenshots and choose pages |
| analyzing | Explicit selected-page command; reservation committed before dispatch | Analysis progress and usage |
| completed | Validated results committed | Review fields, CMS names and duplicate choices; preview/save separately |
| requires_retry | Unknown attempt, known invalid response or a preflight refusal | Actual error and held amount; explicit retry only |
| failed | Definitive capture failure | Failure details and explicit retry |

A persisted inflight external attempt found after restart is uncertain and never automatically resent. Unknown analysis retains its liability; a known response stores measured usage/evidence, and a preflight failure makes no model call and reserves nothing. Retry makes a new physical attempt and reservation. Successful checkpoints remain reusable. Closing or remounting the UI does not own or cancel these tasks.

The UI fences asynchronous replies by session/API/project/run generation. Changing attributes clears superseded data before requesting the new context. Export is an explicit local download. There is no automatic save, fallback detector, deployment or external CMS integration.

## Settings and model provenance

Model metadata is fetched server-side from Anthropic, cached durably for four hours, and exposed as domain-level `AnalysisModel` and `ModelCatalogStatus` values. Provider credentials, credential-scope fingerprints and private execution-model JSON are excluded from browser responses and project exports. The API catalog owns availability and supplied capabilities; the pinned adapter provides separately labeled execution compatibility and pricing.

Analysis and explicit retry freeze settings and resolved model metadata at admission. Each physical attempt retains its public settings snapshot. A later catalog refresh cannot change an admitted job. Legacy work without a resolved execution snapshot requires explicit retry before further model calls. Unknown external outcomes retain their reservations.

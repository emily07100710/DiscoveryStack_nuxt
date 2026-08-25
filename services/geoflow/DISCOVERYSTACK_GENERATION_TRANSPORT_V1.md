# DiscoveryStack Generation Transport V1

## Scope

This document describes the server-side convergence layer for DiscoveryStack generation requests entering the vendored GEOFlow Laravel runtime. It is a **generation-only** path. The implementation creates a draft article and a risk-scan record for later human review; it does not approve, preview, publish, distribute, write to WordPress, or write to a client site.

The path is selected by the exact job type `discoverystack_generate_article_v1`. Existing `generate_article` jobs continue to use the legacy `WorkerExecutionService` path and retain their existing one-argument worker call contract.

## Authoritative API contract

The adapter is aligned to the existing Laravel routes and public response envelope:

| Operation | Method and route | Required scope | Runtime data used |
|---|---|---|---|
| Enqueue | `POST /api/v1/tasks/{task}/enqueue` | `tasks:write` | `data.task_id`, `data.job_id`, `data.status` |
| Job detail | `GET /api/v1/jobs/{job}` | `jobs:read` | `data.id`, `data.task_id`, `data.job_type`, `data.payload`, `data.task_run_summary` |
| Article detail | `GET /api/v1/articles/{article}` | `articles:read` | `data.id`, `data.title`, `data.content`, `data.excerpt`, `data.status`, `data.review_status`, timestamps |

Every successful response is expected to use the Laravel envelope `success: true`, `data: {...}`, `error: null`, and `meta.request_id`/`meta.timestamp`. The job endpoint is the source of the DiscoveryStack lineage and generation result metadata. The article endpoint is deliberately treated as a content/status source only; it is not expected to expose DiscoveryStack provenance as flat fields.

## Payload and lineage

`DiscoveryStackGenerationPayload` validates the snake_case wire payload before queue persistence. It requires the complete normalized brief, content/language/mode, canonical selected rules, requested capabilities, approved evidence chunks with reviewed text and SHA-256 hashes, evidence snapshot hash, request/brief fingerprints, revision context when applicable, attempt, and the derived `external_article_key`.

Fingerprints are recomputed using the same sorted-key JSON canonicalization as the public TypeScript request validator. Evidence source IDs must be in the approved authority source set, locators must be public HTTPS URLs, duplicate evidence identities are rejected, and unknown payload keys fail closed. Text normalization uses NFKC plus whitespace collapse and JavaScript-compatible UTF-16 length; timestamp offsets are bounded to ±14:00 and reject `-00:00`; malformed percent encodings, userinfo, sensitive decoded query keys/values, special-use hosts, and every IPv4/IPv6 literal are rejected. PHP requires the `intl` extension (`Normalizer`) and fails closed when it is unavailable. No prompt text is executed as PHP code or used to select a provider.

`TaskLifecycleService` validates this payload before delegating to `JobQueueService`. `JobQueueService::claimPendingJobById` stamps `worker_id` and a monotonic `claim_attempt` in `task_runs.meta`. `completeJob` and `failJob` require the exact task ID, worker ID, and attempt while the row is `running`; `cancelJob` can transition only `pending`/`running`. Each method locks inside a transaction and performs a conditional state transition, so terminal rows are no-ops. Only a winning `running -> completed` updates task success and enqueues follow-up generation; only a winning `running -> pending` dispatches retry. A generated article whose completion claim is lost is marked `superseded` with orphan lineage. The worker result is stored under `meta.result.discoverystack_generation_v1`.

## Worker behavior

`ProcessGeoFlowTaskJob` reads the claimed task-run metadata. It passes `job_type` and the strict payload only for the DiscoveryStack job type; legacy jobs still call `executeTask($taskId)` exactly as before. The DS branch:

1. Revalidates the payload server-side.
2. Loads the task's configured active chat `AiModel`; it does not use a test-only provider injection seam.
3. Renders a dedicated prompt with the brief, selected canonical rule IDs, approved evidence data delimiters, citation instructions, and output constraints.
4. Calls the existing `ArticleContentGenerationService`, which resolves the configured encrypted model key and provider URL through the existing server runtime.
5. Requires approved evidence citations when `knowledge_rag` is requested, computes the exact generated content SHA-256, and records citation bindings plus `requested_rule_ids` as planned requirements.
6. Creates only a `draft`/`pending` article, records the existing article risk scan, increments generation counters, and returns `applied_rule_ids: []`, `autogeo_execution: false`, provider provenance, content hash, and the exact limitation `AutoGEO optimization has not been executed; this is a base draft.`

A provider failure, empty response, unknown evidence citation, missing model/category, stale task state, or risk-scan failure stops the job; it is not converted into a publishable result. No distribution orchestrator is invoked from the DS branch.

## Security and operational boundary

Credentials remain encrypted and server-side. The TypeScript transport receives an opaque credential reference and injected resolver, never a token in a plan or result. The resolver may return only `{ ok: true, value: { token, allowedBaseUrl } }` or `{ ok: false }`; the normalized `allowedBaseUrl` must exactly equal the normalized target base URL before any Authorization header or fetch is created. TypeScript transport calls use fixed generation routes, manual redirect handling, bounded JSON response reads, request IDs, idempotency keys, injected clock/sleep dependencies, bounded retries, and sealed verified plan/enqueue/job values. The target fingerprint is `sha256(canonical { normalized baseUrl, taskId, credentialReference })` and never contains the token. Enqueue state binds `(idempotencyKey, requestFingerprint)` to that fingerprint with a 1024-entry, 15-minute injected-clock TTL map. The response parser reconstructs the public base draft from verified job metadata plus real article fields and rejects any AutoGEO-executed or non-draft state.

The implementation is runtime-capable but is not a production deployment. Production still needs a caller that supplies the target and credential resolver, a durable cross-process idempotency/replay store, an authenticated network route, upstream interoperability monitoring, and a separately governed review/publication workflow. This task intentionally performs no migration, deployment, real provider request, customer-site write, or publication.

## Verification

The TypeScript suite uses only injected mock fetch/credential/clock/sleep dependencies and exact PHP-shaped fixtures, including the shared normalization parity JSON fixture. The Laravel feature suite uses the real route/controller/service/queue/worker boundary with a fake model HTTP response and tests bearer scope enforcement, payload preservation, truthful base-draft metadata, content hash, article status, and absence of distribution writes. The existing task transaction suite contains direct JobQueue CAS regressions for claim proof, terminal races, stale/wrong worker identity, duplicate dispatch, task mismatch, and superseded orphan lineage.

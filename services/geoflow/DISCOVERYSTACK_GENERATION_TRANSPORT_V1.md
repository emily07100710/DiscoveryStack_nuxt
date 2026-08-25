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

Fingerprints are recomputed using the same sorted-key JSON canonicalization as the public TypeScript request validator. Evidence source IDs must be in the approved authority source set, locators must be public HTTPS URLs, duplicate evidence identities are rejected, and unknown payload keys fail closed. No prompt text is executed as PHP code or used to select a provider.

`TaskLifecycleService` validates this payload before delegating to `JobQueueService`. `JobQueueService::completeJob` locks the task-run row inside a transaction and merges worker result metadata without replacing the original `job_type`, `payload`, attempt, retry, or worker metadata. The worker result is stored under `meta.result.discoverystack_generation_v1`.

## Worker behavior

`ProcessGeoFlowTaskJob` reads the claimed task-run metadata. It passes `job_type` and the strict payload only for the DiscoveryStack job type; legacy jobs still call `executeTask($taskId)` exactly as before. The DS branch:

1. Revalidates the payload server-side.
2. Loads the task's configured active chat `AiModel`; it does not use a test-only provider injection seam.
3. Renders a dedicated prompt with the brief, selected canonical rule IDs, approved evidence data delimiters, citation instructions, and output constraints.
4. Calls the existing `ArticleContentGenerationService`, which resolves the configured encrypted model key and provider URL through the existing server runtime.
5. Requires approved evidence citations when `knowledge_rag` is requested, computes the exact generated content SHA-256, and records actual citation bindings and selected rules.
6. Creates only a `draft`/`pending` article, records the existing article risk scan, increments generation counters, and returns provenance with `mode: provider`, the configured provider/model, request lineage, content hash, and human-review limitation.

A provider failure, empty response, unknown evidence citation, missing model/category, stale task state, or risk-scan failure stops the job; it is not converted into a publishable result. No distribution orchestrator is invoked from the DS branch.

## Security and operational boundary

Credentials remain encrypted and server-side. The TypeScript transport receives an opaque credential reference and injected resolver, never a token in a plan or result. TypeScript transport calls use fixed generation routes, manual redirect handling, bounded JSON response reads, request IDs, idempotency keys, injected clock/sleep dependencies, bounded retries, and sealed verified plan/enqueue/job values. The response parser reconstructs the public candidate from verified job metadata plus real article fields and rejects approved, published, delivered, publishing, or other non-candidate states.

The implementation is runtime-capable but is not a production deployment. Production still needs a caller that supplies the target and credential resolver, a durable cross-process idempotency/replay store, an authenticated network route, upstream interoperability monitoring, and a separately governed review/publication workflow. This task intentionally performs no migration, deployment, real provider request, customer-site write, or publication.

## Verification

The TypeScript suite uses only injected mock fetch/credential/clock/sleep dependencies and exact PHP-shaped fixtures. The Laravel feature suite uses the real route/controller/service/queue/worker boundary with a fake model HTTP response and tests bearer scope enforcement, payload preservation, metadata lineage, content hash, article status, and absence of distribution writes. Existing legacy transaction and worker suites are rerun separately to ensure the optional worker arguments do not alter legacy behavior.

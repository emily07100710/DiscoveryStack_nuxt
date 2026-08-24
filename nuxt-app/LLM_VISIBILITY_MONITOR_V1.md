# Owner-only LLM Visibility Monitor V1

## What this module measures

This private module records bounded, traceable model observations that an authenticated owner has reviewed. It does not measure search rank and does not prove that a brand appeared in a consumer ChatGPT, Gemini, Perplexity, or Google AI Overviews interface.

V1 production/runtime accepts only an owner-reviewed `manual_verified` observation snapshot through the private UI/API. `provider_api_observation` remains in the database/type contract for future compatibility and pure mocked metrics contract tests, but the V1 runtime API rejects it. Mocked observations are never injected into the dashboard. This repository contains no scheduler, provider executor, consumer-UI scraper, browser auto-login, hidden bypass, or unofficial endpoint.

## Privacy and evidence boundary

- Every route requires `requireOwner`, resolves the database owner ID, and scopes project/query/run/observation reads and writes to `ownerUserId`.
- The browser may transiently hash a pasted full response with Web Crypto. The full response is not sent to the server.
- Persistence is limited to a SHA-256 response hash, an excerpt of at most 1,000 characters, structured mention/citation fields, and an evidence locator plus owner review note.
- Public website URLs and citation URLs must be public HTTPS. Localhost, credentials, private/loopback/link-local addresses, and non-HTTPS schemes fail closed.
- Brand matching is deterministic, Unicode-normalized, case-normalized, and uses token boundaries for English/ASCII aliases. Citation matching compares exact parsed canonical hostnames.
- Project creation saves an NFKC/trim/whitespace-normalized brand name, canonical-dedupes aliases and competitors while retaining the first display spelling, and rejects any brand/alias versus competitor canonical collision before persistence.

## Data model and migration

Migration `0013_cuddly_flatman.sql` creates:

- `llmVisibilityProjects`
- `llmVisibilityQueries`
- `llmVisibilityRuns`
- `llmVisibilityObservations`

It is DDL-only. It has no seed/DML, trigger, procedure, migration execution, or provider call. `projectId + promptHash`, owner request fingerprint, and `runId + queryId` uniqueness constraints make common duplicate imports fail closed.

## Private API

- `GET /api/llm-visibility/workspace`
- `POST /api/llm-visibility/projects`
- `POST /api/llm-visibility/queries`
- `POST /api/llm-visibility/observations`
- `GET /api/llm-visibility/projects/:id/summary`

Mutations use strict, bounded Zod objects. The observation route uses a dedicated owner-manual schema whose mode/status/reviewer flags are literals: `manual_verified`, `completed`, and `true`. The service repeats the manual-only fail-closed check before any repository access or commit. Unknown fields such as a raw/full provider response are rejected. Validation errors return explicit 4xx responses without stack traces, SQL, or secrets.

## Metrics contract

The summary reports total and observed queries, brand mention rate, citation rate, exact-domain citation rate, competitor share of voice, average first mention position, provider/locale/mode breakdowns, and current-period versus previous-period deltas. Its fixed metric basis is `manual_verified_v1`.

The primary `current`, `previous`, `delta`, provider, and locale projections use only `manual_verified` rows within the relevant period. `observedQueries` is the number of unique active queries represented by those rows; observation-level rates use the number of qualifying manual observation rows as their denominator. These are deliberately different concepts.

All ratios return `null` with `not_ready` when their denominator is zero. `byMode.manual_verified` and `byMode.provider_api_observation` are calculated independently and never share a denominator. In normal V1 runtime data, the provider API mode remains `not_ready`. The projection always includes limitations and prohibited claims; ranking, consumer-UI exposure, traffic, conversion, revenue, and ROI guarantees are outside this module.

## Operational limits

- Page: `/audit-lab/llm-visibility` (owner layout, i18n disabled, `noindex, nofollow, noarchive`). It is intentionally not added to owner navigation.
- No public page, public CSS, owner layout/navigation, Nuxt config, root package, or Astro migration is changed.
- Migration generation does not execute the migration.
- No deploy or external provider call is part of this work.

# Owner-only LLM Visibility Monitor V1

## Evidence boundary

This owner-only module stores bounded, traceable observations. It does not measure search rank and does not prove exposure in consumer ChatGPT, Gemini, Perplexity, or Google AI Overviews. `manual_verified` observations enter primary metrics only after the durable owner review ledger approves them. Every provider execution remains `provider_api_observation`, `verifiedByOwner=false`, `secondary_only`, with limitation `provider_api_not_consumer_surface`.

Full provider responses are never persisted. Stored evidence is limited to hashes, a bounded excerpt, derived mention/citation fields, citation freshness metadata, an evidence locator, and safe provenance. Default tests use injected adapters and never call a real provider.

## Durable entities

The original project, query, run, observation, and review tables are extended by migration `0036_silent_stranger.sql` with:

- `llmVisibilityPromptVersions`: immutable, one-based versions of normalized query text and hash. A query lazily receives v1 on first sync/use; normalized text changes append a version.
- `llmVisibilityCompetitors`: owner/project-scoped display name, canonical key, aliases, optional canonical hostname, and active state. Deactivation never deletes history.
- `llmVisibilityBenchmarkRuns`: the benchmark mother row, requested/succeeded/failed counters, frozen query/provider/prompt/competitor inputs, frozen brand name/aliases/measured domain, engine limits, lifecycle timestamps, limitations, and aggregate snapshot.
- `llmVisibilityBenchmarkSamples`: one durable query/provider/model repetition with its own window, fingerprint, attempts, failure, and run/observation linkage.

Both the run and observation store `promptVersionId`; observation-level attribution is authoritative when one run could otherwise cover several queries. Benchmark runs also store `benchmarkRunId` and `sampleIndex`. Observations may store `citationFreshness`; no raw-response column exists.

## Registries

`ensurePromptVersion` and `ensureCompetitorRegistry` are the shared lazy-backfill functions used by registry sync, synchronous provider observations, and benchmark creation. Sync is idempotent. Provider plans use active registry rows only; inactive rows remain available for historical share-of-voice attribution. Legacy `projects.competitorBrands` is imported only when a canonical registry row does not already exist, so deactivation cannot be undone by a read-only legacy JSON value.

The active competitor name-plus-alias set is canonical-deduped and capped at 30, the probe-engine boundary. Create, update, reactivation, sync, and plan construction all fail with 422 instead of truncating. Brand/alias collisions also fail with 422.

## Benchmark lifecycle

`POST /api/llm-visibility/benchmarks` strictly accepts one active project, 1–100 unique active query IDs, 1–12 unique provider/model targets, optional label, and `sampleSize` 1–10 (default 5). It first freezes prompt versions, active competitor registry entries, brand name, brand aliases, and canonical measured domain. Duplicate provider/model pairs fail 422 before persistence. `requestedSamples = sampleSize × queries × providerTargets` must not exceed positive integer env `LLM_VISIBILITY_BENCHMARK_MAX_PROBES` (default 250); invalid env values use the default and excess requests fail 422 without truncation.

Every sample plan, resume, stored aggregate, live detail recompute, and comparison uses the benchmark's frozen brand/aliases/domain. Editing the project later cannot rewrite an old benchmark's identity or results; a benchmark created after the edit freezes the new identity. The detail UI labels this boundary as `本次以 <網域> 量測`.

The mother row and every pending sample are inserted in one transaction. The route returns the queued ID immediately and starts an in-process background executor without awaiting it. The owner-requested executor uses a module-local benchmark lock, concurrency 5, existing per-probe deadlines (maximum 120 seconds), existing exact-key runner validation, and at most three attempts per sample per execution. Every success or terminal failure and the benchmark counters/progress timestamp are written immediately.

Each sample uses a one-probe plan with window `benchmark:<benchmarkId>:sample:<k>`. The engine identity and `canonicalProbeIdentity` are unchanged; the window makes repetitions deterministic and mutually distinct. Before a provider call, the executor reconciles an existing owner/fingerprint run and observation. A persistence 409 is reconciled the same way.

Lifecycle states are `queued`, `running`, `completed`, `partial`, and `failed`:

- all requested samples succeeded: `completed`;
- at least one but fewer than requested succeeded: `partial` plus `partial_sample`;
- exactly one succeeded: also `single_sample_not_trend`;
- none succeeded: `failed` plus `insufficient_sample`.

Only succeeded observations enter aggregates. Failed/pending rows are never silently discarded. Resume executes only non-succeeded rows. A `running` benchmark is interrupted/resumable only when its last progress (falling back to start/create time) is more than ten minutes old and no executor lock exists in this process. A fresh running benchmark returns `benchmark_already_running`; a fully successful completed benchmark has nothing to resume. Scheduled auto-resume is a separate, stricter opt-in path described below.

## Opt-in scheduled recovery

Nitro task `llm-visibility:benchmark-tick` may run every five minutes (`LLM_VISIBILITY_BENCHMARK_CRON`, default `*/5 * * * *`). It is disabled unless `LLM_VISIBILITY_BENCHMARK_AUTO_RESUME=true`; the disabled task performs no owner lookup, database access, provider call or citation HEAD fetch. Enabling it requires an explicit `OWNER_OPEN_ID` which resolves to that exact configured owner, without an admin fallback. This is runtime scheduling, so a sleeping/free host does not provide reliable background delivery.

A tick reads at most ten existing owner-scoped benchmarks and executes at most one. Only owner-created `queued` rows or `running` rows with progress/start/create timestamps at least ten minutes old qualify. It never creates benchmarks, queries, versions or approval records. `partial`, `failed`, `completed`, fresh running and this-process active rows remain outside automatic execution. A database compare-and-set repeats the owner/status/staleness predicate at claim time, so another cron or a manual executor cannot claim the same fresh row and a concurrent change to partial/failed does not turn into automatic retry.

`LLM_VISIBILITY_BENCHMARK_TICK_MAX_PROBES` defaults to 5, positive integer overrides are capped at 5, and invalid/zero/negative values stop the tick before I/O. The number of remaining non-succeeded samples must fit the entire budget, otherwise that benchmark is skipped without claim or partial truncation. All eligible automatic samples share one concurrency-5 batch, each with the existing maximum 120-second probe deadline and **one attempt**. Scheduled recovery disables citation HEAD even when it is enabled for manual execution; citation metadata/URL dates still remain available.

Before each automatic attempt, the existing owner/fingerprint result is reconciled without calling the provider. Any non-succeeded sample already marked failed, with a nonzero attempt count or a recorded start time and no durable result becomes failed with `AUTOMATIC_RESUME_PRIOR_ATTEMPT`; it requires manual review/retry because the previous call may already have been charged. Attempt intent is persisted before provider execution with a sample-level owner/benchmark/status/zero-attempt/no-start compare-and-set, preventing concurrent automatic workers from sending the same remaining sample. Retryable failures also receive no automatic retry, and the normal aggregate finalizes the benchmark as partial/failed. An execution-level exception after claim finalizes `failed` with `automatic_resume_failed_manual_retry_required`. If database failure prevents finalization, the fresh claim blocks the next tick and previously attempted samples still cannot be sent automatically after staleness. Manual resume keeps its original three-attempt semantics and frozen inputs.

Enabling the environment flag and deploying/registering the Nitro task require the owner's separate platform authorization. Local mock tests prove scheduling contracts only; production scheduling, database atomicity under the real driver and paid-provider results remain unverified until authorized live acceptance.

## Statistics and aggregates

Each rate includes `n`, the point estimate, standard error, and a 95% Wilson interval. First-mention position and citation age use sample-mean standard error with the n-1 sample variance; n below two has no standard error. No n=1 result is presented as a trend or delta. Comparison returns `comparable=false` and a limitation when either side has insufficient samples, and adds `prompt_version_mismatch` when a shared query used different prompt versions.

Benchmark aggregates include requested/succeeded/failed counts, failure-code counts, brand/citation/exact-citation estimates, mean first position, deterministic provider/query breakdowns, prompt versions, registry share of voice (including bounded/sorted unlisted names), and citation freshness counts/age. Stored snapshot and live recompute use the same pure aggregate function.

## Citation freshness

Each citation record stores `{url, dateSource, sourceDate, ageDays}`. Priority is provider metadata, a validated URL-path date (`/YYYY/MM/DD/` or `YYYY-MM-DD`, real dates, years 2000 through observation year + 1), then HTTP `Last-Modified`, otherwise `unknown`. Manual imports use URL patterns only.

HEAD is off unless `LLM_VISIBILITY_CITATION_HEAD_FETCH=true`. When enabled it is injectable, cached once per URL per benchmark, capped at 100 requests, timed out after five seconds, and follows at most three redirects manually. Every initial/redirect hostname is resolved and all addresses must be public. HTTP(S) only; credentials, localhost, loopback, private, carrier-grade NAT, link-local, zero-network, IPv6 loopback/unique-local/link-local, and IPv4-mapped forms fail closed. Missing/unparseable `Last-Modified`, a value equal to the response `Date`, future values, or values less than 24 hours old remain `unknown`.

## Private API

All routes require owner authentication, resolve `ownerUserId`, set `no-store`/`noindex`, and use strict bounded schemas:

- `GET /api/llm-visibility/workspace`
- `POST /api/llm-visibility/projects`
- `POST /api/llm-visibility/queries`
- `PATCH /api/llm-visibility/queries/:id`
- `POST /api/llm-visibility/observations`
- `POST /api/llm-visibility/observations/:id/review`
- `POST /api/llm-visibility/provider-observations`
- `GET /api/llm-visibility/projects/:id/summary`
- `GET|POST /api/llm-visibility/projects/:id/competitors`
- `PATCH|DELETE /api/llm-visibility/competitors/:id` (`DELETE` deactivates)
- `POST /api/llm-visibility/projects/:id/registry/sync`
- `POST|GET /api/llm-visibility/benchmarks`
- `GET /api/llm-visibility/benchmarks/:id`
- `POST /api/llm-visibility/benchmarks/:id/resume`
- `GET /api/llm-visibility/benchmarks/compare?left=&right=`

The synchronous provider route and scheduled measurement caller keep their original input and exactly-one-execution behavior. No background route weakens the provider evidence classification.

## Page and operational limits

`/audit-lab/llm-visibility` is private/noindex. It provides prompt/competitor registry controls, benchmark creation and five-second progress polling, interrupted/partial resume controls, n/CI/limitations, prompt versions, share of voice, citation freshness, and comparison. Polling stops when no queued/running rows remain and is cleared on unmount. `single_sample_not_trend` is rendered as `單次結果，不能當趨勢`, never as a delta.

Real credentials remain explicit opt-in. Automated tests are mocked, perform no real provider call, no real citation HEAD fetch, and do not apply migrations.

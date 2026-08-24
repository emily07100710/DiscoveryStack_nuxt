# Content Operations Persistence & Scheduler Core V1

## Purpose

Content Operations V1 is an owner-scoped persistence and scheduling layer over the existing pure `content-calendar`, `delivery-automation`, and `outcome-learning` engines. It stores durable operational metadata and delegates deterministic planning, materialization, delivery-contract identity, and outcome assessment to those existing authorities. It does not replace or copy their algorithms.

> **V1 is a durable coordination substrate, not a content generator, publisher, CMS connector, or production-ready worker fleet.**

## Trust boundaries

The browser may submit client configuration, calendar timing and budget parameters, replan expectations, and bounded outcome measurements. The server derives `ownerUserId` exclusively from `requireOwner()` plus `getOwnerDatabaseUserId()`. Calendar opportunities are reconstructed from the owner-scoped persisted SEO/GEO Production Plan, selected strategy recommendations, deliverables, evidence snapshot, rules, topic cluster, and authority-source provenance. The browser cannot submit an opportunity array, evidence hash, draft ID, review ID, content hash, or publication identity.

Public site origins are canonicalized to HTTPS origins and reject credentials, paths, query strings, fragments, localhost, private IPs, and link-local addresses. The client table contains no token, secret, authorization header, or credential value. Error summaries are bounded and sanitized; routes do not expose raw SQL errors, stack traces, content bodies, or credentials.

All six new tables are owner-scoped. Repository queries include owner predicates, and services verify cross-table ownership for clients, calendars, plans, deliverables, jobs, drafts, reviews, runs, and outcome records. Events are append-only: the repository exposes insert/list behavior but no update/delete operation.

## Persistence model

`contentOperationClients` stores the public site origin, Astro/Nuxt framework, first-party transport declaration, timezone, cadence, local publish time, and budget. `contentOperationCalendars` stores the pure engine request/result snapshots, evidence lineage, revision chain, fingerprint, and idempotency key. `contentOperationCalendarEntries` stores the durable projection of engine entries and server-owned SEO/GEO linkages; it begins without a draft, review, job, or content hash.

`contentOperationRuns` stores staged durable runtime state for generation, review wait, publication, measurement, and learning. A bounded lease prevents two active processors from holding the same entry/stage lease at once, while expired leases may be recovered. `contentOperationEvents` is the append-only audit ledger. `contentOperationOutcomeAssessments` stores bounded baseline/follow-up measurement projections, assessment snapshots, consent lineage, and fingerprints; it deliberately does not store crawled full page bodies.

The schema-only migration is generated through the repository's Drizzle workflow as `0014_tan_stone_men.sql`. It has not been executed. Migration runtime validation and production migration are intentionally not run in this task.

## Runtime flows

Calendar creation loads a persisted Production Plan and invokes `buildContentCalendar()`. It persists one calendar snapshot, its entries, and an append-only creation event transactionally. The same owner/idempotency payload replays the original record; a different payload using the same key is rejected as a collision.

Replanning loads the persisted calendar, requires the expected current plan fingerprint, and invokes `replanContentCalendar()`. Revision continuity and `previousPlanFingerprint` are persisted. Existing completed or delivered entries are preserved rather than rewritten; planned entries that no longer belong to the new deterministic plan are cancelled.

Materialization derives the current local date from the server clock and the persisted client timezone, then invokes `materializeDueContentWork()`. It claims only durable planned entries, creates a generation or review-wait run, records the transition event, and never calls a provider. The internal scheduler processes no more than 50 entries per tick. Lease conflicts are left for a later tick.

Outcome recording requires a delivered or completed calendar entry, a server-resolved job/draft/approved-review/publication-run identity, and matching content/evidence lineage. It invokes `assessPublishedContentOutcome()`. When requested, it also invokes `buildOutcomeLearningCandidate()`; a blocked candidate is retained as a blocked result and is never marked learning-ready. V1 uses `piiScanStatus: unknown` for this boundary, so learning admission remains blocked until a separate governed collection and PII gate exists.

## Explicit non-actions

V1 does not call LLMs, external providers, Firecrawl, Hugging Face, first-party APIs, Git transports, CMS endpoints, websites, or publication adapters. It does not generate articles, auto-approve reviews, publish content, collect outcomes automatically, or manufacture a publication identity. The Nitro task is a bounded metadata/materialization task only.

## Verification status

The repair was verified with a frozen install, strict typecheck, 16 Content Operations runtime/route tests, the 757-test Content Calendar/Delivery/Outcome regression, 16 SEO/GEO targeted tests, production-origin SSR, and a node-server production build. A throwaway integration worktree based on `origin/main` also cherry-picked the complete 01 repair chain plus the 02 base/repair commits (`275cbd3`, `51c1b800`) and 03 base/repair commits (`822418b`, `5a5070e`); its typecheck, 952 cross-package targeted tests, and production build passed. The throwaway worktree was removed after verification.

The repair specifically makes canonical SEO/GEO context authoritative, accepts the flat Workbench replan/materialize payloads, uses insert-first operation claims and conditional calendar updates, routes bounded selection through `eligibleEntryIds`, preserves pure-engine fingerprints and durable lifecycle state, gives every invocation a server-generated lease token, and exposes only truthful workspace lineage. Full Vitest, migration execution, production migration, external provider calls, external content writes, and deployment remain intentionally out of scope.

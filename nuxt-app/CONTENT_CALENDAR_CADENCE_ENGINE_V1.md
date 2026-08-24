# DiscoveryStack Content Calendar & Cadence Engine V1

## Purpose and scope

Content Calendar & Cadence Engine V1 is a pure server-side, offline, deterministic, fail-closed domain engine. It plans already-selected content opportunities from the upstream strategy workflow into a bounded calendar using client scope, local publishing tuple, fixed cadence, evidence snapshot, budget, and item caps.

This V1 contains only contracts, normalization, policy catalog, planning functions, synthetic fixtures, one targeted test file, and this design document. It does not contain a page, UI, API route, database, migration, scheduler, queue, provider, CMS, HTTP client, delivery executor, or background task. Persistence, dispatch, authorization, and external delivery remain future integration-layer responsibilities.

## Public contract

The only public barrel is `server/content-calendar/index.ts`. The fixed engine version is `content-calendar-cadence-engine-v1`. The public pure-function entry points are:

```text
normalizeContentCalendarRequest
buildContentCalendar
materializeDueContentWork
replanContentCalendar
canonicalJson
fingerprintCanonical
```

`ContentCalendarRequest` accepts exactly these top-level keys:

```text
clientScopeKey, planStartDate, planEndDate, timeZone, publishLocalTime,
cadenceDays, monthlyBudgetUnits, defaultCostUnits, maxItemsPerCalendarMonth,
maximumTotalItems, catchUpPolicy, evidenceSnapshotHash, opportunities
```

Each opportunity accepts exactly these keys:

```text
id, strategyRecommendationId, title, contentType, language, priority,
status, topicCluster, evidenceSnapshotHash, estimatedCostUnits, ruleIds,
authoritySourceIds
```

`MaterializeDueContentWorkInput` requires exactly `calendar`, `expectedPlanFingerprint`, and `nowLocalDate`, with only `completedEntryIds` and `cancelledEntryIds` optional. `ReplanContentCalendarInput` requires exactly `calendar`, `expectedPlanFingerprint`, and `request`. Unknown, missing, or fallback fields are rejected.

## Exact runtime boundary

All public inputs use exact-shape, bounded, fail-closed validation. Unknown keys, missing required keys, key-count mismatches, primitive values, null values, malformed arrays, nested read exceptions, Proxy `ownKeys` exceptions, getter exceptions, non-finite numbers, unsafe integers, invalid dates, invalid timezones, invalid local times, unsupported cadence, invalid hashes, mixed evidence snapshots, duplicate identities, and over-limit collections are blocked without leaking raw input.

The engine never accepts raw article bodies, prompts, model responses, customer PII, customer email, phone, URLs, tokens, secrets, provider credentials, CMS payloads, or delivery artifacts. It does not silently discard unknown fields: an unknown field is a boundary failure. Public catch blocks return a safe blocked result rather than an exception or a copy of malicious input.

The normalizer bounds opportunities at 200, total calendar entries at 100, monthly entries at 31, and numeric budget/cost fields at safe positive values within the policy catalog. Evidence hashes must be lowercase 64-character SHA-256 hex strings and every opportunity must match the request evidence snapshot.

## Trusted state binding

`planFingerprint` is a deterministic public SHA-256 content checksum. It is not an authentication proof, signature, MAC, HMAC, authorization proof, or database provenance proof. A caller who can alter a complete snapshot can also recompute its public checksum.

Every stateful operation therefore requires an independent `expectedPlanFingerprint` input. The engine validates this value before it trusts calendar entries, statuses, dates, reason codes, or normalized request fields:

```text
materializeDueContentWork({
  calendar,
  expectedPlanFingerprint: calendar.planFingerprint,
  nowLocalDate,
})

replanContentCalendar({
  calendar,
  expectedPlanFingerprint: calendar.planFingerprint,
  request,
})
```

The expected value must be a lowercase 64-character SHA-256 string and must exactly equal the supplied `calendar.planFingerprint`. It is never trimmed, case-normalized, inferred from the calendar, or read from a request fallback field. Missing, null, uppercase, malformed, non-string, or different values fail closed. The comparison occurs before entry statuses, dates, reason codes, revisions, or normalized request data are trusted.

If a caller changes a planned status, entry date, slot ordinal, identity, reason, revision, or previous fingerprint and recomputes the public checksum, the previously saved trusted expected value still rejects the forged snapshot. A newer legal output must be supplied with its own newest `planFingerprint`; reusing an older fingerprint is rejected.

In the future, `expectedPlanFingerprint` may be injected only by trusted server-side persistence or an append-only state ledger. Browser, customer, CMS, and provider inputs must not be treated as trusted expected values. V1 has no database, so its tests verify the pure contract and boundary only; they do not claim cross-process authenticity.

## Revision continuity

Every `ContentCalendarResult` contains the fixed fields `revision` and `previousPlanFingerprint` in addition to the normalized request, entries, unscheduled opportunities, reason codes, limitations, and `planFingerprint`.

| Result state | `revision` | `previousPlanFingerprint` |
|---|---:|---|
| Initial successful build | `1` | `null` |
| Initial or operation blocked result with no valid calendar | `0` | `null` |
| A changed valid calendar | previous revision + 1 | input calendar `planFingerprint` |
| A valid idempotent no-op | unchanged | unchanged |

A changed state includes planned → materialized, planned → skipped, planned/materialized → cancelled, materialized → completed, and a valid replan that changes canonical state. A no-op includes completed → completed, cancelled → cancelled, an already-materialized replay, no due work with no transition, and completion/cancellation inputs that do not change an already-terminal status.

Revision is a bounded positive safe integer for valid calendars. Revision one must have a null previous fingerprint. Revision greater than one must have a lowercase 64-character previous fingerprint. Revision zero is reserved for blocked results and cannot contain entries. Both revision and previous fingerprint are included in the canonical plan fingerprint payload. The public chain is audit-continuity metadata only; it is not a cryptographic authenticity proof.

## Deterministic schedule

The engine creates the first slot on `planStartDate`, then advances by the configured cadence in UTC calendar-day arithmetic until `planEndDate`. Supported cadence values are `3`, `7`, `15`, and `30`. It keeps the local date/time/timezone tuple and does not convert it to an instant.

Candidates are sorted by priority `high → medium → low`, numeric `strategyRecommendationId`, and explicit ASCII comparison of normalized opportunity ID. Identifier, reason-code, object-key, and collection ordering never depend on runtime locale. Among candidates affordable for the current month, the planner prefers a different `topicCluster` from the preceding entry, then falls back to the deterministic affordable candidate set. Topic diversity never blocks an affordable same-topic candidate. Each opportunity is used at most once.

Each planned entry has a schedule key of the form:

```text
clientScopeKey|plannedLocalDate|slot-NNNN
```

`slot-NNNN` is the exact index of that date in the deterministic slot list. The validator checks the scope, date, and ordinal against the actual slot list; a valid-looking ordinal alone is insufficient.

## Calendar semantic reconstruction

A matching public fingerprint is not enough. Before materialize or replan trusts a calendar, the engine performs the following sequence:

1. It validates the independent expected fingerprint against the supplied calendar fingerprint.
2. It exact-shape validates the calendar top-level, revision metadata, normalized request, entries, unscheduled results, reason codes, and limitations.
3. It normalizes and canonicalizes the supplied request and checks the supplied normalized request for canonical equality.
4. It checks entry identity, schedule key scope/date/ordinal, opportunity metadata, evidence, lifecycle status, dates, uniqueness, and idempotency.
5. It reconstructs expected entries, unscheduled results, status, reason codes, caps, budget, and topic ordering using the official deterministic algorithm.
6. It checks that every opportunity has exactly one valid representation and that preserved reasons are semantically justified.
7. It verifies the supplied `planFingerprint` against the reconstructed canonical payload, including revision and previous fingerprint.

Any caller who modifies a materialized, completed, cancelled, skipped, or historical entry date or slot, then recomputes its entry and calendar hashes, is rejected when the trusted expected fingerprint is the previously saved value. Even when a caller recomputes a forged snapshot and supplies that forged fingerprint as expected, semantic reconstruction rejects invalid date, slot, lifecycle, budget, cap, or representation state.

For replan, the old calendar is validated against its old normalized request and its trusted expected fingerprint before fixed entries are selected. The new request cannot make a forged historical entry appear to be a newly created entry.

## Budget, cap, and unscheduled semantics

Each month independently observes `monthlyBudgetUnits` and `maxItemsPerCalendarMonth`; the whole plan observes `maximumTotalItems`. The planner skips an unaffordable candidate and continues looking for an affordable candidate rather than allowing an expensive opportunity to block a cheaper one.

Every request opportunity must occur exactly once: either as one calendar entry or as one unscheduled result. An opportunity cannot occur in both collections, and it cannot have multiple unscheduled reasons. Non-selected opportunities use `OPPORTUNITY_NOT_SELECTED`. Selected opportunities receive only the reason derived by the official scheduling algorithm, such as budget exhaustion, monthly cap, plan cap, or unavailable slot.

A calendar with entries and unscheduled results is `partial`; an empty calendar is `blocked`; a calendar with entries and no unscheduled results is `ready`. Historical fixed entries are retained during replan. If fixed history already exceeds a newly reduced monthly budget or monthly item cap, the engine emits the explicit historical reason and does not add new planned entries that worsen the exceeded month. If fixed history exceeds the new whole-plan cap, replan is blocked with `PLAN_ITEM_CAP_REACHED` and no entries.

## Entry identity and historical slot semantics

Every entry validates:

- `scheduleKey` scope and date against the request and `plannedLocalDate`;
- deterministic slot ordinal against `createSlots(request)`;
- `entryId` against immutable engine-version/schedule/date/opportunity/evidence identity;
- `idempotencyKey` against schedule/opportunity/strategy/evidence identity;
- opportunity strategy, content type, language, topic, cost, and evidence;
- known lifecycle status and exact entry shape.

For a current calendar, every entry date must be a legal cadence slot, regardless of whether its status is planned, materialized, completed, cancelled, skipped, or blocked. Recomputed entryId, idempotencyKey, and calendar fingerprint do not make a non-cadence historical date legal. The validator checks the exact slot index, so `slot-0001` or `slot-0099` cannot be paired with the first slot date.

Preserved fixed entries retain their original entryId, scheduleKey, plannedLocalDate, idempotencyKey, and evidence lineage. A replan may preserve an old fixed entry against its old request even if a new request has a different horizon, but it must not rewrite that entry's origin or treat it as newly scheduled. Any new planned entry must use a slot from the new request.

## Entry lifecycle truthfulness

The formal lifecycle table is:

| Current status | Allowed next status | Meaning |
|---|---|---|
| `planned` | `planned`, `materialized`, `skipped`, `cancelled` | initial plan, due materialization, catch-up skip, or cancellation |
| `materialized` | `materialized`, `completed`, `cancelled` | idempotent work state, completion, or cancellation |
| `completed` | `completed` | terminal idempotent replay |
| `cancelled` | `cancelled` | terminal idempotent replay |
| `skipped` | `skipped` | terminal idempotent replay |
| `blocked` | `blocked` | reserved terminal state; this engine does not emit blocked entries |

`completedEntryIds` can only produce materialized → completed or completed → completed. `cancelledEntryIds` can only produce planned → cancelled, materialized → cancelled, or cancelled → cancelled. Planned → completed, planned → materialized without due evaluation, completed → cancelled, cancelled → completed, skipped → completed, and blocked → materialized fail closed.

A planned entry becomes materialized only when it is genuinely due according to the supplied local date. A skipped entry is produced only by catch-up handling of a missed planned entry. A completed status is not a claim of provider success, conversion, publication, or business performance; it is only a governed lifecycle transition in this pure snapshot engine.

A public checksum alone cannot prove that an entry really passed through an earlier lifecycle state. Trusted expected fingerprint binding prevents a caller from substituting a forged snapshot when the previously saved expected value is used; future server-side persistence is required for durable historical authenticity.

## Due work and catch-up

`materializeDueContentWork` partitions planned entries into missed, today, and future based on the explicit `nowLocalDate` tuple. Future entries remain planned. `skip_missed` skips all missed entries and materializes today entries. `one_catch_up` materializes today entries plus at most one earliest missed entry, then skips every remaining missed entry so a repeated call cannot drain the backlog one item at a time.

`NO_DUE_WORK` belongs to the operation result only. It is not permanently appended to the updated calendar's planning reason codes and is not added to the calendar fingerprint. Repeated materialization of materialized, completed, cancelled, skipped, or blocked entries produces no duplicate due work.

## Replan continuity

A replan must include the current calendar's trusted expected fingerprint and a new request with the same evidence snapshot. The old calendar is fully validated before fixed entries are selected. Preserved materialized or completed entries may cause `REPLAN_PRESERVED_EXECUTED`; cancelled, skipped, and blocked history does not claim successful execution.

A valid state-changing replan increments revision and sets `previousPlanFingerprint` to the old calendar fingerprint. An equivalent replan is idempotent and keeps revision unchanged. Fixed entries equal to the new total cap leave no capacity for new entries. Fixed entries below the cap permit only the remaining capacity. Preserved fixed dates and identities are never re-created as duplicate planned entries.

If a preserved opportunity is missing from the new request, replan returns `PRESERVED_OPPORTUNITY_MISSING` without silently dropping the old entry. If it exists but is no longer selected, replan fails closed. No caller-supplied boolean can establish that an entry is preserved.

## Reason code integrity

Calendar planning reasonCodes are reconstructed from unscheduled results and actual state. Ordinary initial build cannot contain `REPLAN_PRESERVED_EXECUTED`, `NO_DUE_WORK`, or `ALREADY_MATERIALIZED`. `REPLAN_PRESERVED_EXECUTED` is valid only after a real replan preserves a materialized or completed entry. `NO_DUE_WORK` is an operation result and is not permanently added to the updated calendar.

Unknown, duplicate, unsorted, or state-inconsistent reason codes fail closed. An opportunity cannot be present in both entries and unscheduled results, and each opportunity has exactly one state representation.

## Fingerprint contents and honest limitations

The canonical plan fingerprint includes engine version, revision, previous fingerprint, all normalized scheduling settings, all selected opportunity metadata including title, all entry fields including lifecycle status, all unscheduled results, and sorted reason codes. This makes title, lifecycle, and continuity changes observable in deterministic identity.

It remains a public SHA-256 checksum. It does not prove who produced a snapshot, whether a browser or customer was authorized, whether a provider executed work, or whether a database transaction committed. `expectedPlanFingerprint` is an optimistic trusted-state binding input, not a signature. `previousPlanFingerprint` and `revision` are audit-continuity metadata, not a cryptographic chain of authenticity.

Future integration must provide server-side expected-state injection, owner authorization, persistence, transaction/lease handling, dispatch idempotency, retry policy, and audit storage. DST resolution, provider execution, queue dispatch, and delivery semantics belong to that future layer. V1 has no DB and therefore provides no cross-process authenticity proof.

## Non-functional boundaries

This module provides no ranking, traffic, search-volume, LLM-citation, conversion, profitability, ROI, audience, or provider-performance guarantee. It does not access live data and does not make network, API, database, CMS, scheduler, queue, or provider calls. It does not contain real clients, production URLs, customer content, credentials, secrets, datasets, weights, dumps, or delivery artifacts.

## Verification contract

The single targeted test file `tests/content-calendar-cadence-engine.test.ts` preserves the prior 122 tests and adds the third-revision adversarial coverage. The final suite contains **163 tests**, including:

- expected fingerprint missing, null, uppercase, malformed, mismatched, valid, stale, getter, and Proxy cases;
- planned lifecycle forgery to completed, materialized, cancelled, skipped, and blocked;
- legitimate materialized → completed and terminal idempotent replays;
- historical materialized/completed/cancelled/skipped date and slot tampering after recomputing public hashes;
- exact schedule date and ordinal acceptance;
- initial, changed, no-op, blocked, completion, cancellation, skip, and replan revision continuity;
- unknown input keys and blocked-output non-disclosure;
- the prior cadence, budget, cap, topic, evidence, normalization, due-work, catch-up, and replan coverage.

Full Vitest is explicitly **NOT RUN** for this task. Migration and Deploy are explicitly **NOT RUN**. Production build outputs are cleared before commit; only `nuxt-app/.nuxt` and `nuxt-app/.output` may be removed after build.

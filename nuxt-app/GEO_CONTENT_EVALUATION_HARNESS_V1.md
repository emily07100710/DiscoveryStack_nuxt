# Evidence-bound GEO Content Golden Evaluation Harness V1

## Purpose and boundary

This harness is a deterministic, offline evaluation layer for comparing candidate Markdown generated from the same brief, approved evidence, selected canonical GEO rules, and retrieval context. It is a regression harness, not a model trainer, truth score, ranking predictor, citation-improvement predictor, or automatic publication approval.

The harness imports only the public barrel of `server/geo-content-quality`. It does not copy quality rules, modify the existing quality contract, invoke a provider, access a database, call a route, use an embedding or vector store, read network content, or write to a customer-facing system.

## Canonical evaluation case and trust boundary

`createGeoContentEvaluationCase()` and `evaluateGeoContentCandidate()` accept an exact raw candidate envelope containing only `caseId`, `candidateId`, `variantLabel`, `qualityInput`, `providerOutput`, and `markdown`. Unknown candidate keys, malformed values, null/array envelopes, throwing getters, and provider validation failures are contained and fail closed. A missing provider output or Markdown is `insufficient_data`; malformed or contract-invalid input is `blocked`.

The server normalizes the existing `ContentQualityInput`, rebuilds retrieval from the complete approved-evidence corpus, rebuilds the prompt pack, validates the provider output, and runs the existing structured quality gate. It then derives `briefFingerprint`, `promptPackFingerprint`, `retrievalFingerprint`, `contentHash`, provider provenance, and every metric from trusted server values. Caller-provided status, score, metric, hash, or fingerprint fields are not accepted as authoritative inputs.

`compareGeoContentCandidates()` and `buildGeoContentRegressionReport()` accept raw candidate envelopes, not previously evaluated output cases. They call the canonical evaluator internally for every accepted input. This prevents a caller from manufacturing a review-ready case or injecting a favorable metric/result object. Output-only cases are rejected with `EVALUATION_RAW_INPUT_REQUIRED` or `EVALUATION_UNKNOWN_FIELD` and cannot produce a winner or report fingerprint.

Each valid case records the suite version, case identity, content type, locale, topic, all baseline fingerprints, evidence snapshot hash, canonical selected-rule order, exact Markdown string, exact content hash, provider/model provenance, structured quality-gate result, metric records, and reason codes. The case fingerprint is a deterministic regression identifier, not an authenticity signature.

## Metrics contract

Every metric is an explainable deterministic record:

| Field | Contract |
|---|---|
| `applicable` | True only when the metric denominator is a positive applicable count |
| `numerator` | Non-negative integer count bounded by the denominator |
| `denominator` | Explicit non-negative integer used for the metric |
| `ratio` | `numerator / denominator`, or `null` for 0/0/non-applicable |
| `reasonCodes` | Contract or metric findings; never a hidden score |
| `evidenceLocator` | Stable pointers to Markdown, provider output, quality gate, or input fields |

The catalog includes direct-answer presence, heading hierarchy, **paragraph-binding integrity**, FAQ binding, selected AutoGEO rule coverage, citation marker coverage, selected evidence utilization, unused citation count, unsupported factual claim findings, authority-source binding, title/H1 alignment, topic lexical relevance, content bounds, provider provenance integrity, and human-review requirement.

Metric constructors reject non-finite, fractional, negative, and out-of-bounds values. Non-applicable metrics are represented as 0/0 with `ratio: null`, including FAQ binding for non-FAQ content and metrics in an empty aggregate. The harness retains aggregate numerators and denominators and never invents a 100% ratio for 0/0. It intentionally does not create a single opaque GEO, truth, ranking, traffic, conversion, revenue, ROI, or citation-improvement score.

## Status contract

Only three evaluation statuses are emitted: `review_ready`, `blocked`, and `insufficient_data`. `review_ready` means that deterministic contract evaluation is available for human review; it does not mean approved, publishable, published, delivered, ranking improvement, or LLM citation improvement. A blocked or insufficient-data case cannot become a comparison winner.

## Raw candidate comparison and Pareto contract

`compareGeoContentCandidates()` re-evaluates both raw envelopes on the server before comparison. The complete baseline must be identical: suite version, **case ID**, content type, locale, topic, brief fingerprint, prompt-pack fingerprint, retrieval fingerprint, evidence snapshot hash, and selected-rule ID order. Any mismatch returns `blocked` with no winner.

Only compatible `review_ready` cases are compared. Metrics use fixed catalog order and deterministic arithmetic. Positive content metrics use higher-is-better semantics; unused-citation and unsupported-factual-claim findings use lower-is-better semantics. Governance metrics such as provider provenance integrity and human-review requirement are reported but never vote for a content winner.

The decision is based on Pareto dominance over comparable content metrics. A side wins only when it is better on at least one comparable metric and is not worse on any comparable metric. Mutual improvement in different dimensions returns `inconclusive`; all equal comparable metrics return `tie`; no comparable metric returns `insufficient_data`. Neither comparison nor report emits an opaque composite score.

## Bounded regression report

`buildGeoContentRegressionReport()` re-evaluates every raw candidate, then sorts accepted cases by deterministic code-unit order of case ID, candidate ID, and variant label. The report accepts at most 500 candidates and rejects duplicate `(caseId, candidateId, variantLabel)` identities before producing a fingerprint. Invalid or output-only cases fail closed; empty input is `insufficient_data`; a blocked case makes the report `blocked`.

The report produces case counts, status counts, all metric aggregates with their denominators and nullable ratios, per-case deterministic `evaluationFingerprint`, case-level reason codes, limitations, and a regression fingerprint derived from canonicalized case outcomes and aggregates. Input order does not affect the report fingerprint. The report fingerprint is for deterministic regression detection only; it is not a cryptographic signature, authenticity proof, truth score, ranking signal, or publication approval.

## Golden fixtures and exact expected outcomes

The fixture module uses only synthetic metadata and synthetic Markdown while reusing the existing quality fixture factory and public quality barrel. The direct suite contains **185 tests** and includes an exact expected-result table for valid, malformed Markdown, missing direct answer, heading regression, citation failure, unselected evidence, unsupported claim, stale evidence, wrong rule, FAQ mismatch, Unicode/CJK, prompt/retrieval regression, and provider-provenance mismatch variants.

The suite also directly tests raw-input re-evaluation, caller status/metric/hash/fingerprint rejection, case-ID baseline binding, Pareto left/right dominance, inconclusive comparison, governance-metric exclusion, all required metrics, paragraph-binding integrity, 0/0 semantics, non-finite/fractional/bounded metrics, aggregate denominators, stable ordering, case fingerprints, report capacity 500/501, duplicate identity, hostile getters, and non-signature limitations. No tests rely on private harness helpers.

## Validation commands

```text
pnpm install --frozen-lockfile
pnpm typecheck
pnpm vitest run tests/geo-content-evaluation-harness.test.ts
pnpm vitest run tests/geo-content-quality-prompt-rag.test.ts
pnpm vitest run tests/seo-geo*.test.ts tests/geo-workbench.contract.test.ts
NODE_OPTIONS=--max-old-space-size=1536 NITRO_PRESET=node-server pnpm build
git diff --check
```

Full Vitest, migration, deploy, provider calls, and external content writes are intentionally not part of this harness task. Safety review must confirm there is no fetch/axios/network, environment access, DB/API route, provider invocation, embedding/vector DB, crawler/scraper, Date.now/Math.random/randomUUID, localeCompare, secret/token/private-key, dataset/weights/dump, or generated build artifact in the allowed implementation paths.

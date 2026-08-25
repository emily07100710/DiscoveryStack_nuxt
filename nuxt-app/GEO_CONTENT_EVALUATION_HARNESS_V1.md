# Evidence-bound GEO Content Golden Evaluation Harness V1

## Purpose and scope

This harness is a deterministic, offline regression layer for evaluating candidate Markdown generated from the same brief, normalized quality input, approved evidence, selected canonical rules, and retrieval context. It is designed to expose contract regressions and preserve evidence-bound lineage. It is not a production content-generation endpoint and does not claim that a heuristic result is factual truth or an external GEO outcome.

The implementation imports the existing quality engine only through its public barrel. It does not modify `server/geo-content-quality/**` or the existing GEO rules. It performs no provider invocation, network fetch, database access, migration, API-route work, embedding/vector retrieval, crawler/scraper operation, or external content write. All fixtures are synthetic and offline.

## Raw candidate boundary

The three public entry points—`createGeoContentEvaluationCase()`, `compareGeoContentCandidates()`, and `buildGeoContentRegressionReport()`—share one strict raw-envelope validator. A raw candidate must be a plain object with prototype `Object.prototype` or `null`, and its exact enumerable data keys must be:

| Required raw key | Meaning |
|---|---|
| `caseId` | Baseline identity, required string |
| `candidateId` | Candidate identity, required string |
| `variantLabel` | Human-readable deterministic variant identity, required string |
| `qualityInput` | Existing `ContentQualityInput` contract input |
| `providerOutput` | Raw provider output object or explicit `null` |
| `markdown` | Raw Markdown string or explicit `null` |

Validation uses `Reflect.ownKeys()` and property descriptors. Symbol keys, unknown keys, missing keys, non-enumerable fields, accessors, class instances, arrays, special prototypes, and proxies that throw from `ownKeys`, descriptor access, or field reads fail closed. Caller-supplied evaluation status, metrics, hashes, fingerprints, or quality-gate results are never accepted as raw authority.

Identity fields are NFKC-normalized and trimmed before they are retained. Empty values, C0/C1 controls, NUL, and identities exceeding 160 UTF-8 bytes after normalization are rejected without truncation. Duplicate report identity uses a canonicalized tuple object containing `caseId`, `candidateId`, and `variantLabel`; it does not concatenate values with a NUL delimiter. This prevents delimiter-collision and normalization ambiguity.

## Malformed versus missing data

Only an explicit `providerOutput: null` or `markdown: null` is treated as a structurally valid missing-data condition. Such a case is evaluated as `insufficient_data` and retains deterministic lineage where the available input permits it. An omitted required field, `undefined`, scalar, array, function, symbol, bigint, class instance, accessor-bearing object, or otherwise malformed provider/Markdown value is not “missing.” It is `blocked` with `EVALUATION_INVALID_INPUT`, optionally accompanied by the more specific unknown-field reason.

A structurally invalid raw candidate is never retained in a report case list. Its report result is `blocked`, with `caseCount: 0`, `cases: []`, and `regressionFingerprint: null`. An output-only evaluation case is also rejected as raw input and includes `EVALUATION_RAW_INPUT_REQUIRED`. In contrast, a structurally valid candidate that reaches provider validation or the quality gate and is then blocked is retained as a server-evaluated blocked case and can receive a non-null evaluation and regression fingerprint.

## Server-side canonical evaluation

After raw preflight, the evaluator normalizes the existing quality input, rebuilds retrieval from the complete approved-evidence corpus, rebuilds the prompt pack, validates the provider output, checks exact Markdown/body and provider lineage, and runs the existing structured quality gate. It derives content and lineage fields from those validated server-side values. It does not trust candidate-provided case status, metrics, hashes, or fingerprints.

Each accepted evaluation case records the suite version, status, baseline identity, content type, locale, topic, brief fingerprint, prompt-pack fingerprint, retrieval fingerprint, evidence snapshot hash, selected-rule order, candidate identity, exact Markdown, content hash, validated provider provenance, normalized quality input, validated provider output, quality-gate result, metric catalog, and reason codes.

## Metric integrity contract

Metrics are bounded deterministic coverage records rather than opaque scores. A metric is applicable only when all of the following hold: numerator and denominator are finite safe integers; numerator is non-negative; denominator is positive; and numerator does not exceed denominator. A valid metric preserves its original numerator and denominator and uses the exact ratio.

| Input condition | Output contract |
|---|---|
| Valid positive denominator and bounded numerator | `applicable: true`, original numerator/denominator, exact ratio |
| Explicit 0/0 non-applicable metric | `applicable: false`, `0/0`, `ratio: null`, includes `METRIC_NOT_APPLICABLE` |
| Non-finite, fractional, negative, unsafe, or numerator-greater-than-denominator input | `applicable: false`, `0/0`, `ratio: null`, includes `EVALUATION_NON_FINITE_METRIC` or `EVALUATION_METRIC_BOUNDS` |

Invalid metrics are never clamped into a valid or perfect result. They do not participate in Pareto comparison and do not contribute numerator or denominator to regression aggregates. Aggregate logic independently sums only metrics that pass the same strict applicability predicate. The fixed catalog includes direct-answer presence, heading hierarchy, paragraph-binding integrity, FAQ binding, selected rule coverage, citation marker coverage, selected evidence utilization, unused citations, unsupported factual claims, authority-source binding, title/H1 alignment, topic lexical relevance, content bounds, provider provenance integrity, and human-review requirement.

## Evaluation fingerprints

`evaluationCaseFingerprint()` binds the complete server-evaluated state, including the following fields in their contract-defined structure and order:

| Fingerprint field group | Bound values |
|---|---|
| Identity and state | `suiteVersion`, `status`, `caseId`, `candidateId`, `variantLabel` |
| Baseline lineage | `contentType`, `locale`, `topic`, `briefFingerprint`, `promptPackFingerprint`, `retrievalFingerprint`, `evidenceSnapshotHash`, ordered `selectedRuleIds` |
| Content and validated inputs | `exactMarkdown`, recomputed `contentHash`, normalized `qualityInput`, validated `providerOutput`, `providerProvenance` |
| Evaluation findings | `qualityGateResult`, fixed metric catalog and order, applicability, numerator, denominator, ratio, metric reason codes, case `reasonCodes` |

The function validates the evaluation-case structure and re-derives the complete metric catalog from the validated quality gate before hashing. It rejects hostile getters and proxies, inconsistent status/gate combinations, forged or incomplete metric catalogs, and an `exactMarkdown`/`contentHash` mismatch. The fingerprint is a deterministic identifier for regression comparison, not a digital signature, authenticity proof, truth certificate, ranking signal, or publication approval.

## Comparison identity and Pareto behavior

`compareGeoContentCandidates()` accepts two raw envelopes and re-evaluates both before comparison. The baseline must match exactly, including `caseId`, suite version, content type, locale, topic, all lineage fingerprints, evidence snapshot hash, and selected-rule order. The left and right candidate IDs must differ after normalization. Equal IDs remain blocked even when their variant labels differ; NFKC-equivalent IDs are also duplicates. Duplicate comparison identity returns no winner and includes `EVALUATION_DUPLICATE_COMPARISON_IDENTITY`.

Only compatible `review_ready` cases with comparable valid metrics can select a winner. Higher-is-better semantics apply to positive content metrics; unused-citation and unsupported-factual-claim findings are lower-is-better. Provider provenance and human-review governance metrics are reported but excluded from winner selection. A side wins only through Pareto dominance: it must be better in at least one comparable metric and not worse in any comparable metric. Mutual trade-offs are `inconclusive`, equality is `tie`, and a lack of comparable content metrics is `insufficient_data`. No composite truth, quality, ranking, traffic, conversion, revenue, ROI, or citation-prediction score is emitted.

## Regression report admission and capacity

`buildGeoContentRegressionReport()` performs inexpensive checks before any per-candidate evaluation: array shape, the 500-case capacity bound, raw envelope shape, normalized identities, and duplicate identity detection. More than 500 candidates, duplicate canonical identities, mixed valid and structurally invalid input, malformed raw input, and output-only cases produce a blocked empty report with a null regression fingerprint. A valid but quality-blocked case is retained with its server-evaluated case fingerprint and a non-null report fingerprint. A valid insufficient-data case is retained with deterministic `insufficient_data` status and a non-null fingerprint because its raw structure and available lineage were accepted.

Accepted cases are sorted using code-unit comparison by `caseId`, `candidateId`, and `variantLabel`; input order therefore does not change a legal report fingerprint. The report includes status counts, all metric aggregates, per-case reason codes, per-case evaluation fingerprints, limitations, and a canonical regression fingerprint. A local invocation-scoped `WeakMap` reuses normalized input, retrieval, and prompt context for repeated baseline objects, while each candidate still revalidates provider output, exact Markdown, quality gate, and candidate-specific fingerprint. There is no global cache, random eviction, current-time dependency, or nondeterministic behavior.

The exactly-500 test is an **offline/batch harness upper bound**, not a synchronous public API request budget. It retains the complete evaluation path and uses only a local 15-second timeout for that single test; the global Vitest timeout is not changed.

## Golden fixtures and test coverage

The direct harness retains all original 185 safety-intent tests. The prior clamp expectations were changed—not removed—to assert fail-closed `0/0/null` behavior for invalid metrics. The additional adversarial suite adds strict raw-envelope attacks, proxy/accessor/class cases, malformed scalar/array/function/symbol/bigint values, explicit null missing-data cases, NFKC/control/UTF-8 identity checks, delimiter-collision checks, duplicate comparison identities, invalid metric aggregation/comparability, fingerprint lineage/coherence, report admission, and quality-blocked/insufficient cases.

A separate positive `zh-hant` golden fixture uses canonical normalized input with topic and title `合成服務範圍`, primary question `什麼是合成服務範圍?`, rebuilt query fingerprint, retrieval, prompt lineage, synthetic provider output, and exact Markdown/body equality. Its body is Traditional Chinese, uses Han-bigram lexical tokens, passes topic overlap without `QUERY_FINGERPRINT_MISMATCH`, and is evaluated as `review_ready`. The existing intentional Unicode mismatch case remains in the original fixture set as a negative control; it is not used as evidence of positive Traditional Chinese support.

## Validation commands and non-goals

The required validation sequence is:

```text
pnpm install --frozen-lockfile
pnpm typecheck
pnpm vitest run tests/geo-content-evaluation-harness.test.ts
pnpm vitest run tests/geo-content-evaluation-adversarial.test.ts
pnpm vitest run tests/geo-content-quality-prompt-rag.test.ts tests/seo-geo*.test.ts tests/geo-workbench.contract.test.ts
NODE_OPTIONS=--max-old-space-size=1536 NITRO_PRESET=node-server pnpm build
git diff --check
```

Full Vitest is intentionally not run. Migration, deployment, real provider calls, network/API calls, database writes, external content writes, crawler/scraper execution, embedding/vector operations, environment/secret access, and model training are outside this harness task. The harness is not an LLM-as-judge system, not manual annotation, not publication approval, not a truth score, and not a ranking, traffic, or AI-mention prediction system. A passing deterministic case means only that the tested local contracts and evidence bindings passed at evaluation time; mandatory human review remains required.

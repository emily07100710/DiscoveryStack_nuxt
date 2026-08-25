# Evidence-bound GEO Content Golden Evaluation Harness V1

## Purpose and boundary

This harness is a deterministic, offline evaluation layer for comparing candidate Markdown generated from the same brief, approved evidence, selected canonical GEO rules, and retrieval context. It is a regression harness, not a model trainer, truth score, ranking predictor, citation-improvement predictor, or automatic publication approval.

The harness imports only the public barrel of `server/geo-content-quality`. It does not copy the quality rules, modify the existing contract, invoke a provider, access a database, call a route, use an embedding or vector store, read network content, or write to a customer-facing system.

## Canonical evaluation case

`createGeoContentEvaluationCase()` and `evaluateGeoContentCandidate()` accept an exact candidate envelope containing `caseId`, `candidateId`, `variantLabel`, `qualityInput`, `providerOutput`, and `markdown`. Unknown candidate keys, malformed values, null/array envelopes, and unsafe getters fail closed.

The server normalizes the existing `ContentQualityInput`, rebuilds retrieval from the complete `approvedEvidenceChunks` corpus, rebuilds the prompt pack, and runs the existing structured quality gate. It then derives `briefFingerprint`, `promptPackFingerprint`, `retrievalFingerprint`, `contentHash`, provider provenance, and every metric from those trusted server values. Caller-provided score, metric, hash, or fingerprint fields are never trusted as authoritative inputs.

Each case records the suite version, case identity, content type, locale, topic, all baseline fingerprints, evidence snapshot hash, canonical selected rule order, exact Markdown string, exact content hash, provider/model provenance, structured quality-gate result, metric records, and reason codes.

## Metrics contract

Every metric is an explainable deterministic heuristic record:

| Field | Contract |
|---|---|
| `applicable` | Whether the metric has a positive denominator in this case or aggregate |
| `numerator` | Bounded count of satisfied or found items |
| `denominator` | Explicit non-negative count used for the metric |
| `ratio` | `numerator / denominator`, or `null` for 0/0/non-applicable |
| `reasonCodes` | Contract or metric findings; never a hidden score |
| `evidenceLocator` | Stable pointers to Markdown, provider output, quality gate, or input fields |

The catalog includes direct-answer presence, heading hierarchy, paragraph bounds, FAQ binding, selected AutoGEO rule coverage, citation marker coverage, selected evidence utilization, unused citation count, unsupported factual claim findings, authority-source binding, title/H1 alignment, topic lexical relevance, content bounds, provider provenance integrity, and human-review requirement.

For a non-FAQ case, the FAQ metric is explicitly 0/0 with `ratio: null`. Empty aggregate input likewise returns all metric ratios as `null`; the harness never displays 100% for 0/0. The harness intentionally does not create a single opaque GEO, truth, ranking, traffic, conversion, revenue, ROI, or citation-improvement score.

## Status contract

Only three evaluation statuses are emitted: `review_ready`, `blocked`, and `insufficient_data`. `review_ready` means that the deterministic contract evaluation is available for human review; it does not mean approved, publishable, published, delivered, ranking improvement, or LLM citation improvement. A blocked or insufficient-data case cannot become a comparison winner.

## Candidate comparison

`compareGeoContentCandidates()` first verifies that both inputs are server-shaped evaluation cases and that the complete baseline is identical: suite version, content type, locale, topic, brief fingerprint, prompt-pack fingerprint, retrieval fingerprint, evidence snapshot hash, and selected rule ID order. Any mismatch returns `blocked` with no winner.

Only compatible `review_ready` cases are compared. Metrics use a fixed catalog order and stable arithmetic. Higher coverage is preferred for positive coverage metrics; lower ratios are preferred for unused citations and unsupported factual findings. Equal metrics return a tie. The comparison returns metric-level decisions and limitations, never an opaque composite score.

## Regression report

`buildGeoContentRegressionReport()` sorts cases by deterministic code-unit order of case ID, candidate ID, and variant label. It produces case counts, status counts, all metric aggregates with their denominators and nullable ratios, case-level reason codes, limitations, and a regression fingerprint derived from canonicalized case outcomes and aggregates. Input order does not affect the report fingerprint.

The report supports regression review across prompt-pack versions, retrieval fingerprints, provider/model provenance, rule order, Unicode/CJK cases, citation and FAQ integrity, stale evidence, malformed input, and equivalent candidate variants. It is not a truth score and cannot approve publication.

## Golden fixtures and validation

The fixture module uses only synthetic metadata and synthetic Markdown while reusing the existing quality fixture factory and public quality barrel. The direct suite covers high-quality, missing direct-answer, heading, citation, unselected evidence, unsupported claim, stale snapshot, wrong rule, FAQ, Unicode/CJK, prompt regression, retrieval regression, provider provenance, malformed/null/array/proxy/getter, 0/0 metrics, stable ordering, and incompatible comparison cases.

The target validation commands are:

```text
pnpm install --frozen-lockfile
pnpm typecheck
pnpm vitest run tests/geo-content-evaluation-harness.test.ts
pnpm vitest run tests/geo-content-quality-prompt-rag.test.ts
pnpm vitest run tests/seo-geo*.test.ts tests/geo-workbench.contract.test.ts
NODE_OPTIONS=--max-old-space-size=1536 NITRO_PRESET=node-server pnpm build
```

Full Vitest, migration, deploy, provider calls, and external content writes are intentionally not part of this harness task. Safety review must confirm there is no fetch/axios/network, environment access, DB/API route, provider invocation, embedding/vector DB, crawler/scraper, Date.now/Math.random/randomUUID, localeCompare, secret/token/private-key, dataset/weights/dump, or generated build artifact in the allowed implementation paths.

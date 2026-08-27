# DiscoveryStack GEO Outcome Model Foundation V1

## 1. Purpose and scope

This foundation learns from **verified, lineage-preserving observations** which candidate pages are more likely to be retrieved, cited, mentioned, or recommended under a specific query, candidate page, engine, model/interface, locale, run, and timestamp. It intentionally preserves the outcome funnel instead of collapsing the funnel into a fictional GEO score:

1. eligibility / indexability;
2. observable candidate;
3. retrieval;
4. citation selection;
5. citation absorption / answer influence;
6. brand mention;
7. recommendation.

This is an owner-only, offline-capable foundation. The V1 baseline is deterministic TypeScript and does not call a provider, crawl a site, use Colab, use Qwen fine-tuning, or upload a model.

> **Implementation interpretation recorded for review:** the requested product is a governed outcome-data and citation-selection foundation, not another article-writing model. Structural training data may support an auxiliary readiness model, but only query/candidate/engine/time/evidence lineage may support the citation-selection ranker.

## 2. What the models learn—and do not learn

`structural_readiness_auxiliary_v1` may learn a bounded baseline from existing, manually approved structural examples. Its heuristic labels describe structural readiness only; they are not observed AI citation outcomes and must never be reported as citation probability.

`citation_selection_ranker_v1` is the long-term GEO moat. It accepts only verified observations with query, candidate set, engine/model/interface, locale, time, observability, retrieval, and citation lineage. When evidence is absent, the system returns `insufficient_data` or `gate_blocked`. An arbitrary uncited page is not a negative example.

This is not Qwen fine-tuning. Content generation remains replaceable provider capability. The foundation instead protects the proprietary data contract, hard-negative policy, leakage-safe dataset lineage, deterministic baseline, and owner review ledger.

## 3. Observation contract

Every observation stores a schema version, owner scope, de-identified website/query/page identities, canonical/content/evidence hashes, optional publication receipt fingerprint, engine/model/interface, locale/region, run identity and timestamps, observable/retrieval/citation/mention/recommendation statuses, label basis, verification status, evidence locator hashes, AutoGEO rule hashes, server-derived content features, and an observation fingerprint.

Raw email, telephone, name, cookies, sessions, credentials, OAuth tokens, raw provider responses, private backend content, unauthorized full text, and non-deidentified user input are rejected at the boundary and are not part of artifacts. Unknown fields are rejected. Hashes must be valid SHA-256 values. Timestamps are normalized to canonical ISO UTC and reversed windows fail closed. Evidence verification, consent approval, and PII review are independent durable governance facts. Evidence locators must resolve server-side to the same owner, purpose, artifact hash, and evidence snapshot; revocation is terminal for that observation version.

Allowed label bases are:

| Label basis | Permitted use |
| --- | --- |
| `manual_verified_primary` | Primary citation truth when consumer-surface evidence is verified. |
| `consumer_surface_observed` | Primary citation truth when consumer-surface evidence is verified. |
| `provider_api_secondary_only` | Secondary observation only; never primary citation truth. |
| `search_console_aggregate_only` | Aggregate feature only; never AI citation label. |
| `first_party_analytics_aggregate_only` | Aggregate feature only; never AI citation label. |
| `heuristic_auxiliary_only` | Structural auxiliary only; never citation ground truth. |

## 4. Hard-negative policy

A citation-selection negative is accepted only when all conditions hold: it belongs to the same query observation run as a positive; the engine, model/interface, locale, and observation window match; it was observable and retrieved in the candidate set; it was not cited; its evidence is complete; its label is verified and neither stale nor ambiguous; and it was not excluded by robots, indexing, network, provider, or permission failure.

The implementation rejects arbitrary uncited pages, pages with no candidate-set proof, provider failures, inaccessible pages, robots-blocked pages, different queries, different engines/models, stale candidates, missing evidence, ambiguous labels, and duplicate candidate identity. The policy is implemented as a direct public function and exercised by adversarial tests.

## 5. Feature catalog

The versioned catalog is `geo-outcome-feature-catalog-v1`. It contains deterministic, bounded, non-sensitive features: content type and locale; page age and length buckets; heading hierarchy; direct-answer, FAQ, structured-data, canonical, and indexability flags; citation marker and authority-source counts; evidence utilization and entity coverage ratios; selected/applied AutoGEO rule counts; internal-link depth and freshness buckets; query/page lexical overlap; topic-cluster equality; verified publication age; prior observation count; and engine/interface one-hot features.

Features are server-derived, canonicalized, versioned, nullable with explicit missing state, and limited to a bounded feature count. Caller-provided scores are ignored. Raw domain strings, raw query text, raw article bodies, customer identity, credentials, secrets, and unversioned arbitrary fields are not features.

## 6. Dataset manifests and leakage-safe splits

Every immutable manifest records schema/task/feature/label/policy versions, source observation fingerprints, basis/engine/locale counts, website and query-group counts, positive and hard-negative counts, observation span, train/validation/test/site/query/temporal fingerprints, manifest fingerprint, limitations, readiness, and lifecycle status.

The split policy is `site-query-connected-component-temporal-v3`. It builds transitive connected components through website identity, canonical normalized-query identity, run identity, and query-group identity. A website, normalized query, run, query group, or any component connecting them cannot cross train, validation, test, site holdout, query holdout, or temporal holdout. A final continuous temporal segment is held out using canonical timestamps. Components crossing the temporal boundary remain whole in temporal holdout. If non-empty and trustworthy splits cannot be formed, the manifest is `gate_blocked` rather than evaluated as if the holdout were valid.

The V1 governance thresholds are policy thresholds, not universal scientific laws.

| Gate | Minimum requirements |
| --- | --- |
| Development | 200 candidates; 30 query groups; 5 websites; 2 engine/interfaces; 20 positives; 40 verified hard negatives; 14 days; non-empty train/validation/test. |
| Shadow/promotion | 1,000 candidates; 100 query groups; 20 websites; 3 engine/interfaces; 100 positives; 200 verified hard negatives; 60 days; temporal holdout; manual or consumer evidence; not provider-only. |

## 7. Deterministic V1 trainer

The repository-local trainer supports `regularized_logistic_baseline_v1` for interpretable binary classification and `pairwise_logistic_ranker_v1` for within-query candidate ranking. Both use fixed ordering, zero initialization, fixed learning-rate configuration, bounded epochs/features/rows, L2 regularization, no `Math.random()`, no network, no provider, no GPU, and fail-closed handling for malformed numeric values, NaN/Infinity, empty classes, duplicate examples, and inconsistent feature contracts.

The model artifact records artifact schema, task/model versions, feature and label contracts, dataset and split fingerprints, coefficients/intercept, normalization statistics, training configuration, row count, metrics, limitations, immutable artifact fingerprint/hash, owner scope, lifecycle status, and revocation state. `trainedAt`, database IDs, and execution timestamps are excluded from deterministic fingerprints. Browser responses expose summaries and hashes, not full coefficients.

## 8. Metrics

Binary metrics are kept separate from ranking metrics and are calculated for validation, test, site holdout, query holdout, and temporal holdout. They include positive/negative counts, ROC-AUC, PR-AUC, log loss, Brier score, expected calibration error, precision, recall, F1, confusion matrix, and numerator/denominator metadata. Undefined 0/0 cases are `null`, and insufficient data is explicitly marked `insufficient_data`.

Ranking metrics include query-group count, MRR, NDCG@5, NDCG@10, Precision@1, Precision@3, and Recall@5, with separate numerator/denominator information. Structural auxiliary evaluation uses `structural_auxiliary` scope and is never mixed with citation-selection claims.

## 9. Registry and owner governance

Model lifecycle states are development, evaluation failed, ready for owner review, approved for shadow, shadow failed, revoked, and archived. V1 has no `production_active` state and cannot auto-promote. Dataset creation does not auto-approve. Owner review is explicit and can advance a valid artifact only to `approved_for_shadow`.

The promotion gate checks dataset approval, artifact hash, feature/label contract versions, complete test/holdout metrics, leakage, PII, revoked consent, rollback artifact, explicit owner review, and target policy. Production promotion is blocked by design. Every decision is append-only and records decision ID, owner/reviewer scope, artifact/dataset hashes, status transition, reason, and timestamp. Revoked models are terminal and cannot automatically recover.

## 10. Existing data inventory

The implementation provides adapters for the existing Outcome Learning, Measurement Collection, LLM Visibility, Content Operations publication identity, AutoGEO rule lineage, approved public-intelligence manifests, and structural training example contracts. These adapters accept public normalized contracts only; they do not duplicate existing core rules, crawl sites, proxy browsers, call providers, or download datasets.

The repository contains a `COLAB_TRAINING_RESULT_101.md` development proof-of-concept record that reports 101 approved-manifest rows, split 74/14/13, and manifest/dataset/checkpoint SHA-256 metadata. The underlying JSONL, checkpoint, and raw labels are explicitly not in the repository, and the record does not expose a verifiable label-basis, consent ledger, PII audit, or this V1 feature contract. It is therefore **documentation-only inventory**, not an imported dataset and not citation outcome data. A 250-row external dataset cannot be verified from the authoritative repository/DB. The owner workbench displays `unverified_external_dataset` with a null external count and zero imported structural examples. No reported number, filename, or user statement is converted into a dataset. Any structural examples that are later proven approved, consent-clean, and PII-clean may feed the auxiliary task only.

## 11. Owner-only API and workbench

The following owner-only routes are implemented: workspace GET; manual observation POST; dataset build and review; training-run create, execute, and GET; model review, revoke, and experimental prediction. Each route uses the existing owner session authority, derives owner scope on the server, sets private no-store/noindex headers, bounds requests, rejects unknown fields, supports mutation idempotency and collision detection, and does not expose credentials or full weights.

The owner workbench at `/audit-lab/geo-outcome-model` shows asset counts, the external inventory result, development/shadow readiness gaps, manifests and split counts, training runs, registry states, append-only decisions, and explicit experimental-prediction limitations. It includes loading, unauthorized, error, empty, gate-blocked, insufficient-data, and success states. It never displays claims about citation uplift, rank uplift, traffic, conversion, ROI, or production readiness. Production construction requires the durable Drizzle repository and fails closed when the database runtime is unavailable; the mutable memory adapter exists only under test support.

## 12. Completed and NOT RUN

Completed offline capabilities include the observation contract, normalization, sensitive-field rejection, independent evidence/consent/PII governance, hard-negative policy, feature catalog, immutable manifest construction, connected-component and temporal split policy, deterministic logistic/ranking baselines, metrics, artifacts, release gates, owner repository/service/API contracts, atomic idempotent mutations, leased training-run compare-and-swap, durable Drizzle schema/migration generation, a strict injectable Drizzle boundary harness, owner workbench, adapters, and synthetic acceptance coverage.

The synthetic application scenario uses only synthetic observations and no external provider. It demonstrates verified observations → dataset build → owner dataset review → deterministic training → evaluation → artifact → rollback lineage → owner shadow approval → experimental prediction → append-only ledger.

The following remain `NOT RUN` or intentionally blocked because the requested safety policy forbids them or because credentials/data are unavailable: production migration application; runtime validation against a real disposable MySQL database (the repository contract is instead exercised through the strict transactional Drizzle harness); real provider calls; real website crawling; browser proxying; Colab; Qwen/OpenAI/Gemini/Claude calls; external dataset downloads; Hugging Face/model repository uploads; production model promotion; customer-site writes; DNS/payment operations; and claims of real-world citation probability or business uplift.

## 13. Future upgrades

After sufficient governed outcome data accumulates, the next steps may include learning-to-rank objectives with richer pair/listwise sampling, multitask outcome heads for retrieval/citation/mention/recommendation, and a text encoder or representation model. Each upgrade still requires versioned features, consent/PII gates, lineage, leakage-safe evaluation, temporal holdout, rollback, and explicit owner review. None of these upgrades are enabled by V1.

## References

[1]: https://github.com/emily07100710/DiscoveryStack_nuxt "Authoritative DiscoveryStack repository"

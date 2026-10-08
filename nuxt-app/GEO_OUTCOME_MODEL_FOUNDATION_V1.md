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

Raw email, telephone, name, cookies, sessions, credentials, OAuth tokens, raw provider responses, private backend content, unauthorized full text, and non-deidentified user input are rejected at the boundary and are not part of artifacts. Unknown fields are rejected. Hashes must be valid SHA-256 values. Timestamps are normalized to canonical ISO UTC and reversed windows fail closed. Evidence verification, consent approval, and PII review are independent durable governance facts. Primary evidence binding accepts only a source record ID, then resolves owner/project/query/run identity, `manual_verified`, `verifiedByOwner`, response hash, observed time, and canonical locator fingerprint from the authoritative LLM Visibility tables. Provider observations and caller-supplied authority facts cannot be promoted. Revocation is terminal for that observation version.

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

The pure builder uses a deterministic placeholder creation time outside the manifest fingerprint. Durable persistence records server time instead, and the build service returns the committed manifest. Rebuilding the same immutable manifest preserves its original durable creation time and current lifecycle state.

The split policy is `site-query-connected-component-temporal-v3`. It builds transitive connected components through website identity, canonical normalized-query identity, run identity, and query-group identity. A website, normalized query, run, query group, or any component connecting them cannot cross train, validation, test, site holdout, query holdout, or temporal holdout. A final continuous temporal segment is held out using canonical timestamps. Components crossing the temporal boundary remain whole in temporal holdout. If non-empty and trustworthy splits cannot be formed, the manifest is `gate_blocked` rather than evaluated as if the holdout were valid.

The V1 governance thresholds are policy thresholds, not universal scientific laws.

| Gate | Minimum requirements |
| --- | --- |
| Development | 200 candidates; 30 query groups; 5 websites; 2 engine/interfaces; 20 positives; 40 verified hard negatives; 14 days; non-empty train/validation/test. |
| Shadow/promotion | 1,000 candidates; 100 query groups; 20 websites; 3 engine/interfaces; 100 positives; 200 verified hard negatives; 60 days; temporal holdout; manual or consumer evidence; not provider-only. |

## 7. Deterministic V1 trainer

The repository-local trainer supports `regularized_logistic_baseline_v1` for interpretable binary classification and `pairwise_logistic_ranker_v1` for within-query candidate ranking. Both use fixed ordering, zero initialization, fixed learning-rate configuration, bounded epochs/features/rows, L2 regularization, no `Math.random()`, no network, no provider, no GPU, and fail-closed handling for malformed numeric values, NaN/Infinity, empty classes, duplicate examples, and inconsistent feature contracts.

The model artifact records artifact schema, task/model versions, feature and label contracts, dataset and split fingerprints, coefficients/intercept, normalization statistics, training configuration, row count, metrics, limitations, immutable artifact fingerprint/hash, owner scope, lifecycle status, and revocation state. `trainedAt`, database IDs, and execution timestamps are excluded from deterministic fingerprints. Browser responses expose summaries and hashes, not full coefficients.

New durable artifacts use `geo-outcome-artifact-training-configuration-v3`. The finite intercept is stored as canonical numeric text, and configuration, coefficients, normalization statistics, evaluation metrics, observation feature vectors, and dataset-member feature vectors use a versioned `geo-outcome-exact-json-v1` envelope containing canonical JSON text. This preserves the original JavaScript numeric values inside existing JSON columns; actual MySQL acceptance exposed last-digit changes when mathematical values were stored directly as native JSON numbers. The existing `DECIMAL(24,12)` intercept remains an explicitly rounded mirror, not the authoritative value for model math or checksums.

Reads validate envelope keys and versions, the bounded canonical text, numeric domains, and the decimal mirror before recomputing the original immutable fingerprints and artifact hashes. Valid v2 and raw legacy artifacts remain readable only when their original hashes reproduce. Unknown versions, damaged payloads, altered mirrors, and corrupt hashes fail closed. No numerical tolerance is added to hash checks, and no historical rows or database columns are rewritten. The save/read behavior is covered by both focused mapping tests and a real disposable MySQL database, not by a production model write.

## 8. Metrics

Binary metrics are kept separate from ranking metrics and are calculated for validation, test, site holdout, query holdout, and temporal holdout. They include positive/negative counts, ROC-AUC, PR-AUC, log loss, Brier score, expected calibration error, precision, recall, F1, confusion matrix, and numerator/denominator metadata. Undefined 0/0 cases are `null`, and insufficient data is explicitly marked `insufficient_data`.

Ranking metrics include query-group count, MRR, NDCG@5, NDCG@10, Precision@1, Precision@3, and Recall@5, with separate numerator/denominator information. Structural auxiliary evaluation uses `structural_auxiliary` scope and is never mixed with citation-selection claims.

Durable reads validate each evaluation split, class/group counts, confusion-matrix totals, metric domains, and numerator/denominator shape. A completed training run must also match its owner-scoped immutable artifact's hash, dataset fingerprint, model family, configuration, exact metrics, and reserved rollback lineage. A metrics object with the expected top-level keys alone is not sufficient authority.

## 9. Registry and owner governance

Model lifecycle states are development, evaluation failed, ready for owner review, approved for shadow, shadow failed, revoked, and archived. V1 has no `production_active` state and cannot auto-promote. Dataset creation does not auto-approve. Owner review is explicit and can advance a valid artifact only to `approved_for_shadow`.

The promotion gate checks durable dataset approval lineage, artifact hash, feature/label contract versions, complete test/holdout metrics, leakage, PII, revoked consent, rollback artifact, explicit owner review, and target policy. Dataset and model decisions are append-only and record business decision ID, owner/reviewer scope, business ID plus database foreign key, immutable hash, status transition, reason, and timestamp. Revoked datasets and models are terminal and cannot automatically recover.

The initial rollback artifact can be a fixed `geo-outcome-train-prior-v1` for either supported model family. It uses only the approved manifest's train partition to compute a smoothed prevalence prior, zero coefficients, train-only normalization, and independent holdout metrics. Creation and explicit owner model review are separate; the exact deterministic prior payload is the only bootstrap exception to requiring its own rollback artifact. Dataset, governance, split and full shadow data thresholds are unchanged. Its summary is `role: fallback`, `fallbackOnly: true`, `productionActivation: false`; it cannot predict, enter ordinary shadow evaluation, advise drafts or activate production.

Candidates bind a previously approved compatible fallback hash at immutable artifact creation. Every later use re-resolves that exact pointer and its bounded, acyclic fallback chain against current datasets, members, governance and durable decisions; a newer artifact does not silently replace the bound pointer. Training reservations bind the nullable fallback snapshot into their business fingerprint, so approving a first fallback permits a new run with the same ordinary configuration without rewriting an earlier artifact. Durable configuration mapping preserves legacy run fingerprints and validates versioned snapshot envelopes; fitting and persistence recheck exact members/features/splits and authority. Owner revocation remains available even after dataset authority is withdrawn. Policy-derived dataset/candidate decisions remain subject to the existing ModelOps authorization; the initial prior model review always requires the owner.

## 10. Existing data inventory

The implementation provides adapters for the existing Outcome Learning, Measurement Collection, LLM Visibility, Content Operations publication identity, AutoGEO rule lineage, approved public-intelligence manifests, and structural training example contracts. These adapters accept public normalized contracts only; they do not duplicate existing core rules, crawl sites, proxy browsers, call providers, or download datasets.

The repository contains a `COLAB_TRAINING_RESULT_101.md` development proof-of-concept record that reports 101 approved-manifest rows, split 74/14/13, and manifest/dataset/checkpoint SHA-256 metadata. The underlying JSONL, checkpoint, and raw labels are explicitly not in the repository, and the record does not expose a verifiable label-basis, consent ledger, PII audit, or this V1 feature contract. It is therefore **documentation-only inventory**, not an imported dataset and not citation outcome data. A 250-row external dataset cannot be verified from the authoritative repository/DB. The owner workbench displays `unverified_external_dataset` with a null external count and zero imported structural examples. No reported number, filename, or user statement is converted into a dataset. Any structural examples that are later proven approved, consent-clean, and PII-clean may feed the auxiliary task only.

## 11. Owner-only API and workbench

The following owner-only routes are implemented: workspace GET; pending LLM snapshot import and independent review/revoke; candidate-set review/revoke; manual outcome observation POST; dataset build and review; training-run create, execute, and GET; model review, revoke, and experimental prediction. Each route uses the existing owner session authority, derives owner scope on the server, sets private no-store/noindex headers, bounds requests, rejects unknown fields, supports mutation idempotency and collision detection, and does not expose credentials or full weights.

Primary citation labels require two append-only authorities. First, an imported manual LLM snapshot must have a current durable owner review; caller-supplied `verifiedByOwner`, mode, or status fields are rejected and legacy booleans have no authority. Second, the same source must have an approved owner-scoped candidate set. Candidate URLs pass the shared public-HTTPS/SSRF guard, and URL/page/candidate/website hashes are computed by the server. A cited label is derived only from an exact canonical URL in the source `citationUrls`; a not-cited label is derived only for an exact member of that same approved observable candidate set. Source order supplies citation position. External candidates are explicitly `manual_owner_attested_v1`; DiscoveryStack publication candidates additionally require an exact delivered execute receipt, URL, content/evidence lineage, owner scope, and time ordering. Source review revocation, candidate-set revocation, archived provenance, or receipt drift invalidates later list/build/release/training reads.

The owner workbench at `/audit-lab/geo-outcome-model` shows asset counts, the external inventory result, development/shadow readiness gaps, manifests and split counts, training runs, registry states, append-only decisions, and explicit experimental-prediction limitations. It includes loading, unauthorized, error, empty, gate-blocked, insufficient-data, and success states. It never displays claims about citation uplift, rank uplift, traffic, conversion, ROI, or production readiness. Production construction requires the durable Drizzle repository and fails closed when the database runtime is unavailable; the mutable memory adapter exists only under test support.

### Primary observation admission

The same private workbench includes an observation admission panel backed by `GET /api/geo-outcome-model/admission/workspace` and `POST /api/geo-outcome-model/admission/intake`. The GET reads an owner-scoped, repeatable-read, read-only snapshot. Source lists use 25-row keyset pages; candidate authorities and source history are bounded at 100. The panel shows source metadata, citation URLs, candidate-set decisions, current observation governance, feature origin and missing-feature counts, without returning raw prompts, responses, evidence locators, draft text or model weights.

First record and independently review a manual consumer-surface snapshot in LLM Visibility. A reviewed source can register its first candidate set without an existing set. Candidate review requires an explicit owner attestation that the listed pages were actually observable and retrieved in that same run, a content hash and a reason; a citation list alone does not prove that arbitrary uncited pages were retrieved. DiscoveryStack candidates additionally bind their delivered publication receipt. Only an active, matching candidate authority permits intake.

Intake accepts exactly `sourceRecordId`, `candidateUrl` and `idempotencyKey`. The server resolves the query, canonical identities, exact source, time, citation position and current candidate authority. The saved observation remains `unverified`, with unknown consent and PII status. Evidence binding, consent approval, PII review and revocation continue through the existing independent observation governance API. Neither candidate review, intake, an idempotent historical receipt nor any single governance decision grants training admission or production activation.

New admissions use the versioned `geo-outcome-source-run-identity-v1` fingerprint of the authoritative source record and its original LLM run fingerprint. This prevents different queries in the same provider run from colliding on the existing owner/run/page uniqueness constraints. Legacy run identities remain verifiable only with the same exact owner, query, source locator, response, time and candidate checks. Workspace ignores observations from another source; a conflicting observation for this exact source stays ambiguous. New intake rejects an already admitted exact-source candidate rather than creating a second legacy/derived copy or rewriting history.

The browser uses a new mutation key for a confirmed new intent and retains the same key for an uncertain retry. Source changes clear attestations; selection generations prevent delayed A to B to A responses from restoring old authority. Server-side durable claims reject key collisions and incomplete replays. Source and candidate changes are rechecked by the existing dataset and training gates, rather than treated as permanently authorized by the admission response.

After a browser refresh, an owner can enter an already approved uncited candidate URL and compare its canonical identity using Web Crypto against the selected source's current authority hashes. Only an active set and an unadmitted exact candidate enable intake; an unknown URL cannot create authority through this form. URL and comparison state stay in memory, are cleared on source changes and are never reconstructed from hashes or stored in browser persistence. The server still rechecks every authority before admission.

Structural features are projected only from a server-readable, hash-exact published draft with matching owner, client, entry, job, content, evidence, canonical URL, delivered execute receipt and publication time. The draft must pass its safety status and the PII scanner. This limited projection supplies content type, length bucket, Markdown heading structure and citation-marker count; unmeasured fields remain unknown. External pages and unavailable historical draft versions retain `unknown_external`, not invented content features. GET reports `exact_publication_draft` only when a fresh projection reproduces the stored feature fingerprint. A storage failure is not a missing-feature result.

GEO mutations require an exact same-origin request and reject cross-site fetch metadata. The shared GEO reader preserves its existing 256,000-byte default, bounds actual bytes including chunked or cached bodies, and this new intake tightens the limit to 64 KiB. Unknown fields, client authority flags, non-public or non-HTTPS candidates and unsafe replay payloads are rejected. These local additions require no new table or migration; deployment and authenticated production acceptance remain separate from code and synthetic tests.

## 12. Completed and NOT RUN

Completed offline capabilities include the observation contract, normalization, sensitive-field rejection, durable manual-snapshot review, candidate-specific authoritative LLM Visibility evidence resolution, append-only candidate-set authority, independent evidence/consent/PII governance, hard-negative policy, feature catalog, immutable manifest construction, connected-component and temporal split policy, deterministic logistic/ranking baselines, metrics, artifacts, release gates, owner repository/service/API contracts, atomic idempotent mutations, stale-recoverable leased training-run compare-and-swap, durable dataset decision lineage, canonical observation-based workspace readiness, one consolidated branch migration generated from the authoritative base snapshot, a strict injectable Drizzle boundary harness, owner workbench, adapters, and synthetic acceptance coverage.

The synthetic application scenario uses only synthetic observations and no external provider. It demonstrates verified observations → dataset build → owner dataset review → deterministic training → evaluation → artifact → rollback lineage → owner shadow approval → experimental prediction → append-only ledger.

Real disposable MySQL acceptance passed all five cases on 2026-10-08 (Asia/Taipei), using the already-local MySQL 8.4.11 image, the complete 51-file migration chain, 1,157 DDL statements, and 199 application tables. The fixture grows from 200 development candidates to 1,000 synthetic candidates across 500 query groups and three engine labels. It verifies canonical source/candidate-set approvals, the insufficient-shadow-data stop, fallback review, two-connection training claims and lease recovery, completed artifact persistence, fresh-connection readback, owner-approved prediction, source/model revocation, owner isolation, transaction rollback, concurrent run creation, stale-snapshot replay, immutable evidence collision rejection, and exact numeric JSON round-trip. Failed earlier attempts remain in private local evidence. The exact owned container was removed after acceptance; there were no formal-database writes, provider calls, uploads, or new charges in this test.

The earlier production migration acceptance recorded on 2026-10-07 (46 ledger entries / 195 tables) remains historical evidence in [the launch record](docs/CONFIGURATION_READY_LAUNCH.md), not proof of a successful real-data model run. The following remain `NOT RUN` or intentionally gated for this foundation: real provider/model calls; real consented crawling and consumer-surface observation acceptance; a real-data production model run; Colab training for this V1; Qwen/OpenAI/Gemini/Claude calls; external dataset downloads; Hugging Face/model repository uploads; production model promotion; customer-site writes; DNS/payment operations; and claims of real-world citation probability or business uplift. The separate [101-row Colab proof of concept](../COLAB_TRAINING_RESULT_101.md) is not an imported citation dataset or an active V1 model.

## 13. Future upgrades

After sufficient governed outcome data accumulates, the next steps may include learning-to-rank objectives with richer pair/listwise sampling, multitask outcome heads for retrieval/citation/mention/recommendation, and a text encoder or representation model. Each upgrade still requires versioned features, consent/PII gates, lineage, leakage-safe evaluation, temporal holdout, rollback, and explicit owner review. None of these upgrades are enabled by V1.

## References

[1]: https://github.com/emily07100710/DiscoveryStack_nuxt "Authoritative DiscoveryStack repository"

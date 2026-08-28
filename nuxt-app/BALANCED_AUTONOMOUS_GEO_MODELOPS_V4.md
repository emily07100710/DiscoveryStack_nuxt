# Balanced Autonomous GEO + Policy-Driven ModelOps V4

## Runtime authority

V4 autonomous publication is private, owner/site scoped, and fail closed. The formal scheduler reads the current durable policy, Entity Strategy Profile, Query Ownership, evidence snapshot, draft, canonical quality evaluation, and canonical risk snapshot on every review/publication tick. A normal low-risk path is `materialize -> generation -> review_wait -> machine authorization -> publication -> verified receipt -> delivered`; it does not create a per-article human review. V3 and disabled/non-V4 flows retain the manual-review path.

Risk severity (`low`, `moderate`, `high`) and business/domain class are separate fields. Authorization binds both, plus sorted reason codes and finding fingerprints. A permissive business-class allowlist is not an exact severity comparison, and a stored payload whose nested risk, quality, content, evidence, owner/site/target, profile, query, or policy lineage drifts is rejected even if an outer hash is recomputed.

Quality uses the canonical GEO content-quality contracts. Direct answer, heading structure, bounded Markdown, citations/evidence, unsupported claims, entity/query binding, natural query use, stuffing, provider/draft/rule/evidence lineage, and risk are structured checks. Undefined ratios are `null`, never a fabricated zero. Hard safety, credential, PII, evidence, and risk blocks are not relaxed by balanced/aggressive/conservative mode.

Each publication target owns its machine authorization, publication budget reservation, CAS claim, attempt, and verified receipt. Successful target receipts remain append-only when another target fails; only the unresolved retryable target receives another attempt. Publication reload and validation happen before credential resolution or network execution.

Repair is bounded and durable. One worker claims the repair fingerprint, creates an optimized child without overwriting the parent, verifies exact parent/content/evidence/rule/provider/risk lineage, and queues a fresh `review_wait` run for a later tick. Substitution creates a fresh replacement entry and generation run with a non-original topic and preserved lineage. Repair, substitution, skip, and hard-block decisions never publish in that decision tick.

## ModelOps truth boundary

Policy-driven dataset approval is a governed dataset decision, not a verified business outcome. Experimental artifacts may be admitted to shadow evaluation and may create a durable advisory assignment containing cycle, artifact, dataset, split, metrics, shadow, and policy lineage. Advisory assignments always expose `productionActivation=false`; there is no `production_active` state. Degradation, policy-gate failure, or artifact revocation uses compare-and-swap rollback/revocation with durable reason and predecessor lineage.

Workbench/API projections must describe dataset decisions, experimental shadow advisories, rollbacks, and verified outcomes as different records. Predictions remain predictions until outcome evidence independently satisfies the verified-outcome contract. The private workbench is `noindex`; it must not display inferred rankings, traffic, citations, or customer results as achieved effects.

## Migration and external-write boundary

Schema changes are generator-produced DDL only and are not applied by this change. New advisory-lineage columns are additive and nullable for migration compatibility; repository reads fail closed on legacy rows missing exact lineage rather than inventing it. Tests inject Qwen, AutoGEO, and publication transports. They do not call real providers, customer sites, WordPress, generic HTTP endpoints, or production databases.

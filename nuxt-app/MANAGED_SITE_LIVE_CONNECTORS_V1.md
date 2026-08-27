# Managed Site Live Connectors V1

## Scope and authority

This private Nuxt layer extends the existing Managed Site ordering, project vault, version, provisioning, first-party publication, Content Operations, GEO, measurement, and outcome contracts. It does not change the public Astro site. It does not create a customer source-code download or a second GEO/content workflow.

The only canonical application path is:

`owner-session claimed SiteSpec preview/quote/order -> pre-purchase draft project and immutable source version -> validated ManagedSiteBlueprintV1 -> deterministic first-party Astro compiler -> verified preview build plus append-only gate receipts -> owner approval -> server-derived checkout -> signature-verified payment -> exact release payment binding -> atomic domain claim/DNS/TLS -> verified production deployment -> existing Content Operations/GEO activation`

Existing-site customers use:

`active managed project/version -> provider-verified ownership evidence -> verified live-site receipt -> existing Content Operations/GEO activation`

Browser input never establishes payment success, domain ownership, DNS/TLS readiness, deployment success, or provider verification. Those states require an exact server-verified receipt bound to owner, project/order, release, version, content hash, provider event identity, and canonical domain.

## Provider readiness

The server registry has exactly five capabilities:

- `website_generator`
- `payment`
- `domain_registration`
- `dns_tls`
- `deployment`

Each capability is `disabled`, `mock`, `configured`, `verified`, or `blocked`. `configured` means only that non-sensitive transport metadata and an opaque credential reference are present. Live mutation remains fail closed until a server verifier records an exact verification fingerprint and the runtime can resolve the credential reference.

The owner page is `/audit-lab/managed-sites`. It displays missing configuration, blocked reason, bounded attempts, retry eligibility, exact receipt identities, and the next safe action. It never returns credential values. Mock status is rejected outside the test runtime.

## Runtime configuration required from the owner

The following values must be injected into the private server runtime. Do not put their values in Git, the database, browser storage, fixtures, logs, or issue text.

| Item | Runtime contract | Current state |
| --- | --- | --- |
| Credential registry | `DISCOVERYSTACK_MANAGED_SITE_CREDENTIALS_JSON`, mapping opaque references to runtime-only values | Owner configuration required |
| Artifact vault | `DISCOVERYSTACK_MANAGED_SITE_VAULT_JSON`, non-secret S3 bucket/region/prefix metadata; AWS credentials remain runtime-owned | Owner configuration required |
| Payment webhook provider | `DISCOVERYSTACK_PAYMENT_WEBHOOK_PROVIDER_KEY` | Owner/provider selection required |
| Payment webhook credential reference | `DISCOVERYSTACK_PAYMENT_WEBHOOK_CREDENTIAL_REF` | Owner configuration required |
| Payment webhook URL | `/api/managed-sites/live-connectors/payment-webhook` on the private deployed Nuxt origin | Production URL/provider registration required |
| Bailian/Qwen generation | Provider configuration with approved Bailian endpoint, model, and opaque credential reference | Server verification required |
| Deployment transport | Provider configuration with HTTPS `endpointOrigin` and opaque credential reference | Provider transport and server verification required |
| Exact provider origins | `DISCOVERYSTACK_MANAGED_SITE_ALLOWED_PROVIDER_ORIGINS`, comma-separated HTTPS origins controlled only by the server | Owner configuration required |
| Registrar and DNS/TLS | Implement the supplied production adapter boundaries for the owner-selected providers | Provider decision and staging verification required |

The credential registry parser is bounded and fail closed. Configuration JSON cannot contain credential-value fields. Readiness projections return only booleans and missing reason codes.

## Pre-purchase conversion, blueprint generation, and vault

The only pre-purchase conversion service accepts an exact preview, quote, lead intent, and draft order already claimed by the owner session. It creates a draft project/version and durable commerce binding without creating a subscription or claiming payment.

Bailian/Qwen may return only strict `ManagedSiteBlueprintV1` JSON. It cannot return source code. The blueprint binds brand, locale, navigation, pages, sections, safe CTA targets, FAQ, selected module slots, GEO structure, evidence limitations, and provenance. A first-party deterministic compiler produces allowlisted Astro files for `one_page`, `brand_blog`, and `simple_commerce`. Shopify, LINE, Booking, payment, and assistant placements remain inert safe slots with no secret, script, or external form submission.

Provider output admission enforces:

- exact blueprint and compiled-artifact schemas and request fingerprint;
- provider/model/request provenance;
- fixed path and media-type allowlists;
- Unicode canonicalization and case-collision rejection;
- maximum file count, per-file bytes, and total bytes;
- no binary, symlink, path traversal, dynamic route, server/API/plugin/script path, dependency manifest, secret-like material, active script, unsafe form, or prompt-injection text;
- exact per-file SHA-256, deterministic manifest hash, and aggregate content hash.

An admitted candidate is immutable and stored as one server-side encrypted-at-rest bundle through the S3 vault boundary. The database stores only its opaque `vault:` reference, hashes, provenance, and non-authoritative summary. Artifact, deterministic compiler, preview build, static active-content, GEO/content structure, and human review decisions are separate append-only, content-hash-bound gate receipts. A preview provider receipt is not a quality/security gate. A candidate never deploys directly.

## Payment lifecycle

Checkout sessions require an owner-approved release with its durable preview/quote/draft-order binding. Amount, currency, plan, cadence, domain option, tax status, and line items are loaded from the canonical server quote and re-summed before the adapter runs.

The webhook route reads raw bytes and verifies the signature before obtaining or querying a repository. It then validates owner-claimed order/quote lineage. Success, failure, cancellation, full refund, duplicate, payload collision, and out-of-order events are recorded as reduced append-only receipts. Raw bodies and signatures are never retained. Only an exact verified success enters conversion/provisioning. V1 models a full refund; partial-refund commercial policy remains owner/provider-specific.

## Domain, DNS, and TLS

Domain input uses IDNA canonicalization and the public suffix list. The guard rejects URL credentials, schemes, paths, ports, wildcards, IPs, localhost/special-use names, public suffixes, malformed labels, and mixed Latin/Greek/Cyrillic homograph labels.

A purchase intent requires all of:

1. server-verified unexpired quote snapshot;
2. explicit owner confirmation fingerprint;
3. exact verified payment receipt for the same owner/project/order;
4. unused owner-scoped idempotency key;
5. an atomic globally unique canonical-domain claim for the exact release.

DNS and TLS are a separate state machine. Propagation pending and partial failure remain non-ready, carry a bounded retry time, and record a rollback intent to the last verified DNS snapshot. Only a receipt with both DNS and TLS `verified` can unlock production deployment.

## Deployment, rollback, and GEO activation

Preview and production deployment receipts must match provider, project, version, release, content hash, canonical domain, provider deployment ID, and exact response identity. Production additionally requires exact preview, owner approval, payment, domain, and DNS/TLS receipts. Caller-reported deployment state is ignored.

The production deployment boundary is truthfully named an authenticated bearer transport. It sends only immutable identity and vault references. It does not send credential values in the payload and rejects origins outside the server-only exact allowlist, redirects, timeouts, oversized responses, malformed receipts, stale timestamps, payload-hash mismatches, and response identity collisions. Deployment and rollback acquire release CAS authority before provider transport so concurrent callers cannot both mutate the same release.

Rollback requires a prior verified production release for the same owner/project/domain. The current release becomes `rolled_back` only after an exact provider rollback receipt; the target becomes `live_verified`. Exact replay returns the existing receipt.

Existing Content Operations is linked only after a verified production deployment or existing-site ownership receipt. Generation, publication review/risk gates, evidence binding, measurement cadence, and outcome learning remain the existing canonical implementations. No GEO measurement starts from a preview, intent, or unverified site.

## Migration and validation boundary

Migration `0026_reflective_killmonger.sql` creates the initial connector tables. Repair migration `0027_loose_deathstrike.sql` is DDL-only: it creates pre-purchase bindings, append-only gate results, and globally unique domain claims; adds nullable release commerce lineage; and adds the deployment/rollback pending CAS states. New tables require no backfill, and the new columns are intentionally nullable for existing-site and historical releases. The migrations must not be applied to production from this branch.

No disposable MySQL database is supplied in this worktree. Migration runtime application/rollback validation therefore remains **NOT RUN** until an isolated database is provided. `drizzle-kit generate` no-diff is the source/schema consistency gate; it is not runtime migration proof.

## Truthful limitations

- No real Qwen, payment, registrar, DNS, TLS, deployment, customer site, Shopify, LINE, Google, or publication provider is called by tests.
- No payment is charged, domain purchased, DNS changed, certificate issued, production site deployed, or customer site modified by this work.
- Provider account connectivity and production webhook delivery remain unverified until owner configuration and isolated staging validation are completed.
- Production payment is registered only as exact `internal_hmac_v1`; Stripe or another vendor is not implemented or implied. The deployment transport is authenticated bearer, not a signed request/response protocol.
- Bailian/Qwen has no approved zero-business-side-effect account verification endpoint in this implementation, so it remains `configured`, never `verified`, until an owner-approved verifier exists. Payment/domain/DNS vendor verifiers also remain unsupported rather than claiming connectivity.
- Domain purchase and DNS/TLS production adapters remain contract-only until the owner selects providers.
- Full production browser QA requires a deployed private Nuxt runtime, owner session, disposable database, and isolated provider sandboxes.

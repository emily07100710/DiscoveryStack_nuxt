# Unified Multi-channel Publication Routing Capability Engine V2

## Scope and truthfulness

V2 is a **metadata and planning engine**, not a real publication executor and not production-ready. It determines a verified route, derived executor, authority, transport, target identity, and opaque credential reference for content that has already passed the approved delivery gates. It does not publish content or claim that content exists on any website.

`validateRoutingPlan` is deterministic integrity validation. It is **not a digital signature**, does not authenticate the caller, and cannot prove that the caller possesses publication authority. A `DeliveryReceipt` is only a validated metadata record; it does not prove that website content exists unless a separate real executor/runtime performs and verifies the external write.

The implementation makes no WordPress write, GitHub Contents write, generic HTTP write, GEOFlow Agent call, first-party write, provider call, database mutation, API route call, customer-site write, or other external write. It contains no network implementation, credentials, tokens, private keys, `.env` access, or resolved secret material.

## Fixed capability matrix

| Framework | Transport | Executor | Authority | Projection |
|---|---|---|---|---|
| `astro` | `first_party_git` | `first_party_git` | `discoverystack_first_party` | first-party |
| `astro` | `first_party_signed_api` | `first_party_signed_api` | `discoverystack_first_party` | first-party |
| `nuxt` | `first_party_git` | `first_party_git` | `discoverystack_first_party` | first-party |
| `nuxt` | `first_party_signed_api` | `first_party_signed_api` | `discoverystack_first_party` | first-party |
| `wordpress` | `wordpress_rest` | `wordpress_rest` | `geoflow_content_engine` | GEOFlow |
| `php_agent` | `geoflow_agent` | `geoflow_agent` | `geoflow_content_engine` | GEOFlow |
| `generic_http` | `generic_http` | `generic_http` | `geoflow_content_engine` | GEOFlow |
| `geoflow_local` | `geoflow_local` | `geoflow_local` | `geoflow_content_engine` | GEOFlow |
| `static_site` | `geoflow_agent` | `geoflow_agent` | `geoflow_content_engine` | GEOFlow |

Executor and authority are always derived from this fixed matrix. Caller-supplied executor or authority is rejected. Unsupported cross-products fail closed.

## Deterministic plan verifier

`validateRoutingPlan(value: unknown): RoutingPlanValidationResult` is the mandatory runtime integrity boundary before projection, receipt validation, retry validation, ledger construction, and aggregation. A valid result contains a normalized verified plan. An invalid result contains `plan: null` and stable `reasonCodes`.

The verifier enforces exact plan, metadata, and route shapes; V2 version; `planned` status; non-negative safe-integer epoch-millisecond `plannedAt`; one-to-twenty routes; bounded normalized IDs, labels, and references; lowercase SHA-256 hashes; approved draft lineage; fixed GEOFlow source SHA; matrix-derived executor and authority; re-run target guard; unique canonical targets; unique route identities; unique site/destination pairs; deterministic code-unit ordering; canonical route IDs; and a complete recomputed plan fingerprint.

The verifier is defensive against `null`, arrays, symbols, `undefined`, functions, bigint, non-finite numbers, Date, Map, Set, class instances, sparse arrays, circular values, throwing getters, and throwing Proxies. It catches malformed runtime input rather than treating TypeScript assertions as validation.

## Source and destination publication identity

Source and destination publication identity are separate fields and never overwrite each other:

| Field | Origin | Meaning |
|---|---|---|
| `sourcePublicationIdentity` | approved draft | identity of the source publication record |
| `destinationPublicationIdentity` | target | identity of the destination publication record |

Plan metadata retains the source identity. Each route, receipt, and projection retains both identities. Both identities are included in route IDs, plan fingerprints, receipt lineage, and projection validation. Same-site duplicate protection uses `(siteIdentity, destinationPublicationIdentity)`.

## Exact Markdown content boundary

Metadata strings continue to use strict bounded normalization: no control characters, no surrounding whitespace, and explicit length limits. Article content uses a dedicated `normalizeMarkdownContent` boundary instead.

The Markdown validator preserves the exact JavaScript string and exact UTF-8 bytes. It does not trim, collapse whitespace, normalize Unicode, or apply NFKC before hashing. It accepts ordinary Unicode, CJK, emoji, LF line breaks, tab characters, empty Markdown lines, leading/trailing LF, and fenced code blocks. It rejects empty content, NUL, CR, CRLF, all other C0/C1 controls, unpaired UTF-16 surrogates, and content exceeding `MAX_CONTENT_BYTES` UTF-8 bytes. `contentHash` is computed from the exact Markdown string with SHA-256. Changing one LF changes both the content hash and the plan fingerprint.

## Target and SSRF boundary

External targets require HTTPS, no credentials, no fragment, no non-443 port, no sensitive query key or value, no single-label host, no trailing-dot bypass, no Unicode/confusable hostname, and no zone identifier. Every hostname label is checked after URL/IDNA parsing, so a nested `xn--` label is rejected rather than only checking the first label. IANA special-use hosts and subdomains are blocked, including `alt`, `arpa`, `example`, `example.com`, `example.net`, `example.org`, `invalid`, `local`, `localhost`, `onion`, `test`, `home.arpa`, and `resolver.arpa`.

Private, loopback, link-local, reserved, documentation, integer/hex/octal-normalized IPv4, IPv4-mapped/compatible/translated IPv6, and the IANA special-purpose IPv4/IPv6 ranges used by this contract are blocked. IPv6 literals must be inside the currently allocated global-unicast `2000::/3` boundary and must not fall inside the blocked special-purpose ranges. The guard performs no DNS lookup and no network request. `geoflow_local` rejects caller URLs and requires an opaque `serviceReference`.

Metadata validation cannot prevent DNS rebinding. A future real executor must independently perform all of the following immediately before delivery: server-side credential resolution; owner/client/target current-state revalidation; exact credential-to-target binding; DNS resolution; DNS-rebinding protection; redirect revalidation; egress allowlisting; durable idempotency; and durable receipt/event persistence.

## Receipt validation and complete history

`validateReceipt(plan, candidate, knownReceipts)` first verifies the plan and uses the same internal history validator as `validateRetry`, `RouteEventLedger`, and `aggregateEvents`. Receipts have exact keys and status allowlist `delivered`, `blocked`, `failed`, and `retry_wait`. `planned`, `owned`, `success`, `completed`, `published`, `undefined`, `null`, and numeric statuses are invalid.

Each receipt is normalized into a new record and bound to plan fingerprint, route ID, target/site identity, source/destination publication identity, draft/review IDs, evidence/content hashes, matrix-derived executor and authority, opaque executor run ID, attempt, and timestamps. Every receipt satisfies `plannedAt <= completedAt <= occurredAt`, with `plannedAt === plan.plannedAt`.

History is canonicalized by deterministic code-unit sorting of `(routeId, attempt, receiptFingerprint)` and is independent of input order. For every route, attempts start at one and are contiguous. An exact duplicate at the same `(planFingerprint, routeId, attempt)` is a replay. A conflicting duplicate is a collision. The next attempt can follow only `failed` or `retry_wait`; `delivered` and `blocked` are terminal. The next attempt must satisfy `next.completedAt >= previous.occurredAt`, use a fresh executor run ID, preserve every lineage field, and remain within maximum attempts one through ten. Stale attempt-one previous receipts cannot fork a retry when a later valid attempt is already the latest.

A receipt does not certify external publication success. It only certifies that the receipt metadata satisfied this engine's deterministic integrity contract.

## Receipt-backed event ledger

`RouteEvent` is a discriminated union. A planned event is sequence one with null attempt, executor run ID, and receipt fingerprint. A result event is one of `delivered`, `blocked`, `failed`, or `retry_wait`; it must have a receipt.

The ledger admits only route IDs present in the verified plan. Unknown planned or result routes return `EVENT_ROUTE_UNKNOWN` and cannot create a ghost entry. A result cannot be sequence one or bypass a planned event. Each route independently starts at planned sequence one and then uses contiguous result sequences. One route's planned event never unlocks another route.

A result event is bound exactly to its normalized receipt: plan fingerprint, route ID, status/kind, attempt, executor run ID, receipt fingerprint, and `event.occurredAt === receipt.occurredAt`. Exact event plus exact receipt replays. A same-sequence different payload is `collision: true`; an exact event with a forged or conflicting receipt is rejected or collides before replay is accepted. Planned replay cannot include a receipt.

Unknown routes have explicit behavior: `eventsFor(unknownRouteId)` returns an empty list without creating state, while `aggregateRoute(unknownRouteId)` throws `EVENT_ROUTE_UNKNOWN`. `aggregate()` enumerates only verified plan routes. A multi-target plan remains partial until every route has a terminal outcome; one delivered route cannot make the whole plan delivered.

## Immutable object boundary

Before storage, the ledger creates normalized event and receipt records and passes them through deterministic canonical cloning and deep freezing. The verified plan, internal events, and internal receipts are frozen. The ledger never stores the caller's event or receipt reference.

Results returned by `append`, `eventsFor`, and `aggregate` are fresh canonical clones. Caller mutation of returned events, original planned events, original receipts, nested identities, or projection output cannot alter the stored plan, ledger history, retry eligibility, or projection result. JSON stringify/parse is not used as a clone mechanism because it has ambiguous behavior for undefined values, sparse arrays, special numeric values, and other non-JSON runtime objects.

## Projection credential reference

Both `projectFirstParty` and `projectGeoflow` preserve `credentialReference` from the verified route. Every opaque handle must use the fixed `ref-...` namespace; URL-shaped, whitespace-containing, secret-keyword and common provider-token-shaped values are rejected. This is a format boundary, not proof that a caller did not disguise arbitrary bytes behind a valid reference, so a future server adapter must resolve only server-stored references and must never accept raw request values as credential material. It is included in projection canonical identity and is required by `validateProjectionIntent(plan, value)`.

Projection validation re-verifies the complete plan, exact projection shape, route/target/site identity, source/destination publication identity, content/evidence lineage, derived framework/transport/executor/authority, target URL or local service reference, pinned GEOFlow SHA, and credential reference. Mutation of `routeId`, target URL, executor, authority, credential reference, or any extra field fails closed. `geoflow_local` retains both `serviceReference` and `credentialReference`.

A future executor must re-resolve the server-side credential only after re-validating the verified plan, route ID, credential reference, and target URL/service reference. Projection output alone never authorizes an external write.

## One-to-one aggregate receipt validation

`aggregateEvents(plan, events, receipts)` first validates every supplied receipt with the complete history validator. It then maps every result event to exactly one normalized receipt by fingerprint and passes that receipt through the ledger binding checks. Planned events cannot map to receipts. Missing receipts, unused receipts, receipts from another plan, receipts from another route, conflicting duplicates, and cross-route pairings are rejected rather than silently ignored. Exact duplicate receipts collapse deterministically as replay. Aggregation uses only events accepted by the receipt-backed ledger.

## Verification and non-execution boundary

The direct V2 suite retains the existing 387 baseline tests and adds the third-round adversarial coverage for multiline Markdown, exact bytes, unknown routes, planned-event gating, exact receipt timestamps, immutable event/receipt storage, complete retry history, credential references, projection mutation, and one-to-one aggregate receipts.

The routing implementation contains no `fetch`, `axios`, `curl`, `process.env` credential parsing, database/API route, migration, real executor, WordPress write, GitHub Contents write, customer-site write, provider call, `Date.now`, `Math.random`, `randomUUID`, or `localeCompare`. Full Vitest, migration, and deploy are intentionally not run for this task.

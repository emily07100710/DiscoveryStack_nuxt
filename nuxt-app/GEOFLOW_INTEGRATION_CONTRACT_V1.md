# DiscoveryStack ↔ GEOFlow Integration Contract V1

> **定位：pure contract only。** 本模組定義 DiscoveryStack Nuxt control plane 與未來 GEOFlow Laravel content engine 之間的 deterministic、offline、fail-closed wire contract；本輪不建立 API、database、UI、connector、provider call、HTTP transport 或部署。

## Request contract

`buildGeoFlowRequest()` 接受 `unknown`，先對固定 protocol version `discoverystack-geoflow-v1` 與完整 server-owned identity 做 strict normalization，再產生 request fingerprint。Request 綁定 owner、client、calendar entry、production plan、deliverable、brief、job、evidence snapshot、brief fingerprint、content type、language、generation mode、requested capabilities、selected canonical rules、approved authority source IDs、evidence chunks 與 caller-supplied creation timestamp。

All success values are normalized copies. Unknown keys、null、undefined、array、primitive、malformed nested objects、getter/proxy exceptions、unsafe JavaScript values and over-limit aggregates fail closed with bounded reason metadata. Failure values never include the raw input, stack trace, secret or provider error string.

| Field family | V1 rule |
| --- | --- |
| Protocol | `discoverystack-geoflow-v1` is required; unknown versions never fallback. |
| Numeric identity | Owner, client, calendar entry, plan, deliverable, brief and job IDs are positive safe integers. |
| Opaque identity | External project/task/job/article keys are bounded ASCII identifiers; they are never parsed as database IDs. |
| SHA-256 | Hash fields are exactly 64 lowercase hexadecimal characters. Uppercase values are rejected rather than silently normalized. |
| Text | Human-readable text uses NFKC, trim and whitespace normalization; title, summary, reviewed text and limitation bounds are explicit. |
| Arrays | Rules and authorities are set-like and are deduplicated/stably sorted. Evidence chunks and other order-sensitive arrays preserve order. |
| Timestamp | ISO 8601 values must include `Z` or `±HH:MM`, reject invalid calendar dates, and canonicalize to UTC ISO strings. |

## Evidence and URL policy

Every evidence chunk contains `sourceId`, `artifactId`, `chunkId`, `chunkHash`, `reviewedText` and `locator`. The source ID must be present in the request authority allowlist. Evidence locator validation is syntax/policy-only: it accepts public HTTPS URLs and rejects HTTP, `ftp`, `file`, `data`, `javascript`, URL credentials, credential-like query names, fragments, non-443 ports, localhost, single-label/local/internal/onion hosts and private, loopback, link-local, reserved or special-use IP addresses.

No DNS lookup and no network request is performed. A production egress layer remains necessary; passing this policy guard does not make a URL trusted or reachable.

## Canonical fingerprint and idempotency

`canonicalizeContractValue()` produces deterministic JSON with code-unit object-key ordering, order-preserving arrays and explicit rejection of `undefined`, non-finite numbers, functions, symbols, bigints, Date, Map, Set and circular references. It does not use `localeCompare`, ICU or the host locale. Request fingerprint covers the normalized request draft, including the protocol, all server identity, content/language/mode, requested capabilities, selected rules, authority IDs, evidence snapshot, brief fingerprint and ordered evidence chunk identities/hashes. It never includes secrets, tokens, authorization, cookies, raw provider responses, stacks or environment state.

`resolveGeoFlowIdempotency()` uses the complete `(idempotencyKey, requestFingerprint)` pair. A missing stored record is `new_request`; the same pair is `replay`; the same key with a different fingerprint is `IDEMPOTENCY_COLLISION`. A malformed stored record fails closed and is not treated as new work.

## Response, identity lineage and evidence binding

A response must echo protocol version, request ID, idempotency key, request fingerprint, owner, client and job identity. It must provide external project/task/job/article keys, canonical status, draft identity, title, summary, content hash, evidence snapshot hash, citation bindings, applied rule IDs, provider/model provenance, limitations and completion timestamp.

`validateGeoFlowResponse()` rechecks request identity, evidence snapshot hash, brief fingerprint, deterministic external article identity, content hash shape, provider provenance, citation bindings and applied rule subset. The external article key is `article-{calendarEntryId}-{deliverableId}`. Citation bindings must match an exact allowlisted `(sourceId, artifactId, chunkId, chunkHash)` tuple. Applied rule IDs must be a subset of selected rules. A `reference_fallback` provider mode must provide a non-empty fallback reason.

`verifyGeoFlowLineage()` composes request and response validation and rechecks the external article key. `verifyPublishedGeoFlowLineage()` additionally requires `status: published`. A response mismatch produces a fixed reason code and cannot be interpreted as delivered content.

## Status mapping and state machine

The published mappings are explicit:

| DiscoveryStack | GEOFlow |
| --- | --- |
| `awaiting_generation` | `running` |
| `awaiting_review` | `review_required` |
| `ready_to_publish` | `approved` |
| `publishing` | `publishing` |
| `delivered` | `published` |
| `blocked` | `blocked` |
| `failed` | `failed` |
| `retry_wait` | `retry_wait` |

`verifyStatusTransition()` rejects unknown states, terminal `delivered`/`published` rollback, `blocked → approved`, `failed → running` without `explicitRetry: true`, and any `published` transition not originating from `publishing`. The contract has no HTTP 2xx, browser flag or free-form success-message path. Published acceptance also requires the response lineage verifier to confirm matching article identity, content hash, evidence snapshot hash and request fingerprint.

## HMAC envelope planning

`planSigningEnvelope()` requires caller-injected timestamp and nonce together with a validated request, body hash, sender and receiver. It does not call `Date.now()`, generate a fixed/predictable nonce, read `process.env`, hold a browser secret, add an Authorization header or call `fetch`.

The golden canonical signing input is exactly these fields joined by `\n` in this order:

```text
protocolVersion
requestId
idempotencyKey
requestFingerprint
bodyHash
timestamp
nonce
sender
receiver
```

`verifySigningEnvelope()` validates the envelope and invokes only an injected `EnvelopeVerifier`. Tests use a synthetic verifier; real secret management and cryptographic signing remain outside this offline module.

## Reason taxonomy

The fixed V1 taxonomy includes `INVALID_PROTOCOL_VERSION`, `INVALID_INPUT`, `UNKNOWN_FIELD`, `LIMIT_EXCEEDED`, `INVALID_HASH`, `INVALID_TIMESTAMP`, `INVALID_PUBLIC_URL`, `PRIVATE_OR_SPECIAL_TARGET`, `INVALID_OPAQUE_IDENTIFIER`, `UNKNOWN_STATE`, `REQUEST_FINGERPRINT_MISMATCH`, `IDEMPOTENCY_COLLISION`, `IDENTITY_MISMATCH`, `EVIDENCE_SNAPSHOT_MISMATCH`, `BRIEF_FINGERPRINT_MISMATCH`, `CITATION_OUTSIDE_APPROVED_EVIDENCE`, `APPLIED_RULE_OUTSIDE_SELECTION`, `PROVIDER_PROVENANCE_MISSING`, `INVALID_STATUS_TRANSITION` and `UNTRUSTED_PUBLISHED_RESULT`.

## Golden fixtures and limits

Golden fixtures use synthetic IDs, lowercase hashes, public example URLs and non-secret provider labels. The public-function contract suite covers valid request/response handling, all enum variants, Unicode/NFKC, ordering and fingerprint mutation, idempotency replay/collision, malformed values, aggregate limits, URL policy, status mapping and rejection, response lineage, evidence/rule/provenance binding, signing input, injected timestamp/nonce, synthetic verifier behavior, no raw-input return and no secret metadata.

This V1 does not claim that GEOFlow is connected, that Qwen or another provider was called, that PHP/Laravel cross-runtime validation was executed, that a high-quality article was generated, that a client website was published, or that GEO/ranking/traffic/ROI improved. It is a pure contract layer for a future server-authorized adapter.

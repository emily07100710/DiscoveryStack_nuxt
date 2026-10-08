# Managed Site Email Provider Events V1

Status: **IMPLEMENTED / DATABASE_APPLIED / DEPLOYED / PROVIDER_GATED**. As of 2026-10-08, migrations 0048–0050 and the corresponding application release are verified in [the current release record](docs/CONFIGURATION_READY_LAUNCH.md#2026-10-08-release-and-activation-checklist). Resend sending and callbacks remain unconfigured and unverified; flags were not changed. Earlier local acceptance remains historical evidence, not provider acceptance.

## Scope and evidence boundary

Extend the private platform transactional outbox with verified Resend lifecycle observations: sent, delivered, delivery delayed, bounced, complained, failed and suppressed. This is not marketing analytics, inbox hosting, customer SQLite storage, payment, website publication or learning data. Open/click/recipient content is not collected. Events never send/retry a message, alter an outbox lease, accept a business token, reconcile a business receipt or activate a provider.

The outbox remains the authority for synchronous provider acceptance. `email.delivered` means the provider reports delivery to the receiving mail server, not confirmed placement in a person's inbox or confirmed reading. `inboxDeliveryVerified` remains false. The owner page distinguishes synchronous acceptance, provider-reported server delivery and adverse events. Observation and refresh remain read-only; a separately gated owner investigation action is defined in `MANAGED_SITE_EMAIL_REVIEW_V1.md` and never grants sending or delivery authority.

## Verification and bounded input

One catch-all API file handles only POST `/api/managed-sites/email-outbox/resend-webhook`. This server-to-server route requires an independently configured webhook signing secret, not an owner cookie or caller-provided owner. It grants no public-browser CORS. The independent `NUXT_MANAGED_SITE_EMAIL_EVENTS_ENABLED` switch defaults false. Disabled/missing/invalid configuration resolves no database, reads no body and triggers no transport. Configured sending is not implied by enabling observation.

Use untouched raw bytes, never parsed JSON reserialization, for Svix HMAC-SHA256 verification of `svix-id.svix-timestamp.body`. Reject noncanonical signature/key encodings, oversized/malformed headers and timestamps outside 300 seconds in either direction. Compare signatures in constant time; accept any valid v1 member of a bounded signature list, allowing rotation signatures. Decode UTF-8 fatally only after signature verification. The raw body is limited to 64 KiB by actual streaming bytes, including chunked and cached adapter bodies; parsed-object-only caches are refused because their original signed bytes are unavailable. The existing bounded raw-body work must retain its JSON caller behavior.

Project only event type, normalized UUID provider email ID, strict UTC event timestamp, a hash of the Svix message ID, keyed private payload fingerprint and server-derived configuration/verification fingerprints. Do not retain raw body, address, sender, subject, reply-to, bounce text, token, link, header, signature or credential. Unsupported authenticated event types are acknowledged and ignored before storage. Invalid signatures/schema fail before storage. Storage errors return generic retryable 503, never false successful persistence or raw exceptions.

## Durable events, replay and receipt binding

Add `managedSiteEmailProviderEvents`, a small append-only reduced-metadata ledger, with a unique hash of the Svix message ID. Identical authenticated redelivery is replay, not a new event; a same-ID different payload is a collision. Unique SQL insertion and readback decide concurrency, not process memory. Signing-secret rotation can verify a fresh signature without altering the original immutable event. The private payload hash is keyed with the separately configured outbox encryption secret; key drift fails closed rather than weakening identity.

Store authenticated supported events even when a corresponding synchronous outbox receipt has not yet committed. This handles callback-before-acceptance races without inventing an accepted outbox or dropping evidence. Unrelated signed events remain unassigned reduced metadata: no client/owner is adopted from their JSON. Owner projection joins only exact provider receipt UUID plus the original server-owned provider-configuration fingerprint and durable acceptedAt. If the same receipt/configuration ambiguously matches multiple accepted outbox rows, do not attribute it. Pre-purchase null-owner rows remain excluded. A caller-supplied owner/project/message ID never affects routing or projection.

Keep the sender/API/allowlist/private-origin/timeout/encryption/pepper configuration stable through the observation window. A sender configuration change intentionally leaves older receipts unassigned rather than guessing their authority; signing-secret rotation alone does not change the sending-configuration fingerprint. The event ledger is reduced operational metadata, not a promise of indefinite archival or consented ML data. Observation enablement and production retention/operations policy require a separate owner rollout review.

Migration 0048 added the receipt/configuration lookup index and reduced provider-event ledger without changing existing outbox values, columns, purpose enums, leases, resend keys or status transitions. It was applied as part of the 2026-10-08 release; the current schema and Live application status are recorded in the release record above. Any later schema change requires its own review and authorization.

## Order-independent owner projection

At most 50 authenticated owner outbox rows are projected. Aggregate reduced events in SQL, not an unbounded event-body load. Keep observed-delivery time and adverse evidence independently. A late sent/delayed event cannot erase delivered evidence; delivered cannot clear complaint/bounce/failure/suppression. Conservative display priority is complained, bounced, suppressed, failed, delivered_to_server, delivery_delayed, sent, unknown. Evidence is provider-reported observational state, never a verified-person-inbox claim.

Owner inspection remains GET-only and read-only. When observation is disabled/unconfigured, it does not query the new event table, preserving a safe default for deployment/schema ordering. Existing GET auth/no-store/noindex and explicit reduced projection remain. When enabled, a storage error does not fabricate empty or successful provider evidence. Do not expose provider receipt ID, Svix ID, private fingerprints, configuration values or raw event data.

`manual_required` is still a safe stop, not permission to resend. This extension must not reopen an expired/uncertain delivery, generate a fresh provider key or pretend manual recovery is completed. The separate immutable, explicitly authorized owner investigation workflow in `MANAGED_SITE_EMAIL_REVIEW_V1.md` can record a no-resend closure without modifying these provider observations or the original queue state.

## Required verification

- Raw-byte known HMAC vector; changed byte/ID/timestamp/key refusal; canonical base64, bounded header/list and clock boundary cases.
- Supported event schema; unsupported type ignore; fatal UTF-8, invalid UUID/date and privacy projection.
- Default-off/invalid signature cause zero storage and zero provider calls.
- Durable same-ID replay/collision, concurrent insertion, callback-before-acceptance, receipt/configuration ambiguity and owner/null-owner isolation.
- Out-of-order adverse/delivered/sent events and stable independent facts; no inbox/reading/training claim.
- Hard body-size limit without trusting Content-Length, cached/raw/Node/Web handling, aborted input and no JSON-reader regression.
- Generated additive migration/old snapshot preservation, isolated real MySQL checks with synthetic records, precision and indexes.
- Owner API/SFC empty/error/default-off/provider states and mobile/desktop rendered acceptance.
- Final frozen typecheck, fresh node-server build, complete safe Vitest; report skips separately.

## Primary protocol references

- [Resend signature verification](https://resend.com/docs/webhooks/verify-webhooks-requests)
- [Svix manual raw-byte verification](https://www.svix.com/guides/receiving/receive-webhooks-with-go/)
- [Resend event types](https://resend.com/docs/webhooks/event-types)
- [Resend delivered semantics](https://resend.com/docs/webhooks/emails/delivered)
- [Resend retry/replay behavior](https://resend.com/docs/webhooks/retries-and-replays)

References describe provider protocols, not evidence that this integration was exercised against a real account. No account, domain, webhook registration, secret, feature flag or paid service is provisioned here.

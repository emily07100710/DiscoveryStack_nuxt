# Managed Site Email Outbox V1

Status: **IMPLEMENTED / DATABASE_APPLIED / DEPLOYED / DELIVERY_GATED**. This document records implementation, local verification, exact production schema application and the verified live code; it is not real email or complete production-journey acceptance evidence.

## Scope

This is the private DiscoveryStack platform's durable transactional email runtime. It does not merge the separate customer-site SQLite outbox into the platform, enable marketing campaigns, provision a company mailbox, or change the public Astro application. It covers inbox verification, customer reaccess, member invitation, contact-form forwarding, and customer-workspace-ready notices through their actual server call sites.

Production call sites must durably record an exact owner/project/purpose/message before calling the existing strict Resend-compatible transport. Persisting a queue item is not provider acceptance, inbox delivery, payment, deployment or customer-workspace delivery evidence. Existing success/failed/manual-required envelopes and authority checks remain intact. Injected test transports do not prove production queue wiring.

## Immutable identity and private payload

Each item binds owner/project where they actually exist, a fixed purpose, server-owned authority references, immutable payload fingerprint, provider-configuration fingerprint, expiry and a stable provider idempotency key. Pre-purchase inbox verification legitimately has no owner or project yet: its scope is the exact persisted funnel session and challenge, not an invented owner or borrowed project. Null owner/project never permits a wildcard lookup or access to another scope; the dedupe identity includes the complete purpose-specific authority scope. Same-key/same-payload replay returns the existing item; changed payload, owner, recipient or authority is a collision and fails closed. Client JSON cannot supply queued status, success, owner authority, callback code, provider configuration or arbitrary retry policy.

Recipient, subject, body and optional reply-to are AES-256-GCM encrypted at rest with a separately configured server-only secret. Associated data binds row identity, owner, project, purpose and fingerprints. No API key, password or provider credential enters the payload. Queue inspection, errors, event records and task results expose only metadata, hashes and safe codes; no plaintext message, address, code, bearer link, ciphertext or secret is returned. Key rotation or tampering fails closed and never falls back to plaintext.

Fingerprints of private payloads and authority are keyed HMAC-SHA256, not predictable unkeyed hashes of a six-digit code or a recipient/template. The provider-configuration fingerprint is also authenticated as AES-GCM associated data. A business record that introduces a one-time code or raw bearer token and its encrypted outbox message are saved in the same SQL transaction; a process restart cannot commit the token hash while losing the only copy of the link. Transport and current-authority queries run only after that transaction commits.

## Authority, expiry and configuration

A fixed production authority resolver re-reads the current project and purpose-specific record before transport: verification challenge, reaccess token/grant, member invitation, submitted contact message plus currently verified inbox, or exact paid/live release and customer-workspace authority. The exact recipient and original authority must still match. Consumed/expired/revoked challenges, suspended projects, removed membership, changed recipients and stale payment/deployment/workspace authority are not sent. Cancellation clears private payload but preserves reduced audit metadata.

Configuration is entirely server-owned, including canonical private origin, sender, endpoint allowlist and encryption secret. Configuration drift cannot replay an old message under a new sender or endpoint. Missing/invalid configuration or execution-disabled state never invokes a provider. Existing email readiness must not claim durable delivery readiness solely because an API key and From are syntactically valid.

## Leased execution and uncertain outcomes

MySQL/TiDB storage provides atomic insert/replay and compare-and-swap leases. Work is bounded; leases are acquired per item immediately before processing, rather than for a serial batch that may expire while waiting. Concurrent workers and stale acknowledgements cannot overwrite a new lease or cause a second successful delivery record. Provider transport stays outside database transactions and retains its bounded timeout, exact-origin allowlist, redirect rejection, bounded response and UUID receipt validation.

Retries use the original immutable payload and stable provider idempotency key. The provider's bounded idempotency window is tracked from the first attempted transport. Expired links, changed authority, exceeded attempts and uncertain outcomes outside that window are not blindly resent; they become cancelled or require operator attention. Successful acceptance stores only a reduced receipt/fingerprint and clears encrypted message content. Provider acceptance is distinct from observed inbox receipt.

Provider acceptance is durably saved before updating any purpose-specific delivery receipt. If that local reconciliation fails or the process restarts, a reconciliation-only retry uses the saved provider receipt and never calls the provider again. Current authority, expiry, lease and the conservative 23-hour resend window are rechecked after asynchronous work, immediately before the relevant side effect.

## Production wiring and safe default

The actual platform services use the durable delivery runtime by default, preserving their caller-facing contracts and post-send receipt logic. Immediate delivery, if permitted, is still lease-protected and queue-backed. A bounded Nitro task handles due retries with a server-owned execution switch defaulting to false. Neither building, unit testing, applying a migration nor deploying code enables real email. No external service is called in safe tests. No provider account, domain, plan or spend is changed by this work.

The separately opt-in `NUXT_MANAGED_SITE_EMAIL_OUTBOX_RETENTION_ENABLED` switch permits a bounded expired-payload cleanup while delivery is paused; it never calls a provider. With both switches off, the scheduled task performs no configuration, identity, database or provider work. Operators should leave retention cleanup enabled after database acceptance if they later pause actual delivery. Owner inspection lists only that owner's latest 50 records; pre-purchase challenges with no owner are deliberately excluded, never borrowed into an owner's scope.

## Required verification

- Durable replay and payload/authority collisions; owner/project isolation.
- Real repository query/CAS shape and restart recovery, not only an in-memory queue.
- One lease under overlapping workers; stale completion and uncertain network outcomes.
- Provider idempotency-window boundary; expiry before transport and after asynchronous authority checks.
- All five real platform call sites; no false queued-as-delivered success or early workspace-ready receipt.
- Encryption, wrong key, payload/associated-data tampering and private-content cleanup.
- Current recipient, project, invitation/challenge/token and release/payment/workspace revocation.
- Missing configuration and default-off task cause zero provider calls.
- Additive migration/schema consistency in isolation; no production migration as a side effect.
- Final typecheck, fresh node-server build, then complete safe Vitest with sources frozen.

Real Resend acceptance, DNS/sender verification, actual inbox receipt and continuous scheduler operation remain separately gated until their exact checks are executed. Production database application is recorded separately below.

## 2026-10-07 local acceptance evidence

Before the production compatibility correction, frozen typecheck (16.928 s), fresh node-server build (47.489 s) and complete safe Vitest (232.85 s) all exited 0: 302 files / 5,736 tests passed, 15 files / 33 tests skipped, 317 files / 5,769 tests total. The skipped count included six explicitly opt-in MySQL cases, which separately passed against a real isolated MySQL 8.4 using synthetic data and the actual migration, Drizzle repository and service. No production database or real provider was used by these validations. This preliminary result is not substituted for the corrected-source verification below.

The initial full run had three failures in the old scheduler contract's eleven-job inventory. The test inventory was updated to include the exact new outbox task and configurable cron, retaining cadence, collision, no-loss and no-duplicate assertions. The final frozen sequence above was rerun in full; the initial failure is not relabelled as a pass.

Independent review found and fixed the final authority/lease ordering: each branch renews its lease before the final authority read, then checks the known lease deadline and expiry synchronously before transport or callback. Transport also requires at least 30 seconds of remaining lease time. Revocation during renewal and a slow authority read cannot authorize a stale effect. Workspace-ready retries retain an expiry anchored to the persisted workspace receipt's verifiedAt; retrying does not extend it or cause an immutable-payload collision.

Four local production-build HTTP checks passed for anonymous API protection, ignored caller scope parameters, public-origin CORS denial and the new protected page's no-store/noindex/correct public exit. These do not prove an authenticated owner's rendered UI or real database read. The three isolated customer-site examples were also rerun: 53 tests passed, zero failed or skipped; this is separate from the platform outbox.

## 2026-10-07 authorized production schema application

The initial protected local snapshot request was denied without execution. The user subsequently explicitly authorized the described full local backup and isolated restoration. A new consistent production snapshot contains 195 tables / 260 rows; its SHA-256 is `72b420a96f497582672a2cd6b29642edfd2fd55950b02f0bd695dc180c1559b9`. The directory is 0700 and SQL file 0600; neither snapshot nor customer data enters Git or a public service. All table counts and field-level semantic digests matched after isolated restoration. Both owned restore containers were removed; the protected snapshot remains available. This is not scheduled offsite backup.

The first production CREATE TABLE was rejected with `ER_INVALID_DEFAULT`; no DDL statement succeeded. A subsequent read-only check confirmed the exact 0045 ledger, 195 tables and absence of the new table. The un-applied 0046 SQL, schema and snapshot were corrected to explicit `CURRENT_TIMESTAMP(3)` defaults, retaining `ON UPDATE CURRENT_TIMESTAMP(3)`. The corrected migration was rehearsed again on an isolated complete restoration before retrying production.

After that correction, runtime and tests were frozen again: typecheck (20.978 s), fresh node-server build (58.892 s), then complete safe Vitest (246.33 s) all exited 0. Final totals are 302 files / 5,737 passed tests, 15 files / 34 skipped tests, 317 files / 5,771 total tests, zero failed. Report SHA-256: `b07d5db060d28677a958ca4d20e76d29942f93719991bb01e16f2047f6538792`. All seven opt-in isolated MySQL cases separately passed, including a real synthetic insert omitting both timestamp fields. The four anonymous local production-build HTTP checks and 53 independent customer-runtime tests also passed again. No real provider or production data was used by these tests.

At 2026-10-07 07:20:02 Asia/Taipei, corrected migration 0046 was applied to the exact previously verified TLS TiDB target. SQL SHA-256: `548a889a95f04fe9f6a05de8ade6a553b7992aaea7ca58b9cb0797ed7b76306d`. Production now has 196 tables and 47 ledger rows; all 22 new columns, millisecond precision and four indexes (primary, unique, due, owner) were verified. The new queue remains empty. Only the new table/indexes and canonical migration ledger were written; existing business tables were not changed.

Code commit, push and live deployment are still pending at this record's checkpoint. The directly checked Render service remains Free; the new delivery and retention environment keys are absent and no linked environment groups are configured, so source defaults remain off. No email, model, customer-site publication or payment switch was enabled.

## 2026-10-07 live deployment verification

Execution revision `f0daa2774bad818f53e8c1659d080842c446ae9e` was committed within the exact 43-file release fence (secret-pattern matches: zero; runtime/test freeze fingerprint unchanged) and normally pushed to both existing main remotes, without force. Render service `srv-dab7es3tqb8s73f1orlg` was directly checked: Last successfully deployed commit points to that exact revision; deployment `dep-db2o56jrjlhs73flr8q0` is Live, Auto-Deploy duration 2m23s. The service remains Docker Free and its inactivity/scheduler limitation remains unresolved. The live screenshot is held in protected local temporary storage, not Git.

All 21 formal non-mutating HTTP checks passed: the previous 16 public/private checks plus four new anonymous email page/API checks and the exact client artifact. Formal HTML references `/_nuxt/C1Ft4Ad0.js`, whose served SHA-256 `8d223e68eeaa0be5c7d1d4088cde4d7f870f0de5cf91c7bc98e89075c45c2468` matches the local fresh build and includes the new email API reference. These anonymous checks are distinct from the subsequent owner read below. Business-data writes, real email acceptance/inbox receipt, continuous worker operation, actual LINE approval and model training remain separately NOT_RUN.

Remote [CI run `37546156904`](https://github.com/tendertech2018/DiscoveryStack_nuxt/actions/runs/37546156904) for this exact execution revision completed successfully. Both required jobs, public-site (astro check/build/test) and nuxt-app (typecheck/build/test), are success. The final remote result was checked independently; the local test counts above are not asserted as uncollected remote per-test totals.

After the human confirmed a normal owner login, the existing formal email page was reloaded and its read-only “更新紀錄” control used. The exact `/api/managed-sites/email-outbox` response was HTTP 200 / application/json; this route requires the current owner and performs a real owner-scoped SQL metadata query, with database errors returning 503 rather than a false empty success. The settled UI showed no records, configuration incomplete, and delivery off. Only response path/status/MIME and the non-private empty-state UI were retained: no cookies, tokens, headers, bodies, addresses, customer records or secret values were inspected or copied. This proves the new owner's empty-list database read, not production record isolation with populated data, a business write, provider acceptance or inbox delivery. The screenshot stays in protected local temporary storage, not Git. No email, LINE message, publication, training, payment or execution switch was triggered.

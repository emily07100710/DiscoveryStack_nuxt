# Managed Site Email Manual Review V1

Status: **IMPLEMENTED / DATABASE_APPLIED / DEPLOYED / EXECUTION_GATED**. Migrations 0048–0050 and the corresponding application release are verified as of 2026-10-08 in [the current release record](docs/CONFIGURATION_READY_LAUNCH.md#2026-10-08-release-and-activation-checklist). The review feature remains gated and was not enabled by that release. It is a separate owner-authorized investigation workflow, not a sending or recovery authority; real owner closure remains unverified.

## Scope and immutable evidence boundary

Complete the private platform's handling of an owned outbox item in `manual_required`: an owner may record that investigation is closed without sending again. Keep the original outbox status, payload cleanup, acceptedAt, receipt, key, attempts, fingerprints, lease and business-reconciliation state unchanged. A closure is an owner assertion, not provider acceptance, server delivery, inbox receipt, customer learning consent or successful business fulfilment. It never clears adverse provider observations.

Two fixed classifications are permitted: `reviewed_no_resend` (investigation reviewed; no additional send) and `handled_outside_platform` (owner reports handling through another channel; not independently verified). Neither asserts whether the original email was sent. No free text, email content, receipt, token, signature or credential is accepted or stored. A customer who needs a new access link must use the existing current-authority access workflow; this operation cannot recover or resend an expired original message.

The existing audit table cannot represent legitimate owner-scoped reaccess notices with projectId null. Migration 0049 added one separate reduced `managedSiteEmailManualReviews` ledger: one immutable closure per outbox ID, with outboxId, ownerUserId (also the authenticated actor), requestId, outboxVersion, reason and closedAt; primary key outboxId, unique owner/requestId, and bounded owner/time index. There is no UPDATE/DELETE/reopen operation. Migration 0048 remains a separate provider-event increment. Both schema increments are applied; see the current release record above. Historical local acceptance continues to describe the earlier pre-release checkpoint.

## Server-owned authority and concurrency

Require the current owner session, resolve its database user ID server-side, and look up the exact outbox ID with that owner predicate. Foreign, nonexistent and null-owner rows return the same not-found result. An arbitrary client owner/project/status/provider receipt cannot widen authority.

The client sends only itemId (UUID), expectedVersion (64 hex digest), requestId (UUID), reason (the fixed enum) and confirmNoResend:true. Reject extra fields, malformed identifiers and any missing confirmation before storage. The version is a deterministic digest of the exact reduced terminal outbox snapshot: ID, purpose, status, updatedAt, expiresAt, attemptCount and safe error code. It contains no private-message hash or provider credential.

In one short SQL transaction, lock the exact owned outbox row for update, load any prior review, enforce immutable replay/collision, and revalidate `manual_required`, absence of all lease fields, and the exact expected snapshot version before INSERT. Same request, version and classification returns the original immutable closure, including its time; a changed request/body for an already closed item or reuse of an owner/requestId for another item conflicts. Transaction/storage failures are generic retryable errors, never false success. SQL constraints decide concurrent winners; process memory is not the ledger. No provider call occurs inside or outside the transaction.

## HTTP and independent rollout gate

Add exactly POST `/api/managed-sites/email-outbox/manual-resolution` to the existing catch-all file, preserving the signed Resend branch unchanged. No new public-browser CORS capability. Require exact canonical same-origin and compatible Sec-Fetch-Site, authenticated owner, JSON content type and an actual 2 KiB streamed/cached body bound. Never process a mutation through GET or OPTIONS. Private no-store/noindex/no-referrer headers apply to all branches.

`NUXT_MANAGED_SITE_EMAIL_REVIEW_ENABLED` defaults false and is independent of sending and observations. When off, no review query or write occurs, and the owner GET also works in environments where migration 0049 has not yet been applied. Migration 0049 is applied in the current formal environment; enabling still requires separate owner rollout approval. The gate does not need provider secrets and grants no resend, LINE, publication, crawl or training authority.

## Safe owner read and UI

The existing owner GET remains read-only and bounded to its most recent 50 items. If review is enabled and manual-required rows exist, fetch only those owners' reduced closures using an exact outbox owner join. Expose a second explicit allowlist projection: manualReviewStatus, manualReviewVersion, manualReviewReason, manualReviewClosedAt. No requestId, owner ID, record fingerprint or private payload is returned. Corrupt/stale closure binding fails closed rather than claiming current closure.

The page separates original queue status, unchanged provider evidence, and owner investigation status. Default off has no mutation controls. Opening a review form or refreshing sends nothing. For an enabled, open manual review, show purpose, original reason, expiry, cautious provider observation, structured classification and an unchecked explicit no-resend confirmation. A separate deliberate submit appends one review. Keep the same command/requestId on uncertain failure and retry; changing a classification creates a new command. Disable duplicate clicks. Conflict prompts a read-only refresh; a success cannot be claimed from a failed refresh. Do not turn a closed investigation into a delivered-email badge. Desktop/mobile, cancellation, success, replay, conflict and generic errors need rendered acceptance with synthetic data only.

## Required verification

- Strict command/extra-field/confirmation validation; deterministic snapshot binding; immutable explicit projection; no private content or invented provider/inbox facts.
- Default-off and failed auth/origin/input cause zero storage or external actions; source checks preserve webhook signatures and CORS boundary.
- Owned/null-project review; foreign/null-owner/missing row indistinguishability; all nonmanual and lease-bearing rows rejected.
- Same command replay preserves time; different payload/key conflicts; same owner key cannot close another item; parallel commands produce one durable record.
- Snapshot drift, transaction failure/rollback, SQL uniqueness, actual reduced schema/indexes and unchanged full outbox values, including acceptedAt/receipt when present.
- Bounded owner read ignores client scope hints, filters foreign/corrupt projections, and does not query the review table when disabled.
- UI GET/refresh/cancel cause zero writes; explicit submit only the permitted review action; no send/retry/learning endpoint; honest failure and immutable closure display.
- Installed-tool typecheck, fresh node-server build, then full safe Vitest from a frozen source; opt-in isolated SQL and loopback HTTP reported separately from skipped real-provider checks.

No production backup, schema application, Git commit/push, Render deployment, flag change, provider setup, customer mutation or paid action is authorized by this specification. Preserve prior 0048 acceptance as historical evidence, not final validation of a later revision.

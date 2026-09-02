# Stripe Payments Runtime V1

## Scope and authority

Stripe is one registered implementation of the Managed Site `payment` capability. Checkout creation, webhook verification, reconciliation, order transitions, release blocking, project/subscription suspension, and append-only evidence remain server-owned. A browser may request an operation, but it cannot submit a payment state, Stripe object result, API credential, webhook secret, or raw webhook payload as authority.

The implementation uses native server `fetch`, `node:crypto`, strict reduced projections, and the existing Managed Site provider registry. It does not add the Stripe SDK and does not create a second payment write path. Both signed webhooks and owner-triggered reconciliation converge through `processManagedSiteVerifiedPaymentWebhook`.

## Provider registration

1. Configure the owner-scoped `payment` capability with provider key `stripe`.
2. Store only an opaque credential reference in the provider configuration. The referenced value exists only in the server runtime credential registry.
3. Configure the exact Stripe API origin as `endpointOrigin`, the provider-hosted Checkout origin as `checkoutOrigin`, and the deployed site origin as `returnOrigin`. These are separate authorities: Stripe hosts the payment page, while this application owns the success and cancellation destinations.
4. Trigger server verification. Verification performs one read-only `GET /v1/balance` and records the reduced capability receipt.
5. Register the deployed Stripe webhook URL and its separate webhook-signing credential reference.
6. Keep live checkout and reconciliation fail closed until the provider configuration is `verified`, the credential reference resolves, and all exact origin allowlists match.

## Required runtime configuration

Do not put any credential value in Git, database rows, browser storage, fixtures, logs, documentation, or issue text.

| Runtime item | Contract |
| --- | --- |
| Credential registry | `DISCOVERYSTACK_MANAGED_SITE_CREDENTIALS_JSON` maps opaque references to runtime-only values. It contains both the Stripe API credential reference and the independently selected webhook-signing credential reference. |
| Stripe provider configuration | Owner-scoped `payment` configuration uses provider key `stripe`, an opaque API credential reference, `endpointOrigin` set to the allowlisted Stripe API origin, `checkoutOrigin` set exactly to `https://checkout.stripe.com`, and `returnOrigin` set to the deployed application's exact HTTPS origin. |
| Provider origin allowlist | `DISCOVERYSTACK_MANAGED_SITE_ALLOWED_PROVIDER_ORIGINS` includes the exact Stripe API HTTPS origin. |
| Checkout origin allowlist | `DISCOVERYSTACK_MANAGED_SITE_ALLOWED_CHECKOUT_ORIGINS` includes `https://checkout.stripe.com`. |
| Webhook provider selection | `DISCOVERYSTACK_PAYMENT_WEBHOOK_PROVIDER_KEY=stripe`. |
| Webhook credential selection | `DISCOVERYSTACK_PAYMENT_WEBHOOK_CREDENTIAL_REF` contains only the opaque reference to the Stripe endpoint-signing secret. |
| Private browser origin | `NUXT_DISCOVERYSTACK_PRIVATE_ORIGIN` may define the exact deployed owner origin used by same-origin mutation checks. |

The Stripe endpoint to register is:

`https://<private-nuxt-origin>/api/managed-sites/payments/stripe/webhook`

The webhook request body is capped at 1,000,000 bytes; a larger declared or streamed payload is rejected with HTTP 413 before signature processing.

## Single payment route file

This engine is capped at exactly one API route file because Nuxt's generated typed `$fetch` route map is at the TypeScript key limit. All Stripe payment HTTP entry points are therefore dispatched by `server/api/managed-sites/payments/[...path].ts`; adding another payment route file is outside this runtime contract.

The catch-all derives its sub-path from the request pathname after the literal `/api/managed-sites/payments` prefix and requires an exact segment count. Its dispatch table is:

| Method | Sub-path | Behavior |
| --- | --- | --- |
| `POST` | `/stripe/webhook` | Verify and process the raw Stripe-signed webhook without owner-session or same-origin checks. |
| `GET` | `/orders` | Return the authenticated owner's private order projection. |
| `POST` | `/projects/:projectId/releases/:releaseId/reconcile` | Same-origin, owner-scoped reconciliation against Stripe's read-only APIs. |
| Any | Unknown sub-path | Return HTTP 404. |
| Wrong method | Known sub-path | Return HTTP 405. |

The endpoint should receive exactly these four event types:

- `checkout.session.completed`
- `payment_intent.succeeded`
- `charge.refunded`
- `charge.dispute.created`

## Checkout and metadata round-trip

The server loads the owner-claimed draft order, quote, quote lines, approved release, provider configuration, and pre-purchase binding. It re-sums every line before calling Stripe. A positive `cadenceDays` selects Stripe subscription mode with a daily `interval_count`; zero selects one-time payment mode.

`returnOrigin` is used only to build `success_url` and `cancel_url`. `checkoutOrigin` is used only to validate the hosted URL returned by Stripe. Stripe Checkout URLs are pinned to `https://checkout.stripe.com`, retain their required `#fid...` fragment, and continue to enforce HTTPS, credential rejection, URL and path length bounds, and redirect-like query-parameter rejection. The non-Stripe checkout path still rejects fragments.

Checkout Session metadata carries only the reduced `ds_*` authority set: draft order, release, owner, provider configuration fingerprint, provider verification receipt fingerprint, checkout receipt fingerprint, and commerce snapshot fingerprint. The same set is attached to `payment_intent_data.metadata` in payment mode or `subscription_data.metadata` in subscription mode. A signed success receipt also stores reduced downstream Stripe object identities when present: Checkout Session, PaymentIntent, Charge, Invoice, and Subscription ids. Credential values, Authorization headers, signatures, raw request bodies, and raw Stripe responses are never stored.

The owner orders projection may reveal the generated Checkout URL only from the allowlisted `checkoutUrl` field on a `checkout_session_created` receipt. It never passes receipt metadata through wholesale.

## Signature, tolerance, and replay contract

The webhook route reads raw bytes and the `Stripe-Signature` header before obtaining any repository or database handle. It verifies the HMAC SHA-256 `t` and `v1` values against the runtime-only endpoint-signing credential, uses constant-time comparison, and rejects timestamps outside a 300-second tolerance. Bad signatures, stale timestamps, malformed envelopes, commercial mismatches, owner mismatches, and snapshot mismatches fail closed.

The route never logs or persists the signature or raw body. It stores a hash and reduced provider identity only after verification and lineage checks. Provider event ids and event fingerprints provide replay and collision control. Exact replay returns the existing result. A different payload under the same provider event id is rejected. Order-scoped prior-success, prior-refund, and prior-dispute checks suppress a later duplicate lifecycle as `ignored_out_of_order` even when it arrived through the other evidence channel.

A valid signed unsupported event is acknowledged with `accepted: true` and `ignored: unsupported_event_type`, without an inbox row or receipt. For every handled event type, absent or incomplete `ds_*` metadata triggers a read-only lookup against server-persisted Stripe object ids before any inbox row is created. A matching payment receipt supplies the owner, draft order, release, checkout fingerprint, and provider-configuration lineage; the event then follows the same idempotent transition path as a metadata-bound webhook. If no stored id matches, the route returns `ignored: unbindable_provider_reference` with no repository writes. A metadata-bound unknown draft order id returns HTTP 404 before any inbox write. A present `ds_*` value with a wrong type, empty or oversized value, or invalid bounded identity remains a malformed payload and returns HTTP 400.

## Order state machine

The canonical draft-order progression is:

`draft -> payment_pending -> payment_verified`

From `payment_verified`, verified monetary evidence may move the order to `refunded` or `disputed`. A refund or dispute amount must use the same currency and be between one minor unit and the quote total. Both full and partial amounts move to the same terminal order state; the receipt records the actual `amountMinor` and `fullAmount`. There is deliberately no invented `partially_refunded` state.

A verified success moves the exact release from `checkout_pending` to `payment_verified` and records one `provisioning_armed` marker. It does not itself enqueue provisioning. A verified refund blocks the release with `PAYMENT_REFUNDED`; a verified dispute uses `PAYMENT_DISPUTED`. Both suspend the project and subscription. Amounts greater than the canonical quote total, currency mismatches, and refunds/disputes without a prior success are rejected or recorded as out of order according to the shared transition rules.

An out-of-order refund or dispute before success is first recorded as ignored. When the success arrives, the shared transition creates the project/subscription and immediately applies that earlier authority: dispute wins over refund, the order becomes `disputed` or `refunded`, and the release becomes `blocked`. This settled path records no `release_payment_bound` or `provisioning_armed` receipt.

## Owner-triggered reconciliation

The owner mutation route is same-origin checked and owner-scoped to the exact project, release, and draft order. It reads the stored Checkout Session id and, when known, the successful PaymentIntent id. It then performs bounded, redirect-rejecting, ten-second, read-only Stripe calls:

- `GET /v1/checkout/sessions/{id}`
- `GET /v1/payment_intents/{id}` when a PaymentIntent id is known
- `GET /v1/charges/{id}` when the PaymentIntent identifies a latest Charge

Every successful reconciliation request appends a reduced `payment_reconciliation` receipt describing the observed lifecycle and whether it agreed with local state. It does not store the raw response. Only a provider-observed `paid`, `refunded`, or `disputed` lifecycle that is not already represented locally is synthesized into reduced verified events and passed to the same webhook transition function. When local state is unpaid but Stripe reports refunded or disputed, reconciliation sends the terminal event first and then a deterministic paid event so the earlier authority settles immediately. Provider event ids and `occurredAt` values are deterministic and use the selected Stripe objects' `created` Unix timestamps, never the local retry clock. Repeated and out-of-order reconciliation attempts therefore converge through inbox replay rather than colliding. An unpaid observation is evidence only and never downgrades a previously verified payment.

## Known provider limitation

Real Stripe Dispute objects do not inherit Checkout Session, PaymentIntent, or Charge metadata. Subscription-mode PaymentIntents also do not inherit `subscription_data.metadata`, so routine recurring-billing events may arrive without the managed-site keys. Raw signature verification remains network-free and database-free; after signature verification, the DB-aware payment path binds by exact provider object ids previously persisted on payment receipts. In particular, a metadata-free PaymentIntent can persist its Charge id after matching a stored PaymentIntent id, and a later Dispute can bind through that Charge or PaymentIntent id and halt provisioning normally.

To minimize unbindable noise and make the recovery contract explicit, the operator must subscribe the endpoint to exactly `checkout.session.completed`, `payment_intent.succeeded`, `charge.refunded`, and `charge.dispute.created`. A `checkout.session.completed` event whose `payment_status` is not `paid` is acknowledged with `ignored: checkout_session_not_paid`. A valid event whose ids do not match any persisted payment receipt is acknowledged as unbindable; owner-triggered reconciliation remains the independent recovery path for missed or genuinely unbindable lifecycle evidence.

## Truthful boundary

- Mocked tests prove deterministic request validation, signature checks, owner/order isolation, reduced receipts, lifecycle suppression, and read-only reconciliation behavior against injected transports.
- The opt-in real Stripe test performs only `GET /v1/balance`. It never creates a Checkout Session, charge, refund, dispute, or customer.
- A successful balance read proves only that the exported credential can read that endpoint at that moment. It does not prove provider account ownership, webhook delivery, Checkout correctness, funds movement, refund handling, production browser behavior, or deployment readiness.
- Production provider configuration, webhook registration, authenticated owner sessions, live database migrations, provider delivery, and end-to-end payment settlement remain unverified until separately exercised in an isolated authorized environment.

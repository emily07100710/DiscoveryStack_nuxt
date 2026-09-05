# MANAGED_SITE_TAIWAN_PAYMENT_HANDOFF_V1

Status: **SPEC ONLY — NOT IMPLEMENTED.** Deferred out of the self-serve funnel release by owner
decision (「先留洞，之後再接」). Nothing in this document is wired into any runtime today.

Scope: adding 綠界 ECPay and 藍新 NewebPay as real managed-site payment providers, alongside the
Stripe path that already exists.

## 1. Why this could not ship with the funnel

The managed-site checkout contract assumes every payment provider hands back a **navigable URL**:

- `server/managed-sites/live-connectors/types.ts` — `ManagedSiteCheckoutSessionReceipt.checkoutUrl: string`.
- `server/managed-sites/live-connectors/checkout-session.ts:65` — the receipt is validated by
  `assertManagedSiteCheckoutUrl(...)`, which requires an HTTPS URL on the expected checkout origin
  before any receipt or release transition commits.
- `server/api/managed-sites/payments/[...path].ts:23-31` — the webhook router accepts exactly one
  provider (`stripe`), one signature header (`stripe-signature`), and one adapter.

ECPay and NewebPay do not issue a checkout URL. Both require the server to render a **signed HTML
form** (CheckMacValue / TradeSha) that the customer's browser auto-POSTs to the gateway. That is a
different handoff shape, not a different URL, so it cannot be expressed in the current receipt type
without changing the contract that Stripe, the release state machine, and the idempotency/receipt
fingerprints all depend on.

## 2. Required contract change (the real work)

Widen the checkout handoff from a URL to a discriminated union, and keep every existing Stripe
receipt byte-identical:

```ts
type ManagedSiteCheckoutHandoff =
  | { kind: 'redirect_url'; checkoutUrl: string }
  | { kind: 'signed_form_post'; action: string; method: 'POST'; fields: Record<string, string>; expiresAt: string }
```

Rules that must hold:

- `kind: 'redirect_url'` keeps running through `assertManagedSiteCheckoutUrl` unchanged.
- `kind: 'signed_form_post'` validates `action` against a per-provider allowlisted HTTPS origin
  (`payment-ecpay.com.tw`, `core.newebpay.com` and their sandbox hosts), rejects any field name or
  value that is not a plain string, and caps the payload.
- The signed form is **generated server-side and returned once**; the browser only renders and
  submits it. No signing material ever reaches the client bundle — the public/private origin
  invariant in `CLAUDE.md` still governs.
- The receipt fingerprint must cover the handoff exactly as it did the URL, so replay of the same
  `idempotencyKey` returns the identical form and never re-signs.

## 3. Webhook / notify side

Both gateways confirm payment with a server-to-server **notify POST**, not a signed JSON webhook:

- ECPay posts `application/x-www-form-urlencoded` with `CheckMacValue` (SHA256 or MD5 depending on
  `EncryptType`), and expects the literal body `1|OK` in reply.
- NewebPay posts `TradeInfo` / `TradeSha` (AES-256-CBC + SHA256 of the encrypted payload).

Work required:

- Extend `server/api/managed-sites/payments/[...path].ts` to a per-provider subpath
  (`/ecpay/notify`, `/newebpay/notify`) with each provider's own verifier, resolved through the
  existing `FAIL_CLOSED_PAYMENT_EVENT_VERIFIER` discipline in
  `server/managed-sites/ordering-service.ts`. **Fail closed on an unknown provider key.**
- Reuse the existing joint-transaction commit path; do not add a second payment state machine.
- Preserve amount authority: the notify payload's amount must be compared against the server-side
  recomputed quote total, and a mismatch must abort without transitioning the order.
- Return each gateway's exact expected acknowledgement string, otherwise both retry indefinitely.

## 4. Provider registry additions

`server/managed-sites/live-connectors/provider-registry.ts` currently computes
`allowedTransportFields` per exact provider+capability pair. Add:

- `ecpay` + `payment` → `{ endpointOrigin }`
- `newebpay` + `payment` → `{ endpointOrigin }`

Credentials (MerchantID, HashKey, HashIV) stay in the existing credential-reference indirection —
never in code, never in a test fixture, never in a report.

Sandbox identity must be recorded the way Stripe and Porkbun already do it, so the Phase E2
launch-readiness gate keeps blocking a production promotion while a gateway is still in sandbox:
`ecpay:stage` / `ecpay:production`, `newebpay:sandbox` / `newebpay:production`.

## 5. Until this ships

The funnel labels 綠界 and 藍新 honestly as 「需人工設定，付款後由客服聯繫」. They are quoted and
charged for the build work that is genuinely performed by hand, they create a
`pending_manual_setup` fulfilment row, and they never produce an activation receipt. Customers pay
you through Stripe; these modules are about how *their* end-customers pay *them*.

## 6. Acceptance criteria for the future round

1. A Stripe checkout receipt created before the union change and one created after are byte-identical.
2. An ECPay checkout produces a signed form whose `CheckMacValue` verifies against ECPay's own
   documented algorithm using a fixture vector, with no live call.
3. A tampered notify (amount changed, mac unchanged) is rejected and the order does not transition.
4. A replayed notify with the same trade number commits exactly once.
5. Sandbox credentials cannot promote the provider to a production identity while the
   launch-readiness gate reports blockers.

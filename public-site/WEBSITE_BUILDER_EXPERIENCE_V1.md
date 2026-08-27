# DiscoveryStack Website Builder Experience V1

## Purpose

This page is a high-fidelity, client-side concept preview for customers who want DiscoveryStack to plan, generate, operate, and continuously improve a managed website. It is intentionally not a payment page, a domain registrar, a Shopify installation flow, or a deployment console.

The product promise is simple: customers can first see and inspect an interactive direction, then decide whether to continue to human confirmation, payment, domain authorization, and deployment. The preview must never imply that one of those later actions has already happened.

## Fixed experience state machine

The Vue island uses the following ordered states:

`entry` → `diagnosis_or_brief` → `site_architecture` → `style_and_modules` → `generating` → `interactive_preview` → `plan_and_cadence` → `domain_and_launch` → `review_order` → `handoff`

Each step has one primary action, a visible current-step label, a previous-step action where safe, and local state preservation. Required fields block advancement with nearby plain-language errors. Returning to an earlier step does not clear the customer’s brief, selected architecture, modules, style, plan, cadence, or domain intention.

## Existing-site and new-site paths

The existing-site path accepts only a complete `http://` or `https://` URL. It uses the existing public `publicApiFetch('/api/site-analysis')` allowlist contract and presents only data returned by the injected or real public analysis response. It identifies the scope as public homepage analysis and does not call a private Nuxt route. Failed analysis shows a retryable human-readable error and never invents scores, findings, ranking, traffic, or performance claims.

The new-site path asks only for brand name, business description, audience, and desired visitor action. Example prompts fill only empty fields and never overwrite entered content. The component does not persist input to localStorage, sessionStorage, cookies, or the URL. It never asks for passwords, identity numbers, payment details, API keys, or other sensitive credentials.

## Preview and provider boundaries

The preview supports one-page, brand-and-blog, and simple-commerce directions. It can show selected modules, answer-first content, simulated assistant responses, appointment and LINE demo entry points, article content, and Shopify-ready-but-not-connected commerce concepts. Demo forms do not submit. The preview does not create a Shopify store, connect a provider, buy a domain, configure DNS or SSL, deploy a site, send email, or create an order.

The existing public preview boundary is retained as metadata for the public build-output contract, while this concept island does not call it. Production provider work remains a later, explicitly authorized handoff with provider-neutral adapters and human confirmation.

## Motion and accessibility

The visual system reuses the public site’s Navy, Cobalt, Paper/Sand, serif, sans, and mono hierarchy. CSS provides step transitions, selected-card lift, generation-stage reveal, preview morph, device-frame transitions, and handoff dialog motion without a third-party animation package, canvas, WebGL, or an infinite requestAnimationFrame loop.

`prefers-reduced-motion: reduce` disables or shortens non-essential motion. Timers are owned by the component and cleared on unmount. The dialog uses `role="dialog"`, `aria-modal`, Escape close, keyboard focus trapping, focus-visible styling, and restoration to the triggering CTA. Mobile layouts keep the primary action reachable without covering content and are tested at narrow widths through CSS contracts.

## Validation

The required local validation sequence is:

```text
pnpm install --frozen-lockfile
pnpm typecheck
pnpm build
pnpm test
git diff --check
```

The builder tests cover both entry paths, public analysis success and failure, required-field blocking, back-navigation state preservation, all site types, module and device preview behavior, fixed generation stage order, timer cleanup, reduced motion, domain simulation honesty, estimate disclosure, handoff focus behavior, private API exclusion, credential exclusion, and preview-only claims.

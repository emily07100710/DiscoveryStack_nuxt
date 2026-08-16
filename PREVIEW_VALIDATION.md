# Preview Validation

The managed preview was verified after moving Nuxt's generated build directory to `/tmp`.

- URL: `/en`
- Result: DiscoveryStack SSR public homepage rendered successfully.
- Confirmed elements: English route navigation, Traditional Chinese route switch, SEO/GEO public content, AI QA launcher, and Lead Capture form with privacy consent and honeypot field.
- The previous outer-template `Example Page` and unavailable response are no longer served by the managed preview.

## Production-domain check

The deployed homepage at `https://discovstack-kfpqmdfb.manus.space/en` renders successfully over HTTPS, and `/audit-lab` returns `X-Robots-Tag: noindex, nofollow, noarchive`. However, canonical and hreflang links still point to the earlier placeholder domain. The public site origin and OAuth allowlist must be updated to the actual Manus domain before final SEO validation.

## Production-domain recheck

After checkpoint `e86c514f`, the production homepage and Audit Lab remained available and the Audit Lab continued to return `X-Robots-Tag: noindex, nofollow, noarchive`. The page still returned the prior canonical and hreflang origin, so this must be rechecked after deployment propagation and, if persistent, traced through the container runtime environment.

## Production-domain final verification

After checkpoint `cfef5ad4`, `https://discovstack-kfpqmdfb.manus.space/en` rendered successfully over HTTPS. The DOM reported canonical `https://discovstack-kfpqmdfb.manus.space/en` and `en`, `zh-Hant`, and `x-default` alternate links on the same public domain. Fetching `/audit-lab` returned HTTP 200 with `X-Robots-Tag: noindex, nofollow, noarchive`.

## Owner access verification — initial state

On the production Audit Lab route, a browser without an owner session received the private landing state and only the `SIGN IN TO AUDIT LAB` action. Audit evidence, review decisions, and training controls were not rendered before authentication.

## Owner OAuth redirect reproduction

Selecting the production Audit Lab sign-in control generated the expected Manus OAuth authorization URL with the production callback origin and a nonce-bearing state value. In the sandbox browser, the external `manus.im/app-auth` page remained a blank loading view; no authorization code, session, or application data was exposed.

Reopening the proxy browser restored the production Audit Lab sign-in state. Its console contained no application-side errors before the authorization redirect, which narrows the blank loading state to the external authorization page or its browser-session prerequisites rather than the public SSR page.

A second proxy-browser reproduction navigated to the same correctly parameterized external authorization URL, showed only a loading spinner, and then resolved to `about:blank`. This occurred before the DiscoveryStack callback endpoint and confirms that the current blocker is an external portal/browser handoff, not a callback failure or owner-session failure.

The proxy browser can load the public Manus homepage normally, but it presents a `Sign in` control, confirming that the browser has no authenticated Manus owner session. The standard public sign-in control did not initiate a usable owner session in this browser context. Consequently, a live owner OAuth authorization cannot be completed by the proxy browser without a connected authenticated browser session.

After accepting the public-site notice, the standard Manus login page rendered correctly in the proxy browser and presented account-bound sign-in choices (social identity providers, email, and passkey). No owner credential or pre-authenticated session is available to the proxy browser, and no credential was entered or submitted during this diagnostic.

After the browser completed the public-site consent flow, the standard Manus login page continued to render normally. Returning to the production Audit Lab showed its client-side private-state loader; the owner sign-in action is expected after the anonymous overview request resolves.

With the public-site consent flow completed and the standard Manus login page demonstrably functional, the production Audit Lab `app-auth` authorization URL still rendered only a blank loading state. The issue is therefore not caused by the public cookie notice or the DiscoveryStack origin, callback URI, app ID, state encoding, or anonymous Audit Lab state transition.

The proxy browser console reported no client-side error. Its final document state after the `app-auth` redirect was `about:blank` with a completed empty document and no loaded resources, which confirms that the external authorization route clears the browsing context before the DiscoveryStack callback is invoked.

The existing My Browser connector was enabled for this task and could open the production Audit Lab directly. The page correctly remained in its anonymous owner-gated state, so no private Audit Lab data or training controls were exposed before an OAuth session was established.

An address-bar navigation to `/api/auth/login` returned the expected `400 This sign-in origin is not allowed`, because it did not carry the page-origin context required by the endpoint's allowlist. Returning to the Audit Lab rendered the normal anonymous gate. Subsequent authentication testing must invoke the page's own sign-in handler rather than directly browse to the protected login endpoint.

Within My Browser, the page text confirmed the owner OAuth control is rendered only on the anonymous Audit Lab gate. The browser automation did not expose the button as an indexed interactive element, so the next test must invoke its page handler from the loaded DOM while retaining the originating page context.

After the owner OAuth control became visible in My Browser as a page-interactive element, invoking it failed before navigation with a browser transport error (`Could not establish connection. Receiving end does not exist`). This is a My Browser session-bridge failure; no authorization URL, callback, credential, owner session, or training action was reached or changed.

Using the page handler's required `origin` parameter through My Browser reached the Manus `app-auth` account-selection screen for DiscoveryStack Production. The authenticated browser session presented an account choice without exposing its identifier in this record. The next action is to select that existing session and allow the OAuth callback to verify whether its open ID matches the configured owner.

## OAuth callback reliability retry

After auto-published checkpoint `de57e5d0`, the production `/audit-lab` route continued to show only the anonymous owner gate before sign-in. This confirms that the callback reliability update did not weaken the private-output boundary before a new OAuth round-trip.

The My Browser account-selection flow again reached the correct production callback URL, but the callback still returned a Cloudflare host-level 502 after account selection. This confirms the issue persists after provider-call timeouts and redacted stage diagnostics were deployed. Separate safe probes verified that the deployed callback module returns controlled 400 and 403 responses before provider exchange, the managed MySQL database accepts a local read-only `SELECT 1`, and the configured OAuth provider is reachable and rejects a deliberately invalid authorization code within 2.2 seconds. No real access token, account identity, owner session, database write, or training job was exposed or completed during these probes.

After the Axios provider-exchange compatibility update, explicit JSON request headers, a 25-second bounded timeout, and safe provider-error classification, My Browser again reached the correct account-selection page and selected the existing owner account through the normal OAuth flow. The real callback still returned a Cloudflare host-level 502 before returning any application response headers. Invalid-state probes on the same production release consistently returned no-store Nitro headers, which isolates the current blocker to the hosting upstream processing the real OAuth callback. No owner session was created and no training job was submitted.

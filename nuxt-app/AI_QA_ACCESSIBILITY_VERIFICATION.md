# AI QA Floating Dock Verification

This record captures the repeatable browser verification run for the public preview on 2026-08-16. It distinguishes actual browser measurements from source-level contracts.

| Check | Method | Result |
|---|---|---|
| Keyboard reachability | Native `Tab` events in a 1280×720 browser | The launcher was reached after 8 tabs. |
| Focus visibility | Computed style on `#qa-launcher` | `outline-style: auto`; `outline-width: 1px`. |
| Opening and Escape close | DOM click, then native `Escape` | The panel opened (`aria-hidden=false`), then closed and returned focus to `#qa-launcher`. |
| Mobile open bounds | 375×812 emulated viewport with `?qa=open` | Panel: left `12px`, right `363px`, top `356.22px`, bottom `791.20px`; fully inside the viewport. Input: left `185.33px`, right `308px`, top `687.17px`, bottom `738.36px`; fully inside the viewport. |
| Reduced motion | Emulated `prefers-reduced-motion: reduce` | The open panel remained usable and reported `animation-name: none`. |

The verifier is maintained at `scripts/verify-floating-ai-qa-accessibility.mjs`. It validates the stable public preview runtime; normal Nuxt client hydration remains tracked separately in the project TODO.

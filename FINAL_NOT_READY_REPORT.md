# DiscoveryStack Astro Public / Nuxt Private Split — Final Execution Report

## Decision

**READY FOR REVIEW，具有限定的環境型 full-test failures。** 所有 split-specific、public boundary、self-contained public test、Nuxt private target、production build、runtime CORS 與 strict visual parity gates 均已通過。Nuxt full Vitest 仍有 5 個既有外部 provider credential failures 與 3 個明確 skipped tests；依指令，它們不屬於本輪 split regression，不可用 mock、skip 或修改 credentials 掩蓋。

本報告是在唯一普通 commit 建立前寫入 worktree；commit SHA 與 push 後 remote SHA 由最終交付訊息補記，因為將報告本身納入 commit 時該 SHA 尚不存在。工作樹在本報告寫入時仍未提交。

## Base, branch and repository safety

| Field | Result |
|---|---|
| Required base | `6a24ace4e1924307b82adbaa809c2d8fc4914158` |
| Worktree | `/home/ubuntu/DiscoveryStack_astro-split` |
| Branch | `feature/astro-public-private-split` |
| Pre-commit HEAD | `6a24ace4e1924307b82adbaa809c2d8fc4914158` |
| `origin/main` | `6a24ace4e1924307b82adbaa809c2d8fc4914158` |
| Feature remote before delivery | No `origin/feature/astro-public-private-split` existed at final pre-commit audit |
| Required commit message | `feat: split public Astro site from private Nuxt operations` |
| Main modification | None; no checkout/edit/merge/push to `main` |
| Primary checkout | `/home/ubuntu/DiscoveryStack_nuxt`, branch `fix/seo-geo-core-hardening`, clean during final audit |

The permitted ordinary commit is conditional on the evidence in this report. No force push, PR creation, deployment or DNS/domain operation is part of this work.

## Implemented split

`public-site/` is a standalone Astro `7.2.4` static application with Vue islands. It owns the public marketing pages, bilingual public Markdown, public SEO/GEO explanation and brand copy, consent UI, public forms and bounded free website analysis. It contains no database, auth, Audit Lab, private API route, training pipeline, provider SDK, model weight or owner session access.

`nuxt-app/` remains the private Nuxt/Nitro operations and API application. It retains Audit Lab, owner authentication, database/schema/migrations, provider runtime, training/model-improvement runtime, private APIs, leads administration and private operational pages. Nuxt root `/` is a private redirect to `/audit-lab`; Nuxt no longer owns or prerenders the public marketing route set.

The sole public Markdown source is `public-site/src/content/pages/`. Sixteen bilingual Markdown files were copied from the exact-base public source and verified byte-for-byte. The three public visual CSS files, `redesign.css`, `immersive.css` and `hybrid-refresh.css`, were also verified byte-for-byte against the exact-base source.

## Public routes and private routes

The Astro static output contains 20 generated page entries: `/` and `/privacy` are static redirect pages; `/en` and `/zh-hant` are the bilingual homepages; `/en/privacy` and `/zh-hant/privacy` are bilingual privacy pages; and the 16 bilingual content routes cover services, methodology, glossary and publications. It also generates `/robots.txt`, `/sitemap.xml` and `/llms.txt`.

| Public Astro route group | Private Nuxt route group |
|---|---|
| `/`, `/privacy` static redirects | `/` redirects to `/audit-lab` |
| `/en`, `/zh-hant` | `/audit-lab`, `/audit-lab/**` |
| `/en/privacy`, `/zh-hant/privacy` | `/leads` and lead administration |
| `/en/services/**`, `/zh-hant/services/**` | `/training-pipeline` |
| `/en/methodology/**`, `/zh-hant/methodology/**` | `/ml-lab-preview` |
| `/en/glossary/**`, `/zh-hant/glossary/**` | `/api/audit`, `/api/intelligence` |
| `/en/publications/**`, `/zh-hant/publications/**` | `/api/seo-geo/**`, `/api/geo/**`, auth/owner/private APIs |
| `/robots.txt`, `/sitemap.xml`, `/llms.txt` | private server runtime, DB, provider and training surfaces |

The public homepage retains the SEO/GEO core explanatory section and its copy/geometry, but no longer links to `/audit-lab/seo-geo` or any private UI origin. The owner-workbench navigation remains available from the private owner layout and points back to the configured public origin.

## Public API and CORS boundary

Exactly two browser-callable API paths remain in the public client allowlist:

| Method | Route | Client behavior | CORS behavior |
|---|---|---|---|
| `POST` | `/api/leads` | JSON body, `credentials: 'omit'` | Exact configured public origin only |
| `POST` | `/api/site-analysis` | JSON body, `credentials: 'omit'` | Exact configured public origin only |
| `OPTIONS` | The same two paths | Preflight terminates before handler/DB work | Exact configured public origin only |

The public client accepts no arbitrary URL/path and returns generic public errors. `PUBLIC_OPS_UI_ORIGIN` and the legacy `publicOpsUiOrigin` consumer were removed from public source, `.env.example`, docs and output. Production-style fixture output used `PUBLIC_SITE_URL=https://public.example.com` and `PUBLIC_OPS_API_ORIGIN=https://api.example.com`; the output verifier passed 20 HTML pages, 16 custom sitemap URLs, public canonical links, the two API paths only, absence of private paths, absence of UI-origin markers and absence of server-only secret markers.

Runtime smoke with `DISCOVERYSTACK_PUBLIC_SITE_ORIGIN=https://public.example.com` passed: root returned `302 Location: /audit-lab`; `/audit-lab` returned `200` and contained `https://public.example.com/zh-hant` while excluding the fallback `https://www.example.com/zh-hant`; matching preflights for both public POST paths returned `204` with exact origin, `POST, OPTIONS`, `Content-Type`, `max-age` and `Vary: Origin`; mismatched origin returned `403`; and `/api/seo-geo/workspace` returned `401` with no public CORS allow header.

## Visual parity evidence

The authoritative evidence is under `review-evidence/visual-parity/`. It contains the repository-relative README, capture script, comparison script, baseline stability checker, final 24-row matrix, 48-row screenshot SHA-256 manifest and capture metadata. Screenshots, browser profiles, logs and temporary build output are intentionally outside Git.

| Field | Final result |
|---|---|
| Baseline | Nuxt public static output from exact SHA `6a24ace4e1924307b82adbaa809c2d8fc4914158` |
| Candidate | Current `feature/astro-public-private-split` worktree |
| Chromium | `151.0.7922.71`, Ubuntu 24.04.4 LTS |
| Viewports | Desktop `1440×1000`; mobile `390×844` |
| Capture | Same Chromium process per viewport, same local browser state, scroll `0` |
| Wait | `document.fonts.ready`, Noto Sans TC/Noto Serif TC/DM Mono loads, Cookie heading mount/font, two animation frames, 700 ms |
| Motion | Reduced-motion emulation plus injected animation/transition/caret disable CSS |
| Pixel rule | Changed when maximum RGB channel difference is greater than 12 |
| Threshold | Homepage `≤1.0%`; content/privacy `≤0.5%` |
| Baseline stability | **5 rounds, 192/192 comparisons PASS** |
| Candidate repeatability | **3 independent rounds, 72/72 comparisons PASS** |
| Authoritative final matrix | **24/24 PASS** |

| Route | Desktop ratio | Mobile ratio | Threshold |
|---|---:|---:|---:|
| `/en` | 0.001319% | 0.000000% | 1.0% |
| `/zh-hant` | 0.001319% | 0.005772% | 1.0% |
| `/en/privacy` | 0.000000% | 0.000000% | 0.5% |
| `/zh-hant/privacy` | 0.000000% | 0.000000% | 0.5% |
| `/en/services/seo-geo-growth-system` | 0.000000% | 0.000000% | 0.5% |
| `/zh-hant/services/seo-geo-growth-system` | 0.000000% | 0.000000% | 0.5% |
| `/en/methodology/journey-intelligence` | 0.122569% | 0.000000% | 0.5% |
| `/zh-hant/methodology/journey-intelligence` | 0.122569% | 0.000000% | 0.5% |
| `/en/glossary/geo` | 0.000000% | 0.000000% | 0.5% |
| `/zh-hant/glossary/geo` | 0.109514% | 0.000000% | 0.5% |
| `/en/publications/what-a-public-website-can-tell-you` | 0.139444% | 0.000000% | 0.5% |
| `/zh-hant/publications/what-a-public-website-can-tell-you` | 0.248958% | 0.000000% | 0.5% |

## Validation results

| Area | Exact result |
|---|---|
| Public frozen install | PASS: `pnpm install --frozen-lockfile` |
| Public Astro check | PASS: 23 files, 0 errors, 0 warnings, 20 hints/deprecation notices |
| Public self-contained test | PASS from clean `dist/.astro`: build generated 20 pages, then 5 files / 17 tests passed |
| Public fixture build | PASS: `PUBLIC_SITE_URL=https://public.example.com PUBLIC_OPS_API_ORIGIN=https://api.example.com pnpm build` |
| Public output boundary verifier | PASS: 20 HTML pages, 16 sitemap locs, 16 canonical target routes, exactly two API paths, no private routes/UI origin/secrets |
| Nuxt frozen install | PASS: lockfile up to date and Nuxt prepare completed |
| Nuxt typecheck | PASS |
| SEO/GEO targeted suite | PASS: exact 15 files / 82 tests |
| Private boundary targets | PASS: 7 files / 32 tests, including split key, CORS, auth, lead and private output contracts |
| Nuxt production build | PASS: `NODE_OPTIONS='--max-old-space-size=1536' NITRO_PRESET=node-server pnpm build` |
| Runtime smoke | PASS: root redirect, owner fixture link, both exact CORS preflights, mismatch fail-closed, private route no CORS |
| Migration runtime validation | **NOT RUN**: no throwaway database was available; no production DB access was attempted |

The public form interaction tests cover Fit Review and free analysis validation, successful mocked `/api/leads` and `/api/site-analysis`, and generic server-error feedback without external calls. The 15-file private targeted suite covers provider resolver/rules, evidence, plans, reviews, revisions, export ledger, strategy rerun, routing and workbench contracts.

## Full Nuxt Vitest truthful report

The final `pnpm test` result was `45 passed`, `3 failed`, `3 skipped` test files; `191 passed`, `5 failed`, `3 skipped` tests across `51` files. All five failures are provider credential/environment checks, not split-specific source failures:

| File | Failed test(s) | Cause |
|---|---|---|
| `tests/huggingface-namespace-secret.test.ts` | 1 | `HUGGINGFACE_API_TOKEN` and namespace were empty in the sandbox |
| `tests/huggingface.credentials.test.ts` | 1 | server `HUGGINGFACE_API_TOKEN` was not configured |
| `tests/provider-secrets.integration.test.ts` | 3 | required provider settings were undefined; Firecrawl read-only endpoint timed out at 5 seconds; Hugging Face read-only whoami returned `Invalid username or password.` |

The three skipped tests were `database-runtime-smoke.test.ts`, `oauth-origin.managed-preview.test.ts` and `oauth-origin.runtime.test.ts`, because their external database/managed-preview conditions were not available. No credentials were added, changed or mocked. The full suite passed the new `public-private-split.contract.test.ts` and the corrected `private-output-boundary.test.ts`.

## Moved/deleted scope

| Change | Result |
|---|---|
| Public Markdown | Moved/copy-verified from `nuxt-app/content/pages/` to `public-site/src/content/pages/`; Nuxt public content directory removed |
| Public routes | Removed Nuxt public page route tree and replaced it with Astro static route generation |
| Public components | Removed Nuxt public landing/content components after porting interactive behavior to Astro Vue islands |
| Public layout/CSS | Removed Nuxt public default layout/public CSS ownership; preserved exact three public CSS files in Astro |
| Public-only scripts/tests | Removed stale Nuxt public preview/registration artifacts; created Astro output/privacy/visual/boundary/form contracts |
| Private operations | Retained Nuxt owner layout, private pages, API handlers, DB/schema/migrations, provider runtime, training and lead operations |

No SEO/GEO workflow logic, client data, training data, model weights or database content was changed by this split.

## Explicit non-actions and constraints

No deployment, DNS/domain change, migration creation/application, schema change, production DB access, secrets or `.env` edit, external provider/CMS/WordPress/generic HTTP delivery write, client/training/model artifact change or force push was performed. `.env.example` contains placeholders only. The architecture and package manifests state deployment order and rollback guidance but do not execute deployment. Temporary static servers and build artifacts were stopped/removed before final commit preparation.

The only non-green items are the explicitly environment-dependent Nuxt provider credential tests and skipped external-runtime tests listed above. They are retained truthfully. The strict visual gate is green, not waived, and the requested ordinary commit/push may proceed once the final clean-tree audit records this exact state.

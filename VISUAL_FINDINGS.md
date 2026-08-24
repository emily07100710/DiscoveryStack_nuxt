# Visual Parity Findings

## FINAL / AUTHORITATIVE

This section is the only final visual result for `feature/astro-public-private-split`. The authoritative 24-row matrix is `review-evidence/visual-parity/VISUAL_PARITY_MATRIX.tsv`; the 48-input SHA-256 manifest is `review-evidence/visual-parity/screenshot-sha256.tsv`.

| Field | Final value |
|---|---|
| Capture timestamp | `2026-08-24T06:11:45.240786+00:00` (round 1 metadata; rounds 2 and 3 were run immediately after) |
| Baseline | Nuxt public static output from base SHA `6a24ace4e1924307b82adbaa809c2d8fc4914158` |
| Candidate | `feature/astro-public-private-split` current uncommitted worktree |
| Chromium | `Chromium 151.0.7922.71 built on Ubuntu 24.04.4 LTS` |
| Desktop viewport | `1440 × 1000` |
| Mobile viewport | `390 × 844` |
| Routes | 12 specified public routes, listed in `review-evidence/visual-parity/README.md` |
| Font readiness | `document.fonts.ready`; explicit Noto Sans TC, Noto Serif TC and DM Mono loads; Cookie heading computed font load |
| Animation strategy | `prefers-reduced-motion=reduce`; injected animation/transition/caret disable CSS |
| Settle strategy | scroll position `0`, two `requestAnimationFrame` calls, then 700 ms |
| Diff rule | Changed pixel when max RGB channel difference is greater than 12 |
| Threshold | Homepage ≤ `1.0%`; all content/privacy pages ≤ `0.5%` |
| Baseline stability | **PASS: 5 rounds; 192/192 baseline comparisons under threshold** |
| Candidate rounds | **PASS: 3 independent rounds × 24/24 = 72/72 comparisons under threshold** |
| Final result | **PASS: 24/24** |

The final round-1 matrix ratios were:

| Viewport | Route | Ratio | Threshold | Result |
|---|---|---:|---:|---|
| Desktop | `/en` | 0.001319% | 1.0% | PASS |
| Desktop | `/zh-hant` | 0.001319% | 1.0% | PASS |
| Desktop | `/en/privacy` | 0.000% | 0.5% | PASS |
| Desktop | `/zh-hant/privacy` | 0.000% | 0.5% | PASS |
| Desktop | `/en/services/seo-geo-growth-system` | 0.000% | 0.5% | PASS |
| Desktop | `/zh-hant/services/seo-geo-growth-system` | 0.000% | 0.5% | PASS |
| Desktop | `/en/methodology/journey-intelligence` | 0.122569% | 0.5% | PASS |
| Desktop | `/zh-hant/methodology/journey-intelligence` | 0.122569% | 0.5% | PASS |
| Desktop | `/en/glossary/geo` | 0.000% | 0.5% | PASS |
| Desktop | `/zh-hant/glossary/geo` | 0.109514% | 0.5% | PASS |
| Desktop | `/en/publications/what-a-public-website-can-tell-you` | 0.139444% | 0.5% | PASS |
| Desktop | `/zh-hant/publications/what-a-public-website-can-tell-you` | 0.248958% | 0.5% | PASS |
| Mobile | `/en` | 0.000% | 1.0% | PASS |
| Mobile | `/zh-hant` | 0.005772% | 1.0% | PASS |
| Mobile | `/en/privacy` | 0.000% | 0.5% | PASS |
| Mobile | `/zh-hant/privacy` | 0.000% | 0.5% | PASS |
| Mobile | `/en/services/seo-geo-growth-system` | 0.000% | 0.5% | PASS |
| Mobile | `/zh-hant/services/seo-geo-growth-system` | 0.000% | 0.5% | PASS |
| Mobile | `/en/methodology/journey-intelligence` | 0.000% | 0.5% | PASS |
| Mobile | `/zh-hant/methodology/journey-intelligence` | 0.000% | 0.5% | PASS |
| Mobile | `/en/glossary/geo` | 0.000% | 0.5% | PASS |
| Mobile | `/zh-hant/glossary/geo` | 0.000% | 0.5% | PASS |
| Mobile | `/en/publications/what-a-public-website-can-tell-you` | 0.000% | 0.5% | PASS |
| Mobile | `/zh-hant/publications/what-a-public-website-can-tell-you` | 0.000% | 0.5% | PASS |

All three candidate rounds ended `FAILED=0 TOTAL=24`. No result was selected from only one lucky run; every candidate round passed.

## Historical attempts — HISTORICAL / NOT FINAL

Earlier pre-fix attempts used different harnesses and/or pre-fix source states and reported 5/24, 8/24, 3/24 or 1/24 failures. Those values are retained only as debugging history and must not be used as the final acceptance result. The only final result is the 3-round evidence above and `review-evidence/visual-parity/VISUAL_PARITY_MATRIX.tsv`.

# Visual Parity Evidence

This directory contains the reproducible visual validation procedure for the public Astro split. **`VISUAL_PARITY_MATRIX.tsv` is the only authoritative final candidate matrix.** Historical experiments must not be treated as final evidence.

## Contract

The baseline is the Nuxt public site at base SHA `6a24ace4e1924307b82adbaa809c2d8fc4914158`. The candidate is the current `feature/astro-public-private-split` worktree. Capture uses one Chromium process per viewport and the same process, version, viewport, cookie state, scroll position and reduced-motion setting for baseline and candidate.

The exact route set is:

```text
/en
/zh-hant
/en/privacy
/zh-hant/privacy
/en/services/seo-geo-growth-system
/zh-hant/services/seo-geo-growth-system
/en/methodology/journey-intelligence
/zh-hant/methodology/journey-intelligence
/en/glossary/geo
/zh-hant/glossary/geo
/en/publications/what-a-public-website-can-tell-you
/zh-hant/publications/what-a-public-website-can-tell-you
```

Desktop is `1440×1000`; mobile is `390×844`. Homepage threshold is `≤1.0%`; every content/privacy route is `≤0.5%`. Pixel differences count a pixel when the maximum RGB channel difference is greater than 12, matching the comparison script.

The capture waits for `document.fonts.ready`, explicitly loads Noto Sans TC, Noto Serif TC and DM Mono, waits for the Cookie heading to mount and its computed font to load, injects reduced-motion plus animation/transition/caret disabling CSS, scrolls to `0`, waits for two `requestAnimationFrame` calls and 700 ms, then captures from the compositor surface. Screenshots are evidence inputs only and must stay outside this directory and outside Git.

## Prerequisites

Run all commands from the repository root. The candidate must be built from the current split worktree. The baseline server must serve a static/public build produced from the exact base SHA above; it must not be a different feature branch. Set `BASELINE_URL` and `CANDIDATE_URL` to local HTTP origins, for example `http://127.0.0.1:4312` and `http://127.0.0.1:4313`. Do not use production origins.

The capture script requires Python packages `Pillow`, `requests` and `websocket-client`, plus a headless Chromium executable available as `chromium`. The compare and stability scripts require `Pillow`.

## Candidate build and paired matrix

```bash
cd public-site
rm -rf dist .astro
PUBLIC_SITE_URL=https://public.example.com \
PUBLIC_OPS_API_ORIGIN=https://api.example.com \
pnpm build
cd ..
python3 review-evidence/visual-parity/capture-parity.py \
  --baseline-url "$BASELINE_URL" \
  --candidate-url "$CANDIDATE_URL" \
  --output /tmp/discoverystack-visual-round-1
python3 review-evidence/visual-parity/compare-parity.py \
  --root /tmp/discoverystack-visual-round-1 \
  --matrix review-evidence/visual-parity/VISUAL_PARITY_MATRIX.tsv \
  --manifest review-evidence/visual-parity/screenshot-sha256.tsv
```

The paired capture emits 48 screenshots and metadata under `/tmp/discoverystack-visual-round-1`; the evidence directory receives only the matrix and SHA-256 manifest. A non-zero compare exit means at least one route is over threshold and must not be waived.

## Baseline stability gate

Capture the baseline against itself five times in fresh output directories. The `candidate-url` may be set equal to `baseline-url`; the stability checker compares only the `baseline-*` files against round 0.

```bash
for round in 0 1 2 3 4; do
  python3 review-evidence/visual-parity/capture-parity.py \
    --baseline-url "$BASELINE_URL" \
    --candidate-url "$BASELINE_URL" \
    --output "/tmp/discoverystack-baseline-round-$round"
done
python3 review-evidence/visual-parity/check-baseline-stability.py \
  --runs \
  /tmp/discoverystack-baseline-round-0 \
  /tmp/discoverystack-baseline-round-1 \
  /tmp/discoverystack-baseline-round-2 \
  /tmp/discoverystack-baseline-round-3 \
  /tmp/discoverystack-baseline-round-4
```

Every baseline comparison against round 0 must be under its route threshold. If the baseline is not stable, the harness is invalid and the candidate matrix cannot be used for a parity decision.

## Candidate three-round gate

After baseline stability passes, run three independent paired candidate rounds. Do not select the best round.

```bash
for round in 1 2 3; do
  python3 review-evidence/visual-parity/capture-parity.py \
    --baseline-url "$BASELINE_URL" \
    --candidate-url "$CANDIDATE_URL" \
    --output "/tmp/discoverystack-candidate-round-$round"
  python3 review-evidence/visual-parity/compare-parity.py \
    --root "/tmp/discoverystack-candidate-round-$round" \
    --matrix "/tmp/candidate-round-$round.tsv" \
    --manifest "/tmp/candidate-round-$round-sha256.tsv"
done
```

Only when all three rounds contain 24/24 passing comparisons may the state be changed to READY FOR REVIEW. This repository does not retain screenshots, browser profiles, logs or build output.

## Final evidence fields

`VISUAL_PARITY_MATRIX.tsv` must contain exactly 24 rows plus its header, with viewport, route, changed ratio, mean channel difference, threshold and pass columns. `screenshot-sha256.tsv` must contain one SHA-256 row for each of the 48 screenshot inputs used for the authoritative matrix. `capture-metadata.json` is retained only in the external round directory and records the capture timestamp, Chromium version, viewport, route set and wait strategy.

Historical attempts may be discussed in an external report, but must be explicitly labeled `HISTORICAL / NOT FINAL` and must never replace the authoritative matrix.

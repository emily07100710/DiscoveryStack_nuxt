# Private Page Evidence Collector Runbook

**Status:** development-only implementation.

**Purpose:** collect private, reproducible page evidence for the second-layer `frictionReasonSignals` task without modifying frozen v4-500 or parent v5-1087.

## Scope

The collector accepts a private JSONL target file with the original `rowId` and `split`, a user-supplied public `url`, an optional `pagePurpose`, and optional versioned `queryContexts`. It writes a private run directory containing an evidence manifest, page text sidecars, desktop/mobile screenshots, safe interaction traces, and Lighthouse JSON reports. The collector never uses login cookies, credentials, OAuth, payment details, form values, or browser storage.

The target template contains all 1,087 original IDs and splits, but its URL fields are intentionally empty because the current v5 derivative has no row-level URL. Empty URLs produce `blocked_missing_url`; they are not inferred from `canonicalDomainHash`, `sourceFamily`, `stageEvidence`, or candidate labels. The collector therefore cannot silently attach the wrong page to a row.

## Target input contract

Each private target line has this shape:

```json
{"rowId":570001,"split":"train","url":"https://public.example/page","pagePurpose":"User-supplied page purpose","queryContexts":[{"queryId":"q-001","queryText":"private query text","intent":"informational"}]}
```

`rowId` and `split` must remain identical to the parent. `url` must be HTTP(S); private, loopback, link-local, reserved, and multicast hosts are blocked by default. `queryText` is kept only in a private sidecar; the public-facing evidence manifest stores a hash and intent metadata. No target file containing URLs or query text may be committed to Git or published to Kaggle.

## Execution

From a Linux environment with Python Playwright, Chromium, and Node/npm available:

```bash
python3 private_page_evidence_collector.py \
  --targets /private/path/page_evidence_targets.jsonl \
  --output-dir /private/path/page_evidence_runs \
  --run-id v5-2-page-evidence-YYYYMMDD \
  --host-delay 2
```

Use `--limit N` for an initial smoke or review batch. Use `--skip-lighthouse` only for browser-only debugging. The default run uses fresh headless browser contexts at 1440×900 desktop and 390×844 mobile. The collector writes incrementally to `evidence_manifest.jsonl`, so a long run can be audited even if a later target fails.

## Collected evidence

For each reachable target, the collector stores the title, meta description, visible headings, full body text with SHA-256, page-purpose signals, CTA candidates, text snippets around pricing/proof/trust terms, visible form structure, console/network error counts, viewport screenshots, body width and horizontal-overflow checks, non-destructive interaction actions, and desktop/mobile Lighthouse performance JSON. CTA, pricing, proof, and trust outputs are evidence candidates only; they do not automatically become `present` or `absent` friction labels.

The interaction trace may inspect controls, scroll, and expand clearly non-transactional disclosure UI. It does not fill fields and stops before submit, payment, booking, checkout, account, quote, order, or other sensitive actions. A form with no completed submission is evidence of observed form structure, not proof that the form has friction.

Lighthouse reports use version-pinned `12.8.2`, desktop preset for desktop, and the default mobile configuration for mobile. Performance scores and metrics are measurement evidence for the recorded URL and run settings; they are not labels until adjudicated against the label definition.

## Fail-closed statuses

| status | meaning |
|---|---|
| `complete` | Both viewport collections completed; Lighthouse may still be independently `failed` or `not_run`. |
| `partial` | At least one viewport completed. |
| `blocked_missing_url` | No valid target URL was provided; all required evidence remains unknown. |
| `blocked_policy` | URL was rejected by the public-host or protocol policy. |
| `failed` | Browser collection could not complete. The error type is recorded without treating failure as a page diagnosis. |

Missing query context keeps `search_intent_mismatch` unknown. Missing measurement keeps `page_speed_gap` unknown. Missing mobile observation, booking trace, or checkout/form trace keeps the corresponding label unknown. A keyword match, missing keyword, CTA count, form count, Lighthouse score, or horizontal-overflow flag is never by itself an adjudicated friction state.

## Governance and artifact rules

All run outputs are private development evidence. Raw page text, screenshots, private query sidecars, URLs, browser storage, cookies, credentials, HTML, source cards, and unreviewed annotation evidence are excluded from model artifacts and Git. The parent v5-1087 JSONL and frozen v4-500 files are read-only. A future v5.2 derivative must preserve parent IDs/splits and record parent hashes plus new derivative hashes.

Before any second-layer training, reviewers must adjudicate each `rowId + label` as `present`, `absent`, or `unknown` with label-specific evidence. The training gate requires, for every label, at least five explicit train positives, five explicit train negatives, two validation positives, and two validation negatives. Unknown and candidate states remain masked out. Test splits remain sealed until validation model selection is complete.

## Smoke evidence

The implementation was smoke-tested against an isolated public documentation domain. Browser output passed the private evidence validator in desktop and mobile viewports; both Lighthouse desktop and mobile reports were produced; interaction trace stopped before sensitive actions. This smoke target is not part of v5 data and must never be merged into the training dataset.

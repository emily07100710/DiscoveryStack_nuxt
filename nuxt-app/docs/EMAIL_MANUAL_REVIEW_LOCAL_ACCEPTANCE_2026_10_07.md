# Email manual investigation closure: local acceptance, 2026-10-07

Status: **LOCAL_CHECKS_PASSED / NOT_RELEASED / EXECUTION_GATED**.

This increment completes a no-resend owner investigation workflow for an owned outbox item in `manual_required`. It is not delivery confirmation, provider configuration, customer fulfilment, model approval or full-platform production acceptance. No production backup/schema change, Git commit/push, Render deployment, flag enablement, real email/LINE message, production publication/crawl or production training was performed by this increment. Deterministic synthetic model fits inside the safe tests are not production training or model deployment. One existing-production owner page was inspected read-only, separately from the synthetic new-feature acceptance.

## Source and evidence provenance

- Checkout: `/Users/emilyyy/Documents/GitHub/DiscoveryStack_nuxt`, branch `main`.
- Base HEAD, not a new release: `8a77bf595b5afd857fed0b63129b8f0688eea32e`.
- Final frozen source: 42 exact source/spec/test/migration files, SHA-256 `4aabdea7a3382e053c41b875ad09d915c12c562abe529ba48deccbab77ce8a27`.
- Final private evidence directory: `/Users/emilyyy/.codex/visualizations/2026/10/05/01a10d75-6003-77a0-975b-7701e90aa374/ds-email-review-local-acceptance-v3-20261007-YG9lPJ`.
- `source-manifest.json` binds every source file. `final-local-acceptance-result.json` verifies the same source across ordered validation, both isolated SQL suites, built-runtime checks and actual-component synthetic UI observations. Directory mode is 0700; evidence files are 0600.
- This prose report and the previous event acceptance report are explicitly excluded from the source freeze. The previous `EMAIL_PROVIDER_EVENTS_LOCAL_ACCEPTANCE_2026_10_07.md` remains historical evidence, not proof of this later revision.

The final aggregate is available at [final-local-acceptance-result.json](/Users/emilyyy/.codex/visualizations/2026/10/05/01a10d75-6003-77a0-975b-7701e90aa374/ds-email-review-local-acceptance-v3-20261007-YG9lPJ/final-local-acceptance-result.json).

## Implemented behavior

- Separate immutable six-column `managedSiteEmailManualReviews` ledger: outbox ID, authenticated owner ID, request ID, reduced outbox version, structured reason and original closure time. One closure per outbox; an owner/request key cannot close a second item.
- Two classifications: investigation reviewed with no resend; or owner-reported handling through another channel, explicitly not independently verified. No free text, address, message, access token, receipt, signature or credential is accepted or stored.
- Exact owner/outbox lookup and real SQL transaction row lock. Only a current `manual_required` snapshot with both lease fields null may create a closure. Same-command replay preserves the original record/time; changed command, request-key reuse, snapshot drift and competing commands fail closed.
- Original outbox values are unchanged, including queue status, attempts, lease fields, message cleanup, accepted timestamp, provider receipt and reconciliation state. Provider complaint/bounce evidence is independent and remains visible.
- POST `/api/managed-sites/email-outbox/manual-resolution` is an explicit action in the existing catchall. It requires canonical private same-origin, compatible Sec-Fetch-Site, owner session, exact JSON fields and a real 2 KiB body bound. GET/OPTIONS cannot mutate. Private cache/robots/referrer boundaries remain.
- Independent `NUXT_MANAGED_SITE_EMAIL_REVIEW_ENABLED=false` default. Disabled owner GET does not query the unapplied review table. Disabled mutations stop before body/storage work after origin/session checks. No send, Resend API, LINE, publication, crawl or training authority is added.
- Owner GET retains its 50-item scope and explicit projection. New closure projection excludes owner ID, request ID, internal record version and private message/provider material.
- Actual page separates queue status, provider observations and owner investigation. Refresh/open/cancel do not write. The no-resend checkbox starts unchecked; explicit submission alone appends a record. Uncertain retry keeps the same command key. Busy controls stop duplicate clicks; conflicts and read failures do not claim a successful new operation.
- Opening the inserted form now centers it and focuses its labelled form after Vue's render tick, including mobile. This change performs no request and does not auto-confirm the checkbox.

Contract: [MANAGED_SITE_EMAIL_REVIEW_V1.md](../MANAGED_SITE_EMAIL_REVIEW_V1.md).

## Executed final checks

Validation used installed dependencies and a whitelisted execution environment, without inheriting formal credentials or `DATABASE_URL`. Real provider/payment/learning execution gates stayed off. There was no dependency installation or change.

| Check | Executed result | Boundary |
| --- | --- | --- |
| Nuxt typecheck | Exit 0; 17.879 s | Installed local tooling, explicit empty dotenv path |
| Fresh node-server build, after typecheck | Exit 0; 21.585 s | Build only, not deployment |
| Full safe Vitest, after fresh build | 5,964 passed, 0 failed, 56 skipped, 0 todo; 257.386 s | 325 passing files, 18 skipped files; no real provider evidence |
| Isolated manual-review MySQL integration | 10 passed, 0 failed, 0 skipped | Disposable local MySQL 8.4.11, no formal data |
| Isolated provider-event MySQL integration, same final source | 7 passed, 0 failed, 0 skipped | Separate disposable local MySQL 8.4.11, no Resend calls |
| Fresh built Node runtime, anonymous HTTP checks | 13 passed, 0 failed | Loopback only, no credentials or formal database |
| Actual page/layout/state/client synthetic browser acceptance | 13 recorded observations | Desktop 1280x900; mobile 390x844; memory-only fake I/O |
| Existing-production owner page | Read-only page loads; 0 visible queue rows; no alert | Existing release only; not new 0048/0049 acceptance |
| Final source recheck and `git diff --check` | Passed | No commit or push |

The full safe suite deliberately skips opt-in tests. Its 56 skipped tests include the 17 email-event/manual-review MySQL cases that were executed separately in the two isolated rehearsals; those cases remain skipped in the full report and are not double-counted as full-suite passes. Other skipped checks include credential/provider, formal database, deployment, ownership, payment, measurement and additional opt-in SQL environments. They are not production passes.

Final report hashes:

- Full Vitest JSON: `4fc3ff34232a6ac4891464f01a48d1418e0b0636bfb16eb2248a8b253c139e53`.
- Review MySQL JSON: `58ecd3ea1602624b148adf89dc23a9bcb1929da56178b528fb62cdc232e8f887`.
- Provider-event MySQL JSON: `8290cb6618c581b419e4f24fe970f971a4a4af3af1e62b72575d0f834d660cab`.

### Real isolated SQL coverage

The ten manual-review cases verify actual column/index/precision metadata; null-project owner closure and replay; foreign/null-owner/missing equivalence; every nonmanual status and each occupied lease field; immutable collisions; concurrent same-command/distinct-command/global-key winners; snapshot drift and malformed-command zero-insert behavior; rollback after an actual INSERT; a real observed lock wait followed by snapshot drift and zero closure; and bounded owner-only joined projection. Full outbox before/after values remain equal where closure is recorded or rejected.

The lock-wait test observes Performance Schema's requesting lock joined to the exact database/table, rather than assuming a lock from a fixed delay or prepared-statement text. Relevant primary references: [MySQL data_lock_waits](https://dev.mysql.com/doc/refman/8.4/en/performance-schema-data-lock-waits-table.html) and [MySQL data_locks](https://dev.mysql.com/doc/refman/8.4/en/performance-schema-data-locks-table.html).

Both containers used an already-local image, `--pull=never`, random loopback ports, bounded resources and exact ownership labels. Both were removed and absence verified. No formal rows, credentials or backups entered them.

### Built-runtime HTTP boundary

The 13 checks verify default-off Resend webhook normal/oversized POST returns 503; webhook GET/OPTIONS returns 405; unsupported catchall action returns 404; anonymous/spoofed-owner list returns 401; public or absent Origin cannot close a review (403); canonical-origin anonymous normal/oversized review bodies remain unauthorised (401); and manual GET/OPTIONS returns 405. No public CORS is granted; recognised routes retain private no-store/noindex headers. Unsupported action uses the existing gateway's `no-cache` 404 boundary, not an invented private success envelope. Synthetic body canaries are not reflected.

This runtime test does not mint an owner session or append a review. Authenticated/default-off, strict input and mutation semantics are verified independently by the H3/unit and real isolated SQL cases. The owned runtime was stopped.

### Actual rendered synthetic UI acceptance

The preview compiled the real email page, owner layout, async state component and browser review client. It replaced only framework I/O with memory fixtures; it did not replace the form/control logic. CSP `connect-src 'none'` prevented API connections. It is not a full Nuxt routing/session/production-browser rehearsal.

Observed: mobile form enters the viewport and receives focus; checkbox unchecked and submit disabled; mobile cancel leaves 0 commands/records; desktop refresh/open remains read-only; explicit confirmation produces 1 command/1 record and preserves adverse provider facts; an uncertain first response shows unknown outcome; unchanged retry produces 2 commands/1 record/1 replay with the same key; 409 makes no record and claims no success; refreshed snapshot drift disables the stale draft; pending controls and fields are all disabled; completion produces one record; flag-off has no form/write action; empty queue is not a delivery-success claim; and failed read is not fabricated as successful empty data. Every observation records synthetic send/publication/training counters at zero. These counters describe the fixture, not a provider billing audit.

Screenshots: [desktop form](/Users/emilyyy/.codex/visualizations/2026/10/05/01a10d75-6003-77a0-975b-7701e90aa374/ds-email-review-local-acceptance-v3-20261007-YG9lPJ/desktop-review-form.png), [mobile form](/Users/emilyyy/.codex/visualizations/2026/10/05/01a10d75-6003-77a0-975b-7701e90aa374/ds-email-review-local-acceptance-v3-20261007-YG9lPJ/mobile-review-form.png). The owned preview process and tab were closed, viewport override reset, and user-owned tabs retained.

### Separate existing-production owner read

At `2026-10-07T14:37:12.945Z`, the authenticated user tab navigated through its existing “郵件紀錄” link and displayed the live page without a login form or error alert. It showed an empty queue and “郵件設定：尚未完整設定 / 自動寄送：關閉中”. No form/mutation was submitted. The tab was returned to its original `/audit-lab` URL.

This confirms the existing owner page's rendered read path. It does not confirm new schema, new UI, a Resend sender/domain, actual delivery, or the latest local build being deployed. Only reduced status/boolean metadata was saved, not session secrets or customer rows.

## Failures preserved and corrections actually reverified

- First frozen attempt (`ds-email-review-local-acceptance-20261007-7zsE4V`): typecheck failed due to Nitro route-union depth at direct `$fetch`, plus strict migration-test index narrowing and tuple-index types. Bound the single review writer with a literal typed contract, preserving unknown-response validation; added explicit type guards/tuple types. No typecheck was disabled.
- That attempt's real review SQL run: 8 passed, 2 failed. Corrected metadata aliases and replaced unreliable `innodb_trx.trx_query` lock detection with actual Performance Schema wait observation. All assertions about six columns, locks, rollback, drift and unchanged outbox values remain. Failed reports/logs were preserved; temporary container cleanup was verified.
- Second frozen attempt (`ds-email-review-local-acceptance-v2-20261007-5WEBHW`): typecheck/build and 10 SQL cases passed, but full suite reported 5 failed / 5,950 passed / 65 skipped and 4 unhandled errors. Its route listeners hit `listen EPERM: operation not permitted 127.0.0.1` in the sandbox; this was not recorded as a pass. Final full-suite execution permitted only the needed local listener capability while keeping credentials absent and external execution flags off. No failing test was deleted or skipped to obtain the final pass.
- Second attempt's actual mobile UI exposed the inserted form outside the viewport: top -667.93, bottom -247.87 at a scroll position of 1886. Kept the observation and screenshot. Added render-tick form scroll/focus, froze the new 42-file source, and repeated ordered validation, SQL, HTTP and browser acceptance. Final mobile form: top 212.07, bottom 632.13 in 390x844, focused FORM; document width 390. Final desktop form also fits and starts unconfirmed.
- One readback automation locator used an unsupported heading-level filter after returning from the production read. It was corrected with a read-only H1 DOM check; the original audit-lab URL and heading were confirmed. This was an automation ambiguity, not a production page failure or application write.

Build output also retains existing stale browser-compatibility-data warnings; H3 logs retain the `statusMessage` advisory. Neither warning was hidden, and no dependency update was attempted in this scope.

## Pending release authority and remaining real-world boundaries

Separate additive migrations, generated locally without a DB connection:

| Migration | Exact pending DDL | SHA-256 |
| --- | --- | --- |
| 0048 | Provider-event table, two event indexes, one index on the existing outbox | `bd687006de112d142e59b6e5a7b88d3a9568ef160a95528ebc0e0212676e3027` |
| 0049 | Six-column review table with inline owner/request uniqueness, owner/time/outbox index | `01967d3f66dfc060d9ce658e184587150f32d70c425e31d74f5e6dcbae187218` |

0048 is unchanged from the previous increment. 0049 does not modify existing outbox columns or records. Neither migration was applied to production by this turn.

Before a release, obtain consolidated authority for: 0-new-cost private local production backup; restoration into an owned disposable local database; exact approved 0048 and 0049 application after fresh drift/preflight checks; scoped commit and non-force pushes to the existing `origin/main` and `tendertech-backup/main`; deployment to the existing Render Free service; and read-only owner/runtime acceptance. Stop if the operation introduces a paid resource, upgrade, unexpected DDL/data drift or new authority. Keep send/event/manual-review/crawl/publication/training gates disabled in that release unless separately explicitly approved; a deployment must not silently enable operations.

Still **NOT_RUN / GATED** for this increment: official schema/backup/restore/deployment acceptance, real Resend domain/sender/webhook and signed callback, actual inbox receipt, actual owner closure on production, LINE approval-to-publication real-service journey, authorised real measurement/training datasets and provider execution, and reliable unattended scheduling beyond the current hosting constraints. Event/review retention policy and safe replay tombstones require an explicit policy decision before material evidence deletion; no arbitrary purge was added. Customer-site generation/deployment automation and registrar/reseller work remain deferred.

The broad platform/ML closed-loop goal is not marked complete by these local checks.

# Measurement Collection & Outcome Automation V1

## Scope

Measurement Collection V1 is an owner-scoped, receipt-gated layer for collecting bounded aggregate observations after a publication has been delivered. It adds only three durable tables, two Google read-only adapters, a reuse path for the existing LLM visibility provider-observation runtime, a bounded Nitro task, private API routes, and one owner workbench page.

The layer does not replace Content Operations, the Outcome engine, the LLM visibility engine, the Audit Lab, the public website, or the existing database tables. It invokes `recordOwnerOutcomeAssessment()` for every primary-source assessment attempt and passes `learningCandidate: false`; it never creates a model-improvement candidate or submits a training job.

## Durable model

| Table | Purpose | Write policy |
| --- | --- | --- |
| `contentOperationMeasurementConnections` | Versioned owner/client/website/source configuration, optional publication-target binding, canonical origin, allowed page scope, opaque credential reference, provider target metadata, timezone, and availability lag | Owner-only create, pause, and revoke. Revocation releases the live website/source slot without rewriting historical rows, so a replacement can be created safely. Tokens and headers are rejected and never persisted. |
| `contentOperationMeasurementRuns` | One source/checkpoint publication-lineage request with lease, retry, due time, idempotency, and receipt/content/evidence hashes | Queued and claimed with a short lease; terminal states are `succeeded`, `insufficient_data`, `blocked`, `failed`, or `cancelled`. |
| `contentOperationMeasurementSnapshots` | Append-only normalized baseline/follow-up aggregate observations | Insert-only. There is no update or delete helper. Unique run/phase and owner/source-hash constraints prevent replay duplication. |

The migration is generated as `server/database/migrations/0020_goofy_dazzler.sql`. It is provisional and is not applied by this implementation.

## Checkpoints and windows

The only supported checkpoints are **7, 15, 30, 60, and 90 days**. Windows are half-open in the conceptual model and have equal exact durations: baseline starts exactly one checkpoint duration before the target's verified delivery instant, baseline ends at that instant, and follow-up begins there and ends exactly one checkpoint duration later. Provider date-only APIs receive a bounded local date range derived from the configured timezone, so their day-granularity remains an explicit source limitation. Availability lag is stored per connection and is applied to `dueAt`.

Before a run executes, the server re-resolves every bound target's delivered publication and compares target, canonical page, publication receipt fingerprint, content hash, and evidence snapshot hash. Each delivered target receives its own runs, windows, snapshots, and target-bound Outcome record. A non-terminal run with changed lineage is blocked as `STALE_PUBLICATION_LINEAGE`. A previously succeeded historical run is retained as historical evidence and is not rewritten.

## Source behavior

Google Search Console calls the fixed Search Analytics query endpoint with the configured readonly scope, URL-prefix or `sc-domain:` property, exact `page` equality filter, bounded `rowLimit`, and only aggregate `impressions`, `clicks`, and weighted `averagePosition`. Empty rows become `insufficient_data`; authorization failures become `blocked`; rate limits and 5xx responses become bounded retry states. GA4 calls the fixed Data API `runReport` endpoint with a numeric property ID, exact `pageLocation` filter, and only `sessions` and `engagedSessions`. Visitor identifiers, raw events, extra dimensions, and extra metrics are rejected. Sampling, thresholding, row-loss, and schema restrictions are surfaced as limitations.

The actual Google OAuth resolver is intentionally an injected server seam. The default resolver returns no credential, so this V1 does not claim a live Google connection. The API accepts only an opaque `credentialReference`; strict schemas reject raw access tokens, bearer headers, and arbitrary provider-target keys.

LLM visibility reuses the existing `runOwnerProviderObservation()` runtime. It does not invent a second probe engine. Result snapshots contain only aggregate query/mention/citation counts and explicitly record `observationMode: provider_api_observation`, `verifiedByOwner: false`, `metricEligibility: secondary_only`, and `consumerSurfaceEquivalent: false`. These snapshots are excluded from the primary Outcome payload; owner-verified manual observations remain the route to primary visibility evidence.

## Owner API

| Route | Behavior |
| --- | --- |
| `GET /api/measurement-collection/workspace` | Returns owner-scoped clients, connections, runs, snapshots, checkpoint states, capabilities, and limitations. Credential references are masked. |
| `POST /api/measurement-collection/connections` | Validates and creates an owner/client/source connection idempotently. |
| `POST /api/measurement-collection/connections/:id/pause` | Stops new scheduling for a connection while preserving history. |
| `POST /api/measurement-collection/connections/:id/revoke` | Revokes a connection while preserving history. |
| `POST /api/measurement-collection/entries/:id/schedule` | Re-resolves all bound delivered receipts and schedules all five checkpoints for each target's active in-scope connections. |
| `POST /api/measurement-collection/runs/:id/dry-run` | Returns planned windows and request metadata without resolving credentials or calling providers. |
| `POST /api/measurement-collection/runs/:id/retry` | Requeues a non-terminal failed/blocked/insufficient run only when its retry budget remains. |

All routes require the existing owner session, derive the database owner from the authenticated identity, emit `no-store` and `noindex` headers, and return sanitized status messages. There is no public route.

## Scheduler

`content-operations:measurement-tick` resolves the controlled owner, schedules eligible delivered entries, then claims at most 50 due/retry/expired-lease runs. Lease acquisition is conditional on owner, run state, retry time or due time, and expired lease. Retryable failures use a short exponential backoff and stop after three attempts. The task is explicit; merely importing or building the Nitro application does not execute it.

## UI semantics

`/audit-lab/measurement-operations` is available only inside the existing owner layout and is linked once from the owner navigation. It contains a client/site selector, connection readiness, checkpoint/run states, dry-run action, lineage hashes, snapshot provenance, empty/loading/error states, and limitation copy. It does not display fabricated KPI cards or claim live provider validation. `NOT RUN`, `NONE`, `尚未連接`, `資料不足`, `secondary-only`, and `manual verified` are deliberate truthful states.

## Verification

Use the following commands from `nuxt-app`:

```bash
pnpm install --frozen-lockfile
pnpm typecheck
pnpm db:generate
pnpm exec vitest run tests/measurement-collection-adapters.test.ts tests/measurement-collection-scheduler.test.ts tests/measurement-collection-outcome.test.ts
pnpm test
pnpm build
```

The tests use mocked fetchers and synthetic repository seams. They do not claim production credentials, customer-site connectivity, or provider quota validation.

## 2026-10-08：網站確認交接（本機實作）

量測 lineage 分為 `formal_delivered` 與 `site_publication_confirmation`，不合成已交付 attempt/run。後者必須有 owner 明確且仍符合目前授權的獨立確認，逐 target／public version／confirmation fingerprint 配對 active connection 與 exact allowed page scope。

Dry-run 與建立 7／15／30／60／90 天佇列只讀取已確認的歷史身份和目前本機權威，不查網站、不解析 credentials、不呼叫成效 provider。啟用後的 bounded tick 才處理已明確確認的 `awaiting_site_review` entries；只有原始 matching observation 不會自動 opt-in。網站狀態查核並非監控服務或準時 worker 的證明。

實際處理前、每次 provider 呼叫前／回應後及 snapshot 寫入前，重新核對網站簽章公開版本、目前 consent/review/source、connection owner/status/configuration/page。公開版本、日期、時區、client 或 connection 設定漂移會 blocked；失敗不以舊確認替代。先前合法 phase snapshot 可保留為歷史，不宣稱整個 run 是跨 provider／資料庫原子交易。已撤銷或暫停的 connection 不被成功或重新授權回應恢復為 configured。

網站確認 outcome 使用獨立 aggregate writer，保存 explicit evidence kind、target、confirmation fingerprint、`runId: null`、`learningCandidate: false`，並在寫入交易內重核 cached authority。它不呼叫正式 delivery outcome／intervention／learning bridge，亦排除於 owner content learning dataset；LINE 逐篇發布同意不是 model improvement 同意。GSC／GA4 aggregate 可供觀察；provider API LLM observations 仍為 secondary-only，不冒稱真實消費者搜尋結果或因果效果。

本輪沒有 DB migration、正式 provider credentials、收數、背景啟用、部署或訓練；只支援完整單一網站人工審稿的原身份，routing／machine 接入需另行完成精確歷史權威。正式運作仍須 Google 權限、來源 connection、Do status receiver 與獨立 worker 範圍驗收。

## 2026-10-08：收數時的模型用途證據

網站確認 collector 新增伺服器授權 resolver：每個 phase 在供應商呼叫前後都重新核對完整十一欄用途證據，相符且 capture／expiry／retention 合格才保存最小 marker。供應商回應自帶的 marker 先剝除，不可冒充授權。注入本機測試 repository 時若缺少 resolver，不會連正式資料庫。

assessment 只在所有 baseline／follow-up 快照與目前授權完整一致時保存同一 marker；交易前及交易內重查。中途撤銷只保留營運觀察，不生成學習准入證據。原本未知 consent、`runId: null`、`learningCandidate: false` 不變；獨立審查與候選摘要詳見 [准入契約](../SITE_LEARNING_ADMISSION_V1.md)。

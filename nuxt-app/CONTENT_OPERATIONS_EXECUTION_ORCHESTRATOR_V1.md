# Content Operations Execution Orchestrator V1

## 判定範圍

Content Operations Execution Orchestrator V1 將既有 Content Calendar、Content Operations Runtime、SEO/GEO Production Deliverable、First-party Astro/Nuxt Publisher 與 Outcome Learning 接成一條 **owner-only、可恢復、可追蹤** 的執行流程。這一版的設計是「自動生成 → 等待真正存在的人工核准 → 核准後由明確 execution request 或 bounded scheduler 執行發布」，而不是無人審核流程。

系統不會建立假的 reviewer、假造 `approved_for_delivery` review、跳過 risk gate，也不會把 system decision 寫成人工 decision。沒有真正且 owner-scoped 的 `approved_for_delivery` review 時，entry 會停在 `awaiting_review`。`approved_for_preview`、`changes_requested`、`rejected` 與 blocked risk gate 都不能直接造成發布。

## Runtime stages

| Stage | Durable state | Orchestrator 行為 | 不允許的行為 |
|---|---|---|---|
| Materialization | `planned` → `materialized` | 重用既有 calendar materialization 與 entry/run/event persistence。 | 不建立 provider draft，不建立人工 review。 |
| Generation | `materialized` / `awaiting_generation` | 只呼叫指定 `planId`/`deliverableId` 的 single-deliverable runner，保存 job、base/optimized draft、content hash 與 risk gate。 | 不執行同一 Production Plan 的其他 deliverables。 |
| Review synchronization | `awaiting_review` → `ready_to_publish` | 只查詢 authoritative owner review，要求同 job、optimized draft、evidence hash 與 passed risk gate。 | 不呼叫 review creation，不生成 reviewerUserId，不自行核准。 |
| Publication | `ready_to_publish` / `publishing` → `delivered` | 重新驗證 target、identity、review、risk gate、draft hash，透過既有 First-party Publisher dry-run 或 execute。 | 不繞過 target guard，不把 dry-run 寫成 delivered。 |
| Outcome handoff | `delivered` → existing outcome workflow | 保留既有 Outcome Learning engine 與資料契約。 | 不製造排名、流量、轉換、ROI 或因果成效。 |

每個 stage 具有 durable run 與 lease。worker 只在 queued、到期 retry wait 或已過期 processing lease 上進行 conditional claim；active lease 不可被其他 worker 搶占。execution tick 的 batch 上限為 50，單筆 exception 會被轉為 bounded redacted result，不中斷其他 eligible runs。

## Single deliverable generation

Orchestrator 使用既有 SEO/GEO `runOwnerProductionDeliverable` public entry，而不是完整 Production Plan runner。該入口保留 owner、plan、deliverable、strategy lineage、evidence snapshot 與 production job idempotency binding，並使用既有 production runtime provider resolver。base draft 與 selected-rule optimization 的 provenance 會保存 provider mode、fallback reason、selected rule IDs、applied rule IDs、brief、evidence snapshot 與 parent draft lineage。

因此，`provider_candidate`、`reference_fallback`、deterministic scaffold 與 selected-rule optimization 的實際模式仍可由 durable provenance 追溯。沒有合適的 provider 或 artifact 時，系統必須保留 bounded fallback 或 blocked/needs-review 狀態，不得把 fallback 描述成外部模型預測。

## Review synchronization

Review synchronization 只接受真正持久化且仍有效的 owner review。系統要求 review 的 owner、job、optimized draft、evidence snapshot 與決策都與現行 lineage 一致，並重新確認 exact passed risk gate。沒有 review 時，review-wait run 維持等待；`approved_for_preview` 不足以發布；`changes_requested` 不會重用舊 draft；`rejected` 或 blocked gate 會將 entry 阻擋。

當第一次觀察到合法 `approved_for_delivery` 時，orchestrator 只將 entry 推進至 `ready_to_publish` 並完成 review synchronization。發布必須由後續明確 execution request 或 eligible publication run 執行，避免 review sync request 意外產生外部副作用。

## Publication target 與 identity

`contentOperationPublicationTargets` 是 owner-scoped 的 target registry。target 必須與 client 的 framework 與 publication transport 一致，transport 只允許 `first_party_git` 或 `first_party_signed_api`。每個 owner/client 同時最多一個 active target；owner/idempotency key 與 owner/target ID 具唯一性。browser 只能提交允許的 configuration input，owner scope、target ID、configuration fingerprint、status 與 identity 都由 server 解析或產生。

workspace 只回傳 `credentialConfigured: boolean`，不回傳完整 `credentialReference`。本 V1 不提供真實 connection test；`executionEnabled` 只表示 target gate 已開啟，不表示 credentials 有效或網站已成功寫入。啟用 execution 的 workbench 警告為：

> 開啟後，通過正式 delivery approval 的內容可由 scheduler 發布到第一方網站；本 branch 不進行真實 connection test。

publication identity 由純 deterministic helper 建立，並沿用正式 publisher/artifact path mapping：article 使用 `articles`、FAQ 使用 `faq`、service page 使用 `services`。title normalization 使用 NFKD、combining mark removal、ASCII slug normalization 與 entry-stable suffix；同一 entry 的 persisted identity 一旦建立，retry 或 draft revision 不會自行改變 slug、path 或 identity fingerprint。identity fingerprint 不包含 credential 或 secret。

## Publication attempts 與 retry

`contentOperationPublicationAttempts` 是 append-only ledger。每次 execute 或 retry 都建立新 row，保存 attempt number、mode、input fingerprint、publication identity、content/evidence hash、artifact fingerprint、remote state/revision 與 bounded error summary。相同 owner/idempotency key 必須使用相同 input fingerprint；不同 entry、mode、identity 或 hash 會 fail closed。

retry policy 不會 sleep。第一次 retryable failure 的下一次 eligible time 為五分鐘後，第二次為三十分鐘後，第三次失敗則進入 failed。401、403、identity mismatch、collision 與 invalid credential 不重試；429、timeout、network failure 與 5xx 依既有 publisher classification 進入 bounded retry。retry 保持相同 publication identity，且不得重新產生 URL。

## API 與 task boundary

Owner execution endpoint 為 `POST /api/content-operations/entries/:id/execute`。target 設定 endpoint 為 `POST /api/content-operations/clients/:id/publication-target`。兩者都使用 `requireOwner`，ownerUserId 僅從 session/database mapping 取得，client 不可提交 job、draft、review、risk gate、target、content hash 或 owner scope。route 不執行 generic HTTP、WordPress、crawler、scraping 或真實 provider request。

Nitro task 名稱為 `content-operations:execution-tick`。task 只在明確 task invocation 時執行；module import 與 build 不會啟動 runner。task 使用 owner-controlled identity，最多處理 50 筆 owner-scoped eligible runs，並使用 durable lease 與 redacted bounded result。measurement 與 learning 不在此 tick 自動執行。

## Transaction 與 distributed write boundary

entry、run、event、review binding、publication attempt 與 durable identity 的狀態變更必須使用既有 repository transaction 或具等效 conditional update。若外部 publisher response 已經成功，但後續 DB transaction 失敗，系統不宣稱可以消除 distributed write boundary；正式 publisher 的 publication identity、remote idempotency 與 append-only attempt ledger 會讓後續 retry 能夠安全 replay。這是 V1 的明確限制，不是「exactly once」的未驗證承諾。

## 驗證與限制

本 branch 的 tests 使用 synthetic repository、mocked production deliverable runner、mocked publication executor 與 route/workbench source contracts；不會呼叫真實 LLM/provider、GitHub Contents、signed API 或 customer site。Production build 只驗證 compile/prerender contract，不代表 credentials、external publisher endpoint 或 customer site 已驗證。

Migration 僅由既有 Drizzle generate workflow 產生，內容必須是 DDL-only；本 branch 不執行 migration、不套用 production database、不 deploy，也不建立或合併 PR。Full Vitest 依任務要求不執行，因既有 suite 包含需要外部 credentials 或 production origin environment 的測試。`READY FOR REVIEW` 不表示已合併或部署。

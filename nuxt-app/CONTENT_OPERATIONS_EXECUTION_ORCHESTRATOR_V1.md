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

Nitro task 名稱為 `content-operations:execution-tick`。此 task 已註冊於 Nitro 排程，每五分鐘觸發 task；預設立即回 `disabled`；`CONTENT_OPERATIONS_EXECUTION_CRON` 可在 build 時覆寫。module import 與 build 不會啟動 runner。內容 materialization task `content-operations:tick` 另以預設每十五分鐘觸發 task，未明確啟用時也立即回 `disabled`（`CONTENT_OPERATIONS_CRON`），與現有 ModelOps 等相同時段工作累加，不覆寫。task 使用 owner-controlled identity，最多處理 50 筆 owner-scoped eligible runs，並使用 durable lease 與 redacted bounded result。measurement 與 learning 不在此 tick 自動執行。

### 2026-10-08：草稿收到與正式發布分流

Next.js signed API 的可信 `draft_received` 結果會在同一 transaction 保存 immutable attempt 的九欄回執與 checksum、entry `awaiting_site_review`、succeeded publication run，以及執行中的 machine authorization `draft_received`。既有客戶同意／owner review 不會被改寫成老師核准或撤銷。已消耗的草稿 authorization 不能重新變成 authorized／executing／published；仍可由明確撤銷流程標記 revoked。

收到草稿後，owner manual／scheduler／相同或新 idempotency key 均不自動再送；workspace 顯示歷史回執與等待網站審核，不提供重送按鈕。多 target 以獨立回執跳過已收稿／已發布的 route，只重試未解決的 retryable route。只要仍有 draft-only route，aggregate 絕不視為全部 delivered。

Calendar 的 delimiter schedule key 在 first-party 邊界轉為 deterministic owner/entry-bound opaque schedule ID。V4 的 raw authorization fingerprint 只保留於 durable authority／reservation lineage；wire publication reviewId 映射為 `ref-autopilot-v4-<fingerprint>`，不放寬 publisher 的 governed authority 格式。Next.js signed command 的 artifact timestamp 固定為第一筆 exact execute attempt 的 startedAt；重試使用新 HMAC timestamp／nonce，但保持同一 artifact fingerprint 與 remote command idempotency key，支援 response 遺失或 finalization rollback 後的安全 replay。此回復測試使用 owner-approved 路徑；V4 已 claimed 執行中 authorization 遇 DB rollback 的自動復原仍未驗收，不推定可重新授權。

草稿不產生 delivered event、public URL、remote revision、learning snapshot、measurement handoff 或 live-before capture。網站老師實際核准／發布及新的可信 publication receipt，屬於下一個獨立、尚未實作驗收的流程；歷史入稿回執不能推定目前文章狀態。

## Transaction 與 distributed write boundary

### 2026-10-08：網站發布觀察與入稿 ledger 分開

owner-only `POST /api/content-operations/entries/:id/site-publication-check` 接受精確 `targetRowId` 與 idempotency key，驗 owner、exact origin 與 512-byte 本文後，從 owner/client/calendar/entry/target/binding/attempt 重新解析原始收稿身分。對網站固定唯讀狀態路徑的可信簽章回應，在 transaction 內重查 context，再追加 `site_publication_observed` event。重播回原檢查時間，不重新連線、不把歷史觀察標成最新狀態；不同 context 重用同 key 拒絕。

事件綁定原草稿回執、exact target configuration／bindings、request key hash、回應 hash、觀察與 checksum；不存文章本文、teacher 身分或 secret。每 entry 以 501 sentinel 防止將超過 500 筆觀察的截斷歷史視為完整。工作台取最新 observation timestamp，不讓較舊高版本掩蓋網站回滾／未公開的新觀察；目前 context 不符或 metadata checksum 損毀時不投影為可信發布。

這是獨立發布觀察，不改原 `draft_received` attempt、消耗完的 machine authorization、run 或 `awaiting_site_review` 工作流程。即使 exact matching public snapshot 也不由本查詢直接產生 delivered event、learning snapshot、measurement handoff 或模型訓練；下一段還須將此證據安全接入原有 publication／measurement resolver、處理撤下文章與同意撤銷。網站修改過的公開內容不得沿用舊 DS／客戶核准。本段沒有新增 DS migration 或自動排程。

entry、run、event、review binding、publication attempt 與 durable identity 的狀態變更必須使用既有 repository transaction 或具等效 conditional update。若外部 publisher response 已經成功，但後續 DB transaction 失敗，系統不宣稱可以消除 distributed write boundary；正式 publisher 的 publication identity、remote idempotency 與 append-only attempt ledger 會讓後續 retry 能夠安全 replay。這是 V1 的明確限制，不是「exactly once」的未驗證承諾。

## 驗證與限制

本 branch 的 tests 使用 synthetic repository、mocked production deliverable runner、mocked publication executor 與 route/workbench source contracts；不會呼叫真實 LLM/provider、GitHub Contents、signed API 或 customer site。Production build 只驗證 compile/prerender contract，不代表 credentials、external publisher endpoint 或 customer site 已驗證。

Migration 僅由既有 Drizzle generate workflow 產生，內容必須是 DDL-only；本 branch 不執行 migration、不套用 production database、不 deploy，也不建立或合併 PR。Full Vitest 依任務要求不執行，因既有 suite 包含需要外部 credentials 或 production origin environment 的測試。`READY FOR REVIEW` 不表示已合併或部署。


## Repair hardening notes

本輪退修將正式 execute attempt 與 dry-run ledger 序號分離。只有取得同一 publication run lease 的 execute reservation 才會原子增加 `run.attemptNumber`、先建立 `planned` attempt 並把 entry claim 為 `publishing`；dry-run 只建立自己的 append-only result、保持 publication run `queued`，不建立 `retry_wait`。scheduler 使用 `scheduler:publication:<runId>:attempt:<executeAttemptNumber>`，最多執行三次正式 attempt；planned row 可在 lease 到期後以相同 publication identity 恢復，terminal row 則不可改寫。

Publication 前會重新解析 owner/job/draft/evidence 綁定的最新 review 與最新 risk gate；`entry.reviewId` 只是同步 reference。較新的 `changes_requested` 會清除舊 review reference、取消尚未完成的 publication run 並回到 `awaiting_review`；`rejected`、`approved_for_preview`、malformed decision 或非 passed 最新 gate 都 fail closed。若 job 出現較新的 optimized draft，review-wait 會重新綁定 draft/content hash、建立新的 review run，不會自動核准。`createContentReview` 在 transaction 內禁止同一 draft 已有 durable planned publication attempt 時新增負向 review。

Target execution 會重算 persisted publication identity 的正式 artifact path 與 fingerprint，並要求 `publication-<entryId>`、目前 target row、origin、root、content type、language、slug/path 全部一致。active target 由 nullable `activeSlot=1` 與 owner/client/slot unique index 序列化；paused 可釋放後再啟用，revoked 為 terminal。configuration fingerprint 包含 normalized credential-reference SHA-256 及 canonical sorted allowlists，但不包含 raw reference 或 credential value。

Owner execute API 與明確 Nitro task invocation 會使用 server-only credential registry、CSPRNG nonce 與 AbortController-based bounded fetch；沒有可用 registry 時 execute fail closed，dry-run 仍可完成。runtime capability 的 `runtimeCredentialResolverAvailable` 只表示 parser/registry 可用，不代表指定 credential reference 有效；`credentialConfigured` 只表示 server-side reference 存在。測試中的 publisher、fetch、credential 與 nonce 均為 mock 或 synthetic，不能作為 production credential/site connectivity 證據。

正式 execute reservation 會與 owner review、risk-gate transaction 共用 content job row lock，並在 planned ledger 寫入前重新核對最新 `approved_for_delivery` review ID 與最新 passed risk-gate ID。這避免負面 review、risk-gate replacement 與 publication reservation 的 TOCTOU 競爭；已有 execute attempt 的 immutable draft 不可再追加替代 risk gate。若 review、gate、job 或 ledger identity 在 preflight 後改變，reservation 會在任何外部 request 前 fail closed。Dry-run 與 target duplicate replay 也會逐欄核對 owner/client/entry/run/target/input identity，不接受不同資源共用 idempotency key。

Bounded fetch 會先檢查可信的 bounded `content-length`，並以 stream reader 逐 chunk 累計 UTF-8 bytes；一旦超過 policy limit 立即 abort，不會先把任意大小的 response body 完整載入記憶體。

本輪 migration 為 `0016_brief_morg.sql`，只由 Drizzle workflow 產生 activeSlot 欄位與 unique index DDL，未執行 migration runtime validation，未套用 production migration。Full Vitest 依任務要求 NOT RUN；production build 只代表 compile/prerender 可通過，不代表已部署或已對客戶網站寫入。


## 排程啟用與上線邊界（2026-10-04）

`content-operations:tick` 與 `content-operations:execution-tick` 可以已註冊 cron，但預設不執行。兩者必須在伺服器環境明確設定 `NUXT_CONTENT_OPERATIONS_SCHEDULER_ENABLED=true` 才開始；未設定、`false`、其他字串或 task payload 均不會啟用，並在 config／owner lookup／資料庫／runtime dependencies／provider 前回傳 `disabled` 與 `processed: 0`。開關是 server-only，沒有公開 runtimeConfig、API key 或可由客戶修改的 authority。

啟用後仍由伺服器 `OWNER_OPEN_ID` 決定 owner；每次最多 materialize 50 entries 或處理 50 runs，沿用原先 owner/client/target 範圍、證據、審核、風險、租約、指紋及 policy generation/publication budgets。50 是工作筆數限制，並非美元費用上限；启用前須另外核准既有工作與供應商費用。此開關只限制這兩個背景 task，不阻擋 owner 明確手動 API。既有 measurement／ModelOps 等其他 task 的啟用契約不變。

工作台以 `capabilities.schedulerAvailable` 表示已註冊能力，以 owner-private `readiness.schedulerEnabled` 表示這兩個內容背景 task 的啟用設定。任一布林都不能證明 Render 長時間執行、供應商連線或真實客戶發布已驗收。新程式部署的核准不自動包含變更此開關、執行 migration 0043 或對客戶網站寫入。

## 2026-10-08：網站發布確認的獨立成效交接

`site-measurement.ts` 把目前人工核准原稿與可信網站公開快照綁定，再保存 owner 明確接入成效觀察的獨立事件。原 `draft_received` attempt、收稿成功 run、`awaiting_site_review` entry 永遠不升級為 DS `delivered`；不產生 formal publication／learning／intervention event。

身份核對包含原 target 綁定的 persisted publication identity、原 execute input fingerprint、文章 title/body hash、來源、latest draft/review/risk、原私人收稿回執及公開 document hash/version/publishedAt。公開版本身份不含檢查時鐘、nonce 或私人 draft version，避免相同公開快照在每次檢查後變成新發布。保存事件拒絕重用 nonce；same-key 併發回傳 durable winner，歷史 replay 明示不具即時權威。

已 opt-in 客戶使用獨立 consumed weekly consent reader：檢查原 reservation 時批准有效，以及現在 config/binding/target/policy/draft/source/latest decision 尚有效。不恢復 machine lease，不把 LINE 同意當模型訓練同意。部分測試依賴注入不能落到正式資料庫。

本輪安全支援單一網站的 owner 人工審核路徑；routing／machine 路徑無法證明完整原發布身份時 fail closed。程式與合成測試不代表正式 DB、Do 接收器、LINE、Google 或 worker 已啟用。

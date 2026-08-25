# DiscoveryStack End-to-End Platform V1
# Unattended Execution Decisions

## 1. 決策目的

本文件記錄使用者已預先授權的無人值守工程決策。一般技術選擇不再中途詢問；優先沿用 authoritative repository 現有架構，採 fail-closed、server-side、可測試、可回復與精確 lineage／audit ledger 的方法。只有不可逆外部操作、真實 credential、production migration、deploy、真實客戶網站寫入、公開官網視覺變更、license／provenance 不明、可疑供應鏈程式或改變產品本質時，才可停止。

## 2. Authoritative checkout 與 Git 邊界

- Authoritative repository：`https://github.com/emily07100710/DiscoveryStack_nuxt.git`。
- Task-start `origin/main`：`a7a96c68e3ec68eb6415708c9cc027d67096f4d7`。
- 唯一 integration branch：`feature/discoverystack-end-to-end-platform-v1`。
- 不修改或推送 `main`，不使用 amend、rebase、squash 或 force-push。
- 本次 GitHub CLI active account 實際為 `mamamia5241888`，不是要求的 `emily07100710`。依「不得自行切換 GitHub 帳號」邊界，所有工作只保留在本地 integration branch，禁止 push。

## 3. Credential 與帳號決策

不向使用者索取或要求貼上任何 API key、token、secret、GitHub App、WordPress credential、PHP Agent secret、Signed API secret、Generic HTTP credential、Hugging Face token、Firecrawl key、OpenAI／Gemini／Claude key 或 production database credential。

實作一律使用 server-only runtimeConfig、opaque credential reference、strict credential resolver、injected mock adapter 與 fake placeholder test data。Credential 不得進入 browser、log、error、hash、fingerprint、receipt 或 response；缺少 credential 時 fail closed。正式 connection test 保持 `NOT RUN`，不構成整個工程 blocker。

## 4. Provider 決策

主要生成 provider 是 Bailian／Qwen，預設 model label 為 `qwen-plus`；provider interface 保持中立，以便未來加入 OpenAI、Gemini 或 Claude，但本任務不接真實 OpenAI、Gemini 或 Claude。

Qwen／Bailian 必須使用 server-configurable model、官方 endpoint allowlist、model ID validation、非敏感 provider／model provenance 與 bounded request／response。Caller 不得選 arbitrary endpoint，也不能以 model name 充當安全授權。

Provider 未設定、credential 缺失、endpoint invalid、timeout、401／403、429／5xx 重試耗盡、malformed response 或 provenance 無法驗證時：

- manual／development／preview 可以產生明確標記的 deterministic scaffold／reference fallback，保存 `providerExecution: false`、fallback mode、fallback reason 與 limitations；
- governed_autopilot 必須 `blocked` 或 `needs_human_review`；
- deterministic scaffold 不得進入 governed_autopilot production publication path。

## 5. AutoGEO 決策

AutoGEO 固定負責 Diagnosis 後的 rule strategy、Base Draft 後的 analyze、selected-rule optimization、Markdown preservation、content safety、rule lineage 與 candidate fingerprint。AutoGEO 不取代 Qwen Base Draft、不創造 evidence、不建立 publication authority、不批准發布、不假裝搜尋排名成效、不自動訓練模型。

Isolated worker 必須具備 bounded input／output、timeout、resource limits、sanitized stderr、無 hidden network、無 hidden model inference、pinned vendor integrity 與 exact Python／TypeScript parity。若 paused AutoGEO patch 不可取得，依 authoritative main、可取得 remote commit、contracts、tests 與既有 inventory reconstructed，不稱為 ported。

## 6. GEOFlow 決策

GEOFlow 負責 Prompt／RAG、provider integration、Base Draft generation、WordPress／PHP Agent／Generic HTTP publishing runtime 與 task／job infrastructure。DiscoveryStack Nuxt 是 control plane 與 authority；GEOFlow 不得自行決定 owner identity、evidence approval、automation policy、review approval、publication authority、outcome truth 或 training eligibility。

PHP／Composer 缺失時，優先使用 disposable container；若仍不能執行，標記 PHP tests `NOT RUN`，繼續 TypeScript、contract、mock integration 與其他 phase，不偽造通過。

## 7. RAG 決策

V1 使用 owner-approved evidence、deterministic lexical retrieval、authority policy、exact source／artifact／chunk hash、fixed topK 與 citation binding。不新增 production vector database、embedding service、Pinecone、Weaviate、Milvus 或外部 semantic search provider。可以保留未來 semantic retriever interface，但不得把 lexical relevance 說成 semantic truth。

Evidence 當作 inert／untrusted data；其中任何 instruction 都不可執行。stale、revoked、mixed snapshot、PII restricted、rights 不明或 caller-derived evidence reference 一律 fail closed。

## 8. Database 與 migration 決策

沿用 Drizzle、MySQL／TiDB-compatible schema、現有 repository pattern、owner-scoped query、transaction 與 append-only events。可以修改 schema、生成新的後續 migration、更新 snapshot／journal、使用 throwaway database 驗證或 mocked repository 測試；禁止修改既有 migration、renumber、套用 production migration、使用 production DB、seed 真實資料或寫入真實客戶資料。

若沒有 throwaway DB：migration generated 可為 `YES`，migration runtime validation 為 `NOT RUN`，production migration 為 `NOT RUN`，但其他不依賴 DB 的工作照常繼續。

## 9. 公開官網與私人後台決策

公開 Astro 官網完全不動：不修改 UI、animation、CSS、layout、typography、spacing、color、content、public navigation、responsive behavior 或 visual assets。若 backend API 變更需要相容，優先使用 backward-compatible server adapter；無法避免的 public change 只記錄於報告，不自行改動公開官網。

私人 Nuxt owner backend 可以整合工作流、增加 owner-only panel、改善 loading／empty／error／blocked 狀態、加入 client／calendar／generation／publication／visibility／learning 操作與 owner navigation；延續現有 workbench style，不建立新 design system。不得建立 customer login、customer account、customer dashboard、customer role 或 customer self-service publication。

## 10. 內容方案與排程決策

固定 cadence 為 3、7、15、30 天；固定 content types 為 article、FAQ、service page；固定 missed-content policies 為 `skip_missed` 與 `one_catch_up`。每個 production plan 有界，預設最多 10 個 deliverables，不允許無限生成。

Scheduler／queue 必須使用 durable run、lease、atomic claim、bounded concurrency、bounded retry、retry_wait、failed、blocked、delivered、duplicate prevention、event ledger、replay protection 與 manual recovery。

## 11. Automation policy 決策

預設 `manual_review`，可選 `governed_autopilot`。後者必須由 owner 對單一 client 明確啟用，保存 client／website ID、policy version、enabled、allowed content types、allowed targets、allowed cadence、allowed risk class、activation timestamp、revocation timestamp、policy fingerprint 與 append-only authorization event。

`auto_publish_eligible` 只是 evaluator 的 quality／risk 結果，不是 publication authority。品質 evaluator、AutoGEO、GEOFlow、Qwen、scheduler、publication router、caller 或 provider response 都不能創造 autopilot authority。Owner 撤銷政策後，所有尚未發布的任務必須停止。

低風險自動路徑只接受 exact gates：evidence valid、quality pass、risk pass、no unsupported claim、no PII restriction、rights／consent valid、provider provenance valid、target valid、credential valid、policy active、lineage valid、idempotency valid。任何一項不成立即 blocked／human review，不發明單一分數閾值。

## 12. 高風險決策

醫療診斷／治療、法律建議、投資／證券／報酬、金融承諾、保險承諾、政治／選舉、個人敏感資料、保證排名／療效／收入／ROI 預設不能無人工審查自動發布。這些內容可以產生 draft 或 preview，但 publication 必須通過人工 review、明確 evidence、rights／consent 與 risk gate。

## 13. Publication executor 決策

Astro／Nuxt First-party Git、First-party Signed API、WordPress REST、PHP Agent、GEOFlow Local、Static Site、Governed Generic HTTP 與 multisite fanout 必須分開處理。每一 executor 必須有 capability validation、strict target guard、server-only credential resolver、fixed endpoint／path policy、request identity、idempotency、timeout、redirect rejection、bounded retry、response identity validation、content hash verification、receipt、append-only event 與 sanitized errors。

Generic HTTP 預設 disabled，只有 owner 明確 allowlisted target 才能啟用。所有 executor tests 使用 injected mocked transport。本任務不呼叫真實客戶網站、不寫入 GitHub Contents、WordPress、PHP Agent 或 Generic HTTP target。

## 14. Learning 決策

只有 rights approved、consent valid、PII `none_detected`、owner explicitly approved、not revoked、lineage valid 的資料可進入 evaluation／training manifest。現階段完成資料收集、人工標註、dataset admission、manifest、evaluation 與 future training trigger boundary；不自動訓練、不上傳 Hugging Face、不 fine-tune、不 LoRA。

## 15. 測試決策

至少涵蓋 normalization、canonicalization、hash、fingerprint、strict schema、duplicate、idempotency、collision、stale／revoked、rights／PII、target guard、retry 與 state transition；AutoGEO worker integrity／parity／timeout／sanitized error／no network；GEOFlow credential／HMAC／nonce／queue／lease／retry／rollback／lineage；所有 publication matrix、authority、SSRF、redirect、response identity、replay、receipt、event order、multisite partial failure；autopilot authority／revocation／provider unavailable／scaffold block；visibility limitation；learning admission；以及 manual、autopilot、blocked、retry、owner isolation 與 lineage end-to-end acceptance。

每一個 checkpoint commit 前至少執行相關 targeted tests。測試、typecheck、build、migration 與 external connection 的狀態必須如實記錄為 PASS、FAIL、NOT RUN 或 BLOCKED。

## 16. 不可逾越的外部邊界

本任務不呼叫真實 provider、不建立真實外部帳號、不登入外部控制台、不讀取 keychain、不部署、不套用 production migration、不寫入 production DB、不修改公開官網視覺、不寫入真實客戶網站、不啟動 telemetry、不上傳 dataset、不啟動 fine-tuning，也不把 provider API observation 說成 consumer-surface truth。

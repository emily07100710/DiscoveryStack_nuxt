# Intervention Loop Runtime V1

## 目的與範圍

此 private owner runtime 對應 `GEO_ENGINEERING_SPEC_V2` §22、§24 與 `PROJECT_MAP` §8.2 Phase 4 的改動登記、上線／重抓確認、成績、評估四列。它記錄可稽核訊號，不會自動改網站。

## 資料表

七張表：`interventions`（改動與狀態）、`interventionEvents`（append-only 事件）、`interventionMeasurements`（成績視窗）、`interventionExperiments`（實驗）、`experimentResults`（效果與因果限制）、`refreshPolicies`（owner 全域門檻）、`refreshQueue`（需重處理項目）。每張表均以 ownerUserId 範圍隔離。

## 狀態機與守門

`registered → deployed → recrawl_confirmed → measured → assessed`，可取消。未確認重抓不得量測，違反時回傳 `RECRAWL_NOT_CONFIRMED`。所有寫入以冪等 key 或去重 key 守門。

## 上線確認證據等級

強證據是預期文字命中、手動確認或發布回執；弱證據是內容指紋改變或整站掃描。來源會保存為 expected snippet、manual、publication receipt 或 site-evidence scan。

## 重抓確認

URL Inspection 可確認 crawl 時間；手動確認必須附說明。自動查詢只在已有成績等待時詢問，並以 Google 的回答計額：`crawled` 或 `never_crawled` 才會計入每筆最多 30 次、且回答間至少相隔 24 小時。其他不知道的結果不計額、不改回答時間，會保存原因並在同一 UTC 日累積；同一筆當日累積 3 次失敗即停到下一個 UTC 日。憑證未設定即是總開關，結果標為不知道。

## 成績

成績分系統拉的與手動輸入；系統拉取每筆 24 小時一次。拉不到時保留不知道的事件，不假造數字。

## 前後評估

以每日率比較前後視窗，保存 n、每日點擊／曝光、CTR 與排名變化；signal 門檻沿用 outcome-learning。因果限制陳述全文會原樣保存並輸出，前後比較只能視為相關，不能視為因果。

## 實驗

支援 `pre_post` 與 `grouped`。grouped 的 `sampleSizeBaseline` 是 treatment total n，`sampleSizeFollowUp` 是 control total n；效果含 `sampleSizeMapping`。每筆可有 auto experiment key `auto:intervention:<id>`；結果皆帶 n 與限制。

## 刷新佇列

三類觸發：手動、回歸、過期；全域設定為退步百分比、最少樣本與過期天數。過期掃描會略過已取消的介入，且已取消項目不會作為較新版本候選。每項保存原因文字、數字與建議動作。去重 key 為 `manual:…`、`regression:<urlHash>:<id>`、`expiry:<urlHash>:<id>`。回歸與過期掃描會以 owner 範圍的遞增 id 游標走訪全部介入，不受單頁 200 筆限制。

## 匯出資料集契約

`GET /api/interventions/export` 匯出 owner-scoped JSON outcome dataset，回應為 attachment；以遞增 id 游標走訪該 owner 的全部介入，並逐筆載入關聯資料以限制資料庫並行量；包含記錄、事件、量測、結果與限制，並不代表驗證過的業務結果。

### 2026-10-06：InterventionEnvelope 與 operational export v2（PARTIAL）

`GET /api/interventions/:id` 追加 `envelope`，同一投影亦包含於 `intervention-outcome-v2` export。`pages/audit-lab/interventions.vue` 的前後證據卡呈現內容 hash／擷取時間、發布回執綁定、重新抓取、各來源視窗、樣本／實際觀察天數、目前評估與限制。無量測為 unknown；零曝光的 CTR 為 null；不產生置信百分比或因果宣稱。使用者能以目前資料重新評估，歷史結果保留，不覆寫舊結果。

- GSC、其他來源、人工／系統、不同 property 分開。click 契約目前只可評估 GSC；其他來源保持 unsupported，不拿 clicks 欄位當 AI citation／GA4 指標。重疊視窗、source hash mismatch、future/incomplete window、不合法 count/rate/sample 均不形成可比較訊號。同時有多個 GSC 範圍不自動選最好的範圍或合併。
- contentops 的發布後 content hash 不再回填成 baseline。inventory baseline 必須有明確時間；exact publication receipt 只能保留發布前 inventory／live-fetch 基準。舊 `content_operations` baseline 投影為 unknown。人工重抓不能早於發布時間。
- contentops bridge 必須有 delivered 的 execute attempt、完成時間、owner／client／target／entry／draft/content lineage。detail/export 每次由 durable resolver 重讀 receipt、頁面、content hash、target 和時間；drift、revocation 或讀取失敗不能繼續當有效回執。
- assessment 以目前分組與 measurement references 重算 fingerprint；量測更正、來源變更、policy 變動、事件 fingerprint 漂移會使既有結果失效。fingerprint 是 checksum，不代替 owner authority。
- envelope 只保存 hash-only lineage、固定 reason codes 與 aggregates；不將 change summary／hypothesis／原始 provider 回應當訓練欄位。匯出的歷史 results 是營運稽核記錄，必須以 envelope 的 current 狀態判讀。

此切片**未實作** immutable change-set／exact paragraph or metadata diff、current consent／PII／revocation 到 action-learning 的 adapter，因此 `modelTrainingAllowed=false`、`primaryCitationLabelAllowed=false`、`candidateAuthority=not_bound`。GSC aggregate 永遠不是 primary citation label；正式 citation dataset 繼續使用 GEO Outcome Model 的 consumer-surface review／candidate-set authority。不得把新增 operational export 當成 dataset admission、訓練完成或模型變強。

後續優先：受控 revision/change-set identity → publication bridge 回補與冪等 → current consent/PII/rights/withdrawal 的 durable learning adapter → leakage-safe holdout／shadow evaluation。真實 DB、Google、publisher、背景排程、模型訓練／promotion 均仍需分別驗收，本輪不呼叫、不部署、不套 migration。

本輪本機驗證（2026-10-06）：使用專案已安裝的 Nuxt／Vitest 工具，依序完成 typecheck → fresh `node-server` build → 全量安全回歸，**276 個測試檔通過、5,504 個測試通過、14 個檔案／27 個測試依既有條件跳過**。新增 envelope service 與實際 SFC SSR rendering 的 27 個測試亦通過；尚未做瀏覽器視覺／操作驗收。首次受限環境的全量測試遇到 `listen EPERM: operation not permitted 127.0.0.1`，允許本機測試伺服器後重跑通過；未刪除測試或放寬 skip 條件，外部 `DS_RUN_*` opt-in 保持關閉。這些結果不代表真實 provider／DB、訓練品質或正式部署驗收。

## 路由清單

`/api/interventions/list` 提供清單、`/api/interventions/register` 提供登記；`/:id` 提供詳情以及 deployment、recrawl、measurements、pull-metrics、measure、assess、cancel；`/experiments`、`/refresh-queue`、`/refresh-policy`、`/export`、`/tick` 提供對應 owner-only 操作。POST 均要求 same-origin。

所有子路由（含列表 `list` 與登記 `register`）都由唯一一個 catch-all 檔 `server/api/interventions/[...path].ts` 交給 `server/intervention-loop/http-router.ts` 分派（靜態路徑先比對，再比對 `/:id` 與 `/:id/<action>`；未知路徑或動作回 404）。列表與登記刻意不掛在裸路徑 `/api/interventions`：radix3 的 `/**` 不會比對到裸的父路徑，要支援它就得再開一個路由檔，而 Nitro 會把每個路由檔展開成 `$fetch` 的型別，這個專案的路由數已到 TypeScript 型別推導的上限（實測：本引擎只要佔到 2 個路由鍵，`pages/audit-lab.vue` 就會 TS2589 失敗）。所以這個引擎只佔 1 個路由鍵，並由 `tests/intervention-loop-routes.contract.test.ts` 把「只有一個路由檔」鎖成回歸測試。路由共用的 owner 守門與同源檢查放在 `server/intervention-loop/http.ts`，不放在 `server/api/` 底下（放在那裡的 `_helpers.ts` 也會被 Nitro 登記成路由）。

錯誤回應：路由只原樣保留 400／401／403／404／409／413／422／503 與其 `data.code`（401＝owner 登入逾期、要重新登入；403＝同源檢查擋下；413＝內容超過 64 KB；422＝資料不合法；409＝狀態不允許，例如 `RECRAWL_NOT_CONFIRMED`），和 content-operations、measurement-collection 的做法一致；其他任何錯誤一律回 503 與通用訊息，不外洩內部錯誤內容。

## 排程

掛在 `content-operations:measurement-tick`，每 30 分鐘由既有 task scheduler 呼叫。介入 tick 有 owner 範圍、50 筆上限、24h metrics cap 與 30 次／24h auto-recrawl bound。

## 與 content-operations 的接點

outcome assessment 成功後以 hook 非阻斷連結；tick 讀取 delivered entries 自動登記，key 為 `auto:entry:<entryId>:target:<targetId|0>:<receiptFingerprint>`。2026-10-06 新增 gated post-commit learning bridge：正式回執接受並持久化後才補登介入／安排量測，失敗留待五分鐘補登，不能造成重新發布。已量測且 recrawl confirmed 才由 tick 評估，未知基準不冒充改善。詳見 [學習閉環 Runtime](LEARNING_CLOSED_LOOP_RUNTIME_V1.md)。

## 安全

只接受公開 http/https，阻擋 localhost、私有網段與 169.254，重導後再檢查；owner 範圍、冪等、私有 no-store/noindex。它不寫 site-evidence 表，也不自動套用任何改動。

## NOT RUN

本交付不執行真實 URL Inspection、真實按網址拉成績、真實抓取網頁。

## 已知限制

本機測試只證明 source、路由契約和 in-memory 行為；真實 MySQL/TiDB、Google 憑證、外網與排程部署仍待環境驗證。

## 測試對照表

`intervention-loop-routes.contract` 檢查私有 route、安全 headers、導航與禁止區；`intervention-loop-content-operations-bridge` 檢查 delivered source、tick 冪等和 never-throw outcome hook；service/tick tests 檢查狀態機。

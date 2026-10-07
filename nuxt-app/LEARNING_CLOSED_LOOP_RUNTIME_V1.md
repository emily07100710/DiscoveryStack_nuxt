# DiscoveryStack 學習閉環 Runtime V1

2026-10-06–07。本輪優先完成 DS 自身營運平台與受治理學習流程；既有一鍵建站保留，網域／經銷／自動採購不在本輪執行範圍。

## 目前交付邊界

本機已實作：來源授權與撤回、受限結構蒐集、人工審查、資料釋出、既有引用模型的真實 CPU 訓練入口、精確草稿模型建議、指定客戶週更／LINE 送審、正式回執後的量測登記與失敗補登、成效候選的重新核對、核准後的成效模型 CPU 再訓練，以及過期結構投影／失效模型權重清理。

**正式資料庫與 DS 官網／後台已有部署版本，但不是已用真實客戶資料訓練成功。** 2026-10-07 正式遷移及匿名唯讀檢查的證據見下方；真實來源同意、AI／Google／LINE／發布通道設定及業務端到端實測仍未完成。引用觀測與內容成效是不同任務：前者訓練引用模型；後者由正式回執、目前同意及可重算評估建立成效候選，再由 owner 核准確切資料後，訓練獨立的實驗性 GSC 正向／負向方向模型。它沒有混入引用模型、不做因果推論，也不自動改稿或啟用正式模型。新引用模型仍需完整影子門檻與相容的已核准回退模型；首次回退可由獨立建立、獨立 owner 核准的固定 train-only prior 提供，不降低資料或影子驗證門檻。

## 一輪怎麼走

1. 在「內容營運」登錄正式客戶與網站，在 Audit Lab 登錄來源。來源用途必須是 `training_candidate`，權利／條款／robots／個資狀態都通過審查。
2. 進入 `/audit-lab/learning-loop`「學習閉環」，記錄另一份**模型改進同意**。客戶同意發布文章、LINE 綁定、公開可讀，都不構成學習授權。
3. 選擇客戶同網站的來源，記錄權利與同意證明指紋、同意版本、到期日和保存天數。證明檔案只在瀏覽器計算 SHA-256，不會上傳原檔；原始證明需由營運者妥善保存。核取方塊是 owner 的具名申明，不是系統自動驗證合約是否合法。
4. 管理員開通後，蒐集器先讀目前授權與目前 `robots.txt`，只抓同授權主機的公開 HTTPS 頁面。每批最多 20 頁／深度 2／單頁 256 KiB／整批 30 秒／請求至少相隔 1 秒。DNS、授權查詢、HTTP 與讀取本文都受整批期限約束；跨主機、私網、機器人禁止路徑、登入或拒絕都不繞過。
5. 結構投影保持「AI 引用未知」。人工檢查權利與個資後才可核准輔助資料；撤回、來源漂移、過期、審查指紋不符，下一次釋出即排除。
6. 引用模型另由真實消費者 AI 介面的可追溯、核准觀測整理資料集。owner 核准後可訓練引用基準模型或成對排序模型；只用訓練分區擬合，另外計算 validation／test／網站／查詢／時間 holdout 成績。
7. 模型核准影子驗證後，可對系統裡的確切草稿產出分數、特徵貢獻與未知特徵。它不改寫、不發布、不宣稱真實引用機率或市場排名。計算後重新讀取同一授權、來源、草稿與資料集，避免中途撤回／修改仍返回有效建議。
8. 「每週文章送審」設定客戶 LINE 綁定及週更政策。既有流程產生題目與草稿、做品質／風險檢查，再發送 LINE 預覽、確認、要求修改。
9. 確認 webhook 驗原始內容簽章，辨認確切客戶、事件、token、草稿版本和效期，**只記錄同意，不在 webhook 發布**。下一次 worker 再確認同一版本與政策才發布；重複按確認不重發，改稿／過期／撤回必須重新送審。
10. 正式執行回執寫入既有 publication ledger 後，記錄精確草稿的 hash-only 快照，補登介入與安排 GSC／GA4／AI secondary 量測。若補登失敗，後續 tick 從正式回執恢復，不重新發文章。
11. 已量測且重抓確認的介入才評估。內容成效釋出重新核對正式回執、草稿版本、證據指紋、評估可重算、目前學習同意、PII 與保存期，產出方向性候選。未知基準保持未知，相關不冒充因果。
12. 在工作台核對成效資料的指紋、目前權利／同意、個資處理和方向性限制，留下核准理由。核准只排入確切、不可改寫的資料子集；後續新增候選必須另行核准。
13. 開通成效訓練後，五分鐘排程每次最多擬合一份已核准資料，也可手動執行。CPU 訓練有 500 筆／80 特徵／250 epochs／5 秒上限；只用發布前的內容種類、語言、baseline 彙總指標及 missing indicators，不用 follow-up／delta 當預測輸入。GSC positive／negative 才是此任務的二元答案，unknown／mixed／無明顯變化不當負例。
14. 領取工作後、擬合後與回應前都重讀目前來源／同意／回執與候選譜系；領取後另核對仍有效的同一 worker lease，期限最多五分鐘，CPU 仍最多五秒。產出可核對的模型 hash、隔離驗證指標和限制，瀏覽器不取得權重。撤回或保存期到期時停止使用並清理衍生權重，核准歷史保留。

## 到哪裡拿資料

詳細規則見 [ML 資料來源目錄](docs/ML_DATA_SOURCE_CATALOG_V1.md)。

| 來源 | 實際用途 | 不可冒充的事實 |
| --- | --- | --- |
| 有權授權的客戶公開網站 | 結構／品質輔助特徵 | 爬到頁面不代表 AI 引用了它 |
| 客戶授權的 GSC／GA4 唯讀連線 | Google 搜尋與網站彙總成效 | 不是消費者 AI 引用標籤，兩來源不相加 |
| 人工核對的消費者 AI 介面觀測 | 引用模型的 primary 標籤；保存查詢、候選頁、引擎、介面、locale、run、timestamp 譜系 | API 回答不能直接替代消費者介面觀測；unknown 不是負樣本 |
| 已審查的明確授權／開放授權來源 | 權利範圍內的輔助資料，仍須來源審查 | 公開、CC 字樣、robots 允許都不等於可以任意商業訓練 |
| 核准的去識別化第一方業務事件 | 後續可評估的業務結果來源 | 本輪沒有自動接入訂單／會員／LINE 對話資料；不把收入或成交推算為已驗證 |

## 資料與發布各自的守門

- 新表 `learningSourceAuthorizations`：owner／客戶／來源、權利與同意收據、到期與撤回；日期按 MySQL 秒精度正規化再計算指紋。
- 新表 `learningEvidenceCollections`：有界批次、冪等鍵、輸入／授權／投影／人工審查指紋、CAS lease fencing、保存期限。只保存結構區間與雜湊，不保存頁面本文、聯絡資料、Cookie、密鑰或查詢原文。
- 新表 `learningOutcomeModels`：獨立的 observational task、確切候選與來源譜系指紋、不可改寫的 owner 資料核准、CPU 訓練 lease／結果／模型 hash。只在私有資料庫保存數值權重，工作台只回安全摘要；失效／撤回移除衍生權重，不會刪客戶內容。
- `0045_learning_authorized_closed_loop.sql` 與對應 snapshot／journal 由已安裝的 Drizzle 產生，只有新增表／FK／index。本機實作階段未套用資料庫；**2026-10-07 經使用者明確授權，已在與正式 Render 後台設定比對一致的 TiDB 套用 0045**。正式 ledger 已核對為 46 筆、新增表／8 個 FK／7 個明確索引皆存在；總表數 195。遷移前 192 張表、258 筆資料已做 TLS 一致性快照，並在隔離 MySQL 還原、逐表筆數與 JSON 正規化後逐欄雜湊核對成功。備份與正式資料不在 Git 或公開站內。
- owner GET／POST 沿用唯一 intervention catch-all；POST 同源守門、64 KiB body limit、私有 no-store／noindex，不新增 API 路由檔或公開前端資料通道。
- LINE approval 授權精確草稿發布，learning authorization 授權特定用途的資料使用；兩者沒有互相轉換。
- 失敗／未知 outcome 不會湊成訓練標籤，爬蟲和 GSC／GA4 不會被訓練入口冒充引用 truth。
- 範圍化客戶 tick 直接讀指定客戶，不受批次前 50 位限制；outbox SELECT 與 CAS 都帶 owner／client 條件。
- 成效學習每次最多讀 500 筆正式 outcome，不再被工作台原有 100 筆上限卡在 150 筆審查門檻以下。工作台原有預設仍為 100；所有讀取仍 owner-scoped。最後釋出前重讀每筆確切 outcome／snapshot／量測時間及目前證據指紋，並用當下時鐘檢查保存期與授權。

## 管理 API

均為 `/api/interventions/closed-loop/` 下的 owner-only 路徑。

| Method | 路徑 | 功能 |
| --- | --- | --- |
| GET | `workspace` | 真實客戶、來源、授權、蒐集及開關狀態；不回假成功 |
| POST | `authorizations` | 記錄範圍化學習授權；效期最長 90 天，結構投影保存 1–30 天 |
| POST | `authorizations/:id/revoke` | 撤回新蒐集與新資料納入；請求必須空物件 |
| POST | `collect` | 只接受 authorizationId／idempotencyKey，由伺服器讀網址與目前授權 |
| POST | `collections/:id/review` | 人工核准／排除；核准需明確 PII review，審查不可事後改寫 |
| GET | `structural-release` | 目前仍有效、已核准的無標籤結構輔助投影 |
| POST | `train` | 已核准、達標且目前仍合格的引用資料集訓練；回摘要，不回模型權重 |
| POST | `citation-fallback/create` | 以核准的引用資料集建立固定 train-only prior；只有 train 分區擬合，建立不代表核准 |
| POST | `citation-fallback/review` | owner 獨立核對並核准精確 prior artifact；只能供相容回退，不可預測、建議或正式啟用 |
| POST | `draft-advice` | 已核准影子模型對 server-read exact draft 的實驗性建議 |
| POST | `client-cycle` | 執行指定客戶的有界週更流程及發布補登；仍受原開關、政策與額度 |
| GET | `outcome-release` | 同意／發布譜系重新核對的內容成效審查候選；不是引用資料集 |
| GET | `effect-models` | 成效候選審查門檻與目前仍有效的模型摘要；不回權重 |
| POST | `effect-models/review` | owner 核准 server-read 確切資料集指紋／譜系與 PII、方向性限制；只排入訓練 |
| POST | `effect-models/train` | 只接受 modelId，受管理員開關與 durable lease 保護的有界 CPU 擬合 |
| POST | `effect-models/:id/revoke` | 撤回並移除數值權重／metrics，保留 hash-only 核准歷史；請求必須空物件 |

已有的 `/api/geo-outcome-model/` 仍負責觀測、證據綁定、資料集 review、模型影子 review 與既有 ModelOps，沒有第二套模型審批通道。

## 開通前的設定

所有範例值在 `.env.example`；真實秘密只放正式主機的 server-only secret，不貼進聊天或版本庫。

- `DATABASE_URL`、`OWNER_OPEN_ID`、既有 owner 登入配置；確認 migration 順序／備份後才套用 0045。
- `NUXT_LEARNING_LOOP_ENABLED=true`：每五分鐘有界來源蒐集、正式發布補登、結構投影保存期清理。預設 false。
- `NUXT_LEARNING_CRAWL_ENABLED=true`：允許已授權來源蒐集。預設 false；暫停新增蒐集時關這個，不必關保存期清理。
- `NUXT_LEARNING_LIVE_ACTION_ENABLED=true`：選用的受控第一方 HTTP 發布前後證據，預設 false；先審核並套用 0047，再完成客戶 SSR 文章整合與來源授權。發布後背景驗證另需 loop／排程正常運行，並不替代 crawl、模型訓練或發布開關。
- `NUXT_LEARNING_RETENTION_ENABLED=true`：即使 loop 暫停，仍單獨執行保存期清理。已有蒐集資料時必須保留清理排程。每次最多移除 100 筆已過期的結構投影，保留 hash-only 授權與審查歷史；卡住 worker 被 fencing，不能再寫回過期資料。它不刪客戶網站、訂單或原始內容。
- `NUXT_LEARNING_EFFECT_TRAINING_ENABLED=true`：允許核准後的成效訓練，預設 false；自動 worker 仍需 loop 開通。每 tick 最多一份訓練；未核准的新資料不自動加入舊核准。保存期／撤回清理與這個開關獨立，每次輪替核對最多 100 筆仍有效模型，使用／展示前則逐次重新驗證。
- `NUXT_CONTENT_OPERATIONS_SCHEDULER_ENABLED`、`NUXT_WEEKLY_CONTENT_APPROVAL_ENABLED`：原週更／內容營運流程的開關，預設 false；按「執行這位客戶的流程」也不能越過。
- LINE Messaging API channel secret／access token／bot user ID；獨立的 `NUXT_WEEKLY_CONTENT_TOKEN_KEY` 和正式 HTTPS `NUXT_WEEKLY_CONTENT_REVIEW_ORIGIN`。正式帳號設定見 [LINE 設定](docs/SEARCHKING_LINE_ACCOUNT_SETUP_V1.md)。
- 既有生成供應商、發布通道及 credential resolver；LINE 確認並不替代文章品質 gate、owner 策略授權或發布目標設定。
- GSC／GA4 唯讀連線及必要 Google 憑證；量測工作台的實際網站／property／page scope 必須一致。
- 持續運行的 worker／排程。Render 休眠或排程停擺不能保證準時送審、發布、量測或清理；本輪沒有更動方案或部署。

## 模型門檻與尚未解鎖的範圍

引用模型的既有開發 gate：至少 200 候選、30 query groups、5 網站、2 引擎、20 正例、40 hard negatives、14 天觀測跨度及六個非空分區。影子 gate 更嚴：至少 1000 候選、100 query groups、20 網站、3 引擎、100 正例、200 hard negatives、60 天跨度；還要 metrics／owner review／相容回退模型。資料不足不調低門檻。

發布快照證明的是**發布了哪份稿**，不是完整 live before/after patch。第一方 Git 的 canonical 更新現在可記錄 server-read 的 repository revision diff：先以 GET 精確檔案／blob SHA 再以 CAS PUT 更新，只有 PII scan 通過、來源可解析且有 server readAt 的更新能保存 hash-only 標題／段落 added、removed、replaced、unmodified；新增檔案、重播或未知舊內容不虛構 before state。diff 與精確 owner／entry／draft version／content／evidence／target／正式 receipt／artifact 綁定，僅在唯一 immutable delivery event、目前發布身份、來源及同意重新核對後供輔助審查。缺少／撤回授權時保留營運觀測，但 learning authority 為 null。

repository revision 不是已部署的 live-page before state：該 diff 路徑仍是 `liveBeforeState=unknown`、`causalChangeSetEligible=false`、`modelTrainingAllowed=false`，不把 repo diff 提升為因果、引用 primary label 或可訓練資料。現在新增獨立、預設關閉的受控第一方 HTTP before/after adapter 與 action-learning admission，見 [發布前後證據規格](LEARNING_LIVE_PUBLICATION_ACTION_V1.md)：必須真的讀取同 URL 受控 SSR 頁面、精確核對 formal receipt、獨立審查權利／個資與目前授權，不能沿用 repository diff 冒充證據。多發布目標的量測仍按正式回執隔離；新 action 路徑只承認各目標的確切 delivered attempt，可處理 terminal partial run，不代表既有 canonical measurement bridge 或真客戶 multi-target 閉環已通過正式驗收。

成效模型沿用原 candidate admission：至少 150 合格候選、article／faq／service_page 與 en／zh-hant 各至少 20、兩種量測來源組合。另要求至少 100 GSC 二元候選、10 個 subject，train 至少正／負各 20、validation／test 各正／負至少 5。固定按 subject hash 分 70／15／15，subject 不跨分區；只用 train 擬合標準化與權重，回 validation／test log loss、Brier、F1、balanced accuracy 及 train-prevalence majority prior 基準。

這個新 trainer 位於既有純 outcome-learning 治理核心之外，沒有修改 V1 的 label 或 admission 契約。可信時間／分組 sidecar 從每次 fresh formal receipt、可重算 assessment 與 GSC 量測重新投影，不由瀏覽器提交。owner 核准綁定確切 sidecar、候選子集與譜系；新候選不改寫舊核准。所有 baseline 特徵的 capturedAt 必須不晚於發布時間，其 source／scope／window／capture／sourceHash 的組合指紋一併綁定，避免未來才取得的 baseline 洩漏或不同基準混用。

同一 owner＋formal publication receipt 僅保留最早 GSC follow-up horizon（依 end／start／capturedAt，與標籤無關）；精確時間 ties 或衝突的 baseline／publication metadata fail closed。去重後才檢查 admission 及過濾二元答案。由全部唯一發布依 publishedAt 選最新 20% 為時間外 cohort，包含 cutoff ties；該 cohort 的 subject 不出現在其餘 train／validation／test，該 subject 的歷史發布亦排除。其餘分區仍按 subject hash 隔離 70／15／15。歷史 label window end 及 capture 必須嚴格早於 cutoff；時間外 follow-up 在 cutoff 之後，且在 sidecar trainingAsOf 前已取得。V2 artifact 包含獨立 temporal metrics、train-only majority baseline 及排除指紋；驗證不接受舊的 `UNAVAILABLE` 宣稱。

首次引用回退基準版本固定為 `geo-outcome-train-prior-v1`：只用 train 標籤比例計算平滑 prior，其餘權重為零，validation／test／site／query／temporal 只做評估。建立與 owner 核准分開；candidate 在創建 immutable artifact 時綁定已核准的相容回退 hash，不可事後改寫補上。每次使用重新核對 exact rollback pointer、相容契約、durable decision、目前 dataset／members／governance 與有界無循環回退鏈。fallback-only 不可用於預測、shadow evaluation、草稿建議或 production activation。

正式 TiDB 的唯讀 CAST 已確認 `DECIMAL(24,12)` 會改變超過 12 位的小數；模型持久化改以既有 JSON 欄位的版本化 envelope 保留精確 intercept，DECIMAL 只作明確四捨五入的鏡像。讀回先驗證版本、欄位、數值界限與鏡像，再以原精度重算 artifact hash；不修改模型數學或資料表，不回寫歷史模型。舊 raw configuration 仍須通過原 hash 核對，無法驗證或未知版本保持拒絕。存入／讀回測試使用小數取位的本機 harness，沒有向正式資料庫寫入測試模型。

成效工作台另有明確的「已獨立審查的實際改動」V3 模式；只有目前 action release 的確切候選與十項發布前 planned features 能加入，另綁定 immutable model-data approval。原 outcome-only V2 模式／artifact 驗證保留；V3 不可沿用 V2 核准、不會在資料不足時靜默降級，也不拿 after observation 或後續成效當成預測輸入。action 的獨立審查不等於模型資料核准，更不等於 production activation。

以上仍是合成／mock 驗證的觀察性工程，不宣稱因果或正式模型品質。新 live action-learning adapter 的真客戶／HTTP／瀏覽器整合、足夠真實引用／成效資料、供應商端到端與 production 模型 activation 尚未完成正式驗收。本輪沒有從零訓練大型語言模型，文章生成仍由既有 AI provider 提供；成效模型不會直接改寫草稿。

## 驗證證據

新測試涵蓋授權／秒精度／owner 隔離、同意中途撤回、爬蟲 hard deadline／robots redirect、投影隱私、lease concurrency、過期投影清理、引用模型的真實 CPU 擬合及六分區評估、成效模型的真實 CPU 擬合／subject 隔離／無 follow-up 洩漏、核准子集／競爭 worker／權重撤回、精確草稿與模型譜系、指定客戶 LINE 確認到下一次 worker 的發布、正式回執與成效候選。開發測試資料為合成或 mock；沒有抓真客戶、發真 LINE或呼叫真 AI／Google。下述正式資料庫遷移與部署是之後經使用者明確授權、分開執行的操作，不是這些 mock 測試所證明的結果。

2026-10-07 首發部署修正後的本機驗證（歷史紀錄）：Nuxt typecheck exit 0；fresh node-server build exit 0；完整 Vitest suite 286 個檔案通過、14 個檔案跳過，5,607 項測試通過、27 項跳過（總計 5,634 項，171.30 秒）。另已以只含追蹤中 `nuxt-app`、沒有 `services` 或正式 `.env` 的隔離副本完成 prepare／typecheck／正式 build。跳過項目仍需外部服務／設定／資料庫，未把它們算成通過。測試啟動的伺服器只綁定本機 127.0.0.1，資料庫連線清空、真實服務測試及排程全部關閉；環境原有 listener 限制經有界本機測試權限處理，沒有放行真實外部操作。

本輪 fallback／時間外 holdout／repository action／精度與撤回保護增補後，重新依序完成 typecheck、fresh node-server build 與完整 Vitest：295 個檔案／5,677 項通過，14 個檔案／27 項跳過（共 309 個檔案／5,704 項，258.72 秒），全部 exit 0。本機 production-origin runtime 的 7 項實際通過；新版匿名工作台與 390 px 手機導覽亦已在本機正式建置預覽核對。這不是已登入 owner 的正式業務驗收，也未呼叫真供應商、使用正式 DB 訓練或啟用 production 模型。本輪推送／Render Live 證據以 [上線核對文件](docs/CONFIGURATION_READY_LAUNCH.md) 的本輪章節為準。

內容營運／量測的循環 barrel import 已改用原始模組；最後一次建置不再出現跨 chunk 的循環引用警告。仍有既有 browsers data 過期、plugin timing 與 knowledge ULID 的 es2019 BigInt target 警告，未更動依賴或把它們隱藏。環境中的 pnpm wrapper 有簽章／網路限制，因此驗證使用既有 Node 22.23.1 和已安裝的 Nuxt／Vitest 入口，不下載新版本、不關閉簽章檢查。

正式資料庫遷移及 DS 官網／後台部署：**IMPLEMENTED / VERIFIED（2026-10-07）**。資料庫 ledger 46 筆／195 張表；首發官網程式版本 `95b2bc4`、後台 `3123d6e` 已確認 Live，且 runtime-only 公開網址鏡像修正後 14 項正式唯讀 HTTP 檢查通過。本輪後台執行程式已更新為 `515e4fb62f66b8f02ecf3468483bf622eaf02d71`，Render 直接確認 Last successfully deployed commit 與 Live，服務仍為 Free；新版 HTML 所引用 client artifact 與本機正式建置 hash 一致。新版部署後官網／後台 16 項非破壞性 HTTP 檢查通過，涵蓋 canonical／handoff、回返連結、根路由 redirect、noindex、未登入 workspace／fallback POST 的 401／no-store、精確 CORS／錯誤來源拒絕。其餘實際 provider／登入後完整業務流程驗收：**NOT_RUN**。正式模型準確度、客戶 LINE 手機體驗、權利與同意文件、常駐排程與完整 action-learning：**GATED / UNVERIFIED**。此次資料庫套用不會開啟自動訓練、授權客戶資料或啟用正式模型。2026-10-07 本輪重新唯讀核對時，正式來源、訓練紀錄、模型、內容日曆項目與發布目標均為 0；不能把上線當作有資料或已完成業務效果驗證。

# Knowledge Consumer Bindings V1

本機新增資料集與評測題目對知識修訂的持久化精確依賴。它讓影響預覽能列出實際登錄的 GEO dataset manifest 與不可變 prompt version，並在知識改版後保留舊 pin、標示需要重新核對。它不以名稱或文字相似度建立連結，不核准資料訓練，也不修改 native 資料集或評測題目。

狀態：IMPLEMENTED 本機程式與 owner 操作介面，驗收進行中，NOT_DEPLOYED。0052 binding ledger 與 0053 current heads／command key hash 的 migration 僅生成，未套用正式資料庫；兩個新 migration 完成之前不可啟用 binding 寫入。隔離 SQL 與完整新版建置仍需按本批來源驗收；既有 Impact Preview 的驗收不證明這批新增程式已通過。

## 精確 native 對象

`geo_dataset` 使用 `geoOutcomeDatasetManifests.id`，伺服器透過原有 GEO repository 重新驗證不可變 manifest。其 version 與 content hash 都是完整 manifest fingerprint，不使用超過 consumer version 長度限制的 schemaVersion，也不宣稱已重新核准原始 observation 或 dataset members。

`benchmark_prompt` 使用 `llmVisibilityPromptVersions.id`，version 為其整數版本的字串，hash 為 promptHash。查詢同時核對 prompt、query、project 的 owner 與 project 關係，並在伺服器內使用原有 normalizedPromptHash（NFKC、trim、空白合併、und 小寫）重算，不誤用原始 bytes 的 SHA-256。private prompt text 僅用於內部驗證，不回傳到依賴 DTO。

資料集是否核准、觀測授權／個資審查、題目啟用、模型影子審查與發布門檻仍由原有模組獨立決定。依賴登錄僅記錄擁有人明確宣告的關係，不證明任意資料集或題目實際使用了知識全文。

## 登錄和撤銷

POST `/api/knowledge/consumer-bindings` 只接受 consumerKind、consumerId、subjectKind、subjectId、operation、expectedRevisionFingerprint、expectedBindingFingerprint、idempotencyKey。owner 由 session 決定；consumer version／hash、revision ID／編號／hash／fingerprint 都重新讀取私人資料庫，不接受瀏覽器提供權威欄位。兩個 expected fingerprint 只是比較條件，不是權限或核准。

新增登錄必須明確確認一個已存在的目前 Entity／Claim／Source 修訂。伺服器鎖定 canonical subject，核對不可變修訂、原始 canonical snapshot digest、配對 mutation event，並重建目前 subject 快照比對 head；沒有 revision 時回 `REVISION_REQUIRED`，不猜測 baseline 或偷偷建立假歷史。

每個 native consumer／subject 的登錄、重新 pin 與撤銷都追加到 `knowledgeConsumerBindings`。sequence、前一 binding fingerprint、request fingerprint、native hash 與確切修訂一起保存。CAS 必須符合目前 binding head；相同 key／相同 request 回原收據，key collision 拒絕，no-op 不追加。每次讀取 head、重試及寫入，核對其直接前一筆的序號、身份與 fingerprint；這不宣稱已逐筆稽核整條歷史。

撤銷只追加 revoke 並保留舊 pin，沒有刪除 native consumer、知識或原紀錄。原 native 對象消失、授權撤回或知識已漂移時，仍可撤銷既有登錄；撤銷不等於刪除 dataset／artifact 或免除原有 retention 作業。後續重新登錄需重新確認目前修訂與 CAS，使用新的 mutation key。

資料庫交易使用 SERIALIZABLE READ WRITE、canonical subject lock 與唯一索引。追加 command 與更新 current-head pointer 同一交易提交；pointer 再以先前 binding ID／sequence／fingerprint 作 CAS。owner 加 SHA-256 idempotencyKeyHash 是 command 唯一鍵，查詢亦使用 key hash，再比對原始 key 的 digest，大小寫不依賴資料庫預設 collation。交易或寫入失敗時整筆 rollback，不盲目重送。deadlock／未知 SQL 錯誤回固定 503，不能冒充成功。

## 私有讀取和影響預覽

GET `/api/knowledge/consumer-bindings` 不接受 query，使用 REPEATABLE READ READ ONLY 的同一資料視圖；不更新任何登錄。回傳目前 binding 摘要，包含精確 revision pin、binding fingerprint、sequence、bind／revoke 狀態與 native availability，讓重新整理後仍能執行 CAS 或撤銷。coverage 只回 category、state、scope、limitationCodes 與 registeredConsumerCount，不回內部 owner IDs 或依賴圖。impact-preview 在原 Knowledge read-only transaction 中讀取完整內部 registry，不使用其他連線拼接 head 與 consumer。

每個 owner 最多讀取 2000 個 native／subject binding heads，以 2001 SQL sentinel 拒絕超限，不截斷。讀取 current-head pointer 與配對 immutable binding，不聚合所有累積歷史。正式 adapter 將 native anchors、修訂、events、直接 predecessor 依精確 ID／hash 去重，每批最多 500 筆 SQL 參數，不逐筆執行數千次 authority query。讀取仍重新驗證 native immutable hash、歷史修訂及其 mutation event，沒有把舊 pin 換成新 head。registry 驗證會在伺服器內讀取私人歷史 snapshot 以驗證 immutable digest；它不回到 HTTP，並與僅 SQL digest 的最新 head 摘要查詢分開。

目前 revoke heads 的歷史 pin 與 mutation event 也核對；每類 active consumer 沿用 impact 的 1000 筆上限，超限拒絕，不回傳截斷結果。Prompt 使用 owner-scoped left join 核驗 project／query 關係：native 存在但 parent 權限或關係已損毀時拒絕，不把它誤當成已刪除。

已移除的 native 對象保留 server-recorded ID、版本與 hash，標示 `nativeAvailability=missing`，影響項目為 stale 並提示 native consumer missing；不是聲稱 native 目前仍存在。owner 仍可撤銷該登錄。存在但不可變 hash 已漂移的 native 對象則拒絕整個讀取，不能以 missing 狀態掩蓋損毀。

dataset 與 benchmark_prompt 的 complete 只表示 `native_explicit_revision_bindings_v1` 範圍，不包括未登錄關係或所有資料集。public_api 與 reviewer 仍 unconfigured：現有 public/private 架構沒有 Knowledge 公開輸出 registry，歷史審查者也不等於必須審查此變更的人。content／schema 沿用既有 native mappings，不偽稱所有六類已完成。

API 先驗證 owner，成功和失敗均 private no-store／noindex／no-referrer／nosniff；POST 必須 exact same-origin，本文沿用實際 UTF-8 bytes 的 64 KiB 上限。錯誤不洩漏 SQL、raw snapshot、prompt text 或 request body。公開 Astro 仍只可呼叫原有 leads 與 site-analysis，不新增公共 CORS 或 consumer 權限。

## 後台操作

知識工作台的「資料集與 Prompt 知識依賴」區域先選擇本頁已載入的知識紀錄，按「載入連結與選項」明確讀取登錄摘要與 native 清單。不自動讀取、不自動送出。GET `/api/knowledge/consumer-catalog` 只接受 kind 和選填 afterId；游標是 canonical 正整數，不是權限。每頁 25 筆、SQL 26 筆 sentinel，依 owner 與遞增資料庫 ID 選取後重用 native validators，回安全 ID／version／hash；下一頁不回 raw prompt text。終頁可剛好 25 筆；非 null cursor 必須等於最後可見 ID。兩頁可能觀察不同資料視圖，不宣稱跨頁固定快照；寫入時重新核對 native authority。

新登錄與重新綁定必須按「核對目前修訂」，讀取既有唯讀歷史第一頁的 head，再勾選「我了解這只登錄依賴，不核准訓練或發布」。沒有 head 不補造歷史。舊 pin 與目前 head 不同時可明確重新綁定；已移除 native 仍能選取舊登錄並撤銷。撤銷不要求目前 head，也不修改原生資料集、題目、模型或客戶內容。

每次新操作建立隨機 command key。傳送中或未知 5xx／網路／無法核對的成功回應時，鎖定欄位並保留完全相同的 body 與 key，只能按「重試同一命令」；不偷偷產生新 key。409 清除待送命令，要求重新載入登錄和修訂。401／403 清除可操作資料，直到成功重新載入；卸載後的舊回應不更新介面。此重試狀態保留於目前元件記憶體，不宣稱跨頁面重載或瀏覽器關閉可恢復未確認命令。

## 仍需驗收和完成

新版需要 source-frozen typecheck、fresh node-server build、完整安全 Vitest、mounted Vue 操作契約與桌面／手機實際排版，以及 disposable MySQL 的完整 migration、雙連線 CAS、回讀、owner 隔離、毀損與 rollback。實際通過結果另列於上線核對文件；程式和測試案例存在不代表上述驗收已完成。

完整六類 registry、知識 mutation 同交易 impact event、required reviewer 政策、模型／資料集使用時的依賴過期處置和公開輸出安全架構仍是未完成工作。正式 migration、部署、真資料訓練、LINE／郵件／provider 及客戶發布仍須各自授權和驗收，不能由本機合成測試取代。

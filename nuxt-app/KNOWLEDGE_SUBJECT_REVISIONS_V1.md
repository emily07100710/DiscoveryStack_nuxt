# Knowledge Subject Revisions V1

## 目的與狀態

本規格定義 Entity、Claim 與 Source 的 owner-scoped 語意修訂，以及與每筆修訂同一交易提交的 mutation event。修訂提供可核對的歷史快照，不是完整資料復原、審批、發布或訓練授權。

狀態：IMPLEMENTED（本機程式）；NOT_DEPLOYED。本機驗收結果以[設定與發布指南](docs/CONFIGURATION_READY_LAUNCH.md)的對應紀錄為準。正式 migration 尚未套用，正式資料是否完整涵蓋不在本機實作的證明範圍內。

## Subjects 與語意快照

Subject 由 `ownerUserId`、`kind`（`entity`、`claim`、`source`）及正整數 `id` 唯一界定。所有查詢、鎖定、快照讀取與修訂鏈驗證都使用同一 owner 範圍；不得以名稱或 URL 代替 ID。

快照是固定 schema version 的 canonical JSON，物件鍵與集合順序固定，並計算 SHA-256 `contentHash`。Revision fingerprint 將 owner、subject、序號、種類、內容 hash、前一 fingerprint 與排序後 operations 納入摘要；event fingerprint 則摘要該 mutation event 的相同鏈結欄位。

Revision 編號從 1 開始，同一 subject 的每次實際語意變更增加 1。資料庫唯一鍵限制 owner、kind、subject ID 與 revision number 的組合，避免同一版本被寫入兩次。

`revisionKind` 只有 `legacy_baseline` 與 `mutation`。基線的唯一合法位置是 revision 1，其 operation 固定為 `legacy_baseline`；後續 mutation 不可帶入此 operation。

Entity 快照包含名稱、摘要、類型、識別碼、狀態、可見度、別名、外部識別碼、實體連結、publisher 選擇及 merge redirect。Claim 快照包含 statement、類型、狀態、有效期間、entity links、evidence 關係與引用的 source version 語意。Source 快照包含來源欄位與所有已登錄版本的識別、版本、hash 與時間。

原始 canonical snapshot 僅存於 private revision table，不得從 HTTP history DTO 回傳。快照可能含 entity names、summary、claim statement、alias 與 identifier 等可識別內容，不能宣稱 PII 已全面去識別。

Source canonical URL、locator、excerpt、metadata、provenance 與 notes 等敏感或大型值依語意欄位保存其 digest／既有 hash，而非原文。這種快照不能完整還原原始 URL、摘錄或來源內容。

摘要可用於比較及鏈結驗證，不應被解讀成來源原文、公開內容 bytes 或完整 provenance 的重建材料。未列入快照的欄位也不應被視為已核對。

快照每筆最多 64 KiB；canonical JSON 深度最多 20、節點最多 20,000。各 collection 以 SQL LIMIT 2001 讀取，最多接受 2,000 筆；sentinel 超限即拒絕，不截斷後宣稱完整。

## 版本建立與交易

新建 subject 在建立交易內產生 mutation revision 1 與對應 event。若既有 subject 尚無 revision，首次實際內容變更會先將變更前狀態記為 revision 1 `legacy_baseline`，再以 revision 2 記錄新狀態；基線不代表原始歷史事件，也不推定更早內容。

沒有語意差異的 no-op 不建立 revision 或 event。已有 head 時，變更前快照、hash 與最新 revision 必須一致；若 head 與變更前狀態漂移，交易以 revision conflict 拒絕。

KnowledgeService 在同一 owner transaction 中鎖定 subject、執行既有寫入、重建 after snapshot，並追加 revision 與 event。Revision 與 event 任一寫入或驗證失敗，subject mutation 與歷史記錄一併 rollback。

多 subject 的 revision 追加依 kind 與 ID 排序；實際鎖定也受各寫入路徑的呼叫順序影響，資料庫仍可能發生 deadlock。失敗時交易 rollback，API 回報固定錯誤，不做盲目自動重試。呼叫端須由使用者或受控流程決定是否重新提交。

整體流程為：

1. 由 server-derived owner identity 建立 owner-scoped transaction。
2. 先鎖定並保存每個 subject 的變更前語意快照。
3. 執行原有 Knowledge mutation，收集明確 operation 名稱。
4. 驗證既有 head 與對應 event，以及 head 是否符合變更前快照。
5. 比較變更前後 canonical snapshot；完全相同時不追加，否則依序追加 revision 與對應 event。
6. 任一驗證或資料庫寫入失敗時 rollback 整個 transaction。

Revision 與 event 為 append-only 語意；owner、subject、revision number、fingerprint 與 event/revision 的唯一索引限制重複鏈節。這些約束不替代資料庫權限或正式備份策略。

## 私有歷史讀取

`GET /api/knowledge/revision-history` 僅供 owner session。伺服器先解析 owner，再驗證只有字串 `kind`、字串正整數 `id` 與可選字串 `cursor`；重複／陣列值、未知欄位及錯誤格式均拒絕。API 設 private no-store、noindex、no-referrer 與 nosniff，不新增 public CORS。

Drizzle history read 使用 MySQL `REPEATABLE READ` 與 `READ ONLY`，不合併目前套件會產生無效 SQL 的 `withConsistentSnapshot` 旗標。資料視圖由該交易第一個 nonlocking SELECT 建立，後續一致性讀取沿用此視圖；不得描述成交易開始瞬間已建立 snapshot。此行為符合 [MySQL InnoDB consistent nonlocking reads](https://dev.mysql.com/doc/refman/8.0/en/innodb-consistent-read.html) 的說明。

每頁回傳最多 25 筆，依 revision ID 與 revision number 新到舊排列，驗證每筆相差一號且 fingerprint 鏈相接。內部多讀一筆作為下一頁 sentinel；若資料缺頁、event 對不上或 cursor 預期的下一筆不符，整頁拒絕，不回部分歷史。

Opaque keyset cursor 綁定 owner、subject、before ID、預期 revision number 與 fingerprint，帶 canonical payload checksum，長度上限 1,024 字元。Checksum 只偵測損毀，不是簽章、身份驗證或授權；每次讀取仍重新套用 server owner scope 與 subject scope。

API 不接受任意排序、owner 或 before ID 查詢欄位。跨頁第一筆必須符合 cursor 預期的 revision number 與 fingerprint，後端以此偵測舊頁紀錄缺失、替換或鏈結不連續。分頁期間新增較新的 revision 不會改變已選定的舊頁邊界；checksum 不阻止同一 owner 重建游標，伺服器仍逐筆驗證其實際範圍與鏈結。

成功 envelope 固定為 `{ status: 'success', history }`。History DTO 不含 raw snapshot，且明確標示 `recorded_mutations_only`、`rawSnapshotIncluded: false`、`automaticPublication: false`、`productionActivation: false`、`automaticTrainingAdmission: false`。未知欄位或安全旗標不符時，UI 不呈現任何歷史。

History item 僅投影 revision ID／number／kind、content hash、前一與本次 revision fingerprint、event fingerprint、operations 及 occurredAt。API 不回傳 `canonicalSnapshot`，也不回傳原始 claim、來源全文、excerpt 或 metadata。

錯誤碼映射為：`INVALID_INPUT` → 422、`SUBJECT_NOT_FOUND` → 404、`CORRUPT_STATE`／`REVISION_CONFLICT`／`LIMIT_EXCEEDED` → 409；未預期儲存錯誤固定回 503。錯誤訊息不得包含 snapshot、資料庫錯誤或敏感值。

Owner 驗證錯誤只保留適當的 401／403／503 狀態與固定訊息。所有成功與失敗回應均維持 private headers；不因 API 可由 owner 工作台呼叫而新增 public-site CORS 權限。

UI 只有在 owner 主動選取本頁已載入的 subject 並按下讀取後才送出 GET。切換 subject 或 props 變更會作廢舊請求；分頁只接受目前 opaque cursor 並驗證跨頁排序與鏈結。`legacy_baseline` 明確顯示為基線而非原始舊事件。

UI 僅顯示靜態錯誤訊息，不反映 server 原始錯誤內容。401／403、404、409、422 與 503 分別呈現 owner、subject、歷史一致性、查詢及暫時不可用狀態；錯誤時清除目前頁面，避免把部分鏈呈現成完整紀錄。

## Schema 與安全界線

`0051_knowledge_subject_revisions_v1.sql` 由 migration generation 產生，新增 `knowledgeSubjectRevisions` 與 `knowledgeMutationEvents` 兩表及其索引／外鍵；本次 revision migration 不修改舊表 schema。生成 SQL 不會自動套用。

Revision table 保存 raw canonical snapshot；event table 保存 revision ID、鏈結 fingerprint 與 operations。History API 將兩表關聯後只輸出安全 DTO。私有儲存內容仍需依正式存取政策保護。

本功能不建立六類 consumer registry，不宣告影響範圍完整，不授予 consumer 寫入權。它不提供回復按鈕、CAS 寫入 token、審核角色或 owner approval，也不會自動發布內容、啟用模型或准入訓練資料。

Retention、清除期限、封存與法規刪除流程仍待隱私／資料治理評審。正式 migration apply、production rollout、retention 執行、資料匯入或變更均須另行授權與驗收。

## 驗收與發布狀態

本機驗收須分別核對 canonical snapshot/hash、owner 隔離、legacy baseline 與 no-op、before/head drift、原子 rollback、多 subject deadlock 行為、LIMIT sentinel、keyset continuity、DTO 原始欄位排除及固定錯誤回應。

MySQL read-only snapshot 由 `tests/knowledge-revision-mysql.integration.test.ts` 的雙連線及資料庫唯讀 regression 驗收，確認第二個連線提交期間的後續讀取仍使用本 transaction 第一個 nonlocking SELECT 所建立的視圖。預設安全套件不連資料庫；必須另行 opt-in 隔離測試，跳過不代表通過。

完整本機驗收依序執行 frozen typecheck、fresh node-server build 與 safe Vitest，另核對上述隔離 SQL 與合成介面。實際結果與計數記錄於設定與發布指南；它們不替代正式 TiDB、已登入 owner、有真實資料的介面、備份與部署驗收。

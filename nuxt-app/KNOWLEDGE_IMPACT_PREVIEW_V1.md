# Knowledge Impact Preview V1

DiscoveryStack 的擁有人可在知識工作台預覽實體、主張或來源的已知依賴，判斷哪些知識紀錄、文章及結構化資料需要重新檢查。此版本是私有唯讀預覽，不是完整的六類 Impact Engine，也不會改動文章、准入訓練、啟用模型或公開資料。

原始 Impact Preview V1 使用既有資料表；目前本機程式另接入 [Knowledge Consumer Bindings V1](KNOWLEDGE_CONSUMER_BINDINGS_V1.md)，需要其新增 0052／0053 migration 與先前 Knowledge Subject Revisions 0051。這些 migration 尚未因此套用正式資料庫；新程式未因本機修改自動部署。本機工程的驗收與部署狀態記錄在 [設定與發布指南](docs/CONFIGURATION_READY_LAUNCH.md)。

## 使用入口與權限

`/audit-lab/knowledge` 的「知識變更影響預覽」只使用該頁已載入的擁有人實體、主張與來源清單。唯讀 API 是 `GET /api/knowledge/impact-preview?kind=entity&id=1`，kind 亦可為 claim 或 source。

伺服器先解析擁有人 session，再驗證查詢。僅接受 kind 與正整數 id；未知欄位、陣列與重複參數都不能提供 owner、coverage 或 consumer 權限。回應維持 private no-store、noindex、no-referrer 與 nosniff。公開 Astro 網站的兩個既有 POST 邊界不變，沒有新增 public CORS 或公開 Knowledge API。

## 可追溯的影響範圍

所有判定使用精確 ID 與明確關係，不以名稱、相似文字或頁面提到某主題來猜測依賴。

| 修改對象 | 可核對的關係 | 不作的推論 |
| --- | --- | --- |
| Entity | 明確合併轉指、ClaimEntityLink、ContentEntityLink、作者與 Publisher 設定 | 同名 Entity 不視為同一對象 |
| Claim | 該 Claim 的精確依賴登錄 | 不倒推成所有引用相同 Source 或談到同一 Entity 的文章都受影響 |
| Source | 所有歷史 SourceVersion，以及精確引用該版本的 ClaimEvidence | 不只看最新版本，也不把沒有登錄的文章視為已查完 |

合併轉指包含明確的反向來源與 canonical target，最多十跳；循環、缺失或跨擁有人引用會停止預覽。Claim 與 Source 的關係必須按照依賴方向傳播，不能把上游來源當成 Claim 修改的下游消費者。

## 六類輸出與覆蓋限制

回應固定提供 content、schema、dataset、public_api、benchmark_prompt、reviewer 六個桶。頂層固定 `coverageScope=known_explicit_dependencies_only`、`exhaustive=false`，不得當成整站完整盤點。

content 與 schema 的 `complete` 僅指 `native_knowledge_bindings` 這個明確範圍。文章由已有的 ContentEntityLink 與 draft anchor 決定；JSON-LD 只追蹤現行 composer 真正使用的合格 author 與 publisher。about 與 mentions 不會因有連結就被算進 JSON-LD。

schema 的 `contentHash` 為 null：本次只核對投影輸入，沒有生成含正式 origin、canonical URL 的最終 JSON-LD bytes。`dependencyFingerprint` 不是最終公開輸出雜湊。

本機 dataset 與 benchmark_prompt adapter 現在讀取持久化 native consumer binding，精確對應 GEO manifest ID 與不可變 prompt version ID。其 complete 僅代表 `native_explicit_revision_bindings_v1`，不包括未登錄的 consumer 或任意文字推論。新增 adapter 的獨立驗收狀態見 Consumer Bindings 規格；原始預覽的測試結果不能代替它。

公開 API 與審核人員 adapter 仍 `unconfigured`，介面顯示「尚未接上，無法判定」。沒有建立公開 Knowledge 輸出 registry，亦不將過往審查 actor 視為 required reviewer。所有依賴登錄都不提供訓練或發布權限。

## 快照與讀取上限

資料集合由同一擁有人交易讀取；MySQL 使用 `REPEATABLE READ` 與 read-only consistent snapshot，視圖在第一個 nonlocking SELECT 建立並供後續一致性讀取沿用，不是在交易開始瞬間建立。[MySQL 說明](https://dev.mysql.com/doc/refman/8.0/en/innodb-consistent-read.html)。每個 collection 使用 SQL LIMIT 2001 作為 sentinel，允許最多 2000 筆；多出一筆即停止，不截斷後回完整報告。既有未傳 limit 的 repository 呼叫保留原契約。報告與 adapter 另有項目及 byte 上限。

Graph 與 output 的 SHA-256 使用固定欄位與排序。回應不包含原始主張、來源全文、摘錄、metadata、provenance 或供應商秘密。雜湊供比較快照，不是持久化 revision、compare-and-swap 授權、冪等寫入憑證或 owner approval。

影響預覽也在同一唯讀交易讀取 Entity／Claim／Source 的最新語意修訂摘要，每個 owner 與 subject 僅一筆，最多 2000 筆並使用 2001 sentinel。查詢不受歷史每頁 26 筆內部上限影響。資料庫在 SQL 內計算私人 snapshot 的 digest、byte 長度與 owner／subject 識別；伺服器核對 revision fingerprint 及配對 mutation event，原始 snapshot 不進入此 head 摘要的 SQL 回應或 HTTP DTO。另有 registry 歷史 pin 的伺服器內驗證，會讀取私人 immutable snapshot，仍不回 HTTP。

精確 adapter 可另外提供 semantic `revisionFingerprint` pin；只有 Entity、Claim 與 Source 支援此欄位，SourceVersion 與 Content 仍使用各自原有版本契約。提供的修訂編號、content hash 與 fingerprint 必須同時符合同一 head；缺少 head 或任一欄位不符時保留該精確 ID consumer，但標示 stale，不冒充最新版本。Graph fingerprint 包含 head 摘要；consumer lineage 分開保存預期 pin 與目前 head 的安全 hash，避免只換 pin 或 head 時產生相同 dependency fingerprint。未提供任何 pin 的舊 adapter 契約保持相容。

這個 head 核對以不可變修訂 ledger 的最新 head 為基準，不是對所有歷史頁的完整稽核，也不將當下可變資料重新認證為該修訂。唯讀預覽不新增或更新依賴關係；只有獨立 owner binding mutation 可登錄、重新 pin 或撤銷。公開 API 與 required reviewer 尚未接入，所有發布與訓練權限保持不變。

未知 subject 回 404；無效查詢回 422；圖不一致、循環或超限回 409；未預期的儲存錯誤回固定的 503，不回傳原始資料庫錯誤。

## 仍需完成的完整 Impact Engine

不可變 Entity／Claim／Source 語意修訂及同交易 mutation event 已有本機 foundation；設計與界線見 [Knowledge Subject Revisions V1](KNOWLEDGE_SUBJECT_REVISIONS_V1.md)。這不等於完整 Impact Engine，也不改變本文件中 impact-preview 自身「既有正式資料庫不需新增 schema」的範圍說明。

完整 V2 §11.3 仍需六類 consumer 的正式 registry、實際版本與依賴登錄、可核對的 affected-consumer 清單、追加式 impact event、reviewer 政策與角色，以及 CAS／冪等寫入和併發控制。現有 revision history 不代表這些能力已接通；公開 Knowledge API 仍須在 Astro／Nuxt 隔離下另行完成架構與安全驗收。

這些工作不能由唯讀快照、revision event、空 adapter 或本機測試取代。Revision V1 的 migration 與發布、資料收集、訓練及模型使用仍須各自通過授權、品質及撤回條件；本段不表示 migration 已套用。

## 驗收要求

本機驗收包含精確依賴與同名排除、owner 隔離、來源歷史版本、合併／循環、缺失引用、hash 漂移與排序穩定性、SQL 讀取上限、實際 GET handler 權限與錯誤，以及 Vue 元件的載入、未知 coverage、錯誤與過期回應狀態。完成 frozen typecheck、fresh node-server build 與完整 safe Vitest 後，結果另記入發布指南。

本機、合成 fixtures、mock MySQL transport 或 Vue 渲染測試不能證明正式資料、瀏覽器視覺、provider、模型品質或部署已通過。

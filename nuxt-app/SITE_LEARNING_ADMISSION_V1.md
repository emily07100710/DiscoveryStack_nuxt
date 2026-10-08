# 網站觀察資料的學習准入 V1

這是獨立於正式發布收據的資料治理流程。網站已公開、LINE 核准發文或擁有人核對公開版本，都不代表客戶同意模型改進用途。

## 操作順序

1. 在既有來源授權流程保存可核對的客戶模型用途同意、來源權利與保存期限。擁有人申明證明存在，不是代客戶同意，也不是法律效力的自動驗證。
2. 在「學習閉環 → 網站成效資料准入」明確選擇客戶授權與已核驗的特定網站版本。兩個確認欄位預設不勾選。
3. 日後執行既有成效收集時，伺服器在資料來源呼叫前後重新核對授權、來源、確認版本與時間。只有一致的完整證據才保存學習用途標記。
4. 基準期與追蹤期快照都必須帶同一份收數時證據，擁有人才能審查這一版成效資料。個資檢查與觀察限制理解須另行確認。
5. 明確要求資料釋出時才重新查驗網站；釋出為去識別化候選與 manifest 摘要，不會開始訓練、部署模型或發布客戶文章。
6. 接入授權可撤銷。即使網站不可用或來源授權已失效，後台仍保留歷史接入紀錄的撤銷入口。

## 證據與隔離

- 契約 `site-learning-collection-proof-v1` 固定十一個欄位：版本、接入指紋、網站確認指紋、來源授權 ID／指紋、來源指紋、接入時間、授權批准時間、到期時間、保存天數與同意版本。
- 存在額外欄位、存取器、錯誤雜湊或不一致欄位時不保留此標記。只保存最低限度證據，不複製供應商原始回應、客戶同意文件或登入資料。
- 快照取得時間不得早於接入或授權批准、不得早於量測視窗結束、不得在未來或到期後，且必須在保存期限內。
- 舊的無證據快照不會補標記；只有追蹤期帶標記也不能把原本的基準期升級。
- 在供應商等待、審查或釋出等待期間撤銷、換版或修改證據，會停止准入。不得回退到較舊但曾有效的授權。
- 准入與撤銷、審查寫入既有 `contentOperationEvents`，並核對 owner、entry、client、calendar、事件種類及 record fingerprint。雜湊是完整性檢查，不是客戶簽章或匿名保證。
- 存量成效紀錄仍保留原本 `consentStatus: unknown`、`learningCandidate: false` 與非正式收據邊界。本流程不改寫已發布狀態，也不進入引用模型資料集。
- 釋出固定 `modelTrainingAllowed: false`、`citationTrainingEligible: false`。樣本數與品質 gate 仍可能阻擋資料集；准入不等於模型已訓練或商業成效已證實。

## API 與安全

- `GET /api/content-operations/site-learning/workspace`：僅有界、owner 隔離的本機資料讀取；不呼叫網站、資料供應商或訓練。
- `POST /api/content-operations/entries/:id/site-learning-opt-in`：來源授權與網站版本核對後才接入。
- `POST /api/content-operations/entries/:id/site-learning-revoke`：撤銷既有接入，不依賴網站可用性。
- `POST /api/content-operations/site-learning/outcomes/:id/review`：核對成效快照、目前權限、公開版本與個資後，批准或排除特定資料版本。
- `POST /api/content-operations/site-learning/release`：使用者明確操作的 fresh recheck 與候選摘要；不是訓練 API。
- 驗證擁有人先於解析 body 與建立資料庫依賴；寫入要求同 origin、限制 body 大小與精確欄位，回應禁止快取及搜尋索引。不開放 CORS。
- GET 顯示與 release 回傳的 DTO 必須實際相容，受阻的舊資料允許空 grant 指紋，但不可送出審查命令。
- 查讀 event／outcome 有界；超出範圍或證據損壞採保守阻擋。注入測試 repository 時，缺少學習權限 resolver 不得暗中連正式資料庫。

## 上線界線

本階段不新增資料庫結構，使用既有授權與事件表；部署仍需先套用先前累積的 0051–0055 遷移。自動訓練、排程發文、真實客戶收數與 Do Alignment 正式接收端部署維持各自獨立的設定與核准。

本機合成測試、建置與 MySQL 遷移演練，不等於 TiDB、正式網站／LINE／供應商或模型的實測。實際執行結果及尚未驗收項目記於 `docs/CONFIGURATION_READY_LAUNCH.md`。

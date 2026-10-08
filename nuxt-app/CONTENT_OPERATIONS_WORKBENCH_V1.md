# Owner Content Operations Workbench V1

## 定位與邊界

`/audit-lab/content-operations` 是 DiscoveryStack 的 owner-only 私有營運工作台，使用既有 `owner` layout，不加入客戶登入，也不加入公開網站導航。頁面以白話呈現客戶網站設定、內容月曆、每篇內容的 pipeline 狀態、人工 review、發布失敗／重試與 Outcome Learning 資料是否存在。

本分支只新增 UI 與 contract tests。它不新增 server route，不新增 mock server，不改變任何 endpoint，不修改 database、migration、content calendar engine、delivery engine、outcome engine、SEO/GEO core、公開 Astro 網站或公開 Nuxt 頁面。

頁面 metadata 固定使用 `noindex, nofollow, noarchive`。它只在既有 owner-only navigation 內新增「內容營運」連結，沒有公開導航入口。

## 固定 API contract

頁面只使用下列既有／平行 runtime branch 會提供的 contract；本 UI branch 不自行實作 API：

```text
GET /api/content-operations/workspace
POST /api/content-operations/clients
POST /api/content-operations/calendars
POST /api/content-operations/calendars/{id}/replan
POST /api/content-operations/calendars/{id}/materialize
```

Workspace response 的形狀為：

```ts
type Workspace = {
  clients: Client[]
  calendars: Calendar[]
  entries: ContentEntry[]
  runs: Run[]
  outcomeAssessments: OutcomeAssessment[]
  capabilities: {
    schedulerAvailable: boolean
    generationExecutorConfigured: boolean
    firstPartyPublisherConfigured: boolean
    outcomeCollectionConfigured: boolean
  }
  limitations: string[]
}
```

建立客戶使用完整 body：`displayName`、`canonicalSiteOrigin`、`framework`、`publicationTransport`、`timeZone`、`defaultCadenceDays`、`defaultPublishLocalTime`、`monthlyBudgetUnits` 與 `idempotencyKey`。建立月曆使用 `clientId`、`productionPlanId`、計畫期間、發布時間、`cadenceDays`、每月預算、單篇成本、每月及全計畫數量上限、`catchUpPolicy` 與 `idempotencyKey`。Replan 額外帶 `expectedPlanFingerprint`；materialize 帶 `expectedPlanFingerprint` 與 `idempotencyKey`。

所有 mutation 都經由單一 `post()` wrapper，使用 `$fetch`，成功後 `refresh()` workspace。wrapper 在 `saving` 期間直接拒絕重複送出。每項操作使用 secure random idempotency key；遇到不確定的 request failure 時保留原 key供重試，只有成功取得 response 後才輪替，避免「server 已寫入但 response 遺失」時因新 key 建立重複資料。這些 request 只在使用者明確送出表單或按鈕時發生，測試不呼叫真實 route。

## UI sections

### Overview

Overview 顯示啟用中的客戶、本月 `plannedLocalDate` 內容數、下一篇發布日期、等待人工 Review、Ready to publish、Retry wait / Failed、已發布與 Outcome 有資料的篇數。所有數字均直接由 workspace response 的 clients、entries 與 outcomeAssessments 推導，不顯示假的百分比、排名提升、流量提升、ROI 或 LLM 提及數。

沒有 clients 與 entries 時顯示明確 empty state。沒有下一篇時顯示「尚未排程」，不以預設或虛構日期補值。

### 客戶網站設定

客戶表單只允許 Astro／Nuxt 兩種 framework，送給 API 的 canonical value 分別為 `astro`／`nuxt`；publication transport 只允許 First-party Git／First-party Signed API。沒有 WordPress 選項。頻率只允許每 3、7、15、30 天；網站欄位要求 HTTPS origin，發布時間使用 local time。資料庫 ID 會在送出前轉為 number，不以表單字串冒充數字 contract。

建立後會 refresh workspace，並在 client card 顯示 API 回傳的 status 與 publisher capability。若 first-party publisher 尚未設定，畫面明確顯示「第一方網站發布器尚未設定」。

### 內容月曆

內容月曆表單包含客戶、Production Plan ID、計畫開始／結束日、發布時間、3／7／15／30 天頻率、每月預算、單篇預設成本、每月最多篇數、全計畫最多篇數，以及 Skip missed／One catch-up。沒有客戶資料時，月曆提交按鈕停用並顯示先建立客戶的提示。

已建立的月曆提供可編輯的重新規劃表單，以及建立到期內容工作兩個動作，分別對應固定 replan 與 materialize endpoint；兩者均帶 `expectedPlanFingerprint`，避免以過時計畫無條件覆蓋。沒有 fingerprint 或 calendar 已 blocked／paused／archived 時，不允許 materialize。

### Calendar 與 content pipeline

Calendar card 顯示客戶、計畫期間、發布時間、頻率、預算、成本、missed content policy 與下一步操作。Entry card 顯示 `plannedLocalDate`、title/topic、content type、language、status、framework/target、approved draft 狀態、risk gate 狀態與下一動作。

Pipeline 以文字顯示：

```text
已排程 → 等待產生 → 等待人工審核 → 可以發布 → 發布中 → 已發布 → 成效觀察 → 學習候選
```

UI 使用 durable runtime 的 canonical entry states：`planned`、`materialized`、`awaiting_generation`、`awaiting_review`、`ready_to_publish`、`publishing`、`delivered`、`completed`、`cancelled`、`skipped`、`blocked`。Run 使用 `state`，Outcome 使用 `assessmentStatus`。`blocked`、`failed` 與 `retry_wait` 是獨立狀態，不會透過綠色樣式或正向文案偽裝成成功。Status 同時使用文字與 class，不能只靠顏色辨識。錯誤、retry 與能力不足都保留白話提示；技術欄位只放在 collapsed Advanced details。

### 能力與限制

能力卡片以 workspace response 的 `capabilities` 為唯一來源：

| Capability | false 時的固定訊息 |
|---|---|
| `schedulerAvailable` | 排程器尚未接通 |
| `generationExecutorConfigured` | 自動內容生成尚未接通 |
| `firstPartyPublisherConfigured` | 第一方網站發布器尚未設定 |
| `outcomeCollectionConfigured` | 成效資料尚未自動回收 |

UI 存在本身不代表能力可用。頁面不會因為表單或按鈕存在，就將排程、生成、發布或成效回收說成已接通。

### Advanced details

`details` 預設折疊。只有展開後才顯示 Client ID、Calendar ID、Entry ID、Production Plan ID、plan fingerprint、approved draft ID、evidence hash、content hash 與 Run ID。主要流程使用客戶名稱、計畫名稱、日期與白話狀態，不把技術 ID 當成主要操作語言。

## 2026-10-08：網站草稿審核階段

Workbench 新增中性 `awaiting_site_review`／`draft_received` 顯示及獨立網站審核 pipeline step。單 target entry 與 multi-target binding 都可顯示經 server exact owner/entry/target/checksum 驗證的九欄歷史入稿回執。UI 再驗證 receipt shape，明示「不代表文章目前狀態或已發布」，不呈現 post ID/hash 作主要語言，也不將入稿狀態標成綠色已發布。

等待網站審核時不提供下一步執行／重送；週更送審頁也區分客戶同意與網站審核，禁止把已收稿項目重新送審。其他未收稿的正常送審行為不變。實際網站老師核准或正式發布必須另有可信流程，不能由此歷史回執推定。

## 狀態處理

### 2026-10-08：網站發布核驗紀錄

入稿回執改用純歷史事實「網站已收到草稿（歷史回執）」，不推定老師目前仍待審。內容工作台另顯示發布核驗紀錄：公開快照與送入版本相符、公開但內容不同、舊紀錄無法比對、檢查當時未公開或已封存；另外區分公開快照相符但私人草稿有未發布修改。每筆明示核驗時間及之後狀態可能改變，不聲稱即時監控或已刪除。

只有 server projection 提供 exact eligible target 才顯示「核對網站發布狀態」。按鈕明確觸發上述 owner-only 核驗 API，不在 mount／refresh 自動查網站、不提供「我已發布」覆寫。保存 uncertain request key，驗證 verified／workflowChanged=false／learningAuthorized=false 的回應 envelope，再重新讀 workspace；失敗維持安全錯誤及歷史紀錄，不宣告發布。每週送審頁保留不可重開已入稿版本的限制，並引導至內容工作台核驗發布結果。

網站觀察與 DS 工作流程分開：核驗本身不發布、不取得客戶同意，也不推進 delivered／學習。元件再驗證精確摘要欄位與組合；未知或矛盾資料維持未核驗。本段的完整 authenticated owner／teacher、正式資料庫與正式網站仍須另行驗收。

初次 workspace 載入顯示 loading；HTTP 401／403 顯示 owner-only unauthorized 說明；其他載入錯誤顯示 error 並保證沒有執行寫入。沒有資料時顯示空狀態。Mutation 期間顯示 saving、停用所有 mutation 按鈕並阻止第二次送出；成功後顯示 success notice 並 refresh；失敗後顯示白話 error notice，不宣稱操作完成。

## Responsive 與 accessibility

頁面使用現有專案 CSS，不引入 UI library。桌面使用多欄 grid，寬度較窄時切換單欄；pipeline 可水平滾動，Advanced details 與 status 文案在手機仍可讀。`aria-live` 用於 loading／notice，error 使用 `role="alert"`，pipeline 使用文字 labels，status 不依賴顏色。

## Testing contract

`tests/content-operations-workbench.contract.test.ts` 使用 source-text contract assertions 與 mocked `$fetch` boundary。測試驗證 owner layout、robots metadata、固定五個 API endpoint、完整 request fields、cadence、framework、transport、WordPress absence、能力 false 的 truthful messages、無假 KPI、loading／error／empty／unauthorized／saving／success、duplicate-submit guard、status text、collapsed Advanced details、mobile CSS 與 owner navigation。

測試不呼叫真實 route，也不引入 mock server。Full Vitest、migration 與 deploy 均不在本分支執行範圍。

## 明確限制

此頁面只提供 workspace projection 與 mutation controls；資料真實性、owner authorization、client/calendar/entry lifecycle、發布能力、scheduler、generation executor、outcome collection 與所有 persistence 由既有／平行 runtime contract 負責。沒有 API response 時，頁面只能顯示 empty 或 not available，不會用本地 mock data 補出客戶、文章、日期、成本、成效或能力。

頁面沒有執行瀏覽器視覺 QA，因此不能宣稱 visual parity 或完整 runtime UI 通過。此次驗證以 source contract、TypeScript、targeted tests、既有 regression 與 production build 為主。

## References

### 2026-10-08：明確接入成效觀察

內容工作台新增「接入成效觀察」二階段確認。入口來自伺服器投影，不由瀏覽器提交發布時間、網址、文章 hash、同意或發布權威。只有核驗未超過五分鐘、公開版本相符，且目前原稿、最新人工審核、風險、來源、網址身份及必要逐篇客戶同意均有效時，才顯示可確認。

`POST /api/content-operations/entries/{id}/site-measurement-confirm` 只接受 `targetRowId`、`expectedPublicationFingerprint`、`confirmed: true`、`idempotencyKey`。同源 owner 驗證先於 body、資料庫及網站存取；請求上限 1024 bytes、簽章狀態回應上限 4096 bytes。確認前重新讀取網站簽章快照；寫入獨立 append-only `site_measurement_confirmed` 事件，不改 entry／原草稿 attempt／run、不發布、不呼叫成效 provider、不授予訓練權限。回應遺失時保留相同 key／版本；成功須嚴格驗證 envelope 並重新讀 workspace。

「已確認」是歷史接入意願，不是現在仍公開、已收數或已訓練。收數前後仍重核網站與授權；未公開、版本不同、資料不完整、核驗過舊、同意失效各有繁體提示。這輪只支援已保留完整網址身份與原請求指紋的單一網站、人工審稿入稿；舊紀錄缺身份、routing 多目標與機器授權路徑維持阻擋，不能由此確認補造原發布權威。

[1]: https://github.com/emily07100710/DiscoveryStack_nuxt — DiscoveryStack_nuxt repository.

### 2026-10-08：獨立的網站成效資料准入

「學習閉環」新增網站成效資料准入區，分開顯示客戶用途授權綁定、成效版本審查與明確資料釋出。模型用途與 LINE 發文同意分開核對；確認欄位預設不勾選。受阻的無證據舊紀錄可以查看，但不能審查成合格資料。既有接入紀錄在來源或網站不可用時仍保留撤銷入口。真實 core 的 DTO 與元件使用相同 nullable／釋出摘要契約，不以人工組裝測試取代串接。詳見 [准入契約](SITE_LEARNING_ADMISSION_V1.md)。

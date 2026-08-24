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

## 狀態處理

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

[1]: https://github.com/emily07100710/DiscoveryStack_nuxt — DiscoveryStack_nuxt repository.

# PROJECT_MAP — DiscoveryStack

> 產生者：Claude Code `/project-map`（三階段深度接管：靜態偵察 → 4 個唯讀 specialist 平行深掃 → 主 Claude 逐條複驗）
> 初次掃描：2026-08-31 ／ `HEAD` = `898b6f9`
> **本次改版：2026-08-31 ／ `HEAD` = `d51d403` ／ working tree：clean**
> **驗收基準：[`nuxt-app/GEO_ENGINEERING_SPEC_V2.md`](nuxt-app/GEO_ENGINEERING_SPEC_V2.md)（2,251 行，本次已逐條讀完）。** §8 的每一個狀態都對得上規格中的某一條 MUST。
> **若本檔與程式碼衝突，以程式碼為準。若本檔與 v2.0 規格衝突，以規格為準。**
> 標記 ✍️ 的區段為人工填寫，**任何自動化流程不得覆寫**。
> 增量更新用 `/project-status`；抓 bug 用 `/deep-audit`。

---

## 0. 這個專案要幹嘛 ✍️

### 使用者原話

> DiscoveryStack 是一套「AI 建站＋企業系統＋SEO／GEO 長期營運平台」。
>
> 客戶可以：
> - 輸入需求，一鍵產生可互動的網站預覽。
> - 選擇官網、部落格、電商、AI 助手、LINE、預約、金流、發票或 ERP／CRM。
> - 確認後付款，由我們代管程式碼、網域、部署與更新。
> - 自己透過媒體庫、區塊編輯器或自然語言修改網站。
> - 選購每 3／7／15／30 天自動產出文章。
> - 持續追蹤 Google、GA4、AI 模型提及、引用、流量與轉換。
> - 已經有網站的客戶，也能只使用診斷、GEO 優化、內容營運與成效追蹤。
>
> **我們的護城河**
>
> 護城河不是「會用 AI 寫文章」，而是每次服務都會累積一條可驗證的資料鏈：
>
> 網站問題 → 修改內容 → 發布版本 → AI／Google 是否引用 → 流量與轉換變化 → 哪種策略真正有效
>
> 長期會形成我們自己的：
> - 客戶網站 Entity／Claim／Evidence 知識庫。
> - 不同行業的內容策略、引用來源與競爭情報。
> - 修改前後的真實成效資料。
> - 安全、可回滾、可跨網站執行的自動化系統。
> - 專屬的診斷、內容選擇與策略排序模型。
>
> 我們不需要從零訓練一個通用大語言模型。前期使用 Qwen 等成熟模型產生內容；我們自己的模型則學習「哪個網站有什麼問題、應該先改什麼、什麼內容最可能有效」。這才是難以被複製的部分。
>
> **最後期許**
>
> 理想狀態是讓一間小公司甚至一個人，也能管理大量客戶：
>
> AI 自動建站 → 自動部署 → 自動內容營運 → 自動發布 → 自動追蹤 → 自動學習 → 自動改善
>
> 人只處理付款、特殊需求、法律風險與真正異常的案例。
>
> 我們最終不是另一個 Wix、SEO 工具或文章生成器，而是企業網站在 AI 搜尋時代的「建置、營運、觀測與學習作業系統」。

### 給誰用

- **Owner（我方營運者）**：`/audit-lab/**` 私有工作台，單一 owner（`OWNER_OPEN_ID`）。
- **Customer（付費客戶）**：`/customer/managed-sites/**` 自助編輯器，走獨立的 managed-site session。
- **公眾**：`public-site/`（Astro 靜態站），只能打兩支 API。

### 完成的定義（使用者裁定）

> 「這是一個真正的商業計劃，不是 MVP，所以該要有的最後都要有。」

因此本地圖的判定基準是**完整商業產品**，不是「先能動就好」。`GEO_ENGINEERING_SPEC_v2.0` 全部區塊皆屬產品範圍。

### 使用者確認的必要功能（這是 ⚪ MISSING 判定的唯一授權來源）

1. **真實 provider 連線** — Qwen／Bailian／GEOFlow／AutoGEO 實際發出並取回內容。
2. **爬蟲與真實頁面證據** — 抓取客戶網站原始／渲染 HTML 作為診斷依據。
3. **Entity Graph／Claim Ledger／Source Quality Graph** — 護城河的知識庫底座。
4. **真實部署** — migration 實際套用、網域購買、DNS／TLS、正式上線。
5. 以及 v2.0 規格其餘全部區塊。

### 明確不做的事

- 不從零訓練通用大語言模型。
- `services/geoflow/`（Laravel）、`services/autogeo/`（Python）為**原始碼匯入的第三方**，不接進任何 runtime、不安裝、不部署。已複驗：`nuxt-app` **零** import 這兩個目錄。

---

## 1. 技術棧

| 層 | 用什麼 | 錨點 |
|---|---|---|
| 私有 App／API | Nuxt 4.5.2（Vue SFC）＋ Nitro/H3 1.15.11 | `nuxt-app/nuxt.config.ts` |
| ORM／DB | Drizzle 0.45.2，MySQL/TiDB 方言，`mysql2` | `nuxt-app/server/database/schema.ts` |
| 驗證 | 手寫 `parseXxxInput` 為主，zod 4.1.12 為輔（49 檔） | `server/*/normalization.ts` |
| 認證 | `jose` 6.2.9（HS256 JWT），OAuth 授權碼流程 | `server/utils/auth.ts#requireOwner` |
| 物件儲存 | `@aws-sdk/client-s3` ＋ presigner；`sharp` 0.34.3 影像處理 | `server/managed-sites/media-vault/sharp-processor.ts` |
| 網域解析 | `tldts` 7.4.11 | `server/utils/publicSiteAnalysis.ts` |
| 排程 | Nitro `experimental.tasks` in-process cron | `nuxt.config.ts#nitro.scheduledTasks` |
| 測試 | Vitest 4.0.18（`fileParallelism: false`） | `nuxt-app/vitest.config.ts` |
| 型別 | TypeScript 5.9.3 ＋ `vue-tsc` 3.3.10 | `pnpm typecheck` |
| 公開站 | Astro 7.2.4 靜態輸出 ＋ Vue 3.5.41 islands | `public-site/astro.config.mjs` |
| 第三方（僅原始碼） | Laravel 12 / PHP 8.3；Python | `services/geoflow/`、`services/autogeo/` |

三個獨立 lockfile（`lockfileVersion: 9.0`），**無 root workspace 統籌** — 命令必須在各自 app 目錄執行。

---

## 2. 目錄地圖

```
DiscoveryStack_nuxt/
├── nuxt-app/                      ★ 私有 owner 工作台 ＋ API runtime（985 檔）
│   ├── nuxt.config.ts             routeRules / runtimeConfig / 4 個 cron
│   ├── pages/                     17 個 .vue（srcDir 是 repo root，不是 app/）
│   │   ├── audit-lab/             8 個 owner 工作台分頁
│   │   └── customer/managed-sites/ 客戶自助端（index + editor）
│   ├── layouts/owner.vue          owner 導覽殼（**無任何 auth 邏輯**）
│   ├── server/
│   │   ├── api/                   233 個 endpoint（Nitro 檔案式路由）
│   │   ├── middleware/            只有 public-cors.ts
│   │   ├── utils/                 auth / oauth / provider-vault / publicCors / publicSiteAnalysis
│   │   ├── database/              schema.ts（149 表）＋ migrations/（0000–0033）
│   │   ├── tasks/                 7 個 defineTask（**只有 4 個被排程**）
│   │   ├── seo-geo-core/          診斷→策略→計畫→草稿→風險閘→審查（樞紐）
│   │   ├── content-operations/    跨 engine 編排層（唯一的 orchestrator）
│   │   ├── managed-sites/         71 檔：ordering / provisioning / live-connectors
│   │   │                          / media-vault / page-editor
│   │   ├── geo-outcome-model/     26 檔：資料集 / 模型 / ModelOps 治理
│   │   ├── system-factory/        22 檔：Frappe/ERPNext 租戶工廠
│   │   ├── measurement-collection/ GA4 / GSC / LLM 快照採集
│   │   ├── first-party-publishing/ GitHub Contents ＋ signed API 發布
│   │   ├── publication-routing/   多通道發布計畫與 receipt
│   │   ├── geoflow-runtime/       Qwen transport（含 target-guard）
│   │   ├── ⚠ market-intelligence/ authority-intelligence/ delivery-automation/
│   │   │  first-party-content-site-kit/ geo-content-evaluation/
│   │   │                          ← 5 個 engine 只被測試 import，production 不可達
│   │   └── …
│   ├── tests/                     153 個 .test.ts ＋ fixtures/ helpers/ support/
│   └── *_V1.md / *_V2.md          ~48 份 engine 規格（每個 engine 一份）
├── public-site/                   ★ 公開 Astro 品牌／SEO 站（66 檔）
│   ├── src/lib/publicApi.ts       唯一對外出口（兩條路徑白名單）
│   ├── src/content/pages/{en,zh-hant}/  16 份雙語 Markdown
│   └── src/components/            13 個元件（Vue islands ＋ Astro）
├── services/                      ⛔ 第三方原始碼匯入，不接 runtime（2073 檔）
│   ├── geoflow/                   Laravel 12 內容引擎
│   └── autogeo/                   Python（見 ADAPTATION_BOUNDARY.md）
├── infrastructure/frappe/         System Factory 的不可變映像建置
├── ml/                            Python page-evidence 採集工具 ＋ runbook
├── .github/workflows/             ci.yml（每次 push／PR 跑兩 app）＋ frappe-system-factory.yml
├── Dockerfile                     ★ 真正使用的（只 COPY nuxt-app/）
└── package.json                   ⛔ hosting template 殘留（React/tRPC/wouter，非真實技術棧）
```

---

## 3. 進入點

| 入口 | 檔案 | 啟動方式 |
|---|---|---|
| 私有 App | `nuxt-app/nuxt.config.ts` | `cd nuxt-app && pnpm dev`（:3000）；production `node .output/server/index.mjs` |
| Owner 頁面 | `nuxt-app/pages/**/*.vue` | Nuxt 檔案式路由；`/` 302 → `/audit-lab` |
| HTTP API | `nuxt-app/server/api/**/*.<method>.ts` | Nitro 檔案式路由，自動註冊 |
| 全域 middleware | `server/middleware/public-cors.ts` | 每個請求都跑，但只對兩條白名單路徑作用 |
| 排程（已註冊 4 個） | `nuxt.config.ts#nitro.scheduledTasks` | `model-improvement:collect`（`0 18 * * *`）／`content-operations:geo-modelops-tick`（`*/15`）／`managed-sites:editor-tick`（`*/5`）／`system-factory:provisioning-tick`（`*/5`） |
| 排程（**未註冊 3 個**） | `server/tasks/content-operations-{,execution-,measurement-}tick.ts` | ⚠ 無 cron、無 `runTask` 呼叫者 — 永遠不會執行 |
| 公開站 | `public-site/src/pages/**` | `cd public-site && pnpm dev`（:4321）；輸出靜態 `dist/` |
| 容器 | root `Dockerfile` | `NITRO_HOST=0.0.0.0`＋release marker guard |

---

## 4. 架構圖

```mermaid
flowchart TD
  A["public-site (Astro)<br/>src/lib/publicApi.ts"] -->|"POST /api/leads<br/>POST /api/site-analysis"| B["server/middleware/public-cors.ts"]
  C["pages/audit-lab/*.vue<br/>layouts/owner.vue"] -->|"$fetch /api/**"| D["server/api/** (Nitro)"]
  CU["pages/customer/managed-sites/editor.vue"] -->|"customer session"| D
  B --> D
  D --> E["server/utils/auth.ts#requireOwner"]
  E --> F["server/audit/repository.ts<br/>getOwnerDatabaseUserId"]

  D --> G["seo-geo-core<br/>診斷/策略/計畫/草稿/風險閘/審查"]
  D --> H["content-operations<br/>orchestrator（唯一編排層）"]
  D --> I["measurement-collection"]
  D --> J["managed-sites<br/>ordering / provisioning / page-editor"]
  D --> K["geo-outcome-model / ModelOps"]
  D --> L["llm-visibility"]

  H --> G
  H --> M["publication-routing"]
  H --> N["first-party-publishing<br/>git / signed-api"]
  H --> O["outcome-learning"]
  H --> P["geo-content-quality"]
  G --> Q["geo + geoflow-runtime<br/>Qwen / Bailian / reference-rules"]

  I --> H
  I --> L
  I -.->|"resolver 永遠 null"| R["GA4 / Search Console"]
  N --> S["客戶網站 (GitHub Contents / signed HTTP)"]
  Q --> T["外部 LLM provider"]
  J -.->|"對端不存在"| U["/v1/managed-sites/* broker sidecar"]

  V["server/tasks/ 4 個已排程 cron"] --> J
  V --> K
  V --> W["model-improvement"]
  X["server/tasks/ 3 個未排程"] -.->|"永不觸發"| H

  G --> Y["server/database/schema.ts<br/>149 表 / 34 migrations"]
  H --> Y
  I --> Y
  J --> Y
  K --> Y

  Z["孤兒 engine ×5：market-intelligence /<br/>authority-intelligence / delivery-automation /<br/>first-party-content-site-kit / geo-content-evaluation"] -.->|"僅測試可達"| Y
```

---

## 5. 一條真實路徑：GEO 內容營運閉環

這是護城河那條「網站問題 → 修改內容 → 發布版本 → 是否被引用 → 成效 → 哪種策略有效」在程式碼中的實際樣貌。**斷點以 ⚠ 標示。**

### 前段：證據 → 計畫 → 草稿 → 人工審查

1. **證據授權** — `pages/audit-lab/seo-geo.vue#submitEvidenceApproval` → `POST /api/seo-geo/evidence-approvals` → `server/seo-geo-core/repository.ts#createEvidenceApproval`。往後每一步都靠 `repository.ts#resolveApprovedEvidenceSnapshot` 取回 `{refs, context, hash}`；**這個 `hash` 是整條鏈的錨**。
2. **診斷** — `seo-geo.vue#runGuidedDiagnosis` → `POST /api/seo-geo/diagnose` → `server/seo-geo-core/service.ts#runOwnerPublicDiagnosis` → `server/utils/publicSiteAnalysis.ts#analysePublicHomepage` ＋ `server/seo-geo-core/diagnosis.ts#createDeterministicDiagnosis` → `repository.ts#saveDiagnosis`。
3. **策略** — 同一支 `runOwnerPublicDiagnosis` 在 `engine === 'deterministic-diagnosis-v1'` 且有 findings 時直接呼叫 `repository.ts#createStrategyRecommendations`。
4. **生產計畫** — `seo-geo.vue#createGuidedPlan` → `POST /api/seo-geo/production-plans` → `repository.ts#createProductionPlan`，用 `#assertProductionPlanEvidenceSnapshot` 綁死步驟 1 的 hash。
5. **生成＋風險閘** — `POST /api/seo-geo/production-plans/{id}/generate` → `server/seo-geo-core/service.ts#runOwnerProductionDeliverableInternal`。兩段草稿：base draft → `#evaluateContentRisk` ＋ `#withEvidenceMaterialGate` → `server/geo/optimise.ts#optimiseGeoDocument` 做 selected-rule 優化 → 再跑一次風險閘 → job 落在 `needs_human_review` 或 `blocked`。
   - ⚠ **斷點 A** — `server/seo-geo-core/productionProviders.ts#resolveProductionRuntimeProviders`：`NUXT_CONTENT_DRAFT_PROVIDER` 未設或憑證缺失時回 `fallback('content-provider-not-configured')`，改用 `contentGenerator.ts#createDeterministicScaffoldGenerator`，`provenance.providerExecution = false`。**這不是造假**（誠實落 provenance），但會讓下游機器授權永久拒絕（見斷點 C）。
6. **人工審查** — `seo-geo.vue#submitGuidedReview` → `POST /api/seo-geo/reviews` → `repository.ts#createContentReview`，四種裁決：`approved_for_preview` / `approved_for_delivery` / `changes_requested` / `rejected`。

### 中段：客戶 → 日曆 → 排程產出

7. **客戶與日曆** — `pages/audit-lab/content-operations.vue#createClient` / `#createCalendar` → `server/content-operations/service.ts#createOwnerContentClient` / `#createCalendarFromProductionPlan`（cadence 3/7/15/30 天，對應使用者說的「選購自動產文」）。
8. **物化到期項目** — `#materializeOwnerDueContent`（`planned` → `materialized`）。排程版是 `server/content-operations/scheduler.ts#runContentOperationsTick`。
   - ⚠ **斷點 B** — 包裝它的 `server/tasks/content-operations-tick.ts` **沒有 cron，也沒有任何呼叫者**。自動化只能靠 UI 手動點。
9. **執行狀態機** — `content-operations.vue#executeEntry` → `POST /api/content-operations/entries/{id}/execute` → `server/content-operations/orchestrator.ts#executeContentOperationEntry`，依 `entry.status` 分派：`planned`→物化／`materialized`→`#executeGeneration`／`awaiting_review`→`#synchronizeReview`（V4 政策下走 `#executeV4MachineReview`）／`ready_to_publish`→`#executePublication`／`delivered`→immutable replay。
10. **生成** — `#executeGeneration` 取 `repository.acquireRunLease` → `repository.reserveAutopilotBudget` → 呼 `seo-geo-core/service.ts#runOwnerProductionDeliverable` → 檢驗 `draft.safetyStatus === 'passed' && gate.status === 'passed' && provenance.stage === 'optimized'`，全過才轉 `awaiting_review`。
    - ⚠ **斷點 C** — `pages/audit-lab/content-operations.vue` **沒有審查按鈕**。`awaiting_review` 的項目必須跳到 `seo-geo.vue` 手動配對 jobId／draftId 才能推進。且 `#executeV4MachineReview` 硬性要求 `provenance.providerExecution === true` — 斷點 A 的 fallback 草稿**永遠無法通過機器授權**。

### 發布與 receipt

11. **發布** — `orchestrator.ts#executePublication`。門檻依序：target 允許的 contentType/language → `repository.findLatestReview` 必須 `approved_for_delivery` → `repository.resolveCanonicalContext` 驗 evidence hash 未漂移 → `repository.findRiskGate` 驗精確通過的閘 → `content-operations/publication-identity.ts#buildPublicationIdentity` → `repository.reservePublicationAttempt` → 呼 executor。
12. **transport** — 單一 first-party target 走 `server/first-party-publishing/executor.ts#executeFirstPartyPublication`（下轄 `git-adapter.ts#executeGitContentsPublish` 或 `signed-api-adapter.ts#executeSignedApiPublish`）；多通道走 `server/publication-routing/planner.ts#createRoutingPlan` ＋ `multi-channel-executors.ts#executeMultiChannelPublication`。
    - **真實 fetch 確實接上了**：`server/api/content-operations/entries/[id]/execute.post.ts` 匯入 `server/content-operations/runtime-dependencies.ts#getContentOperationsRuntimeDependencies`，供給 `fetchImpl: createBoundedFetch()` ＋ `serverCredentialResolver: resolveServerCredential`。
    - ⚠ **斷點 D** — 實際門檻是 `server/content-operations/credential-resolver.ts#resolveServerCredential` 能否從 `DISCOVERYSTACK_FIRST_PARTY_CREDENTIALS_JSON` 解出憑證，以及 target 的 `executionEnabled`（預設 `false`，只能 dry-run）。
13. **Receipt** — `delivered` 時用 `content-operations/normalization.ts#stableFingerprint` 算 `receiptFingerprint`（涵蓋 publicationId／contentHash／artifactFingerprint／remoteState／remoteRevision），寫入 `repository.finalizePublicationAttempt`。

### 成效回收與學習

14. **排程測量** — `server/measurement-collection/service.ts#scheduleMeasurementForEntry`（`POST /api/measurement-collection/entries/{id}/schedule`）建 baseline／follow-up 兩階段。
    - ⚠ **斷點 E（閉環最大的一個）** — 這條路由**沒有任何前端呼叫**；`server/tasks/content-operations-measurement-tick.ts` **沒有 cron**。delivered → 測量這一跳只能手動打 API。
15. **採集** — `#collectPhase` → `measurement-collection/adapters/{ga4-data-api,google-search-console}.ts`；LLM 面走 `server/llm-visibility/repository.ts#runOwnerProviderObservation`。
    - ⚠ **斷點 F** — `schedule.post.ts` 未傳 `dependencies`，因此 `measurement-collection/credentials.ts#resolveCredentialDependencies` 回落到 `#unavailableGoogleCredentialResolver = async () => null`。**GSC／GA4 在 production 必然 fail-closed**。UI 自己也承認（`pages/audit-lab/measurement-operations.vue` 顯示「實際 Google OAuth 尚未在本 V1 執行」）。
16. **Outcome 落地** — `#assessMeasurementOutcome` → `server/content-operations/service.ts#recordOwnerOutcomeAssessment`。**此函式強制 `receiptAttempt.receiptFingerprint` 存在且為 64 hex 才允許記錄** — receipt 是 outcome 的入場券，這正是「可驗證資料鏈」的實作點。內部呼 `server/outcome-learning/engine.ts#assessPublishedContentOutcome` ＋ `content-learning-runtime.ts#scanOutcomeLearningPii`。
17. **學習資料集** — `content-operations.vue` 開頁即取 `/api/content-operations/learning-dataset` → `service.ts#buildOwnerContentLearningDataset`。
    - ⚠ **斷點 G** — `contentOperationOutcomeAssessments` 只被 `content-operations/` 讀寫；`geo-outcome-model/` **完全不讀它**。「內容營運 outcome」與「GEO Outcome Model 訓練」是兩條**平行未接通**的資料鏈。

---

## 6. 資料與契約

### 6.1 資料模型（149 表 / 34 migrations，皆連續無缺號、`meta/_journal.json` 34 筆對得上、無人工編輯痕跡）

| 領域 | 表數 | 代表表 |
|---|---|---|
| Core auth / leads | 3 | `users`、`providerCredentials`、`leads` |
| Audit / friction | 8 | `auditWorkspaces`、`auditRuns`、`auditEvidenceLedger` |
| Public intelligence / 模型改進 | 10 | `publicIntelligenceSources`、`modelImprovementCandidates` |
| SEO/GEO core | 13 | `seoGeoDiagnoses`、`seoGeoEvidenceApprovals`、`seoGeoContentRiskGates` |
| Content operations | 16 | `contentOperationAutopilotPolicies`、`contentOperationMachineAuthorizations`、`contentOperationOutcomeAssessments` |
| LLM visibility | 5 | `llmVisibilityRuns`、`llmVisibilityObservations` |
| Measurement | 3 | `contentOperationMeasurement{Connections,Runs,Snapshots}` |
| Managed sites core | 8 | `managedSiteProjects`、`managedSiteMemberships`、`managedSiteSessions` |
| Media vault | 14 | `managedSiteMediaAssets`、`managedSiteMediaQuotaClaims` |
| Page editor ＋ AI | 12 | `managedSitePageVersions`、`managedSiteAiEditProposals`、`managedSiteAiCostLedger` |
| 訂購／金流／部署 | 23 | `managedSitePreviews`、`managedSiteDomainClaims`、`managedSitePaymentWebhookInbox` |
| GEO outcome model ／ ModelOps | 19 | `geoOutcomeDatasetManifests`、`geoOutcomeModelArtifacts`、`geoOutcomeIdempotencyClaims` |
| System factory | 15 | `systemTenants`、`systemProvisioningRuns`、`systemReceipts` |

**治理表**（產品的核心資產）：lineage（`auditEvidenceLedger`、`geoOutcomeEvidenceLocators`、`managedSitePageVersions`）／receipt（`managedSitePagePublicationReceipts`、`managedSiteConnectorReceipts`、`systemReceipts`）／decision（`geoOutcome*Decisions`）／consent（`seoGeoEvidenceApprovals`、`contentOperationMachineAuthorizations`）／idempotency（`geoOutcomeIdempotencyClaims`、`managedSitePaymentWebhookInbox`）／lease（`contentOperationRuns`、`systemProvisioningRuns`）／event ledger（`contentOperationEvents`、`managedSiteAuditEvents`、`systemEvents`）。

Migration 演進：0000 地基 → 0001 audit → 0002–0010 intelligence／訓練 → 0011–0012 SEO/GEO → 0013 LLM visibility → 0014–0020 content-ops／測量 → 0021–0028 managed-sites 商業化 → 0029–0030 GEO outcome model → 0031 system factory → 0032 content-ops 治理強化 → **0033 media vault ＋ page editor（26 表，最大一次）**。

### 6.2 API 分群（233 endpoint）

| 群組 | 數量 | Auth | 治理機制 |
|---|---|---|---|
| `managed-sites` | 96 | **混合** owner／customer／public／webhook | receipt、domain claim、quota claim、webhook inbox |
| `intelligence` | 26 | owner | source review→approve→remove 四階段 |
| `geo-outcome-model` | 25 | owner | **唯一系統性強制 `idempotencyKey`**（`server/api/geo-outcome-model/_helpers.ts#requiredIdempotency`） |
| `content-operations` | 19 | owner | autopilot policy ＋ revoke、budget reservation |
| `system-factory` | 17 | 混合 owner／customer／invitation | receipt、provisioning lease、HMAC |
| `seo-geo` | 16 | owner | evidence approval、risk gate |
| `llm-visibility` / `measurement-collection` / `audit` | 7 / 7 / 7 | owner | observation review／connection revoke／consent revoke |
| `auth` ＋ `oauth` | 5 | public 入口 | OAuth state nonce |
| root ＋ `admin` ＋ `leads` ＋ `geo` | 8 | 混合 | — |

**不需要 owner session 的 endpoint（安全審查重點）**：
- **完全公開 8 條** — `POST /api/leads`（zod ＋ honeypot `companyFax`）、`POST /api/site-analysis`（zod ＋ 8 次/小時 rate limit ＋ SSRF guard）、`GET /api/__release`、`GET /api/__private-config`、`GET /api/auth/login`、`GET /api/auth/callback`、`GET /api/oauth/callback`、`GET /api/managed-sites/price-catalog`。
- **Preview／訂購鏈 5 條** — access token 綁定（非 session）。`POST /api/managed-sites/previews` 為**條件式**：只有帶 `existingSiteUrl` 才要 owner。
- **Customer session 43 條** — `managed-sites/customer/**` ＋ `managed-sites/editor/**`。
- **Invitation token 2 條** — `managed-sites/invitations/accept`（⚠ 無 same-origin 檢查）、`system-factory/invitations/accept`（有）。
- **Webhook 3 條** — payment-webhook（HMAC）、shopify/webhook、shopify/callback。

### 6.3 環境變數（**只列名稱與用途，本檔絕不寫值**）

**Secret 類**：`JWT_SECRET`／`NUXT_SESSION_SECRET`（session JWT，**同時是 provider vault 的 master secret**）、`DATABASE_URL`、`FIRECRAWL_API_KEY`、`HUGGINGFACE_API_TOKEN`、`NUXT_AUTOGEO_GEMINI_API_KEY`、`NUXT_AUTOGEO_BAILIAN_API_KEY`、`NUXT_GEOFLOW_QWEN_API_KEY`、`SHOPIFY_API_SECRET`、`SHOPIFY_CLIENT_ID`、`NUXT_PAGE_EDITOR_PREVIEW_SECRET`、`NUXT_MEDIA_LOCAL_SIGNING_SECRET`、`NUXT_MEDIA_SCANNER_CREDENTIAL_REF`、`SYSTEM_FACTORY_HMAC_SECRET`／`_KEY_ID`／`_CREDENTIAL_REF`、`SYSTEM_FACTORY_FRAPPE_AUTHORIZATION`、`DISCOVERYSTACK_PAYMENT_WEBHOOK_CREDENTIAL_REF`／`_PROVIDER_KEY`、`DISCOVERYSTACK_FIRST_PARTY_CREDENTIALS_JSON`、`DISCOVERYSTACK_MANAGED_SITE_CREDENTIALS_JSON`、`DISCOVERYSTACK_MANAGED_SITE_VAULT_JSON`、`DS_MEDIA_S3_ACCESS_KEY`／`_SECRET_KEY`。

**Origin／設定類**：`DISCOVERYSTACK_PUBLIC_SITE_ORIGIN`、`NUXT_DISCOVERYSTACK_PRIVATE_ORIGIN`、`OAUTH_SERVER_URL`、`VITE_OAUTH_PORTAL_URL`、`VITE_APP_ID`、`NUXT_DISCOVERY_STACK_OAUTH_ALLOWED_ORIGIN`、`OWNER_OPEN_ID`、`FIRECRAWL_API_BASE_URL`、`HUGGINGFACE_{NAMESPACE,BASE_MODEL_ID,JOB_FLAVOR}`、`NUXT_CONTENT_DRAFT_PROVIDER`、`NUXT_GEOFLOW_QWEN_{ENDPOINT,MODEL,CREDENTIAL_REFERENCE}`、`NUXT_AUTOGEO_BAILIAN_{ENDPOINT,MODEL}`、`NUXT_MEDIA_SCANNER_ENDPOINT`、`DS_MEDIA_S3_{BUCKET,ENDPOINT}`、`SYSTEM_FACTORY_FRAPPE_{ORIGIN,ALLOWED_ORIGINS}`、`DISCOVERYSTACK_MANAGED_SITE_ALLOWED_{CHECKOUT,PROVIDER}_ORIGINS`、`PUBLIC_SITE_URL`、`PUBLIC_OPS_API_ORIGIN`。

**Feature flag（全部 `=== 'true'` 字串比對）**：`NUXT_SYSTEM_FACTORY_EXECUTION_ENABLED`、`SYSTEM_FACTORY_CONTROL_PLANE_LIVE_ENABLED`、`SYSTEM_FACTORY_TENANT_APP_LIVE_ENABLED`、`SYSTEM_FACTORY_RUNTIME_PRODUCTION_APPROVED`、`NUXT_MODEL_IMPROVEMENT_AUTO_TRAIN`、`NUXT_BUILD_TYPECHECK`。

**Cron**：`MODEL_IMPROVEMENT_CRON`、`GEO_MODELOPS_CRON`、`MANAGED_SITE_EDITOR_CRON`、`SYSTEM_FACTORY_CRON`。

**測試 gate**：`DS_RUN_EXTERNAL_CREDENTIAL_TESTS`、`DS_RUN_{MANAGED_EDITOR_DB,MEDIA_S3,SYSTEM_FACTORY_DB,SYSTEM_FACTORY_FULL_MIGRATION_DB}_INTEGRATION`。

### 6.4 外部服務與 transport 邊界

| 服務 | 錨點 | 邊界 |
|---|---|---|
| Firecrawl | `server/public-intelligence/firecrawl.ts` | 真實 HTTP，無注入 seam |
| HuggingFace Inference／Jobs | `server/audit/huggingface.ts`、`public-intelligence/huggingface-jobs.ts` | 真實 HTTP，硬編碼 origin |
| Gemini（AutoGEO） | `server/geo/autogeo-api.ts#GEMINI_GENERATE_CONTENT_URL` | 真實 HTTP，可注入 `fetchImpl` |
| Bailian／Qwen | `server/geoflow-runtime/qwen.ts`、`seo-geo-core/productionProviders.ts` | 真實 HTTP，endpoint 需過 `isAllowedBailianEndpoint` 白名單；未設定則 fallback |
| LLM visibility probe（OpenAI／Gemini／Perplexity） | `server/llm-visibility-probes/server-adapters.ts` | 真實 HTTP ＋ `redirect: 'error'`，**接線最完整的一條** |
| GA4／Search Console | `measurement-collection/adapters/{ga4-data-api,google-search-console}.ts` | 真實 transport，但 credential resolver 永遠回 `null` |
| Shopify | `server/managed-sites/shopify-service.ts` | ⚠ `mock_verified`，`externalCalls: false` |
| S3 | `server/managed-sites/live-connectors/s3-vault.ts` | AWS SDK ＋ 可注入 client |
| Frappe／ERPNext | `server/system-factory/frappe-adapter.ts` | 雙模式：live（HMAC 簽章真呼叫）／mock（`mocked: true`） |
| 網域／DNS／TLS／部署／金流 broker | `live-connectors/{hmac-broker-transport,deployment-transport}.ts` | ⚠ 發出格式完整、簽章正確的真實 HTTP 到 `/v1/managed-sites/*` — **但該服務不存在於本 repo** |

---

## 7. 專案慣例

> 照著寫，產出的程式碼才會像原生的。

**目錄與檔名**
- 一個 engine ＝ `server/<engine-name>/` 一個資料夾，固定角色檔名：`types.ts`（型別＋常數）、`normalization.ts`（輸入解析／fingerprint）、`repository.ts`（DB）、`service.ts`（use case）、`index.ts`（barrel，**只有 barrel 對外**）。編排型另加 `orchestrator.ts`、`scheduler.ts`、`policy-catalog.ts`。
- API handler 檔名 `<resource>.<method>.ts`，動作用子資源：`entries/[id]/execute.post.ts`。**撤銷一律叫 `revoke.post.ts`，不用 DELETE。**
- Nuxt `srcDir` 是 repo root（沒有 `app/` 目錄）— 新頁面放 `nuxt-app/pages/`。
- 每個 engine 對應一份 `nuxt-app/<ENGINE_SCREAMING_SNAKE>_V<n>.md` 規格。**改 engine 前先讀它的規格。**
- Repository 採 **port ＋ 多實作**：記憶體版與 Drizzle 版並存（`modelops-memory-repository.ts` vs `modelops-repository-drizzle.ts`），service 只認 `...RepositoryPort`。

**輸入驗證**
- 主力是**手寫** `parseXxxInput(value: unknown)`，放該 engine 的 `normalization.ts`，失敗 `throw createError({ statusCode: 422 })`。zod 是輔助（49/約 400 檔）。
- 路由參數 inline regex：`/^\d{1,12}$/.test(rawId)`。

**錯誤處理**
- engine 內把 h3 `createError` 包成語意函式放檔頭：`badRequest`（422）／`notFound`／`collision`（409）／`ownerMismatch`。
- API handler 最外層 `catch { throw toPublicXxxError(error, '<中性訊息>') }`。
- 進 log／DB 的錯誤先過 `sanitizeErrorSummary(error)` 並截 500 字。
- **Fail-closed 是預設語氣**：未設定的外部依賴回 `FAIL_CLOSED_*` 常數而非 throw（`ordering-service.ts#FAIL_CLOSED_PAYMENT_EVENT_VERIFIER`）。

**回傳形狀**
- 幾乎每個編排回傳值都帶 `limitations: string[]`，用完整句子誠實描述「這次沒做什麼」。**新程式碼務必沿用** — 這是這個 repo 最好的習慣。
- 每個狀態轉換都算一個 sha256 `stableFingerprint(stableStringify(x))` 存進 event metadata，一律用 `/^[a-f0-9]{64}$/u` 驗。

**依賴注入**
- 新 engine 用 `dependencies?: XxxDependencies` 物件式（content-operations／seo-geo-core 風格），不用尾參數預設值式（managed-sites 舊風格）。
- 時間一律經 `Clock` 介面或 `now?: Date`，**不直接 `new Date()`**。

**冪等**
- 所有寫入 API 收 `idempotencyKey`（前端用 `crypto.randomUUID()`），DB 靠 unique index ＋ `findXxxByIdempotency` replay，replay 時在 `limitations` 註明。

**測試**
- 153 支平放 `nuxt-app/tests/`，無巢狀。命名 `<engine-kebab>-<面向>.test.ts`；後綴有語意：`.contract.test.ts`（API/UI 契約）／`.integration.test.ts`（需真 DB，預設 skip）／`.adversarial.test.ts`（攻擊／競態）／無後綴＝單元。

---

## 8. 完成度看板

> Status schema: `completion-status-v1`
>
> ✅ VERIFIED COMPLETE — 實作存在，且重要驗證真的執行並通過
> 🟦 IMPLEMENTED — UNVERIFIED — 實作看起來完整，但缺真實 runtime 驗證
> 🟡 PARTIAL — 主路徑有了，但缺重要狀態、consumer 或錯誤處理
> 🟠 STUB / DEMO / MOCK — 只有預覽、fixture、blocked adapter 或概念流程
> ⚪ MISSING / NOT STARTED — 使用者已確認必要，但完全沒有
> ❓ UNKNOWN — repo 證據不足，無法判定
>
> **狀態與信心是兩個獨立的軸。**
>
> 本節依 `GEO_ENGINEERING_SPEC_V2.md` 的驗收結構重寫：8.1 五平面總覽 → 8.2 依 Phase 的主看板 → 8.3 §33 Definition of Done 逐條 → 8.4 §26 核心資料表 → 8.5 §34 交付物與「不得算作完成」稽核。

### 8.1 五個平面的落點（規格 §4）

| # | 平面 | 規格區塊 | 落點 | 一句話 |
|---|---|---|---|---|
| 1 | Connector & Verification | §6、§5.3 | 🟡 **一半** | GSC／GA4 adapter 是真的（真端點、可注入 fetcher、provenance 完整），但 **edge／WAF／server log connector 完全不存在**，且網域所有權驗證卡在不存在的 broker sidecar |
| 2 | Crawl & Edge Observability | §7–§9 | ⚪ **幾乎空白** | bot policy、crawler 身分驗證、WAF 事件、URL inventory、raw vs rendered、sitemap 稽核 —— 命中數全部為 0。唯一的頁面抓取是 `audit/` 對客戶站的單次 fetch |
| 3 | Knowledge & Publishing | §10–§16 | 🟡 **repo 的重心，但知識層是空的** | 內容治理管線（brief→diagnose→plan→risk gate→review→delivery）是全庫最紮實的一段；但 **Entity Graph、Claim Ledger、Author 實體三張底座完全沒有**，Structured Data 引擎寫好了卻是孤兒 |
| 4 | AI Visibility Observatory | §19–§21 | 🟡 **比預期完整，但不可重複** | `llm-visibility-probes/` 1,797 行真實接了 OpenAI／Gemini／Perplexity；metrics 有 brand mention rate／citation rate／competitor share of voice。**但沒有同一 prompt 重複執行的機制，也沒有樣本數與信賴區間** → 觸發 §34 的 `single-run benchmark` 紅線 |
| 5 | Intervention & Learning | §22–§24 | 🟡 **有 baseline，沒有閉環** | `outcome-learning/` 有真實的 baseline window／snapshot／pre-post 量測且已接上 content-operations；但 **intervention registry、verified recrawl、experiment registry、refresh queue、quality score 全部沒有** |

**護城河那條鏈的實際斷點**（使用者原話：`網站問題 → 修改內容 → 發布版本 → AI／Google 是否引用 → 流量與轉換變化 → 哪種策略真正有效`）：

```text
網站問題          🟡 audit/ 能抓單頁並評分，但沒有 crawl／render／canonical／sitemap 層級的診斷
  ↓
修改內容          🟦 治理管線完整（這是 repo 最強的一段）
  ↓
發布版本          🟡 first-party 發布路徑真實；多通道與代管部署卡在不存在的 broker
  ↓
AI／Google 是否引用  🟡 LLM 引用量得到；Google 引用（GSC）adapter 真實但憑證解析器永遠回 null
  ↓
流量與轉換變化      ⚪ 斷在這裡 —— 沒有 referral_sessions、沒有 conversion_events、沒有 AI referral 歸因
  ↓
哪種策略真正有效     ⚪ 斷在這裡 —— 沒有 interventions、沒有 experiment_results
```

**這條鏈目前無法從頭走到尾。** 斷點集中在後兩段，也就是使用者自己定義為「護城河」的那一段。

### 8.2 主看板（依規格 §31 的 Phase 排序）

規格把工程順序定死成 Phase 0→5，每個 Phase 有 Exit Gate。**Phase N 的 Exit Gate 沒過，Phase N+1 的完成度沒有意義** —— 這是本節按此排序的原因，也解釋了為什麼 repo 在 Phase 2 做了很多、Phase 0/1 卻沒過關。

#### PHASE 0 — Foundation　**Exit Gate：可安全連接一個 production 網域並只讀取得資料，且無 tenant leakage** → ❌ **未通過**

| 功能 | 狀態 | 錨點 | 缺什麼才算完成 | 信心 |
|---|---|---|---|---|
| Multi-tenant 隔離（§5.1 MUST） | 🟡 PARTIAL | `server/database/schema.ts`：`ownerUserId` 出現 **357** 次、`tenantId` 出現 **2** 次（`systemTenants`／`systemTenantBindings`，用途是 Frappe 租戶供裝，不是列級隔離） | 隔離軸目前是 owner 不是 tenant。需在 149 張業務表加 `tenant_id`、RLS 或等效強制、cache key／queue payload／trace context 全面 tenant 化、加跨租戶洩漏測試。**這是全清單成本最高的一項，而且愈晚做愈貴** | 高 |
| RBAC（§5.2） | 🟡 PARTIAL | `server/utils/requireOwner`、managed-site session、`systemTenantBindings` | 現況是三種身分（單一 owner／managed-site 客戶／公眾）的硬編碼分流，沒有角色模型、沒有權限矩陣 | 高 |
| 站台所有權驗證（§5.3） | 🟠 STUB | `managedSiteDomainClaims`（`status: pending\|verified\|released\|blocked`）、`live-connectors/repository.ts` 讀 `existing_site_ownership_verified` receipt | `verified` 只能由**不存在的** `/v1/managed-sites/*` broker sidecar 發 receipt 產生。repo 內找不到 DNS TXT／檔案／meta 任一種自主驗證實作 | 高 |
| Connector framework（§6） | 🟡 PARTIAL | `server/measurement-collection/adapters/`（`google-search-console.ts` → `webmasters/v3/searchAnalytics/query`；`ga4-data-api.ts` → `analyticsdata v1beta runReport`）、`google-shared.ts#postFixedJson`（可注入 fetcher、15s timeout） | Search／Analytics 這一類做得好。**Edge／WAF／server log 這一類（§6 第一段）零實作**；Bing 也沒有 | 高 |
| Secrets 與 audit log | 🟦 IMPLEMENTED — UNVERIFIED | `server/utils/provider-vault.ts`、`managedSiteAuditEvents`、`systemEvents`、`contentOperationEvents` | 缺 secret rotation（§33 Security 明列）。且 vault master key 派生自 `JWT_SECRET`（見 §9 第 6 條） | 高 |
| URL normalization service | 🟡 PARTIAL | `first-party-content-site-kit/canonical.ts#compareCanonicalStrings`（**孤兒**）、`llm-visibility/guards.ts#canonicalizePublicHttps` | 兩套正規化邏輯各寫各的，其中一套沒有 production consumer。§9.4 要求集中式 canonical／normalization 服務 | 高 |
| Event contracts（§27） | 🟡 PARTIAL | 四張 event 表存在且 append-only | 表有了，**契約文件沒有**。§34 明列 `Event schemas` 為必交付物，repo 內不存在 | 中 |
| Observability foundation（§29） | ⚪ MISSING | `opentelemetry`／`traceId`／`spanId`／`prometheus` 在 `server/` 與 `package.json` 命中數 **0** | 需 trace／metric／log 三件與 SLO 掛勾。目前只有 DB 內的業務事件表，沒有系統可觀測性 | 高 |

#### PHASE 1 — Observe & Diagnose　**Exit Gate：能回答「crawler 在哪一層失敗、哪些重要頁不可取得、目前有哪些可驗證流量」** → ❌ **未通過**

| 功能 | 狀態 | 錨點 | 缺什麼才算完成 | 信心 |
|---|---|---|---|---|
| AI Bot Policy Engine（§7） | ⚪ MISSING | `botPolic`／`botIdentit` 命中 **0**；`Googlebot`／`OAI-SearchBot`／`PerplexityBot`／`Claude-SearchBot` 命中 **0** | 需 per-bot-purpose 政策模型 ＋ robots.txt 產生器 ＋ 部署到客戶站。諷刺的是全庫唯一的 SEO／sitemap 產生器 `first-party-content-site-kit/seo.ts` 正好是孤兒模組 | 高 |
| Crawler 身分驗證（§8.1） | ⚪ MISSING | `reverseDns`／`verifyCrawler`／`crawlerIdentit` 命中 **0** | §8.1 的 MUST 是「不信任 User-Agent」，需 reverse DNS ／官方 IP 段比對。目前連 User-Agent 都沒有在讀 | 高 |
| WAF／Edge log ingestion（§8.2–8.4） | ⚪ MISSING | `waf` 的 16 個命中全部是 migration snapshot 與 Cloudflare **DNS 供裝**（`provisioning-service.ts`），不是 WAF 日誌 | 需 crawler event schema（append-only）＋ 403/429/challenge 可觀測 ＋ dashboard | 高 |
| URL Inventory（§9.1） | 🟠 STUB | `auditPages`（有 `sourceUrl`／`finalUrl`／`canonicalUrl`／`httpStatus`／`contentHash`／`snapshotStorageKey`） | 欄位其實已經是 URL inventory 的雛形，**但綁在單次 audit run 上，不是站台級的持續清單**。需獨立 `url_inventory` ＋ 站台全量發現 | 高 |
| Raw vs Rendered Diff（§9.2–9.3） | ⚪ MISSING | `renderedHtml`／`renderSnapshot`／`rawVsRendered` 命中 **0** | 需同時取 raw HTML 與 rendered HTML 並比對主內容差異。**這是 GEO 診斷最核心的一項，目前完全沒有** | 高 |
| Canonical／noindex／Sitemap 稽核（§9.4–9.5） | ⚪ MISSING | `canonical` 的 252 個命中幾乎全是治理語意的「canonical rule／canonical fingerprint」，不是 URL canonical 稽核；`sitemap` 的 8 個命中是 public-site 自己的 sitemap ＋ 孤兒 site-kit | 需對**客戶網站**做 canonical 解析、noindex 誤設偵測、redirect chain、sitemap 只含 canonical indexable URL、lastmod 真實性 | 高 |
| GSC／GA4 成效測量 | 🟠 STUB | adapter 真實（見 Phase 0）；但 `measurement-collection/credentials.ts#unavailableGoogleCredentialResolver` 恆回 `null`，`service.ts` 未注入替代者 | **只差一件事：Google OAuth 憑證解析器。** 註解自陳「V1 deliberately has no OAuth implementation」。接上之後這一列會直接跳到 🟦 | 高 |
| AI referral baseline（§20） | ⚪ MISSING | `referralSession`／`aiReferral`／`conversionEvent` 命中 **0** | 需 referral 分類（ChatGPT／Perplexity／Copilot referrer）＋ session ＋ conversion 事件。**護城河鏈的第一個斷點** | 高 |
| 客戶網站診斷（現況替代品） | 🟦 IMPLEMENTED — UNVERIFIED | `server/audit/engine.ts`、`server/audit/targetGuard.ts#assertSafeAuditTarget`、`frictionAssessments`（`journeyStage` 五階段 ＋ `assessmentStatus: supported\|insufficient_evidence\|needs_review`） | 這是 repo 目前**實際在做**的診斷：抓單頁、算 friction score、無證據時明確標 `insufficient_evidence`（刻意避開 §34 的 `fake quality score` 紅線）。但它不是 §9 要求的 crawlability 診斷 | 高 |

#### PHASE 2 — Knowledge & Publishing　**Exit Gate：一篇 production research page 能由同一資料源產生 HTML／Schema／API／Dataset，且每個重要 claim 可追溯** → ❌ **未通過**

| 功能 | 狀態 | 錨點 | 缺什麼才算完成 | 信心 |
|---|---|---|---|---|
| GEO Content CMS ＋ 治理管線（§13） | 🟦 IMPLEMENTED — UNVERIFIED | `server/seo-geo-core/service.ts#runOwnerProductionDeliverableInternal`；13 條路由 `briefs → diagnose → recommend → production-plans → reviews → evidence-approvals → delivery-preview → delivery-targets` | **全庫最紮實的一段，而且它已經滿足規格 §2.4（可預覽／核准／稽核／回滾）—— 也就是文化上最難建的那一半已經有了。** 缺真實 MariaDB 上跑一次完整鏈（9 支 integration test 目前 skip） | 高 |
| Entity Graph（§10） | ⚪ MISSING | `entityGraph`／`entityEdge`／`entityAlias`／`entityResolution` 命中 **0**。`contentOperationEntityStrategyProfiles` 是策略檔案不是實體節點 | 需 entity 型別 ＋ 穩定不變 ID ＋ aliases ＋ external IDs ＋ edges ＋ resolution ＋ 公開實體頁五層。**使用者定義的護城河核心** | 高 |
| Claim Ledger / Evidence Graph（§11） | ⚪ MISSING | `claimLedger`／`claimEvidence`／`materialClaim` 命中 **0**。全庫的 `*Claims` 表（`managedSiteAiBudgetClaims`、`managedSiteDomainClaims`、`geoOutcomeIdempotencyClaims`…）都是「資源佔用宣告」，語意上與知識 claim 完全無關 | 需 claim 模型 ＋ evidence 關聯 ＋ source version／locator 保存 ＋ 衝突偵測 ＋ impact engine。**護城河核心** | 高 |
| Source Quality Graph（§12） | 🟡 PARTIAL | `server/public-intelligence/crawl-policy.ts`、`repository.ts#sourcePolicySnapshot`、`publicIntelligenceSources`／`publicIntelligenceSourceReviews` | source **治理**（robots／terms／copyright／PII／retention ＋ 審核歷史）已完整；缺的是 **quality scoring** —— `qualityScore`／`authorityScore`／`trustScore` 命中數 0 | 高 |
| Author 實體與作者頁 | ⚪ MISSING | `mysqlTable('...authors')` 命中 **0**；`authorProfile`／`authorEntity`／`authorPage` 命中 **0** | §33 明列「author is a real entity with profile」。目前作者只是內容欄位上的字串 | 高 |
| Structured Data Engine（§15） | 🟠 STUB / 孤兒 | `server/first-party-content-site-kit/`（1,188 行：`seo.ts` JSON-LD、`canonical.ts`、breadcrumb、hreflang、FAQ evidence envelope、`FirstPartySitemapEntry`、Astro／Nuxt projection） | **程式碼是完整的，consumer 是零。** 全 repo 唯一 import 它的是 `tests/first-party-content-site-kit.test.ts`。需接一條 API route 或發布路徑。接上之後這一列會跳到 🟦 | 高 |
| Content versioning（§13.1） | 🟦 IMPLEMENTED — UNVERIFIED | `managedSitePageVersions`、`managedSiteVersions`、`seoGeoContentDrafts`、`revision → risk gate → needs_human_review` 生命週期 | 版本模型與不可變語意都在；缺真實 DB 驗證 | 高 |
| Freshness / Publishing Engine（§16） | ⚪ MISSING | `indexNow`／`cdnPurge`／`purgeCache` 命中 **0** | 需 IndexNow ＋ CDN purge ＋ sitemap 更新記錄。§33 Publishing 這四條全部沒有 | 高 |
| Dataset / First-party research（§14） | 🟦 IMPLEMENTED — UNVERIFIED | `geoOutcomeDatasetManifests`／`Members`／`Decisions`、`publicIntelligenceDatasetBuilds`、`server/model-improvement/pipeline.ts` | manifest ＋ member ＋ 決策 receipt 都有；缺真實資料集產出驗證 | 高 |
| 第一方發布（GitHub Contents／signed API） | 🟦 IMPLEMENTED — UNVERIFIED | `server/api/content-operations/entries/[id]/execute.post.ts`、`content-operations/runtime-dependencies.ts#getContentOperationsRuntimeDependencies`（注入真實 `fetchImpl` ＋ 憑證解析器） | 缺 `DISCOVERYSTACK_FIRST_PARTY_CREDENTIALS_JSON` 與一次真實 `executionEnabled: true` 發布 | 高 |
| 多通道發布 routing | 🟡 PARTIAL | `server/publication-routing/planner.ts#createRoutingPlan` | capability matrix 與 receipt 驗證是純查表／投影，缺各通道真實 adapter | 中 |
| Public Knowledge API／llms.txt（§25） | ⚪ MISSING | `public-site/src/pages/robots.txt.ts` 是本站自己的 robots，不是 llms.txt；無公開知識 API | 需 §25.1 公開 API ＋ §25.2 llms.txt | 高 |

#### PHASE 3 — Observatory　**Exit Gate：Benchmark 可重複執行、surface 分層、結果有樣本數與不確定性** → ❌ **未通過**

| 功能 | 狀態 | 錨點 | 缺什麼才算完成 | 信心 |
|---|---|---|---|---|
| Provider adapters（§19.1） | 🟦 IMPLEMENTED — UNVERIFIED | `server/llm-visibility-probes/`（1,797 行：`server-adapters.ts` 接 `api.openai.com/v1/responses`、`generativelanguage.googleapis.com`、`api.perplexity.ai`；另有 `planner.ts`／`runner.ts`／`retry-policy.ts`／`analyzer.ts`），已被 `llm-visibility/service.ts` 消費 | **全 repo 接線最完整的外部整合。** 缺真實 provider 憑證下的一次實跑 | 高 |
| Surface 分層（§19.1） | 🟦 IMPLEMENTED — UNVERIFIED | `llmVisibilityRuns.observationMode`（`manual_verified` ／ `provider_api_observation`）、`limitationCode` **notNull**、`llm-visibility/contracts.ts` 明文寫「provider_api_observation 永遠不是 owner-verified evidence、consumer UI truth 或 primary 指標」 | 這一條**做得比規格還嚴**：每次 run 都被迫宣告自己的限制，API 觀測不得冒充消費者介面真實曝光 | 高 |
| Prompt registry／版本化（§19.3） | 🟡 PARTIAL | `llmVisibilityQueries`（`promptText`／`promptHash`／`intent`／`locale`／`active`）、`llm-visibility-probes/normalization.ts` 強制 `promptHash === normalizedPromptHash(promptText)` | 有內容雜湊釘選，**沒有 `prompt_versions` 實體**（§26 明列）。無法回答「這次 benchmark 用的是第幾版 prompt」 | 高 |
| Benchmark 可重複執行（§19.4） | 🟠 STUB | `llm-visibility-probes/planner.ts` 內 `repeat`／`replicate`／`samplesPer`／`runsPer`／`iteration`／`trials` 命中 **0** | 規格 §19.4 原文：「同一 prompt 必須重複執行…一次結果不得代表穩定趨勢」。**目前一個 prompt 一次 run**。直接觸發 §34 的 `single-run benchmark` 紅線 | 高 |
| 統計報告：樣本數與不確定性（§19.5） | ⚪ MISSING | `sampleSize`／`confidenceInterval`／`standardError`／`pValue` 在 `server/` 命中 **0** | §33 Measurement 明列「sample size and confidence displayed」。目前 metrics 只有點估計 | 高 |
| Citation 正規化與指標（§19.5） | 🟦 IMPLEMENTED — UNVERIFIED | `llmVisibilityObservations`（`citedDomain`／`citationUrls`／`firstMentionPosition`／`boundedExcerpt`／`evidenceLocator`／`verifiedByOwner`）、`llm-visibility/metrics.ts`（`brandMentionRate`／`citationRate`／`exactCitationRate`／`averageFirstMentionPosition` ＋ 期間 delta） | 指標層是真的。缺真實 provider 憑證下的一次實跑 | 高 |
| Competitor Citation Intelligence（§21） | 🟡 PARTIAL | `llm-visibility/metrics.ts#competitorShareOfVoice`、`countCompetitorMentions`、`llmVisibilityObservations.competitorMentions` | share of voice 算得出來，但**沒有 competitor registry 表**（§26 `competitors`），也沒有 §21 的「為什麼對手贏」分析 | 高 |
| Citation freshness（§19.5） | ⚪ MISSING | `citationFresh`／`citationAge` 命中 **0** | 需引用時間新鮮度指標 | 高 |
| Content Decay Detector（§24） | ⚪ MISSING | 全 repo `decay` 唯一命中是 AdamW 的 `weight_decay`（無關） | 需 decay 偵測 ＋ 門檻 ＋ 進 refresh queue | 高 |

#### PHASE 4 — Intervention Loop　**Exit Gate：至少完成一次可稽核的 `Issue → Change → Recrawl → Citation/Referral/Conversion outcome` 閉環** → ❌ **未通過**

| 功能 | 狀態 | 錨點 | 缺什麼才算完成 | 信心 |
|---|---|---|---|---|
| Recommendation engine | 🟦 IMPLEMENTED — UNVERIFIED | `server/api/seo-geo/recommend.post.ts`、`seoGeoStrategyRecommendations` | 缺真實 DB 驗證 | 高 |
| Change Sets（§2.4） | 🟦 IMPLEMENTED — UNVERIFIED | `seoGeoContentRiskGates`、`seoGeoProductionPlanSelections`、`delivery-preview.post.ts`、`owner_revision_input → canonical child → risk gate → needs_human_review` | 規格 §2.4 的四項（可預覽／核准／稽核／回滾）都對得上 | 高 |
| Intervention registry（§22.1） | ⚪ MISSING | `interventionRegistr`／`registerIntervention` 命中 **0**；§26 的 `interventions` 表不存在 | 需把「這次改了什麼」登記成可追蹤實體，並與 baseline、部署確認、recrawl、outcome 綁在一起。**沒有這張表，護城河那條鏈的最後一段在資料上不存在** | 高 |
| Verified recrawl gating | ⚪ MISSING | 全 repo `recrawl` **只有 1 個真命中**（先前掃描的「42 個」是 `firecrawl` 的子字串誤判，已更正） | 需在量測 outcome 前先確認搜尋引擎／AI 已重新抓取。缺這一關，pre/post 比較沒有因果意義 | 高 |
| Pre/post outcome 分析 | 🟡 PARTIAL | `server/outcome-learning/engine.ts`、`content-operations/service.ts`、`measurement-collection/service.ts`；`baselineWindowStart`／`baselineWindowEnd`／`baselineSnapshot`／`baselineMeasurements`／`baselineMetrics`（全庫 `baseline` 204 次） | **baseline 基礎設施是真的，而且已接上 content-operations 與 measurement-collection。** 缺的是上游（intervention registry、recrawl 確認）與統計（樣本數、因果限制陳述） | 高 |
| Experiment registry（§22.2） | ⚪ MISSING | `experimentRegistr`／`experimentResult` 命中 **0**；§26 的 `experiment_results` 表不存在 | 需實驗規則 ＋ 結果表 | 高 |
| Refresh queue | ⚪ MISSING | `refreshQueue` 命中 **0** | 需 refresh 佇列 ＋ 觸發條件 | 高 |
| GEO Quality Score（§23） | ⚪ MISSING | `qualityScore`／`geoScore` 在 `server/` 命中 **0** | §23 要求 13 維度的可校準分數 ＋ 版本化（§26 `quality_score_versions`）。**注意：`frictionAssessments` 有 `score` 但那是 journey friction，不是 GEO quality score，兩者不可互相冒充** | 高 |
| GEO Outcome Model ／ ModelOps | 🟦 IMPLEMENTED — UNVERIFIED | `server/geo-outcome-model/modelops-service.ts#executeModelOpsCycle`（強制冪等、decision receipt、rollback） | 治理最嚴謹的一塊；但 25 條路由中約 9 條無 UI，且與 content-operations outcome 未接通 | 高 |
| 自有模型訓練與升版 | 🟡 PARTIAL | `server/model-improvement/pipeline.ts`、`public-intelligence/huggingface-jobs.ts` | 交接文件記載 250／1087 筆資料仍需 page-specific evidence 與人工裁決；無完成的 fine-tune／權重上傳／模型升版 | 中 |

#### PHASE 5 — Agent & Advanced Research　**Exit Gate：核心互動任務可透過 accessibility tree 完成** → ❌ **未通過（整個 Phase 未開始）**

| 功能 | 狀態 | 錨點 | 缺什麼才算完成 | 信心 |
|---|---|---|---|---|
| ARIA／semantic 稽核（§18） | ⚪ MISSING | `ariaAudit`／`semanticHtmlAudit`／`accessibleName` 命中 **0**（`AI_QA_ACCESSIBILITY_VERIFICATION.md` 是本站自己的一次性驗證紀錄，不是給客戶站的稽核引擎） | 需對客戶站做語意 HTML／可及名稱／鍵盤流程稽核 | 高 |
| Agent task harness（§18） | ⚪ MISSING | `agentTaskHarness`／`browserAgent` 命中 **0** | 需瀏覽器代理跑核心任務並驗證可完成 | 高 |
| Preferred Source module／進階知識 API | ⚪ MISSING | — | 依賴 Phase 2 的 Entity／Claim 底座 | 高 |

#### 跨 Phase：商業與平台能力（不在 v2.0 五平面內，但屬使用者定義的產品範圍）

| 功能 | 狀態 | 錨點 | 缺什麼才算完成 | 信心 |
|---|---|---|---|---|
| 公開／私有雙 origin 隔離 | ✅ VERIFIED COMPLETE | `server/utils/publicCors.ts#PUBLIC_CORS_PATHS`、`public-site/src/lib/publicApi.ts#PUBLIC_API_PATHS` | 已完成。路徑全等比對、mismatch 403、production 強制 HTTPS，3,799 測試通過 | 高 |
| CI 保護 | ✅ VERIFIED COMPLETE | `.github/workflows/ci.yml`（push ＋ pull_request，兩個 job，`pnpm/action-setup@v4` 以 `package_json_file:` 指向各 app） | **本次改版期間補上並驗證。** run `33359408453` 綠：public-site 30s（7 檔／1.97s）、nuxt-app 5m4s（143 檔通過／10 skip、138.75s）。三次 run 的完整因果見 §9 第 13 條 | 高 |
| Owner OAuth 登入 | 🟡 PARTIAL | `server/api/auth/callback.get.ts`、`nuxt-app/todo.md` | 修正 production redirect URI（`a.run.app` callback 被 portal 拒絕）與 nonce cookie 403；`oauth-origin.runtime.test.ts` 目前 skip | 高 |
| 真實 Qwen／Bailian 內容生成 | 🟡 PARTIAL | `seo-geo-core/productionProviders.ts#resolveProductionRuntimeProviders`、`server/geoflow-runtime/qwen.ts` | transport 真實且 endpoint 有白名單；缺部署環境設定 `NUXT_CONTENT_DRAFT_PROVIDER` ＋ 憑證，並實跑一次 `providerExecution: true` | 高 |
| 網域購買／DNS／TLS／部署／金流 | 🟠 STUB / MOCK | `live-connectors/hmac-broker-transport.ts`、`ordering-service.ts#FAIL_CLOSED_PAYMENT_EVENT_VERIFIER`、`provisioning-service.ts#truthfulBoundary`（`externalCalls: false`） | **實作那個不存在的 `/v1/managed-sites/*` HMAC broker sidecar**，並接真實 registrar／DNS／CA／host／PSP。這同時也是 Phase 0「站台所有權驗證」的阻塞點 | 高 |
| 內容營運排程自動化（3/7/15/30 天自動產文） | 🟡 PARTIAL | `nuxt.config.ts#nitro.scheduledTasks`（已註冊 4 個）、`server/tasks/content-operations-{,execution-,measurement-}tick.ts`（**未註冊**） | 把 3 個已寫好但未排程的 task 加進 cron map。其中 `measurement-tick` 正是 GSC／GA4 收集的排程器 —— **adapter 真實、憑證缺失、排程也缺失，三層都要補** | 高 |
| 自然語言修改網站（AI 編輯） | 🟠 STUB / MOCK | `managed-sites/page-editor/ai.ts#classifyWebsiteEditIntent`、`api/managed-sites/editor/ai/propose.post.ts` | **完全沒有接 LLM。** `AiPlannerPort` 唯一實作是 `createDeterministicAiPlannerAdapter`（`providerKey: 'deterministic-injected-mock'`），propose 路由沒傳 planner，實跑的是寫死正則 | 高 |
| Shopify 整合 | 🟠 STUB / MOCK | `server/managed-sites/shopify-service.ts#authorize` | 用真實 Admin GraphQL／Storefront 呼叫取代 `mock_verified`（目前 `externalCalls: false`） | 高 |
| System Factory（Frappe／ERPNext 租戶） | 🟡 PARTIAL | `server/system-factory/control-plane.ts#invoke`、`frappe-adapter.ts` | control plane 是 deterministic mock（`mock-control:` fingerprint）；另缺租戶運維 UI（21 條路由只有 4 條有前端） | 高 |
| 客戶自助編輯器（媒體庫／區塊／版本） | 🟦 IMPLEMENTED — UNVERIFIED | `pages/customer/managed-sites/editor.vue`、`managed-sites/page-editor/scheduler-drizzle.ts` | 唯一有 cron 的內容執行路徑；缺真實 DB ＋ S3 驗證 | 高 |
| **5 個孤兒引擎** | 🟠 STUB / 不可達 | `authority-intelligence`(865)、`delivery-automation`(1,484)、`first-party-content-site-kit`(1,188)、`geo-content-evaluation`(1,078)、`market-intelligence`(1,152) —— **合計 5,767 行**，各有 `*_V1.md` 規格與測試，`server/` 內非自身 import 數皆為 **0** | 各需一條 API route 或 scheduled task 接進生命週期。注意 repo 的 `CLAUDE.md` 稱 `delivery-automation` 有「HTTP handlers under `server/api/`」—— **該敘述不成立**（已複驗） | 高 |
| 前端 consumer 缺口 | 🟡 PARTIAL | `pages/audit-lab/system-factory.vue`、`pages/audit-lab/managed-sites.vue` | 233 endpoint 中約 60 條無前端 consumer（system-factory 17/21、managed-sites 專案管理 ~17、geo-outcome-model ~9） | 高 |
| Migration 實際可套用性 | ❓ UNKNOWN | `server/database/migrations/0000`–`0033`、`system-factory-full-migration-mariadb.integration.test.ts` | 34 個 migration 連續、`meta/` 對得上、無人工編輯痕跡；但唯一會實跑的 integration test 目前 skip | 高 |

### 8.3 §33 Definition of Done 逐條對照

規格 §33 是 **54 條 checkbox**（Crawler 7／Rendering 7／Knowledge 6／Publishing 6／Measurement 9／Learning 7／Agent 6／Security 6）。**目前 4 條達成、10 條部分達成、40 條未達成。**

| 類別 | 條目 | 判定 | 依據 |
|---|---|---|---|
| **Crawler & Access**（0/7） | Googlebot / OAI-SearchBot / Claude-SearchBot / PerplexityBot 政策測試 | ⚪ ×4 | 四個 bot 名稱在 repo 命中數皆為 0 |
| | spoofed bot 不得被驗證為真 | ⚪ | 無 crawler 身分驗證 |
| | robots allow / WAF deny 不一致可觀測 | ⚪ | 無 WAF ingestion |
| | 403 / 429 / challenge 可觀測 | ⚪ | 無 crawler event |
| **Rendering & URL**（0/7） | 重要頁 raw HTML 含主內容 | ⚪ | 無 raw HTML 擷取（`auditPages.snapshotStorageKey` 只存單次 audit 的快照） |
| | canonical 正確解析 / 無誤設 noindex / redirect chain 合規 | ⚪ ×3 | 無客戶站 canonical／noindex 稽核 |
| | sitemap 只含 canonical indexable URL / lastmod 真實 | ⚪ ×2 | 唯一 sitemap 產生器是孤兒模組 |
| | raw / rendered 不一致可偵測 | ⚪ | 無 render snapshot |
| **Knowledge & Evidence**（0/6） | 核心實體有穩定 ID | ⚪ | 無 Entity Graph |
| | author 是有 profile 的真實實體 | ⚪ | 無 authors 表 |
| | 重要 claim 連到 evidence / source version 與 locator 保存 | ⚪ ×2 | 無 Claim Ledger。**注意**：`auditEvidenceLedger`、`geoOutcomeEvidenceLocators`、`seoGeoEvidenceApprovals` 是治理稽核證據，不是知識 claim 的 evidence graph |
| | 衝突 claim 可偵測 / entity merge 可審可逆 | ⚪ ×2 | 同上 |
| **Publishing**（1/6） | content versions immutable | 🟡 | `managedSitePageVersions`／`seoGeoContentDrafts` 有版本語意，未經真實 DB 驗證 |
| | publish pipeline 冪等 | ✅ | `idempoten` 在 206 個檔案出現；`contentOperationMachineAuthorizations` 有 fingerprint unique index |
| | JSON-LD 有效且與可見內容一致 | 🟡 | `first-party-content-site-kit/seo.ts` 產得出來，但無 production consumer，也無「與可見內容一致」的驗證 |
| | CDN purge 與 sitemap 更新有記錄 / IndexNow 僅在適用處使用 | ⚪ ×2 | 命中數 0 |
| | rollback 已測試 | 🟡 | `rollback` 在 48 檔出現且 ModelOps 有 `geoOutcomeModelopsRollbackDecisions`；但內容發布的 rollback 未見端到端測試 |
| **Measurement**（1/9） | crawler coverage 可測 | ⚪ | 無 crawler event |
| | AI referral 可測 / AI referral 轉換可測 | ⚪ ×2 | 無 referral／conversion 表 |
| | prompt benchmark 版本化 | 🟡 | 有 `promptHash` 釘選，無 `prompt_versions` 實體 |
| | run 級結果保存 | 🟡 | `llmVisibilityRuns` ＋ `Observations` 有保存，且 `boundedExcerpt` 刻意不存完整回應 |
| | measurement surface 分層 | ✅ | `observationMode` ＋ notNull `limitationCode` ＋ contracts 明文禁止 API 觀測冒充 primary |
| | 樣本數與不確定性顯示 | ⚪ | `sampleSize`／`confidenceInterval` 命中 0 |
| | competitor share 可測 | 🟡 | `competitorShareOfVoice` 算得出，但無 competitor registry |
| | citation freshness 可測 | ⚪ | 命中 0 |
| **Learning Loop**（1/7） | intervention 已登記 | ⚪ | 無 interventions 表 |
| | baseline 已保存 | ✅ | `outcome-learning/engine.ts` ＋ `baselineWindowStart/End`／`baselineSnapshot`，已接上 content-operations |
| | 部署已確認 / recrawl 觀測已記錄 | ⚪ ×2 | 無 recrawl 機制 |
| | post-outcome 已量測 | 🟡 | `contentOperationMeasurementSnapshots` ＋ `OutcomeAssessments` 有，但缺上游 intervention 綁定 |
| | 因果限制已陳述 | 🟡 | `limitations` 欄位在 measurement adapter 中確實有填（`ga4_zero_rows_is_not_api_failure` 這類），但沒有統計層的因果限制陳述 |
| | 結果進入 intervention-outcome dataset | ⚪ | 無此資料集 |
| **Agent Compatibility**（0/6） | 全部 6 條 | ⚪ ×6 | Phase 5 未開始 |
| **Security**（1/6） | tenant isolation 測試通過 | ⚪ | 無 tenant 軸，無跨租戶測試 |
| | SSRF / DNS rebinding 測試通過 | 🟡 | `server/audit/targetGuard.ts` 擋私有 IPv4 段、localhost、IPv6 ULA／link-local；`utils/publicSiteAnalysis.ts` 有 `lookup(hostname, {all:true})` 先解析再判斷。**但沒有連線後的 IP 釘選**，典型 DNS rebinding 仍可能成立 |
| | secret rotation 已測試 | ⚪ | `secretRotation` 命中 0，且 vault key 綁 `JWT_SECRET`（§9 第 6 條） |
| | signed webhook 防 replay | 🟡 | `geoflow-integration/signing-envelope.ts` 有簽章；`managedSitePaymentWebhookInbox` 有 inbox 去重 |
| | production 寫入完整稽核 | ✅ | 四張 event 表 ＋ receipt ＋ decision ledger，這一項是 repo 的強項 |
| | provider terms registry 最新 | ⚪ | `providerTerms`／`complianceRegistry` 命中 0。§19.2 明列為 MUST |

### 8.4 §26 核心資料表對照（50 張）

repo 有 **149 張表**，但與 §26 要求的 50 張只有部分交集。**表多不等於覆蓋率高** —— 149 張裡有 57 張是 `managedSite*`（代管商業流程），與 GEO 知識層無關。

| §26 要求 | repo 對應 | 判定 |
|---|---|---|
| `tenants` / `tenant_memberships` | `systemTenants` / `systemTenantBindings` | 🟡 存在但用途是 Frappe 供裝，非隔離軸 |
| `users` | `users` | ✅ |
| `sites` / `site_environments` / `site_verifications` | `managedSiteProjects` / `managedSiteVersions`＋`managedSitePreviews` / `managedSiteDomainClaims` | 🟡 語意對得上，但驗證卡在 broker |
| `connectors` / `connector_sync_runs` | `managedSiteIntegrations`＋`contentOperationMeasurementConnections` / `managedSiteConnectorReceipts`＋`contentOperationMeasurementRuns` | 🟡 只涵蓋 Search／Analytics 與發布，無 edge log |
| `bot_identities` / `bot_identity_versions` / `bot_policies` / `robots_versions` / `waf_change_sets` / `crawler_events` | — | ⚪ **6 張全無** |
| `url_inventory` / `crawl_snapshots` / `render_snapshots` / `sitemaps` | `auditPages` 勉強對到 crawl_snapshot 的一部分 | ⚪ **4 張實質全無** |
| `entities` / `entity_aliases` / `entity_external_ids` / `entity_edges` | — | ⚪ **4 張全無（護城河底座）** |
| `sources` / `source_versions` | `publicIntelligenceSources` / — | 🟡 有 source 無 version |
| `claims` / `claim_evidence` | — | ⚪ **2 張全無（護城河底座）** |
| `content_items` / `content_versions` / `content_blocks` / `content_entities` / `content_claims` | `seoGeoContentBriefs`＋`Drafts`＋`managedSitePages` / `managedSitePageVersions` / — / — / — | 🟡 前兩張有，後三張全無 |
| `authors` / `reviews` | — / `seoGeoContentReviews`＋`auditReviews`＋`llmVisibilityObservationReviews` | 🟡 有 review 無 author |
| `datasets` / `dataset_versions` | `geoOutcomeDatasetManifests` / `geoOutcomeDatasetMembers` | ✅ |
| `query_clusters` / `queries` / `internal_link_edges` | — / `llmVisibilityQueries`＋`contentOperationQueryOwnership` / — | 🟡 只有 prompt 級 query，無 cluster、無 link graph |
| `prompts` / `prompt_versions` | `llmVisibilityQueries`（含 promptText／promptHash） / — | 🟡 有 prompt 無 version |
| `benchmark_runs` / `citations` | `llmVisibilityRuns` / `llmVisibilityObservations`（含 citationUrls／citedDomain） | 🟡 語意對得上，但無重複執行 |
| `competitors` | — （只有 observation 上的 `competitorMentions` 欄位） | ⚪ |
| `referral_sessions` / `conversion_events` | — | ⚪ **2 張全無（護城河斷點）** |
| `interventions` / `experiment_results` | — | ⚪ **2 張全無（護城河斷點）** |
| `quality_score_versions` / `refresh_queue` | — | ⚪ |
| `audit_logs` | `managedSiteAuditEvents`＋`systemEvents`＋`contentOperationEvents`＋`auditRuns` | ✅ |

**§26 的 8 條 Critical constraints**：`tenant_id` 不得遺漏 ⚪（357 vs 2）／crawler events append-only ⚪（表不存在）／published content versions immutable 🟡／entity IDs immutable ⚪／active canonical URL 在 site+locale 下不得重複 ❓（未驗證）／claim 與 evidence 保留 version relation ⚪／benchmark run 關聯 prompt version 與 surface version 🟡（關聯到 hash 與 mode，非 version 實體）／delete 用 tombstone ❓（未逐表確認）。

### 8.5 §34 交付物與「不得算作完成」稽核

**必交付物 16 項 → 2 項完整、4 項部分、10 項完全不存在：**

| 交付物 | 有無 | 位置 |
|---|---|---|
| Architecture Decision Records | 🟡 部分 | `docs/managed-site-media-page-editor-adr.md`、`DISCOVERYSTACK_END_TO_END_DECISIONS_V1.md`、`SCROLL_MOTION_DECISION.md` —— **全部是功能級決策，沒有一份涵蓋 §4.1 reference stack 的替換**（規格允許替換 PostgreSQL→MySQL、Temporal→Nitro cron 等，但**必須有 ADR**） |
| System architecture diagram | ✅ | 本檔 §4 |
| Test plan and fixtures | ✅ | `tests/`（153 檔）＋ `tests/fixtures/` |
| Data retention matrix | 🟡 | `PUBLIC_INTELLIGENCE_POLICY.md` 只涵蓋 public-intelligence 一域 |
| Dashboard definitions | 🟡 | `pages/audit-lab/*.vue` 存在但無定義文件 |
| Operational runbooks | 🟡 | 僅 `docs/managed-site-editor-operations-v1.md` 一份；§29 列了 11 種需要 runbook 的情境 |
| Threat model | ⚪ | 不存在 |
| ERD | ⚪ | 不存在 |
| OpenAPI specification | ⚪ | 不存在（233 條 endpoint 無機器可讀契約） |
| Event schemas | ⚪ | 不存在 |
| Bot policy registry | ⚪ | 不存在 |
| Connector permission matrix | ⚪ | 不存在 |
| Provider terms matrix | ⚪ | 不存在（§19.2 MUST） |
| Migration plan | ⚪ | 不存在（34 個 migration 從未實際套用過） |
| Rollback plan | ⚪ | 不存在 |
| Sample tenant 與可重現 demo | ⚪ | 不存在 |

**§34「不得算作完成」9 條紅線的實際觸發情況：**

| 紅線 | 是否觸發 | 說明 |
|---|---|---|
| `empty Entity Graph tables` | **不觸發（更嚴重）** | 不是空表，是**沒有表** |
| `single-run benchmark` | ⚠️ **觸發** | `llm-visibility-probes` 無重複執行機制 |
| `manual-only crawler verification` | ⚠️ **觸發（類比）** | 沒有 crawler 驗證；LLM 觀測的 primary 指標是 `manual_verified` |
| `UI exists but no ingestion` | ⚠️ **觸發** | GSC／GA4 有 7 條路由 ＋ UI，但憑證解析器恆回 `null`，永遠取不到資料 |
| `API exists but HTML uses a different source` | ⚠️ **觸發（變體）** | 5 個孤兒引擎共 5,767 行有完整 API 形狀但零 production consumer |
| `recommendation without validation` | ⚠️ **觸發** | `recommend.post.ts` 產出策略，但沒有 intervention→outcome 迴路來驗證它是否有效 |
| `fake quality score` | ✅ **未觸發** | 這一點 repo 做得好：`frictionAssessments.assessmentStatus` 有 `insufficient_evidence`，`llm-visibility/contracts.ts` 明文禁止 API 觀測冒充 primary，measurement adapter 每筆都帶 `limitations`。**專案的誠實度是真實資產** |
| `placeholder dashboard` | ✅ 未觸發 | dashboard 接的是真實 repository |
| `hard-coded sample data` | ✅ 未觸發 | 未發現 production 路徑上的寫死假資料（mock 都在 test fixture 或明確標示的 `deterministic-injected-mock`） |

### 8.6 統計

| 狀態 | 數量（§8.2 主看板，共 64 列） | 占比 |
|---|---|---|
| ✅ VERIFIED COMPLETE | 2 | 3% |
| 🟦 IMPLEMENTED — UNVERIFIED | 13 | 20% |
| 🟡 PARTIAL | 16 | 25% |
| 🟠 STUB / DEMO / MOCK | 9 | 14% |
| ⚪ MISSING / NOT STARTED | 23 | 36% |
| ❓ UNKNOWN | 1 | 2% |

**怎麼讀這張表**：⚪ 佔 36% 不代表「三分之一沒寫」，而是「這個規格要求的東西，有三分之一在 repo 內完全找不到痕跡」。同時 🟦 只有 13 列而 🟡 有 16 列 —— 已完整實作但缺真實驗證的，比缺一段的還少。**這個專案的主要缺口不是品質，是覆蓋面。**

**五個 Phase 的 Exit Gate 目前全部未通過**，而規格 §32 明訂在第一條 vertical slice（15 步）跑通前，「不得把空的 Entity Graph、假 GEO Score 或只有幾筆測試資料的 Observatory 宣稱完成」。**該 slice 的第 3–7 步（偵測 hosting／CDN／WAF／CMS、edge log、robots 稽核、crawler 身分、raw/rendered/canonical/sitemap 稽核）在 repo 內完全沒有對應實作，第 13–15 步（recrawl 確認、citation/referral/conversion outcome、intervention 登記）亦然。**

---

## 9. 地雷區

1. **`/v1/managed-sites/*` broker sidecar 不存在於本 repo。** `hmac-broker-transport.ts`、`deployment-transport.ts`、`broker-adapters.ts` 會發出格式完整、HMAC 簽章正確的真實 HTTP 請求，但對端服務從未被實作。**網域購買、DNS/TLS、付款、部署四大商業能力全部依賴它。** 這不是假資料，是假對端 — 比假資料更難察覺。

2. **3 個 defineTask 被打包進 production 但永遠不會執行。** `content-operations:{tick,execution-tick,measurement-tick}` 定義齊全、確實出現在 `.output/server/chunks/tasks/`，但不在 `nuxt.config.ts#scheduledTasks`（那裡只有 4 個）、也無任何 `runTask` 呼叫者。
   **本次改版新增的關鍵發現**：`measurement-tick` 正是 GSC／GA4 量測收集的排程器。因此 §8.2 的「GSC／GA4 真實資料擷取」被**三層同時擋住**——adapter 是真的（會打 Google API）、憑證解析器恆回 `null`、排程根本沒註冊。三層都要補才會有第一筆真實流量資料，而那正是護城河鏈斷掉的那一環。

3. **前端完全沒有路由守衛。** `nuxt-app` **沒有 `middleware/` 目錄**，`layouts/owner.vue` 內零 auth 邏輯，`definePageMeta` 只設 `{ i18n: false, layout: 'owner' }`。頁面殼會對未登入者渲染，資料靠 `$fetch` 401 後自行導向。**實際授權邊界 100% 在 server API 層** — 這在防護上足夠（無資料洩漏），但與文件敘述的「private page 在 guard 之後」不符，且任何人若誤以為前端有守衛而放寬 server 檢查就會出事。

4. **CSRF 防護不一致。** `system-factory/http.ts` 與 `page-editor/http.ts` 有 `assertSameOriginMutation`／`assertEditorSameOrigin`；**`live-connectors/http.ts#managedSiteOwnerContext` 完全沒有**。`deploy`、`domain-purchase`、`payment-bind` 這類不可逆的 owner mutation 只靠 `sameSite: 'lax'` cookie。另外 `POST /api/managed-sites/invitations/accept` 是唯一一條無 session 又無 same-origin 檢查的 token 換 session 端點（對照 system-factory 版本有）。

5. **測試注入 seam 的防禦深度不一致。** `managedSiteOwnerContext` 在 `requireOwner` **之前**檢查 `testDependencyFactory`，讀取端沒有 `NODE_ENV === 'test'` 檢查 — 但**寫入端 `setManagedSiteRouteDependencyFactoryForTests` 有硬守衛**（非 test 環境 throw 403），所以 production 無法被設定。**這是縱深防禦的不一致，不是可利用的繞過。**

6. **Provider vault master key 直接派生自 `JWT_SECRET`。** `server/utils/provider-vault.ts#runtimeProviderMasterSecret` 回傳 `runtime.sessionSecret`。輪換 session secret 會使所有已存 provider 憑證**無法解密**；反之洩漏 `JWT_SECRET` 等於同時洩漏整個 vault。**規格 §33 Security 明列「secret rotation tested」為 DoD 條件 — 以目前的耦合，rotation 根本不可能安全執行。**

7. **兩個 `/customer/managed-sites` 私有頁的 header 保護不完整。** `nuxt.config.ts#routeRules` 涵蓋 `/customer/managed-sites/editor`，但 **`/customer/managed-sites`（index）完全沒有任何 routeRule** — 既無 noindex 也無 no-store。`/ml-lab-preview`、`/en/audit-lab`、`/zh-hant/audit-lab` 只有 noindex，沒有 `Cache-Control: no-store`。`/api/**` 的 routeRule 也只有 noindex，`no-store` 靠各 handler 自律。

8. **Release marker 硬編碼在 5 個地方。** `nitro-public-intelligence-20260818-r17-immutable-readiness-ssr` 出現在 `server/api/__release.get.ts#OAUTH_NITRO_RELEASE`、`server/api/auth/login.get.ts`、`server/api/auth/callback.get.ts`、root `Dockerfile` 的最終 `grep`、以及 `tests/oauth-origin.contract.test.ts` 的斷言。**改一處漏四處 → Docker build 在最後一步失敗。** 沒有 single source of truth。

9. **兩個 Dockerfile 不等價。** root 版本（真正使用）有 `--frozen-lockfile`、stale-artifact guard、`NITRO_HOST=0.0.0.0`；`nuxt-app/Dockerfile` 用 `pnpm install`（允許 lockfile 漂移）、**沒有 `NITRO_HOST`**（多數容器平台會綁 localhost 而收不到外部流量）。沒有任何檔案說明哪個是正式的。

10. **`vue-router` 版本註解與實際不符。** `nuxt.config.ts` 註解寫「installed Vue Router **4.x**」，但 `package.json` 宣告 `^5.2.0`、lockfile 實際解析到 **`vue-router@5.2.0`**。`experimental.typedPages: false` 是基於這個錯誤前提被永久關閉的。

11. **測試與建置跑在不同 Vite 引擎上。** `nuxt-app` 樹內同時有 `vite@8.2.1`（Nuxt/Nitro）與 `vite@7.1.9`（Vitest）。pnpm 能隔離，但這正是「本機測試綠、production build 掛」的溫床。

12. **cron 隱含單一長駐實例。** 4 個 cron 走 Nitro in-process scheduler：水平擴到 N replica 會讓每個 tick 同時跑 N 次（要靠 task 內部的 lease／冪等擋）；scale-to-zero 或 serverless 平台上 scheduler 根本不會醒來。**規格 §4.1 的參考堆疊是 Temporal／Cloud Tasks 這類外部排程器；改用 in-process cron 是允許的替換，但 §34 要求替換必須有 ADR，目前沒有。**

13. **記憶體門檻已被證實不足（本次改版更新）。** 原記錄為「1536MB 剛好夠但從未被 CI 驗證」。CI 上線後第一次 push（run `33343250803`）就在 `pnpm build` 這一步以 1536MB **失敗**，門檻隨後調到 `--max-old-space-size=4096` 才通過。**這條從「疑慮」升級為「已證實」：本機一次通過不代表門檻正確，只代表本機當時的記憶體壓力比 CI 低。** 現行 CI 的 typecheck 步驟還沒設 `NUXT_BUILD_TYPECHECK=false`，因此 `vue-tsc` 實際跑了兩次。

14. **測試執行時間在 CI 上有真實變異，且被 timeout 遮住。** ModelOps 相關測試在本機約 2 秒、CI 第一次 4451ms、第二次超過 5000ms。目前的處置是把 timeout 放寬到 `15000`。**這掩蓋了變異而不是消除它** — 真正的問題（該測試為什麼會慢 2.5 倍）沒有被回答。

15. **root `package.json` 是 hosting template 殘留，且含危險的死 script。** 證據：`template.json`（`"id": "web-db-user"`）內嵌了與 root `package.json` 幾乎逐字相同的 JSON。`build`、`start`、`check`、`test` 全部指向不存在的輸入。特別注意 **`db:push` = `drizzle-kit generate && drizzle-kit migrate`** — 名字危險（`migrate` 會實際套用）且 root 沒有 `drizzle.config.*`。另有孤兒 `patches/wouter@3.7.1.patch`（root `Dockerfile` 還在 COPY 它）。root `packageManager` 是 `pnpm@10.4.1`，與其他兩個 app 及 CI 的 `10.24.0` 不一致。**建議至少先刪掉 `db:push`。**

16. **兩個寫死的絕對路徑綁定某台特定機器。** `nuxt-app/scripts/capture-scroll-story-state.mjs`（`/home/ubuntu/screenshots/`）與 `scripts/export-training-snapshot-101.mts`（`/home/ubuntu/private-training-output`）。有 `process.argv` 覆寫，但預設值在其他環境會靜默寫錯位置。

17. **`drizzle.config.ts` 的 `DATABASE_URL` fallback 是 `mysql://placeholder:placeholder@localhost:3306/placeholder`。** 不是 secret 洩漏，但意味著未設定時 drizzle-kit 會安靜地指向本機而非報錯。

18. **root `CLAUDE.md` 被 `.gitignore` 排除且未被 git 追蹤。** 專案級指引不進版控 — 團隊成員與 CI 拿不到它。

19. **`fileParallelism: false`。** 153 個測試檔序列執行，這是記憶體能壓住的原因之一，但**無法暴露跨檔案的並發／共享狀態問題**，且時間隨檔案數線性成長（CI 上 nuxt-app job 已需 5 分鐘）。

20. **公開白名單複製了兩份。** `public-site/src/lib/publicApi.ts#PUBLIC_API_PATHS` 與 `server/utils/publicCors.ts#PUBLIC_CORS_PATHS` 各自硬編碼同一組路徑，沒有共享來源。**新增公開 API 必須同時改兩處。**

21. **無 `Origin` header 的請求繞過 CORS（by design）。** `publicCors.ts` 對非 preflight 且無 Origin 的請求回 `{ allowed: true, reason: 'same-origin' }`。CORS 本來就不是驗證機制，但這代表 `/api/leads` 與 `/api/site-analysis` 對非瀏覽器 client 完全開放，只靠 site-analysis 的 8 次/小時 rate limit（且是 in-memory，多實例下失效）與 leads 的 honeypot。

22. **SSRF 防護擋得住直接私有位址，擋不住 DNS rebinding。** `server/audit/targetGuard.ts` 有完整的私有 IPv4／IPv6／localhost 黑名單，`utils/publicSiteAnalysis.ts` 也先 `lookup(hostname, { all: true })` 再判斷。**但解析與連線之間沒有 IP 釘選** — 攻擊者控制的 DNS 可以在兩次查詢間換答案。規格 §33 Security 把「SSRF and DNS rebinding tests pass」列為單一條件，目前只滿足前半。

23. **repo 內文件本身含有已被證偽的敘述（文件是證據，不是事實）。** `CLAUDE.md` 把 `delivery-automation` 列為「有 HTTP handler 在 `server/api/` 底下」的 domain engine；實測 `server/` 內對它的非自身 import 為 **0**。這類文件漂移在本 repo 不只一處，讀規格時請一律回頭驗程式碼。

24. **5 個完整引擎共 5,767 行沒有任何 production consumer。** `authority-intelligence`（865）、`delivery-automation`（1,484）、`first-party-content-site-kit`（1,188）、`geo-content-evaluation`（1,078）、`market-intelligence`（1,152）。每個都有自己的 `*_V1.md` 規格、有測試、測試會過。**它們不是死碼（測試在用），但也不是活的產品能力。** 這是本 repo 最大的單一結構性問題：它讓「已完成的模組數」這個指標嚴重高估實際交付。

---

## 10. 掃描元資料

**基準**
- 初次全掃 `HEAD` = `898b6f9`（`docs: record GEO engineering v2 implementation status`）
- 本次改版 `HEAD` = `d51d403`（`docs: track GEO Engineering Spec v2.0 as the acceptance baseline`）
- Working tree：**clean**
- 分支：只有 `main`；無 stash、無額外 worktree、`git rev-list --left-right --count HEAD...@{upstream}` = `0 0`
- → **「沒做完的東西不是躺在別的分支」**，是真的沒寫。接手他人半成品時最常見的誤判已排除。

**掃描深度**：深度掃描（3,191 tracked files，扣除 2,073 個 vendored `services/` 後真實工作面約 1,051 檔；233 endpoint、149 表、34 migration、OAuth／多租戶／金流／網域／部署契約、媒體上傳＋S3、ML pipeline）。

**流程**：Phase 1 單線程靜態偵察 → 一輪 AskUserQuestion 關卡（產品目的／必要功能／執行授權／subagent 同意）→ Phase 2 四個唯讀 specialist 平行深掃（單一波次，無追加）→ Phase 3 主 Claude 逐條複驗 → **改版：逐條讀完 v2.0 規格 2,251 行，重寫 §8。**

**執行授權（使用者批准層級 C，僅限本 repo、以下精確命令）**

| 命令 | 結果 |
|---|---|
| `cd nuxt-app && pnpm typecheck` | ✅ PASS，0 diagnostics |
| `cd nuxt-app && NODE_OPTIONS=--max-old-space-size=1536 NITRO_PRESET=node-server pnpm build` | ✅ PASS（本機），`.output` 31.4 MB。**同一命令在 CI 上失敗，見 §9 第 13 條** |
| `cd nuxt-app && NODE_OPTIONS=--max-old-space-size=1536 NITRO_PRESET=node-server pnpm vitest run` | ✅ PASS — 143 檔通過／10 檔 skip；3799 tests 通過／20 skip，64.93s |
| `cd public-site && pnpm vitest run tests/public-forms.interaction.test.ts tests/public-visual-contract.test.ts` | ✅ PASS，2 檔／12 tests，0.63s |

執行**不修改 tracked source 或持久產品狀態**；經授權的驗證產生了 ignored 暫存物（`.nuxt/`、`.output/`）。

**CI 證據（由另一個對話窗建置，本檔僅引用其結果）**
- `.github/workflows/ci.yml`，每次 push／PR 對兩個 app 各跑一個 job。
- 最終綠燈 run `33359408453`：public-site 30s（7 檔／1.97s）、nuxt-app 5m4s（143 passed ＋ 10 skipped／138.75s）。
- 過程中暴露三個本機掩蓋掉的問題：build 記憶體門檻不足、測試執行時間變異、以及 `vue-tsc` 被跑兩次。前兩項已進 §9。

**已知盲區**
1. 未在真實 MySQL/TiDB 上執行任何查詢或 migration。**34 個 migration 從未實際套用過。**
2. 未對任何外部 provider 發出真實請求（Firecrawl／HuggingFace／Bailian／Gemini／GA4／GSC／Shopify／Frappe／OpenAI／Perplexity 全部未驗證）。依專案規約，`pnpm test:external-credentials` 記為 **NOT RUN／NOT PROVIDER VALIDATION**，不得視為通過。
3. 未執行 `pnpm audit` 或任何網路命令 → **沒有 CVE 判定**。
4. `services/geoflow/`、`services/autogeo/`（2,073 檔）僅做邊界確認（已驗證 `nuxt-app` 零 import），未做內容審查。
5. 61 條 owner-only 路由的 repository 層是否**每一條**都有 `ownerUserId` 綁定，未逐一檢查。
6. 未執行 coverage instrumentation → 測試對應是 import-graph 接觸面，**不是行覆蓋率**。
7. `orchestrator.ts#executeMultiChannelPublicationPath`（約 220 行）未逐行讀完。
8. **§8.4 的 50 張表對照是語意對照，不是欄位級對照。** 標 🟡 的表代表「概念上對得上」，不代表欄位、約束、生命週期符合規格。真正的 gap 只會在寫 ERD 時才完全顯露。
9. 未驗證 §26 的 8 條 critical constraints 中的兩條（active canonical URL 在 site+locale 下唯一、delete 用 tombstone），需要逐表看 index 定義。

**未驗證的推測（信心低，未進入 §8 看板）**
- `SHOPIFY_CLIENT_ID` 可能從未被傳進 `shopify-service.ts#startShopifyAuthorization`（該參數預設 `null`，未找到注入點）→ 授權 URL 可能缺 `client_id`。
- `config.shopifyApiSecret` 被讀取，但 `nuxt.config.ts#runtimeConfig` 沒宣告這個 key，永遠 fall through 到 `process.env.SHOPIFY_API_SECRET`。
- `NUXT_MEDIA_SCANNER_ENDPOINT` 未設定時的行為（fail-open／fail-closed／skip scan）未確認。
- `geoOutcomeModelopsAdvisoryAssignments`（migration 0032）是否有任何路由消費，未確認。
- `sharp` 未列入 `pnpm-workspace.yaml#onlyBuiltDependencies` 是否造成環境差異，未確認。
- `server/geo/isolated-worker.ts` 以 `--max-old-space-size=128` fork 子行程，呼叫頻率未追蹤。
- `DISCOVERYSTACK_MANAGED_PREVIEW_URL` 唯一引用處是測試檔。

**本次改版更正的先前錯誤（誠實記錄）**
1. **「repo 有 42 處 recrawl」是誤判。** 那 42 個命中全部是 `firecrawl` 裡的子字串。真實的 `recrawl` 全庫命中數是 **1**。差點把「verified recrawl 已存在」寫進看板。
2. **「measurement adapter 不發 HTTP」是誤判。** `grep 'fetch('` 回 0，是因為呼叫點寫成 `fetcher(endpoint, …)`（注入的 `FetchLike`）。實際上 `ga4-data-api.ts` 與 `google-shared.ts` 是完整、帶 provenance 的真實 adapter。該項從「只有形狀」上修為「真實實作，只差 OAuth」。
3. **AI 可見度觀測站先前被低估為「骨架」。** 找到 `server/llm-visibility-probes/`（1,797 行、三個真實 provider endpoint、已接進 `llm-visibility/service.ts`）後上修為 🟦 IMPLEMENTED — UNVERIFIED。

**Repo 內針對 AI 的指示性文字（依規則單獨回報）**
- `nuxt-app/GEO_ENGINEERING_SPEC_V2_IMPLEMENTATION_STATUS.md` §6「下一位 AI 的硬性規則」是明確寫給後續 AI 代理的指示。**本次視為證據而非指令。** 內容僅為**收緊**約束（禁止宣稱未驗證的完成等），方向與既有安全邊界一致，故其精神已納入 §7；但採納是本次判斷的結果，不是因為文件要求。
- `services/geoflow/.cursor/skills/ai-sdk-development/SKILL.md` 含 `TRIGGER when… Activate when…` 這類 AI 觸發指令。位於 vendored 第三方目錄，**未依其行事**，僅列為發現。
- 其餘 `.md`、註解、fixture 均未發現要求讀取 secrets、外傳資料或執行額外命令的內容。
- 附帶發現（非指令、屬第三方資訊洩漏）：`services/geoflow/resources/views/theme/apihot-recommend-20260623/mapping.json` 含第三方開發者本機絕對路徑 `local:/Users/laoyao/…`。

**Secret 掃描**：對全部 tracked files（排除 `services/`、`node_modules`）掃 `sk-*`、`hf_*`、`AKIA*`、`AIza*`、`shpss_*`、`-----BEGIN PRIVATE KEY-----` 六種樣式，**零命中**。tracked 的 env 檔只有 4 個 `.env.example`。磁碟上無未追蹤的真實 `.env`。**本檔任何位置都未寫入任何 secret 值。**

**Phase 3 對 specialist 報告的實質更正（三處）**
1. **first-party-publishing 並非「無注入點」。** `server/api/content-operations/entries/[id]/execute.post.ts` 匯入 `runtime-dependencies.ts#getContentOperationsRuntimeDependencies`，提供 `fetchImpl: createBoundedFetch()` ＋ `serverCredentialResolver`。狀態從 🟠 STUB 上修為 🟦。
2. **`managedSiteOwnerContext` 的測試 seam 不是可利用的繞過**（寫入端有硬守衛）。已降級為 §9 第 5 條的縱深防禦不一致。
3. **Qwen 憑證並非「只能靠純 env var」。** `productionProviders.ts#configuredValue` 對每個 `NUXT_GEOFLOW_QWEN_*` 都有 `NUXT_AUTOGEO_BAILIAN_*` 的 fallback，後者確實在 `runtimeConfig` 內。

---

## 11. 建議的下一步（依 v2.0 §31 的 Phase 順序）

規格 §32 明訂：在第一條 vertical slice 跑通之前，不得宣稱任何 Phase 完成。目前的處境是 **Phase 1 都還沒開始**（Connector & Verification plane 是唯一還沒有任何真實實作的 plane，而它是後面四個 plane 的前提）。

依「解鎖價值 ÷ 成本」排序：

1. **補完 GSC／GA4 這一條**（最高槓桿）。三件事：註冊 `content-operations:measurement-tick`、實作 Google OAuth 的 `GoogleReadOnlyCredentialResolver`、跑一次真實 property。adapter 已經寫好了。**這是唯一一件能讓護城河鏈往前接一格的低成本工作。**
2. **決定多租戶的命運。** `ownerUserId`（357 處）→ `tenantId` 的遷移，愈晚做愈貴，且 §5.1 是 MUST。若商業上確定單一 owner 就夠，就寫一份 ADR 明確偏離規格；**不要讓它一直懸著。**
3. **處理 5 個孤兒引擎（5,767 行）。** 每一個都要有明確歸屬：接上 production consumer、或標記為未來階段、或刪除。維持現狀是最糟的選項。
4. **Entity Graph ＋ Claim Ledger**（`entities` / `entity_aliases` / `entity_external_ids` / `entity_edges` / `claims` / `claim_evidence`，6 張表）。這是 §33 Knowledge & Evidence 整類 6 條的唯一前提，也是產品差異化的核心。
5. **Crawler 與 Edge 可觀測性**（`bot_identities` / `bot_policies` / `robots_versions` / `waf_change_sets` / `crawler_events` / `url_inventory`）。工程量大且依賴外部 CDN／WAF 接入，但 §33 Crawler & Access 全 7 條都卡在這裡。
6. **`interventions` ＋ `experiment_results` ＋ `referral_sessions` ＋ `conversion_events`。** 護城河那句話最後兩格。技術上不難，難的是前面五項要先到位才有資料可餵。

短期可順手清掉的：root `package.json` 的 `db:push` 死 script（§9 第 15 條）、CI 的 `NUXT_BUILD_TYPECHECK=false`（省一次 `vue-tsc`）。

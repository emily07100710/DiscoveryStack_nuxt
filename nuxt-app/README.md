# DiscoveryStack

DiscoveryStack 是一個以 **Nuxt 4.5.2** 建立的雙語（English / 繁體中文）SEO/GEO-first growth marketing website。公開層以預渲染、語意 HTML、可見內容對應的結構化資料與 answer-first 內容叢集為優先；私有層則提供 Lead capture、owner-only Audit Lab、Journey Intelligence 的人工覆核與可追溯 Public Intelligence 資料治理。

> **重要邊界：** 本專案不保證排名、不宣稱公開網站的真實轉化成效、不公開任何機密客戶案例，也不宣稱已訓練模型。BGE-M3 目前是 gated similarity pilot；supervised training 只能在同意、去識別、人類覆核、品質檢查、資料版本及保留的 holdout set 都準備完成後開始。

| 層級 | 技術與用途 |
|---|---|
| 公開網站 | Nuxt 4、Vue 3、Nuxt Content、Nuxt I18n、Nuxt Image、Nitro prerender。 |
| SEO / GEO | `/en/**` 和 `/zh-hant/**` route-based i18n、canonical、`hreflang`、`x-default`、JSON-LD、robots、llms.txt、sitemap。 |
| Lead | Nitro API、Zod validation、privacy consent、honeypot、去重與節流；資料儲存在 MySQL/TiDB-compatible database。 |
| Private operations | Signed owner session、OAuth callback、owner-only Audit Lab、`X-Robots-Tag: noindex, nofollow, noarchive`。 |
| Journey Intelligence | 可版本化 taxonomy、可解釋規則 baseline、人工 review、consent revoke、BGE-M3 similarity gate、Public Intelligence Source Card、typed artifacts 與 dataset manifest lineage。 |

## 本機開發

系統使用 `pnpm@10.24.0`。請使用 Node.js 22 以上版本，並從專案根目錄執行以下指令。

```bash
pnpm install
pnpm dev
```

| 指令 | 用途 |
|---|---|
| `pnpm dev` | 啟動 Nuxt 開發環境。 |
| `pnpm typecheck` | 執行 Nuxt / Vue TypeScript 檢查。 |
| `pnpm test` | 執行 Vitest regression tests。 |
| `pnpm generate` | 產生公開靜態輸出，驗證 pre-rendered HTML；不應拿來取代有 Nitro API 的 server deployment。 |
| `pnpm build` | 建立 Nuxt/Nitro server artifact，供需要 Lead、OAuth、Audit Lab 的 production deployment 使用。 |
| `pnpm db:generate` | 從 Drizzle schema 產生 migration SQL。產生後必須先審查 SQL，再以受控資料庫 migration 流程套用。 |

## 路由與搜尋可見度

公開內容使用 prefix i18n：`/en` 與 `/zh-hant`。根路徑 `/` 以 302 導向 `/en`。所有公開頁在正式域名設定後會輸出自己的 canonical、兩個語言 alternate 及 `x-default`；所有私有 `/audit-lab` 與 `/api/**` 路徑一律不可索引。

| 資源 | URL | 用途 |
|---|---|---|
| Crawler policy | `/robots.txt` | 公開與私有路徑的存取規則。 |
| AI research guide | `/llms.txt` | 品牌、公開內容與研究邊界摘要。 |
| Sitemap | `/sitemap.xml` | 公開雙語 URL 與 alternate 關係。 |
| Private operations | `/audit-lab` | Owner sign-in required，不是公開內容頁。 |
| Consented training pipeline | `/training-pipeline` | Owner sign-in required；審核去識別候選、資料門檻與 collection ledger。 |

在尚未配置 `NUXT_PUBLIC_SITE_URL` 前，網站以 `https://discoverystack.example` 作為安全 placeholder，並以 staging 防誤索引策略運作。**不要在未有正式網域、正確 canonical 與 Search Console 驗證前要求搜尋引擎收錄。**

## 環境變數與秘密

秘密只能由部署平台的 Secrets/環境設定提供；請勿將 `.env`、token、資料庫 URL 或 session signing key 提交到 Git。`runtimeConfig.public` 僅包含 `siteUrl`，不應加入任何私密設定。

| 變數 | 是否必須 | 用途與邊界 |
|---|---:|---|
| `NUXT_PUBLIC_SITE_URL` | 正式上線必須 | 例如 `https://www.example.com`；用於 canonical、hreflang、robots、sitemap。 |
| `DATABASE_URL` | Lead / Audit Lab 必須 | MySQL/TiDB connection string；server-only。 |
| `JWT_SECRET` | Private session 必須 | 簽署 owner session；server-only。 |
| `OAUTH_SERVER_URL` | Private session 必須 | OAuth code exchange endpoint；server-only。 |
| `VITE_OAUTH_PORTAL_URL` | Private sign-in 必須 | OAuth portal base URL。 |
| `VITE_APP_ID` | Private sign-in 必須 | OAuth application identifier。 |
| `OWNER_OPEN_ID` | Private operations 必須 | 唯一可開啟 owner-only routes 的 Open ID；server-only。 |
| `HUGGINGFACE_API_TOKEN` | BGE-M3 pilot 可選 | 僅由 server 呼叫 Hugging Face；不寫入資料庫、HTML、frontend bundle 或 Git。 |
| `MODEL_IMPROVEMENT_CRON` | 可選 | Nitro cron，預設 `0 18 * * *`（UTC 部署環境為台北隔日 02:00）。 |
| `NUXT_MODEL_IMPROVEMENT_AUTO_TRAIN` | 可選，預設關閉 | 設為 `true` 後，只會對最新且 owner 已核准、通過 150/各階段 20 筆門檻的 manifest 建立 training job；不自動部署模型。 |

## 資料庫與 migration

資料模型由 `server/database/schema.ts` 管理，使用 Drizzle / MySQL driver。已建立的 migration 覆蓋 users、leads、Audit governance 與 Public Intelligence lineage。請遵循 schema-first 流程：修改 schema、執行 `pnpm db:generate`、逐行審查產生 SQL，最後透過受控 migration 工具套用。

公開研究資料、明確授權的第一方資料與可部署訓練資料不能混為同一資料集。Public Intelligence 的每個來源都應有 Source Card，至少記錄來源 URL、terms/robots review、著作權與 PII 風險、用途上限、保留期限與 reviewer note。Artifact 必須有 typed feature contract、source locator 及 SHA-256 source span hash；quality-passed artifacts 才能被選入 versioned dataset manifest。

## Journey Intelligence 與模型訓練

目前 workflow 的正確順序如下：

1. Owner 建立有明確 public-review authorization 的 workspace 或 Source Card。
2. 策略師新增可複核的最小觀察或 typed public artifact。
3. 人類確認／修正 friction assessment，並標示品質狀態與 training consent。
4. 使用者可隨時 revoke consent；既有 candidate 會從未來模型工作撤除，但 audit history 仍保留。
5. BGE-M3 只在 server token 已配置且合格去識別 candidate 足夠時產生 **similarity ranking**，供人類 review；它不是 trained model。
6. 僅在資料量、各 label/stage 覆蓋、dataset/split/taxonomy/feature-contract version、保留 holdout set 及評估計畫都完成後，才建立可重現 supervised training job。

`PUBLIC_INTELLIGENCE_POLICY.md` 說明公開來源使用政策；`VALIDATION_MATRIX.md` 記錄已完成驗收與刻意不宣稱完成的項目。

## 正式網域與 Search Console checklist

在發布前，應先設定正式網域，然後將相同值寫入 `NUXT_PUBLIC_SITE_URL`。重新 build / deploy 後，抽樣檢查 `/en`、`/zh-hant` 與內容頁的 canonical、`hreflang`、`robots.txt`、`llms.txt`、`sitemap.xml`；確認 staging noindex 不會殘留在 production。

接著在 Google Search Console 驗證網域，提交正式 sitemap，觀察 Indexing、Page Experience 與 International Targeting 訊號。也應在 Bing Webmaster Tools 提交 sitemap。不要把 sitemap submission、開啟 robots 或提交 Search Console 視為排名保證；它們只讓 crawler 可以正確發現與理解公開內容。

## 上線後人工驗收

下列項目需要真實 owner 與 production-like domain，不能以假 session 或靜態檔案取代：

| 驗收 | 完成條件 |
|---|---|
| Owner OAuth | 登入 `/audit-lab` 後，session endpoint 回 200，owner-only workspace／Source Card／artifact workflow 可使用。 |
| Public source reviews | 四個既有公開研究網站逐筆完成 terms/licence、PII、retention 與用途審核；robots 不可作為單一訓練許可依據。 |
| Accessibility | 使用鍵盤走過公開 header、AI QA、Lead form 與 private Audit Lab；抽查 focus order、error announcement 和 screen reader labels。 |
| Performance | 在候選 production domain 執行 Lighthouse / PageSpeed Insights，記錄 LCP、CLS、TBT/INP proxy 與 hero image / font / content runtime 的優化結論。 |
| Model readiness | 僅在實際合格資料達 gate 後執行 BGE-M3 pilot 或 supervised training；將結果、版本、holdout metrics 與失敗案例寫入 audit evidence ledger。 |

## 驗收狀態

最新自動驗收為 `pnpm generate` 成功（40 條 prerender output）、52 項 Vitest regression tests 通過，以及 `pnpm typecheck` 通過。請以 `VALIDATION_MATRIX.md` 為完整的驗收與已知限制紀錄；owner OAuth、Search Console／Bing 與 Lighthouse 仍屬人工／正式營運驗收。

## Git 交付安全

交付前已以 `git check-ignore` 驗證 Nuxt `.output/`、`.nitro/`、暫存目錄、私鑰／憑證、token、SQLite 與 archive 樣本會被忽略；`.gitignore` 也涵蓋所有 `.env*`。已追蹤檔案名稱掃描未發現 credential 或 binary export 類型。請維持此原則：秘密只放在部署平台設定，資料庫 migration SQL 與 schema 可以進入 Git，但資料庫檔案、dump、checkpoint archive 與任何憑證不可進入 Git。

早期無變更 checkpoint：`976dd49d`；**第一個具實質驗收內容的可恢復 checkpoint**：`d361db12`（淺色四場景 scroll-story、fallback preview、互動診斷與 SEO/GEO readiness）。最新已驗證 checkpoint：`b23641cf`（完整 static output、52 項回歸、雙語 native hydration）。私有 GitHub source repository：[`emily07100710/DiscoveryStack_nuxt`](https://github.com/emily07100710/DiscoveryStack_nuxt)。

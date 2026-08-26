# DiscoveryStack private Nuxt ops

這個 `nuxt-app` 是 DiscoveryStack 的 **private operations、owner workbench 與 API runtime**。公開品牌網站、SEO/GEO 內容、雙語文章、robots、sitemap、llms.txt、公開表單介面與 bounded website analysis UI 已由同一個 repository 下的 `public-site/` Astro static app 負責。

> **邊界：** Nuxt 不再產出公開 `/en/**`、`/zh-hant/**` 官網路由，也不再持有公開 content collection、public layout 或 public CSS。Nuxt root `/` 只會 302 導向 `/audit-lab`；private pages 與 server APIs 維持 owner/auth/database/provider 邊界。

| 層級 | Owner | 技術與責任 |
|---|---|---|
| Public site | `../public-site` | Astro 7.2.4 static output、Vue islands、Markdown content collection、SEO head、robots、sitemap、llms.txt、公開 forms。 |
| Public API | Nuxt server | 只有 `POST /api/leads` 與 `POST /api/site-analysis` 提供 public-site 使用；保留既有安全 schema、DNS/IP safety、consent、honeypot、節流與去重。 |
| Private operations | Nuxt pages/layout | `/audit-lab`、`/audit-lab/geo`、`/audit-lab/seo-geo`、`/leads`、`/training-pipeline`、`/ml-lab-preview`；owner session、OAuth、noindex、no-store。 |
| Governed core | Nuxt server | Evidence、Diagnosis、AutoGEO-compatible strategy、GEOFlow production plan、risk gate、human review、preview/export ledger 與 revision lifecycle。 |
| Data/ML | Nuxt server/tasks | Drizzle/MySQL、Public Intelligence lineage、consent/revoke、BGE-M3 similarity pilot 與 gated training；不自動部署模型或外部內容。 |

## 本機開發

兩個應用程式分開執行，避免 public-site 把 owner cookies、Nuxt runtime 或 private provider 帶入瀏覽器 bundle。

```bash
# public static site
cd public-site
pnpm install --frozen-lockfile
PUBLIC_SITE_URL=http://localhost:4321 \
PUBLIC_OPS_API_ORIGIN=http://localhost:3000 \
PUBLIC_OPS_UI_ORIGIN=http://localhost:3000 \
pnpm dev

# private Nuxt ops/API
cd ../nuxt-app
pnpm install --frozen-lockfile
DISCOVERYSTACK_PUBLIC_SITE_ORIGIN=http://localhost:4321 pnpm dev
```

正式環境的 `PUBLIC_SITE_URL`、`PUBLIC_OPS_API_ORIGIN`、`PUBLIC_OPS_UI_ORIGIN` 與 `DISCOVERYSTACK_PUBLIC_SITE_ORIGIN` 必須是 HTTPS absolute origins。localhost 只在 development mode 允許。`public-site/src/lib/publicApi.ts` 只允許兩條 POST API、使用 `credentials: 'omit'`，不會轉送 owner cookies。

| 指令 | 用途 |
|---|---|
| `pnpm dev` | 啟動 private Nuxt server，預設 port 3000。 |
| `pnpm typecheck` | 執行 Nuxt/Vue TypeScript 檢查。 |
| `pnpm test` | 執行 private API、repository、risk-gate、training、CORS 與全套 safe-default mocked tests；不發出第三方 credential/provider request。 |
| `pnpm test:external-credentials` | 明確 opt-in 後執行 read-only Firecrawl/Hugging Face credential tests；需要部署環境注入對應 secrets，未執行或 skipped 絕不代表 provider validation passed。 |
| `pnpm build` | 建立 Nuxt/Nitro private server artifact；不產生 public static website。 |
| `pnpm db:generate` | 只產生 Drizzle migration SQL；必須另行審查及受控套用，本次 split 不執行 migration。 |

## Private routes and authentication

所有 owner workbench pages 透過 owner layout 與既有 auth guard；`/api/**` 均設定 noindex。`/` 明確導向 `/audit-lab`，不再是公開首頁。`leads`、`training-pipeline`、`ml-lab-preview` 已指定 `owner` layout，避免落入 public shell。

公開瀏覽器只能使用 `POST /api/leads` 與 `POST /api/site-analysis`。`server/middleware/public-cors.ts` 只對這兩條 path 執行 CORS，production 必須 matching `DISCOVERYSTACK_PUBLIC_SITE_ORIGIN`；origin mismatch、缺少 production origin、錯誤 preflight method 都 fail closed。既有 owner GET `/api/leads` 不會取得 cross-origin CORS header，但仍可在同源 authenticated page 使用。

## SEO/GEO core safety

Diagnosis、strategy、Production Plan、candidate draft、risk gate、review、preview、delivery ledger 與 revision 的治理流程只在 private Nuxt server 執行。Evidence、source/artifact policy、quality、PII、removed/revoked、canonical selected rules 與 owner approval 仍由 server-side resolver 重新驗證；沒有將 provider key、database、owner cookie、私有內容或 training artifact 送入 Astro bundle。

Owner revision 的有效路徑為 `owner_revision_input → canonical selected-rule optimization child → risk gate → needs_human_review`。`changes_requested` 會失效舊 draft eligibility，只有新版本重新通過 gate 才能再 review。Preview/export 保留 append-only ledger 與 exact risk-gate validation；V1 沒有 CMS、WordPress 或 HTTP target 寫入。

## Data and migration boundary

Schema 由 `server/database/schema.ts` 管理；本次 Astro split 沒有新增或修改 migration，亦未執行任何 migration。Secrets 只能由部署平台注入，不得提交 `.env`、database URL、token、session secret、dataset、dump 或 model weights。`DISCOVERYSTACK_PUBLIC_SITE_ORIGIN` 的 CORS allowlist 值只由 Nuxt server middleware 使用；同一個非敏感 origin 只以 public runtime mirror 提供 owner layout 的退出連結。

模型改善仍需獨立 consent、版本化 receipt、去識別、品質與 PII gate、owner approval、held-out evaluation 與可撤回流程；公開網站快檢不是模型預測，也不是排名、流量、轉換或 ROI 保證。

## Verification

Public site：

```bash
cd public-site
pnpm astro check
pnpm test
pnpm build
```

Private Nuxt：

```bash
cd nuxt-app
pnpm typecheck
pnpm test
pnpm build
```

正式 domain、OAuth、資料庫 migration runtime、第三方 provider credentials、Lighthouse、Search Console 與實際部署仍需在 production-like environment 另行人工驗收。本地 split 工作不 deploy、不合併 main、不 force-push。

### External credential test boundary

預設 `pnpm test` 保持完全 safe-default：Content Operations、publication routing、autopilot、outcome learning 與 provider boundary 均使用 injected mocks，不讀取或送出真實秘密。只有在具備適當授權、並由執行者明確確認後，才可執行 `pnpm test:external-credentials`；該命令只包含 read-only credential identity/health checks，仍不執行 customer-site、GitHub、WordPress、PHP agent 或 Generic HTTP publication write。缺少 secrets 時測試會失敗或被 skip，兩者都必須在稽核報告中標示為 **NOT RUN / NOT PROVIDER VALIDATION**。

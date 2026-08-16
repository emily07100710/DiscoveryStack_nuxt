# 正式 SSR 500 修復驗證

## 根因與修正

`usePageSeo()` 會在函式內立即建立 head／JSON-LD computed state。先前首頁與內容頁將 JSON-LD 寫成無參數 callback，卻在 callback 內讀取同一行解構出的 `baseUrl` 或 `absolute`。SSR 初始 render 可能在解構完成前同步求值 callback，因而觸發 JavaScript temporal-dead-zone 錯誤；production bundle 中顯示為 `Cannot access 'p' before initialization` 或 `Cannot access 's' before initialization`。

修正後，`usePageSeo()` 將已初始化的 `{ baseUrl, absolute }` 明確傳入 JSON-LD callback；首頁與內容頁均改用 callback parameter，避免捕捉尚未初始化的外部解構變數。`tests/seo-ssr-initialization.contract.test.ts` 會防止此模式回歸。

## 正式網域實測

| 正式 URL | 結果 | 已確認內容 |
| --- | --- | --- |
| `https://disco-nuxt-jcrxrcab.manus.space/en?ssr-fix=check` | HTTP 頁面成功載入，非 500 | SSR 首頁 H1、Journey sequence、AI QA 文案與 fit-review 表單均可抽取。 |
| `https://disco-nuxt-jcrxrcab.manus.space/en/services/seo-geo-growth-system?ssr-fix=check` | HTTP 頁面成功載入，非 500 | 服務頁 H1、answer-first 摘要、四層服務表格與 related reading 均可抽取。 |
| `https://disco-nuxt-jcrxrcab.manus.space/en` | 正式 revision 切換後成功載入，非 500 | 使用者原始入口已正常完成首頁 render／hydration，標題、導覽、hero、Journey content、AI QA 文案與 fit-review 均可抽取。 |

這次驗收僅確認公開首頁與一個公開內容頁的 SSR 500 已解除；owner-only Audit Lab 與正常 client hydration 仍由各自待辦追蹤。

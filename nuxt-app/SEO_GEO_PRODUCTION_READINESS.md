# DiscoveryStack SEO/GEO Production-Readiness 稽核

> **狀態：上線準備中。** 本文件將已驗證的站內技術基礎，與必須在正式網域、真實搜尋資料及持續內容營運下完成的工作分開記錄。它不是排名、流量、收錄或 AI 引用的保證。

## 一、目前已驗證的站內基礎

| 範圍 | 現況 | 驗證依據 | 上線後仍需觀察 |
|---|---|---|---|
| 雙語資訊架構 | `prefix` 路由：`/en/*` 與 `/zh-hant/*`；每種語言均有首頁、服務、方法論、術語與 publication | `tests/public-html-snapshots.test.ts`；`pnpm generate` 產出 40 個路由 | 每種語言是否被正確收錄、是否吸引對應市場的查詢 |
| Canonical 與語言替代 | 每個公開頁輸出 canonical、`en`、`zh-Hant` 與 `x-default` alternate | 靜態 HTML regression tests | 正式網域設定後，檢查 canonical 是否全部指向正式 HTTPS 網域 |
| 可爬取內容 | 首頁與內容頁的主要標題、段落、內部連結與結構化資料均在初始 HTML；動畫為漸進增強 | production prerender、scroll-story contract tests | 正式爬蟲取得的 response、indexing report 與 URL Inspection 結果 |
| 結構化資料 | 依頁型輸出 `Organization`、`WebSite`、`WebPage`、`Service`、`DefinedTerm` 或 `Article` JSON-LD | `usePageSeo.ts`、公開 HTML snapshot | Rich Results／實際搜尋結果如何呈現並非由 schema 單獨決定 |
| Sitemap／robots／LLM 說明 | 靜態輸出含 `sitemap.xml`、`robots.txt`、`llms.txt`；未設定正式網域時防止 staging 意外索引 | `pnpm generate` 與 crawler 文件 | 切換到正式網域後，解除 staging 保護並在工具中檢查處理狀態 |
| Answer-first 內容 | 服務、方法論與術語頁有獨立 URL、定義、可引用答案與相關連結 | 16 個公開雙語內容入口 | 原創經驗、來源、維護頻率與外部引用必須持續累積 |
| 網頁體驗設計 | 動畫不取代內容；四段 scroll-story 有 reduced-motion 回退、可見 heading、表單 label 與 focus rules | `tests/accessibility-motion.test.ts`、`tests/scroll-story.contract.test.ts` | 實測 LCP、INP、CLS、行動裝置與真實使用者資料 |

## 二、正式網域啟用後的三段執行順序

| 階段 | Owner／團隊需完成的動作 | 成功證據 | 為何不能在目前先宣稱完成 |
|---|---|---|---|
| 1. 網域與可抓取性 | 設定唯一正式 HTTPS 網域；更新 runtime `siteUrl`；檢查首頁、任一 EN/ZH 內容頁、`robots.txt`、`sitemap.xml` 均回傳正確內容與 canonical | Production URL response、canonical、robots 和 sitemap 的實際截圖／請求紀錄 | 目前尚未配置正式網域，系統刻意將 placeholder host 設為 `noindex` |
| 2. 搜尋平台驗證 | 驗證 Google Search Console property、提交 sitemap、檢查 Page indexing 與 URL Inspection；驗證 Bing Webmaster Tools 並提交 sitemap | 兩個平台中的 ownership、sitemap accepted／processing 與 URL 狀態 | 這需要帳號與正式網域所有權，不能用測試 HTML 偽造 |
| 3. 實際網頁體驗 | 以正式首頁、服務頁與繁中頁執行 Lighthouse／PageSpeed；追蹤 LCP、INP、CLS；檢查 Scroll-story 行動版與 reduced-motion | 實測報告與改善紀錄 | Lab 與 field 指標取決於正式部署、裝置、網路與真實使用者，不應在本機宣稱分數 |

> Google 說明 sitemap 是提示，不保證抓取或採用；它應列出希望出現在搜尋結果中的 canonical 絕對 URL，並可透過 Search Console 觀察處理錯誤。[1]

> Google 建議的良好 Core Web Vitals 目標為 **LCP ≤ 2.5 秒、INP < 200 毫秒、CLS < 0.1**；這些是使用者體驗的檢核目標，不是排名保證。[2]

## 三、GEO 的可驗證工作與不可宣稱事項

GEO 在本專案中指的是讓人類、搜尋引擎與答案導向系統能讀取一致的實體、服務、定義、證據與下一步，而不是以隱藏內容、虛構數據或「保證被 AI 引用」來換取可見度。現有技術層提供清楚的路由、初始 HTML、語言關聯、schema、可引用段落與公開的 crawler policy；這些是必要條件，但不是充分條件。

| 可立即執行的內容營運 | 應保留的證據 | 不應承諾的結果 |
|---|---|---|
| 為每個客戶問題寫一個獨立、具體、雙語且能被更新的頁面 | 撰稿人、更新日期、可公開來源、方法與範圍 | 特定排名、固定流量、特定答案引擎引用 |
| 為可證實的經驗、方法、工具或案例補上原創內容 | 客戶授權、來源連結、方法備註、更新紀錄 | 未授權客戶成效、虛構 testimonial、捏造評價 |
| 將新內容連回服務、術語、方法論與下一步 CTA | 內部連結地圖、網站 sitemap、Search Console／Bing crawl data | 僅因發布頻率就獲得權威或收錄 |
| 追蹤真正的 query、頁面、收錄與 crawl 問題 | Search Console／Bing 匯出資料與定期稽核 | 將第三方爬蟲或 AI 回答視為可控制的結果 |

## 四、上線前最低驗收清單

- [ ] 正式網域已設定為唯一 `siteUrl`，所有 public canonical／hreflang／JSON-LD 使用該網域。
- [ ] 以正式 URL 檢查 `/robots.txt`、`/sitemap.xml`、`/llms.txt` 與至少 16 個公開入口沒有 staging `noindex`。
- [ ] Google Search Console 與 Bing Webmaster Tools 已完成所有權驗證，並各自提交 sitemap。
- [ ] Search Console Page indexing 與 URL Inspection 已檢查首頁、英文服務頁、繁中服務頁。
- [ ] 正式環境 Lighthouse／PageSpeed 已保存，並針對 LCP、INP、CLS 的問題建立優化項目。
- [ ] 首次內容發布節奏、作者／來源規範、內部連結規則與更正流程已指定 owner。
- [ ] 不存在未授權 logo、客戶成果、評論、保證排名或保證引用的公開宣稱。

## References

[1]: https://developers.google.com/search/docs/crawling-indexing/sitemaps/build-sitemap "Google Search Central — Build and submit a sitemap"
[2]: https://developers.google.com/search/docs/appearance/core-web-vitals "Google Search Central — Understanding Core Web Vitals and Google search results"
[3]: https://www.bing.com/webmasters/help/sitemaps-3b5cf6ed "Bing Webmaster Tools — Sitemaps"

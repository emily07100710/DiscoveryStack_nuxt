# Batch-41 官方來源研究與預檢紀錄

## 來源與授權

候選僅取自 Google Search Central 官方 crawling/indexing 文件索引：

- <https://developers.google.com/search/docs/crawling-indexing>
- <https://developers.google.com/search/docs/appearance>

兩個官方索引頁均在頁尾聲明，除非另有註明，內容採用 **Creative Commons Attribution 4.0 License**。本批後續只會收集 `developers.google.com/search/docs/**` 範圍內、完成逐頁人工閱讀及 policy-gated ingestion 的文件。

## Canonical-source active annotation preflight

於 2026-08-20 針對 Google 文件 source identity（移除僅語言選擇的 query string）查核 `human_annotation`、`qualityStatus=passed`、`piiStatus=none_detected`、`useSnapshot=training_candidate` 與未移除項目。

| Canonical URL | 結果 | 處理 |
|---|---:|---|
| `/crawling-indexing/javascript/javascript-seo-basics` | 已有 annotation 150001 | 排除。 |
| `/crawling-indexing/block-indexing` | 已有 annotation 810002 | 排除。 |
| `/crawling-indexing/remove-information` | 已有 annotation 1530004 | 排除。 |
| `/crawling-indexing/javascript/fix-search-javascript` | 0 | 保留為候選。 |
| `/crawling-indexing/keep-redacted-information-out` | 0 | 保留為候選；需由 PII gate 判定。 |
| `/crawling-indexing/manage-crawl-budget` | 0 | 保留為候選。 |
| `/crawling-indexing/overview-google-crawlers` | 0 | 保留為候選。 |
| `/crawling-indexing/verifying-googlebot` | 0 | 保留為候選。 |

上述 preflight 僅排除既有活躍訓練候選；不構成 PII、品質、robots、授權或人工標註的豁免。

## 人工閱讀與候選範圍決策

已人工閱讀以下通過 preflight 的官方頁面，皆在頁尾再次確認 **CC BY 4.0**：

| 文件 | 主題適配性與標註價值 | 初步風險判斷 |
|---|---|---|
| Fix Search-related JavaScript problems | WRS、soft 404、rendered DOM、fallback、HTTP content、web components、paywall 與 Rich Results／URL Inspection 診斷。 | 無明顯 PII；仍由 extractor 判定。 |
| Keep redacted information out of Google Search | 文件／影像 redaction、OCR、metadata、URL naming、noindex、authentication 與 Removals response。 | 文件明示敏感資訊情境；仍僅由 fail-closed extractor 決定可否入集。 |
| Overview of Google crawlers and fetchers | crawler/fetcher categories、robots behavior、HTTP/2、cache、ETag、file-size、host load 與 verification。 | IP 與 DNS 範例是技術內容；仍由 extractor 判定。 |
| Verify requests from Google crawlers and fetchers | reverse/forward DNS verification、common/special/user-triggered crawler ranges、robots behavior 與 spoofing 防護。 | IP／hostname 範例是技術內容；仍由 extractor 判定。 |

`manage-crawl-budget` 的文字擷取沒有取得內容，且未在本批作為可人工確認的候選。為補足第五筆，已對下列官方 structured-data 文件做 canonical-source preflight：

| Canonical URL | active eligible annotations | 決策 |
|---|---:|---|
| `/appearance/structured-data/math-solvers` | 0 | 選為 batch-41 第五候選，待逐頁人工閱讀。 |
| `/appearance/structured-data/movie` | 0 | 保留為備援，不在本批重覆收集。 |

## 第五候選人工閱讀：Math Solver structured data

已人工閱讀 <https://developers.google.com/search/docs/appearance/structured-data/math-solvers>。該頁在頁尾確認 **CC BY 4.0**，主題涵蓋 `MathSolver`／`LearningResource`、搜尋 rich-result eligibility、structured-data build/test/release、Rich Results Test、URL Inspection、robots/noindex/login access、canonical URL、multilingual language signals、paywall access 與內容品質政策。頁面包含通用 mathdomain 示範 URL、數學式與技術 markup；未以人工閱讀取代 PII gate，仍僅以 policy-gated ingestion 的 extractor outcome 決定是否進入 human annotation。

# Batch-42 Candidate Research

## Official discovery sources

本批只從 Google Search Central 官方網域選擇候選；外部搜尋結果僅用於發現精確 URL，**不作為訓練資料或授權依據**。下列頁面皆必須在受控收集前完成 Google canonical source identity 預檢、逐頁人工閱讀、頁尾 CC BY 4.0 確認與 PII gate。

| Candidate URL | Discovery topic | Initial relevance |
|---|---|---|
| https://developers.google.com/search/docs/monitor-debug/google-analytics-search-console | Search Console + Analytics reporting | Performance diagnostics, query/page analytics, decision support |
| https://developers.google.com/search/docs/appearance/structured-data/intro-structured-data | Structured data introduction | Eligibility, validation and implementation fundamentals |
| https://developers.google.com/search/docs/appearance/structured-data/search-gallery | Search Gallery | Search appearance type discovery and feature fit |
| https://developers.google.com/search/docs/crawling-indexing/ask-google-to-recrawl | Recrawl requests | Indexing operations and response workflow |
| https://developers.google.com/search/docs/crawling-indexing/sitemaps/overview | Sitemap overview | Crawl discovery and index coverage operations |
| https://developers.google.com/search/docs/crawling-indexing/robots/intro | robots.txt introduction | Crawl controls; likely prior coverage, so preflight first |
| https://developers.google.com/search/docs/crawling-indexing/robots-meta-tag | robots meta directives | Indexing controls; likely prior coverage, so preflight first |
| https://developers.google.com/search/docs/monitor-debug/search-console-start | Search Console start | Monitoring overview; likely prior coverage, so preflight first |

## Scope boundary

Only a candidate passing active eligible human-annotation preflight and later policy/PII gates may progress. A candidate matching an earlier language rendering or any prior canonical source document is excluded rather than counted again.

## Appearance-index follow-up

官方 Search appearance overview（2026-06-15 更新）明確列出 AI features、favicons、featured snippets、Google Discover、images、site names、snippets、title links 等尚可研究的子題，並在頁尾明示內容為 **Creative Commons Attribution 4.0**。下列 URL 只是新增的 preflight 候選，尚未證實未重覆、尚未視為可用資料：

- https://developers.google.com/search/docs/appearance/favicon-in-search
- https://developers.google.com/search/docs/appearance/featured-snippets
- https://developers.google.com/search/docs/appearance/google-discover
- https://developers.google.com/search/docs/appearance/google-images
- https://developers.google.com/search/docs/appearance/site-names
- https://developers.google.com/search/docs/appearance/snippet
- https://developers.google.com/search/docs/appearance/title-link

Structured-data landing page的 Rich Results Test 與 Schema Markup Validator 為工具入口而非同一類型的可收集文件；是否可作來源仍需獨立判定，不能因其與 Google 文件相連即逕行納入。

## Internationalization and sitemap follow-up

官方搜尋找到下列精確 URL，皆尚未視為可用訓練資料；必須先比對 active eligible human annotations，再進行全文閱讀、授權確認與 PII gate。

- https://developers.google.com/search/docs/specialty/international/managing-multi-regional-sites
- https://developers.google.com/search/docs/crawling-indexing/sitemaps/build-sitemap

`localized-versions` 已在既有資料集內，不能因為與 multi-regional management 主題相鄰而再次收集。Google Search Console API 與 support.google.com 搜尋結果屬不同產品／內容邊界，暫不當作本批 Google Search Central CC BY 4.0 文件來源。

## Human reading after preflight

以下文件均通過 active eligible canonical-source preflight，並在官方頁尾確認 Google Developers **CC BY 4.0**；它們仍須經 ingestion PII gate 才能進入人工標註。

- **Introduction to structured data markup in Google Search** — JSON-LD／Microdata／RDFa、visible-content parity、required/recommended properties、Rich Results Test、URL Inspection、Search Console monitoring與 before/after performance measurement。URL: https://developers.google.com/search/docs/appearance/structured-data/intro-structured-data
- **Using Search Console and Google Analytics data for SEO** — Search Console click／query／impression 與 Analytics session／engagement 的量測邊界、Looker Studio dashboard、country/device/date filters、performance discrepancy、organic traffic diagnostics。URL: https://developers.google.com/search/docs/monitor-debug/google-analytics-search-console
- **Education Q&A structured data** — Quiz／Question／Answer、flashcard visibility、educational alignment、language/region availability、robots/noindex/login access boundaries、Rich Results Test、URL Inspection、sitemap與 rollout monitoring。URL: https://developers.google.com/search/docs/appearance/structured-data/education-qa

候選 `https://developers.google.com/search/docs/appearance/structured-data/practice-problems` 在擷取時實際回傳 **Latest documentation updates**，不是可確認為 Practice Problems 的所需正文；為避免錯誤或重導內容進入資料集，本批排除它，不做 ingestion 或 annotation。

另三頁通過相同 preflight 與人工閱讀，且頁尾均確認 **CC BY 4.0**：

- **Build and submit a sitemap** — XML/RSS/Atom/text 格式、50MB／50,000 URL 限制、UTF-8 與 location scope、absolute canonical URLs、`lastmod` accuracy、CMS generation、Search Console/API/robots.txt/WebSub submission、cross-site sitemap ownership與 hint-not-guarantee。URL: https://developers.google.com/search/docs/crawling-indexing/sitemaps/build-sitemap
- **Define a favicon to show in search results** — home-page `link rel`、hostname versus subdirectory scope、Googlebot／Googlebot-Image access、stable URL、1:1 square size、brand representation、inappropriate-icon policy與 crawling delay/non-guarantee。URL: https://developers.google.com/search/docs/appearance/favicon-in-search
- **Discover and your website** — index/content-policy eligibility non-guarantee、helpful people-first content、headline／image／`max-image-preview:large`、`og:image`／schema hints、user-interest volatility、SafeSearch／manual actions、Discover report 16-month clicks/impressions/CTR。URL: https://developers.google.com/search/docs/appearance/google-discover

六個頁面所有可能的電話、姓名、帳號或其他 pattern 均不由人工閱讀自行豁免；只有後續 policy-gated ingestion 的 extractor v4 `not_detected` 結果才可進入 artifact 和 human annotation。

# Batch-43 Candidate Research

## External discovery record

本研究紀錄僅保存候選來源與主題線索；任何文件均不得因出現在此處而直接進入訓練資料。後續必須依序完成 Google canonical source preflight、人工閱讀、頁尾 CC BY 4.0 確認、approved-source policy-gated ingestion、PII fail-closed、人工品質審核、`seoGeoMultilabelSchema` 驗證與獨立核准。

| Candidate URL | Search-result subject | Initial relevance |
|---|---|---|
| https://developers.google.com/search/docs/crawling-indexing/ask-google-to-recrawl | Ask Google to recrawl your URLs | URL Inspection、request indexing、sitemap 與索引更新診斷。 |
| https://developers.google.com/search/docs/crawling-indexing/consolidate-duplicate-urls | Consolidate duplicate URLs | canonical selection、redirect、duplicate URL consolidation 與 crawl efficiency。 |
| https://developers.google.com/search/docs/crawling-indexing/url-structure | URL structure best practices | URL design、parameter handling、case sensitivity 與 website information architecture。 |
| https://developers.google.com/search/docs/crawling-indexing/site-move-with-url-changes | Site moves and migrations | URL change migration、redirect、validation、monitoring 與 staged recovery。 |
| https://developers.google.com/search/docs/crawling-indexing/mobile/mobile-sites-mobile-first-indexing | Mobile-first indexing best practices | 行動版內容、UX、crawl/index parity 與 responsive decision support。 |
| https://developers.google.com/search/docs/crawling-indexing/301-redirects | Redirects and Google Search | HTTP／JavaScript／meta redirects、canonical transition 與 migration behavior。 |
| https://developers.google.com/search/docs/specialty/ecommerce/pagination-and-incremental-page-loading | Pagination and incremental page loading | ecommerce pagination、incremental loading、crawlable links、content discovery 與 progressive UX。 |
| https://developers.google.com/search/docs/specialty/ecommerce/designing-a-url-structure-for-ecommerce-sites | Ecommerce URL structure best practices | product/category URL、facets、parameters、canonical signals 與 product discovery。 |
| https://developers.google.com/search/docs/appearance/google-images | Image SEO best practices | image captions、alt text、landing pages、formats、performance、image discovery 與 badges。 |
| https://developers.google.com/search/docs/appearance/structured-data/local-business | LocalBusiness structured data | local identity、location/service representation、search appearance 與 validation；高 PII 範例風險由 extractor 判定。 |
| https://developers.google.com/search/docs/crawling-indexing/remove-information | Remove information | 已有 active canonical document，僅保留為 preflight 重覆對照，不應重覆入集。 |
| https://developers.google.com/search/docs/monitor-debug/search-console-start | Search Console start | 已在 batch-35 納入，保留為 canonical preflight 的已知重覆對照，不應再入集。 |

## Scope boundary

僅接受 `developers.google.com/search/docs/**` 且在 Google Search Central 文件頁明示 CC BY 4.0 的官方公開內容。搜尋結果中的 support threads、Scribd、YouTube、Semrush、Search Engine Journal、seobotai、Quora、Stack Exchange、Google Cloud Migration Center、SEOZoom、BlueGlass Insights、Prefixbox、Seranking 等第三方或非目標網域不得納入本批資料集。

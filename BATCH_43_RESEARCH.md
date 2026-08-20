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
| https://developers.google.com/search/docs/appearance/structured-data/search-gallery | Search Gallery | structured-data types、rich-result eligibility、content-type mapping 與 discovery. |
| https://developers.google.com/search/docs/appearance/structured-data/sd-policies | General Structured Data Guidelines | eligibility、manual action、quality signals 與 search appearance governance. |
| https://developers.google.com/search/docs/crawling-indexing/links-crawlable | SEO link best practices | crawlable HTML links、internal navigation、anchor text 與 JavaScript link behavior. |
| https://developers.google.com/search/docs/crawling-indexing/javascript/javascript-seo-basics | JavaScript SEO basics | rendering、crawling、indexing queues、content discoverability 與 technical implementation. |
| https://developers.google.com/search/docs/appearance/title-link | Title links | result title selection、page-title clarity、brand／content alignment 與 search appearance. |
| https://developers.google.com/search/docs/appearance/favicon-in-search | Favicon | branding signal、favicon technical eligibility 與 result appearance. |
| https://developers.google.com/search/docs/appearance/snippet | Meta descriptions and snippets | result snippet、content summary、search intent alignment 與 content presentation. |
| https://developers.google.com/search/docs/specialty/international/managing-multi-regional-sites | Multi-regional sites | country targeting、regional architecture 與 multilingual international SEO. |
| https://developers.google.com/search/docs/specialty/international/localized-versions | Localized versions | hreflang、language／region variants、canonical alignment 與 multilingual discovery. |
| https://developers.google.com/search/docs/appearance/sitelinks | Sitelinks | information architecture、internal links、navigational discovery 與 search appearance. |
| https://developers.google.com/search/docs/appearance/structured-data/product | Product structured data introduction | product information、merchant feed complement、search appearance 與 buyer journey. |
| https://developers.google.com/search/docs/appearance/structured-data/intro-structured-data | Structured data introduction | required/recommended properties、implementation／testing workflow 與 rich-result eligibility. |
| https://developers.google.com/search/docs/appearance/structured-data/breadcrumb | Breadcrumb structured data | website hierarchy、navigational context、search appearance 與 internal architecture. |
| https://developers.google.com/search/docs/crawling-indexing/remove-information | Remove information | 已有 active canonical document，僅保留為 preflight 重覆對照，不應重覆入集。 |
| https://developers.google.com/search/docs/monitor-debug/search-console-start | Search Console start | 已在 batch-35 納入，保留為 canonical preflight 的已知重覆對照，不應再入集。 |

## 人工閱讀證據

### URL structure

`url-structure` 的繁中官方頁面已完成人工閱讀。文件涵蓋可檢索 URL（IETF STD 66）、避免以 fragment 改變內容、常見 query 參數編碼、描述性 URL、目標對象語言、百分比編碼、以連字號分隔字詞、減少不必要參數、大小寫一致性與多地區 URL 結構。並說明多重篩選、無關參數、session ID、日曆與損毀相對連結如何造成 URL 爆炸及 crawl/index coverage 風險。

此文件適合標註 technical SEO 與 multilingual／country GEO signals；主旅程預期可定位為 understanding 或 progression，最終仍以人工 annotation 內容與 schema parsing 為準。頁面僅含公開文件示例 URL 與技術文字，未見個人 email、電話或身分證字號；正式 admission 仍必須由 extractor v4 執行 fail-closed PII 判定。頁尾的 CC BY 4.0 license lineage 仍須在受控 ingestion artifact 中保存。

### Ecommerce URL structure

`designing-a-url-structure-for-ecommerce-sites` 的繁中官方頁面已完成人工閱讀，頁尾明示文件內容採 **CC BY 4.0**（程式碼範例採 Apache 2.0）。文件說明 fragment 導致內容遺漏、同內容多 URL 導致重複檢索、時間變數造成無限 URL 的風險；並建議描述性永久網址、可理解的 `?key=value` 參數、避免暫時性 session／tracking／nearby 參數、產品子類 URL 與 canonical 連結、sitemap 對齊，以及以可檢索 `<a href>` 做跨頁導覽。

此文件可提供 ecommerce technical SEO、product／service entity、buyer／practitioner audience 與 discovery 或 progression journey 的人工標註依據。頁面內容為公開技術建議與示例網址；未發現個人 email、電話或身分證字號，但不得以人工判讀取代 extractor v4 的 PII gate。

## Scope boundary

僅接受 `developers.google.com/search/docs/**` 且在 Google Search Central 文件頁明示 CC BY 4.0 的官方公開內容。搜尋結果中的 support threads、Scribd、YouTube、Semrush、Search Engine Journal、seobotai、Quora、Stack Exchange、Google Cloud Migration Center、SEOZoom、BlueGlass Insights、Prefixbox、Seranking 等第三方或非目標網域不得納入本批資料集。

搜尋得到的 `https://developers.google.com/crawling/docs/faceted-navigation` 不在本批已定義的 `/search/docs/**` 資料來源範圍，不得納入本批，即使其主題相關也不得以擴張來源為由繞過既有 approved-source policy。

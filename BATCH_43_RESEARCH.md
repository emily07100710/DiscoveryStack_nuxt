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
| https://developers.google.com/search/docs/appearance/structured-data/paywalled-content | Subscription and paywalled content | paywall eligibility、structured-data disclosure、content accessibility 與 publisher journey. |
| https://developers.google.com/search/docs/crawling-indexing/301-redirects | Redirects and Google Search | redirect selection、permanent URL migration、indexing continuity 與 technical SEO recovery. |
| https://developers.google.com/search/docs/crawling-indexing/remove-information | Remove information | 已有 active canonical document，僅保留為 preflight 重覆對照，不應重覆入集。 |
| https://developers.google.com/search/docs/monitor-debug/search-console-start | Search Console start | 已在 batch-35 納入，保留為 canonical preflight 的已知重覆對照，不應再入集。 |

## 人工閱讀證據

### URL structure

`url-structure` 的繁中官方頁面已完成人工閱讀。文件涵蓋可檢索 URL（IETF STD 66）、避免以 fragment 改變內容、常見 query 參數編碼、描述性 URL、目標對象語言、百分比編碼、以連字號分隔字詞、減少不必要參數、大小寫一致性與多地區 URL 結構。並說明多重篩選、無關參數、session ID、日曆與損毀相對連結如何造成 URL 爆炸及 crawl/index coverage 風險。

此文件適合標註 technical SEO 與 multilingual／country GEO signals；主旅程預期可定位為 understanding 或 progression，最終仍以人工 annotation 內容與 schema parsing 為準。頁面僅含公開文件示例 URL 與技術文字，未見個人 email、電話或身分證字號；正式 admission 仍必須由 extractor v4 執行 fail-closed PII 判定。頁尾的 CC BY 4.0 license lineage 仍須在受控 ingestion artifact 中保存。

### Ecommerce URL structure

`designing-a-url-structure-for-ecommerce-sites` 的繁中官方頁面已完成人工閱讀，頁尾明示文件內容採 **CC BY 4.0**（程式碼範例採 Apache 2.0）。文件說明 fragment 導致內容遺漏、同內容多 URL 導致重複檢索、時間變數造成無限 URL 的風險；並建議描述性永久網址、可理解的 `?key=value` 參數、避免暫時性 session／tracking／nearby 參數、產品子類 URL 與 canonical 連結、sitemap 對齊，以及以可檢索 `<a href>` 做跨頁導覽。

此文件可提供 ecommerce technical SEO、product／service entity、buyer／practitioner audience 與 discovery 或 progression journey 的人工標註依據。頁面內容為公開技術建議與示例網址；未發現個人 email、電話或身分證字號，但不得以人工判讀取代 extractor v4 的 PII gate。

### Subscription and paywalled content

`paywalled-content` 的繁中官方頁面已完成人工閱讀，屬已核准 Google Search Central 文件來源；受控 ingestion 時仍須保存頁尾 **CC BY 4.0** 授權 lineage。文件說明如何以 `CreativeWork`／`NewsArticle` JSON-LD、`isAccessibleForFree` 與 `hasPart.cssSelector` 區隔可建立索引的訂閱或付費牆內容和偽裝，並涵蓋 Googlebot 存取一致性、摘要控制、驗證與疑難排解。

此文件可支援 publisher/practitioner/technical-evaluator audience、structured-data 與 indexability signals，以及 understanding 或 conversion journey 的多維標註。範例包含個人姓名 placeholder 與時間戳字串；不得以人工閱讀放行，僅當 extractor v4 回報 `none_detected` 才能進入人工審核與訓練候選。

### Organization structured data

`organization` 的繁中官方頁面已完成人工閱讀，屬已核准 Google Search Central 文件來源；受控 ingestion 時仍須保存頁尾 **CC BY 4.0** 授權 lineage。文件說明機構首頁／About 頁的結構化資料、最具體的 schema.org Organization 子類型選擇、OnlineStore／LocalBusiness 的適用條件、名稱、網站、商標與搜尋外觀關係，以及技術規範、驗證、人工判決與疑難排解。

其內容適合 organisation/service/product entity、technical-evaluator/practitioner audience、structured-data 與 language/indexability signals，並可提供 understanding 或 conversion journey 訓練洞察。畫面及文本示例明確包含電話與 email placeholder；因此本頁為**高 PII 風險候選**，只能由 extractor v4 決定是否 fail-closed 排除，絕不可因資料量壓力而放行。

### Core Web Vitals

`core-web-vitals` 的繁中官方頁面已完成人工閱讀，頁尾明示內容採 **CC BY 4.0**，程式碼範例採 Apache 2.0。文件將 LCP、INP 與 CLS 連結到實際使用者的載入效能、互動性及視覺穩定性，並說明其與 Google 搜尋核心排名系統和 Search Console 監測、偵錯、改善流程的關係。

此文件可用於 technical-evaluator/practitioner audience、technical SEO 的效能可觀測性、understanding/progression journey 與資訊型意圖的多維標註。頁面包含公開指標閾值與工具連結，未見個人 email、電話或國民身分證字號；仍須通過 persisted extractor v4 的 `none_detected` PII gate 才可入集。

### Enable Web Stories

`enable-web-stories` 的繁中官方頁面已完成人工閱讀，頁尾明示內容採 **CC BY 4.0**，程式碼範例採 Apache 2.0。文件說明如何讓 Web Stories 在 Google 搜尋與探索呈現，包括有效 AMP、必要中繼資料、Search Console 網址檢查、sitemap／站內連結、self-canonical、robots/noindex 與多語版本提供。

此文件可支援 discovery/progression journey、creator/practitioner/technical-evaluator audience、multilingual GEO、canonical/indexability/internal-routing/language-signal 等多維標註。文本僅含公開示例網域與技術欄位，未見個人 email、電話或國民身分證字號；仍必須通過 extractor v4 的 `none_detected` PII gate。

### Web Stories content policy

`web-stories-content-policy` 的繁中官方頁面已完成人工閱讀，頁尾明示 **CC BY 4.0**。文件要求符合 Google 探索政策、搜尋基礎入門、搜尋功能內容政策和特定的原創性、版權、文字密度、素材品質、敘事完整性與非過度商業化規範，違反時可能失去豐富呈現資格。

此文件可支援 understanding/response journey、content-quality governance、content-policy、publisher/practitioner audience 與資訊型意圖標註。人工閱讀未見個人 email、電話或國民身分證字號；正式 admission 仍僅以 extractor v4 的 `none_detected` outcome 為準。

### Fact check (ClaimReview) structured data

`factcheck` 的繁中官方頁面已完成人工閱讀，頁尾採 **CC BY 4.0**。文件說明 ClaimReview 若要取得事實查核複合式搜尋結果資格，必須維持網頁與標記一致、可追溯的資料與分析方法、來源引用、透明性、修正或回報機制，以及每一頁單一 ClaimReview 的技術限制；並再次界定有效標記只啟用功能，不保證呈現。

此文件可用於 understanding/response journey、資訊完整性、引用準備度、結構化資料與 research/practitioner/technical-evaluator audience 的多維標註。頁面包含 Person/Organization 欄位說明與公開示例，未見 email、電話或國民身分證字號；仍必須以 extractor v4 `none_detected` outcome 作為唯一入集依據。

### Review Snippet structured data

`review-snippet` 的繁中官方頁面已完成人工閱讀，頁尾採 **CC BY 4.0**。文件規範評論或累計評分要與頁面可見內容一致、針對特定項目、由使用者直接提供、不能彙整其他網站評分，且禁止受評論實體自行控制的 LocalBusiness／Organization 自刊星級標記；並要求 validation、rendering、crawl/index access、sitemap submission 與發布後重檢。

此文件可用於 conversion/response journey、信任訊號、結構化資料、content-policy 與 practitioner/technical-evaluator/decision-maker audience 標註。它含公開示例的人名與商家情境，必須以 extractor v4 完整掃描後維持 fail-closed；不會將任何示例評分、評論或見證內容當作本專案客戶評價或虛構資料。

### SEO Starter Guide

`seo-starter-guide` 的繁中官方頁面已完成人工閱讀，屬 Google Search Central `/search/docs/**` 說明文件且頁尾採 **CC BY 4.0**。文件涵蓋可見性限制、合理網站資訊架構、描述性 URL、主題目錄、重複內容與 canonical／redirect 管理、實用可靠且以使用者為優先的內容、使用者搜尋字詞差異、非干擾式廣告、可檢索連結、錨定文字、標題連結與摘要控制。

此文件可提供 discovery/understanding journey、資訊型與商業研究型意圖、content-quality、internal-routing、canonical/indexability、title 與 technical-evaluator/practitioner/decision-maker audience 的多維標註依據。可見內容僅包含公開技術示例 URL 與教學文字；人工閱讀未見個人 email、電話或國民身分證字號，最終仍必須由 extractor v4 `none_detected` 結果決定是否可入集。

### Video Sitemaps

`video-sitemaps` 的繁中官方頁面已完成人工閱讀，屬 Google Search Central `/search/docs/**` 說明文件，頁尾採 **CC BY 4.0**。文件說明影片 Sitemap／mRSS 如何協助發現和解讀網站影片，並規範影片必須與頁面主內容相關、`robots.txt`、登入與防火牆不得阻斷 Googlebot、媒體存取協定、`content_loc`／`player_loc`、縮圖、標題、說明、發布與到期日、地區限制、存取驗證及 Sitemap 對齊。

此文件可支援 discovery/progression journey、影片內容型態、technical SEO、indexability、internal-routing、performance_not_observed、global/country GEO、practitioner/technical-evaluator/media-or-partner audience 的多維標註。它含公開技術示例 URL、虛構 uploader 名稱與日期時間格式；人工閱讀未見 email、電話或國民身分證字號，最終仍僅以 extractor v4 `none_detected` outcome 決定是否 admission。

### Troubleshoot crawling errors

`troubleshoot-crawling-errors` 的繁中官方頁面已完成人工閱讀，屬 Google Search Central `/search/docs/**` 文件並明列 **CC BY 4.0**（程式碼示例另為 Apache 2.0）。內容提供 Googlebot 可用性問題、應檢索但未檢索頁面、加快檢索、改善檢索效率、處理過度檢索、Crawl Stats、URL Inspection 及主機超載的診斷與處置路徑，並說明可用性不必然改善排名但會影響 Google 對網站的可檢索性。

此文件可支援 response/progression journey、診斷型搜尋意圖、技術 SEO、indexability、performance_not_observed、global GEO、practitioner/technical-evaluator/existing-customer audience 的多維標註。人工閱讀未見 email、電話或國民身分證字號；仍必須以 extractor v4 `none_detected` 結果作為唯一 admission 條件。

## Scope boundary

僅接受 `developers.google.com/search/docs/**` 且在 Google Search Central 文件頁明示 CC BY 4.0 的官方公開內容。搜尋結果中的 support threads、Scribd、YouTube、Semrush、Search Engine Journal、seobotai、Quora、Stack Exchange、Google Cloud Migration Center、SEOZoom、BlueGlass Insights、Prefixbox、Seranking 等第三方或非目標網域不得納入本批資料集。

搜尋得到的 `https://developers.google.com/crawling/docs/faceted-navigation` 不在本批已定義的 `/search/docs/**` 資料來源範圍，不得納入本批，即使其主題相關也不得以擴張來源為由繞過既有 approved-source policy。

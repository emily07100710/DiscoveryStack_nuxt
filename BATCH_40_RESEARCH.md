# Batch-40 研究與來源預檢紀錄

本文件記錄 batch-40 在 policy-gated ingestion 前完成的外部來源研究。所有候選只考慮 `developers.google.com/search/docs/**` 的 Google Search Central 官方文件；每頁在送入 ingestion 前均須通過 canonical source identity 的 active human-annotation preflight。Google 文件頁尾使用的內容授權為 **Creative Commons Attribution 4.0 License**（程式碼範例另依 Apache 2.0），資料可用性仍以 approved source policy、robots、PII extractor v4 與人工品質審閱共同決定。

## Canonical source preflight

下列候選於 2026-08-20 的 active eligible human-annotation preflight 為 0，因此可進入人工閱讀與後續 PII gate：

| URL | 結果 | 說明 |
|---|---:|---|
| `https://developers.google.com/search/docs/appearance/structured-data/merchant-listing` | 0 | 未有 active eligible annotation。 |
| `https://developers.google.com/search/docs/appearance/structured-data/organization` | 0 | 未有 active eligible annotation；預期範例含 email、telephone、地址與 VAT，需由 PII gate fail-closed 判定。 |
| `https://developers.google.com/search/docs/crawling-indexing/change-address` | 0 | 未有 active eligible annotation；文字擷取失敗，需以可視方式確認有效頁面與授權後才可收集。 |
| `https://developers.google.com/search/docs/appearance/structured-data/event` | 0 | 未有 active eligible annotation。 |
| `https://developers.google.com/search/docs/appearance/structured-data/faqpage` | 0 | canonical preflight 為 0，但目前回傳的是 documentation updates 頁面，非預期的 FAQ rich-result 內容，故不作為本批文件。 |
| `https://developers.google.com/search/docs/appearance/structured-data/local-business` | 0 | 未有 active eligible annotation；預期範例含 phone/address，需 PII gate。 |

已排除的已入集來源包括 `product`、`site-move-with-url-changes`、`google-discover`、`google-images` 與 `breadcrumb`；不以不同 `hl` 語言 rendering 重複收集。

## 人工閱讀重點

### Merchant listing (`Product`, `Offer`)

來源：<https://developers.google.com/search/docs/appearance/structured-data/merchant-listing>

文件說明 Product／Offer structured data 對 Shopping knowledge panel、Google Images、popular product results 與 product snippets 的 eligibility；涵蓋 CMS/JavaScript implementation、Rich Results Test、URL Inspection、Googlebot access、robots/noindex/login requirements、recrawl 與 sitemap。範例含虛構人名、商品、價格、SKU、日期與 example.com URL；是否被 PII extractor 視為 pattern 仍須以 ingestion 實際結果判斷。

### Organization (`Organization`)

來源：<https://developers.google.com/search/docs/appearance/structured-data/organization>

文件說明 organization administrative details、disambiguation、logo／knowledge-panel display、首頁或 about page placement、OnlineStore subtype、shipping／return policies、Rich Results Test 與 URL Inspection。可視範例明確包含 `contact@example.com`、telephone、郵寄地址、VAT ID 與 DUNS 等 personal/contact identifier patterns，因此不應因為只是示例而跳過 PII gate；若 extractor 判為 redacted 或 needs_human_review，必須完全排除。

### Event (`Event`)

來源：<https://developers.google.com/search/docs/appearance/structured-data/event>

文件涵蓋 event search experience、CMS／third-party publishing、HTML markup、Rich Results Test、URL Inspection、regions/languages、unique leaf-page URLs、single-event scope、multi-day event status、public booking eligibility、physical-location rule 和 date/time accuracy。範例含虛構活動名稱、街道與地址型式，仍須以 PII extractor v4 實際 finding 決定是否可建立 structural artifact。

### Change Address

來源：<https://developers.google.com/search/docs/crawling-indexing/change-address>

文字擷取服務未取得正文；在完成可視確認它不是 404、重導或非 Search Central 內容，並再次確認頁尾 CC BY 4.0 前，禁止納入本批 ingestion。

2026-08-20 已以可視方式確認此 URL 顯示 Google for Developers **404｜找不到網頁**；因此永久排除於 batch-40，不建立 ingestion job、structural artifact 或 human annotation。

### Product variant (`ProductGroup`, `Product`)

來源：<https://developers.google.com/search/docs/appearance/structured-data/product-variants>

canonical preflight 為 0。文件說明 size、color、material、pattern 等 variant 聚合，涵蓋 `ProductGroup`、`variesBy`、`hasVariant`、`productGroupID`、single-page／multi-page 設計、variant-specific URL、common versus variant-specific attributes、Rich Results Test、URL Inspection、Googlebot access 與 sitemap。範例含 product identifiers、價格、日期與 example.com URL；只以 PII extractor v4 的實際 finding 作入集判定。

### Merchant return policy (`MerchantReturnPolicy`)

來源：<https://developers.google.com/search/docs/appearance/structured-data/return-policy>

canonical preflight 為 0。文件涵蓋 Organization-level 與 Offer-level return policy、return link、applicable country、return window、return method、fees、refund、seasonal override、Rich Results Test、URL Inspection、Search Essentials 與 technical guidelines。首個 OnlineStore 範例含 `support@example.com`、telephone 與 VAT/ISO identifier patterns，因此必須讓 PII gate fail-closed；若 outcome 非 `not_detected`，即不可建立 structural artifact 或 annotation。

### Event (`Event`)

來源：<https://developers.google.com/search/docs/appearance/structured-data/event>

canonical preflight 為 0。文件涵蓋 event experience、CMS／第三方 publisher、HTML markup、Rich Results Test、URL Inspection、region/language availability、single-event leaf pages、多日 event、rescheduled/cancelled status、public booking、physical location 與 date/time accuracy。範例含虛構名稱、地址與時間，因此仍需 PII gate 與人類品質審閱。

### Video (`VideoObject`, `Clip`, `BroadcastEvent`)

來源：<https://developers.google.com/search/docs/appearance/structured-data/video>

canonical preflight 為 0。文件涵蓋 video results、Video mode、Images、Discover、LIVE badge、`BroadcastEvent`、`Clip`、`SeekToAction`、key moments、YouTube descriptions、`nosnippet` opt-out、language availability、watch page markup、Rich Results Test、URL Inspection、Googlebot access、sitemap 與 recrawl。範例使用 ISO 8601 date/time、timezone offsets、example.com URLs 與虛構內容；PII extractor v4 已修正日期時間／timezone offset 誤判，仍會對 email、phone、national-ID pattern 保持 fail-closed。

## Batch-40 暫定收集範圍

經 preflight 與人工閱讀後，暫定以 Merchant listing、Product variants、Merchant return policy、Event 與 Video 五頁送入 policy-gated ingestion。Organization 因人為閱讀發現多種 contact／identifier pattern，暫不作為本批候選；Change Address 與 FAQPage 404／錯誤內容已排除。任何一頁若 ingestion PII outcome 不是 `not_detected`，將保留其 job audit，但不建立 training artifact 或 human annotation。

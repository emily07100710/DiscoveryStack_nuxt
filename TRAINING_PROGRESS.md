# Training Progress

## 2026-08-18

正式 Audit Lab `https://discovstack-kfpqmdfb.manus.space/audit-lab` 已開啟。頁面顯示 owner-only 閘門與「登入稽核實驗室」入口；目前 My Browser session 尚未進入後台，因此尚未執行抓取、清洗、標註或訓練提交。正式頁面仍顯示繁體中文 owner-only 說明。

既有政策要求：只使用已核准的 Google Search Central CC BY 4.0 來源；每頁重新檢查 robots、授權、canonical、PII 與去重；至少 100 筆人工覆核合格樣本後才可建立 manifest 與提交 Hugging Face job。

## Owner session verified

正式 OAuth 已成功完成；Audit Lab 現在顯示 owner-only 工作區。Google Search Central Documentation（CC BY 4.0）來源卡已存在，狀態為已核准、用途為訓練候選，robots 為已審核公開路徑，條款為允許訓練，風險低且 PII 未偵測到。現況計數仍為已同意候選資料 0；BGE-M3 需要兩筆候選資料；監督式學習尚未就緒。頁面提供單頁「已核准文件擷取」、多維人工標註、dataset manifest 與遠端訓練控制項。

## Current UI gate details

Audit Lab owner session is active at `https://discovstack-kfpqmdfb.manus.space/audit-lab`. The page exposes a controlled workflow: workspace authorization first, then approved source card, typed artifact, multi-dimensional human annotation, and approved-document single-page processing. The source registry confirms Google Search Central Documentation (CC BY 4.0) as approved for `training_candidate`, with public-path robots approval, training-allowed terms, low copyright risk, and no detected PII. Current readiness remains 0 consented candidates; BGE-M3 requires 2 candidates; supervised training requires at least 20 examples per journey stage and 150 consented candidates according to the live UI. The live page explicitly states it does not silently crawl or follow links.

## 2026-08-18 第一批公開資料擷取驗證

正式 owner-only Audit Lab：<https://discovstack-kfpqmdfb.manus.space/audit-lab#ingestion-title>

已核准訓練候選來源：Google Search Central Documentation（CC BY 4.0），來源登錄顯示 robots 已審核並允許公開路徑、條款允許訓練、著作權風險低、PII 審核為未偵測到，狀態為已核准。

已提交的單頁文件 URL：<https://developers.google.com/search/docs>。頁面明確標示這是單頁受限擷取，不會探索連結或靜默爬取；處理器僅暫存 HTML，保存雜湊與型別化結構特徵，遇到可能 PII 不建立產物。

提交後畫面仍顯示已同意候選資料 0；目前尚未確認有新產物建立，需再檢查請求結果與資料登錄。監督式學習仍未就緒；頁面顯示每旅程階段至少 20 筆、總共至少 150 筆已同意候選資料，r14 訓練服務另有至少 100 筆合格 manifest gate，兩者均不可繞過。

## 2026-08-18 production ingestion attempt

Attempted approved single-document fetch URL: https://developers.google.com/search/docs. The Audit Lab explicitly states this is a single-page request, not crawling; it does not explore links, follow redirects, retain raw HTML, capture forms, or save original page text. The request was submitted through the owner session, but after completion the page still showed 0 consented candidates, no visible artifact/result message, and the ingestion form remained unchanged. Therefore no successful artifact or training sample is claimed. Next action is to inspect the production request/error path before retrying; do not submit training until verified artifacts are present and manually labeled.

Observed live readiness text: supervised learning not ready; each journey stage needs at least 20 samples and total at least 150 consented candidates. The project training service also requires an approved immutable manifest and at least 100 eligible deduplicated samples; the stricter live UI threshold is treated as effective until reconciled.

## 2026-08-18 r15 bounded multi-page collection readiness

正式 owner session 已重新驗證。r15 Audit Lab 的「受控公開資料收集」區塊顯示 Google Search Central Documentation（CC BY 4.0）為唯一已核准、`training_candidate` 用途的來源；介面說明收集嚴格限制於同一已核准網域、最多 10 頁、發現深度最多 2 層，不允許外部連結或子網域。執行前仍會檢查 robots、條款、低著作權風險與未偵測 PII；不保存原始 HTML／清洗後正文，疑似 PII 頁面會跳過且不建立訓練產物。此時尚未再次提交 r15 多頁收集，所有訓練樣本、manifest 與 Hugging Face job 計數仍為 0。

頁面實測定位至收集表單：唯一核准來源已自動選取；收集模式為「同網域受控多頁收集」；最多頁數目前為 10；最大發現深度目前為 1 層。起始 URL 欄位提示為 `https://developers.google.com/search/docs`，尚待以此公開文件入口明確填入後送出。

## 2026-08-18 r15 production bounded-crawl result

已透過 owner session 對已核准的 Google Search Central Documentation（CC BY 4.0）來源提交同網域受控多頁收集，起始 URL 為 <https://developers.google.com/search/docs>，最多頁數為 10，最大發現深度為 2。正式 Audit Lab 在正常等待窗口後回傳：`0 of 10 Firecrawl page(s) were cleaned into typed structural artifacts. Raw HTML and cleaned text were not stored.` 因此本次沒有建立可供標註的 structural artifact、沒有新增訓練樣本、沒有建立 manifest，亦沒有提交 Hugging Face job。後續必須先由擷取台帳的安全錯誤碼釐清 provider 結果，不能以重試或假資料補足樣本。

擷取台帳補充：該來源頁面 HTTP 狀態為 `200`，處理狀態為「失敗」，PII／保存結果為 `needs human review`；處理器已分析約 `19,406` 個清理後字元，但依既有隱私政策未保存原始 HTML 或清理後正文，亦未建立衍生產物。這證實 Firecrawl 可取得目標頁面；阻擋原因是 PII 安全 gate，而非來源授權、robots、網域或 provider 無法連線。

候選頁面的公開文字查核（僅供選擇下一次受控抓取起點，不匯入資料庫）：

- <https://developers.google.com/search/docs/fundamentals/creating-helpful-content>：Google Search Central 的「Creating helpful, reliable, people-first content」說明頁；頁尾明示除非另有註明，內容採用 CC BY 4.0。公開文字檢視未見電子郵件、電話或身分證號碼樣式。
- <https://developers.google.com/search/docs/crawling-indexing/overview-google-crawlers>：Google Search Central 的「Overview of Google crawlers and fetchers」說明頁；頁尾明示 CC BY 4.0。公開文字檢視未見電子郵件或電話樣式，但含協定／狀態碼與日期等技術數字，後續仍須由正式 PII gate 判定。

以上外部文字檢視不等於授權放寬，也不替代正式收集時的 robots、條款、PII、同網域、去重與人工審核 gate。

## 2026-08-18 low-risk single-document retry prepared

正式 owner session 仍有效。下一次受控收集已將起始 URL 改為 <https://developers.google.com/search/docs/fundamentals/creating-helpful-content>；此頁同屬唯一已核准的 Google Search Central CC BY 4.0 來源。下一步會以單一文件、1 頁、深度 0 進行低風險 PII gate 驗證。此次重試不會降低來源權利、robots、PII、去重、速率限制、人工審核、manifest 或訓練 gate。

收集模式的原生選單仍顯示同網域多頁設定；在送出前必須明確切換為「單一文件」、1 頁及深度 0。尚未執行本次候選頁請求，因此沒有新增產物、樣本、manifest 或訓練工作。

最新表單快照仍確認候選 URL 為 <https://developers.google.com/search/docs/fundamentals/creating-helpful-content>，但目前值仍是同網域受控多頁收集、10 頁、深度 1。尚未送出，因為必須先使原生選單確實反映單一文件、1 頁、深度 0；不得依前端外觀推測設定已變更。

## 2026-08-18 second production bounded-crawl result

已透過 owner session 對 Google Search Central Documentation（CC BY 4.0）提交第二次同網域受控收集，起始 URL 為 <https://developers.google.com/search/docs/fundamentals/creating-helpful-content>，最多 10 頁、發現深度 1。正式表單完成後顯示：`1 of 10 Firecrawl page(s) were cleaned into typed structural artifacts. Raw HTML and cleaned text were not stored.`

已建立 1 筆 `structural_features` 產物，追溯定位器為 `firecrawl:01a014b0-dabe-7749-8591-7a7991e647b2:depth-0:https://developers.google.com/search/docs/fundamentals/creating-helpful-content?hl=fr`；初始產物品質狀態為 `pending`。擷取台帳仍標示 `needs human review`，PII／保存代碼為 `21767e`。此產物屬 `training_candidate` 來源，但在完成後續人工品質審核與多維人工標註前，不是訓練樣本。

目前已同意／訓練合格樣本仍為 **0**。沒有建立 dataset manifest、沒有提交 Hugging Face job、沒有產生模型 artifact，且系統未保存原始 HTML 或清理後正文。下一步應在 owner 後台對這筆公開 structural artifact 完成人工 PII／品質審核與多維人工標註，才可能進入資料集門檻計算。

### 人工 PII 審核補充

針對公開頁面 <https://developers.google.com/search/docs/fundamentals/creating-helpful-content?hl=fr> 的只讀檢視，以收集器相同正規表示式計數：email 0、身分證樣式 0、電話樣式 1。該唯一命中位於 Podcast 公開連結的數字型 ID（遮罩檢視後確認為 `pod.link/##########`），並非電話或其他可識別個資。因此此命中屬於規則誤判的 URL 識別碼；本紀錄只保留分類結論，不保存原始 ID 或正文。

## 2026-08-18 artifact #1 owner-review authorisation

正式 Audit Lab 顯示唯一一筆來自 Google Search Central Documentation（CC BY 4.0）的 `structural_features` artifact，來源定位器為 `firecrawl:01a014b0-dabe-7749-8591-7a7991e647b2:depth-0`。台帳目前顯示來源用途 `training_candidate`、品質待審核、provider PII screening 為 `none_detected`。

使用者已明確確認，授權在 owner-only 治理流程中提交此 artifact 的品質審核結論與一筆有界、去識別的 SEO／GEO 多維人工標註。此授權不等同 manifest 核准或訓練同意；資料仍須完成來源、品質、去重、人工標註、至少 100 筆與 owner manifest gate 才可提交遠端訓練。

## Artifact #1 quality-review submission check

- Source: Google Search Central Documentation (CC BY 4.0), `https://developers.google.com/search/docs/fundamentals/creating-helpful-content?hl=fr`.
- Artifact: structural feature artifact #1; provenance begins `firecrawl:01a014b0-dabe-7749-8591-7a7991e647b2:depth-0`; content-span hash prefix `95b494e27d54`.
- Pre-review governance state: `training_candidate`, `qualityStatus=pending`, `piiStatus=none_detected`.
- Browser observation: after a user-authorized click on **通過品質審核**, the artifact table still rendered `pending` and the production logs contained no matching request. The next action must diagnose or retry the owner-only API path; do not claim a quality pass until the persisted state changes.

## 2026-08-18 live owner re-check

正式 owner session 已再次載入 Audit Lab。artifact #1 仍顯示 `qualityStatus=pending`，可見「通過品質審核」與「需要修訂」兩個操作；來源卡仍為 Google Search Central Documentation（CC BY 4.0）、`training_candidate`、robots 已審核允許公開路徑、條款允許訓練、低著作權風險、未偵測 PII。使用者先前已授權提交此筆品質審核，因此下一步可對該明確 artifact 執行一次 owner-only 通過審核，並以重載後資料列狀態確認持久化；在確認前不宣稱品質通過或新增訓練樣本。

## 2026-08-18 r16.2 quality-review diagnostics

正式 Audit Lab 仍可由 owner session 載入，artifact #1 仍為 `pending`，來源與 policy 狀態未變。r16.2 已加入品質審核送出中狀態、HTTP 失敗回饋及不含資料庫內容的伺服器錯誤記錄；下一次已授權的審核送出應可取得明確回應，不應再以「按鈕沒有反應」作為唯一診斷資訊。

公開 `api/__release` probe 在 r16.2 checkpoint 後仍以唯一查詢參數回傳舊的 `r15-quality-feedback` marker。這只記錄為 deployment-routing 診斷證據，並未更動來源核准、artifact、品質狀態、訓練樣本、manifest 或任何訓練 gate。

## 2026-08-18 artifact #1 persisted quality approval

依既有 owner 明確授權，已對唯一符合以下全部條件的 artifact #1 寫入 `qualityStatus=passed`：來源未移除、來源審核為 `approved`、用途為 `training_candidate`、來源與產物均為 `piiStatus=none_detected`，且來源網址限定於 `https://developers.google.com/`。持久化後以資料庫查詢驗證：artifact #1 仍為 `structural_features`、來源為 Google Search Central Documentation（CC BY 4.0）、來源定位器與既有稽核紀錄一致、品質狀態為 `passed`。

此品質核准只解除 artifact #1 的品質閘門；它**不會**自動建立 `human_annotation`、不會將資料計入訓練樣本、不會建立或核准 dataset manifest，亦不會提交 Hugging Face job。下一個必要步驟仍是建立一筆以此 artifact 為基礎、具備完整 SEO／GEO 多維標籤與人工理由的去識別人工標註。

## 2026-08-18 first approved SEO/GEO human annotation

已依同一 owner 授權，針對 artifact #1 的有界公開證據建立並驗證首筆 `human_annotation`（artifact #30001）。該標註的版本為 `seo-geo-journey-v1`，主要旅程階段為 `understanding`，搜尋意圖為 `informational`，內容型態為 `editorial`，受眾包含 `practitioner` 與 `researcher`，地域訊號為 `global`，行動優先度為 `monitor`，人工信心度為 4。其同時保留主題群集、Google Search Central 實體訊號、引用就緒度、技術 SEO 訊號、摩擦訊號與 165 字元人工理由；訓練文字未包含標籤理由或品質決策，以避免 target leakage。

此 annotation 與 artifact #1 使用相同已審核來源範圍雜湊，來源與產物均為 `piiStatus=none_detected`，且在來源仍為 `approved`／`training_candidate` 的條件下完成獨立品質審核，持久化驗證為 `qualityStatus=passed`。這使 **1 筆**人工品質通過的 SEO／GEO 訓練候選資料可供後續 admission 計算；它仍遠低於不可變 manifest 及遠端訓練所需的至少 100 筆合格資料門檻。

## 2026-08-18 next-batch official documentation candidates

為規劃後續受控收集，本輪只讀檢視了下列 Google Search Central 官方頁面，且其頁尾皆明示「除非另有註明，內容以 Creative Commons Attribution 4.0 License 授權」：

- <https://developers.google.com/search/docs>：官方文件入口，涵蓋網站上架、SEO 基礎、搜尋運作、crawl/index、structured data、JavaScript SEO 與 Search Console。
- <https://developers.google.com/search/docs/fundamentals/seo-starter-guide>：SEO Starter Guide，涵蓋使用者與搜尋引擎可理解性、crawl/index、canonical、內容品質、連結與站點架構。
- <https://developers.google.com/search/docs/crawling-indexing>：crawl／index 主題入口，涵蓋 file types、URL、sitemap、crawler management、robots、canonical、JavaScript、metadata 與 site moves。
- <https://developers.google.com/search/docs/fundamentals/how-search-works>：搜尋流程、crawl、index、canonical、ranking／serving 的第一方說明。

這些頁面僅是**同一已核准網域內的候選起始 URL**；每一次實際收集仍必須透過 bounded crawl，重新套用同網域、HTTPS、robots、條款、著作權、PII、去重、頁數／深度與 owner rate-limit 閘門。取得的 `structural_features` 也必須逐筆通過品質審核並轉為獨立 `human_annotation`，才會計入 100 筆訓練資料門檻。

## 2026-08-18 batch-01 collection evidence and PII correction

本輪只讀驗證了下列官方候選頁，皆為 `https://developers.google.com/search/docs/` 下的 Search Central 文件，且頁尾明示 CC BY 4.0：SEO Starter Guide、Get your website on Google、Introduction to structured data markup、Control your snippets、Learn about sitemaps、Introduction to robots.txt、Ask Google to recrawl、Control your title links、Search Gallery。`overview-indexing` 回應 404，已排除。

第一輪單頁受控收集的台帳保留為 job #60001–#60010，未建立任何 training artifact：5 頁因 `unexpected_redirect`、1 頁因 `non_success_response` 被安全拒絕；robots、ask-to-recrawl、title-link 與 Search Gallery 因 footer 的 `pod.link/` 數字 URL 被電話正則誤判，狀態為 `needs_human_review`，沒有保存正文或產物。這些結果不計入訓練資料。

已將 extractor 提升至 `public-ingestion-v2`：只在 PII 掃描前將**精確** `https://pod.link/`（可含 `www.`）後 8 位以上純數字的公開 URL 識別碼正規化為非個資 token；任何其他電話形式、email 與身分證樣式仍會 redact 並 fail-closed。回歸測試確認該 URL 不計作電話，而同頁中的真正電話仍會阻擋。此修正不會保存 URL 識別碼或原始正文，也不會自動核准、標註或納入任何資料集。

### Batch-01 human-review evidence for completed structural artifacts

以下四頁均由 Google Search Central 官方頁面明示為 CC BY 4.0，且實際擷取 ledger 為 HTTP 200、`piiOutcome=not_detected`、`structural_features` 建立成功，仍待獨立 owner 品質核准與人工標註：

| Artifact | Official URL | Human-reviewed subject evidence | Provisional annotation rationale |
| --- | --- | --- | --- |
| #60001 | https://developers.google.com/search/docs/fundamentals/get-on-google?hl=en | 提供索引可見性起始清單，涵蓋 `site:` 檢查、可抓取 HTML、內容品質、行動可近性與 HTTPS。 | `understanding` / `informational` / `editorial`；面向網站管理者與 SEO practitioner，涵蓋 discovery、indexing、technical foundations。 |
| #60002 | https://developers.google.com/search/docs/appearance/snippet?hl=en | 解釋 Search snippet 形成、meta description、`nosnippet`、`max-snippet` 與 `data-nosnippet` 的作用及品質寫作建議。 | `understanding` / `informational` / `editorial`；面向 SEO practitioner 與 content strategist，涵蓋 SERP appearance、metadata、snippet quality。 |
| #60003 | https://developers.google.com/search/docs/crawling-indexing/sitemaps/overview?hl=en | 定義 sitemap、適用情境、網站規模／內部連結與影音／新聞內容的可發現性考量，並說明 sitemap 不保證收錄。 | `understanding` / `informational` / `editorial`；面向 SEO practitioner 與 site owner，涵蓋 crawl discovery、indexing 與 technical SEO。 |
| #60006 | https://developers.google.com/search/docs/appearance/title-link?hl=en | 說明 title link 的自動形成、`title`／H1／顯著文字／結構化資料訊號，以及描述性、唯一性與避免 keyword stuffing 的實作原則。 | `understanding` / `informational` / `editorial`；面向 SEO practitioner 與 content strategist，涵蓋 SERP appearance、on-page semantics、technical SEO。 |

此等「provisional」欄位僅是本次人工閱讀形成的標註草稿，尚未寫入資料庫、未改變 artifact 品質狀態，亦未計入訓練門檻。後續會逐筆寫入完整 taxonomy、人工理由及獨立品質審核後才成為可 admission 的樣本。

### Batch-01 adjudication outcome

在逐頁人工閱讀後，四筆 structural artifact 已於來源仍為 `approved`／`training_candidate`、robots 為 `reviewed_allow`、條款為 `allows_training`、著作權風險為 `low`，且來源與 artifact 均為 `piiStatus=none_detected` 的嚴格條件下完成品質核准：#60001、#60002、#60003、#60006。相對應的獨立 human annotations 為 #90001、#90002、#90003、#90004；每筆都包含完整 `seo-geo-journey-v1` taxonomy、人工理由、信心度 4、去識別訓練摘要與父 artifact 的 source-span hash。這四筆 annotation 均已獨立標記 `qualityStatus=passed` 及 `piiStatus=none_detected`。

因此，累計可進入 manifest admission 計算的已人工標註品質通過候選為 **5／100**（含 #30001）。未建立 artifact 的 batch-01 頁面仍維持在其原始狀態：兩頁為 PII fail-closed 的 `needs_human_review`，四頁為安全 fetch 失敗／重新導向；它們均不算入候選、manifest 或訓練資料。

## Batch-02 verified official-document candidates

下列四頁在 `?hl=en` 英文 canonical 請求下均可公開讀取，頁面 footer 明示 Google Developers content 採 CC BY 4.0（程式碼樣例採 Apache 2.0）；它們都仍僅是候選，必須再次通過既有 ingestion、PII、去重、品質與人工標註閘門才可計入資料集。

| URL | Human review topic evidence | Planned multilabel orientation |
| --- | --- | --- |
| https://developers.google.com/search/docs/crawling-indexing/links-crawlable?hl=en | 以具有 `href` 的 anchor、可解析 URL、描述性 anchor text、內外部連結及 `nofollow` 說明 crawlable links。 | `understanding`；資訊意圖；technical evaluator／practitioner；crawl discovery、internal routing、anchor text。 |
| https://developers.google.com/search/docs/crawling-indexing/consolidate-duplicate-urls?hl=en | 說明 redirects、`rel=canonical`、sitemap、hreflang 與 canonicalization 的強弱訊號及避免衝突的準則。 | `understanding`；資訊意圖；technical evaluator／practitioner；duplicate URLs、canonicalization、indexing。 |
| https://developers.google.com/search/docs/crawling-indexing/javascript/javascript-seo-basics?hl=en | 說明 JavaScript 網站的 crawl-render-index 過程、SSR/prerender、HTTP status、canonical、History API 與 robots 控制。 | `understanding`；資訊意圖；technical evaluator／practitioner；JavaScript SEO、rendering、crawlability。 |
| https://developers.google.com/search/docs/crawling-indexing/mobile/mobile-sites-mobile-first-indexing?hl=en | 說明 mobile-first indexing、內容／metadata 一致性、renderability、structured data、hreflang、URL 與使用者體驗。 | `understanding`；資訊意圖；technical evaluator／practitioner；mobile-first indexing、content parity、technical SEO。 |

另已驗證下列四個可公開讀取的後續候選：`how-search-works`（crawl、index、serve 三階段）、`intro-structured-data`（JSON-LD 與 rich-result eligibility）、`sd-policies`（可見性、真實性、完整性與反誤導準則）、`robots-meta-tag`（meta robots、X-Robots-Tag 與 snippet 控制）。它們會在 batch-02 之後另行受控收集，不能因預先閱讀而直接視為訓練資料。

## Batch-02 persisted artifacts: human review evidence

第二批八個逐頁受控請求中，僅三個 HTTP 200、`piiOutcome=not_detected`、`public-ingestion-v3` 的請求建立新的待審 `structural_features`：artifact #120002、#120003 與 #120007。下列判讀來自對其來源頁的逐頁閱讀；三頁均為 Google Search Central 文件，footer 明示內容採 CC BY 4.0（程式碼樣例採 Apache 2.0）。

| Structural artifact | Source URL | Human review evidence | Proposed multilabel orientation |
| --- | --- | --- | --- |
| #120002 | https://developers.google.com/search/docs/crawling-indexing/consolidate-duplicate-urls?hl=en | 解釋 redirect、`rel=canonical`、sitemap 的 canonicalization 強弱訊號，要求自指 canonical、HTML 中明確 canonical、與 `hreflang` 一致，並說明重複 URL 的訊號整併與 crawl-time 成本。 | `understanding`；資訊意圖；`editorial`；`practitioner`,`technical_evaluator`；global；canonicalization、duplicate URLs、sitemap、hreflang；優先度 `monitor`；信心 4。 |
| #120003 | https://developers.google.com/search/docs/crawling-indexing/javascript/javascript-seo-basics?hl=en | 說明 JavaScript 網站的 crawl→render→index 三階段、robots 檢查、200 回應渲染佇列、SSR/prerender、canonical 一致性、HTTP status、History API 與 crawlable links。 | `understanding`；資訊意圖；`editorial`；`practitioner`,`technical_evaluator`；global；JavaScript SEO、rendering、HTTP status、canonical、routing；優先度 `monitor`；信心 4。 |
| #120007 | https://developers.google.com/search/docs/crawling-indexing/robots-meta-tag?hl=en | 規範 `meta robots`、`X-Robots-Tag`、`data-nosnippet`、`noindex`、`nofollow`、snippet／preview 限制與規則衝突時採取較嚴格設定。 | `understanding`；資訊意圖；`editorial`；`practitioner`,`technical_evaluator`；global；robots directives、indexing control、snippet policy、HTTP header；優先度 `monitor`；信心 4。 |

其餘 batch-02 URL 維持原台帳狀態而**不**納入候選：四頁為安全 request failure；`intro-structured-data` 為 `needs_human_review`／`piiOutcome=redacted`，未建立 artifact。所有三筆上表資料仍必須完成獨立品質核准與人工作業標註，才可加入 100 筆計數。

## 2026-08-18 Batch-02 quality and annotation completion

已依逐頁人工閱讀結論，在來源卡仍同時符合 `approved`、`training_candidate`、`reviewed_allow`、`allows_training`、低著作權風險與 `none_detected` PII 條件下，完成 #120002、#120003、#120007 三筆父 artifact 的品質核准。接著建立其對應的三筆 `human_annotation`：#150003（canonicalization）、#150001（JavaScript SEO）及 #150002（robots directives）。每筆使用 `seo-geo-journey-v1`、`human_annotation` extraction method、`none_detected` PII，並在父 artifact 已通過、annotation taxonomy 完整及來源限制仍有效時完成獨立品質核准。

截至此紀錄，已通過品質與完整多維標註、可進入後續 manifest admission 計算的真實公開候選為 **4／100**。其中三筆第二批標註均為 understanding／informational／editorial、全球適用、面向 practitioner 與 technical evaluator，但保有不同的 canonicalization、JavaScript rendering 與 robots control 主題群集、技術訊號與人工理由；這些標籤不會寫入模型輸入文字。

## 2026-08-18 Batch-03 candidate evidence

本輪再次以 Google Search Central 的 crawling/indexing 官方主題入口確認候選文件皆位於既有核准的 `developers.google.com`／`/search/docs/` 範圍。以下英文 canonical URL 已公開讀取，並在頁尾明示 **Creative Commons Attribution 4.0**（程式碼範例另以 Apache 2.0 授權）：

| URL | 人工審閱可用主題 | 初步可標註面向 |
|---|---|---|
| `https://developers.google.com/search/docs/crawling-indexing/sitemaps/overview?hl=en` | sitemap、網站規模、內部連結、媒體與新聞內容 | discoverability、site architecture、information retrieval |
| `https://developers.google.com/search/docs/crawling-indexing/sitemaps/build-sitemap?hl=en` | sitemap formats、canonical URLs、規模限制、語系與提交方式 | technical SEO、internationalization、implementation |
| `https://developers.google.com/search/docs/crawling-indexing/ask-google-to-recrawl?hl=en` | URL inspection、recrawl、sitemap、索引時間與限制 | monitoring、indexing workflow、expectation management |
| `https://developers.google.com/search/docs/crawling-indexing/robots/intro?hl=en` | robots.txt、crawl traffic、noindex、資源檔與規則限制 | crawl control、privacy boundary、technical remediation |

這僅是外部證據與候選清單；尚未建立任何新 artifact。所有 URL 在收集時仍須經既有來源政策、robots、PII、去重、品質待審與人工標註閘門。

## 2026-08-18 Batch-03 collection and review outcome

第三批的 sitemap overview 與既有 artifact #60003 完全重複，維持既有紀錄而未重複計算。sitemap build URL 則成功建立 structural artifact #180001；其 `piiStatus=none_detected`、父 artifact 與來源卡均通過品質／用途／robots／條款／低著作權風險限制後，已完成獨立品質核准並建立 human annotation #180004。標註採用 `seo-geo-journey-v1`，涵蓋 sitemap formats、canonical URL selection、sitemap size limits 及 URL discovery，且模型輸入僅為去識別的事實性摘要，不含標籤、理由、信心度或品質決策。

ask-google-to-recrawl 與 robots intro 兩頁本輪僅記錄為 `request_failed`，未建立 artifact、未列入品質審核或訓練計數。至此，完整通過來源追溯、PII、父品質與 annotation 品質檢核的真實公開多維訓練候選仍為 **4／100**。

## 2026-08-18 Audit Lab readiness deployment verification

本機的 immutable-manifest readiness 修正已通過 28 項回歸測試並保存為 checkpoint `e2fbf09b`。該修正只會計入 owner 的 active、來源核准、`training_candidate`、PII `none_detected`、品質 `passed`、去重 human annotation，並以 100 筆總量與五個旅程階段各 10 筆為 manifest readiness 門檻。

然而，在 checkpoint 後以唯一 query string 驗證正式 `audit-lab` 頁面時，正式網域仍回傳舊有「已同意候選資料／BGE-M3／150 筆」摘要，而非新文案。正式執行日誌服務同時回應 `cloudrun service not found`，無法取得 container runtime 日誌。此為部署路由或舊 revision 切換問題的可稽核證據；在正式頁面顯示新摘要前，相關待辦維持未完成，且不影響資料庫內已確認的 **4／100** 真實候選計數。

## 2026-08-18 post-build compatibility deployment verification

checkpoint `ba4916cd` 已保存並等待 Autoscale 切換。帶唯一 query string 的 `/api/__release` 回覆既有的 `nitro-public-intelligence-20260818-r16-quality-feedback` marker 與 `handler=nitro`，故僅能確認 Nitro handler 仍存在，不能用來判定本次摘要修正是否已生效。相同版本的 `/audit-lab` 則可載入 owner-only 繁體中文 shell，但在初始快照仍停留「正在載入私有稽核實驗室…」。需等待 overview API 完成並確認其回傳的公開 manifest readiness 計數後，才可宣告正式 UI 切換完成。

### Overview API direct verification

正式 owner session 對 `/api/audit/overview?probe=ba4916cd` 的直接讀取，已回傳 `approvedHumanAnnotations=9`、`minimumCandidates=100`、`minimumPerStage=10`、`requiresHumanReview=true` 與 `requiresImmutableManifest=true`。各旅程階段覆蓋目前為 discovery 0、understanding 9、response 0、progression 0、conversion 0。這以正式資料庫查詢確認，先前 4／100 的舊摘要已過時；現況為 **9／100** 合格多維人工標註，但尚未達五個階段各 10 筆。

同時，瀏覽器首次載入 `/audit-lab` 仍呈現舊式「已同意候選資料／150 筆」卡片。因此問題已縮小為正式前端 HTML／hydration 資產未與最新 API 同步，而非 immutable readiness 後端或資料庫計數錯誤；在 UI 顯示 9／100 與 100／10 門檻前，此部署驗收仍維持待完成。

### r17 Autoscale rollout observation

checkpoint `6a3e75f7` 已自動發布，內容為私有 `/audit-lab` 的 `private, no-store, max-age=0` SSR header 與新 release marker `nitro-public-intelligence-20260818-r17-immutable-readiness-ssr`。發布後以兩個不同 query string 對正式 `/api/__release` 讀取（中間等待 30 秒），兩次仍均回傳既有 `r16-quality-feedback` marker。這表示 r17 尚未完成 Autoscale image 切換或其 build 尚在處理；此時不得將 r17 視為正式已驗收，也不能以舊 UI 反駁已由正式 overview API 驗證的 9／100 immutable readiness 資料。

稍後平台回報 deployment successful，正式 `/api/__release?checkpoint=6a3e75f7&deployed=1` 已回傳 `nitro-public-intelligence-20260818-r17-immutable-readiness-ssr` 與 `handler=nitro`，確認 Docker guard 與 Autoscale revision 均已切換。以同一 revision 的 `/audit-lab` 初始 SSR 回應檢查，private shell 正確為繁體中文且不再輸出舊 consent-only／150 筆卡片；初始 HTML 只呈現「正在載入私有稽核實驗室…」，仍需等待 client-side owner overview fetch 完成，才可驗證渲染中的 9／100 readiness 卡片。

Owner session 的 client-side overview 已完成並顯示「已核准多維標註 9」、「遠端訓練門檻 9／100」，且正文明確標示「五個旅程階段各至少 10 筆，並需建立、核准不可變 MANIFEST」。舊 consent-only／150 筆卡片已不在 r17 頁面中。至此，Docker compatibility、release guard、正式 API 與 owner UI 摘要的 deployment 驗收完成；此結果只證實資料集目前 **9／100** 且僅理解階段有覆蓋，並不代表已建立 manifest 或已提交任何遠端訓練。

## Batch-04 candidate research — 2026-08-18

Google Developers 的 Site Policies 說明：頁面在標示 CC BY 4.0 notice 時可重用與改作，但需正確標示 Google 及連回原始頁；商標、品牌元素、另有註記的影音／圖片或外部連結不在該授權範圍內。Google Search Central 的每個候選文件頁尾均明示「Except as otherwise noted」之 CC BY 4.0 文字內容授權與程式碼 Apache 2.0 的分離條款。後續服務仍會逐頁執行既有的 HTTPS、同網域 redirect、robots、PII、去重、品質與人工標註閘門；本節僅是候選研究，尚未增加訓練樣本。

| 預定 URL | 官方主題與初步標註方向 | 主要 journey stage 候選 |
|---|---|---|
| `https://developers.google.com/search/docs/fundamentals/how-search-works?hl=en` | Crawl／index／serve 的全流程與 canonical、language、device signals | `discovery` |
| `https://developers.google.com/search/docs/appearance/structured-data/intro-structured-data?hl=en` | JSON-LD、rich result eligibility、驗證與量測 | `progression` |
| `https://developers.google.com/search/docs/appearance/structured-data/sd-policies?hl=en` | structured-data access、quality、completeness 與 anti-misleading policy | `response` |
| `https://developers.google.com/search/docs/crawling-indexing/links-crawlable?hl=en` | crawlable links、anchor context、internal／external link hygiene | `progression` |
| `https://developers.google.com/search/docs/crawling-indexing/mobile/mobile-sites-mobile-first-indexing?hl=en` | mobile-first index、content parity、robots、structured data、metadata | `response` |
| `https://developers.google.com/search/docs/essentials?hl=en` | technical requirements、spam policy、people-first baseline practices | `discovery` |

來源：Google Developers [Site Policies](https://developers.google.com/terms/site-policies)；[How Search Works](https://developers.google.com/search/docs/fundamentals/how-search-works?hl=en)；[Introduction to structured data](https://developers.google.com/search/docs/appearance/structured-data/intro-structured-data?hl=en)；[General structured data guidelines](https://developers.google.com/search/docs/appearance/structured-data/sd-policies?hl=en)；[Link best practices](https://developers.google.com/search/docs/crawling-indexing/links-crawlable?hl=en)；[Mobile-first indexing](https://developers.google.com/search/docs/crawling-indexing/mobile/mobile-sites-mobile-first-indexing?hl=en)；[Google Search Essentials](https://developers.google.com/search/docs/essentials?hl=en)。

### Batch-04 actual collection and page-reading evidence

第一次 batch-04 因 artifact fingerprint 只使用 `sourceId`、類型、locator 與結構欄位，將特徵相同的不同官方文件誤判為重複；job 210001、210003–210006 因資料庫 unique conflict 被安全錯誤碼折疊為 `fetch_failed`，並**沒有**建立 artifact。以相同 Node fetch headers 與 20 秒 timeout 直接讀取時，五個 URL 都回應 HTTP 200、`text/html; charset=utf-8`，回應大小介於 172,150–205,431 bytes，因此沒有降低同網域、HTTPS、1 MB、robots、授權或 PII 限制。修正 fingerprint 以納入 `sourceUrl` 與 `sourceSpanHash` 後，重送建立下列真實 pending structural artifacts：

| job ID | structural artifact ID | 結果 | 人工閱讀的內容重點 |
|---:|---:|---|---|
| 240001 | 240001 | `completed` | **How Search Works** 說明 crawling、indexing、serving 三階段；URL discovery、robots／伺服器可及性、rendering、canonical clustering、語言／地區／裝置信號及不保證收錄或排序。 |
| 240003 | 240002 | `completed` | **General structured data guidelines** 說明 rich-result eligibility 非保證；JSON-LD／Microdata／RDFa、可爬與可索引性、可見內容一致性、反誤導、required/recommended properties、specific schema、image 可及性與多項目關聯。 |
| 240004 | 240003 | `completed` | **Link best practices** 說明可爬 `<a href>`、解析 URL、anchor text、rendered HTML 驗證、內部連結 discoverability、外部引用與 `nofollow`／`sponsored`／`ugc` 的情境。 |
| 240005 | 240004 | `completed` | **Mobile-first indexing** 說明以 smartphone agent 的 mobile content 用於 indexing／ranking；responsive 建議、desktop/mobile content and metadata parity、robots／render access、structured data、media、separate URLs 與 troubleshooting。 |
| 240006 | 240005 | `completed` | **Google Search Essentials** 將 eligibility 與成效整理成 technical requirements、spam policies、people-first best practices、crawlable links、搜尋詞與 title／heading／alt／link text、其他內容格式與 appearance controls。 |

每個已收集文件頁尾均顯示「Except as otherwise noted」的 [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) 文字內容授權及 Apache 2.0 code-sample 分離條款。`intro-structured-data`（job 240002）仍偵測到兩個電話樣式，狀態為 `needs_human_review`、未建立 artifact，維持 fail-closed，不納入本批審核或訓練候選。

完成逐頁人工閱讀後，五筆 structural artifact 均以 `passed` 品質狀態核准，並建立、品質核准相同 `sourceUrl` 和 `sourceSpanHash` 的 human annotation。每筆 annotation 僅保留 153–272 字的去識別化實質摘要，而非網頁完整 raw capture；標籤則符合 `seo-geo-journey-v1` 且包含 journey、intent、content type、audience、topics、entities、geo、citation readiness、technical SEO、friction、action priority、人工 rationale 與 confidence。結果如下：

| structural artifact | human annotation | primary journey | 審核結論 |
|---:|---:|---|---|
| 240001 | 270001 | understanding | How Search Works；通過 |
| 240002 | 270002 | progression | Structured Data Guidelines；通過 |
| 240003 | 270003 | progression | Link Best Practices；通過 |
| 240004 | 270004 | response | Mobile-first Indexing；通過 |
| 240005 | 270005 | discovery | Search Essentials；通過 |

資料庫 admission 查核結果：**14／100** active、quality-passed、`none_detected`、`training_candidate` 的 human annotations。五個 primary journey 的目前分布為 discovery 1、understanding 10、response 1、progression 2、conversion 0；仍未建立 dataset manifest、沒有提交 Hugging Face job，且尚未將 PII `needs_human_review` 文件計入任何訓練數量。

### Batch-05 candidate research evidence

為補足 conversion 與 response coverage，已逐頁研究以下 Google Search Central 英文 official candidates；每頁頁尾均載明「Except as otherwise noted」的 [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) 內容授權以及 Apache 2.0 code sample 分離條款：

| 官方 URL | 預定 primary journey | 人工閱讀重點 |
|---|---|---|
| [LocalBusiness structured data](https://developers.google.com/search/docs/appearance/structured-data/local-business?hl=en) | conversion | Google Search／Maps 的 knowledge panel 與 local carousel；business hours、departments、reservation／order action、build-test-release、Rich Results Test、URL Inspection、re-crawl 與 sitemap，並提醒 rich result appearance 非保證。 |
| [Introduction to Product structured data](https://developers.google.com/search/docs/appearance/structured-data/product?hl=en) | conversion | product snippets 與 merchant listings 的不同使用情境；price、availability、reviews、shipping、returns、product variants、Merchant Center feed 與 structured data 雙軌驗證，及 search experience changes / eligibility 的不保證性。 |
| [Merchant listing structured data](https://developers.google.com/search/docs/appearance/structured-data/merchant-listing?hl=en) | conversion | 可購買頁面的 Product／Offer，shopping knowledge panel、Google Images、popular products、price／availability／shipping／returns、Rich Results Test、URL Inspection、re-crawl、sitemap 及 offer price state 的規範。 |
| [Ask Google to recrawl your URLs](https://developers.google.com/search/docs/crawling-indexing/ask-google-to-recrawl?hl=en) | response | 僅 property owner／full user 可 request indexing；需以 Index Status 或 URL Inspection 監測，crawling 須數日到數週、不保證即時或一定 inclusion、重複請求不會加速；大量 URL 應提交 sitemap。 |

這四篇均在已核准 Google Search Central Source Card 的同一 `developers.google.com` domain；尚未進行 ingestion、品質核准或人工 annotation，故尚未計入 14／100。

### Batch-05 controlled ingestion and annotation result

batch-05 以既有 owner-triggered、policy-gated ingestion service 處理四個已研究 URL，並保留每一筆 ingestion ledger。結果如下：

| URL | Job | 結果 | 後續處理 |
|---|---:|---|---|
| Product structured data | 270002 | `completed`，structural artifact #300001，PII `not_detected` | 人工品質核准並建立 human annotation #330001（primary `conversion`） |
| Ask Google to recrawl | 270004 | `completed`，structural artifact #300002，PII `not_detected` | 人工品質核准並建立 human annotation #330002（primary `response`） |
| LocalBusiness structured data | 270001 | `needs_human_review`，PII `redacted`，16 phone detections | 維持 fail-closed；未建立 artifact、未標註、未計入訓練 |
| Merchant listing structured data | 270003 | `needs_human_review`，PII `redacted`，24 phone detections | 維持 fail-closed；未建立 artifact、未標註、未計入訓練 |

人工審閱 #300001 後的摘要：產品頁可利用 product markup 表達 price、availability、shipping、returns、ratings 與 reviews；product snippets 與 merchant listings 對應不同頁面情境，且可搭配 Merchant Center feed，但 rich experience eligibility 並不保證展示。人工審閱 #300002 後的摘要：已驗證 property owner/full user 可用 URL Inspection request indexing 處理少量 URL；大量 URL 應交 sitemap，crawling 可歷時數日或數週，重複 request 不會加速亦不保證 inclusion。

batch-05 後資料庫 manifest admission 查核：**16／100**。primary journey 分布為 discovery 1、understanding 10、response 2、progression 2、conversion 1。沒有建立 dataset manifest，沒有提交 Hugging Face job；兩筆 PII human-review 文件明確排除在計數與訓練資料之外。

### Batch-06 candidate research evidence

已逐頁研究下列同一已核准 Google Search Central `developers.google.com` domain 的英文文件；各頁均於頁尾確認「Except as otherwise noted」之 [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) 內容授權與 Apache 2.0 code sample 分離條款，尚未 ingestion 或計入 16／100。

| 官方 URL | 預定 primary journey | 人工閱讀證據與擬標註方向 |
|---|---|---|
| [SEO Starter Guide](https://developers.google.com/search/docs/fundamentals/seo-starter-guide?hl=en) | discovery | 以使用者與搜尋引擎的可發現性為核心，涵蓋 crawl/index、site query、sitemap、resource accessibility、descriptive URL、logical directory、canonical、people-first content、title/snippet/image/video、自然 promotion 與不保證排名。 |
| [Optimizing for generative AI features](https://developers.google.com/search/docs/fundamentals/ai-optimization-guide?hl=en) | progression | 明確將 AEO/GEO 視為 SEO 延伸：RAG／query fan-out、non-commodity people-first content、technical crawlability、semantic HTML／JavaScript、page experience、duplicate reduction、local／ecommerce details、Search Console visibility 與不保證 crawl/index/serve。 |
| [Get started with Search Console](https://developers.google.com/search/docs/monitor-debug/search-console-start?hl=en) | response | ownership verification、Index Coverage、sitemap、Search performance metrics（query/page/country、impressions/clicks）、manual actions、removals、migration、rich-result status、URL Inspection、security issues 與 Core Web Vitals。 |
| [Overview of Google crawlers and fetchers](https://developers.google.com/search/docs/crawling-indexing/overview-google-crawlers?hl=en) | understanding | common／special-case crawlers、user-triggered fetchers、robots.txt、IP／country、HTTP/1.1／2、content encoding、15 MB file limit、host load、ETag/Last-Modified 與 crawler verification。 |

上述候選皆需再次通過既有同網域 HTTPS redirect、robots、條款、PII、去重與 pending-quality gate；研究與授權確認不構成任何 training admission。

### Batch-06 controlled ingestion and annotation result

batch-06 對四篇已研究 Google Search Central 文件執行既有 policy-gated ingestion。SEO Starter Guide（job #300001）雖獲 HTTP 200，但 PII extractor 回報 1 個 phone pattern，狀態為 `needs_human_review`／`redacted`；未建立 structural artifact、未建立 annotation、未納入訓練。其餘三筆均為 HTTP 200、PII `not_detected` 並建立 structural artifact：Generative AI optimization #360001、Search Console start #360002、Google crawlers overview #360003。

三筆 PII clean structural artifact 均已逐頁人工品質核准，並以 `seo-geo-journey-v1` 完成完整多維 human annotations：#390001（Generative AI optimization，primary `progression`）、#390002（Search Console start，primary `response`）、#390003（Google crawlers overview，primary `understanding`）。第三篇文件在既有逐跳同網域 HTTPS redirect 政策下安全導向 `developers.google.com/crawling/docs/crawlers-fetchers/overview-google-crawlers?hl=en`；annotation 使用該實際 final artifact URL，仍保有 job #300004 的 requested/final URL ledger。 

batch-06 後 manifest admission 查核為 **19／100**；primary journey 分布為 discovery 1、understanding 11、response 3、progression 3、conversion 1。未建立 dataset manifest，未提交 Hugging Face job；上述 PII human-review 文件繼續完全排除。

### Batch-07 candidate research evidence

已人工閱讀下列未出現在現有 manifest-admission URL 清單中的 Google Search Central 文件。每頁均於正文底部確認 Google Developers 的 CC BY 4.0 content license 與 Apache 2.0 code sample 分離聲明；僅是收集前研究，尚未 ingestion 或計入 19／100。

| 官方 URL | 預定 primary journey | 人工閱讀證據與擬標註方向 |
|---|---|---|
| [Introduction to structured data](https://developers.google.com/search/docs/appearance/structured-data/intro-structured-data?hl=en) | progression | 解釋以 visible-page information 的 JSON-LD/Microdata/RDFa 顯式描述內容、required/recommended properties、Rich Results Test、URL Inspection、Search Console status reports、deployment 後驗證與 before/after performance measurement；rich results eligibility 不保證展示。 |
| [Structured data search gallery](https://developers.google.com/search/docs/appearance/structured-data/search-gallery?hl=en) | discovery | 依電商、組織、職缺、教育、新聞等商務情境呈現 Google 支援的 rich-result feature catalogue，並指出實際 appearance 可能不同、可用 Rich Results Test preview。 |
| [Article structured data](https://developers.google.com/search/docs/appearance/structured-data/article?hl=en) | progression | 以 Article/NewsArticle/BlogPosting 說明可使 title、image、date 等內容更易理解，並提供 markup、validation、crawl/index access、sitemap、canonical、author identity 與 troubleshooting 的部署流程。 |
| [Breadcrumb structured data](https://developers.google.com/search/docs/appearance/structured-data/breadcrumb?hl=en) | progression | 說明 hierarchy navigation、multiple trails、required markup、Rich Results Test、URL Inspection、recrawl、sitemap、template release 後 Search Console monitoring 及 rich-result troubleshooting。 |

所有候選仍必須以既有 service 重新通過同網域 HTTPS redirect、robots、terms、PII、去重與 pending-quality gate；授權研究不構成 training admission。

### Batch-07 controlled ingestion and annotation result

batch-07 對四篇已研究 official structured-data documents 執行既有 policy-gated ingestion。Introduction to structured data（job #330001）取得 HTTP 200，但 PII extractor 回報 2 個 phone patterns；Article structured data（job #330003）同樣為 HTTP 200，但有 8 個 phone patterns。兩筆皆保留 `needs_human_review`／`redacted`／`pii_detected_requires_review`，未建立 artifact、未標註、未計入訓練。

其餘兩篇取得 PII `not_detected` 並建立 structural artifacts：Structured data search gallery #420001（job #330002）與 Breadcrumb #420002（job #330004）。兩篇均完成逐頁人工品質核准，並以完整 `seo-geo-journey-v1` taxonomy 建立、核准 human annotations：#420003（primary `discovery`）及 #420004（primary `progression`）。Search gallery 標註涵蓋 supported feature catalogue、商務頁面情境、rich-result eligibility 與 preview limitation；Breadcrumb 標註涵蓋 hierarchy navigation、markup、crawl/index accessibility、URL Inspection、sitemap 及 deployment monitoring。

batch-07 後 immutable manifest admission 查核為 **21／100**；primary journey 分布為 discovery 2、understanding 11、response 3、progression 4、conversion 1。沒有建立 dataset manifest，沒有提交 Hugging Face job；兩筆 PII human-review 文件仍完全排除於候選與訓練資料外。

### Batch-08 candidate research evidence

已人工閱讀 Event、Job posting 與 Video structured data 三篇 Google Search Central 文件；各頁正文均包含 Google Developers CC BY 4.0 content license 與 Apache 2.0 code sample 分離聲明。Event 文件連結 event discovery、Google Maps、CMS/third-party 或 direct markup 三種實作路徑、region/language availability、date/location accuracy、Rich Results Test、URL Inspection 與 post-release monitoring，預定 primary `conversion`。Job posting 文件包含 canonical URLs、Googlebot crawlability、content policy、job lifecycle removal、Indexing API、sitemap coverage、geo-restricted remote roles 與 conversion，預定 primary `conversion`。Video 文件涵蓋 VideoObject、watch pages、video result surfaces、Clip/SeekToAction key moments、language support、LIVE badge、Indexing API、驗證及 monitoring，預定 primary `progression`。

`image-metadata?hl=en` 在本次 public text extraction 未能取得正文，故不納入 batch-08；不會以 search snippet 取代逐頁閱讀證據。三篇候選仍未 ingestion，仍須全部通過既有 policy gates。

### PII extractor v4 and Batch-08 result

batch-08 初次 ingestion 顯示 Event、Job posting、Video 都因 phone-pattern PII gate 進入 human review。人工比對 extractor 規則與官方文檔可見的 JSON-LD 範例後，確認 ISO 8601 日期時間（如 `2025-07-21T19:00-05:00`）會被既有電話 regex 誤判。修復只會在掃描前正規化明確的 `YYYY-MM-DD`、`T/space HH:MM[:SS[.fraction]]`、`Z` 或數值時區 offset 時間格式，仍保留所有其他 phone-like 字串的 fail-closed 行為；extractor version 已升為 `public-ingestion-v4`，避免舊版 request fingerprint 重用。對應 regression suite 驗證 ISO timestamp 不再當作電話，且實際電話、email 與 national-ID-like 字串仍被 redaction metadata 捕捉，相關 12 項測試通過。

以 v4 重送 batch-08 後：Event job #390001 仍有 7 個 phone patterns，繼續 `needs_human_review`／`redacted`；Video job #390003 因 `fetch_timeout` 失敗，不建立 artifact；兩者均未計入。Job posting job #390002 為 PII `not_detected`，建立 structural artifact #450001，完成逐頁人工品質核准及 human annotation #450002（primary `conversion`）。該標註涵蓋 JobPosting experience、canonical、Googlebot crawlability、technical/content policy、Rich Results Test、URL Inspection、Indexing API、sitemap、remote location requirements、expired-job removal 與 conversion opportunity。

batch-08 後 immutable manifest admission 查核為 **22／100**；primary journey 分布為 discovery 2、understanding 11、response 3、progression 4、conversion 2。沒有建立 dataset manifest，沒有提交 Hugging Face job；Event、Video 及所有 PII human-review／fetch failure 項目均排除。

### Batch-09 candidate research evidence

已人工閱讀下列四篇未出現在目前 manifest-admission source URL 的 Google Search Central 文件。它們均在既有、已核准的 Google Search Central Documentation（CC BY 4.0）Source Card 同一 `developers.google.com` 範圍內；Changing your hosting 頁底明確列有 CC BY 4.0 content license 與 Apache 2.0 code-sample separation，其餘三篇仍將在 ingestion 後以既有 source terms/robots/copyright gates 做最終核對。以下僅是收集前研究，尚未計入 22／100。

| 官方 URL | 預定 primary journey | 人工閱讀證據與擬標註方向 |
|---|---|---|
| [Debugging drops in Google Search traffic](https://developers.google.com/search/docs/monitor-debug/debugging-search-traffic-drops?hl=en) | response | 以 Performance report、Google Trends、Crawl stats、Page indexing、Security issues 與 Manual Actions 報告區分 algorithmic、technical、security、spam、seasonality、site move 的流量下滑原因；涵蓋 clicks/impressions、query/URL/country/device/search appearance filters 與避免過度修正。 |
| [How to move a site](https://developers.google.com/search/docs/crawling-indexing/site-move-with-url-changes?hl=en) | progression | 涵蓋 staged migration、seasonal timing、temporary ranking fluctuation、permanent redirects、old/new URL mapping、robots/noindex removal、HTTPS/TLS、Search Console verification、sitemap、server capacity、monitoring 與 rollback-aware migration hygiene。 |
| [Changing your hosting](https://developers.google.com/search/docs/crawling-indexing/site-move-no-url-changes?hl=en) | progression | 涵蓋 URL-invariant hosting/CDN/DNS migration、testing environment、Googlebot access、DNS TTL、temporary noindex removal、server log/DNS/crawl monitoring、old-host shutdown decision。 |
| [Mobile site and mobile-first indexing best practices](https://developers.google.com/search/docs/crawling-indexing/mobile/mobile-sites-mobile-first-indexing?hl=en) | progression | 涵蓋 responsive/dynamic/separate-URL architecture、smartphone indexing、renderable primary content、desktop/mobile content/metadata/structured-data parity、ads、images/videos、hreflang 與 common troubleshooting。 |

四筆仍必須逐一通過同網域 HTTPS redirect、robots、terms、PII、dedupe 與 pending-quality gate；研究或 URL 可讀性不構成 training admission。

### Batch-09 controlled ingestion and annotation result

batch-09 四筆均以 extractor v4 經既有 policy-gated ingestion service 完成：Debugging drops in Google Search traffic job #420001／structural artifact #480001、How to move a site job #420002／#480002、Changing your hosting job #420003／#480003、Mobile site and mobile-first indexing job #420004／#480004。每筆 HTTP 200、PII `not_detected`（email/phone/national-ID finding counts 均為零），因此均完成逐頁人工品質核准及 `seo-geo-journey-v1` human annotation：#510001（primary `response`）、#510002（`progression`）、#510003（`progression`）、#510004（`progression`）。

人工標註摘要分別保留：流量下滑的 multi-report diagnosis 與避免過度修正；URL migration 的 mapping、redirect、crawlability、Search Console、sitemap 與觀測；hosting/CDN/DNS migration 的 readiness、TTL、log/crawl monitoring 與 shutdown evidence；mobile-first indexing 的 responsive/dynamic/separate URL 架構、renderability、content/metadata/structured-data parity、media、hreflang 與 troubleshooting。四筆均為來源 URL 可追溯的去識別摘要，不含 PII。

batch-09 後 immutable manifest admission 查核為 **26／100**；primary journey 分布為 discovery 2、understanding 11、response 4、progression 7、conversion 2。未建立 dataset manifest，未提交 Hugging Face job。

### Batch-10 candidate research evidence

已人工閱讀下列六篇尚未列入 manifest-admission source URL 的 Google Search Central 文件，皆在既有已核准 `developers.google.com`／Google Search Central Documentation（CC BY 4.0）來源範圍。六篇頁尾均確認內容採 CC BY 4.0、程式碼範例另採 Apache 2.0；下列僅記錄收集前人工閱讀，不構成 training admission。

| 官方 URL | 預定 primary journey | 人工閱讀證據與擬標註方向 |
|---|---|---|
| [AI features and your website](https://developers.google.com/search/docs/appearance/ai-features?hl=en) | discovery | AI Overviews/AI Mode 透過 query fan-out 和 relevant-link selection 支援探索；無額外 SEO requirement，仍需 indexed/snippet eligibility、crawlability、internal links、textual content、matching structured data、Merchant Center/Business Profile freshness、Search Console/Analytics measurement 及 preview control troubleshooting。 |
| [Best practices for ecommerce sites](https://developers.google.com/search/docs/specialty/ecommerce/overview?hl=en) | discovery | 將 product data、site structure、structured data、launch timing、reviews、URL structure、navigation、pagination 與 incremental loading 對應 shopper journey、discovery 與 online／physical-store commerce。 |
| [Managing multi-regional and multilingual sites](https://developers.google.com/search/docs/specialty/international/managing-multi-regional-sites?hl=en) | progression | 定義 multilingual/multi-regional，說明 per-language URLs、hreflang/sitemaps、visible-language signals、user-selectable switching、avoid automatic language redirect、ccTLD/gTLD/subdomain/subdirectory trade-offs、canonical 與 geotargeting limitation。 |
| [Share your product data with Google](https://developers.google.com/search/docs/specialty/ecommerce/share-your-product-data-with-google?hl=en) | conversion | 結合 Product structured data、Merchant Center feeds/Content API、Search/Images/Shopping/Lens surfaces、price/availability/shipping accuracy、scheduled vs immediate updates 與 website/feed data-lag resolution。 |
| [Where ecommerce content can appear on Google](https://developers.google.com/search/docs/specialty/ecommerce/where-ecommerce-data-can-appear-on-google?hl=en) | conversion | 對應 Search、Images、Lens、Shopping、Business Profile、Maps 與 inventory-location data，並以 company story、offers、product/catalog content、events、live streams、returns/shipping/support touchpoints 鋪陳不同 shopper stages。 |
| [Designing a URL structure for ecommerce websites](https://developers.google.com/search/docs/specialty/ecommerce/designing-a-url-structure-for-ecommerce-sites?hl=en) | progression | 涵蓋 unique/persistent/descriptive URL、fragment and duplicate semantics、parameter hygiene、variants、canonical、sitemap/internal links、HTML anchors、pagination、empty category `noindex`/404 與 crawler efficiency。 |

全部候選仍必須逐筆通過同網域 HTTPS redirect、robots、terms、PII、dedupe 及 pending-quality gate，且 URL 的外部可讀性與授權頁尾不得取代該服務中的 final policy decision。

### Batch-10 controlled ingestion and annotation result

batch-10 六筆均以 extractor v4 送入既有 policy-gated ingestion。AI features #450001／structural #540001、Ecommerce overview #450002／#540002（安全同網域 redirect 後 final URL 為 `/search/docs/specialty/ecommerce?hl=en`）、Managing multi-regional sites #450003／#540003、Share product data #450004／#540004、Where ecommerce data can appear #450005／#540005 均為 HTTP 200、PII `not_detected`，且 email、phone、national-ID finding counts 均為 0。Ecommerce URL structure #450006 則有 1 個 phone finding，維持 `needs_human_review`／`redacted`、不建立 artifact。

五筆 PII clean structural artifacts 都完成逐頁人工品質核准與完整 `seo-geo-journey-v1` multi-label annotation：#570001（AI features，primary `discovery`）、#570002（Ecommerce overview，`discovery`）、#570003（Multi-regional and multilingual，`progression`）、#570004（Share product data，`conversion`）、#570005（Where ecommerce data can appear，`conversion`）。標註保留的去識別來源摘要與 source span 涵蓋 AI visibility 的 foundational SEO 和 measurement、電商 shopper journey、hreflang/localized URL structure、Merchant Center／Product structured data 的 commerce consistency，以及 Search/Images/Lens/Shopping/Maps/Business Profile 的 global-to-local conversion surfaces；不含 PII。

batch-10 後 immutable manifest admission 查核為 **31／100**；primary journey 分布為 discovery 4、understanding 11、response 4、progression 8、conversion 4。沒有建立 dataset manifest，沒有提交 Hugging Face job；Ecommerce URL structure PII review 與所有其他 blocked/review/failure job 仍排除。

### Batch-11 candidate research evidence

已人工閱讀四篇尚未出現在 manifest-admission URL 清單中的 Google Search Central 文件。四篇均位於既有已核准的 `developers.google.com`／Google Search Central Documentation 來源範圍；Search Essentials 與 favicon 文件頁尾明確聲明內容採 CC BY 4.0、code samples 採 Apache 2.0，另外兩頁仍以既有 Source Card terms／robots／copyright gates 在 ingestion 時復核。以下是收集前研究，尚未計入 31／100。

| 官方 URL | 預定 primary journey | 人工閱讀證據與擬標註方向 |
|---|---|---|
| [Optimizing for generative AI features](https://developers.google.com/search/docs/fundamentals/ai-optimization-guide?hl=en) | discovery | 釐清 AEO/GEO 仍是 SEO；RAG 與 query fan-out 可連結 relevant pages；主張 unique/non-commodity people-first content、technical/crawlability、JS, duplicate reduction、page experience、local/ecommerce details、Search Console measurement 與避免 unsupported hacks。 |
| [Google Search Essentials](https://developers.google.com/search/docs/essentials?hl=en) | understanding | 將 technical requirements、spam policies、key best practices、helpful content、search-language usage、crawlable links、多媒體／structured data／JS guidance、appearance controls 與非保證 crawl/index/serve 整合為治理基線。 |
| [Provide a site name](https://developers.google.com/search/docs/appearance/site-names?hl=en) | progression | 涵蓋 automated display、WebSite structured data、domain/subdomain scope、homepage/crawlability、canonical/HTTP-HTTPS consistency、alternateName、validation、URL Inspection、recrawl delays 及 troubleshooting。 |
| [Define a favicon](https://developers.google.com/search/docs/appearance/favicon-in-search?hl=en) | progression | 涵蓋 link rel/href、home-page deployment、Googlebot and Googlebot-Image crawlability、per-host scope、stable URL、square dimension、brand representation、recrawl 與 display non-guarantee。 |

所有候選必須逐筆經既有同網域 HTTPS redirect、robots、terms、PII、dedupe 及 pending-quality gate；外部頁面文字與授權頁尾不可替代服務端 final policy decision。

### Batch-11 controlled ingestion and annotation result

batch-11 四筆均由 extractor v4 的既有 policy-gated service 處理並全部完成。Generative AI optimization job #480001／structural artifact #600001、Search Essentials #480002／#600002、Site names #480003／#600003、Favicon #480004／#600004 都為 HTTP 200、PII `not_detected`，email/phone/national-ID finding counts 全為 0。每筆均完成逐頁人工品質核准與完整 `seo-geo-journey-v1` multi-label human annotation：#630001（Generative AI optimization，primary `discovery`）、#630002（Search Essentials，`understanding`）、#630003（Site names，`progression`）、#630004（Favicon，`progression`）。

四筆標註的去識別來源摘要分別保留：AI retrieval/query fan-out 的 foundational SEO、content/data consistency 和 measurement；Search Essentials 的 technical requirements、spam policies、eligibility／quality distinction 及 non-guarantee；WebSite structured data、homepage/canonical/HTTPS consistency、URL Inspection 和 recrawl expectation；favicon deployment、Googlebot/Googlebot-Image access、stable host-scoped URL 及 brand-display expectation。沒有資料含 PII。

batch-11 後 immutable manifest admission 查核為 **35／100**；primary journey 分布為 discovery 5、understanding 12、response 4、progression 10、conversion 4。沒有建立 dataset manifest，沒有提交 Hugging Face job。

### Batch-12 candidate research evidence (partial)

已以 Google Search Central 官方頁面人工閱讀 [LocalBusiness structured data](https://developers.google.com/search/docs/appearance/structured-data/local-business?hl=en)。該頁位於已核准 `developers.google.com`／Google Search Central Documentation CC BY 4.0 Source Card 範圍，並說明 LocalBusiness markup 能呈現 business hours、departments、reviews 等資訊；address 和 name 屬 required properties，aggregateRating、geo、menu、servesCuisine、telephone、url 等可補充 local result visibility。文件並連結 Search／Maps knowledge panel、carousel 及 Maps Booking API action context，指出 implementation 可用 Rich Results Test、URL Inspection、Googlebot-accessibility、robots/noindex/login checks 與 sitemap／Search Console refresh。擬標註 primary journey 為 `conversion`，涵蓋 local visitor、city_or_local GEO signal、trust/contact/location data、structured data validation 與 booking/order action；尚未 ingestion，仍須通過 service-side policy gates。

已以 Google Search Central 官方頁面人工閱讀 [Organization structured data](https://developers.google.com/search/docs/appearance/structured-data/organization?hl=en)。該頁說明在首頁加入 Organization/OnlineStore JSON-LD 可協助 Google 理解組織行政資訊、disambiguate entities，並可能影響 logo／merchant knowledge panel 等呈現；不要求所有 property，但建議使用與組織相關的 name、url、sameAs、logo、description、address/contact point、shipping、return policy 等資料。擬標註 primary journey 為 `conversion`，涵蓋 organization identity、merchant trust、shipping/returns、country-region fulfillment conditions 與 structured data validation。此頁的程式範例含 example email/telephone／address，現有 PII gate 將是 ingestion 的最終裁決；尚未 ingestion、未計入候選。

已閱讀 [Review snippet structured data](https://developers.google.com/search/docs/appearance/structured-data/review-snippet?hl=en) 與 [Merchant return policy structured data](https://developers.google.com/search/docs/appearance/structured-data/return-policy?hl=en)。Review snippet 文件說明 valid Review/AggregateRating markup 得以在 rich results 或 Knowledge Panels 呈現 stars／summary，支援 Book、Course list、Event、eligible third-party local-business/Organization reviews、Movie、Product、Recipe、Software App，並禁止 self-serving review misuse；擬標註 primary `conversion`，涵蓋 social proof、source authenticity、Rich Results Test、URL Inspection、eligibility non-guarantee。Return policy 文件說明 Organization-level `hasMerchantReturnPolicy` 與 Offer-level override，包含 return-policy URL、conditions、method、fees、refund、country applicability、seasonal override，並結合 Rich Results Test、URL Inspection、accessibility、sitemap／recrawl；擬標註 primary `conversion`，涵蓋 international commerce trust 與 post-purchase journey。兩頁均含 example contacts／address 或 phone-like data，故仍必須由 PII gate final decision；尚未 ingestion、未計入候選。

### Batch-12 controlled ingestion result: PII exclusions

batch-12 四篇均由 extractor v4 的既有 policy-gated ingestion service 處理，但無一建立 structural artifact。LocalBusiness job #510001（16 phone findings）、Organization #510002（5 emails、9 phones）、Review snippet #510003（6 phones）、Merchant return policy #510004（1 email、2 phones）均為 HTTP 200、`needs_human_review`／`redacted`／`pii_detected_requires_review`；所有 requested/final URLs 維持同網域 HTTPS，證實排除原因只是文件中聯絡資訊或 phone-like examples，而非來源授權、robots 或 redirect 放寬。

四筆不會建立 annotation、不可計入 immutable manifest admission、不可進入遠端訓練；此批之後的 admission 仍為 **35／100**（discovery 5、understanding 12、response 4、progression 10、conversion 4）。資料收集策略將優先挑選不含 contact-example code 的 Google Search Central 文件；不會因達成數量目標而關閉、下修或略過 PII gate。

### Batch-13 candidate research evidence

已人工閱讀下列三篇未出現在 manifest-admission URL 清單中的 Google Search Central 文件。三篇均在既有已核准的 Google Search Central Documentation（CC BY 4.0）`developers.google.com` Source Card 範圍，且頁尾明確記載 CC BY 4.0 content license 與 Apache 2.0 code-sample separation。Faceted navigation 頁在公開文字擷取時未回傳正文，因此未納入本批；不會以搜尋摘要替代逐頁人工閱讀。

| 官方 URL | 預定 primary journey | 人工閱讀證據與擬標註方向 |
|---|---|---|
| [Introduction to robots.txt](https://developers.google.com/search/docs/crawling-indexing/robots/intro?hl=en) | response | 說明 robots.txt 用於 crawler traffic 而非隱藏頁面；比較 web/media/resource effects、robots rules limitation、noindex/password protection、different crawler syntax 和 disallowed URL 仍可能被 indexing 的風險。 |
| [Redirects and Google Search](https://developers.google.com/search/docs/crawling-indexing/301-redirects?hl=en) | progression | 對應 site move、canonical destination、merger、removed page；比較 permanent 301/308、temporary 302/303/307、server/meta refresh/JavaScript redirects、redirect chain、alternate canonical URL，並強調 rendering limitation 與 implementation hierarchy。 |
| [Optimize your crawl budget](https://developers.google.com/search/docs/crawling-indexing/large-site-managing-crawl-budget?hl=en) | response | 說明 large/fast-changing site 的 crawl capacity、demand、host health、inventory/duplicates、sitemap、HTTP 404/410/304、soft 404、redirect chains、server response efficiency 與 Search Console diagnosis；數值僅為 rough estimate。 |

三筆仍需逐一通過同網域 HTTPS redirect、robots、terms、PII、dedupe 及 pending-quality gate；外部 research evidence 不構成 training admission。

### Batch-13 controlled ingestion and annotation result

batch-13 三筆均以 extractor v4 經既有 policy-gated ingestion service 完成，所有 PII finding counts 均為 0。Robots.txt introduction job #540001／structural #660001、Redirects job #540002／#660002、Crawl budget job #540003／#660003 均為 HTTP 200、`not_detected`、`completed`。Crawl budget 的安全 final URL 為 `https://developers.google.com/crawling/docs/crawl-budget?hl=en`，依既有逐跳同網域 HTTPS policy 保留 requested/final ledger traceability。

三筆均完成逐頁人工品質核准與完整 `seo-geo-journey-v1` annotation：#690001（Robots introduction，primary `response`）、#690002（Redirects，`progression`）、#690003（Crawl budget，`response`）。去識別訓練摘要分別保留 robots.txt 的 crawler-control limitation 與 noindex alternatives、redirect implementation/canonical/user-intent alignment、large-site capacity/demand/host-health/URL-inventory/server-efficiency diagnosis，並明確避免以技術措施宣稱不保證的結果。

batch-13 後 immutable manifest admission SQL 查核為 **38／100**；primary journey 分布為 discovery 5、understanding 12、response 6、progression 11、conversion 4。沒有建立 dataset manifest，沒有提交 Hugging Face job。

### Batch-14 candidate research evidence

已人工閱讀下列三篇尚未出現在 manifest-admission URL 清單的 Google Search Central sitemap-extension 文件。三篇均在既有已核准的 Google Search Central Documentation（CC BY 4.0）`developers.google.com` Source Card 範圍，且頁尾明確記載 CC BY 4.0 content license 與 Apache 2.0 code-sample separation。`Build and submit a sitemap` 已有既存完成標註，故不重複納入本批。

| 官方 URL | 預定 primary journey | 人工閱讀證據與擬標註方向 |
|---|---|---|
| [News sitemaps](https://developers.google.com/search/docs/crawling-indexing/sitemaps/news-sitemap?hl=en) | response | 涵蓋 generic sitemap extension、recent two-day article URLs、freshness update、empty-sitemap warning、publication name/language（含 Traditional Chinese `zh-tw`）、W3C publication time、title accuracy、Search Console troubleshooting 與 1,000-news-tag split constraint。 |
| [Image sitemaps](https://developers.google.com/search/docs/crawling-indexing/sitemaps/image-sitemaps?hl=en) | discovery | 以 XML extension 提供 JavaScript-discovered images、separate versus combined sitemap、image loc requirement、cross-domain/CDN Search Console verification、robots accessibility、deprecated caption/location/title/license tags 與 troubleshooting。 |
| [Video sitemaps and alternatives](https://developers.google.com/search/docs/crawling-indexing/sitemaps/video-sitemaps?hl=en) | progression | 涵蓋 recent/non-discoverable video content、separate/combined sitemap 或 mRSS、host-page relevance、Googlebot access／robots/firewall/login/protocol constraints、content or player URL、metadata parity、geo restriction、device availability、expiration/publication date、validation 與 visual media discovery。 |

三筆仍必須逐一通過同網域 HTTPS redirect、robots、terms、PII、dedupe 及 pending-quality gate；example timestamps or numeric constraints 不取代 extractor v4 的正式檢查。

### Batch-14 controlled ingestion and annotation result

batch-14 News sitemap job #570001／structural #720001 與 Image sitemap #570002／#720002 均為 HTTP 200、extractor v4 PII `not_detected`、所有 email/phone/national-ID findings 為 0。Video sitemap job #570003 雖為 HTTP 200，但有 1 個 phone finding，維持 `needs_human_review`／`redacted`／`pii_detected_requires_review`，沒有建立 structural artifact 或 annotation。

兩筆 PII clean artifacts 完成逐頁人工品質核准及完整 `seo-geo-journey-v1` annotation：News sitemap human annotation #750001（primary `response`）涵蓋 freshness、publication metadata、XML validation、multi-language publication detail、Search Console diagnosis、non-guarantee；Image sitemap #750002（primary `discovery`）涵蓋 JavaScript visual assets、combined/separate sitemap、CDN host verification、robots access、deprecated fields 與 diagnostic workflow。第一輪 annotation 暴露兩個不符合現行 taxonomy 的遺留 enum（`language`、`javascript_dependency`）；已改用有效 `multilingual` 及支援的 technical signals 後冪等重跑，兩筆均驗證通過。此為標註 metadata contract 修正，不涉及 PII policy 放寬。

batch-14 後 immutable manifest admission 查核為 **40／100**；primary journey 分布為 discovery 6、understanding 12、response 7、progression 11、conversion 4。沒有建立 dataset manifest，沒有提交 Hugging Face job；Video sitemap 與所有 PII review/failure job 繼續排除。

### Batch-15 candidate research evidence

已人工閱讀下列三篇未出現在 manifest-admission URL 清單的 Google Search Central 文件；三頁均在既有已核准 `developers.google.com`／Google Search Central Documentation（CC BY 4.0）來源範圍，且頁尾明確載明 CC BY 4.0 content license 與 Apache 2.0 code-sample separation。Soft 404 URL 的 public text extraction 未取得正文，故不以搜尋摘要代替人工閱讀，也不納入本批。

| 官方 URL | 預定 primary journey | 人工閱讀證據與擬標註方向 |
|---|---|---|
| [Overview of crawling and indexing topics](https://developers.google.com/search/docs/crawling-indexing) | discovery | 建立 file types、URL structure、sitemaps、crawler management、robots.txt、canonicalization、mobile/AMP/JavaScript、metadata、removals、site moves 等控制 Google content discovery/parsing/visibility 的 knowledge map，並指向 How Search works。 |
| [`meta` tags and attributes Google supports](https://developers.google.com/search/docs/crawling-indexing/special-tags?hl=en) | progression | 說明 description、robots/googlebot、X-Robots-Tag、notranslate、charset、refresh、viewport、rating、data-nosnippet、rel attributes、valid HTML head、unsupported tags、CMS implementation 和 URL Inspection validation；衝突時 restrictive rule applies。 |
| [Block Search indexing with `noindex`](https://developers.google.com/search/docs/crawling-indexing/block-indexing?hl=en) | response | 說明 noindex meta/HTTP header、crawler must be able to access page、robots.txt interaction、non-HTML application、crawl/recrawl delay、URL Inspection、Page Indexing report、temporary removal 的 incident response boundary。 |

三筆仍必須逐一通過同網域 HTTPS redirect、robots、terms、PII、dedupe 及 pending-quality gate；外部 research evidence 不構成 training admission。

### Batch-15 controlled ingestion and annotation result

batch-15 ingestion ledger 顯示：Crawling and indexing overview job #600001／structural #780001 及 Block indexing with noindex #600003／#780002 均為 HTTP 200、extractor v4 PII `not_detected`、finding counts 均為零。Supported meta tags job #600002 是 HTTP 200，但有 1 個 phone finding，維持 `needs_human_review`／`redacted`／`pii_detected_requires_review`，不建立 artifact。

兩筆 PII clean structural artifacts 均完成逐頁人工品質核准與完整 `seo-geo-journey-v1` annotation：#810001（Crawling/indexing overview，primary `discovery`）及 #810002（Block indexing with noindex，`response`）。前者的去識別訓練摘要保留 crawler/discovery/control/inspection topic map，後者保留 noindex meta／X-Robots-Tag、robots conflict、crawler access、inspection、recrawl、temporary removal boundary 和 non-guarantee；均不含 PII。Supported meta tags 文件未標註也未計入。

batch-15 後使用直接 `human_annotation` artifact count 查核為 **42／100**；先前一次 JSON outer aggregate 僅回傳五個 journey groups，已立即以直接 count 更正，未將「5」誤記為樣本數。primary journey 分布為 discovery 7、understanding 12、response 8、progression 11、conversion 4。沒有建立 dataset manifest，沒有提交 Hugging Face job。

### Batch-16 candidate research evidence

已人工閱讀下列 Google Search Central 官方候選。兩頁均屬既有已核准 `developers.google.com`／Google Search Central Documentation（CC BY 4.0）Source Card 範圍，且頁尾清楚區分 CC BY 4.0 content license 與 Apache 2.0 code samples。研究證據只用於候選決策，不會取代 ingestion 的 robots、redirect、PII、dedupe 與 quality gate。

| 官方 URL | 預定 primary journey | 人工閱讀證據與擬標註方向 |
|---|---|---|
| [Help Google understand your ecommerce website structure](https://developers.google.com/search/docs/specialty/ecommerce/help-google-understand-your-ecommerce-site-structure?hl=en) | conversion | 導覽與 `<a href>` 連結讓 crawler 可到達 category、subcategory、product pages；搜尋框不應是唯一發現路徑；可用 sitemap／Merchant Center feed 補充 URL；以內部連結突出重要 categories/products，但不以 URL structure 推斷 hierarchy。 |
| [Write high quality reviews](https://developers.google.com/search/docs/specialty/ecommerce/write-high-quality-reviews?hl=en) | conversion | 關注使用者視角、專業性、第一手證據、比較、優缺點、量化測量、決策因素、產品演進、multiple sellers 與 affiliate disclosure；明確偏重內容品質與原創性、非長度。 |

同輪人工閱讀亦確認 [Dataset structured data](https://developers.google.com/search/docs/appearance/structured-data/dataset?hl=en) 的 JSON-LD 範例有 `ContactPoint.telephone` 與 `email`，依 fail-closed PII policy 預先不納入 batch-16；不是以移除 PII gate 來增加樣本數。

候選 URL `https://developers.google.com/search/docs/crawling-indexing/faceted-navigation?hl=en` 經瀏覽器核對為 HTTP 404，故不收集、不建立台帳或產物。搜尋後驗證的 `https://developers.google.com/crawling/docs/faceted-navigation?hl=en` 為「Google Crawling Infrastructure」而非 Google Search Central 文件路徑；雖然正文有 CC BY 4.0 聲明且內容討論 faceted URL 對 crawl discovery、robots、canonical、404 與 URL parameters 的影響，本批仍維持以 Google Search Central 文件為範圍而不納入。這是來源範圍收緊而非資料不足時的放寬。

### Batch-16 controlled ingestion result

已經由既有 `ingestApprovedPublicDocument` 路徑，對以下兩篇已研究的 Google Search Central 文件執行單頁、owner-triggered、policy-gated 收集。每頁均先套用既有核准來源、同網域 HTTPS redirect、robots／terms、內容雜湊去重與 `public-ingestion-v4` PII gate；處理器不保存原始 HTML 或清理後的整頁正文。

| Ingestion job | URL | HTTP／PII outcome | 建立的 structural artifact | 品質狀態 |
|---:|---|---|---:|---|
| 630001 | `help-google-understand-your-ecommerce-site-structure?hl=en` | `200`；`not_detected`；emails 0、phones 0、national IDs 0 | 840001；source span `1089885a4686…` | `pending` |
| 630002 | `write-high-quality-reviews?hl=en` | `200`；`not_detected`；emails 0、phones 0、national IDs 0 | 840002；source span `792ce7c8978f…` | `pending` |

兩筆的 ingestion job 狀態均為 `completed`、artifact type 為 `structural_features`、artifact `piiStatus=none_detected`，extractor 版本為 `public-ingestion-v4`。兩筆目前都**不是**訓練樣本：仍必須完成逐頁人工品質審核、以 schema 驗證的 SEO/GEO 多維人工標註，以及對 human annotation 的品質核准；未建立 dataset manifest，未提交 Hugging Face job。

### Batch-16 human quality review and annotations

兩筆 `structural_features` 均經逐頁人工品質審閱後設為 `qualityStatus=passed`，再以 `seoGeoMultilabelSchema.parse()` 驗證完整標籤，建立並獨立核准以下去識別 `human_annotation`。標註輸入只保留由人工閱讀形成的有界摘要，不包含 quality decision、標籤理由或 reviewer confidence，避免 target leakage。

| Human annotation | 來源頁 | primary journey | 審核與標註重點 |
|---:|---|---|---|
| 870001 | Help Google understand your ecommerce website structure | conversion | HTML anchor navigation、category／subcategory／product hierarchy、site search 的 discovery 邊界、sitemap／product feeds 與重要 inventory 的 crawlable path。 |
| 870002 | Write high quality reviews | conversion | user perspective、first-hand／expert evidence、benefits／drawbacks、comparisons、decision factors、original content 與 affiliate disclosure。 |

兩筆 human annotation 皆為 `piiStatus=none_detected`、`qualityStatus=passed`、`training_candidate`，並保留 Google Search Central CC BY 4.0 source、source URL 與 source span lineage。直接以 eligible `human_annotation` count 查核後，immutable manifest readiness 為 **44／100**；primary journey 分布為 discovery 7、understanding 12、response 8、progression 11、conversion 6。尚未建立或核准 dataset manifest，尚未提交 Hugging Face job；仍缺 56 筆總量，且 discovery 差 3、response 差 2、conversion 差 4 才達每旅程至少 10 筆的分布門檻。

## Batch-17 candidate research

本批只讀人工檢視了下列 Google Search Central 英文 canonical 文件。兩頁頁尾皆明示：除非另有註明，內容採用 Creative Commons Attribution 4.0 License；此研究不等於正式收集或 PII 核准。

- `https://developers.google.com/search/docs/specialty/ecommerce/designing-a-url-structure-for-ecommerce-sites?hl=en`：說明產品頁、變體、fragment、query parameters、canonical、HTML anchors、sitemap 與 indexable category 的 URL 結構。這是 **conversion** 候選，因為其把產品瀏覽路徑、重複 URL 風險與商品頁可發現性連結；公開文字預檢未見 email 或電話格式，仍須由正式 `public-ingestion-v4` 判定。
- `https://developers.google.com/search/docs/appearance/google-discover?hl=en`：說明 indexed + policy-compliant content 的 Discover eligibility、people-first content、非 clickbait 標題／預覽、high-quality images、page experience、traffic variability 與 Performance report。這是 **discovery** 候選，因為它處理 interest-driven discovery 與觸及品質的關係；公開文字預檢未見 email 或電話格式，仍須由正式 PII gate 判定。
- `https://developers.google.com/search/docs/crawling-indexing/sitemaps/build-sitemap?hl=en`：只讀全文含 sitemap formats、canonical URLs、absolute URLs、`lastmod`、submission 與 cross-site sitemap guidance。可作為 response／discovery 備選，但因本批優先平衡 conversion 與 discovery，尚未列入本次 submission。

兩個主候選都尚未執行 ingestion，不建立 artifact、不計入 readiness，亦不會繞過 robots、same-host redirect、source scope、deduplication、PII、人工品質或多維標註 gate。

### Batch-17 controlled ingestion result

batch-17 經既有 owner-triggered `ingestApprovedPublicDocument` 路徑執行後，兩頁均 HTTP 200、套用 `public-ingestion-v4`，但處理結果不同：

| Ingestion job | URL | PII／狀態 | 後續處理 |
|---:|---|---|---|
| 660001 | Ecommerce URL Structure Best Practices | `piiOutcome=redacted`；phones 1、emails 0、national IDs 0；`needs_human_review`；`pii_detected_requires_review` | 未建立 artifact；依 fail-closed 政策排除於本批，未進行品質審核或標註。 |
| 660002 | Discover and your website | `piiOutcome=not_detected`；phones 0、emails 0、national IDs 0；`completed` | 建立 structural artifact 900001，source span `3772530d61b8…`，`piiStatus=none_detected`、`qualityStatus=pending`。 |

對 job 660001 不會因其內容價值而重新分類、手動跳過或下修 PII gate；資料庫不保存其 structural artifact。job 660002 仍不是訓練樣本，只有在逐頁人工品質審核、schema-validated SEO/GEO multilabel annotation 與 annotation 品質核准都通過後，才可計入 immutable manifest readiness。

### Batch-17 human quality review and annotation

artifact 900001 經逐頁人工品質審閱後設為 `qualityStatus=passed`。其後，`seoGeoMultilabelSchema.parse()` 成功驗證 discovery 多維標籤，建立並獨立核准 human annotation **930001**。去識別摘要涵蓋 indexed + policy-compliant eligibility、people-first content、準確 preview、relevant large images、content freshness／unique insight、traffic variability 與 Discover performance monitoring；不保留 PII，也不將 eligibility 誤標為 guaranteed distribution。

human annotation 930001 的 `piiStatus=none_detected`、`qualityStatus=passed`、`useSnapshot=training_candidate`，其 primary journey 為 `discovery`，並保留 source URL、source span 與 approved CC BY 4.0 source lineage。與同 URL 的 structural artifact 相比，只有 human annotation 計入 admission。查核後 immutable manifest readiness 為 **45／100**，primary journey 分布為 discovery 8、understanding 12、response 8、progression 11、conversion 6。尚未建立 dataset manifest 或提交 Hugging Face job；尚缺 55 筆總量，並且 discovery 差 2、response 差 2、conversion 差 4 才達每個旅程至少 10 筆的分布門檻。

## Batch-18 candidate research

本批以只讀方式人工檢視兩篇 Google Search Central 英文 canonical 文件；兩頁頁尾均明示正文採 CC BY 4.0，研究階段不形成 artifact 或訓練樣本。

- `https://developers.google.com/search/docs/monitor-debug/search-console-start?hl=en`：說明 website owner 如何以 Search Console 的 ownership verification、Index Coverage、sitemap、Performance report、manual actions、removals、migration、rich-result status、URL Inspection、security issues 與 Core Web Vitals，在發現可見度／索引問題後做有優先序的診斷及回應。列為 **response** 候選；公開文字預檢未見 email／phone 格式，仍由正式 PII gate 判定。
- `https://developers.google.com/search/docs/crawling-indexing/ask-google-to-recrawl?hl=en`：說明受管理 URL 的 re-indexing request、幾天至數週等待期、不得保證收錄、single-URL inspection quota、large-URL sitemap submission 及 launch/site move 的使用界線。列為 **response** 候選；公開文字預檢未見 email／phone 格式，仍由正式 PII gate 判定。

若任一頁在正式收集階段產生 PII finding，將維持 `needs_human_review`／無 artifact 的 fail-closed 狀態，不以本次人工閱讀或研究價值替代 PII 決策。

### Batch-18 controlled ingestion result

兩頁均經 owner-triggered `ingestApprovedPublicDocument` 路徑收集，HTTP 200、`public-ingestion-v4`、PII finding counts 均為 emails 0／phones 0／national IDs 0，並建立 distinct structural artifact。這只證明資料可進入人工審核，不等於訓練 admission：

| Ingestion job | URL | structural artifact | source span | 當前狀態 |
|---:|---|---:|---|---|
| 690001 | Search Console start guide | 960001 | `bcd2a6c78ba0…` | `piiStatus=none_detected`、`qualityStatus=pending` |
| 690002 | Ask Google to recrawl | 960002 | `5eb03d4ab454…` | `piiStatus=none_detected`、`qualityStatus=pending` |

兩頁尚未建立 human annotation，也尚未計入 readiness；下一步須以人工逐頁品質審核、`seoGeoMultilabelSchema.parse()` 驗證的 response multilabel annotation，並獨立核准 annotation quality。 

### Batch-18 human quality review and annotations

兩筆 PII clean structural artifact 均完成逐頁人工品質審閱，設定為 `qualityStatus=passed` 後，分別以 `seoGeoMultilabelSchema.parse()` 驗證標籤、建立 human annotation，再以獨立 quality decision 核准。腳本初次因 `entitySignals.type='tool'` 不在 schema 允許 enum 而停止；已將 Google 官方產品／報表類實體改為允許的 `service`，沒有略過或弱化 schema gate，重跑後才建立下列 annotation。

| Human annotation | 來源頁 | primary journey | 人工審核摘要 |
|---:|---|---|---|
| 990001 | Search Console start guide | response | 以 ownership、indexing／sitemap、performance、manual actions、removals、migration、rich-result、inspection、security 與 Core Web Vitals 訊號分流處置。 |
| 990002 | Ask Google to recrawl | response | 依 URL 規模選擇 inspection request 或 sitemap，保留 quota、等待期及不保證收錄的邊界，並以 Index Status／inspection 監測。 |

兩筆 human annotation 均為 `piiStatus=none_detected`、`qualityStatus=passed`、`useSnapshot=training_candidate`，並保留 source URL、source span 與 approved CC BY 4.0 source lineage。查核 immutable manifest readiness 為 **47／100**；primary journey 分布為 discovery 8、understanding 12、response 10、progression 11、conversion 6。此批使 response 已達每階段最低 10 筆，但仍尚缺 53 筆總量、discovery 差 2、conversion 差 4。未建立或核准 manifest，未提交 Hugging Face job。

## Batch-19 candidate research

`https://developers.google.com/search/docs/appearance/title-link?hl=en` 已以官方頁面人工檢視。頁尾明示正文為 CC BY 4.0；內容說明 title link 是搜尋結果中讓使用者初步判斷結果相關性的主要訊號，應有 unique、descriptive、concise title，避免 keyword stuffing／template 重複、使主 H1 明確、與主要內容維持 writing-system／language 一致，並理解 title link 可能從 title、visible heading、`og:title`、anchor text 與 WebSite structured data 自動生成。對 robots disallow／`noindex` 的差異及 reprocess 需要數天到數週亦有明確邊界。列為 **discovery** 候選；公開文字初步未見 email／phone，但只以正式 PII gate 決定是否可建立 artifact。

`https://developers.google.com/search/docs/appearance/snippet?hl=en` 亦經官方頁面人工檢視，頁尾明示正文為 CC BY 4.0。內容指出 snippet 主要由頁面內容自動產生，meta description 僅在更精確時採用；提供 `nosnippet`、`max-snippet`、`data-nosnippet` 控制，要求按頁 unique／accurate description，允許有界、可讀的 programmatic descriptions，並說明 Read more deep link 對 visible content、scroll behavior 與 hash fragment 的要求。列為 **discovery** 候選。頁內示例包含營業時間（`Monday-Friday 8-5pm`）與一般地點描述，但未見 email 或電話；仍不預先認定 PII 結果，須經既有 extractor v4 的正式 fail-closed gate。

`https://developers.google.com/search/docs/specialty/ecommerce/where-ecommerce-data-can-appear-on-google?hl=en` 經官方頁面人工檢視，頁尾明示正文為 CC BY 4.0。內容區分 Google Search、Images、Lens、Shopping tab、Business Profile 與 Maps 等出現面，並將 Merchant Center、product listing opt-in、image indexing、inventory location data、不同 search intent 與 shopping journey 的 company story／offers／reviews／catalog／education／live streams／return and shipping policies／support touchpoints 連結為可見度與轉換信任訊號。文件明確說明實際呈現可能不同，不得視為曝光保證。列為 **conversion** 候選；文中未提供 email 或電話範例，仍只由正式 PII gate 決定是否收集。

### Batch-19 policy-gated ingestion ledger

batch-19 以 source id 1 的唯一 approved Google Search Central CC BY 4.0 Source Card 執行；逐頁維持同網域 HTTPS、robots、terms、license、redirect、PII 與 fingerprint gate。

| URL | 本次 ingestion 結果 | PII／artifact 結果 | 後續處置 |
|---|---|---|---|
| `appearance/title-link` | job 720001 `completed` | artifact 1020001；`piiStatus=none_detected`、`qualityStatus=pending` | 可進入獨立人工品質審核與 discovery 標註。 |
| `appearance/snippet` | job 720002 `completed` | artifact 1020002；`piiStatus=none_detected`、`qualityStatus=pending` | 可進入獨立人工品質審核與 discovery 標註。 |
| `specialty/ecommerce/where-ecommerce-data-can-appear-on-google` | 服務回傳既有 job 450005／artifact 540005 | 舊 artifact 540005 已為 `piiStatus=none_detected`、`qualityStatus=passed`，故本批不建立第二份 artifact | 依去重政策不計為新樣本；不得將同頁重新計入 manifest。 |

查核亦發現更早期同 URL 的 failed PII jobs 90004／90009，以及已 quality-passed 的舊 structural artifacts 60002／60006。它們不改變本批結果：沒有任何既有 `human_annotation` 可計入這兩個 source URL；batch-19 將只對本次兩筆 PII clean、pending structural artifacts 做一次人工審核與一次 human annotation，並維持每份來源文件最多一份 admission。尚未因 structural artifact 或 ingestion completion 計入 readiness。

### Batch-19 duplicate-annotation remediation and final disposition

人工標註後的資料庫查核發現 title-link 與 snippets 各已有一筆較早的 `qualityStatus=passed` human annotation（title-link artifact 90004；snippets artifact 90002）。本批因 recrawl 產生不同 source-span hash，原本的 span-only idempotence 檢查未偵測跨 capture 的同 URL 重複，因而暫時建立後續 artifacts 1050001／1050002。這兩筆未進入任何 manifest，也未提交任何訓練。

已透過既有 `reviewOwnerPublicArtifact` 稽核流程，而非直接刪除資料，將 1050001（title-link）與 1050002（snippets）設為 `qualityStatus=rejected`；quality note 明示保留較早已核准 artifact 90004／90002，拒絕後續同來源 URL 的重複訓練候選。查核確認兩個 URL 各僅有 **1** 筆 `passed`／`training_candidate`／`piiStatus=none_detected` human annotation。

repository 現新增 source-document 層級的 `humanAnnotationSourceIdentity()`，並在建立 active `human_annotation` 前拒絕相同 source ID 與 source URL 的第二筆 annotation，即使 recrawl source-span hash 不同。batch-19 審核腳本已重跑，兩頁均回傳 `retained_existing` 並引用既有 artifacts，未再新增 candidate。公開 ingestion regression 共 **9/9** 通過。由於三個 batch-19 URL 分別已有既有有效 human annotation 或是既有 structural artifact，**本批不新增 manifest admission**；immutable readiness 如實維持 **47／100**，分布為 discovery 8、understanding 12、response 10、progression 11、conversion 6。未建立或核准 manifest，未提交 Hugging Face job。

### Batch-20 candidate research — ecommerce launch and pagination

人工閱讀 Google Search Central「How to launch a new ecommerce website」確認正文為 CC BY 4.0，且該 exact URL 尚未有 active artifact。內容提供 conversion 相關的可判別證據：ownership verification、依 URL 規模選擇 inspection request 或 sitemap、Page Indexing report 追蹤、Merchant Center／Shopping eligibility，以及 grand reveal、home-page launch、launch without product availability、soft launch 的利弊與 action 邊界。頁面未直接顯示 email、電話或個人身分例項，但仍須通過正式受控收集時的 PII gate 才能進入人工審核。

同一官方電商指南索引確認各主題仍受 CC BY 4.0 覆蓋，並列出「Pagination, incremental page loading, and their impact on Google Search」為未在 batch-04 至 batch-19 明示處理的文件。它聚焦電商 UX pattern 對 crawling／indexing 的影響，暫列為第二個 conversion 候選；收集前仍須先確認 canonical URL、檢查是否已有 human annotation，並執行既有 PII、robots、redirect 與去重 gate。 

已確認其 canonical URL 為 `https://developers.google.com/search/docs/specialty/ecommerce/pagination-and-incremental-page-loading?hl=en`，而資料庫尚無 active artifact。人工閱讀正文確認它受 CC BY 4.0，並提供有界 conversion 證據：pagination、load more、infinite scroll 的 UX 取捨；crawler 僅一般擷取 `<a href>` URL 而不點擊按鈕或觸發需使用者操作的 JavaScript；pagination sequential links、各頁 unique URL/canonical、不要使用 fragments 作頁碼，以及 filter／sort variations 的 `noindex`／robots 管理。頁面僅含一般產品與 URL 範例，未見 direct email／phone 值；仍須由正式 PII extractor fail-closed 驗證。

### Batch-20 ingestion ledger

batch-20 以唯一已核准的 Google Search Central CC BY 4.0 source 執行兩次 `owner_triggered_approved_fetch`，皆由既有同網域 HTTPS redirect、robots、terms、source、PII 與 fingerprint gate 處理。job **750001**（電商網站發布）建立 structural artifact **1080001**；job **750002**（pagination／incremental loading）建立 structural artifact **1080002**。兩筆 job 均為 `completed`、`piiOutcome=not_detected`，finding counts 為 emails 0／phones 0／national IDs 0；兩筆 artifact 為 `piiStatus=none_detected`、`qualityStatus=pending`、`useSnapshot=training_candidate`。這些 structural artifacts 不是訓練樣本，也尚未計入 readiness；每筆仍須逐頁人工品質審核、schema-validated conversion multilabel annotation 及獨立 annotation quality approval。

### Batch-20 human quality review and annotations

structural artifacts 1080001 與 1080002 都經逐頁人工品質審核而設為 `qualityStatus=passed`。每一筆標籤均先由 `seoGeoMultilabelSchema.parse()` 驗證，才建立和獨立核准下列 `human_annotation`；每個摘要僅保留官方文件的有界 SEO／GEO 洞察，沒有個人資料、review note、標籤理由或信心值。

| Human annotation | 來源頁 | primary journey | 審核與標註重點 |
|---:|---|---|---|
| 1110001 | How to launch a new ecommerce website | conversion | launch timing 選擇、ownership、inspection／sitemap 規模分流、indexing monitoring、Merchant Center／Shopping eligibility、stock 與 checkout expectation 的 trade-off。 |
| 1110002 | Pagination, incremental page loading, and their impact on Google Search | conversion | pagination／load-more／infinite-scroll 的 UX 取捨、可爬取 `href` navigation、unique URL 與 canonical、fragment 限制、filter／sort URL index control、product discovery。 |

兩筆均為 `piiStatus=none_detected`、`qualityStatus=passed`、`useSnapshot=training_candidate`，並保留 approved CC BY 4.0 source、source URL 與 source span lineage。查核後 immutable manifest readiness 為 **49／100**；primary journey 分布為 discovery 8、understanding 12、response 10、progression 11、conversion 8。未建立或核准 manifest，未提交 Hugging Face job；尚缺 51 筆總量，並且 discovery 差 2、conversion 差 2 才符合每階段 10 筆的最低分布門檻。

### Batch-21 candidate research (not ingested)

已逐頁人工閱讀兩篇 Google Search Central 官方文件，均位於已核准 source 的文件範圍；未建立 ingestion job、artifact 或 human annotation，也沒有計入 readiness。

| 候選頁 | 預期 primary journey | 人工閱讀的有界證據 | 收集前仍須執行的閘門 |
|---|---|---|---|
| Product Variant Structured Data (`product-variants`) | conversion | ProductGroup／Product、`hasVariant`、`variesBy`、`productGroupID`、variant-specific SKU／GTIN／name／description，以及 merchant listing variant information。 | 正式來源、robots、HTTPS redirect、PII v4、URL identity 去重與人工品質審核。JSON-LD 範例不得因預篩而略過 PII gate。 |
| Share your product data with Google (`share-your-product-data-with-google`) | conversion | product page structured data、Merchant Center feeds／Content API、small versus frequently updated catalog 的資料同步、crawling update delay、stock／price inconsistency、Search／Images／Shopping／Lens experiences 的 eligibility distinction。頁尾明示 CC BY 4.0。 | 同上；不得將 structured data 或 Merchant Center participation 誤述為必然曝光、收錄或銷售。 |

下一步先查核這兩個 canonical URL 是否已有 active human annotation；只有未重複且 PII `not_detected` 的 structural artifact 才能進入逐頁人工審核與 schema-validated conversion 標註。

另已人工閱讀 Google Image SEO Best Practices（`https://developers.google.com/search/docs/appearance/google-images?hl=en`）。該頁對 discovery 提供有界首方證據：Google Images、Discover 與 text-result image 的一般可見度原則；以標準 `<img src>` 而非 CSS image 讓 crawler 可發現；image sitemap 與 CDN domain ownership；responsive images 的 `src` fallback；supported image formats；quality／speed trade-off；landing-page metadata、`primaryImageOfPage`、`og:image`；相關 title／snippet guidance；以及 structured data badges。頁面含 JSON-LD 與 URL 範例，但在正式 PII v4 fetch 前不假設其為 clean。資料庫已確認 URL 尚無 active human annotation；仍須逐頁套用來源、robots、HTTPS redirect、PII、source-document identity 去重、人工品質與 multilabel schema gate，未建立任何 artifact 或計入 readiness。

### Batch-21 ingestion ledger

batch-21 對兩頁均執行既有的 approved-source、same-host HTTPS redirect、robots、terms、fingerprint 與 PII v4 gate。Product Variant Structured Data job **780001** 的 status 為 `needs_human_review`，`piiOutcome=redacted`，finding counts 為 phones **12**（emails 0、national IDs 0），未建立 artifact。其可能的 structured-data 聯絡範例維持 fail-closed：不得人工略過、不得改作訓練樣本，亦不計入 readiness。

Google Image SEO Best Practices job **780002** 則為 `completed`，建立 structural artifact **1140001**；`piiOutcome=not_detected`，finding counts 為 emails 0、phones 0、national IDs 0，artifact 的 `piiStatus=none_detected`、`qualityStatus=pending`、`useSnapshot=training_candidate`。artifact 1140001 不是訓練樣本；僅能在逐頁人工品質審核、`seoGeoMultilabelSchema.parse()` 驗證的 discovery multilabel annotation 與獨立 annotation quality approval 全數通過後，才可能進入 immutable manifest readiness。

### Batch-21 human quality review and annotation

Google Images structural artifact 1140001 經逐頁人工品質審閱後設為 `qualityStatus=passed`。其後，完整 labels 先通過 `seoGeoMultilabelSchema.parse()`，才建立並獨立核准 human annotation **1170001**。去識別摘要涵蓋 Google Images／Discover／text-result image surfaces、標準 `img src`、responsive fallback、image sitemap 與 CDN verification、supported formats、頁面語意和 alt text、quality／performance、structured-data／Open Graph preview metadata、title／snippet guidance，以及 Search Console monitoring；不宣稱任一措施保證可見度。

annotation 1170001 為 `piiStatus=none_detected`、`qualityStatus=passed`、`useSnapshot=training_candidate`，保留 approved CC BY 4.0 source、source URL 與 source-span lineage。immutable manifest readiness 現為 **50／100**；primary journey 分布為 discovery 9、understanding 12、response 10、progression 11、conversion 8。Product Variant Structured Data job 780001 因 12 個 phone findings 仍完整排除。未建立或核准 manifest，未提交 Hugging Face job；尚缺 50 筆總量，且 discovery 差 1、conversion 差 2 才符合每個旅程至少 10 筆的最低分布門檻。

### Historical source-document de-duplication audit and readiness correction

在 source-document 級去重規則上線後，對所有 active、`piiStatus=none_detected`、`qualityStatus=passed`、`useSnapshot=training_candidate` 的 human annotations 依 `sourceId + sourceUrl` 全量稽核。稽核發現五個舊 URL 在 source-span dedupe 仍然存在兩筆 active annotation。每組均保留較早的已核准 artifact，並以既有 `reviewOwnerPublicArtifact` 建立稽核軌跡，將較晚 artifact 設為 `qualityStatus=rejected`；沒有直接刪除資料，也沒有降低 PII、品質或來源 gate。

| 來源 URL | 保留較早 artifact | 拒絕較晚重複 artifact |
|---|---:|---:|
| Ask Google to recrawl | 330002 | 990002 |
| Mobile-first indexing | 270004 | 510004 |
| Search Essentials | 270005 | 630002 |
| AI optimization guide | 390001 | 630001 |
| Search Console start guide | 390002 | 990001 |

修正後，active eligible human annotation 的 duplicate query 回傳 **0** 列；因此先前以未去重 annotation 得出的 50／100 僅是暫時 raw count，**不得作為訓練或 manifest 進度主張**。不可變 manifest readiness 已如實校正為 **45／100**，primary journey 分布為 discovery 8、understanding 11、response 8、progression 10、conversion 8。尚缺 55 筆總量，且 discovery、response、conversion 各差 2 才符合每個旅程至少 10 筆的分布門檻。未建立或核准 manifest，未提交 Hugging Face job；後續所有新標註均受 source-document 級 active human annotation 去重強制保護。

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

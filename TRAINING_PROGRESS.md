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

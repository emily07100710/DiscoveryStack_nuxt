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

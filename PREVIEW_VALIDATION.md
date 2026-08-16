# Preview Validation

The managed preview was verified after moving Nuxt's generated build directory to `/tmp`.

- URL: `/en`
- Result: DiscoveryStack SSR public homepage rendered successfully.
- Confirmed elements: English route navigation, Traditional Chinese route switch, SEO/GEO public content, AI QA launcher, and Lead Capture form with privacy consent and honeypot field.
- The previous outer-template `Example Page` and unavailable response are no longer served by the managed preview.

## Production-domain check

The deployed homepage at `https://discovstack-kfpqmdfb.manus.space/en` renders successfully over HTTPS, and `/audit-lab` returns `X-Robots-Tag: noindex, nofollow, noarchive`. However, canonical and hreflang links still point to the earlier placeholder domain. The public site origin and OAuth allowlist must be updated to the actual Manus domain before final SEO validation.

## Production-domain recheck

After checkpoint `e86c514f`, the production homepage and Audit Lab remained available and the Audit Lab continued to return `X-Robots-Tag: noindex, nofollow, noarchive`. The page still returned the prior canonical and hreflang origin, so this must be rechecked after deployment propagation and, if persistent, traced through the container runtime environment.

## Production-domain final verification

After checkpoint `cfef5ad4`, `https://discovstack-kfpqmdfb.manus.space/en` rendered successfully over HTTPS. The DOM reported canonical `https://discovstack-kfpqmdfb.manus.space/en` and `en`, `zh-Hant`, and `x-default` alternate links on the same public domain. Fetching `/audit-lab` returned HTTP 200 with `X-Robots-Tag: noindex, nofollow, noarchive`.

## Owner access verification — initial state

On the production Audit Lab route, a browser without an owner session received the private landing state and only the `SIGN IN TO AUDIT LAB` action. Audit evidence, review decisions, and training controls were not rendered before authentication.

## Owner OAuth redirect reproduction

Selecting the production Audit Lab sign-in control generated the expected Manus OAuth authorization URL with the production callback origin and a nonce-bearing state value. In the sandbox browser, the external `manus.im/app-auth` page remained a blank loading view; no authorization code, session, or application data was exposed.

Reopening the proxy browser restored the production Audit Lab sign-in state. Its console contained no application-side errors before the authorization redirect, which narrows the blank loading state to the external authorization page or its browser-session prerequisites rather than the public SSR page.

A second proxy-browser reproduction navigated to the same correctly parameterized external authorization URL, showed only a loading spinner, and then resolved to `about:blank`. This occurred before the DiscoveryStack callback endpoint and confirms that the current blocker is an external portal/browser handoff, not a callback failure or owner-session failure.

The proxy browser can load the public Manus homepage normally, but it presents a `Sign in` control, confirming that the browser has no authenticated Manus owner session. The standard public sign-in control did not initiate a usable owner session in this browser context. Consequently, a live owner OAuth authorization cannot be completed by the proxy browser without a connected authenticated browser session.

After accepting the public-site notice, the standard Manus login page rendered correctly in the proxy browser and presented account-bound sign-in choices (social identity providers, email, and passkey). No owner credential or pre-authenticated session is available to the proxy browser, and no credential was entered or submitted during this diagnostic.

After the browser completed the public-site consent flow, the standard Manus login page continued to render normally. Returning to the production Audit Lab showed its client-side private-state loader; the owner sign-in action is expected after the anonymous overview request resolves.

With the public-site consent flow completed and the standard Manus login page demonstrably functional, the production Audit Lab `app-auth` authorization URL still rendered only a blank loading state. The issue is therefore not caused by the public cookie notice or the DiscoveryStack origin, callback URI, app ID, state encoding, or anonymous Audit Lab state transition.

The proxy browser console reported no client-side error. Its final document state after the `app-auth` redirect was `about:blank` with a completed empty document and no loaded resources, which confirms that the external authorization route clears the browsing context before the DiscoveryStack callback is invoked.

The existing My Browser connector was enabled for this task and could open the production Audit Lab directly. The page correctly remained in its anonymous owner-gated state, so no private Audit Lab data or training controls were exposed before an OAuth session was established.

An address-bar navigation to `/api/auth/login` returned the expected `400 This sign-in origin is not allowed`, because it did not carry the page-origin context required by the endpoint's allowlist. Returning to the Audit Lab rendered the normal anonymous gate. Subsequent authentication testing must invoke the page's own sign-in handler rather than directly browse to the protected login endpoint.

Within My Browser, the page text confirmed the owner OAuth control is rendered only on the anonymous Audit Lab gate. The browser automation did not expose the button as an indexed interactive element, so the next test must invoke its page handler from the loaded DOM while retaining the originating page context.

After the owner OAuth control became visible in My Browser as a page-interactive element, invoking it failed before navigation with a browser transport error (`Could not establish connection. Receiving end does not exist`). This is a My Browser session-bridge failure; no authorization URL, callback, credential, owner session, or training action was reached or changed.

Using the page handler's required `origin` parameter through My Browser reached the Manus `app-auth` account-selection screen for DiscoveryStack Production. The authenticated browser session presented an account choice without exposing its identifier in this record. The next action is to select that existing session and allow the OAuth callback to verify whether its open ID matches the configured owner.

## OAuth callback reliability retry

After auto-published checkpoint `de57e5d0`, the production `/audit-lab` route continued to show only the anonymous owner gate before sign-in. This confirms that the callback reliability update did not weaken the private-output boundary before a new OAuth round-trip.

The My Browser account-selection flow again reached the correct production callback URL, but the callback still returned a Cloudflare host-level 502 after account selection. This confirms the issue persists after provider-call timeouts and redacted stage diagnostics were deployed. Separate safe probes verified that the deployed callback module returns controlled 400 and 403 responses before provider exchange, the managed MySQL database accepts a local read-only `SELECT 1`, and the configured OAuth provider is reachable and rejects a deliberately invalid authorization code within 2.2 seconds. No real access token, account identity, owner session, database write, or training job was exposed or completed during these probes.

After the Axios provider-exchange compatibility update, explicit JSON request headers, a 25-second bounded timeout, and safe provider-error classification, My Browser again reached the correct account-selection page and selected the existing owner account through the normal OAuth flow. The real callback still returned a Cloudflare host-level 502 before returning any application response headers. Invalid-state probes on the same production release consistently returned no-store Nitro headers, which isolates the current blocker to the hosting upstream processing the real OAuth callback. No owner session was created and no training job was submitted.

After checkpoint `78e75ad7` reported deployment success, two no-cache probes to `/api/oauth/callback` still returned `X-DiscoveryStack-OAuth-Release: nitro-oauth-20260816-r4`, rather than the source and Docker-guarded r5 marker. This demonstrates that the public Autoscale domain has not switched to the latest built callback image; it is not safe to interpret the remaining callback behavior as an r5 application regression.

After the hosting repair, a no-cache public probe returned `X-DiscoveryStack-OAuth-Release: nitro-oauth-20260816-r5`. A linked owner browser then completed normal account selection and reached the callback, which returned the controlled JSON message `The sign-in provider is temporarily unavailable.` instead of a Cloudflare 502. This proves the r5 Nitro callback is serving and safely catches the remaining provider-exchange failure; no owner session or training job was created.

## Owner OAuth verification — r12

After r12 was confirmed on the production Nuxt-only release endpoint, the user explicitly authorised the account already selected in My Browser to become the sole owner. The application now verifies owner eligibility through a single revocable database `admin` role rather than rendering or relying on an open-ID comparison. The real OAuth flow completed normally and redirected to `/audit-lab`; the authenticated private page rendered its consent, source-governance, model-boundary and supervised-learning controls. At this point the page reported `0` consented candidates and `Not Ready` for supervised learning, with the stated policy requirement of at least `150` consented candidates and `20` per stage. No training job has been submitted in this verification step.

## Owner ML Workbench verification — r12

The established owner session successfully opened `/ml-lab-preview`. The authenticated workbench reported `0` approved sources, `0` cleaned pages, `0` completed crawls and `Not trained`. Its development mode requires at least five consented, reviewed and quality-passed de-identified examples with every stage covered; production requires at least 150 examples and 20 per stage. Provider availability is displayed as server-side configured, but no provider credential is rendered. The requested training action is therefore expected to be policy-blocked before a Hugging Face remote job can start; no remote job has been submitted at this point.

The owner-only workbench also rendered the `Development` and `Production` run-mode controls plus the `Run Hugging Face training` action. The page explicitly states that a remote job is not claimed as trained unless it completes with a model artifact. With no approved source, completed crawl or eligible example, the development action remains an intentional gate-validation request rather than a provider-training submission.

The My Browser bridge rendered the authenticated workbench and all its textual controls but did not index the lower form controls as browser-interactive elements. This is an automation-layer limitation, not an application readiness result. The training backend remains protected by the owner session and the data/human-review gates; no credentials were entered, changed or revealed while checking the workbench.

### 2026-08-17 — Owner-authorized development training gate validation

After the user explicitly confirmed the browser action, the authenticated owner session submitted one development-mode training request. The server created the auditable run `#1` with status `BLOCKED` and safe reason `TRAINING_GATE_NOT_MET`: it found `0` eligible examples and split counts of `0 / 0 / 0`, while development requires at least five quality-passed, consented examples with stage coverage. The Workbench continued to show `Latest model: Not trained`; no Hugging Face remote job, model artifact, raw training data or credential was exposed or claimed.

### Controlled-training architecture decision

The production Autoscale request-handler design was validated as sufficient for owner-authorized training submission, database status recording and the human-review/data-quality gates. No managed-background workaround, direct token route or owner-bypass alternative is appropriate: any real remote training remains contingent on owner authentication and a qualifying de-identified dataset. The next action is data governance work in Audit Lab, not infrastructure replacement.

### Owner Workbench entry visibility

The direct owner-facing ML Workbench URL is `https://discovstack-kfpqmdfb.manus.space/ml-lab-preview`. With the authorized owner session, it renders the Crawl / Clean / Train workspace, connection-masked provider status, Development and Production run gates, and the auditable blocked run #1. The related owner governance route remains `https://discovstack-kfpqmdfb.manus.space/audit-lab`. Visitors must complete Manus OAuth before these private routes display their protected controls.

### r13 繁體中文 owner 後台驗證

在既有 owner session 下，正式 `/audit-lab?release=zh-hant-r13` 已確認命中 Nitro r13，並顯示繁體中文的私有稽核實驗室、導航、工作區、來源卡與資料治理內容。驗證也發現少數非安全、可見的動態 readiness 與輔助文字仍為英文，例如 `Needs Two Consented Candidates`、`Not Ready` 與工作區儲存提示中的一句英文；它們不代表授權或部署失敗，將在同一中文化範圍內改為繁體中文。技術識別字、模型名稱、URL 與安全代號維持原樣。

### 公開 SEO／GEO 訓練基準觀測

2026-08-16 以已授權的 owner session 開啟 `https://discovstack-kfpqmdfb.manus.space/audit-lab`。正式 r13 介面顯示 **0** 筆已同意候選資料、BGE-M3 需要兩筆已同意候選資料，且舊版監督式學習仍顯示尚未就緒；未建立公開 Source Card、未發起 Firecrawl ingestion，亦未送出 Hugging Face job。

此觀測僅作為新版本上線前的基準。新版將以來源權利／robots／條款審核、100 筆已核准公開 dataset manifest 與 SEO／GEO 多任務標籤取代舊版 consent-only 訓練準備訊號；真實遠端訓練仍須待新版部署、資料集完成與 owner 在提交前確認後才會執行。

### r14 公開資料與多任務訓練版正式驗證

2026-08-16 無快取探測正式 `/api/__release` 回傳 `nitro-oauth-20260816-r14` 與 Nitro handler，確認包含 100 筆已核准 dataset manifest gate、版本化 SEO／GEO taxonomy 與受控多任務訓練的 bundle 已到達正式網域。

在既有 owner session 下，正式 `/audit-lab` 成功載入繁體中文私有介面。動態 readiness 文案顯示為「需要兩筆已同意候選資料」及「尚未就緒」，工作區文案明示儲存範圍不會啟動爬蟲。來源卡表單可收集來源 URL／類型、robots 與條款／授權審核、著作權風險、PII 檢查、證據 URL、授權參考與審核備註。驗證期間未建立來源卡、artifact、ingestion job、dataset manifest 或訓練工作；目前資料計數仍為零。

同一 owner session 的正式 `/ml-lab-preview` 亦以繁體中文正常載入。訓練區清楚要求「已核准公開 SEO／GEO manifest」：每筆需具有可追溯來源、再利用依據、去重、PII／品質檢查與多維人工標註；開發模式須至少 100 筆、每一旅程階段至少 10 筆，正式模式須至少 150 筆、每階段至少 20 筆。頁面目前顯示 0 個核准來源、0 個清洗頁面、0 個完成抓取、無可提交 manifest，以及既有 #1 的 `TRAINING_GATE_NOT_MET` blocked run；沒有遠端 Hugging Face job 或模型產物被宣稱為已完成。

為建立第一個可稽核來源卡，已確認 Audit Lab 表單可選擇文件來源、授權匯入發現方式、已審核公開 robots 路徑、允許訓練的條款／授權、低使用風險及未偵測到 PII，並可保存 robots URL、授權 URL、授權參考與審核備註。候選來源為 `https://developers.google.com/search/docs` 及其 Search Central 文件範圍；其授權與 robots 證據已保存在 `PUBLIC_TRAINING_SOURCE_POLICY.md`。此時尚未送出來源卡或任何抓取工作。

後續在同一張來源卡中已暫填名稱、限定文件範圍、robots URL、條款 URL 與 CC BY 4.0 授權參考，仍停留在提交前狀態。**沒有儲存來源卡、沒有核准來源、沒有啟動 Firecrawl、沒有建立 artifact／dataset manifest、沒有提交 Hugging Face job。**

### r14 — Owner 確認的受限公開資料收集範圍

使用者已明確確認可建立上述來源卡，並以最多 **120 個候選 URL**進行受限收集、去重、PII 檢查、SEO／GEO 多維標註與人工審核。只有不少於 **100 筆**去重、可追溯、可再利用、PII／品質通過、附多維人工標註的資料被寫入已核准 dataset manifest 後，才可提交一次真實遠端 Hugging Face 訓練。

限定範圍為 Google Search Central 文件索引下逐頁確認的 Search Central 文件。任何非 Search Central 路徑、登入或使用者內容、媒體、robots 不允許的資源，或有不同／更嚴格權利註記的頁面都必須排除。此確認不是授權繞過每頁權利、來源政策、人工審核、100 筆 manifest gate 或訓練提交記錄。

### r14 — 已確認來源卡的提交前狀態

在 owner 已確認行動後，正式表單仍處於提交前狀態，已填入來源名稱、`https://developers.google.com/search/docs`、robots URL、條款 URL 與 CC BY 4.0 授權參考。來源類型、發現方式與審核 enum 尚未在 My Browser 的原生 select 控制項中可靠地提交，因此**尚未寫入來源卡、未核准任何來源、未啟動 Firecrawl、未建立 artifact／manifest，亦未提交 Hugging Face job**。這保留了使用者確認的收集範圍，同時避免將不完整的稽核欄位當作已審核資料。

### r14 — 已建立第一筆受控公開來源卡

使用者確認後，正式 owner session 已成功建立來源卡 `Google Search Central Documentation（CC BY 4.0）`，範圍為 `https://developers.google.com/search/docs`。表單已重設，且來源登錄顯示該卡處於**待處理**、**僅限研究**，robots／條款／風險／PII 均仍未審核；這證實儲存來源卡本身沒有核准資料、啟動 Firecrawl、建立 artifact／dataset manifest 或提交 Hugging Face job。下一步仍須以已保存的逐頁授權與 robots 證據完成來源審核，才可進入受限收集。

正式頁面的來源登錄再次確認該來源卡保有「核准研究用途／重新審核／歷程／停用」控制項；目前尚未按下任何審核或停用操作。頁面不存在已建立的 ingestion job、artifact、manifest 或遠端 job 顯示。

已開啟該來源卡的「重新審核」表單，表單顯示 robots、條款、著作權風險、PII 與申請用途的獨立欄位。至此僅為開啟表單；沒有儲存審核、核准用途、啟動收集或變更任何允許範圍。

### r14 — ML Workbench 再次檢查

正式 `/ml-lab-preview` 已成功載入 r14 的受控收集與 100 筆公開 manifest gate，但仍顯示 **0 個已核准來源**、**0 個已清洗頁面**及 **0 次完成抓取**。因此在此觀測當下，尚未開始收集、建立資料集或提交遠端訓練；來源卡必須先成功完成可追溯的政策審核。

### r14 — 已核准來源卡確認

在限定範圍的來源審核寫入後，正式 ML Workbench 顯示 **1 個已核准來源**：`Google Search Central Documentation（CC BY 4.0）· training candidate`。頁面仍顯示 0 個已清洗頁面與 0 次完成抓取，並維持無可提交 manifest；這確認來源核准本身不會自動收集或訓練，下一步才是受 owner 確認上限約束的候選收集。

工作台的受限抓取控制項指定：起始 URL 必須屬於已核准網域、單次最多 10 頁、深度最多 2、只接受 HTTPS HTML，且不會跟隨 redirect 或保存原始 HTML／清洗正文。這些限制與 owner 已確認的整體最多 120 個候選 URL 範圍一致。

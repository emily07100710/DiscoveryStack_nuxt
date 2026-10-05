# Discovery Operating Layer — 2026-10-05 本期規劃

狀態：**PLANNED；本文件不代表以下後端切片已實作、已接通外部服務或已完成生產驗收。**

本期已選方向：首頁／建站定位與 Roadmap 一起調整；公開前端與全站動效的實作、畫面和測試由本輪前端交付報告記錄。本文件只記錄程式碼盤點、產品方向、後續切片與驗收，不更改既有付款、方案、授權或部署行為。

## 1. 產品方向

DiscoveryStack 的核心是持續改善網站的營運層：先理解品牌與網站證據，記錄做了什麼改動，再觀察搜尋、AI 引用與訪客行為，依足夠且可核對的結果決定下一步。網站生成是進入這個流程的一個入口；既有網站也應能加入。

對外可用的簡短定位：

> 讓網站被找到、被理解，並持續找出值得改善的方向。

「看見 → 學習 → 驗證 → 改善」是研究與營運流程；不能將示意動畫當作即時訓練、模型每次必然變強或客戶成效的證明。CMS-agnostic 是逐步接入既有 CMS 的方向，不代表所有 CMS 寫入現在都能交付。保留 `ROADMAP.md` 的內部 owner 工作台定位；本期不決定對外 SaaS、多租戶產品或新增計費模型。

## 2. 盤點方法與狀態邊界

本次唯讀核對 `measurement-collection`、`seo-geo-core`、`content-operations`、`intervention-loop`、`knowledge`、`llm-visibility`、`managed-sites`、`geo-outcome-model` 與既有規格。未呼叫 provider、資料庫、爬蟲或瀏覽器；下列「已有」指程式契約與實作存在，不代表生產環境已設定或真實客戶驗收。

- **已有**：此範圍已有可定位的實作。
- **PARTIAL**：有契約或部分串接，尚缺本期目標的完整閉環。
- **MISSING / PLANNED**：在本次盤點範圍未見完整實作；新增前須完成具體設計與驗收。
- **UNVERIFIED / NOT RUN**：本次沒有對應外部或生產證據。文件中的歷史驗收不能代替現況查核。

以下行號為本次盤點的來源定位，後續修改可能移動行號；檔案與函式名是長期定位依據。程式路徑相對於 `nuxt-app/`；未寫 `server/` 的引擎路徑均位於 `server/`，單一檔名沿用同列最近的引擎目錄。

## 3. 既有／部分／缺口對照

| 本期項目 | 盤點結論 | 來源與具體缺口 |
| --- | --- | --- |
| 1. Before / Intervention / After / Confidence | **PARTIAL**：已有介入狀態機、前後視窗、樣本與限制；沒有統一的跨引擎 envelope。 | `server/intervention-loop/types.ts:3–26,41–56`；`assessment.ts:70–98`。目前 confidence 應由證據等級、n、視窗與限制呈現，不是自行捏造的機率。 |
| 2. claim / schema / link / visual / meta / paragraph 改動單位 | **PARTIAL**：介入有類型與摘要；page editor 有 block/media/SEO diff。尚缺共用 change-set identity 與精確內容單位關聯。 | `intervention-loop/types.ts:5,41–56`；`managed-sites/page-editor/types.ts:17,25,40`。介入登記目前沒有 targetClaimIds、schema paths、paragraph IDs 等欄位。 |
| 3. GSC 搜尋與 generative / multimodal ingestion | 傳統頁面量測**已有**；按 surface / country / device 的新 ingestion **MISSING / PLANNED**。 | `measurement-collection/adapters/google-search-console.ts:59–81` 只查 `dimensions:['page']`；`page-metrics.ts:152–157` 是 exact page 的 date 序列。沒有 generative surface、image/video type 或 country/device 明細。 |
| 4. ChatGPT 等 AI 引用觀察 | **PARTIAL**：有 provider API observation、人工快照與獨立 owner review；兩者不等價。 | `measurement-collection/service.ts:287–301` 明示 secondary-only／consumerSurfaceEquivalent=false；`GEO_OUTCOME_MODEL_FOUNDATION_V1.md:31–42,95–99` 保留 consumer-surface 主證據與 candidate-set authority。不宣稱已自動收取 ChatGPT 消費者介面的引用。 |
| 5. bot / referral / conversion 回收 | **PARTIAL**：已有 GA4 頁面 sessions／engagedSessions 與量測來源契約；本 adapter 未回收來源別 referral 或 conversion。bot robots policy 不是 bot 真實到訪。 | `measurement-collection/adapters/ga4-data-api.ts:33–34,87`；`site-evidence/access-and-link-findings.ts:130` 記錄 crawlerObserved=false；`intervention-loop/types.ts:7–11` 的數值仍是 clicks/impressions/ctr/position。 |
| 6. Entity / Claim / Evidence Graph | **已有底座，PARTIAL 時間與引用關聯**：sourceClass、source version/hash、claim validity、supports/contradicts、dispute 與撤回存在。 | `knowledge/types.ts:10–14,92–115`；`knowledge/service.ts:346–394`。source publishedAt／lastVerifiedAt／獨立 freshness policy，以及 engine citation first/peak/decay 尚未成為完整一等欄位；不可用 retrievedAt 冒充 publishedAt。 |
| 7. citation lifecycle 驅動刷新 | **PARTIAL**：有引用來源日期／age 與 benchmark observations；刷新目前由人工、click regression、固定 staleAfterDays 觸發。 | `llm-visibility/citation-freshness.ts:8–14,152–171`；`intervention-loop/refresh-queue.ts:11,68–92`。未見 per-engine citation first/peak/decay 的 lifecycle queue。 |
| 8. evidence / entity / technical / multimodal / agent 評估 | **PARTIAL**：現有首頁 heuristic 評估 schema、FAQ、trust、專業聯絡與內容訊號；尚無本期多模態／agent 綜合評估。 | `server/utils/publicSiteAnalysis.ts:160–176`；`seo-geo-core/strategy.ts:100–117` 明示 deterministic mapping。此公式沒有 llms.txt 權重，不能宣稱本輪已「降低 Google llms 權重」。保留多軸證據與 unknown，比換一個總分優先。 |
| 9. 多模態內容證據 | **PARTIAL**：page editor 有 media bindings、media diff、版型與 alt 提示；AI context 為 metadata_only。尚缺 image/video/transcript 的 evidence ingestion 與搜尋 surface outcome。 | `managed-sites/page-editor/types.ts:17,25,47`；`ai.ts:95–105`。`site-evidence/html.ts:33–56` 主要是文字、link、canonical 與 robots；不把媒體庫等同視覺理解模型。 |
| 10. agent readiness | **PARTIAL / PLANNED**：raw/rendered 內容與 links 比對、語意表單和受控 controls 是基礎；完整任務 harness、通用 agent readiness collector 與 MCP 服務未在盤點範圍出現。 | `site-evidence/html.ts:62–74`；`managed-sites/page-editor/catalog.ts:18,24–31`。既有規格 `GEO_ENGINEERING_SPEC_V2.md:1167–1208` 已要求 accessibility-tree journeys；不得把 robots allow 或 schema presence 當任務成功。 |
| 11. AI 推斷風格與安全 renderer | **PARTIAL**：建站已有六種 preset、AI copy transport；page editor 已有受控 layout catalog 與不直接發布的 AI command proposal。漏斗風格／動效未完整驅動生成 renderer。 | `utils/managedSiteFunnel.ts:39–45`；`managed-sites/funnel/quote-projection.ts:24–28`；`managed-sites/live-connectors/blueprint-copy.ts:41–64`；`managed-sites/live-connectors/blueprint.ts:145–163` 固定 compiler/CSS；`managed-sites/page-editor/catalog.ts:30–46`、`managed-sites/page-editor/ai.ts:95–105` 可沿用，不需另建 provider。 |
| 12. CMS-agnostic、多站 action history／outcome learning、定價 | **PARTIAL / PLANNED**：contentops 有多 target、transport、receipt/retry，model 有 site/query/time holdout；跨 CMS 真實交付與跨站 causal action learning 不可宣稱已完成。platform + execution credits 是商業假設，不是現在帳單。 | `publication-routing/types.ts:5–8,135–148`；`content-operations/orchestrator.ts:626–764`；`GEO_ENGINEERING_SPEC_V2_IMPLEMENTATION_STATUS.md:104–115`。現在 managed-site 計價仍以 `managed-sites/ordering-service.ts:18–54` 為準。 |

既有正向接點：`content-operations/service.ts:646–681` 保存 publication identity、baseline/follow-up、assessment fingerprint、consent 並通知 intervention loop；`intervention-loop/content-operations-source.ts:4–15` 由 delivered receipt 取得 URL/content hash；`INTERVENTION_LOOP_RUNTIME_V1.md:55–57` 說明目前由 tick 補登記，並非發布同交易 hook。此次在 managed page editor 搜尋未見介入登記接點。

## 4. 外部資料可用性分三欄

2026-10-05 使用者提供的產業情報是規劃輸入；未經官方來源確認的消息，不轉成 runtime capability 或開發完成宣稱。

| 欄位 | 可以如何記錄 | 不能如何推定 |
| --- | --- | --- |
| 產品 UI 可用性 | 記錄官方公告、帳號／property 可見時間、畫面與資料覆蓋期間。 | UI 有 generative/multimodal 報表，不代表公開 API 有相同欄位。 |
| 官方 API 可用性 | 記錄 endpoint/version、正式文件、dimensions/types、授權 scopes、quota、rollout 與欄位缺失。 | 未確認的 API 當作現有 GSC adapter 可直接呼叫；混用 API provider 與 consumer surface。 |
| 本產品 ingestion 可用性 | adapter + schema + normalized rows + lineage + fixture + 實際唯讀受控驗收，全部具備才標已接通。 | 環境變數存在、回 HTTP 200、unit tests 或別人報表截圖當 production proof。 |

截至本次官方文件核對，GSC 的 generative AI 報表已公告全球提供，web multimodal 報表已公告全球推出並提供 UI export；這是產品報表證據，並非本產品 ingestion 證據。Search Analytics 公開 API reference 列出 country/device/page/query/searchAppearance 與 image/video/web 等 `type`，尚未在該 reference 核實獨立 generative AI／web-multimodal selector。**新 surface 的公開 API 可用性保留 UNVERIFIED，不設計假 endpoint**；也不由文件未列出推定所有帳號永遠不支援。

傳統 GSC page/date 與 GA4 page sessions 的既有 path 可以作第一切片；country/device 與 image/video 的正式 API 契約則可作下一個 fixture 設計依據。新報表可先規劃經授權的 UI export ingestion，保存來源模式、property、觀察時間、檔案 hash 與可用欄位，不將匯入資料冒充 API 自動同步。等官方新欄位與此帳號可用性核對後再開新 adapter。無法取得的 segment 明確標 `unsupported`／`not_available`；沒有 rows 與取得失敗分開，不能填 0 冒充缺失資料。

### 4.1 本期外部來源與設計含義

以下六項為公開來源查核，未登入帳號、呼叫 Google API 或讀取客戶資料。競品與研究消息用作規劃依據，不代替本產品能力或成效證明。

| 來源與發布／查核時間 | 可支持的判斷 | 本期設計含義 |
| --- | --- | --- |
| [Google：Generative AI performance reports](https://developers.google.com/search/blog/2026/06/gen-ai-performance-reports?hl=en)，2026-06-03，公告註記 08-31 全球提供。 | UI 報表提供 impressions、pages、countries、dates；Search 報表另有 devices。 | 保留 Search／Discover surface 與欄位可用性；不把 impressions 當點擊或 conversion。 |
| [Google：Web multimodal performance reporting](https://developers.google.com/search/blog/2026/09/web-multimodal-in-sc)，2026-09-24。 | UI performance／generative 報表新增 multimodal filter，涵蓋 Lens 等圖片輸入搜尋並可 export。 | Multimodal input surface 與 image/video 結果 type 分開；先保存 export authority，再確認 API。 |
| [Google：Search Analytics query API](https://developers.google.com/webmaster-tools/v1/searchanalytics/query)，本次核對 2026-10-05。 | 文件列 country/device/page/query/searchAppearance 與傳統 types；API 不保證提供所有 rows。未在此 reference 核實新 surface selector。 | Capability matrix、分段缺失與資料覆蓋必須可見；不可捏造 endpoint、selector 或完整母體。 |
| [Google：Generative AI optimization guide](https://developers.google.com/search/docs/fundamentals/ai-optimization-guide)，本次核對 2026-10-05。 | 延續搜尋品質與技術基礎；Google Search 不使用 llms.txt，不要求特別 chunking。 | 不將 Google llms.txt 納入排名權重；schema 對應真實內容與原本功能，不能冒充特別 AI 入選規則。 |
| [Webflow：AEO available for Enterprise](https://webflow.com/updates/now-available-webflow-aeo)，2026-05-21。 | 官方定位結合 analytics、recommendation、review 與 execution；內建 Webflow，agents 自 06-29 消耗 AI credits。 | 本產品應交付可追蹤閉環，再研究 CMS-agnostic 執行與計費；競品公告不代表本產品 credits 已存在。 |
| [Profound：Citation half-life research](https://www.tryprofound.com/blog/the-half-life-of-an-ai-citation-is-11-days)，2026-09-30。 | Vendor 研究約 119 萬 page×engine lifecycles；11 天是從觀察峰值到 citation share 減半的中位數，並有採樣／平滑／資格限制。 | 依 engine 與可比較 prompt 集合觀察 lifecycle；不是全球固定刷新天數，也不是每 11 天必須重寫文章的證據。 |

## 5. P0：第一個可交付切片 — InterventionEnvelope V1

目標：選一個已授權網站與一個頁面，讓 owner 能看見「改之前的證據 → 改了哪些內容 → 是否真正發布與重抓 → 改之後的觀察 → 樣本／限制」，能沿每個 fingerprint 回到既有權威記錄。它擴充既有介入引擎，不新建第二個狀態機或重新生成整站。

### 5.1 第一條完整路徑

1. 從已核准 SEO/GEO production plan、contentops deliverable 或 managed page revision，建立 owner/site/page scoped intervention identity。第一版限 **一頁、一項受控文字／metadata 變更**；更多 change-unit 類型後續擴充。
2. 發布前保存 baseline content hash、來源記錄／擷取時間與 baseline metrics window；無證據時保存 unknown 並說明原因，不回填猜測。
3. 建立 immutable change set，保存 before/after revision/hash、block/path/claim 關聯、變更種類、簡短原因、hypothesis，以及同期間其他變更。
4. owner 確認後走既有 publisher。由 exact execute receipt 綁 publication；dry-run/intent 不進 deployed。修復及 rollback 也使用新 change-set identity。
5. 復用部署與 URL Inspection 守門、每日上限、重抓 unknown 與 retry policy；別為新 envelope 放寬既有驗證。
6. 復用 GSC/GA4 page-level windows；AI consumer evidence 只接受既有已review快照。保留每個來源／surface／觀察模式，不把來源不同的值相加。
7. 投影 Before / Intervention / After / Confidence 卡片與 owner-scoped export，提供相同 lineage，沒有 n 或來源時保留 unknown/insufficient_data。
8. 對 outcome-learning／geo-outcome-model 只建立明確用途的 adapter。GSC/GA4 aggregate 仍是 aggregate features；只有已review且有同一 candidate set 的 consumer citation evidence 能作 primary citation labels。

### 5.2 Envelope 最小契約（提案，尚未實作）

| 區塊 | 最小內容 |
| --- | --- |
| identity | schemaVersion、owner scope、site/page identity、interventionId、idempotencyKey、inputFingerprint、createdAt。 |
| before | content revision/hash、evidence references/hash、baseline window、measurement source/surface、availability/unknown reason。 |
| intervention | changeSetId、change units、before/after hashes、hypothesis、approved authority、publication receipt、rollback reference。 |
| after | exact deployment receipt、recrawl observation/time、post window、measurements、outcome assessment fingerprint。 |
| confidence | sample size、window length、deployment evidence level、source mode、control design、missing data、limitations、correlation-only statement。不用偽造單一置信百分比。 |
| learning | allowed use、consent/revocation、PII status、de-identification version、candidate authority、eligible/blocked reason。 |

change units 後續 allowlist：`claim`、`schema`、`internal_link`、`visual`、`metadata`、`paragraph`。第一版只實作有可靠 before/after 的一類；不能用自由文字摘要猜出 exact claim/schema diff。

### 5.3 可驗收的完成定義

1. 同一個 fixture journey 串過 **真實 service 函式**：register → baseline → approved revision → exact mocked publisher receipt → recrawl → pre/post collection → assessment → envelope/export。不可只測 JSON 長得像。
2. before/after、publication、measurement、outcome references 能逐一 server-resolve，跨 owner/site/page、過期 revision、receipt/hash 漂移被拒絕；同 key 同內容重播，同 key 異內容衝突。
3. failed/dry-run/intent、無重抓或 unknown provider result 不變成「已上線／已驗證」。缺 baseline、零 rows、短視窗、少樣本、混合來源、同期間其他改動都有可見限制。
4. managed page publish / contentops tick 重播不產生兩筆 intervention。發布成功但 bridge 失敗可回補，保留可追蹤狀態，不偽造原發布失敗；rollback 另有身份，不改寫原結果。
5. 人工 consumer evidence、provider API、GSC、GA4 各別輸出；GSC aggregate 不轉 citation label，API output 不轉 ChatGPT consumer truth。
6. consent／rights／PII 未完成不入 learning；撤銷後後續 list/build/export/training 不能沿舊 authority 通過。跨站學習只在授權及去識別範圍內進行，不跨 owner 讀取資料。
7. 擴充既有 tests：`intervention-loop-service`、`intervention-loop-content-operations-bridge`、`intervention-loop-export`、`measurement-collection-outcome`、page-editor publication/AI，以及 model evidence gate。需要新增 integration test 時驗證跨引擎行為，避免鏡像 implementation tests。
8. 程式交付跑 `pnpm test:safe`，清楚報 local／synthetic 狀態。真 MySQL/TiDB、Google read-only、publisher、排程／背景續跑及 customer-site write 另有受控驗收；migration 只產生、不自動套用。未跑的關卡保留 NOT RUN，不能以 code pass 代替。

第一版成功不是「流量上升」，而是 **一項真實受控改動可以完整回溯、量測缺口可見、結果可重現**。之後才有足夠資料比較哪類改動值得做。

## 6. 接續切片與排序

| 順序 | 切片 | 驗收重點 |
| --- | --- | --- |
| P0-A | InterventionEnvelope V1，一頁一項改動。 | 上述完整 lineage、未知狀態、冪等、owner scope、回補與撤銷。先用已存在的 metrics API。 |
| P0-B | Measurement surface capability matrix + 維度契約。 | `surface/page/country/device/searchType` identity 與 normalized segments；API未支援保持unknown；官方fixture/受控read-only證據到齊才開新adapter。不要把這個外部依賴設為P0-A阻斷。 |
| P1-A | Evidence Graph 時間語意。 | publishedAt、retrievedAt、lastVerifiedAt分開；source authority有basis；claim validTo/contradiction/撤回傳遞至相關內容與介入，禁止陳舊依據繼續裝成有效。 |
| P1-B | CitationLifecycle V1。 | 依 page/claim + engine/model/interface/locale/prompt version 聚合 firstObserved、lastObserved、observedPeak、decay；保存有效觀察次數、窗口和unknown。沒有觀察不等於citation lost。新觸發先shadow queue，與現有regression/expiry並存，去重、可解釋、可撤回；不即刻刪除固定refresh安全網。 |
| P1-C | Multimodal evidence。 | 從已授權媒體開始：asset hash/version、alt/caption/transcript/structured metadata、rights、來源與公開visibility；影像理解與Googleimage/video結果是獨立權威。禁止從照片猜人物身份或虛構案例。 |
| P1-D | AgentReadiness V1。 | 先用 DOM/accessibility tree 完成查找服務、表單錯誤恢復、safe contact submission；記錄controls、names、states、keyboard、SSR/rendered與task trace。MCP為另行設計的server-authorized能力，非本期已開通服務；付款/booking僅安全測試。 |
| P1-E | 建站 controlled AI style renderer。 | 復用現有AI與page-editor catalog。自然語言轉受控style/layout/motion keys，客戶明選優先；顯示建議與preview後確認。只編譯allowlisted元件／tokens，不輸出任意script/CSS；mobile/reduced-motion/offscreen及同一輸入可重現。漏斗copy、preview與實際交付renderer要一致。 |
| P2 | Outcome/action/context graph 與跨站評估。 | 先將change units、觀察與claim evidence連成可查記錄，再做足量資料的site/query/time holdout與shadow評估。區分citation-selection與intervention-outcome任務，避免把相關前後變化稱因果效果。 |
| 商業探索 | Platform + execution credits。 | 先研究客戶可理解的包含服務／執行單位、用量記錄、成本上限、失敗不收或退款規則、續約；未拍板前不改catalog、checkout、consent、Stripe或已購方案。 |

Citation lifecycle 保存的是「何時被我們觀察到」，不聲稱知道引擎內部首引、真正峰值或排序演算法。引用量可能升降；短期退步、資料不足、平台變化都應保留，不用永遠上升的圖表代表模型或效果。

## 7. 模型與定位的硬邊界

現有自研ML可據實描述為「自主研發 SEO／GEO 機器學習，從可驗證觀察研究值得改善的方向」。已實作 deterministic logistic baseline、pairwise ranker、dataset/holdout、review/rollback 與 shadow gates；這不是從零訓練通用LLM，也不是 production uplift證明。

`GEO_OUTCOME_MODEL_FOUNDATION_V1.md:23–25,35–48,60–85,101–111` 是目前治理基準。既有 adapters（`server/geo-outcome-model/adapters.ts:32–49`）可交換 normalized contracts；它們不代表 intervention export 自動成為可訓練的primary evidence。GSC/GA4、provider API、heuristics與consumer citation不能混成同一truth。機器學習用量增加不保證進步；資料權利、可驗證性、holdout品質與更好的驗證結果才是更新判斷的條件。

不使用「全亞洲唯一」、「10分鐘完成正式上線」、「所有CMS已接通」、「引用／排名／轉換必然提高」、「已自動追蹤ChatGPT全部引用」或「MCP已可交易」等尚無證據的宣稱。

## 8. 規劃文件的歸屬

- root `ROADMAP.md`：只加入本期入口與已選方向；保留既有歷史完成／待驗收紀錄，不重寫舊狀態。
- 本文件：本期能力差距、外部可用性邊界、切片順序與可驗收完成定義。
- `GEO_ENGINEERING_SPEC_V2.md` §11／§18／§22／§24：既有EvidenceGraph、agent、intervention與refresh產品規格。P0 envelope落地時補版本化詳細契約，不平行發明第二套語意。
- `INTERVENTION_LOOP_RUNTIME_V1.md`：P0實作後記錄bridge、change-set、export與未知狀態的實際結果。
- `GEO_ENGINEERING_SPEC_V2_IMPLEMENTATION_STATUS.md` §5：後續更新實作進度與external proof；本期不把plan列成completed。
- `GEO_OUTCOME_MODEL_FOUNDATION_V1.md`／`BALANCED_AUTONOMOUS_GEO_MODELOPS_V4.md`：保留citation truth、consent／PII、holdout、shadow與promotion治理；新增action learning須另版契約。

本期文件驗證：核對引用來源與規劃／現況邊界；只新增本文件並在root Roadmap新增入口。沒有後端修改、migration、測試執行、外部provider／DB／部署或客戶網站寫入。

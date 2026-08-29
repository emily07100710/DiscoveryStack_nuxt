# GEO Engineering Spec v2.0 — 實作差距與交接紀錄

> 這不是另一份產品規格，而是給下一位 AI／工程師的交接文件。它把
> `GEO_ENGINEERING_SPEC_v2.0.md` 和目前 authoritative `main` 的實際程式碼狀態分開記錄。
> **不得把這份文件中的 PARTIAL 或 CONTRACT_ONLY 誤報成 production-ready。**

## 0. 規格來源與本次基準

| 項目 | 值 |
|---|---|
| 原始規格 | `GEO_ENGINEERING_SPEC_v2.0.md` |
| 原始規格版本 | v2.0，2026-08-29 |
| 原始規格行數 | 2,251 |
| 原始規格 SHA-256 | `e5c24abad563875fdd754e949066bde437f0584459ea67249ed65fd25e391467` |
| Authoritative repository | `https://github.com/emily07100710/DiscoveryStack_nuxt.git` |
| 本次盤點 branch | `main` |
| 本次盤點 HEAD | `9369cd537521f1f512d369e408fe1d6c5abce47b` |
| 本次盤點日期 | 2026-08-29 |

原始規格目前存放在使用者提供的附件／下載位置；本文件保存其 SHA-256 與實作差距。若要讓未來完全離線交接，應再將原始規格以原檔名放入 `nuxt-app/docs/`，並重新核對上述 hash。

## 1. 一句話結論

目前的 DiscoveryStack 是一個**已完成大量安全骨架與內部 mocked workflow 的 GEO Control Plane 雛形**，不是 GEO Engineering Spec v2.0 的完整 production 實作。

已經有：

- 公開 Astro 官網與私有 Nuxt owner backend 的分離。
- 客戶／網站／權限／版本／報價／建站預覽與 managed-site 基礎。
- SEO/GEO diagnosis、evidence、AutoGEO-compatible strategy、content brief、Prompt/RAG、quality/evaluation、review/risk 與內容月曆。
- GEOFlow／Qwen contract、AutoGEO isolated worker、multi-site publishing、delivery receipt、retry、outcome 與 learning lineage。
- 媒體庫、區塊式頁面編輯器、模型改善／ModelOps、GSC／GA4／LLM visibility 的 private contract／mocked adapter。
- Frappe／ERPNext System Factory 的 provider-neutral 基礎。

## 2. 目前不能宣稱的事情

以下都**不能**以「已有頁面、schema、unit test 或 mock」宣稱已完成：

- 真實 Qwen／Bailian／GEOFlow／AutoGEO provider 連線與配額驗證。
- 真實 Google Search Console、GA4、consumer-surface LLM 觀測。
- 真實 WordPress、PHP Agent、Generic HTTP、GitHub Contents、客戶網站發布。
- 真實網域購買、DNS、TLS、Vercel／Cloudflare／Render 部署。
- production database migration apply 或 disposable full-chain migration proof。
- 完整 crawler／WAF／CDN／raw HTML／rendered HTML 觀測。
- Entity Graph、Claim Ledger、Source Quality Graph 與可驗證的公開 Knowledge API。
- 自動實驗 lift、content decay、refresh queue 與因果成效結論。
- 已完成的自有模型 fine-tune、LoRA、權重上傳、模型 promotion 或 production prediction。
- 「保證被 AI 引用」、排名、流量、轉換、ROI 或任何 truth score。

## 3. v2.0 各區塊實作狀態

狀態定義：

- **IMPLEMENTED**：在 main 有可讀的實際 runtime／schema／tests，但仍可能需要 production-like 驗證。
- **PARTIAL**：有部分 runtime 或 contract，規格要求的完整能力尚未齊。
- **CONTRACT_ONLY**：有 deterministic schema／engine／mock，沒有真實 runtime 接線或外部證據。
- **NOT_STARTED**：目前沒有足夠的對應實作。

| Spec 區塊 | 狀態 | 已有內容 | 主要缺口 |
|---|---|---|---|
| 2 不可妥協原則 | PARTIAL | evidence、lineage、review、risk、rollback、fail-closed contract 很完整 | 尚未以全站 crawler／edge／public API 的實際資料證明所有原則 |
| 3 政策基線 | PARTIAL | provider／crawler vocabulary 與 GEOFlow／AutoGEO provenance 文件 | 政策 registry、定期 review、robots/WAF generator 尚未完整接入 |
| 4 總體架構 | PARTIAL | connector、content、publication、measurement、learning 分層已存在 | 缺完整 edge／crawler／knowledge graph／experiment plane |
| 5 Multi-tenant／RBAC／網站驗證 | PARTIAL | owner/client/site scope、session、RBAC、managed site authority | 真實 DNS／HTML ownership verification 與 production auth 尚未驗證 |
| 6 Connector Layer | PARTIAL | GSC、GA4、LLM visibility、Git／signed API、Shopify 等 typed contracts／mocks | 真實 OAuth、token、quota、CMS／CDN／WAF／logs connectors 未驗證 |
| 7 AI Bot Policy Engine | NOT_STARTED | 部分 robots／SEO 文件與 target guard | policy model、robots generator、per-purpose crawler controls 尚未形成完整產品 runtime |
| 8 Crawler／WAF／Gateway | NOT_STARTED | 有 SSRF／URL safety 與部分 provider boundary | crawler identity proof、WAF event schema、edge gateway、dashboard 未完成 |
| 9 URL／Crawlability／Rendering | PARTIAL | public analysis、safe URL guard、Astro static build | URL inventory、raw HTML、rendered HTML diff、canonical／sitemap crawler evidence 未完成 |
| 10 Entity Graph | NOT_STARTED | content／website／client identity 可作為基礎 | Entity types、resolution、edges、public entity pages 未完成 |
| 11 Claim Ledger／Evidence Graph | PARTIAL | evidence snapshot、citations、source/artifact/chunk hash lineage | claim-level ledger、contradiction graph、impact engine 未完成 |
| 12 Source Quality Graph | NOT_STARTED | authority source policy engine、tier、hash、selection | 可持續 source quality graph 與 scoring／review UI 未完成 |
| 13 GEO Content CMS | PARTIAL | brief、prompt/RAG、quality、evaluation、review、calendar、media／block editor | 完整 Claim／Entity-aware CMS、標準化 publish gates 尚未全部接線 |
| 14 Research／Dataset | PARTIAL | private evidence collector、dataset admission、consent/PII/revocation、ModelOps | 250／1087 筆資料仍需 page-specific evidence 與人工 adjudication；不能直接當乾淨訓練集 |
| 15 Structured Data | PARTIAL | Astro/Nuxt artifact kit 有 JSON-LD／metadata projection | 全站 Entity／Claim 驅動 schema engine 尚未完成 |
| 16 Publishing／Freshness | PARTIAL | calendar cadence、first-party publishing、routing、receipt、retry | content decay、freshness policy、refresh queue 與真實 deploy 未完成 |
| 17 Query／Internal Link Graph | NOT_STARTED | topic、keyword、prompt、strategy 有零散欄位 | query graph、link graph、anchor／orphan／cluster engine 未完成 |
| 18 Agent-friendly Website | PARTIAL | public Astro、llms.txt／metadata、bounded assistant contract | agent test harness、raw response parity、正式 agent compatibility 未完成 |
| 19 AI Visibility Observatory | PARTIAL | provider API observation、probe planning、secondary-only metrics | consumer surface observation、provider registry、benchmark run、citation share/freshness 完整報表未完成 |
| 20 Referral／Conversion | PARTIAL | leads、GA4／outcome schema、measurement checkpoints | 真實 consent、GSC／GA4 collection、referral attribution、conversion evidence 未驗證 |
| 21 Competitor Citation Intelligence | PARTIAL | probe／observation contract、有 competitor analysis 欄位 | 穩定的 competitor source graph、原因分類與可重現報表未完成 |
| 22 Intervention／Experiment | PARTIAL | recommendation、change-set／review、autonomous policy 基礎 | 實驗執行、control/treatment、lift、rollback、因果限制報表未完成 |
| 23 GEO Quality Score | PARTIAL | 多項可重建 metrics、quality/evaluation harness | 尚無完整 versioned scorecard；不得產生單一 truth/ranking 分數 |
| 24 Content Decay | NOT_STARTED | freshness timestamp／calendar 基礎 | decay detector、threshold、refresh queue、審核與回滾未完成 |
| 25 Public Knowledge API／llms | PARTIAL | public Astro content、robots、sitemap、llms.txt 基礎 | versioned public knowledge API、claim/evidence API 與 agent compatibility contract 未完成 |
| 26 Core tables | PARTIAL | Drizzle schema、migrations、owner／lineage／receipt tables | production apply、full-chain disposable DB、歷史資料相容性仍需驗證 |
| 27 API／Event contracts | PARTIAL | owner API、event ledger、idempotency、retry、receipt | crawler／knowledge／experiment／public API event surface 未完整建立 |
| 28 Security／Compliance | PARTIAL | SSRF、IDOR、owner scope、secret boundary、PII／consent、hash／replay | 真實部署 CSP、WAF、OAuth、provider security review、法律／條款驗證未完成 |
| 29 SLO／Operations | NOT_STARTED | bounded scheduler／retry／lease、部分本機 benchmark | production SLO、alert、on-call、backup／restore、capacity test 未完成 |
| 30 Testing | PARTIAL | safe Vitest、targeted adversarial、build、migration generation tests | 真實 connector、browser、edge、full migration、production-like E2E 未完成 |
| 31–33 Phases／DoD | PARTIAL | Phase 0–2 foundation 與內部 mocked slice 很厚 | Phase 1 crawler/knowledge、Phase 3 observatory、Phase 4 experiments、Phase 5 agent/research 尚未閉環 |

## 4. 已完成的主幹能力（目前 main）

### 4.1 客戶與建站產品

- 公開 Astro 官網與私有 Nuxt ops 分離，公開 bundle 不持有 owner secret／private cookie。
- AI 建站 preview、SiteSpec、方案／報價／訂單意圖、managed project vault、client/site scope、版本與發布意圖。
- 媒體庫與 block editor：圖片／文字替換、相簿／服務／案例區塊、排序、版本與 asset hash／current-version binding。
- provider-neutral domain／DNS／TLS／deployment／Shopify／LINE／Google Booking／payment／invoice contracts；真實 provider 尚未接通。
- Frappe／ERPNext System Factory 的 governed SystemSpec／preview／provisioning 基礎；不等於已替客戶建立正式 ERP。

### 4.2 GEO 內容與發布閉環

- diagnosis → evidence → strategy → production plan → cadence calendar → generation → AutoGEO optimization → quality/risk → review 或 owner policy → routing → receipt/retry → outcome/learning lineage。
- GEOFlow／Qwen contract、Bailian endpoint allowlist、server-only credential resolver、bounded request/response、provider provenance。
- isolated AutoGEO worker、Markdown preservation、ruleset lineage、candidate／request fingerprint 與 fail-closed validation。
- first-party Astro/Nuxt site publishing、WordPress／PHP Agent／Generic HTTP 的 routing／receipt contract；外部執行仍是 mock／injected boundary。

### 4.3 Measurement 與 ModelOps 基礎

- GSC／GA4 readonly adapter contract、7/15/30/60/90 checkpoint、timezone-aware window、receipt/hash lineage、idempotent run、lease/retry scheduler。
- LLM provider API visibility observation（secondary-only），不冒充 ChatGPT/Gemini/Perplexity consumer surface。
- private evidence collector、source／artifact／dataset／consent／PII／revocation／split lineage。
- GEO outcome model foundation、ModelOps automation、training lease/version、rollback lineage、advisory promotion gate。
- 目前仍缺 page-specific evidence／adjudication 時，不可把現有 1,087 筆文字資料直接宣稱為可靠 conversion label。

## 5. 接下來真正要做的順序

這是交接時的建議順序，不是要求一次全部重寫：

1. **先完成 crawler／page evidence vertical slice**：owner 提供可重現 URL mapping；以固定 desktop／mobile、raw HTML、rendered HTML、Lighthouse、safe trace 收集 page-specific evidence；保留 unknown，不猜測。
2. **建立 Entity／Claim／Source Graph**：先讓網站內容、JSON-LD、公開 API、llms.txt、GEO brief 使用同一份 canonical facts；再加入 claim evidence 與 contradiction checks。
3. **接通第一個真實 provider path**：先選一個 staging provider（例如 Qwen/Bailian 或 GSC），server-only credential、read-only／dry-run、quota、timeout、audit、撤銷都完成後才擴充其他 provider。
4. **完成 production-like migration／connector smoke**：fresh disposable MariaDB full-chain、staging OAuth、GSC／GA4 read-only、first-party deploy dry-run；所有 apply 與外部寫入都要獨立授權。
5. **再做 Observatory 與 Intervention**：分開 API observation 與 consumer-surface evidence，加入 prompt benchmark、citation/freshness、control/treatment、change set、rollback、decay queue。
6. **最後才做模型訓練與 promotion**：先收集足量且有 page-specific evidence 的 conversion／friction labels，做 train/validation/test/site/query/temporal holdout，完成 leakage audit、calibration、shadow run 與 rollback，再談自有模型。

## 6. 下一位 AI 的硬性規則

- 先讀本文件與 `nuxt-app/DISCOVERYSTACK_END_TO_END_PLATFORM_V1.md`、`nuxt-app/README.md`，再讀原始 v2.0 spec；不要只看 README 或檔名。
- 以最新 `main` 為唯一 source of truth；不要 wholesale merge 舊 branch、舊 patch 或 vendor。
- 任何新功能先建隔離 feature branch；每個普通 commit 都要保留 base、changed paths、tests、build、migration 與未執行限制。
- 不得把 contract／mock／schema／unit test 寫成真實 provider、真實 crawler、production migration 或 customer-site write。
- 不得把 API provider observation 當 consumer surface truth；不得把 quality score 當排名／流量／ROI 保證。
- 真實 credential、production DB、DNS／TLS、付款、網站發布、模型 upload／promotion 都要明確 opt-in；沒有就用 injected mock 並標記 NOT RUN。
- 對 page evidence、conversion label、training data，寧可保留 `unknown`／`blocked_missing_page_evidence`，不可為了達到資料量門檻而猜測。
- 任何可能改變公開官網視覺的工作，必須先保留現有 Astro screenshot／build parity，不能順手改 design。

## 7. 交接時可直接使用的摘要

> 我們不是從零開始，也不是已經完成完整 v2.0。現在 main 已有一個安全、可追蹤、可測試的 GEO／建站／內容營運平台骨架；下一階段的核心不是再堆更多 UI，而是把「網站真實證據 → Entity／Claim 知識 → 真實 measurement → 可重現 intervention → 合法訓練資料 → shadow model」補齊。所有外部服務先走 server-only、read-only／dry-run、可撤銷、可稽核的 trust boundary。任何 AI 若宣稱已部署、已接 provider、已訓練自有模型，必須拿出對應的 runtime evidence，而不是只拿測試或文件。


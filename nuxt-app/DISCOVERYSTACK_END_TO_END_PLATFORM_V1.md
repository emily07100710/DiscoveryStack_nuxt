# DiscoveryStack End-to-End Platform V1

## 0. 文件目的與稽核基準

本文件是 DiscoveryStack End-to-End Platform V1 的 Phase 0 truth inventory。它描述 authoritative source tree、目前可由程式碼驗證的 runtime 接線、engine／contract-only 模組、mocked adapter、paused work 決策、資料流、信任邊界與 rollout 限制。文件不把存在的檔案、通過的單元測試或持久化 schema 誤報為 production ready。

本次 task-start checkout：

| 項目 | 值 |
|---|---|
| Authoritative repository | `https://github.com/emily07100710/DiscoveryStack_nuxt.git` |
| Task-start `origin/main` SHA | `a7a96c68e3ec68eb6415708c9cc027d67096f4d7` |
| Expected base | `a7a96c68e3ec68eb6415708c9cc027d67096f4d7` |
| Base relationship | `origin/main` 與 expected base 精確相等，因此 expected base 是 current origin/main |
| Local integration branch | `feature/discoverystack-end-to-end-platform-v1` |
| Active GitHub CLI account | `mamamia5241888` |
| Account limitation | 附件要求 active account 為 `emily07100710`；目前 CLI account 不符。依任務限制不自行切換帳號，因此只進行本地工作，不 push。 |
| Initial worktree state | fresh clone、clean、未有未提交修改 |

## 1. Source of truth

權威順序如下：

1. 最新 authoritative `origin/main` 的 schema、migrations、server code、tests 與 runtime contracts。
2. Codex 已審核的安全修補與 fail-closed 行為。
3. server-derived canonicalization、exact hash、lineage、idempotency、atomic state transition 與 append-only event。
4. 可驗證的 provider／executor contract 與 injected mock boundary。
5. paused branch 與 patch；只有在 base、changed paths、integrity、license／provenance 及最新 contract 均通過稽核後才可 selective port。
6. 舊 branch、舊文件與僅有 UI 的宣稱。

不得 wholesale merge 舊 feature branch，不得因文件或 branch 名稱含有 READY 而直接視為完成。

## 2. Authoritative architecture

| 元件 | 責任 | 目前狀態 |
|---|---|---|
| Astro public site | 品牌、服務、FAQ、公開內容、lead capture、公開 site analysis 與 bounded public assistant；不攜帶 owner secret、cookie 或私有內容。 | 已存在 public-site application 與 public/private split contract；本 V1 不修改公開官網視覺。 |
| Nuxt owner backend | owner-only session、私人 workbench、SEO/GEO API、Content Operations、calendar、review、risk、preview/export、LLM visibility、public intelligence 與 learning governance。 | 有 pages、layouts、API 與 server modules；owner OAuth round-trip、正式 DB 與正式部署仍需環境驗證。 |
| GEOFlow service | Content Brief、Prompt/RAG、provider、base draft 與 publishing runtime 的整合來源。 | 有 GEOFlow integration contract、normalization、signing、lineage、idempotency、status machine 與可注入 mock 的 Qwen/Bailian base-draft runtime；正式 queue／provider credentials 仍未連線驗證。 |
| AutoGEO isolated worker | 對 Base Draft 做 selected-rule analyze／optimize、Markdown preservation、content safety、ruleset lineage 與 candidate fingerprint。 | 已加入 isolated Node child-process deterministic reference worker；bounded I/O、2.5s timeout、128 MB heap、shell=false、protocol／request fingerprint／rule lineage revalidation。此 fallback 明確不可進 governed_autopilot。 |
| Qwen／Bailian provider | 以 server-only credential 產生 Base Draft，保存 provider provenance、model、content hash 與 evidence binding。 | `server/geoflow-runtime/qwen.ts` 已接 strict GEOFlow contract、Bailian endpoint allowlist、opaque credential resolver、bounded JSON、retryable HTTP、source-bound safety、artifact/hash/citation lineage；credential／real provider execution 未驗證。 |
| Database／persistence | 保存 client、website、diagnosis、evidence、strategy、plan、brief、job、draft、risk、review、calendar、runs、leases、events、publication attempts、autopilot policies、outcomes、visibility 與 learning lineage。 | Drizzle schema 含 `contentOperationAutopilotPolicies`；`0017_governed_autopilot.sql` 已生成但未套用，`db:generate` 只產生過 duplicate metadata 後已清理，未執行任何 DB migrate 或 production DB write。 |
| Scheduler／queue | Materialize due entries、建立 durable runs、取得 leases、bounded retries、blocked／failed／delivered state 與事件。 | Nitro task 與 Content Operations orchestrator 已具 owner scope、lease、stage compatibility、bounded retry、persisted policy rehydration；scheduler publication 無 matching durable autopilot policy 時 fail-closed。production queue／concurrency 未做正式環境驗證。 |
| Publication executors | 依 framework／transport capability 選擇專用 executor，驗證 credential、target、identity、hash、receipt、retry 與 event。 | First-party Git／Signed API application path 已存在；另有獨立 injected multi-channel registry 覆蓋 WordPress REST、PHP/GEOFlow agent、Generic HTTP、GEOFlow Local、receipt replay 與 multisite partial failure，但尚未接入 Content Operations first-party target DB/orchestrator，未作真實 site write。 |
| Monitoring／learning | 保存 owner LLM observations、outcome、人工修訂、learning candidate 與 dataset manifest；所有資料須有 rights、consent、PII、revocation 與 lineage gate。 | LLM visibility 已有 fixed ChatGPT/Gemini/Perplexity provider API adapters 與 owner route；provider rows 僅 `secondary_only`、`verifiedByOwner:false`、`consumerSurfaceEquivalent:false`。Outcome learning 已建立 hash-only dataset review artifact，但未 training/upload/promote。 |

## 3. Current runtime inventory

### 3.1 已接入 application runtime

目前可從 Nuxt route、server service、repository 或 task 看到的 runtime 路徑包括：

- owner session、admin role、owner-only layout 與 private API guard；
- public `/api/leads` 與 `/api/site-analysis`，包含 validation、honeypot、rate limit、public target guard 與受限 CORS；
- SEO/GEO diagnosis、recommendation、strategy、production plan、brief、job、review、revision、delivery preview 與 export route；
- Content Operations client、calendar、calendar entry、materialization、replan、durable runs、leases、events、execution tick 與 outcome assessment；
- LLM Visibility project、query、manual observation、fixed server provider API observation、summary projection 與 observation repository；
- Public Intelligence source／artifact／dataset／training pipeline 的 owner-scoped CRUD 與 admission gate。

這些 runtime 路徑已具備不同程度的 server wiring，但不能統一稱為完整 end-to-end。Content Operations workspace 仍可回報 generation executor、first-party publisher 與 outcome collector 未配置；publication preview 明確是 preview-only，不能當作真實 CMS delivery。

### 3.2 Engine／contract-only 模組

以下模組提供可重用規則或安全 contract，但不單獨代表外部 runtime 已完成：

- `server/geo`：AutoGEO rules、metrics、source-bound output safety、API adapter contract 與 optimization；
- `server/geoflow-integration`：schema、normalization、HMAC/signing、nonce／idempotency、lineage 與 status machine；
- `server/geo-content-quality`：Prompt Pack、RAG contract、provider output schema、citation binding、Markdown structure、hash 與 quality gate；
- `server/geo-content-evaluation`：raw candidate、derived metrics、golden evaluation 與 regression harness；
- `server/publication-routing`：canonical routing、capability matrix、target guard、planner、receipts、projections 與 append-only events；
- `server/delivery-automation`：eligibility、idempotency、retry classification、state reducer 與 target guard；
- `server/outcome-learning`：measurement normalizer、learning candidate 與 manifest gate；
- `server/public-intelligence`：source policy、artifact lineage、dataset admission、consent／revocation 與 training boundary。

### 3.3 UI-only 或主要由 UI 觸發的能力

Nuxt owner pages 包含 `/audit-lab`、`/audit-lab/geo`、`/audit-lab/seo-geo`、`/audit-lab/content-operations`、`/audit-lab/llm-visibility`、`/leads`、`/training-pipeline` 與 `/ml-lab-preview`。它們可以呈現狀態與操作入口，但沒有因為畫面存在就自動取得 provider、database、queue 或 publication authority。

### 3.4 Mocked adapter 與 external boundary

`autogeo-api.ts`、`autogeo-bailian-qwen.ts` 與 `productionProviders.ts` 支援 server-only provider configuration；未配置 provider 時可以使用明確標記的 `reference_rules`／deterministic scaffold，僅限 test、preview、development、manual inspection 或 explicit fallback demonstration。進入 governed_autopilot production publication path 時，credential 缺失、provider unavailable、malformed response、provenance 無法驗證或 retry 耗盡都必須 blocked 或 needs_human_review。

First-party publishing 使用 injected fetch、server credential resolver、nonce provider 與 server time 供測試隔離。所有真實外部 request 在測試與 acceptance flow 中都必須使用 injected mock transport。

### 3.5 Imported vendor 與 provenance

目前 authoritative tree 有 GEOFlow integration contract、AutoGEO adapter／rules、upstream provenance 與 integrity boundary 的程式碼與文件。這些內容必須與真正的 vendor bytes、revision、license／NOTICE、worker runtime 逐一核對；在沒有完成 exact source／integrity／license 稽核前，不把 contract 或 adapter 稱作完整 imported production vendor。

## 4. Dependency map 與 API flow

主要 application flow 為：

```text
Owner
  -> Client / Website Intake
  -> Diagnosis API + SEO/GEO service
  -> AutoGEO Strategy
  -> bounded Production Plan
  -> Calendar + Cadence Engine
  -> durable Calendar Entry / Run / Lease
  -> approved Evidence Snapshot + RAG Pack
  -> GEOFlow / Qwen Base Draft
  -> AutoGEO Analyze / Optimize
  -> Quality Evaluation + Risk Gate
  -> manual_review 或 governed_autopilot policy decision
  -> Publication Routing
  -> matching Executor
  -> Receipt / Event / Retry
  -> Outcome Assessment
  -> LLM Visibility Observation
  -> Learning Candidate / Dataset Admission
```

API 與 service 的責任分層如下：

| Flow | API／入口 | Server responsibility |
|---|---|---|
| Intake | content-operations clients、publication-target route | owner auth、strict schema、framework／transport／target validation、server-derived target identity。 |
| Diagnosis | SEO/GEO diagnose route | 公開 target safe fetch、rich finding、evidence／limitation preservation；不產生排名／ROI 斷言。 |
| Strategy | recommend／strategies routes | canonical selected AutoGEO rules、rationale、strategy fingerprint 與 evidence snapshot。 |
| Plan／Calendar | production-plans、briefs、content-operations calendars | bounded deliverables、cadence、timezone、materialize、replan、duplicate prevention。 |
| Generation | generate route、content operations orchestrator | provider／reference-rule selection、draft hash、provenance、evidence binding、AutoGEO optimization、quality／risk gate。 |
| Review | reviews、revisions、delivery preview routes | owner review decision、stale draft invalidation、preview-only export、no implicit approval。 |
| Execution | calendar entry execute route、Nitro execution task | atomic durable run、lease、stage compatibility、retry、blocked／failed／delivered state。 |
| Publication | publication routing、first-party executor | target／capability／authority validation、credential resolution、request identity、response validation、receipt 與 event。 |
| Outcome／Visibility | outcomes、llm-visibility routes | 只接收 delivered identity 或 owner manual observation；保存 bounded evidence、hash、provenance 與 truthful limitations。 |
| Learning | intelligence／model-improvement routes | rights／consent／PII／quality／revocation／owner approval／lineage admission；不自動宣稱模型訓練完成。 |

## 5. Database flow

`server/database/schema.ts` 的主要資料表群如下：

| 群組 | 表格／資料責任 |
|---|---|
| Identity | `users`、`leads`，保存 owner mapping、admin role 與 lead consent。 |
| Public intelligence／learning | `publicIntelligenceSources`、`publicIntelligenceSourceReviews`、`publicIntelligenceArtifacts`、`publicIntelligenceDatasetBuilds`、`publicIntelligenceDatasetMembers`、`publicIntelligenceIngestionJobs`、`publicIntelligenceTrainingRuns`、`publicIntelligenceInferences`、model-improvement runs／candidates。 |
| SEO/GEO | `seoGeoDiagnoses`、`seoGeoEvidenceApprovals`、`seoGeoStrategyRecommendations`、`seoGeoProductionPlans`、`seoGeoProductionPlanSelections`、`seoGeoContentBriefs`、`seoGeoProductionDeliverables`、`seoGeoContentJobs`、`seoGeoContentDrafts`、`seoGeoContentRiskGates`、`seoGeoContentReviews`、`seoGeoDeliveryTargets`、`seoGeoDeliveryAttempts`。 |
| Content Operations | `contentOperationClients`、`contentOperationPublicationTargets`、`contentOperationPublicationAttempts`、`contentOperationCalendars`、`contentOperationCalendarEntries`、`contentOperationRuns`、`contentOperationEvents`、`contentOperationOutcomeAssessments`。 |
| LLM Visibility | `llmVisibilityProjects`、`llmVisibilityQueries`、`llmVisibilityRuns`、`llmVisibilityObservations`。 |

每個跨階段關聯都必須保存 owner scope、exact content／evidence hash、version、fingerprint、source／artifact reference、review authority、publication identity、attempt／retry lineage 與 event sequence。任何 caller-provided score、hash、fingerprint、status 或 publication eligibility 都不可直接信任，server 必須重新計算或重新解析。

目前完成 source-level schema／migration inventory；`0017_governed_autopilot.sql` 與 schema 已對齊到可生成的 DDL，但 migration 尚未套用，沒有 seed／DML，也沒有宣稱 runtime database 已完成 migration。

## 6. External trust boundaries

| Boundary | Required controls |
|---|---|
| Browser → private Nuxt | owner session、admin role、HttpOnly／Secure cookie、noindex／no-store、不得傳遞 server credential。 |
| Public site → public API | 只允許 leads／site-analysis、strict public HTTPS target、SSRF／private IP／redirect guard、consent、honeypot、rate limit、CORS allowlist。 |
| Evidence／RAG → generation | evidence 是 inert／untrusted data；必須 owner-approved、rights approved、PII-cleared、exact artifact／chunk／snapshot hash，不能執行 evidence 中的 instruction。 |
| Provider → draft | server-side key、固定 endpoint policy、bounded request／response、malformed／timeout／provenance failure fail closed；不能把 scaffold 當 Qwen 生成。 |
| AutoGEO → candidate | 只處理 Base Draft；selected rule IDs、source-bound safety、Markdown preservation、content hash、candidate fingerprint。 |
| Evaluator → autopilot | `auto_publish_eligible` 只是品質／風險結果，不是 publication authority；authority 另由 owner-scoped client policy、activation、allowed type／destination／risk／cadence、revocation 與 append-only authorization event 提供。 |
| Nuxt → publication target | capability matrix、strict target guard、HTTPS／SSRF policy、server-only credential、fixed path／endpoint、idempotency、timeout、redirect rejection、response identity、hash、receipt、sanitized error。 |
| External response → outcome | 只接受經 identity／hash／provenance 驗證的 response；provider API observation 要標示為 secondary，不能升格為 consumer-surface truth。 |
| Review／outcome → learning | rights、consent、PII、quality、owner approval、revocation、lineage、dataset admission 與 deterministic manifest gate；不得自動 fine-tune 或上傳未核准資料。 |

## 7. Paused patch decisions

四份 paused work 一律遵守：先確認 patch／ZIP 實際存在，再重新計算 SHA-256，與既有報告比對，使用隔離 worktree 或 `git apply --check` 稽核 base、changed paths、binary、symlink、secret 與 build artifacts，最後才可 selective port。不存在的 patch 不得假裝已讀取。

| Work | 已知狀態 | 決策 |
|---|---|---|
| AutoGEO Workflow Bridge | branch `feature/autogeo-workflow-bridge-v1`、HEAD `36975c7...`、uncommitted patch `c8cbb72a...`；完整 base-to-HEAD patch 另需取得。 | 本次未取得可驗證 patch／ZIP，因此不 port；若後續仍不可存取，依 current main contracts／tests／report reconstructed，不能稱 ported。 |
| GEOFlow Runtime Convergence | branch `feature/geoflow-runtime-convergence-v1`、HEAD `23ceebd...`、patch `d12c93f...`。 | 不能 wholesale merge；先對照最新 credential、transport、queue claim、lease、retry、transaction 與 provider contract，再 selective port。 |
| GEO Content Training Dataset | starting HEAD `62e4e675...`、patch `93e6ef73...`，基於舊 main。 | 以最新 main schema／migration 為權威，只移植仍符合 consent、rights、PII、revocation、manifest 與 split leakage prevention 的部分；不能覆蓋 journal 或新功能。 |
| LLM Visibility Bailian Adapter | starting HEAD `62e4e675...`、patch `da5e8a5b...`，涉及 Nuxt config、probe retry、runner、types、endpoint、adapter、index。 | 先對照現行 owner-only manual observation、provider limitation 與 credential contract，再 selective port；保留 `consumerSurfaceEquivalent: false`、`secondary_only` 與 `verifiedByOwner: false`。 |

目前 authoritative remote read-only 檢查顯示 GEOFlow Runtime Convergence branch 尚可見；AutoGEO、Training Dataset、LLM Visibility Bailian 三個 branch 未由 remote 回傳。這只代表 refs 的可取得性，不代表任何 patch 已通過 integrity 或可直接套用。

## 8. Superseded V1／V2 與整合原則

main 已包含 GEO Content Quality Prompt/RAG、GEO Content Evaluation Harness、Unified Publication Routing V2、hardened GEOFlow Integration Contract 與 governed Bailian/Qwen provider。後續不得再次 wholesale merge 舊 V1 branch。

發生衝突時採用：最新 main schema／migration → Codex 修補版本 → fail-closed 較強版本 → deterministic server-derived authority → exact lineage／fingerprint → paused patch → 舊 branch → 舊文件。舊測試如果期待較寬鬆行為，不能作為降低新安全邊界的理由。

## 9. Rollout limitations

目前已知限制如下：

1. GitHub CLI active account 是 `mamamia5241888`，不符合附件要求的 `emily07100710`；依不自行切換帳號規則，本地可繼續，但禁止 push，直到帳號／授權由使用者處理。
2. targeted tests、完整 typecheck 與 Nuxt production build 已在最新 checkpoint 後執行；完整 suite 為 78 個 test files 通過、3 個 skipped，仍有 3 個既存 provider-secret integration tests 因 sandbox 沒有真實 Firecrawl/Hugging Face credentials 且外部 token 驗證失敗。這些 tests 未被繞過，也未因本 task 取得或使用真實 credentials。
3. 尚未套用任何 production migration；如需 schema 變更，只能生成新的後續 migration，並在 disposable throwaway database 驗證，不能修改既有 migration、renumber、seed 或寫 production DB。
4. 未呼叫真實 Qwen／Bailian、AutoGEO、GEOFlow、GitHub Contents、WordPress、PHP Agent、Generic HTTP 或客戶網站；所有外部 boundary 都必須以 injected mock 驗證。
5. 未取得四份 paused patch 的可驗證附件；可用內容須重算 SHA-256，否則要從 current main、contracts、tests 與報告 reconstructed，不能報告為 ported。
6. Qwen runtime、AutoGEO isolated deterministic worker、多通道 executor、durable autopilot policy、provider visibility observation 與 learning dataset review wiring 已以 mocked／injected runtime 完成；多通道 executor 尚未接入 Content Operations first-party target persistence，GEOFlow queue、正式 credentials、正式 outcome collector 與 production concurrency 仍未驗證。
7. `auto_publish_eligible` 不等於 publication authority；任何 governed_autopilot 必須有 owner-scoped policy、explicit activation、policy version、allowed scope、revocation state、policy fingerprint 與 append-only authorization event。
8. deterministic scaffold／reference fallback 只能用於 tests、preview、development、manual inspection 或 explicit fallback demonstration；不能進入 governed_autopilot production publication path。
9. LLM provider API observation 只能表示 provider API 的二級觀察，不等同 ChatGPT、Gemini、Qwen、Perplexity 或其他 consumer surface 的實際答案。
10. 沒有足量、合法、乾淨且 owner-approved 的真實資料時，learning pipeline 只能停在 collection／annotation／admission／manifest／evaluation boundary，不得假裝已 fine-tune、LoRA、上傳 dataset 或建立自有模型。

## 10. Definition of Done

### Internal end-to-end ready

只有當以下 mocked evidence 齊全，才可宣稱 internal end-to-end ready：

- 一個 owner 在私人 backend 建立一個 synthetic client／synthetic website；
- 儲存 framework、target、cadence、timezone 與 owner-scoped automation policy；
- rich Diagnosis findings 產生 AutoGEO Strategy；
- Strategy 建立 bounded Production Plan 與 Calendar Entry；
- due entry 建立 durable execution run、lease 與 append-only events；
- approved evidence snapshot 建立 Content Brief／RAG pack；
- mocked Qwen provider 產生 Base Draft 並保存 truthful provenance；
- AutoGEO analyze／optimize 保留 Markdown、rule lineage 與 exact hash；
- Quality Evaluation 與 Risk Gate 由 server 重新計算並作出決策；
- manual review happy path 與 governed_autopilot happy path 都有明確 authority；
- missing credential、malformed provider、high-risk、stale evidence、PII、revocation、target disabled、duplicate、retry／replay 與 multisite partial failure 都 fail closed；
- mocked publication executor 產生經 identity／hash 驗證的 receipt；
- outcome、LLM observation 與 learning candidate 沿同一 lineage 產生並可完整回讀；
- 全部 external request 使用 injected mock transport，且報告明確區分 mocked、local、provider API observation、migration generated／applied、deploy 與 production ready。

### Ready for Codex review

Codex review 前應具備：

- 本文件與後續各 phase 的 truth inventory 更新；
- 單一 integration branch 的清楚 checkpoint commits，禁止 amend、rebase、squash、force-push；
- 每一 checkpoint 的 targeted test output、typecheck／build output 或明確 NOT RUN／BLOCKED 原因；
- schema／migration diff、foreign-key／index／existing-data compatibility 說明；
- 每份 paused patch 的 SHA-256、base、changed paths、integrity、license／provenance 與 port／reconstructed 決策；
- API flow、database flow、external trust boundary、owner isolation、autopilot policy、publication receipt 與 lineage evidence；
- 明確限制清單，且不把 internal ready 說成 production deployed。

## 11. Phase 0 exit criteria

Phase 0 inventory 已建立於本文件。正式進入 Phase 1 前，必須維持以下邊界：不修改 main、不 push main、不 deploy、不套 production migration、不呼叫真實 provider、不寫入真實客戶網站；所有後續程式變更只在 `feature/discoverystack-end-to-end-platform-v1`，並以可審查的普通 checkpoint commits 推進。

Phase 1 的第一優先是以最新 main 為基準收斂 foundations 與 paused work；任何無法驗證的 patch 都標記為 reconstructed，不得偽稱 ported。

## 12. Phase 2 foundation audit result

Phase 2 的唯讀稽核已完成。authoritative `origin/main` 仍精確為 `a7a96c68e3ec68eb6415708c9cc027d67096f4d7`；可由 remote 取得的 paused branch 只有 `feature/geoflow-runtime-convergence-v1`（`23ceebd062c9cf82ed5260f792c5190e427fa89d`），而該 commit 不是 authoritative main 的 ancestor，且其 diff 會移除 main 已有的 GEO content quality／evaluation 與 publication routing V2，因此沒有 wholesale merge。AutoGEO Workflow Bridge、GEO Content Training Dataset、LLM Visibility Bailian Adapter 的列出 branch ref 目前不存在於 remote；四份 uncommitted patch／ZIP 亦未在本次附件或 checkout 中找到，故未假裝讀取、未重算為可用 patch、未套用任何一份。

Phase 2 targeted tests 已於 Nuxt app 執行並通過：6 個 test files、1,308 個 tests 全部通過，涵蓋 GEOFlow integration contract、production provider selection、GEO content quality Prompt/RAG、GEO content evaluation harness、Unified Publication Routing V2 與 Content Operations execution orchestrator。這些結果只證明現有 contract／engine／orchestrator 的 targeted baseline，不能取代後續 runtime、provider、executor 與 end-to-end acceptance。Phase 2 未新增 migration、未呼叫真實 provider、未寫入外部目標。

Phase 2 的決策是：保留 authoritative main 已吸收的安全 contract 與 V2 implementation；對 paused GEOFlow work 只在後續對照最新 contract 後 selective port 或 reconstructed；對其餘不可存取 patch 以 current main、available contracts、tests 與報告 reconstructed；所有變更繼續只在本地 integration branch，且因 active GitHub account 不符合 `emily07100710`，禁止 push。


## 13. Phase 10–12 completion record（2026-08-26）

Phase 10 完成 owner workbench truthful UI。`pages/audit-lab/content-operations.vue` 現在顯示每個 client 的 governed autopilot policy status、expiry、allowlists、target 與可撤銷操作，並明確說明 evidence、review、quality、risk、provider、credential、lease、idempotency 與 scheduler gates 仍然適用；同一頁顯示 hash-only GEO content learning dataset 的 manifest status、eligible／blocked candidates、gate reasons、dataset digest 與 manifest fingerprint，並聲明不 training、upload 或 promotion。`pages/audit-lab/llm-visibility.vue` 現在分開顯示 provider API secondary evidence 與 owner manual primary metrics，明確標示 `secondary_only`、`verifiedByOwner=false`、`consumerSurfaceEquivalent=false`、固定 server adapter、無 credential 時 blocked，且不提供 browser credential input。相關 workbench／route／visibility suites 已通過。

Phase 11 新增 `tests/discovery-stack-e2e.acceptance.test.ts`，5 個 mocked acceptance tests 全部通過。它們涵蓋：approved evidence → mocked Qwen Base Draft → isolated AutoGEO → quality/risk → manual review → exact mocked delivery receipt → outcome／learning lineage；matching durable owner autopilot scheduler publication 與 revoke；missing Qwen credential、stale evidence、high-risk、owner scope mismatch；multi-channel retry／receipt replay／exact content hash／multisite partial failure；以及 provider API visibility 的 owner-scope gate、secondary-only persistence 與 primary metric separation。沒有任何真實 provider、customer website、GitHub、WordPress、PHP Agent、Generic HTTP 或 dataset upload 呼叫。

最新普通 checkpoint commits 如下，全部位於單一 local branch `feature/discoverystack-end-to-end-platform-v1`，沒有 amend、rebase、squash、force-push：

| Commit | 內容 |
|---|---|
| `ea96324` | AutoGEO isolated worker 與 workflow bridge |
| `b6b4ed1` | GEOFlow Qwen generation runtime |
| `792dcaf` | governed Content Operations runtime |
| `a9e875b` | multi-channel publication executor layer |
| `f2c5b52` | durable owner autopilot policy |
| `aeafa3f` | secondary visibility provider observations |
| `bd0738b` | GEO content learning dataset runtime |
| `335257e` | owner workbench governance／learning UI |
| `5e5d935` | mocked end-to-end acceptance tests |
| `3c55dad` | scheduler retry test bound to durable autopilot policy |
| `4f3cd5f` | provider visibility route contract coverage |

Phase 12 validation 結果為：`pnpm typecheck` 通過；`pnpm build` 通過並產生本地 Nuxt `.output`；build 後完整 `pnpm test` 為 78 個 test files 通過、3 個 skipped，3 個既存 provider-secret integration tests（Firecrawl／Hugging Face）因 sandbox 沒有真實 credentials 且 token 驗證失敗而未通過。這 3 個 tests 沒有被修改、繞過或以假 secret 滿足；依本任務禁止真實 credential／provider call 的規則，列為 environment-blocked，而非 V1 mocked runtime failure。Production-origin 與 private-output boundary tests 在本地 build 後通過。

Migration audit 已執行 `pnpm db:generate`。由於既有 `0017_governed_autopilot.sql` 尚未進入 Drizzle journal，工具產生了另一個等價但命名不同的 duplicate migration／snapshot；該 duplicate 與 metadata-only journal 變更已刪除／還原，沒有修改既有 migration history。保留狀態為：`0017_governed_autopilot.sql` generated = YES、applied = NO、disposable runtime database validation = NOT RUN、production migration／DB write = NOT RUN。

Public Astro site boundary audit：相對 task-start authoritative SHA 的非 `nuxt-app` diff 為空；本次未修改公開 Astro 官網的內容、視覺、layout、style、navigation 或 runtime。GitHub CLI active account 仍為 `mamamia5241888`，不是要求的 `emily07100710`，所以本次不 push。四份 paused patch／ZIP 沒有可驗證附件；本次所有相應能力以 current main contract、available tests 與 reconstructed implementation 完成，沒有任何工作被宣稱為 ported。

下列項目仍明確不是本次 internal mocked acceptance 的已完成承諾：real owner OAuth round-trip、real provider credentials／execution、GEOFlow production queue、Content Operations 與 WordPress／PHP／Generic／Local multi-channel executor 的 first-party DB/orchestrator integration、production database migration、customer-site writes、production deployment、真實 outcome collector、consumer-surface LLM UI observation、足量合法 learning data、training／fine-tuning／upload／model promotion 與 production-like concurrency／rollback validation。

## 14. Phase 12 delivery conclusion

本 branch 可主張的是：**internal mocked end-to-end platform V1 acceptance 已完成，並以 fail-closed、owner scope、exact hash／lineage、mocked external boundaries 與 truthful limitations 為前提。** 本 branch 不可主張已 production deployed、已完成正式 DB migration、已取得 provider credentials、已寫入客戶網站、已完成 consumer LLM visibility、已訓練或上傳模型。所有上述差異必須在 Codex review、正式 credentials／environment、disposable DB rehearsal 與 owner authorization 後另行處理。

### 14.1 Latest verification summary

| Check | Result | Boundary |
|---|---|---|
| Workbench targeted tests | PASS：52 tests across 5 files | owner UI contracts、content operations routes、visibility provider runtime |
| Mocked E2E acceptance | PASS：5 tests | all outbound transports injected／synthetic |
| Adversarial scheduler regression | PASS：17 tests | scheduler publication requires durable owner autopilot policy |
| Full suite after build | 78 files PASS、3 skipped；3 existing provider-secret tests blocked | no real credentials supplied |
| Nuxt typecheck | PASS | local source tree |
| Nuxt production build | PASS | local `.output` only |
| Migration generation | `0017` already present; duplicate generation audited and removed | generated only; not applied |
| Public Astro diff | PASS：no non-`nuxt-app` diff from task-start | public site untouched |
| Push／deploy／production DB／external writes | NOT RUN by policy | account and safety boundary |

本文件維持為 truth inventory；任何未在此處標為 PASS 的正式外部驗證，不得由 branch 內的 mocked tests 推論完成。

## References

本文件的主要證據為 authoritative repository 內的 source、tests、checkpoint commits 與本次 local command outputs；沒有引用外部 provider response 或 customer-site state。相關可核對檔案包括 `tests/discovery-stack-e2e.acceptance.test.ts`、`tests/content-operations-execution-adversarial.test.ts`、`tests/llm-visibility-api-contract.test.ts`、`server/geoflow-runtime/qwen.ts`、`server/geo/isolated-worker.ts`、`server/publication-routing/multi-channel-executors.ts`、`server/content-operations/autopilot-service.ts`、`server/outcome-learning/content-learning-runtime.ts` 與 `server/database/migrations/0017_governed_autopilot.sql`。

[1]: https://github.com/emily07100710/DiscoveryStack_nuxt "Authoritative DiscoveryStack repository"

[2]: https://nuxt.com/docs "Nuxt documentation"

[3]: https://orm.drizzle.team/docs/migrations "Drizzle migrations documentation"

[4]: https://vitest.dev/guide/ "Vitest guide"

[5]: https://www.rfc-editor.org/rfc/rfc9110 "HTTP Semantics"

[6]: https://www.w3.org/TR/trace-context/ "W3C Trace Context"

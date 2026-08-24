# DiscoveryStack Outcome Learning Loop Engine V1

## 定位與安全邊界

`outcome-learning-loop-engine-v1` 是純 server-side、offline、deterministic、fail-closed 的成效回收與模型學習治理核心。它只處理呼叫者提供的已發布內容 publication identity、aggregate measurement、明確 consent lineage，以及已存在的 aggregate evaluation evidence。它不連線 Google、LLM provider、網站分析、CRM、CMS、資料庫或任何外部 API；它不提交 training job、不修改 production model、不修改 production configuration，也不代表模型已訓練或已部署。

本引擎產生的是 **directional observational signal**，不是因果推論。`positive_signal`、`negative_signal`、`no_material_change` 與 `mixed_signal` 只能描述 baseline 與 follow-up aggregate measurement 的方向性差異；它們不能宣稱文章造成排名、引用、流量、轉換或 ROI 變化。

> deidentifiedSubjectKey 是由上游提供的 pseudonymous/deidentified reference，不是完全匿名識別。V1 不接收公司名稱、Email、網域或 URL 以自行 hash。

## Public API 與版本

`server/outcome-learning/index.ts` 匯出固定版本 `OUTCOME_LEARNING_ENGINE_VERSION = outcome-learning-loop-engine-v1`，以及 `normalizeOutcomeMeasurement`、`assessPublishedContentOutcome`、`buildOutcomeLearningCandidate`、`buildOutcomeDatasetManifest` 與 `evaluateModelReleaseGate`。所有 fingerprint 使用 Node `crypto` 的 SHA-256；canonical object keys、set-like arrays、UTC timestamps 與 finite numbers 都以 deterministic 規則處理。

## Publication identity

每個 outcome 必須綁定 `deidentifiedSubjectKey`、schedule entry/key、production plan、job、draft/version、`contentHash`、`evidenceSnapshotHash`、`publishedAt`、content type、language、applied rule IDs 與 topic cluster code。subject key、content hash 與 evidence snapshot hash 都必須是 64 字元 lowercase SHA-256 hex；任一 identity 或 hash 不合法時，assessment fail closed 為 `blocked`。

## Measurement contract

允許的 source 僅有四種：`google_search_console`、`llm_visibility`、`first_party_analytics` 與 `crm_aggregate`。每筆 measurement 必須具有 source、subject key、scope fingerprint、phase、window start/end、capturedAt、source hash 與固定 aggregate metrics。所有 timestamp 必須帶 `Z` 或 `±HH:MM`，輸入會 canonicalize 為 UTC ISO；`windowStart < windowEnd`，`capturedAt >= windowEnd`。

| Source | Accepted aggregate metrics | Derived metrics |
|---|---|---|
| `google_search_console` | `impressions`, `clicks`, `averagePosition` | `ctr`, `impressionsPerDay`, `clicksPerDay` |
| `llm_visibility` | `queryCount`, `mentionCount`, `citationCount` | `mentionRate`, `citationRate` |
| `first_party_analytics` | `sessions`, `engagedSessions` | `sessionsPerDay`, `engagementRate` |
| `crm_aggregate` | `qualifiedLeads`, `conversions` | `qualifiedLeadsPerDay`, `conversionRate` |

Counts 必須是非負有限整數；rate 必須落在 0–1；average position 必須是有限正數。mention/citation 不得大於 query count，engaged sessions 不得大於 sessions，conversions 不得大於 qualified leads。source hash 必須符合 normalized canonical measurement payload。raw prompt/response、raw query、raw page content、article body、customer/contact/visitor-level data 與 credential material 一律拒絕。

單次 assessment 的 policy upper bounds 集中於 `policy-catalog.ts`：最多 100 measurements、20 publication records、500 metric fields。任何超量輸入都在逐筆深度 normalization 前拒絕。

## Outcome assessment

baseline 的 window end 必須不晚於 publication time；follow-up 必須從 publication time 起算，長度至少 7 天、最多 90 天，且不可與 baseline overlap。比較時 source、deidentified subject、scope fingerprint 與 measurement window 必須可比較；不同 query set、site scope、品牌範圍或模型集合不得合併。baseline/follow-up 先轉 daily rate，再產生每個 source 的 directional observational signal。

| Status | Policy meaning |
|---|---|
| `ready` | 至少兩個合法且可比較的 measurement source pair |
| `partial` | 至少一個合法 pair，但 source 不足兩個 |
| `insufficient_data` | 沒有合法 baseline/follow-up pair |
| `blocked` | identity/hash/window/source/subject/scope/duplicate 或 input contract 失敗 |

固定 limitations 至少包含 `observational_not_causal`、`platform_measurement_may_change`、`attribution_not_established` 與 `external_factors_not_controlled`。V1 不產生 truth score、GEO score、ROI score 或 causal lift。

## Learning candidate governance

只有在 `consentStatus === granted`、consent version 與 consentedAt 完整、allowed uses 明確包含 `model_improvement`、consent 未撤回、rights confirmed、assessment 為 `ready` 或 `partial`、存在合法 pair、PII scan 為 `none_detected` 且 data contract version 完整時，才會建立 eligible learning candidate。其餘狀況一律 `blocked`。

Eligible candidate 只保存 deidentified subject reference、publication identity hashes、content type、language、normalized applied rule IDs、topic cluster code、aggregate numeric features、directional labels、source hashes、policy/engine versions、consent lineage、data contract version、limitations 與 candidate fingerprint。runtime 會遞迴拒絕大小寫或 snake/camel 變體的 forbidden keys，並不依賴 TypeScript type 來提供安全性。

## Dataset manifest

`buildOutcomeDatasetManifest` 只接收 eligible candidates。candidate fingerprint 必須唯一，publication identity lineage 不得重複，consent 不得 revoked，source hash lineage 必須完整，候選會依 fingerprint 與 lineage 進行 stable ordering。train/validation/test split 使用 fingerprint-derived deterministic bucket，比例為 80%/10%/10%，不使用 random 或現在時間；相同 publication lineage 不會跨 split。

| Admission requirement | V1 fixed minimum |
|---|---:|
| Eligible candidates | 150 |
| `article` candidates | 20 |
| `faq` candidates | 20 |
| `service_page` candidates | 20 |
| `zh-hant` candidates | 20 |
| `en` candidates | 20 |
| Measurement source combinations | 2 |

不足時只回 `gate_blocked`；達標時只回 `ready_for_dataset_review`。這是 dataset governance gate，不是模型品質證明、因果效果證明或 training completion。V1 不呼叫 training provider。

## Model release gate

`evaluateModelReleaseGate` 只評估已存在的 aggregate evaluation evidence。輸入需包含 baseline/candidate model artifact hash、dataset manifest hash、evaluation contract version、case count、baseline/candidate factual error、blocked-content escape、citation readiness、task quality、shadow/canary status、rollback availability、safety incidents 與 evaluatedAt。

固定決策為 `gate_blocked`、`shadow_ready`、`canary_ready` 與 `promotion_ready`。最少 evaluation cases 為 100；candidate factual error 與 blocked-content escape 不得高於 baseline，citation readiness 不得下降，task quality 必須至少改善 0.01，safety incidents 必須為 0，shadow/canary 必須 passed，rollback artifact 必須可用。`promotion_ready` 只代表 evidence gate 通過，**不等於 deployed**，也不會修改 production configuration。

## Determinism 與 privacy constraints

Canonical fingerprint 會排序 object keys、normalize 去重排序 set-like arrays、canonicalize timestamps、拒絕 undefined 與非有限數字，並使用 locale-independent ordering。assessment、candidate、manifest 與 release fingerprint 都會隨其 hash lineage 或 aggregate evidence 改變而改變。所有 fixtures 僅使用 synthetic metadata；V1 沒有 real provider/API/DB integration。

## V1 limitations

V1 只建立 outcome assessment、learning candidate、dataset admission 與 model release evidence governance core。它不擷取來源全文、不驗證內容真偽、不做因果推論、不進行 attribution、不搜尋文獻、不執行訓練、不部署模型，也不接入真實 GSC、LLM visibility、first-party analytics 或 CRM data source。Production admission 仍需後續人工 review 與更完整的資料治理、法務、品質與安全流程。

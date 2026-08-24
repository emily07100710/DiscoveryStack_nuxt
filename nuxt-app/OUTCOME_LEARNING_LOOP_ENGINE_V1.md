# DiscoveryStack Outcome Learning Loop Engine V1

## 定位與安全邊界

`outcome-learning-loop-engine-v1` 是純 server-side、offline、deterministic、fail-closed 的成效回收與模型學習治理核心。它只處理呼叫者提供的已發布內容 publication identity、aggregate measurement、明確 consent lineage，以及已存在的 aggregate evaluation evidence。它不連線 Google、LLM provider、網站分析、CRM、CMS、資料庫或任何外部 API；它不提交 training job、不修改 production model、不修改 production configuration，也不代表模型已訓練或已部署。

本引擎產生的是 **directional observational signal**，不是因果推論。`positive_signal`、`negative_signal`、`no_material_change` 與 `mixed_signal` 只能描述 baseline 與 follow-up aggregate measurement 的方向性差異；它們不能宣稱文章造成排名、引用、流量、轉換或 ROI 變化。

> deidentifiedSubjectKey 是由上游提供的 pseudonymous/deidentified reference，不是完全匿名識別。V1 不接收公司名稱、Email、網域或 URL 以自行 hash。

## Public API 與固定版本

`server/outcome-learning/index.ts` 匯出固定版本 `OUTCOME_LEARNING_ENGINE_VERSION = outcome-learning-loop-engine-v1`，以及 `OUTCOME_DATA_CONTRACT_VERSION = outcome-contract-v1` 與 `OUTCOME_EVALUATION_CONTRACT_VERSION = evaluation-contract-v1`。Assessment、candidate 與 candidate fingerprint 必須使用固定 data contract；model release gate 必須使用固定 evaluation contract。`latest`、`v2`、空白、undefined、null 或其他任意字串都會 fail closed。

Public API 包含 `normalizeOutcomeMeasurement`、`assessPublishedContentOutcome`、`buildOutcomeLearningCandidate`、`buildOutcomeDatasetManifest` 與 `evaluateModelReleaseGate`。所有 fingerprint 使用 Node `crypto` 的 SHA-256；canonical object keys、set-like arrays、UTC timestamps 與 finite numbers 都以 deterministic 規則處理。

## Publication identity 與 value boundary

每個 outcome 必須綁定 `deidentifiedSubjectKey`、schedule entry/key、production plan、job、draft/version、`contentHash`、`evidenceSnapshotHash`、`publishedAt`、content type、language、applied rule IDs 與 topic cluster code。subject key、content hash 與 evidence snapshot hash 都必須是 64 字元 lowercase SHA-256 hex；任一 identity 或 hash 不合法時，assessment fail closed 為 `blocked`。

呼叫者提供的 `topicClusterCode`、`appliedRuleIds`、`consentVersion`、schedule/draft/job identifiers 都先經 `normalizeOutcomeReferenceIdentifier()`：NFKC、trim 後長度 1–256，且只允許 `A-Z a-z 0-9 . _ : | -`；不允許空格、`@`、斜線、query／fragment／URL、括號、引號、control characters、malformed Unicode 或明顯電話序列。Email-like value 即使藏在較長文字內也會 blocked。`topicClusterCode` 與 `appliedRuleIds` 通過 validator 後才以 domain-separated hash 保存：`outcomeSha256({ kind: 'topic_cluster', value })` 與 `outcomeSha256({ kind: 'applied_rule', value })`。即使最後會 hash，偵測到 PII-like value 時不會先 hash 再放行。

SHA/pseudonymous reference 不等於匿名資料；系統只能治理明確的結構化欄位，不宣稱能從任意文字可靠辨認所有人名，也不宣稱 forbidden-key scanner 能證明資料沒有 PII。Production admission 仍需可信的上游 PII scanner 與人工治理。

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

Assessment input 的 `dataContractVersion` 必須精確等於 `outcome-contract-v1`；assessment output 保存 canonical contract，且 contract version 會納入 assessment fingerprint。因此 valid contract 與 attacker contract 會產生不同 fingerprint，attacker contract 會 blocked。

baseline 的 window end 必須不晚於 publication time；follow-up 必須從 publication time 起算，長度至少 7 天、最多 90 天，且不可與 baseline overlap。比較時 source、deidentified subject、scope fingerprint 與 measurement window 必須可比較；不同 query set、site scope、品牌範圍或模型集合不得合併。baseline/follow-up 先轉 daily rate，再產生每個 source 的 directional observational signal。

| Status | Policy meaning |
|---|---|
| `ready` | 至少兩個合法且可比較的 measurement source pair |
| `partial` | 至少一個合法 pair，但 source 不足兩個 |
| `insufficient_data` | 沒有合法 baseline/follow-up pair |
| `blocked` | identity/hash/window/source/subject/scope/duplicate 或 input contract 失敗 |

固定 limitations 至少包含 `observational_not_causal`、`platform_measurement_may_change`、`attribution_not_established` 與 `external_factors_not_controlled`。V1 不產生 truth score、GEO score、ROI score 或 causal lift。

## Learning candidate governance

`buildOutcomeLearningCandidate` 必須收到 supplied `assessment`；undefined、null、primitive、malformed object、missing assessmentFingerprint 或 fingerprint mismatch 都會 blocked，不會在缺少 supplied assessment 時靜默重建並繼續建立 eligible candidate。`outcomeRequest.dataContractVersion`、`assessment.dataContractVersion` 與 candidate input `dataContractVersion` 三者都必須精確等於 `outcome-contract-v1` 且彼此一致；candidate fingerprint 也包含固定 contract。

只有在 `consentStatus === granted`、consent version 與 consentedAt 完整、allowed uses 明確包含 `model_improvement`、consent 未撤回、rights confirmed、assessment 為 `ready` 或 `partial`、存在合法 pair、PII scan 為 `none_detected` 且 data contract version 完整時，才會建立 eligible learning candidate。其餘狀況一律 `blocked`。

Eligible candidate 只保存 deidentified subject reference、publication identity hashes、content type、language、`appliedRuleHashes`、`topicClusterHash`、aggregate numeric features、directional labels、source hashes、policy/engine versions、consent lineage、固定 data contract、limitations 與 candidate fingerprint。runtime 會遞迴拒絕大小寫或 snake/camel 變體的 forbidden keys，並執行 value-level validation；不依賴 TypeScript type 來提供安全性。

## Dataset manifest envelope 與 candidate revalidation

`buildOutcomeDatasetManifest` 的 top-level envelope 必須是 object shape，且只能有一個 enumerable string key：`candidates`。missing key、extra key、symbol key、singular `candidate`、null、array、primitive、Object.keys exception 與 candidates getter exception 都回 `gate_blocked` 與 `INVALID_MANIFEST_SHAPE`；它不以 `{ ...input, candidates: [] }` 作為主要 shape validation。

完成 exact envelope validation 後才讀取 candidates；它必須是 array。上限為 `OUTCOME_MAX_DATASET_CANDIDATES = 10000`，超過時在 sort、hash 或讀取 nested candidate fields 前立即回 `gate_blocked` 與 `TOO_MANY_DATASET_CANDIDATES`。

每個 raw candidate 都會經過 `normalizeOutcomeLearningCandidate` 的 exact-shape runtime validation，不再直接 cast 成 `OutcomeLearningCandidate`。Validator 會拒絕未知 extra keys，驗證 fixed enums、bounded finite features、consent、rights、policy/engine/data contract、精確 lowercase 64-hex hash lineage、source/label 一致性與 canonical limitations；排除 candidateFingerprint 後重新建立 canonical body，計算 expected fingerprint，不一致即回 `CANDIDATE_FINGERPRINT_MISMATCH` 並阻擋 manifest。前後空白、uppercase、newline、tab、`0x` prefix、wrong length 或 Unicode lookalike hash 不會被 trim/lowercase 靜默修正；可辨認的非 canonical hash 會回 `NON_CANONICAL_HASH`。rights、consent、allowed uses、contract、policy、engine、enum、hash、features 或 publication lineage 的 tampering 都不能保留舊 fingerprint 通過。

`aggregateNumericFeatures` 使用 source-specific `OUTCOME_FEATURE_FIELDS[source]` 與固定 phase `baseline`／`follow_up`／`delta` 驗證。其 key set 必須精確等於每個 `measurementSources` 的 catalog fields × 三個 phases；不得有 missing、extra、wrong source、wrong field 或 wrong phase。Feature source set、directional label source set 與 `measurementSources` set 必須完全相等；每個 source 必須有兩個 measurement source hashes，且 `sourceHashes.length === measurementSources.length * 2`。這些 semantic checks 獨立於 candidate fingerprint。

Admission 後先以 lineage 與 candidateFingerprint 建立 deterministic stable score，再以 score 與 fingerprint tie-break sorting。Split ratios 使用固定 `OUTCOME_SPLIT_TRAIN_RATIO`、`OUTCOME_SPLIT_VALIDATION_RATIO`、`OUTCOME_SPLIT_TEST_RATIO`，並驗證總和為 1；對 N 筆候選使用 floor(0.8N)、floor(0.1N)、N 減前兩者。150 筆精確得到 train 120、validation 15、test 15；arrays 無交集且 union 等於 candidate set。不使用 random、現在時間、locale-dependent sort 或 object insertion order。

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

`evaluateModelReleaseGate` 只評估已存在的 aggregate evaluation evidence，且先做 exact-shape runtime normalization。未知 extra keys、missing keys、非固定 evaluation contract、非 canonical hash、baseline/candidate model artifact hash 相同、metric extra/missing/non-finite/string number、unsafe case count 或 invalid safety incidents 都會 blocked。`evaluationContractVersion` 必須精確等於 `evaluation-contract-v1`；release fingerprint 只根據 normalized canonical request 產生，不直接 hash raw input。

輸入需包含 baseline/candidate model artifact hash、dataset manifest hash、evaluation contract version、case count、baseline/candidate factual error、blocked-content escape、citation readiness、task quality、shadow/canary status、rollback availability、safety incidents 與 evaluatedAt。metrics 必須且只能有四個固定 keys，case count 為 safe integer 且介於 100 與 1,000,000，safety incidents 為 safe non-negative integer。shadow pending 時 canary 不得 passed；shadow/canary failed 一律 blocked；只有 shadow passed 且 canary passed、沒有品質 regression、rollback artifact 可用且 safety incidents 為 0，才能 `promotion_ready`。

固定決策為 `gate_blocked`、`shadow_ready`、`canary_ready` 與 `promotion_ready`。`promotion_ready` 只代表 evidence gate 通過，**不等於 deployed**，也不會修改 production configuration。

## Determinism 與 privacy constraints

所有 hash 欄位都只接受精確 canonical lowercase SHA-256：`typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)`；runtime 不在 hash validator 內 trim，也不把 non-canonical hash 靜默 lower/trim 後保存。此規則套用於 subject/scope/content/evidence/source hashes、publication/rule/topic/candidate/assessment/manifest/release fingerprints，以及 model/dataset artifact hashes。`NON_CANONICAL_HASH` 與 `INVALID_HASH` 保留明確區分。

Canonical fingerprint 會排序 object keys、normalize 去重排序 set-like arrays、canonicalize timestamps、拒絕 undefined 與非有限數字，並使用 locale-independent ordering。assessment、candidate、manifest 與 release fingerprint 都會隨其 hash lineage 或 aggregate evidence 改變而改變。所有 fixtures 僅使用 synthetic metadata；V1 沒有 real provider/API/DB integration。

`candidateFingerprint` 是 deterministic canonical checksum。它不是 signature、MAC、authorization proof，也不是 builder provenance proof；呼叫者可以自行重新計算 SHA。因此 runtime semantic validation 必須獨立檢查 feature/source schema、consent、contract、enums、hashes、lineage 與 exact keys，不能把 fingerprint 相符單獨描述成可信來源證明。

Value-level validation 只能治理明確的結構化欄位；SHA/pseudonymous reference 不等於匿名資料。系統不宣稱能從任意文字可靠辨認所有人名，forbidden-key scanner 也不能單獨證明沒有 PII；production admission 仍需可信上游 PII scanner 與人工治理。

## V1 limitations

V1 只建立 outcome assessment、learning candidate、dataset admission 與 model release evidence governance core。它不擷取來源全文、不驗證內容真偽、不做因果推論、不進行 attribution、不搜尋文獻、不執行訓練、不部署模型，也不接入真實 GSC、LLM visibility、first-party analytics 或 CRM data source。Production admission 仍需後續人工 review 與更完整的資料治理、法務、品質與安全流程。

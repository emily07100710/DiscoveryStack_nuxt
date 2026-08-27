# DiscoveryStack SEO/GEO v5-1087 AI Handoff

**狀態：** 已完成私有 1,087-row manifest、治理驗證、owner-only Drive snapshot、output-free Colab recovery Notebook 與 CPU one-batch smoke；v5 bounded fast path 已因 CPU 首批 forward 過慢而安全中斷。**目前沒有 v5 checkpoint、test metrics、prediction files 或 model artifact。** v4-500 與 v4 artifact 是 frozen、獨立且未被覆寫的基準。

> **重要限制：** v5 是 development-only candidate，不是 production dataset 或 production model。新增資料仍需要逐頁 rights review 與 stageEvidence 人工 adjudication；`public_access_only_pending_human_review` 不等同於已核准授權。

## 1. 資料來源與收集

v5 的 frozen base 為已保存的 v4-500，另新增 587 筆官方公開文件衍生資料。新增來源族群為 web.dev 250、Google Developers 137 與 MDN 200；合併 base 後的 source-family counts 為 web.dev 500、Google Search Central 250、Google Developers 137、MDN 200。Chrome sitemap shard 因連線逾時未納入本批；W3C 未被當作通用衍生來源。

來源研究先檢查 robots／sitemap 與官方授權政策，再以隔離 recovery collector 建立 candidate records。collector 使用本地 sitemap cache、robots gate、頁面或 policy-level rights gate、canonical／near-duplicate 去重、來源 cap 與 exact split allocation。流程禁止 synthetic rows、同頁切片與 language-query variants 作為不同樣本。MDN 的靜態頁面不一定包含頁尾授權資訊，因此本批只記錄 policy-level public access，必須在 production 前完成 page-level human rights review。

## 2. 清洗、去重與治理欄位

每筆資料保留穩定整數 `id`、`canonicalDomainHash`、`nearDuplicateCluster`、`sourceFamily`、`split`、`trainingText`、`contentType` 與 `language`。清洗階段使用 canonical／near-duplicate identity、PII 檢查、robots 結果、source card reference 與 rights status；原始 HTML、瀏覽器資料、OAuth material 與 source cards 不進 Git 或模型 artifact。

治理欄位包括 `sourceCardId`、`rightsStatus`、`robotsChecked`、`piiStatus` 與 `dedupeStatus`。v5 row contract 位於 `ml/schemas/dataset-v5-1087.schema.json`，它刻意獨立於 v4 schema，接受 `approved` 與 `public_access_only_pending_human_review`，並允許存在 `licensePolicy`。這個 schema delta 不應被解讀為 v4 schema 的無條件相容。

| 治理／審核項目 | v5 aggregate |
|---|---:|
| `developmentOnly` | `true` |
| `rightsReviewPending` | `true` |
| `humanAdjudicationRequiredBeforeProduction` | `true` |
| `reviewed` | 250 |
| `needs_adjudication` | 837 |
| `rightsStatus=approved` | 500 |
| `rightsStatus=public_access_only_pending_human_review` | 587 |
| robots checked false | 0 |
| PII 非 `none_detected`／`masked` | 0 |

## 3. 標籤與 Y

模型任務共有九個。`journeyStage` 與 `actionPriority` 是 single-label targets；其餘 `searchIntents`、`contentTypes`、`audienceRoles`、`geoSignals`、`citationReadiness`、`technicalSeoSignals` 與 `frictionSignals` 是 multi-label targets。`stageEvidence`、`secondaryStages`、`stageCueTypes`、source split、rights flags 與 post-outcome 欄位屬於治理或 provenance，不得作為模型輸入。

`journeyStage` 的固定 vocab 為 `discovery`、`understanding`、`response`、`progression`、`conversion`；總數分別為 232、112、188、247、308。`actionPriority` vocab 為 `critical`、`high`、`medium`、`monitor`。其他 task 的完整 label vocab 以 v5 aggregate inventory 與 row schema 為準；訓練時應從 training contract 產生 deterministic label maps，不能以 test rows 重新推導或調整。

## 4. X 與 inference-safe features

文字輸入 `X_text` 是每筆清理後的 `trainingText`，使用 `distilbert-base-multilingual-cased` tokenizer、`max_length=256`、truncation 與 max padding。共享 encoder 產生 pooled text representation。只有 `journeyStage` head 連接額外的 `stageCueVector` branch；其他八個 heads 使用文字 representation。

目前實作實際使用 14 維、可在 inference 重建的 text cues：`problem_statement_count`、`question_heading_count`、`definition_cue_count`、`how_it_works_cue_count`、`comparison_cue_count`、`requirements_cue_count`、`troubleshooting_cue_count`、`error_debug_cue_count`、`remediation_cue_count`、`cta_count`、`contact_purchase_cue_count`、`form_presence`、`text_length_log` 與 `heading_count_log`。feature normalization 僅在 train split fit mean／std，然後 freeze 到 validation、test 與 inference。不得使用 target、stageEvidence、secondaryStages、stageCueTypes、source／split labels 或 test metrics 產生 feature。

## 5. Split 與 digest

| split／項目 | 值 |
|---|---:|
| train | 761 |
| validation | 163 |
| `test_legacy_v1` | 32 |
| `test_v2` | 131 |
| total | 1,087 |
| manifest hash | `08931b3827f37d9254c9d8d0555aa635babc26d6c94c218bac523cc4a86f2003` |
| dataset digest | `c787aad7f775a3f4db705c171b22f968bd1fff09b3ee3ee7e99557afccea60a6` |
| dataset bytes | 2,168,710 |

`test_legacy_v1` 是 v4 的固定回歸集，不可覆寫；`test_v2` 是新增的 v5 test，直到 validation 選模完成前不可讀取其 metrics。訓練 class weights 必須只由 train split 的 `journeyStage` counts 計算；不能用全資料集或 test distribution 調參。

## 6. 模型與訓練計畫

正式比較目標是 `text_only_baseline` 與 `stage_branch_weighted`，seeds 為 20260820、20260821、20260822。基準 optimizer 為 AdamW、learning rate `2e-5`、weight decay `0.01`、batch size `8`、max epochs `8`、gradient clipping `1.0`；stage loss multiplier 為 `2.0`，class weight 使用 train-only sqrt inverse-frequency。以 validation `journeyStage` macro-F1 唯一主選模指標，搭配 patience 2 early stopping；不可用 test_v2 反覆調參。

bounded fast path 只用於快速驗證執行環境，設定為 `stage_branch_weighted`、seed `20260820`、最多 2 epochs，**不等同**完整 2-config × 3-seed ablation。建議在新的可用 GPU runtime 先重跑 R2 Notebook 的 setup、private load、validator、feature、tokenizer、model、smoke，再開始 fast path；只有取得 checkpoint 與 validation metrics 才能評估兩個 test split。

## 7. 已完成的可稽核執行證據

R2 Colab CPU runtime 已完成 owner-private Drive load，並輸出 `validated=True`、rows 1,087、splits 761／163／32／131、stage counts 與 v5 governance gate。14 維 feature build 與 tokenizer／dataset 建立成功；one-batch smoke 實際輸出 device=cpu、batch size 8、sequence length 256、featureDim 14、`lossFinite=True`。

CPU bounded fast path 實際輸出 `run_start`、`stage_branch_weighted`、seed 20260820 與 `epoch_start` epoch 1，但首個 training batch 長時間未完成，最後在約 3 分 36 秒安全中斷並得到 `KeyboardInterrupt`。因此不能把這次執行當作 metrics、checkpoint 或 readiness 結果，也沒有執行任何 test evaluation。

## 8. 評估、readiness 與 artifact gate

取得 checkpoint 後，只能先以 validation selection 選定模型，再一次評估 `test_v2` 與一次評估 `test_legacy_v1`。應保存每個 task 的 macro／micro F1、per-class precision／recall／F1、support、confusion matrix、predicted support 與 zero-prediction check。任何 `test_v2` journeyStage class 的 predicted support 為 0，readiness 必須是 `candidate_not_ready`；這不因其他 task 或 validation 結果而取消。

artifact 只允許包含 checkpoint／model state、tokenizer、training config、label maps、train-fitted feature statistics、metrics、private prediction JSONL、artifact manifest 與 checksums。`containsRawDataset` 與 `containsHtml` 必須為 false；不得包含 raw JSONL、HTML、source cards、browser captures、OAuth、tokens、`.env` 或 secrets。v5 目前**尚未到 artifact gate**。

## 9. 下一個 AI 的執行清單

第一，使用 owner-only Drive 的 v5 snapshot 與 output-free CPU fallback R2 Notebook；不要打開或修改 v4 Notebook。第二，在可用 GPU runtime 執行 sequential cells，不要 Run All；先保存 validator、smoke 與 runtime evidence。第三，先執行 bounded fast path，確認取得 checkpoint 與 validation macro-F1；若 GPU 不可用，應停止並保留 handoff，不要用 CPU 假裝完成正式訓練。第四，只有 selection 完成後才評估兩個 test split與建立 artifact。第五，更新 v5 private state／safe results，並只提交本 handoff、v5 schema、runbook、output-free generators/checkers；不要提交 raw data 或 executed Notebook。

## 10. Second-layer `frictionReasonSignals` handoff

第二層使用獨立 private derivative，不覆寫 parent v5-1087，也不涉及 frozen v4-500。candidate derivative 保留相同 1,087 IDs 與 split，derived manifestHash=`f85409be384a1eea7936d52137ccf0baa816962b8e47347cce1b72c691bfbb2d`、derived datasetDigest=`8fe1c25e6e70ef47ce938ff83cf566f05b793033ad88b566e15b9a5a7aaf5c8b`。目前 candidate support 僅是 service_clarity_gap 23、trust_gap 254、proof_or_case_gap 2、cta_clarity_gap 237；其餘八個 labels 為 0，且所有 candidate／non-hit 狀態仍屬 `unknown`，不是人工確證 labels。

v5.1 script 已修正為 per-row tri-state masked BCE：明確 `present` 只產生 target=1、mask=1；明確 `absent` 只產生 target=0、mask=1；`candidate_present`、`unreviewed`、`unknown` 全部 mask=0。eligibility gate 目前要求每個 label 至少有 train present 5、train absent 5、validation present 2、validation absent 2；缺一即停止，且停止發生在 Transformers/model 初始化前。validator 本地已確認 parent immutability、ID／split、derivative hash 與 candidate structure；本地執行的 gate report 也確認 12 個 labels 全部缺 explicit positives／negatives，因此沒有模型、checkpoint、metrics 或 artifact 可宣稱。

Annotation contract 與 adjudication workflow 位於 private workspace 的 `v5_1_friction_reasons_work/friction_reason_annotation_contract.json`、`FRICTION_REASON_ADJUDICATION_WORKFLOW.md`、`friction_reason_annotation_queue_v5_1.jsonl`。人工 review 必須按 label 定義提供 evidence；booking、mobile、speed、booking/checkout/form 類 labels 需要實際 measurement 或 interaction evidence，不能由文字猜測；`search_intent_mismatch` 需要明確 query context。人工完成後建立新的 v5.2 adjudicated derivative，保留 parent linkage 與 split，重新做 schema/hash/eligibility validation，再於 private Kaggle T4 x2 notebook 執行 sequential preflight、smoke、bounded fast path、validation selection；在此之前不得執行或宣稱第二層 supervised training。

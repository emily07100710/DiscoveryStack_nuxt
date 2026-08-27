# DiscoveryStack SEO/GEO v4-500：AI 接手文件

**文件用途：** 本文件提供下一個 AI 或工程執行者在不接觸 Git 私有資料、不恢復 1,087 筆收集方向的前提下，接手既有 500 筆 SEO/GEO 多任務訓練工作的完整說明。

> **截至 2026-08-27 的真實狀態：** 500 筆資料集、私有 Drive snapshot 與原始 optimized Colab Notebook 已保存並通過資料驗證；500 筆模型訓練尚未完成。沒有可信的 500 筆 checkpoint、epoch metrics、final test evaluation、artifact ZIP 或 Drive artifact upload。本文件刻意不填寫虛構的模型分數。

## 1. 目標與範圍

原始目標是將 DiscoveryStack 既有 250 筆 SEO/GEO 多任務資料擴充到 500 筆，並改善先前 `journeyStage` test micro-F1 `0.1250` 的低表現。已完成的資料版本是 **manifest-v4-500**：保留原有 250 筆 Google Search Central legacy 資料，新增 250 筆由 web.dev 公開文件清理後衍生的開發樣本。後續曾嘗試擴充至約 1,087 筆，但因來源與 stage 配額不足而安全停止；使用者已明確放棄該方向。不得恢復收集，也不得覆寫或重新命名 v4-500。

這個 v4-500 不是 production-ready dataset。新增的 250 筆中有 250 筆 `needs_adjudication`，在 production 前必須由人工作業完成 `stageEvidence` adjudication。模型若日後訓練成功，最多只能標記為 development candidate 或 `candidate_ready_for_review`，不代表可直接部署。

## 2. 已保存的資料與摘要

唯一的私有 500-row manifest 位於本機 `/home/ubuntu/private_training/discoverystack-manifest-v4-500.jsonl`，且另有 owner-only Google Drive snapshot。原始 JSONL 不得複製到專案 Git、公開 artifact、對話附件或網站。Drive snapshot 的檔名是 `discoverystack-manifest-v4-500-private.jsonl`，Drive file ID 是 `1i2N36qNgHOmx1PM7-DZV-R02wq73t3SV`；先前查詢確認為 owner-only。

資料摘要如下。這些數字來自不含原文的私有統計檔 `/home/ubuntu/private_training/handoff_inventory_500.json`。

| 項目 | 已確認值 |
|---|---:|
| rows | 500 |
| manifest hash | `d1868ebd13ebf5b489e551afba2c047c19af5022e83c101e23a9927beaf02977` |
| dataset digest | `6aaf9e6c57f4d930ba220575bc1a5f7cb0ba6145373e7a8b629f89403c85c474` |
| split | train 350 / validation 75 / test_legacy_v1 32 / test_v2 43 |
| source families | google_search_central 250 / web_dev 250 |
| review state | reviewed 250 / needs_adjudication 250 |
| rights status | approved 500 |
| robots checked | true 500 |
| PII status | none_detected 500 |
| journeyStage | conversion 83 / discovery 89 / progression 117 / response 118 / understanding 93 |

資料的 source notes 位於本機私有檔案 `/home/ubuntu/private_training/500_source_notes.md`。其中記錄 web.dev 的 robots、sitemap 與授權依據；Google Developers site policies 也有相關授權提醒。該摘要可以供研究與治理追溯使用，但不應把每筆 evidence locator 或 raw page content 寫入 Git。

## 3. 資料來源與收集方式

### 3.1 Google Search Central legacy 250 筆

第一組 250 筆是既有的 Google Search Central legacy 資料，保留作為與前版資料及 `test_legacy_v1` 的回歸基準。其來源與建集脈絡由 `/home/ubuntu/private_training/build_dataset_v4_500.py`、`build_dataset_v4_500_fast.py` 及 `500_source_notes.md` 保存。這些腳本是可追溯來源，不是讓新執行者在未審核情況下重建或修改固定 manifest 的授權。

### 3.2 web.dev 公開文件 250 筆

第二組 250 筆來自 web.dev 公開文件的清理後衍生樣本。收集時以公開頁面、robots 與 sitemap 為入口，逐頁保留來源證據，再把可供模型使用的內容整理成 `trainingText`。web.dev 頁面通常提供 Creative Commons Attribution 4.0 的內容授權說明，但 Google 商標、部分媒體與外部連結仍可能有額外限制；因此每筆資料仍要經過 rights、robots、PII、去重及 stage review 檢查。新來源不得只把同一頁的語言版本或切片當成多筆獨立樣本。

### 3.3 不得恢復的 1,087 筆方向

先前的 v5/約 1,087 筆收集因來源和 journey stage 配額不足多次安全停止，最終沒有取代 v4-500，也不應再執行。所有後續工作只針對上述固定 500 rows。

## 4. 清洗、治理與資料契約

每一列的 schema 定義在 `ml/schemas/dataset-v4-500.schema.json`。基本欄位包括 `id`、`manifestHash`、`split`、`trainingText`、`targets`、`stageEvidence`、`labelConfidence`、`labelMethod`、`reviewState`、`taxonomyVersion` 與 `featureContractVersion`；治理欄位包括 `sourceFamily`、`canonicalDomainHash`、`nearDuplicateCluster`、`contentType`、`language` 及 `governance`。

`governance` 必須保存 `sourceCardId`、`rightsStatus`、`robotsChecked`、`piiStatus` 與 `dedupeStatus`。目前已確認 500 rows 的 rights status 為 `approved`、robots checked 全部為 true、PII status 全部為 `none_detected`。這些是資料治理摘要，不代表可以在 Git 暴露原始 evidence 或 source text。

清洗與建集時應遵守以下流程：先從已核准的公開來源抓取頁面與 robots／授權證據；抽取可用正文和結構化資訊；移除 HTML boilerplate、導航重複、script/style、明顯重複段落與可識別個資；建立 deterministic `trainingText`；計算內容 hash、canonical domain hash 與 near-duplicate cluster；再依 taxonomy 產生 targets 與 `stageEvidence`；最後執行 rights、robots、PII、dedupe、label review、split isolation 和 digest 驗證。不得先分割再用 split 結果修正標籤，也不得用 target、evidence 或測試結果製作模型特徵。

現有驗證器是 `/home/ubuntu/private_training/validate_v4_500.py`。Notebook 的 fail-closed 驗證應保持 500 rows、唯一 id、固定 manifest hash、固定 dataset digest、固定 split counts、五類 journeyStage 都至少 80、每列有 stage evidence，以及 review/governance 欄位符合約束。資料若失敗，應停止而不是以手動更改 expected 數字繞過。

## 5. 標籤、Y 與任務型態

模型有九項任務。`journeyStage` 與 `actionPriority` 是 single-label classification；其餘七項是 multi-label classification。完整 label values 已安全寫入 `/home/ubuntu/private_training/handoff_inventory_500.json`，此檔不含樣本文本。

| 任務 | 類型 | 目前 label vocabulary |
|---|---|---|
| `journeyStage` | single-label | `discovery`, `understanding`, `response`, `progression`, `conversion` |
| `searchIntents` | multi-label | `commercial`, `informational`, `navigational`, `transactional` |
| `contentTypes` | multi-label | `comparison`, `editorial`, `faq`, `home`, `other`, `pricing`, `product`, `service`, `tool` |
| `audienceRoles` | multi-label | `buyer`, `decision_maker`, `existing_customer`, `local_visitor`, `media_or_partner`, `practitioner`, `researcher`, `technical_evaluator` |
| `geoSignals` | multi-label | `city_or_local`, `country`, `global`, `multilingual`, `not_applicable`, `region` |
| `citationReadiness` | multi-label | `contact_or_location`, `dated_or_current`, `first_party_expertise`, `insufficient_evidence`, `named_author_or_owner`, `source_links`, `structured_data` |
| `technicalSeoSignals` | multi-label | `canonical_present`, `h1_present`, `indexable`, `internal_routing`, `language_signal`, `performance_not_observed`, `structured_data`, `title_present` |
| `frictionSignals` | multi-label | `information_overload`, `missing_contact_route`, `missing_next_step`, `missing_trust_signal`, `no_material_friction_observed`, `unclear_value`, `weak_cta` |
| `actionPriority` | single-label | `critical`, `high`, `medium`, `monitor` |

在資料列中，`targets` 就是 supervised learning 的 **Y**。`stageEvidence` 是標註治理與 provenance 證據，不是 Y 的替代品，也不是 model input。`secondaryStages` 與 `stageCueTypes` 可作為標註治理資訊，但禁止在此訓練分支作為輸入，否則會造成 label leakage。

## 6. X、特徵與目前 contract 差異

文字主輸入 X 是 `trainingText`。Notebook 以 `AutoTokenizer` 使用 `distilbert-base-multilingual-cased`，`truncation=True`、`padding='max_length'`、`MAX_LENGTH=256`。journeyStage 另有從同一份 inference-time `trainingText` 重建的 cue vector；它不可依賴 targets、stageEvidence、secondaryStages、stageCueTypes、test metrics 或 split 後的 label-derived field。

專案 contract 位於 `ml/schemas/features-v1.json`，名稱為 `features-v1`，規定 scaler 只能在 train fit 再 freeze。該 contract 宣告較完整的 17 項特徵組合，包括 text cues、`price_shipping_returns_cue_count`、`form_presence`、approved structured extract 的 `next_step_link_count`、page type one-hot、schema type one-hot 與 evidence quality vector。

**但目前 optimized Colab Notebook 實際只實作 14 維 text-derived subset。** 下一個 AI 不得把 contract 宣告的較寬欄位誤報為已經送進模型的輸入。實際使用的 14 維為：

| 實作特徵 | 來源 |
|---|---|
| `problem_statement_count` | `trainingText` regex count |
| `question_heading_count` | `trainingText` question mark count |
| `definition_cue_count` | `trainingText` regex count |
| `how_it_works_cue_count` | `trainingText` regex count |
| `comparison_cue_count` | `trainingText` regex count |
| `requirements_cue_count` | `trainingText` regex count |
| `troubleshooting_cue_count` | `trainingText` regex count |
| `error_debug_cue_count` | `trainingText` regex count |
| `remediation_cue_count` | `trainingText` regex count |
| `cta_count` | `trainingText` regex count |
| `contact_purchase_cue_count` | `trainingText` regex count |
| `form_presence` | `trainingText` regex presence of form/email/phone |
| `text_length_log` | `log1p(len(trainingText))` |
| `heading_count_log` | `log1p(trainingText.count('\\n'))` |

所有 14 維 raw features 先由 train rows 計算 mean/std；std 小於 `1e-6` 時設為 1，再把同一組 stats 套用到 validation、test 與未來 inference。若未來要採用 features-v1 contract 的其他 approved structured fields，必須升級 contract／模型版本、保存重建規則，並重新驗證沒有 label leakage；不能在現有 artifact 名稱下悄悄改變 X。

## 7. 模型架構與既定訓練設定

模型版本是 `seo-geo-multitask-colab-v4-optimized`，共享 multilingual DistilBERT encoder，取 first-token pooled representation。journeyStage head 在 text pooled representation 之外接一個 64 維 MLP embedding 的 14 維 stage feature branch；其他八個 heads 只使用 pooled text representation。多任務 heads 對應九項 labels。

既定正式設定如下。正式 full ablation 應使用兩種 config、三個 seed，並以 validation journeyStage macro-F1 選模；test_v2 在選模前不可查看或用於調參。

| 設定 | 值 |
|---|---|
| base model | `distilbert-base-multilingual-cased` |
| max length | 256 |
| batch size | 8 |
| optimizer | AdamW |
| learning rate | `2e-5` |
| weight decay | `0.01` |
| gradient clipping | `1.0` |
| max epochs | 8 |
| early stopping | patience 2，監控 validation journeyStage macro-F1 |
| seeds | `20260820`, `20260821`, `20260822` |
| stage loss multiplier | `2.0` |
| weighted stage loss | sqrt inverse-frequency class weights，依 train counts fit |
| configs | `text_only_baseline`；`stage_branch_weighted` |
| selection | validation journeyStage macro-F1 only |

既有原始 Notebook 位於 `/home/ubuntu/private_training/DiscoveryStack_SEO_GEO_500_OPTIMIZED.ipynb`，私有 Drive Notebook ID 是 `1QS3-7FwpHSfLdIfIhQCH1oP9__xBos6r`。本地 recovery Notebook 產生器及清除輸出的 recovery Notebook 位於 `/home/ubuntu/private_training/make_recovery_notebook.py` 與 `/home/ubuntu/private_training/DiscoveryStack_SEO_GEO_500_OPTIMIZED_RECOVERY.ipynb`；它們是交接資產，不代表已在 Colab 成功執行。

## 8. 評估 gates 與 artifact 規格

只有在實際看到訓練 epoch logs、`run_records`、checkpoint 及 selected path 後，才可執行 final evaluation。需各自評估 `test_v2` 43 筆新測試集與固定的 `test_legacy_v1` 32 筆回歸集，至少輸出 journeyStage macro-F1、micro-F1、per-class F1、confusion matrix、truth support、predicted support 與 zero-prediction class。

若 test_v2 中任何 journeyStage class 的 predicted support 為零，readiness 必須是 `candidate_not_ready`；沒有零支持時，最多是 `candidate_ready_for_review`。任何狀態都不等於 production-ready，因為 250 筆 web.dev rows 仍需 manual stageEvidence adjudication。

允許封裝的 artifact 內容應包括 self-describing checkpoint 或 Transformers-compatible model／safetensors、tokenizer、`training_config.json`、`label_maps.json`、`feature_stats.json`、metrics、兩個 test split 的 JSONL predictions、artifact manifest、checksums 與 ZIP。`ml/packaging/package_artifact.py` 是 allow-list packager。

Artifact 絕不能包含 raw JSONL、HTML、瀏覽器 profile、Colab HTML capture、`.env`、OAuth material、token、secret 或任何未清理的 source cache。封裝後必須 assert `containsRawDataset=False`、`containsHtml=False`，驗證 ZIP bytes 與 SHA256，再上傳 owner-only Drive；本次目前沒有 artifact 可供查詢。

## 9. Colab 阻塞的實際證據與接手方法

Colab 曾成功取得 Tesla T4，Drive OAuth 讀取成功，500-row manifest download 與 fail-closed validation 也成功。阻塞不是已知的 CUDA OOM 或資料驗證失敗，而是 Colab runtime 的 cell execution state 與 Notebook source 不同步。

已確認的最後具體錯誤是訓練 cell 在 `run_root = Path('/content/optimized_runs_v4')` 前停止，錯誤為 `NameError: name 'Path' is not defined`。雖然 Notebook source 顯示過 `from pathlib import Path`，當前 Python session 並沒有可靠地執行該 imports cell。曾在 GUI 中插入 `from pathlib import Path; import shutil; print({'path_ready': True})` 修復 cell，但沒有可驗證的 `path_ready` output，因此不能把它視為已修復。

因此，若未來重新訓練，應使用本地產生的 recovery Notebook，而不是在原 Notebook 上繼續點擊。新鮮 T4 runtime 的執行順序應是：先執行自包含 setup cell；確認 `imports_ready=True`；載入 owner-only Drive snapshot；確認 500 rows、兩個 digest 與 split counts；建立 tokenizer、feature stats、dataset；執行 model definition 與 one-batch forward/backward smoke test；確認 `model_definition_ready=True` 與 `smoke_train_batch_ready=True`；先執行一個可觀察的 bounded run，再決定是否執行完整 2 configs × 3 seeds ablation。正式 run 必須在每個 run 開始及每個 epoch flush log，並保留完整 traceback。

本次使用者已要求停止訓練，因此這些是日後接手指引，不是本次已完成的結果。不要執行原 Notebook 的 final evaluation 或 packaging cell，因為當前沒有 checkpoint、`selected_path`、`run_records` 或可信 metrics。

## 10. 私有保存與專案檔案

| 類別 | 路徑或 ID | 版本／權限 |
|---|---|---|
| raw 500 JSONL | `/home/ubuntu/private_training/discoverystack-manifest-v4-500.jsonl` | 本機私有，不進 Git |
| Drive raw snapshot | `1i2N36qNgHOmx1PM7-DZV-R02wq73t3SV` | owner-only |
| original Colab Notebook | `1QS3-7FwpHSfLdIfIhQCH1oP9__xBos6r` | owner-only |
| safe inventory | `/home/ubuntu/private_training/handoff_inventory_500.json` | 不含原文；本機私有 |
| training state | `/home/ubuntu/private_training/phase4_500_state.md` | 不含 secrets |
| dataset schema | `ml/schemas/dataset-v4-500.schema.json` | 可進 Git |
| feature schema | `ml/schemas/features-v1.json` | 可進 Git |
| execution runbook | `ml/runbooks/500_EXECUTION_RUNBOOK.md` | 可進 Git，含治理假設差異說明 |
| this handoff | `ml/AI_HANDOFF_500_TRAINING.md` | 可進 Git；不含 raw data |
| recovery generator | `/home/ubuntu/private_training/make_recovery_notebook.py` | 建議 scrub 後進 Git；不含資料內容 |
| recovery Notebook | `/home/ubuntu/private_training/DiscoveryStack_SEO_GEO_500_OPTIMIZED_RECOVERY.ipynb` | 清除 outputs；建議 scrub 後進 Git |

目前 Git main／origin/main 先前均在 commit `1853e5f`，500 ML 檔案曾呈現 untracked；提交前必須重新執行 `git status --short`、檢查 staged file list，確認沒有 `private_training`、`.jsonl`、`.html`、`.zip`、`.env`、token 或 browser state。只有 safe handoff、schema、runbook 及經 scrub 的 recovery source 可以提交。

## 11. 最終交接結論

本次成功保存的是 **500 筆 v4 資料版本、私有 Drive snapshot、私有原始 optimized Notebook、safe inventory、狀態紀錄、schema、runbook 與本交接文件**。本次沒有成功保存 500 筆 trained model artifact，因為訓練從未客觀進入可確認的 epoch 完成狀態，且在 `Path` NameError 後沒有 checkpoint。

下一個 AI 應從固定的 v4-500 manifest digest 開始，先讀本文件、`dataset-v4-500.schema.json`、`features-v1.json`、`500_EXECUTION_RUNBOOK.md` 與 `phase4_500_state.md`，再於新鮮 T4 runtime 使用 recovery Notebook。任何聲稱已完成 500 訓練的報告，都必須附有客觀的 epoch、checkpoint、metrics、ZIP SHA256 與 owner-only Drive metadata；在這些證據出現前，狀態必須保持為 **training incomplete / candidate not available**。

## References

[1]: https://web.dev/robots.txt "web.dev robots.txt"
[2]: https://web.dev/sitemap.xml "web.dev sitemap"
[3]: https://web.dev/articles/ai-agent-site-ux "web.dev AI agent site UX article"
[4]: https://developers.google.com/terms/site-policies "Google Developers site policies"
[5]: https://json-schema.org/draft/2020-12/schema "JSON Schema Draft 2020-12"

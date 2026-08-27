# DiscoveryStack journey-v5-1087 Colab 執行 Runbook

**目的：** 在完全保留 frozen `manifest-v4-500` 與其 artifact 的前提下，執行 development-only 的 `manifest-v5-1087` 多任務訓練。v5 的新增 587 筆資料尚未完成 rights review 與 stageEvidence adjudication，因此任何模型結果都只能作為研究／開發候選，不得直接 production deploy。

> **目前狀態（2026-08-28）：** v5 private manifest 已通過 local 與 Colab R2 validator，owner-only snapshot 與 output-free R2 Notebook 已保存。CPU one-batch smoke 成功；bounded fast path（`stage_branch_weighted`、seed `20260820`、最多 2 epochs）因 CPU 首批 forward 過慢而安全中斷，沒有 epoch metrics、checkpoint、test results 或 artifact。不要把 v5 描述為已訓練完成。

## 1. 固定資料與治理契約

| 項目 | v5 contract |
|---|---|
| parent | `manifest-v4-500`，frozen，不可覆寫 |
| rows | 1,087 = base 500 + added 587 |
| manifest hash | `08931b3827f37d9254c9d8d0555aa635babc26d6c94c218bac523cc4a86f2003` |
| dataset digest | `c787aad7f775a3f4db705c171b22f968bd1fff09b3ee3ee7e99557afccea60a6` |
| split | train 761 / validation 163 / `test_legacy_v1` 32 / `test_v2` 131 |
| stage totals | understanding 112 / progression 247 / response 188 / discovery 232 / conversion 308 |
| source families | Google Search Central 250 / web.dev 500 / Google Developers 137 / MDN 200 |
| feature contract | `features-v1`, actual model subset 14 dimensions |
| status | development-only; rights pending; human adjudication required |

v5 使用 `ml/schemas/dataset-v5-1087.schema.json`，而不是 v4 schema。v5 governance 允許 `approved` 與 `public_access_only_pending_human_review`，並接受 optional `licensePolicy`。後者只表示目前的資料契約能記錄此欄位，不表示所有新增頁面都已完成逐頁授權確認。

## 2. 執行前檢查

執行者先在 owner-only Drive 確認只有一份 `discoverystack-manifest-v5-1087-private.jsonl` snapshot，且其 bytes、manifest hash 與 dataset digest 完全符合上表。不要把 raw JSONL、source cards、HTML 或 OAuth files 複製到 Git；不要在 v5 run 中讀取或覆寫 v4 artifact。

確認新增資料的 aggregate review state 為 837 `needs_adjudication`、250 `reviewed`，rights status 為 587 `public_access_only_pending_human_review`、500 `approved`，manifest flags 為 `developmentOnly=true`、`rightsReviewPending=true`、`humanAdjudicationRequiredBeforeProduction=true`。這些 flags 是 fail-closed governance evidence，不是 release approval。

## 3. Colab runtime 與 cell 順序

Notebook 使用 `DiscoveryStack_SEO_GEO_1087_CPU_FALLBACK_R2.ipynb` 的 output-free source。若取得 GPU，應使用獨立的新 runtime，記錄 GPU／CUDA／Python／PyTorch／Transformers 版本；若沒有 GPU，不要把 CPU run 的結果和 v4 T4 結果直接宣稱可比較。

依序執行以下 cell，禁止 Run All，以便每個 gate 都能保存實際 output：

| 順序 | Cell | 必須觀察的 evidence |
|---:|---|---|
| 1 | setup/import | `imports_ready=true`，runtime backend 與 library versions |
| 2 | owner-private Drive load | 唯一檔名、bytes、private load success |
| 3 | v5 fail-closed validator | rows、digest、manifest、splits、stage balance、治理 flags |
| 4 | feature build | 14 dimensions；normalization 只 fit train |
| 5 | tokenizer／dataset | `max_length=256` 與 split indexes |
| 6 | model definition | shared encoder、九個 heads、stage branch shape |
| 7 | one-batch smoke | forward、loss、backward、finite loss、device |
| 8 | training function | 只定義 training／evaluation function，不讀 test metrics |
| 9 | bounded fast path | checkpoint、epoch records、validation metrics |
| 10 | selection then tests | 先選 validation，再各一次 test_v2／test_legacy_v1 |
| 11 | package | allow-list、manifest、checksums、private upload |

R2 CPU 實際已完成第 1–8 步的必要前置與 smoke，但第 9 步在第一個 training batch 被安全中斷。若要重試，不要在同一個已中斷 kernel 上猜測變數狀態；建立新 runtime 或重新執行所有前置 cell。

## 4. X、Y 與模型輸入規則

`X_text` 是清理後的 `trainingText`，tokenized by `distilbert-base-multilingual-cased`、max length 256、truncation 與 max padding。shared pooled text representation 同時供九個 heads 使用；只有 `journeyStage` head 額外使用 14 維 inference-safe text cue branch。

14 維 feature 為：problem statement、question heading、definition、how-it-works、comparison、requirements、troubleshooting、error/debug、remediation、CTA、contact/purchase cue counts，外加 form presence、log text length、log heading/newline count。scaler 只用 train split fit 並 freeze。

`Y` 包含 `journeyStage`、`actionPriority` 兩個 single-label task，以及七個 multi-label task：`searchIntents`、`contentTypes`、`audienceRoles`、`geoSignals`、`citationReadiness`、`technicalSeoSignals`、`frictionSignals`。`stageEvidence`、`secondaryStages`、`stageCueTypes`、source／split、rights／review flags 與 post-outcome 欄位不可進入 X。

## 5. 訓練設定與選模

先執行 bounded fast path：`stage_branch_weighted`、seed `20260820`、最多 2 epochs。這只是 runtime／shape／可行性檢查，不是完整研究。正式研究若資源允許，再獨立執行 `text_only_baseline` 與 `stage_branch_weighted`，每組 seeds `20260820`、`20260821`、`20260822`，max 8 epochs，early stopping patience 2。

固定核心設定為 AdamW、learning rate `2e-5`、weight decay `0.01`、batch size `8`、gradient clipping `1.0`、stage loss multiplier `2.0`。stage class weights 只能從 train split 計算，採 sqrt inverse-frequency。唯一主選模指標為 validation `journeyStage` macro-F1；不得使用 `test_v2` 或 `test_legacy_v1` 進行調參、早停或選模。

## 6. Test gate

只有在 selected checkpoint 與 validation record 真實存在後，才可一次評估 `test_v2` 與一次評估 `test_legacy_v1`。應保存九個 task 的 macro／micro F1、per-class precision／recall／F1、support、confusion matrix、predicted support 與 zero-prediction check。`test_legacy_v1` 必須維持固定 32 筆，不可被 `test_v2` 或新 split 覆寫。

任何 `test_v2` journeyStage class 的 predicted support 為 0，readiness 必須標示 `candidate_not_ready`。無論測試分數如何，rights pending 或未完成人工 adjudication 都阻止 production release。若訓練中斷、沒有 checkpoint 或沒有 validation metrics，狀態只能是 `not_trained`／`run_interrupted`，不可生成假 metrics。

## 7. Artifact allow-list

artifact 僅可包含可重建模型所需的 checkpoint／model state、tokenizer files、training config、label maps、train-fitted feature statistics、metrics、private prediction JSONL、artifact manifest 與 checksum file。artifact manifest 必須記錄 v5 model version、backend、data digest、governance flags、review restrictions、selected config 與 test gate 結果。

封裝前必須 assert `containsRawDataset=false` 與 `containsHtml=false`，並檢查 ZIP 不含 raw JSONL、source cards、HTML、browser profile／captures、OAuth、token、`.env`、private keys 或 secrets。模型 ZIP 與 checkpoint 只能 owner-only 保存，不能加入 Git 或對話附件。

## 8. 目前 handoff 結論

目前可交接資產包括 v5 private manifest／snapshot、aggregate-safe inventory、v5 schema、output-free recovery Notebook R2、generator／checker、runbook 與 private CPU progress log。v5 尚未完成 training、selection、test evaluation 或 artifact packaging。下一個執行者應優先取得可用 GPU，再由乾淨 runtime sequentially 執行；若 GPU 仍不可用，保留本 handoff，不能以 CPU 中斷狀態宣稱已完成模型。

# DiscoveryStack journey-v4-500 Colab 執行 Runbook

**目的**：在不覆寫 `manifest-v3-250` 的前提下，建立可重建、可比較、可回滾的 500 筆 journeyStage 多任務模型。

> **目前狀態（2026-08-27）**：本 runbook 的執行前檢查是 production-grade 目標門檻；實際固定的 v4-500 是 development candidate，含 `reviewed=250` 與 `needs_adjudication=250`，來源家族為 Google Search Central 250 + web.dev 250，尚未完成模型訓練。不得宣稱已取得 500 筆 metrics、checkpoint 或 artifact；production 前必須先完成新增樣本的人工 stageEvidence adjudication，並重新確認所有門檻。

## 執行前檢查

執行者先確認 owner-only Drive 中存在唯一命名的 `manifest-v4-500` JSONL、來源卡摘要與候選審核紀錄。所有樣本必須已通過權利、robots、PII、去重與人工標註閘門；未完成 adjudication 的樣本不進入 final manifest。Notebook 的 `EXPECTED_MANIFEST_HASH`、`EXPECTED_DATASET_DIGEST`、`EXPECTED_ROW_COUNT` 與 split counts 必須由 manifest 產生器寫入，禁止手動在 Colab 內改數字。

| 項目 | 預期值 |
|---|---|
| row count | 500 |
| primary stage | discovery / understanding / response / progression / conversion |
| minimum per stage | 80 |
| train / validation | 350 / 75 |
| test | 75；其中包含固定的 `test_legacy_v1` 回歸子集 |
| source group | 不跨 split；單一 source family 不超過 20% |
| label method | human 或 human_amended |
| review state | reviewed |
| feature contract | `features-v1` |

## Colab cell 順序

### Cell 1：環境與 GPU

安裝固定版本的 `transformers`、`scikit-learn` 與 `sentencepiece`，執行 `nvidia-smi`，並在程式中 assert `torch.cuda.is_available()`。記錄 GPU 型號、CUDA、Python、PyTorch 與 Transformers 版本。若沒有 GPU，直接停止，不得退回 CPU 產生不可比的 run。

### Cell 2：私有資料載入

優先使用 owner OAuth 讀取唯一的 Drive snapshot；直接上傳只作明確的備援路徑，且只能接受檔名與 digest 完全匹配的檔案。不要在同一個 runtime 先後執行兩條資料載入路徑，避免 `DATA_PATH` 被覆寫。

### Cell 3：fail-closed manifest 驗證

驗證 500 筆、唯一 ID、manifest hash、dataset digest、split counts、primary stage 的五類分布、每筆必備的 stage evidence、label confidence、review state、feature contract 與治理欄位。驗證完成後列印摘要，不列印原始文字、URL、PII 或長篇證據。

### Cell 4：特徵重建與資料集建立

從 `trainingText` 與核准的結構化抽取重建 `stageCueVector`。所有 scaler／vocabulary 只在 train fit，然後 freeze 到 validation、test 與推論服務。`primaryStage`、`secondaryStages`、`stageCueTypes` 與任何 test 結果不得進入 feature vector。保存每筆 feature schema version，不要保存未經清理的原始 HTML。

### Cell 5：模型與 smoke test

保留共享 encoder，新增只供 journeyStage 使用的 feature MLP branch。stage head 的輸入為 `concat(pooled_text, feature_embedding)`；其他八個 heads 維持既有文字 branch。先用五筆非訓練樣本檢查所有輸出 shape、label shape、feature dimension 與 device，再開始訓練。

### Cell 6：A/B/C ablation

依序執行以下三組，所有組別固定資料 split、seed 集合與 test 不可見：

| 組別 | 設定 |
|---|---|
| A | 250 baseline，text-only，固定舊 test |
| B | 500，text-only，stage class weight |
| C | 500，text + stageCueVector，stage loss weight 2.0 |

每組至少使用三個 seed；以 validation journeyStage macro-F1、每類 recall、zero-prediction check 與 validation loss 選模。不能用 test 反覆調參。

### Cell 7：正式訓練

使用最多 8 個 epoch、warmup、gradient clipping 與 early stopping，監控 validation `journeyStage.macroF1`，patience 2。第一輪 class weight 採 inverse-square-root frequency；再獨立比較 WeightedRandomSampler，避免兩者同時極端化。建立 optimizer parameter groups，encoder 使用較小 learning rate，stage branch 與 heads 使用較大 learning rate。

### Cell 8：評估

輸出每一個 task 的 macro-F1、micro-F1、per-class precision／recall／F1、support、confusion matrix、預測支持數與 bootstrap confidence interval。`discovery` 或 `response` 任一預測支持數為零即標記 `candidate_not_ready`。舊 32 筆 test 另存為 `test_legacy_v1`，不得被新 test 覆寫。

### Cell 9：artifact 封裝

執行 `ml/packaging/package_artifact.py`，輸入本次 run 的 artifact directory，產生 `artifact-manifest.json`、`checksums/SHA256SUMS` 與 ZIP。封裝前先保存 Transformers-compatible checkpoint；v4+ 優先 `safetensors`，不要只保存無法自描述的 `state_dict`。ZIP 不得包含原始 JSONL、HTML、瀏覽器 profile、`.env`、token 或 secrets。

## 500 版建議 run ID

```text
journey-v4-500-<manifest_hash_first_12>-<utc_timestamp>
```

對應的 `training-config.json` 至少記錄：base model、model version、taxonomy version、feature contract version、seed、max length、batch size、epoch limit、learning rates、class-weight policy、stage loss weight、threshold、split counts、manifest hash、dataset digest、source group policy、GPU 與 library versions。

## 完成條件

只有在三個 seed 的結果、old-test regression、new test、artifact checksum、checkpoint reload smoke test 與資料治理摘要都已保存時，run 才能標記 `candidate_ready_for_review`。`candidate_ready_for_review` 不等於 production release；仍需 owner review 與部署邊界驗證。任何閘門失敗都保留完整失敗證據並標記 `candidate_not_ready`，不可用重新命名或覆寫 metrics 方式消除。

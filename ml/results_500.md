# DiscoveryStack v4-500 訓練結果

**更新日期：** 2026-08-27

**目前狀態：** `fast_path_evaluated_candidate_not_ready`

本次已在新的 Colab Tesla T4 recovery runtime 以固定的 v4-500 私有 manifest 完成一個可觀察的 **fast-path bounded candidate run**。這不是原定的完整 `2 configs × 3 seeds × 最多 8 epochs` ablation；本次只執行 `stage_branch_weighted`、`seed=20260820`、最多 2 epochs。資料沒有被修改，1,087 筆方向也沒有恢復。

## 資料與 runtime 證據

| 項目 | 已確認值 |
|---|---|
| rows | 500 |
| manifest hash | `d1868ebd13ebf5b489e551afba2c047c19af5022e83c101e23a9927beaf02977` |
| dataset digest | `6aaf9e6c57f4d930ba220575bc1a5f7cb0ba6145373e7a8b629f89403c85c474` |
| splits | train 350 / validation 75 / test_legacy_v1 32 / test_v2 43 |
| GPU | Tesla T4，CUDA device |
| model | `distilbert-base-multilingual-cased` |
| features | `features-v1`，實際 14 維 inference-safe text cue subset |
| smoke gate | `model_definition_ready=True`、`smoke_train_batch_ready=True`、`lossFinite=True` |

## Fast-path 訓練

訓練在第 1 與第 2 epoch 都產生了可觀察的 log、`run_records`、selected record 與 checkpoint。模型依 validation `journeyStage` macro-F1 選擇第 2 epoch。

| epoch | train loss | validation macro-F1 | validation micro-F1 | validation accuracy | validation predicted support |
|---:|---:|---:|---:|---:|---|
| 1 | 7.8520873135 | 0.0898395722 | 0.1200000000 | 0.1200000000 | conversion 12 / discovery 0 / progression 59 / response 0 / understanding 4 |
| 2，selected | 6.3885995041 | 0.2274165977 | 0.2666666667 | 0.2666666667 | conversion 11 / discovery 10 / progression 9 / response 32 / understanding 13 |

Selected configuration 是 `stage_branch_weighted`，`use_stage_features=True`、`use_class_weight=True`、seed `20260820`、best epoch `2`。這些數字只代表 fast-path candidate，不能與完整 ablation 或 production 模型混稱。

## Final test evaluation

`test_v2` 與固定 `test_legacy_v1` 均以 validation 選出的 checkpoint 評估一次。完整多任務 metrics 與兩個 split 的 prediction JSONL 均位於私有 artifact；以下只列出 journeyStage 的安全摘要。

| split | rows | macro-F1 | micro-F1 | accuracy | predicted support | gate 結果 |
|---|---:|---:|---:|---:|---|---|
| `test_v2` | 43 | 0.1879598662 | 0.3953488372 | 0.3953488372 | conversion 0 / discovery 11 / progression 0 / response 32 / understanding 0 | `candidate_not_ready` |
| `test_legacy_v1` | 32 | 0.0422222222 | 0.0625000000 | 0.0625000000 | conversion 13 / discovery 0 / progression 2 / response 0 / understanding 17 | regression fail signal |

`test_v2` per-class F1 為 conversion `0.0`、discovery `0.4615384615`、progression `0.0`、response `0.4782608696`、understanding `0.0`。由於 `test_v2` 有三個 journeyStage 類別的 predicted support 為零（conversion、progression、understanding），依既定 gate 必須標記 `candidate_not_ready`。這不是 production-ready，也不是可直接部署的模型。

`test_legacy_v1` per-class F1 為 conversion `0.1111111111`、discovery `0.0`、progression `0.0`、response `0.0`、understanding `0.1`；其 predicted support 也有 discovery 與 response 為零，表示固定 legacy regression 表現不足。

## 私有 artifact

allow-list packaging 已成功完成，並 assert raw dataset 未被納入。artifact 包含 checkpoint／模型狀態、tokenizer、training config、label maps、feature stats、metrics、兩個 test split 的 predictions、manifest 與 ZIP；不包含 raw JSONL、HTML、browser state 或 secrets。

| 項目 | 已確認值 |
|---|---|
| ZIP name | `discoverystack-ml-v4-500-d1868ebd13eb.zip` |
| ZIP bytes | `500810915` |
| ZIP SHA256 | `89683d0630aff1e003cad360e44ae255f3434bbbb0e07af01d1057990e8443ad` |
| Drive file ID | `1yBQj_VD8g0jGo1c7UbpTnpb1fzTucMI3` |
| Drive permission | owner-only；metadata owner 是使用者帳戶 |
| raw data included | `False` |
| readiness | `candidate_not_ready` |

Drive artifact 只作私有保存，不能視為公開模型或 production release。250 筆 web.dev 衍生樣本仍全部需要人工 `stageEvidence` adjudication。

## 後續建議

下一輪若要改善結果，應以這個 artifact 作為可追溯的 fast-path baseline，重新執行完整 `text_only_baseline` 與 `stage_branch_weighted` 的三 seed、最多八 epoch ablation，仍然只以 validation journeyStage macro-F1 選模，並把 test_v2 留到最後一次評估。應優先檢查 stage label adjudication、source-family/domain split、legacy regression 分布與 multilingual text normalization；不能以 test_v2 反覆調參，也不能因 gate 失敗而降低 zero-prediction 門檻。

完整資料契約與接手流程請參閱 `ml/AI_HANDOFF_500_TRAINING.md`、`ml/DiscoveryStack_500_AI_HANDOFF.ipynb`、`ml/schemas/dataset-v4-500.schema.json`、`ml/schemas/features-v1.json` 與 `ml/runbooks/500_EXECUTION_RUNBOOK.md`。原始 manifest 與 artifact ZIP 維持在 owner-only 私有位置，不進 Git。

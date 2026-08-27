# DiscoveryStack v4-500 訓練結果狀態

**更新日期：** 2026-08-27  
**狀態：** `training_incomplete`

目前已確認 500-row v4 manifest、owner-only Drive snapshot、資料驗證與原始 optimized Colab Notebook 已保存。資料摘要為：500 rows；manifest hash `d1868ebd13ebf5b489e551afba2c047c19af5022e83c101e23a9927beaf02977`；dataset digest `6aaf9e6c57f4d930ba220575bc1a5f7cb0ba6145373e7a8b629f89403c85c474`；splits train 350、validation 75、test_legacy_v1 32、test_v2 43。

目前**沒有可信的 500 筆 epoch metrics、run_records、checkpoint、selected model、test evaluation、artifact ZIP 或 Drive artifact upload**。Colab 的最後具體阻塞是 training cell 在 `run_root = Path('/content/optimized_runs_v4')` 前出現 `NameError: name 'Path' is not defined`；GUI 插入的 `path_ready` 修復 cell 沒有可驗證輸出。使用者已要求停止訓練，故不可執行原 Notebook 的 evaluation／packaging cell，也不可填入虛構分數。

1,087 筆擴充方向已放棄，不能恢復或覆寫 v4-500。500 筆中有 250 筆 `needs_adjudication`，所以即使日後訓練成功，最多也只能是 development candidate 或 `candidate_ready_for_review`，不是 production-ready。

完整接手說明請見 `ml/AI_HANDOFF_500_TRAINING.md` 與 `ml/DiscoveryStack_500_AI_HANDOFF.ipynb`。日後重新訓練必須在新鮮 T4 runtime 使用 recovery Notebook，先通過 `imports_ready`、`model_definition_ready`、`smoke_train_batch_ready`，再執行可觀察的 training run。

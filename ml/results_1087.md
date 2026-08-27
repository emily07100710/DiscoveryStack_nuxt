# DiscoveryStack SEO/GEO v5-1087 結果報告

**報告狀態：** `run_interrupted`；v5-1087 尚未形成可評估模型。本文只記錄實際證據，不以中斷執行推導 metrics 或 readiness。

## Dataset gate

| 項目 | 實際值 |
|---|---|
| rows | 1,087 = v4 frozen base 500 + added 587 |
| manifest hash | `08931b3827f37d9254c9d8d0555aa635babc26d6c94c218bac523cc4a86f2003` |
| dataset digest | `c787aad7f775a3f4db705c171b22f968bd1fff09b3ee3ee7e99557afccea60a6` |
| split | train 761 / validation 163 / `test_legacy_v1` 32 / `test_v2` 131 |
| journeyStage | understanding 112 / progression 247 / response 188 / discovery 232 / conversion 308 |
| source families | Google Search Central 250 / web.dev 500 / Google Developers 137 / MDN 200 |
| validator | local passed; Colab R2 `validated=True` |

## Governance gate

v5 是 development-only candidate：`developmentOnly=true`、`rightsReviewPending=true`、`humanAdjudicationRequiredBeforeProduction=true`。aggregate review state 為 `reviewed=250`、`needs_adjudication=837`；rights status 為 `approved=500`、`public_access_only_pending_human_review=587`。新增資料的 page-level rights 與 stageEvidence 仍需人工 adjudication，因此無論模型分數為何都不能直接 production release。

## Runtime evidence

Colab R2 CPU fallback 依序完成 owner-private Drive load、v5 validator、14 維 inference-safe feature build、tokenizer／dataset、model definition 與 one-batch smoke。smoke 實際輸出為 `device=cpu`、`featureDim=14`、`batchSize=8`、`seqLength=256`、`lossFinite=True`。

bounded fast path 的設定為 `stage_branch_weighted`、seed `20260820`、最多 2 epochs。實際觀察到 `run_start` 與 `epoch_start` epoch 1，但 CPU 首個 training batch 長時間未完成，最後安全中斷並產生 `KeyboardInterrupt`。因此本次沒有 `epoch_complete`、validation macro-F1、selected checkpoint、test_v2 metrics、test_legacy_v1 metrics、prediction JSONL 或 artifact ZIP。

## Interpretation

目前不能標示 `candidate_ready_for_review` 或 `candidate_not_ready`，因為 readiness test gate 尚未執行；正確狀態是 `run_interrupted`／`not_trained`。若在 GPU runtime 重試，必須先完成 checkpoint 與 validation-only selection，再各執行一次 `test_v2` 與 `test_legacy_v1`。任何 `test_v2` journeyStage zero predicted support 都必須導致 `candidate_not_ready`。

v4-500 的資料、artifact 與既有 fast-path 結果維持不變；本報告不包含 raw text、URL、source cards、HTML、OAuth、checkpoint 或 secrets。相關執行步驟見 [`1087_EXECUTION_RUNBOOK.md`](runbooks/1087_EXECUTION_RUNBOOK.md)，資料欄位契約見 [`dataset-v5-1087.schema.json`](schemas/dataset-v5-1087.schema.json)，完整 handoff 見 [`AI_HANDOFF_1087_TRAINING.md`](AI_HANDOFF_1087_TRAINING.md)。

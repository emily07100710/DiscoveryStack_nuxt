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

## Second-layer frictionReasonSignals status

第二層 `frictionReasonSignals` 已建立獨立的 private candidate derivative，保留 v5 parent 的 1,087 個 IDs 與原 split；derived manifest hash 為 `f85409be384a1eea7936d52137ccf0baa816962b8e47347cce1b72c691bfbb2d`，derived dataset digest 為 `8fe1c25e6e70ef47ce938ff83cf566f05b793033ad88b566e15b9a5a7aaf5c8b`。候選計數為 service_clarity_gap=23、trust_gap=254、proof_or_case_gap=2、cta_clarity_gap=237，其餘八個新增 labels 為 0；這些只是 candidate cues，不是 adjudicated labels。

修正後的 validator 與 Kaggle script 已採用 per-row tri-state mask：只有明確人工 adjudicated `present`／`absent` 才能進入 BCE；`candidate_present` 與 `unreviewed` 一律是 unknown、mask=0。現有 candidate derivative 沒有任何明確的 reviewed positive 或 reviewed negative，因此 eligibility report 對 12 個 labels 全部 blocked，沒有啟動第二層模型、沒有 checkpoint、沒有 validation/test metrics，也沒有 artifact ZIP。這是刻意的資料完整性 gate，不是可用 heuristic recall 或 masked loss 取代的訓練結果。

第二層的標註契約與 adjudication workflow 保存在 private training workspace：`friction_reason_annotation_contract.json`、`FRICTION_REASON_ADJUDICATION_WORKFLOW.md` 與 `friction_reason_annotation_queue_v5_1.jsonl`。完成人工 review 並產生新的 adjudicated v5.2 derivative 前，不應宣稱第二層已訓練完成或可供 production 使用。原 v5-1087 與 frozen v4-500 的結果、hash、資料與 artifact 狀態不變。

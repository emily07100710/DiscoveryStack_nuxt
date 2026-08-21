# DiscoveryStack 101 筆受治理 Colab 重訓：v1／v2 對照收據

> **結論：v2 是 development proof of concept，不是 production model。** v2 修正了 `journeyStage` 與 `actionPriority` 的單選分類契約；它沿用同一個核准 manifest、相同資料雜湊、相同 deterministic-id-v1 split 與固定 random seed。這份報告只保留可稽核的中繼資料、設定與彙總指標，不包含 JSONL、原始文本、來源片段、模型權重、checkpoint 檔、ZIP 或憑證。

## 受治理資料與執行識別

| 欄位 | v1 | v2 |
| --- | --- | --- |
| Provider | `google_colab_local` | `google_colab_local` |
| 模型版本 | `seo-geo-multitask-colab-v1` | `seo-geo-multitask-colab-v2` |
| Base model | `distilbert-base-multilingual-cased` | `distilbert-base-multilingual-cased` |
| Approved manifest | #1 / `gsc-ccby4-2026-08-20-101-v1` | #1 / `gsc-ccby4-2026-08-20-101-v1` |
| Manifest SHA-256 | `5c8917f1c3aa9908c4af9b8216de0f056139f7aa4ae3756bcf29af7fcbb6bbdc` | `5c8917f1c3aa9908c4af9b8216de0f056139f7aa4ae3756bcf29af7fcbb6bbdc` |
| Dataset SHA-256 | `c0cd6029382b5c9aba6baa1d348efa807758821889ce8e7b1f023ac100794569` | `c0cd6029382b5c9aba6baa1d348efa807758821889ce8e7b1f023ac100794569` |
| Split | `deterministic-id-v1`: 74 / 14 / 13 | `deterministic-id-v1`: 74 / 14 / 13 |
| Checkpoint SHA-256 | `2c2999604917fbbf501a125b619a16364ae1c6eb6116ed1ef32dc84d7551d1e3` | `6c0cbf4dc64eb875ce551f05cca8072c6a70ad9f9b2fa825a93edeedf8cfc1f6` |
| 固定 seed | 未在 v1 收據記錄 | `20260820` |
| Runtime | 私有 Google Colab | 私有 Google Colab / Tesla T4 |
| Artifact lineage | owner-controlled browser download | `owner_browser_download` |

v2 未變更 manifest、dataset digest 或 split，因此結果差異不來自重新切分資料或擴張資料集。v2 以 `maxLength=256`、`batchSize=8`、`epochs=3`、learning rate `2e-5`、weight decay `0.01` 與 multi-label threshold `0.5` 執行；五個未參與訓練的例子跨九個 heads 的 smoke test 已通過。

## 分類契約修正

| Head 類型 | Heads | v2 target／loss／評估 |
| --- | --- | --- |
| 單選 | `journeyStage`、`actionPriority` | class index、`CrossEntropyLoss`、softmax 後 argmax |
| 多選 | `searchIntents`、`contentTypes`、`audienceRoles`、`geoSignals`、`citationReadiness`、`technicalSeoSignals`、`frictionSignals` | multi-hot target、`BCEWithLogitsLoss`、sigmoid 後以 0.5 threshold 判定 |

此修正使 v2 的 label encoding、loss 與評估方式相互一致。新增契約測試會拒絕將上述兩個單選 head 設定成 multi-label、BCE loss 或 sigmoid threshold 評估。

## Loss 軌跡

| Epoch | v1 train loss | v1 validation loss | v2 train loss | v2 validation loss |
| --- | ---: | ---: | ---: | ---: |
| 1 | 0.6383 | 0.5746 | 0.6232 | 0.6821 |
| 2 | 0.5116 | 0.5078 | 0.5880 | 0.6391 |
| 3 | 0.4628 | 0.4826 | 0.5537 | 0.6063 |
| Test | — | — | — | 0.5658 |

## 最終測試集指標

| Task head | v1 Macro-F1 | v1 Micro-F1 | v2 Macro-F1 | v2 Micro-F1 |
| --- | ---: | ---: | ---: | ---: |
| `journeyStage` | 0.0000 | 0.0000 | 0.2333 | 0.2308 |
| `searchIntents` | 0.4545 | 0.8627 | 0.4444 | 0.8511 |
| `contentTypes` | 0.2637 | 0.7606 | 0.2664 | 0.7647 |
| `audienceRoles` | 0.4525 | 0.8800 | 0.4439 | 0.8687 |
| `geoSignals` | 0.1667 | 0.6341 | 0.1667 | 0.6341 |
| `citationReadiness` | 0.4286 | 0.8571 | 0.4286 | 0.8571 |
| `technicalSeoSignals` | 0.8047 | 0.8914 | 0.7996 | 0.8889 |
| `frictionSignals` | 0.2257 | 0.6182 | 0.2257 | 0.6182 |
| `actionPriority` | 0.2045 | 0.6923 | 0.2045 | 0.6923 |

v2 的 `journeyStage` 指標不再是 0，這與單選 loss／解碼修正一致；但是測試 Macro-F1 `0.2333`、Micro-F1 `0.2308` 仍然不足以支撐 production 使用。其他 heads 的少量變動必須在極小的 13 筆 test split 背景下解讀，不能被視為可靠的品質提升或退步證明。

## v2 `journeyStage` 測試混淆矩陣

矩陣的列為實際標籤、欄為預測標籤；標籤順序是 `conversion`、`discovery`、`progression`、`response`、`understanding`。

| Actual \ Predicted | conversion | discovery | progression | response | understanding |
| --- | ---: | ---: | ---: | ---: | ---: |
| conversion | 1 | 0 | 0 | 0 | 0 |
| discovery | 4 | 0 | 0 | 0 | 0 |
| progression | 1 | 0 | 0 | 0 | 0 |
| response | 4 | 0 | 0 | 1 | 0 |
| understanding | 1 | 0 | 0 | 0 | 1 |

模型在測試集中仍明顯偏向預測 `conversion`，而 `discovery` 與 `progression` 沒有被正確預測。這個偏差、101 筆資料量與極小測試集共同說明 v2 只能用於驗證治理流程與模型契約，不能用於網站推論、客戶決策或正式自動化。

## Ledger 與 production gate

v2 已在不變更任何既有紀錄的前提下新增 completed training ledger row **#150001**，provider 為 `google_colab_local`。v1 ledger row #120001 保持不變。

production gate 仍是至少 150 個 examples，且每個 journey stage 至少 20 個 examples。這次受治理 manifest 只有 101 個 examples，因此 gate 結果仍為 **false**。本報告及 v2 ledger 一律標記為 development-only；未建立或啟用 inference API，未部署，也未合併 main。

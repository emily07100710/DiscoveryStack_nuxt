# Google Colab 101 筆治理訓練結果收據

> **定位：development proof of concept。** 此文件只保存可稽核的結果中繼資料與彙總指標；不包含 JSONL、來源文字、標註內容、模型權重、checkpoint 檔案、封存檔或憑證。這次完成的訓練不得被描述為 Hugging Face Jobs，也不得被描述為 production model。

| 項目 | 已登記結果 |
| --- | --- |
| Provider | `google_colab_local` |
| 完成時間（UTC） | 2026-08-21 07:26:40.698811 |
| Base model | `distilbert-base-multilingual-cased` |
| Model version | `seo-geo-multitask-colab-v1` |
| 已核准 manifest | #1 / `gsc-ccby4-2026-08-20-101-v1` |
| Manifest SHA-256 | `5c8917f1c3aa9908c4af9b8216de0f056139f7aa4ae3756bcf29af7fcbb6bbdc` |
| Dataset SHA-256 | `c0cd6029382b5c9aba6baa1d348efa807758821889ce8e7b1f023ac100794569` |
| Checkpoint SHA-256 | `2c2999604917fbbf501a125b619a16364ae1c6eb6116ed1ef32dc84d7551d1e3` |
| 受控 split | `deterministic-id-v1`：train 74 / validation 14 / test 13 |
| Epochs | 3 |
| Artifact lineage | owner-controlled browser download；沒有將檔案推送至 Git 或公開連結 |

## 訓練軌跡

| Epoch | Train loss | Validation loss |
| --- | ---: | ---: |
| 1 | 0.6383 | 0.5746 |
| 2 | 0.5116 | 0.5078 |
| 3 | 0.4628 | 0.4826 |

## 最終測試集指標

| Task head | Macro F1 | Micro F1 |
| --- | ---: | ---: |
| journeyStage | 0.0000 | 0.0000 |
| searchIntents | 0.4545 | 0.8627 |
| contentTypes | 0.2637 | 0.7606 |
| audienceRoles | 0.4525 | 0.8800 |
| geoSignals | 0.1667 | 0.6341 |
| citationReadiness | 0.4286 | 0.8571 |
| technicalSeoSignals | 0.8047 | 0.8914 |
| frictionSignals | 0.2257 | 0.6182 |
| actionPriority | 0.2045 | 0.6923 |

## Smoke test 與限制

五個**未參與訓練**的例子已通過 smoke test，並覆蓋 `journeyStage`、`searchIntents`、`contentTypes`、`audienceRoles`、`geoSignals`、`citationReadiness`、`technicalSeoSignals`、`frictionSignals` 與 `actionPriority` 九個 task heads。這僅驗證受控快照、模型結構與推論路徑可運作；**不構成模型品質或 production readiness 證明**。

101 筆資料只符合 development gate。production gate 仍維持至少 150 筆、每個 journey stage 至少 20 筆，且本次 `journeyStage` 測試 Macro/Micro F1 皆為 0，明確表示在擴增資料、重新評估與另行完成 inference API 前，模型不得接入正式網站或作為決策依據。

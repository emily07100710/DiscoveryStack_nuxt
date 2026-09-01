# DiscoveryStack ML 更新報告：journeyStage 優化與 250→500 架構

**作者：Manus AI**  
**更新範圍：250 筆 development run、journeyStage 診斷、artifact 封裝、500 筆訓練準備**

## 執行摘要

本次分析確認 `journeyStage` 的低表現不是單一模型超參數問題，而是由**評估樣本過少、類別分布不均、validation／test 切分不穩定，以及文字訊號不足以區分相鄰階段**共同造成。250 筆資料的整體階段分布為 `discovery=29`、`understanding=63`、`response=58`、`progression=67`、`conversion=33`；但目前 test 只有 32 筆，五個階段的實際 support 為 5、5、9、10、3，導致單一樣本錯誤就會大幅影響 macro-F1。

目前的 test confusion diagnosis 顯示模型完全沒有預測 `discovery` 與 `response`，並且把過多樣本預測成 `understanding` 或 `conversion`。這代表現階段應優先修正**資料與切分契約**，其次才是加入 stage-specific features 與調整 loss；直接把 epoch 或 learning rate 調大，預期不會穩定解決此類別崩塌問題。

## 目前實測證據

| 項目 | 實測結果 | 解讀 |
|---|---:|---|
| 全部資料 | 250 筆 | 目前仍屬 development proof of concept |
| train / validation / test | 184 / 34 / 32 | validation 與 test 太小，per-class 指標方差高 |
| journeyStage 整體分布 | 29 / 63 / 58 / 67 / 33 | discovery、conversion 明顯少於 progression、understanding |
| test 實際 support | conversion 5、discovery 5、progression 9、response 10、understanding 3 | understanding 只有 3 筆，無法作可靠泛化判斷 |
| test 預測 support | conversion 13、discovery 0、progression 7、response 0、understanding 12 | discovery／response 發生 zero-prediction collapse |
| discovery / response F1 | 0 / 0 | 不是單純 precision 不足，而是完全未被預測 |
| progression F1 | 0.375 | 目前五類中相對較有訊號，但 recall 仍只有 0.333 |
| conversion F1 | 0.111 | 預測過量，precision 只有 0.077 |
| understanding F1 | 0 | 實際 3 筆但預測 12 筆，呈現類別吸附現象 |
| test accuracy | 0.125 | 與前述 collapse 一致 |

`journeyStage` 是單選分類，因此不應以多標籤的 threshold 調參方式處理；應使用 per-class recall、macro-F1、confusion matrix、預測支持數與 calibration 一起選模。類別權重可以直接傳入 cross-entropy；PyTorch 官方 API 將此設計為每一類的 optional weight，適合處理訓練集類別不平衡，但權重必須只由 train split 計算。[1]

## 提升 journeyStage 的優先方案

### P0：先修正標籤與切分，再談模型

每一筆資料要補充至少一段**可定位到原文區塊的 stage evidence**，並以統一標註指南區分五個階段。標註者必須回答「使用者現在要完成的下一個行動是什麼」；不能只依據頁面主題、`contentTypes` 或 `searchIntents` 推斷。對於 `understanding` 與 `progression`、`response` 與 `conversion` 這些相鄰類別，應增加 hard-negative pair，要求標註者寫出「為什麼不是另一類」。

切分時改用**以 source family／canonical entity 為群組的 stratified split**，確保同一來源家族不跨 train、validation、test；同時將每個階段的樣本數固定到最低門檻。500 筆版本建議使用 train 350、validation 75、test 75，並讓每一階段至少有 80 筆；test 另保留固定的 `test_legacy_v1` 回歸子集，不能被新資料覆寫。

### P1：加入可在推論時重建的 stage cue features

目前文字 encoder 只有一個共享文字表示；對 `journeyStage` 應增加一個小型 feature branch，輸入只包含推論時可重建的訊號，避免把 label 本身或任何由 label 派生的欄位送入模型。第一版 feature contract 已建立在 `features-v1.json`，優先納入下列訊號：

| 特徵群 | 可重建訊號 | 主要辨識用途 |
|---|---|---|
| 問題／探索 | question mark、problem、why、issue、topic、definition、introduction | discovery／understanding |
| 學習／評估 | how-it-works、steps、guide、requirements、comparison、pros／cons、alternative | understanding／progression |
| 修復／回應 | troubleshoot、error、debug、resolve、remediation、incorrect、drop | response |
| 轉換／商業 | CTA、contact、book、buy、sign-up、checkout、shipping、returns、pricing | conversion |
| 結構訊號 | form／email／phone、頁型、是否存在下一步、內容結構深度、FAQ／產品／服務區塊 | progression／conversion |
| 語意關係 | 文字 embedding 與結構化 cue vector 的 concatenation | 協助模型處理短文本與相鄰階段 |

`stageCueVector` 的 scaler、詞彙或統計量只能在 train fit，再 freeze 到 validation、test 與推論服務。`primaryStage`、`stageEvidence`、`labelConfidence`、`reviewState` 與其他直接描述標籤的欄位不可進入 feature vector，否則會產生 label leakage。

### P1：採用受控的類別成本，而不是同時疊加所有補救手段

建議先比較三組 ablation：text-only baseline、text-only 加 stage class weight、text 加 `stageCueVector` 並把 journeyStage loss weight 設為 2.0。class weight 可先使用 train frequency 的 inverse-square-root，再獨立比較 `WeightedRandomSampler`；不要同時使用極端 sampler、極端 class weight 與 focal loss，否則會難以判斷改善來源並可能放大少數類別噪音。每一組至少跑三個 seed，選模只看 validation，不得反覆使用 test 調參。

### P2：加入分類器與評估的穩定性檢查

對五個階段輸出每類 precision、recall、F1、support、confusion matrix、預測支持數與 bootstrap confidence interval。只要任一類別的預測支持數為零，就標記 `candidate_not_ready`；不應只回報一個 aggregate accuracy。正式模型應使用 early stopping 監控 validation journeyStage macro-F1，並搭配 per-class recall 下限與固定舊 test 回歸檢查。

## 250→500 的架構調整

| 層面 | 250 v3 現況 | 500 v4 調整 |
|---|---|---|
| encoder | `distilbert-base-multilingual-cased` | 先保留 encoder，避免一次引入模型更換與資料變更兩個變因 |
| journeyStage head | 文字 pooled representation 的單一 head | `concat(pooled_text, stage_feature_mlp(stageCueVector))` 的 stage-specific branch |
| 其他八個 heads | 共享文字表示 | 維持既有路徑，避免非目標 task 同步漂移 |
| 資料 | 250；train 184、validation 34、test 32 | 500；建議 train 350、validation 75、test 75，另保留 legacy regression subset |
| loss | 三輪固定訓練 | 最多 8 epochs、early stopping、stage loss weight 2.0 的 ablation |
| seed | 單一 seed | 至少 3 seeds：20260820、20260821、20260822 |
| checkpoint | legacy `model_state_dict.pt` | 優先 Transformers-compatible `safetensors`，並保存 model／tokenizer／feature contract |
| artifact | download ZIP，缺少可重建的 lineage 索引 | `artifact-manifest.json`、`checksums/SHA256SUMS`、training config、metrics、test predictions；不含 raw JSONL／HTML |
| readiness gate | 250 POC | `candidate_ready_for_review` 需通過資料治理、reload smoke test、legacy regression、new test 與 zero-prediction gate |

Hugging Face Transformers 的標準保存介面可保存模型與設定，使 checkpoint 不只是一個沒有 schema 的裸 state dict；500 v4 應以此作為可重載格式，並將 feature contract 與 label map 一併封裝。[2]

## 本次已建立的工程交付物

| 路徑 | 用途 |
|---|---|
| `ml/ML_250_TO_500_PLAN.md` | 完整優化策略、資料契約、優先級與執行順序 |
| `ml/schemas/dataset-v4-500.schema.json` | 500 筆資料契約，含 evidence、治理與 split 要求 |
| `ml/schemas/features-v1.json` | journeyStage inference-safe feature contract |
| `ml/DiscoveryStack_SEO_GEO_500_TEMPLATE.ipynb` | 可延伸的 Colab Notebook 模板，含 stage branch、class weight、ablation 與 gate |
| `ml/runbooks/500_EXECUTION_RUNBOOK.md` | 500 筆逐 cell 執行順序與 fail-closed 閘門 |
| `ml/runbooks/REPACKAGE_250_TO_PRIVATE_DRIVE.md` | 250 筆模型重封裝及私有 Drive 保存流程 |
| `ml/packaging/package_artifact.py` | allow-list artifact packager；排除 raw JSONL、HTML、secrets 與 browser profile |

以上腳本與 JSON 檔案已完成語法／格式檢查：packager 通過 `py_compile`，Notebook 與兩個 schema 均可被 JSON parser 讀取。

## 250 artifact 保存狀態

目前的 Colab 舊 packaging cell 在重跑時因既有 run directory 已存在而失敗，具體錯誤為 `FileExistsError`；這不是模型訓練失敗，而是封裝 cell 使用 `exist_ok=False` 時沒有產生新的 run id。之後已在 Notebook 最後新增一個只保存既有 ZIP 的精簡 cell，但目前 My Browser 分頁又發生逾時，無法取得其成功輸出。

截至本報告產出時，Google Drive 中繼資料查詢結果為**尚未發現** `discoverystack-ml-v3-repack-*` ZIP，因此我不能誠實宣稱私有 Drive artifact 已完成保存。這次沒有重跑訓練，也沒有修改 250 筆資料。已建立的 `REPACKAGE_250_TO_PRIVATE_DRIVE.md` 與 `package_artifact.py` 可在瀏覽器恢復後直接完成保存；需要的 cell 只會尋找 `/content/colab-training-artifacts-v3*.zip`，計算 SHA-256，再以 owner-only Drive API 上傳，不會上傳原始 JSONL。

## 建議下一次執行順序

第一步，先在 owner-only Drive 建立並審核 `manifest-v4-500-private.jsonl`，確保五類各至少 80 筆、每筆有 evidence、reviewed 狀態、固定 source group 與不可跨 split 的群組鍵。第二步，在 500 template 執行 GPU、私有載入與 fail-closed validation；若任一治理欄位不符，停止而不要以手動改數字方式繼續。第三步，先跑三個 ablation 組別與三個 seed，再以 validation macro-F1、per-class recall 與 zero-prediction gate 選模型。第四步，只在模型選定後執行一次 new test 與 legacy regression。第五步，使用 allow-list packager 產生 ZIP、artifact manifest 與 SHA-256，最後才標記 `candidate_ready_for_review`。

## References

[1]: https://docs.pytorch.org/docs/stable/generated/torch.nn.CrossEntropyLoss.html "PyTorch CrossEntropyLoss"
[2]: https://huggingface.co/docs/transformers/main/en/main_classes/model#transformers.PreTrainedModel.save_pretrained "Hugging Face Transformers PreTrainedModel.save_pretrained"

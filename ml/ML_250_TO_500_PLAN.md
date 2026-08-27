# DiscoveryStack ML：journeyStage 優化與 250→500 擴充計畫

**作者：Manus AI**  
**文件狀態：可執行的工程與資料治理計畫**  
**目前基線：`seo-geo-multitask-colab-v3`，250 筆 development proof of concept**

## 一、結論先行

目前 `journeyStage` 的 test micro-F1 為 **0.1250**，而且不是單純的類別數量問題：混淆矩陣顯示模型對 `discovery` 與 `response` 的預測次數都是零，並把大量樣本吸收到 `conversion`、`progression` 和 `understanding`。因此，下一版不應只把資料從 250 筆增加到 500 筆；必須同時修正 **標註可辨識性、資料切分、階段證據欄位、class imbalance loss 與評估閘門**。

目前 250 筆資料的 journey-stage 總分布為：`discovery` 29、`conversion` 33、`response` 58、`understanding` 63、`progression` 67。固定 test 32 筆的實際支持數則是 `conversion` 5、`discovery` 5、`progression` 9、`response` 10、`understanding` 3；預測支持數為 `conversion` 13、`discovery` 0、`progression` 7、`response` 0、`understanding` 12。這使得 test macro-F1 對小樣本非常敏感，也證明模型沒有學到可泛化的 `discovery`／`response` 判別邊界。

| 項目 | 250 筆基線 | 500 筆目標與閘門 |
|---|---:|---:|
| 總資料量 | 250 | 500，全部通過 immutable manifest |
| 建議切分 | 184 / 34 / 32 | 350 / 75 / 75；另保留原 32 筆為 `test_legacy_v1` |
| journeyStage 類別 | 29 / 63 / 67 / 58 / 33 | 每類至少 80 筆；理想 90–110 筆 |
| journeyStage 主要指標 | test micro-F1 0.1250 | 以 validation macro-F1 作選模主指標，test macro-F1 作一次性確認 |
| 預測為零的類別 | discovery、response | fail-closed：任一 stage 預測支持數為 0 即不發版 |
| 特徵形式 | 只有 `trainingText` + targets | 文字、stage evidence、可用的結構化頁面特徵與資料治理欄位分離 |
| checkpoint | `model_state_dict.pt` legacy | 優先 `safetensors`；所有檔案有 SHA-256 與 artifact manifest |

## 二、為什麼目前 journeyStage 會低分

### 1. 測試集顯示出預測崩塌，而非均勻的小幅誤差

目前混淆矩陣的列是實際類別、欄是預測類別，順序為 `conversion`、`discovery`、`progression`、`response`、`understanding`：

```text
[[1, 0, 2, 0, 2],
 [4, 0, 0, 0, 1],
 [1, 0, 3, 0, 5],
 [5, 0, 1, 0, 4],
 [2, 0, 1, 0, 0]]
```

因此 `discovery` 與 `response` 的 recall 都是 0；`understanding` 雖然有 12 筆預測，卻沒有正確命中，precision 與 recall 也都是 0。這種型態通常優先指向 **標籤語意重疊、可觀測證據不足、資料切分與來源群組不平衡，以及共享多任務 loss 被其他 heads 稀釋**，而不是只需要再跑幾個 epoch。

### 2. 標籤是功能階段，但輸入缺少明確的階段證據

目前資料 schema 只有 `id`、`manifestHash`、`split`、`targets` 與 `trainingText`。`journeyStage` 的定義是頁面在使用者決策路徑中的功能；然而模型收到的主要是文字摘要，沒有被人工確認的 `stageEvidence`、證據位置、標註信心或主／輔階段。對同一主題而言，一篇可以幫助發現問題的文章、一篇用來比較方案的文章與一個促成行動的頁面，可能共享大量詞彙，單靠整段文字容易學成主題分類而非旅程功能分類。

### 3. 現有語料存在可被模型記憶的 lexical shortcut

250 筆診斷中，`conversion` 的高區辨詞包含 `product`、`purchase`、`shipping`、`returns`、`merchant`；`progression` 明顯出現 `schema`、`engineering`、`dataset`；`response` 出現 `debug`、`troubleshoot`、`remediation`；`discovery` 出現 `awareness`、`topic`、`starter`；`understanding` 出現 `introduction`、`pitfalls`、`headers`。這些詞可以作為候選 cue，但不能被當成真值。若某一階段長期與特定內容類型、來源網站或主題綁定，模型會以來源或主題捷徑取代階段推理。

### 4. 250 筆 test 太小，且類別支持數不平衡

`understanding` 在 test 只有 3 筆，而 `response` 有 10 筆；在這種規模下，一兩筆錯誤就會大幅改變 per-class F1。下一版應同時保留舊 test 作回歸集，並建立按 **journeyStage × source family × page type** 分層及群組切分的新 test，不可用同一來源或近似頁面洩漏到不同 split。

## 三、優先級最高的資料與標註優化

### P0：先把 journeyStage 改成「有證據的主階段標註」

每筆新樣本都應新增以下欄位；自動抽取只能產生候選，不能直接形成真值。`primaryStage` 才是目前五分類 head 的單一目標，`secondaryStages` 用來保留跨階段頁面的資訊，避免強迫所有頁面看起來只有一個功能。

| 欄位 | 要求 | 用途 |
|---|---|---|
| `primaryStage` | 五個固定值之一 | 五分類目標；由人工審核決定 |
| `secondaryStages` | 可為空集合 | 保留跨階段功能，不餵給 primary head 當噪音 |
| `stageEvidence` | 1–3 個證據片段；保存 locator、offset 或結構節點 | 讓標註可重審、可做 evidence-aware feature |
| `stageCueTypes` | 例如 `problem_discovery`、`explanation`、`comparison`、`troubleshooting`、`transaction_cta` | 將階段語意拆成可學的中介標籤 |
| `labelConfidence` | 1–5 | 低信心樣本進入 adjudication，不直接進 final train |
| `labelMethod` | `human` 或 `human_amended` | 防止 rule-only 候選冒充真值 |
| `reviewState` | `reviewed`、`needs_adjudication`、`blocked` | manifest gate 的必要條件 |
| `taxonomyVersion` | 例如 `journey-v3` | 允許未來重建而不混用舊語意 |

建議採 **雙人獨立標註 + 分歧 adjudication**。至少對所有 `discovery`、`response` 及低信心樣本做第二次審核；新增 250 筆時，目標是每一類至少 80 筆且每類至少 60 筆有明確 stage evidence。若頁面確實跨兩個階段，保留 `secondaryStages`，但必須依 rubric 指定 primary stage 的決策規則。

### P1：建立可辨識的對照樣本，而不是只增加相似來源

500 筆的新增 250 筆不應只是再抓 250 個同類官方技術文件。應建立 **counterfactual pairs**：同一主題或同一 page type，分別具備不同旅程功能，例如「問題認知文章 vs 方案比較頁」、「概念解釋頁 vs troubleshooting／修復頁」、「產品說明頁 vs 明確 CTA 的轉換頁」。對每一組 pair 保存 `pairId` 與 `contrastiveGroup`，但 pair 只用於訓練或診斷，不可讓相同內容變體跨 train/test。

新增資料應控制以下矩陣，避免 stage 與其他欄位完全共線：

| 控制維度 | 500 筆的操作要求 |
|---|---|
| journeyStage | 每類 80–110 筆；不要讓任何一類只來自單一網站或單一內容類型 |
| contentTypes | 每類至少涵蓋 editorial、service、tool、product 中的兩種 |
| searchIntents | 每類至少有 informational 與至少一種非 informational intent；若不適用需明示 `unknown` |
| source family | 單一來源家族不超過總資料 20%，來源群組不可跨 split |
| 語言／地區 | 依實際來源分布記錄，不用人為翻譯製造新樣本；保留 language／geo features |
| 同主題變體 | 以 canonical、內容 hash 與相似度去重；近似頁面不得分散到不同 split |

### P2：把 stage cue 做成可驗證的結構化特徵

建議從每一筆真實來源頁面計算且保存以下衍生特徵；這些特徵必須在推論時也能取得，不能使用標註結果或未來行為資料。文字仍保留作為主輸入，結構化特徵作為 journeyStage 專用 branch 的輔助輸入。

| 特徵群 | 候選特徵 | 可能對應的階段線索 |
|---|---|---|
| 問題認知 | problem statement count、question heading count、definition／awareness cue count | discovery |
| 解釋理解 | definition、how-it-works、step explanation、glossary／FAQ density | understanding |
| 比較與規劃 | comparison cue、pros／cons、requirements、case study、pricing context | progression |
| 回應與修復 | troubleshooting、error、debug、remediation、before／after cue | response |
| 行動與轉換 | CTA count、contact／book／buy／sign-up verbs、price／shipping／returns、form presence | conversion |
| 結構與路徑 | page type、internal-link band、breadcrumb depth、next-step link、schema type | 輔助，不可單獨決定階段 |
| 證據品質 | first-party evidence、author／owner、datedness、source links | 輔助信心，不是 stage 真值 |

不要直接把以上詞頻變成標籤；應把它們作為 `stageCueVector` 與中介 heads，並在 validation 上做 ablation：`text only`、`text + cue vector`、`text + evidence-aware branch`。若加入結構化特徵後 validation 上升但跨來源 test 下降，代表仍有來源 shortcut，應退回資料平衡與 group split 檢查。

## 四、模型與訓練調整

### 1. 讓 journeyStage 在多任務 loss 中有足夠權重

目前九個 heads 的 loss 取平均，會讓低資料量但核心的 `journeyStage` 被其他 head 的穩定梯度稀釋。500 筆第一輪建議採 `stage_loss_weight = 2.0`，再以 validation macro-F1 與 per-class recall 做小範圍搜尋 `[1.0, 1.5, 2.0, 3.0]`。不可直接以 test 選權重。

類別權重建議先使用 **inverse-square-root frequency** 或 effective-number 權重，而不是直接使用 inverse frequency，以免小類別梯度過大。PyTorch 的 `CrossEntropyLoss` 支援 per-class `weight`，可將這些權重直接傳入 stage head 的 loss。[1] 若採 `WeightedRandomSampler`，第一輪不要同時使用極端 sampler 與極端 class weight；先分開做 ablation，再選一個穩定方案。[2]

### 2. 加入 evidence-aware stage branch

目前模型是共享 DistilBERT encoder 後接九個線性 heads。下一版可保留共享 encoder，新增一個小型 `stage_feature_mlp`，將標準化的 `stageCueVector` 與 pooled text embedding concat，再只餵給 `journeyStage` head；其他 heads 維持文字 branch，以避免所有任務都被手工特徵污染。第一輪不要把模型換成更大的 encoder，先隔離資料／特徵／loss 的效果。

建議對比三個實驗：

| 實驗 | 內容 | 目的 |
|---|---|---|
| A | 250 基線重跑 + 固定 test | 確認環境與結果可重現 |
| B | 500 text-only + stage class weight | 分離資料量與 loss 改善 |
| C | 500 text + stageCueVector + stage loss weight | 檢驗特徵工程的增益 |

若 C 只在同來源 validation 提升，卻在 `test_legacy_v1` 或新來源群組 test 下降，不得發版。

### 3. 不要過早假設五階段是嚴格線性序列

`discovery → understanding → response → progression → conversion` 可以作為產品敘事順序，但實際頁面功能可能跳階或兼具多階段。第一版仍用五分類 primary head，但以 `secondaryStages` 與 `stageCueTypes` 保存多階段資訊；只有在標註統計證明順序穩定後，才考慮 hierarchical head 或 ordinal loss。否則把非線性頁面硬塞入 ordinal constraint 會把標註噪音寫進模型。

### 4. 訓練設定建議

500 筆在 T4 上可維持 batch size 8，先將 epoch 上限設為 8，加入 warmup、early stopping（監控 validation `journeyStage.macroF1`，patience 2），並保留 gradient clipping。建議使用 encoder 較小 learning rate、stage branch 較大 learning rate 的 differential learning rate；若輸入仍是 256 tokens，應先統計 stage evidence 是否常在尾端，只有確實截斷才提高到 384 或改用 evidence window，而不是盲目增加 max length。

## 五、500 筆資料與 split 設計

不要覆寫原 250 筆 manifest。建立新版本，例如 `manifest-v4-500`，並保留 `manifest-v3-250` 作為 lineage parent。建議 500 筆採 350／75／75 的 train／validation／test；原 32 筆 test 全部凍結為 `test_legacy_v1`，新 test 則補入 43 筆，使舊測試仍能做回歸而新測試能有較穩定的 per-class 支持數。若產品只接受單一 test 報告，應預先定義 `test_v2 = test_legacy_v1 + new_test` 並在 manifest 中固定，不可事後挑選。

每一次 split 要同時考慮 `primaryStage`、來源家族、canonical domain、page type 與 near-duplicate cluster。資料合成或隨機複製不得用來填補 stage 數量；若合法來源不足，應降低擴充速度並請 owner 提供更多已核准來源，而不是製造假資料。

## 六、模型與 artifact 封裝架構

新封裝不應只是一個 ZIP；應包含可重建所需的 **模型、設定、資料契約、指標、血緣與檔案雜湊**。Hugging Face Transformers 官方文件區分 architecture 與 checkpoint，並建議使用 `from_pretrained()` 讀取模型與設定；`save_pretrained()` 可保存可重載的模型目錄，且會處理大型 checkpoint 的分片。[3] 目前 v3 只有自訂 `model_state_dict.pt`，因此應在下一次成功重訓時轉為可明確重載的 checkpoint 目錄，並優先採用 safetensors 格式。

建議 250 舊版重封裝與 500 新版都採以下結構：

```text
artifact_bundle/
├── artifact-manifest.json
├── README.md
├── checkpoint/
│   ├── model.safetensors                 # v4+ 首選
│   ├── config.json                       # encoder／head 結構
│   ├── tokenizer.json / tokenizer_config.json / special_tokens_map.json
│   ├── label-maps.json                   # 固定 task → label → index
│   └── model-definition.py               # 自訂 multitask head 的版本化程式
├── training-config.json
├── metrics.json
├── run-summary.json
├── test-predictions.json                 # 僅保留必要的匿名化 id／預測
├── data-contract/
│   ├── schema.json
│   ├── split-summary.json
│   └── feature-contract.json
├── governance/
│   ├── manifest-lineage.json
│   ├── source-card-summary.json
│   └── license-robots-pii-summary.json
└── checksums/SHA256SUMS
```

原始 JSONL、原始 HTML、帳號資料、token、`.env` 與瀏覽器 profile 不進入 ZIP。若要保留原始資料，僅放在 owner-only Drive 的私有快照，並在 `artifact-manifest.json` 只保存檔案名稱、大小與 hash。每個 bundle 的 `runId` 建議為 `journey-v4-500-<manifest8>-<UTC timestamp>`；250 舊版可標記 `legacy-v3-250`，不可冒充 500 版。

## 七、建議的執行順序

| 步驟 | 動作 | 通過條件 |
|---:|---|---|
| 1 | 保存 v3 250 baseline 與舊 test | 舊 metrics、manifest hash、dataset digest 可重現 |
| 2 | 對既有 250 筆補查 stage evidence 與 label confidence | `discovery`、`response`、低信心樣本完成 adjudication |
| 3 | 收集 250 筆新增候選，逐筆通過 source card、license、robots、PII、dedupe | 候選不是自動真值；只有 reviewed 樣本可入 manifest |
| 4 | 建立 `manifest-v4-500` 與 stage-balanced group split | 每 stage ≥80；來源群組不跨 split；保留 legacy test |
| 5 | 生成 `stageCueVector` 與 feature contract | 所有特徵可由推論時輸入重建，無 label leakage |
| 6 | 先跑 A／B／C 三組 ablation | 以 validation stage macro-F1 選模，不看 test |
| 7 | 在固定 T4 上做最多 8 epoch、early stopping、3 seeds | 報告均值、標準差與每類 recall |
| 8 | 一次性跑新 test_v2 與 legacy test | 無 zero-prediction class；macro-F1 與 CI 達到預先門檻 |
| 9 | 以 packager 建立 ZIP、SHA256SUMS 與 artifact manifest | 可從 bundle 重新載入模型並通過 smoke test |
| 10 | 只把新版 Notebook、schema、runbook 與 packager 提交 Git | 私有資料、checkpoint、ZIP、token 全部在 Git 外 |

## 八、建議的發版閘門

500 筆仍是 development scale，不能把指標當作 production 保證。建議先設定相對於 250 baseline 的可檢驗閘門，而不是事後看結果再改門檻：`journeyStage` validation macro-F1 至少 0.45、test_v2 macro-F1 至少 0.40、每類 test recall 至少 0.25、`discovery` 與 `response` 預測支持數均大於 0，且 legacy test 的 macro-F1 不得比 250 baseline 顯著退化。這些是工程發版門檻，不是統計保證；在 500 筆資料仍應附 bootstrap confidence interval 與 per-class support。

若上述任一條件不通過，artifact 應標記 `candidate_not_ready`，保留 metrics、混淆矩陣與失敗原因，不得只回報平均分數或把新模型覆蓋舊模型。

## References

[1] [PyTorch, *CrossEntropyLoss*](https://docs.pytorch.org/docs/stable/generated/torch.nn.CrossEntropyLoss.html)

[2] [PyTorch, *torch.utils.data*](https://docs.pytorch.org/docs/stable/data.html)

[3] [Hugging Face Transformers, *Loading models*](https://huggingface.co/docs/transformers/en/models)

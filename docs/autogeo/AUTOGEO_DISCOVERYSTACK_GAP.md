# AutoGEO × DiscoveryStack 整合差距與 MVP 路線

DiscoveryStack 現有的多語言 DistilBERT SEO/GEO 九頭分類器、journey friction 規則診斷、BGE-M3 similarity pilot、資料集 manifest、training ledger、consent/PII/human-review gate 解決的是**診斷與治理**。AutoGEO 是**對指定 generative engine 產生改寫候選**的研究框架。兩者不能以替換方式整合，且 AutoGEO 不是自動發布機制。

| 層級 | DiscoveryStack 現有責任 | AutoGEO 可帶來的責任 | MVP 前必需差距 |
|---|---|---|---|
| Input | 已治理的來源、PII、consent 與人工審查 | 改寫候選的受控輸入 | 建立 first-party / consented candidate record；禁止 public crawl output 直接餵入。 |
| Diagnosis | 九頭分類、journey friction、similarity pilot | 可選擇 rule extraction 的訊號來源 | 將繁中/英文分類結果轉為可審查 feature，而非 prompt 注入。 |
| Generation | 無內容自動發布 | vanilla、AutoGEOAPI、AutoGEOMini candidate rewrite | 重新抽取 engine/domain 規則；繁中及目標 engine 需要配對資料與人審。 |
| Evaluation | ledger 與 dataset lineage | GEO/GEU、retrieval/visibility、citation、factuality、SEO、conversion | 建立 Experiment Ledger：before/after hash、engine/model/rule revision、分數、factuality 和 human approval。 |
| Publishing | owner-only workflow、noindex ML lab | 無 | 預設拒絕；只可由人工核准後進入既有內容發布管線。 |

## 可直接沿用與必須重做項目

| 類型 | 結論 |
|---|---|
| 可直接沿用 | AutoGEO 的固定 upstream、asset lineage、vanilla/AutoGEOAPI/AutoGEOMini 概念、官方模型卡所列 Qwen tokenizer / causal-LM format。 |
| 必須重新抽取規則 | 任何不同於 `gemini-2.5-flash-lite` 的 generative engine，以及 Traditional Chinese/English 的 DiscoveryStack domain。官方模型卡已明示跨 engine 或資料集需要 post-train。 |
| 必須重新訓練 | 需要 DiscoveryStack 專屬 AutoGEOMini 時，必須先取得有同意的 before/after paired experiments、human-approved factuality 與 measurable reward；不得以 101 筆分類資料替代。 |
| 需要付費 API | AutoGEOAPI 的 engine calls 與任何真實 generative-engine evaluation。必須以 provider 當期價格另行預算與取得 key。 |
| 需要兩張 A100 | 未來的大型 SFT/GRPO 或大量 candidate / reward experiment。不是 foundation、MVP 或網站 hosting 的需要。 |
| 可在免費環境測試 | public metadata manifest、asset verification、AutoGEO import、synthetic vanilla pipeline、adapter tests、及一個模型 config/tokenizer（在資源足夠時）。 |

## 容量與成本預估（僅供立項與重算）

以下不是採購建議，也不代表本分支已消耗任何付費服務。費率、區域、容量、折扣與 API token 數都會改變；啟動前應以供應商計價頁與實際 quota 重算。

| 項目 | 可重算假設 | 指示性區間／算式 | 邊界 |
|---|---|---|---|
| Metadata-only foundation | 三份 dataset metadata、五份 model manifest、config/tokenizer 與 synthetic fixture | 本次不保存正文或權重；project Git 新增內容應維持 MB 級 | 已完成，無付費模型 API。 |
| Research cache | 以 10–100 GB 估算未來已核准 cache | Google Cloud Standard 儲存示例價格為約 USD 0.020–0.026／GB-month，因此約 USD 0.20–2.60／month，另加請求與 egress | 不可把未審核公開資料或客戶資料視為可存。 |
| 單卡 A100 short experiment | 1 × A100、8–24 小時 | HF Endpoint AWS A100 80GB 列示 USD 2.50/hr，即約 USD 20–60，未含資料傳輸與 API | 只在另行核准訓練、資料與安全 gate 後評估。 |
| 兩卡 A100 SFT／GRPO pilot | 2 × A100、24–72 小時 | HF Endpoint AWS A100 80GB：2 × USD 2.50/hr × 24–72，約 USD 120–360；Google Cloud A2 價格另依區域／消費模式計 | AutoGEO 上游的大型訓練需要 GPU 與資料治理，但本 foundation 不會執行。 |
| 生成式 API evaluation | 已核准樣本數 × 每樣本 input/output token × 當期 provider 單價 | 無固定估算；必須先固定 provider、model、token budget、月度上限與 kill-switch | 沒有 key 時保持 blocked，禁止將無 API 結果寫成驗證成功。 |

官方參考：[Google Cloud Storage pricing](https://cloud.google.com/storage/pricing)、[Google accelerator pricing](https://cloud.google.com/products/compute/pricing/accelerator-optimized)、[Hugging Face Inference Endpoints pricing](https://huggingface.co/docs/inference-endpoints/en/pricing)、[Hugging Face Inference Providers billing](https://huggingface.co/docs/inference-providers/en/pricing)。

## 最短安全 MVP

第一步只新增 owner-only「改寫候選研究」資料模型：first-party consent、source hash、input locale、engine / model / rule revision、candidate hash、factuality check、quality check、GEO/GEU、human decision。第二步只收集成對的人工核准實驗結果，不做自動寫入。第三步在可重現的 held-out、繁中與英文測試集上評估 rule extraction 與候選品質。只有在 safety、PII、版權、brand、factuality、SEO performance、conversion、citation 和 human-approval gates 都明確時，才考慮受控 SFT / GRPO 實驗。

> 初期 reward 只能作為 research metric，需同時保留 retrieval/visibility、citation、GEO、GEU、factuality、SEO performance、conversion 與 human approval。任何單一 reward 最佳化都不得導致誤導、隱藏資訊、關鍵字堆砌或未核准發布。

## Production 前 gate

每次候選改寫必須檢查：來源所有權／同意、PII、版權與商標、繁中/英文 locale、事實可驗證性、citation 及品質、人審、變更追蹤與 rollback。production 仍不可直接啟用 RL；在有足量且授權清楚的 paired experiment data 前，AutoGEO 只屬 research foundation。

## References

[1]: https://github.com/cxcscmu/AutoGEO "AutoGEO official repository"
[2]: https://huggingface.co/cx-cmu/AutoGEO_mini_Qwen1.7B_Ecommerce "AutoGEO-Mini E-commerce model card"

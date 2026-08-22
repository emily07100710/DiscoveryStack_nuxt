# AutoGEO 官方資產盤點

本盤點固定 AutoGEO upstream `49456df236774ea24087c44f45e9e52005b8e6a4`，沒有 Git submodule。全部精確檔案清單、LFS SHA-256、檔案大小、資料集 split/row count 與 column schema 由 `sync_assets.py` 從官方公開 API 重建至 repository 外 cache；不提交任何資料列、模型、cache 或 checkpoint。

## Upstream 與依賴

| 項目 | 固定或官方要求 | 意義 |
|---|---|---|
| AutoGEO | MIT；commit `49456df236774ea24087c44f45e9e52005b8e6a4`; LICENSE SHA-256 `7db440f0a16ee1bb2b77726e9c693a6171667069c6ac1679efbb2c2fe41cf0b3` | 研究 code 的唯一 upstream。 |
| Core requirements | Python（未釘版本）、Transformers（未釘版本）、datasets >=2.14.0、huggingface-hub >=0.19.0、pandas >=2.0.0、numpy >=1.24.0 | adapter 在讀取 model 前會以 Qwen 官方要求確認 Transformers >=4.51.0。 |
| API dependencies | google-generativeai >=0.3.0、openai >=1.0.0、anthropic >=0.8.0 | 僅在獲核准並有環境變數 key 時可做最多 3 筆的 API smoke。 |
| Mini training only | CUDA >=11.8、A100 40GB+ 建議、約 50GB disk、vLLM 0.8.5.post1、TRL 0.22.0、FlashAttention 2.5.8、open-r1、LLaMA-Factory | 不會在這個 foundation、Autoscale 或免費 smoke 中安裝或啟動。 |

## Dataset inventory

| Dataset | 目前 public revision | License | 主要 configs / rows | 主要欄位 | 用途與限制 |
|---|---|---|---|---|---|
| `cx-cmu/E-commerce` | `89e460876fcf5a45f999224a6e709ffb66cf1a5b` | MIT | main 1,664 train / 416 test；rule_candidate 1,664；cold_start 484；inference 416；grpo_input 1,664；grpo_eval 1,664 | main: query_id, query, target_id, text_list；rule_candidate: bad_document/good_document | 用於 E-commerce engine/domain；不是 DiscoveryStack training admission。 |
| `cx-cmu/GEO-Bench` | `585e75104cad55e4a99460cff8e48300b99fe96b` | MIT | main 7,998 train / 1,000 test；rule_candidate 7,998；cold_start 3,398；inference 1,000；grpo_input/eval 7,998 | 與 E-commerce 相同的 query/document schema，GRPO eval 另含原始 object/keypoint 結構 | English release；需重新完成繁中、授權、PII 與 domain review。 |
| `cx-cmu/Researchy-GEO` | `6d3a76e91f6a0b52e4390484ed1b9291ee681bba` | MIT | main 9,998 train / 1,000 test；rule_candidate 9,998；cold_start 4,976；inference 1,000；grpo_input/eval 9,998 | 與 GEO-Bench 相同的主要 schema | English research domain；不得直接混入現有 public-intelligence manifest。 |

## Model inventory

| Model | Public license / format | Base / target engine | 適用與限制 |
|---|---|---|---|
| `cx-cmu/AutoGEO_mini_Qwen1.7B_Ecommerce` (`34e822f…`) | MIT; Transformers; BF16 safetensors; 約 2B params | Qwen3-1.7B; E-commerce; gemini-2.5-flash-lite | 僅作 local fixture manifest/config smoke 的首選 checkpoint；跨 engine、domain、繁中時需 post-train。 |
| `cx-cmu/AutoGEO_mini_Qwen1.7B_GEOBench` (`704b3fe…`) | MIT; Transformers; BF16 safetensors; 約 2B params | Qwen3-1.7B; GEO-Bench; gemini-2.5-flash-lite | 英文 benchmark domain 產物；禁止直接佈署。 |
| `cx-cmu/AutoGEO_mini_Qwen1.7B_ResearchyGEO` (`1b3dee2…`) | MIT; Transformers; BF16 safetensors; 約 2B params | Qwen3-1.7B; Researchy-GEO; gemini-2.5-flash-lite | 英文 research domain 產物；禁止直接佈署。 |
| `Qwen/Qwen3-1.7B-Base` (`ea980cb…`) | Apache-2.0; causal LM; BF16 safetensors | 1.7B pretraining base | AutoGEO Mini 的 base lineage；不是改寫器本身。 |
| `Qwen/Qwen3-1.7B` (`70d244c…`) | Apache-2.0; causal LM; 28 layers; 32,768 context | 1.7B post-training parent | 支援多語言聲稱，但 DiscoveryStack 仍必須有繁中評測與人工 gate。 |

官方模型 manifest 顯示每個 1.7B checkpoint 的主 `model.safetensors` 約 3.44 GB；任何下載都只能進 external cache，且 `verify_assets.py` 必須比對 Hub 宣告的 LFS SHA-256。AutoGEO-Mini 檔案格式除 safetensors、tokenizer / chat template / generation config 外，也可能帶有 trainer state；後者不構成可重訓或可直接用於 production 的證明。

## 商業與語言判斷

MIT / Apache-2.0 是商業採用的必要條件，但不是充分條件。每次使用仍須核對特定資料集內容、上游資料來源、服務條款、使用者同意、PII、版權、繁中 factuality 與人工核准。AutoGEO 官方模型卡標示 `en`，因此 **不適合直接用於 DiscoveryStack 的繁體中文內容**；可作為受控 research baseline，但需本地 rule extraction、配對資料與再訓練後才可能評估產品適用性。

## References

[1]: https://github.com/cxcscmu/AutoGEO "AutoGEO official repository"
[2]: https://huggingface.co/datasets/cx-cmu/E-commerce "E-commerce dataset card"
[3]: https://huggingface.co/datasets/cx-cmu/GEO-Bench "GEO-Bench dataset card"
[4]: https://huggingface.co/datasets/cx-cmu/Researchy-GEO "Researchy-GEO dataset card"
[5]: https://huggingface.co/cx-cmu/AutoGEO_mini_Qwen1.7B_Ecommerce "E-commerce Mini model card"
[6]: https://huggingface.co/Qwen/Qwen3-1.7B "Qwen3-1.7B model card"

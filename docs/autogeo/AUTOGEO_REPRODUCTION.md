# AutoGEO 重現與 Smoke 驗證契約

本文件定義「重現研究基底」而非「確認模型有效」。這個 branch 不會做 SFT、GRPO、完整 benchmark、API 消費、網站發布或 production inference。

## 固定輸入與輸出

執行者必須將 AutoGEO clone 放在 repository 外，使用 `AUTOGEO_UPSTREAM` 指向固定 commit，並將所有 manifest、datasets、weights 與 runtime outputs 放在 `AUTOGEO_CACHE_DIR`。`sync_assets.py` 會獲取官方 public metadata，包含 Hub revision、license、file size、LFS SHA-256、dataset configs、splits、row counts 和 columns。`verify_assets.py` 必須在任何模型或資料下載後重跑。

| Smoke layer | 指令 | 合格條件 | 不可宣稱 |
|---|---|---|---|
| Upstream identity | `git -C "$AUTOGEO_UPSTREAM" rev-parse HEAD` | 與 inventory SHA 相同。 | 模型品質。 |
| Public asset manifest | `python3 ml/autogeo/sync_assets.py --output "$AUTOGEO_CACHE_DIR/asset-manifest.observed.json"` | 3 datasets、5 models 皆有合法 SHA 與預期 license。 | 已下載資料或權重。 |
| Asset verification | `python3 ml/autogeo/verify_assets.py --manifest ...` | JSON status `passed`。 | Dataset content quality 或商用全面核可。 |
| AutoGEO import | `PYTHONPATH="$AUTOGEO_UPSTREAM" python3 -c 'import autogeo'` | import 成功或記錄缺失依賴。 | rewriter 已驗證有效。 |
| Tokenizer/config | 僅對一個 external-cache checkpoint 以 Transformers 載入 config/tokenizer。 | 不讀取客戶內容、不產生改寫。 | 模型可以在 production 運作。 |
| Vanilla pipeline | `evaluate_baseline.py --fixture ...` | 有 input hash、engine、GEO/GEU null、factuality/quality not_evaluated。 | GEO/GEU 有效分數。 |
| API smoke | 明示 `--allow-live-api` 與官方 provider key 才可執行，最多 3 fixture。 | 完整記錄 engine/version/time，不寫入 key。 | 未有 key 時的結果。 |
| Mini smoke | 有 GPU/RAM 才使用 **一個** checkpoint 做 1–3 fixture；不做 benchmark。 | 使用 revision/hash 記錄，人工檢閱 output。 | 完整 benchmark 或可自動發布。 |

## 機器與成本邊界

官方 `install_mini.sh` 建議 CUDA 11.8+、約 50GB disk 和 A100 40GB+，用於 vLLM、FlashAttention、open-r1、LLaMA-Factory 的 Mini training。故免費／CPU sandbox 僅能可靠執行 metadata、import、fixture baseline、config/tokenizer（若權重可下載）與 unit tests；不應冒充完成推論或訓練。

外部 API 成本無法從官方 repository 可靠固定，會依 Gemini/OpenAI/Anthropic 當期方案、token 與 throughput 改變，因此這個 foundation 報告為 **未估計、未消費**。兩張 A100 的需求只適用於後續大規模 AutoGEO Mini training／GRPO 研究，不能自動外推為 DiscoveryStack 上線成本。

## 禁止項目

所有 customer content、production URL、crawler output、資料庫資料與敏感變數都不可以作為 smoke input。任何 output 必須保留 input hash、model revision、dataset/rule revision、engine、execution time、GEO/GEU，以及 factuality/quality status；若沒有受控 engine response，分數必須是 `null`。

## References

[1]: https://github.com/cxcscmu/AutoGEO/blob/main/install_mini.sh "AutoGEO Mini official installation requirements"
[2]: https://huggingface.co/Qwen/Qwen3-1.7B "Qwen3-1.7B official model card"

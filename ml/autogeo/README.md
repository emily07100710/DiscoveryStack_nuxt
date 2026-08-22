# DiscoveryStack AutoGEO Research Adapter

這個目錄是**研究隔離層**，不是 Nuxt runtime、不是發佈器、也不是訓練腳本。它透過 repository 外固定的 AutoGEO checkout 及 Hugging Face 的公開 metadata API 建立可稽核資產 manifest。它不含 AutoGEO 上游程式碼、資料集本文、模型權重、checkpoint、API key 或客戶內容。

## 安全預設

所有 CLI 預設只允許 `tests/fixtures/` 內的 synthetic 文件。`autogeo_api` 必須同時給出 `--allow-live-api` 與對應的環境變數；沒有 key 時會回報 `blocked_missing_api_key`，而不會假造結果。`autogeo_mini` 需要明確的 `--allow-model-load`，且權重只能留在 `$AUTOGEO_CACHE_DIR`，不得置於本 repository。

| 指令 | 作用 | 預設網路／模型行為 |
|---|---|---|
| `sync_assets.py` | 擷取官方 metadata、revision、license、檔案 manifest 與 dataset schema | 僅 GET 公開 metadata；不下載資料或權重。 |
| `verify_assets.py` | 檢查 manifest source、revision、license 與可選的本機 SHA-256 | 離線。 |
| `rewrite_document.py` | 以 fixture 執行 vanilla／API／Mini 路徑 | vanilla 不呼叫模型；API 與 Mini 都需明示 opt-in。 |
| `evaluate_baseline.py` | 為 fixture 產生可追溯的 baseline evaluation record | 未取得 generative-engine response 時，GEO／GEU 為 `null`，不捏造分數。 |

## 快速開始

```bash
export AUTOGEO_UPSTREAM=/home/ubuntu/.cache/autogeo-upstream
export AUTOGEO_CACHE_DIR=/home/ubuntu/.cache/discoverystack-autogeo
python3 ml/autogeo/sync_assets.py --output "$AUTOGEO_CACHE_DIR/asset-manifest.observed.json"
python3 ml/autogeo/verify_assets.py --manifest "$AUTOGEO_CACHE_DIR/asset-manifest.observed.json"
python3 ml/autogeo/evaluate_baseline.py --fixture ml/autogeo/tests/fixtures/synthetic_product_page.txt
python3 -m unittest discover -s ml/autogeo/tests -v
```

## 固定 import 與 metadata smoke

請在 repository 外的 AutoGEO checkout 執行本目錄的 `requirements.lock`，並將
`NLTK_DATA` 指向 Git ignore 的 research cache。`scan_upstream_imports.py` 以 AST
盤點 upstream import，`smoke_upstream_imports.py` 僅 import non-training modules，
`smoke_checkpoint_metadata.py` 則只載入固定 revision 的 config 與 tokenizer；若
cache 含 `.safetensors`、`.bin`、`.pt` 或 `.pth` 會立即失敗。

`vllm` 刻意不納入：官方 Mini optimized inference 會 lazy-import 它，但實際使用
會要求完整 checkpoint，超出本次 import/config/tokenizer/evaluation-only 範圍。完整
依賴樹、NLTK corpus 雜湊與 smoke 證據請見
[`AUTOGEO_DEPENDENCY_AUDIT.md`](../../docs/autogeo/AUTOGEO_DEPENDENCY_AUDIT.md)。

> 只有在已完成授權、供應商、PII、同意與人工審查 gate 後，才可另行設計 DiscoveryStack 的候選改寫實驗。此 adapter 不會寫入資料庫、呼叫網站 API 或自動發布內容。

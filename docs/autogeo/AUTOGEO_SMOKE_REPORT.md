# AutoGEO Foundation Smoke Report

> **結論：通過。** 本報告只證明 research foundation 的 metadata、import、tokenizer/config 與 synthetic pipeline 可重現；它**不**證明 AutoGEO 可用於 DiscoveryStack 正式改寫、繁體中文品質、GEO 成效、SFT、GRPO 或 production inference。

## 執行範圍與環境

| 項目 | 觀測結果 |
|---|---|
| 執行日期 | 2026-08-22（GMT+8） |
| AutoGEO upstream | `cxcscmu/AutoGEO`，commit `49456df236774ea24087c44f45e9e52005b8e6a4`，保留於 repository 外部 research cache |
| 執行環境 | Ubuntu x86_64、6 CPU、3.8 GiB RAM、30 GiB 可用磁碟、未偵測 GPU |
| Python research runtime | 系統 Python 3.12；依賴僅由 `ml/autogeo/requirements.lock` 定義，未寫入 `nuxt-app/package.json` 或 Nuxt runtime |
| NLTK | `nltk==3.9.2`；唯一必要 corpus 為 `punkt_tab`，位於 ignored external cache，SHA-256 `e57f64187974277726a3417ca6f181ec5403676c717672eef6a748a7b20e0106` |
| 禁止路徑 | 未呼叫 OpenAI、Anthropic、Google 或任何付費 API；未下載 model weights；未執行 SFT／GRPO／vLLM；未讀取客戶內容、production DB 或部署服務 |

## 最終驗證結果

| 驗證 | 指令／條件 | 結果 |
|---|---|---|
| 靜態 import 掃描 | `scan_upstream_imports.py` 對 pinned upstream 做 AST scan | 通過；35 個 non-training importable modules 作為研究依賴依據。 |
| Asset manifest | `verify_assets.py --manifest ml/autogeo/asset-manifest.example.json` | 通過；revision、license 與已記錄的 LFS SHA-256 格式有效。 |
| Full non-training import | `NLTK_DATA=<external-cache> smoke_upstream_imports.py --upstream <pinned-upstream>` | 通過；imported modules `35`。未初始化 rewrite、未存取 dataset、未載入 weights。 |
| Config/tokenizer metadata | `smoke_checkpoint_metadata.py`，`cx-cmu/AutoGEO_mini_Qwen1.7B_Ecommerce@34e822fefbd2f99584018206f70bc4b51a155053` | 通過；`config_model_type=qwen3`、tokenizer vocab `151643`、weight files `[]`。 |
| Vanilla fixture pipeline | `evaluate_baseline.py --fixture synthetic_product_page.txt` | 通過；`auto_publish=false`、`generative_engine_response=not_requested`、GEO/GEU score 為 `null`。 |
| Python unit tests | `python3 -m unittest discover -s ml/autogeo/tests -v` | 通過；5/5。涵蓋 fixture-only、customer path 拒絕、API mode fail-closed、完整 pinned inventory 與不完整 manifest 拒絕。 |
| Dependency integrity | `python3 -m pip check` | 通過；`No broken requirements found.` |
| Application compatibility | `pnpm typecheck`（`nuxt-app`） | 通過；research-only 文件與 Python adapter 未改變 Nuxt 型別契約。 |
| Content safety | `git diff --check`、secret patterns、prohibited artifact、large file 掃描 | 通過；未偵測資料集、權重、checkpoint、dump、token、`.env` 或大檔。 |

## 一次性診斷與修正

最終整合 smoke 起初使用了錯誤的 40 字元 checkpoint revision，因此 Hugging Face cache 產生 `.no_exist/.../config.json` 標記，`AutoConfig` 回報無法識別模型。這不是缺少 Python dependency，也不是模型格式錯誤。

官方 Hub metadata 顯示的實際 SHA 為 `34e822fefbd2f99584018206f70bc4b51a155053`。清除僅屬錯誤 revision 的**外部 cache 記錄**後，使用該 SHA 重跑 metadata smoke 即通過。沒有安裝新套件、沒有下載任何 `.safetensors`、`.bin`、`.pt` 或 `.pth` 檔。

## 未驗證或刻意禁止的項目

1. 不驗證 AutoGEO-Mini 的 model-weight inference，因為這會下載約 3.4 GB checkpoint 並超出 foundation scope。
2. 不驗證 SFT、GRPO 或 vLLM。上游模型訓練與高效推論需額外硬體、資料、成本與安全核准。
3. 不驗證第三方生成 API；資料、prompt、月度 token budget、provider 及 kill-switch 尚未由 owner 核准。
4. 不將公開英文 benchmark 或 checkpoint 視為繁體中文 SEO/GEO production model，也不啟用任何網站 inference。

更多依賴、corpus 與命令證據請見 [AUTOGEO_DEPENDENCY_AUDIT.md](./AUTOGEO_DEPENDENCY_AUDIT.md)，資產來源與授權請見 [AUTOGEO_INVENTORY.md](./AUTOGEO_INVENTORY.md)。

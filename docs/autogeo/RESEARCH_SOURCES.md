# AutoGEO 官方研究來源快照

本文件只保存截至 2026-08-22 的公開來源摘要與 URL；它不是模型、資料集或任何受保護資料的副本。完整、可機器驗證的 revision、license、檔案 manifest 與大小會由 `ml/autogeo/sync_assets.py` 在 repository 外的 cache 建立。

| 來源 | 已核對事實 | 用途 |
|---|---|---|
| AutoGEO 官方 repository | 預設分支為 `main`；檢視時最新 commit 為 `49456df236774ea24087c44f45e9e52005b8e6a4`；repository 宣告 MIT License；README 說明 rule extraction、AutoGEOAPI、AutoGEOMini 三部分。 | 固定 upstream code 與重現邊界。 |
| AutoGEO 論文 | 論文為 *What Generative Search Engines Like and How to Optimize Web Content Cooperatively*；提出由規則抽取、prompt-based API 改寫和 rule-based reward 的 Mini 訓練組成。 | 說明方法與產品差距。 |
| AutoGEO-Mini 官方模型卡 | E-commerce、GEO-Bench、Researchy-GEO 三個模型卡皆標示 `mit`、Transformers、Safetensors、BF16、約 2B params；各卡明示訓練目標是 `gemini-2.5-flash-lite` 加上對應資料集，跨 engine 或 dataset 需要以 Qwen/Qwen3-1.7B post-train。 | 確認模型不可直接宣稱適用於 DiscoveryStack 或繁體中文。 |
| Qwen/Qwen3-1.7B 官方模型卡 | 標示 Apache-2.0、因果語言模型、1.7B parameters、28 layers、32,768 context，並宣稱支援 100+ languages/dialects；卡片要求 Transformers 4.51.0 以上以識別 `qwen3`。 | 釐清 base model 授權、規模與多語言能力並非 AutoGEO 專屬驗證。 |

> AutoGEO 官方 README 明確限制：規則抽取依賴 generative engine 與資料集／domain；切換 engine 或 domain 時，必須重新抽取 AutoGEOAPI 規則並重訓 AutoGEOMini。這是本分支不直接啟用自動改寫或自動發布的核心理由。

## References

[1]: https://github.com/cxcscmu/AutoGEO "AutoGEO official repository"
[2]: https://arxiv.org/abs/2510.11438 "What Generative Search Engines Like and How to Optimize Web Content Cooperatively"
[3]: https://huggingface.co/cx-cmu/AutoGEO_mini_Qwen1.7B_Ecommerce "AutoGEO Mini — E-commerce model card"
[4]: https://huggingface.co/cx-cmu/AutoGEO_mini_Qwen1.7B_GEOBench "AutoGEO Mini — GEO-Bench model card"
[5]: https://huggingface.co/cx-cmu/AutoGEO_mini_Qwen1.7B_ResearchyGEO "AutoGEO Mini — Researchy-GEO model card"
[6]: https://huggingface.co/Qwen/Qwen3-1.7B "Qwen3-1.7B official model card"

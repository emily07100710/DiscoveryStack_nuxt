# Google Colab 本地 SEO/GEO 多任務訓練

本方案把 Hugging Face Jobs 改為 **Google Colab 本地執行**。它仍使用 DiscoveryStack 已核准的 101 筆 immutable manifest，不新增、不替換、不重新標註資料。

## 取得真實資料

請從 DiscoveryStack owner-only Audit Lab 取得已核准 manifest 的訓練資料 JSONL。JSONL 必須來自 manifest 的 101 個 frozen members；不可使用範例資料、手動湊數或公開分享原文。建議每行至少包含 `id`、`text` 或 `trainingText`、`targets`、`split`、`manifestHash`。若目前 Audit Lab 只顯示摘要而沒有下載按鈕，先不要自行重建資料；需要在 owner-only session 中加入受控 JSONL export，或由專案管理介面提供下載。

## 執行方式

1. 開啟 `colab/DiscoveryStack_SEO_GEO_101.ipynb`。
2. 將執行階段切換為 GPU；以 `nvidia-smi` 確認實際取得 GPU。免費 Colab GPU 是動態分配，可能沒有 GPU、會中斷或有時間限制。
3. 上傳從 owner-only manifest 匯出的 `discovery-stack-101.jsonl`。
4. Notebook 會 fail-closed 驗證：總數必須為 101、五個 journey stage 各至少 10 筆、每筆都必須有多維 targets、split 必須是 manifest 已指定的 `train`／`validation`／`test`，並檢查 duplicate IDs 與 manifest hash 一致性。
5. Notebook 使用 `distilbert-base-multilingual-cased` 的共享 encoder，建立 journey stage、search intents、content types、audience roles、geo signals、citation readiness、technical SEO signals、friction signals 與 action priority 多個 classification heads。
6. 訓練完成後，下載 `colab-training-artifacts.zip`，其中包含 metrics、configuration、split counts、manifest hash、validation predictions 與 checkpoint。這些輸出只能宣稱為 **Colab local training**，不能冒稱 Hugging Face Jobs remote job。

## 安全與治理

Notebook 不需要 Hugging Face token。除非要把模型上傳 Hub，否則不要設定 token，也不要把 token 寫入 notebook。原始資料與 checkpoint 只放在本次 Colab session 或你自己的 Google Drive 私有資料夾，不要 commit 到 GitHub。

目前 Hugging Face Jobs 的 403 ledger 應保留為未啟動證據；Colab 成功後，應記錄 notebook execution timestamp、manifest hash、資料筆數、split counts、每個 task 的 metrics 與 checkpoint SHA-256，並在 DiscoveryStack 的治理紀錄中標示 provider=`google_colab_local`。

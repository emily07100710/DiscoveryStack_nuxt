# r14 ML Workbench 正式驗證

驗證時間：2026-08-17（使用既有 owner session）

正式 `https://discovstack-kfpqmdfb.manus.space/ml-lab-preview` 已回傳 r14 Nitro release。工作台顯示 **1** 個已核准來源、**0** 個已清洗頁面與 **0** 次已完成抓取。

唯一已核准來源已安全預選為 **Google Search Central Documentation（CC BY 4.0） · training candidate**。頁面仍明確限制每次抓取最多 10 頁、最大深度 2、HTTPS HTML、同網域、無 raw HTML／正文保存，並顯示無可提交的公開 dataset manifest。

截至本紀錄，尚未建立任何候選資料、未建立 manifest，亦未提交 Hugging Face 遠端訓練。

使用者已確認後續在此限定來源下進行最多 120 個候選 URL 的受限收集。第一批仍維持產品原有單次上限：10 頁、最大深度 2；在實際表單提交前，候選資料、資料集 manifest 與遠端訓練均尚未建立。

第一批表單已填入 `https://developers.google.com/search/docs`，唯一已核准來源由工作台安全預選，單次頁數上限已設為 10。此時仍未按下「啟動受限抓取」。

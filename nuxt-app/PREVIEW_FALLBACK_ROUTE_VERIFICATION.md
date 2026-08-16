# 受管 Preview Fallback 路由驗證

當 `.output/public` 在受管環境缺失時，`create-visual-preview.mjs` 現在會由正式 production 擷取四條核心公開路徑，並以本機 CSS 和受限 interaction runtime 提供 3000 preview：`/en`、`/zh-hant`、`/en/services/seo-geo-growth-system`、`/zh-hant/services/seo-geo-growth-system`。

正式 production 請求加上五秒逾時，避免單一外部請求阻止預覽服務啟動。若全部請求均不可用，才退回已驗證的雙語首頁快照，因此公開內容頁不再依賴那兩份一次性首頁檔案。

| 路徑 | 第一輪重啟後實測 |
| --- | --- |
| `/en` | HTTP 200，首頁內容可抽取。 |
| `/zh-hant` | HTTP 200，繁中首頁內容可抽取。 |
| `/en/services/seo-geo-growth-system` | HTTP 200，英文標題、answer-first、四層工作表及延伸閱讀可呈現。 |
| `/zh-hant/services/seo-geo-growth-system` | HTTP 200，繁中標題、摘要答案、四層工作表及延伸閱讀可呈現。 |

第二輪受管重啟與錯誤字串檢查仍由 `todo.md` 追蹤，完成前不宣稱 preview pipeline 已完全無故障。

## 第二輪重啟結果

第二輪重啟在約四秒內完成 4/4 條 production fallback route 擷取並重新啟動 3000。`/en`、`/zh-hant`、兩個服務頁均由 loopback 實測為 HTTP 200。最新啟動區段未出現 `fetch failed` 或 `Preview route not found`；日誌中較早的 bootstrap 失敗記錄屬於舊版 bootstrap script 的歷史輸出，並非本輪核心 fallback 啟動錯誤。

## 完整靜態輸出恢復

在釋放驗收瀏覽器記憶體後，Nuxt static generate 成功 prerender 40 條輸出路由並重建 `.output/public`。受管 preview 隨後改由這份完整輸出啟動；16 條 EN／ZH-Hant 公開內容 URL 逐一回應 HTTP 200。對 `.output/public` 的掃描亦確認不存在 `/manus-storage/` 參考，因此 preview 不再依賴會出現 404 的品牌資產路徑。

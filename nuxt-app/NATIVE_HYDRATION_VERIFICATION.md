# 原生 Nuxt Hydration 驗證

完整 `.output/public` 恢復後，受管 static preview 可用 `?nuxt=1` 開啟未剝除 client bundle 的原生 hydration 診斷路徑。

| 路徑 | 結果 |
| --- | --- |
| `/en?nuxt=1&hydration=post-fix` | 首頁成功顯示，未出現先前的初始化 500／白頁；導覽與 right-bottom AI QA launcher 可辨識。 |
| 英文 AI QA launcher | 實際點擊後 Vue dock 展開，出現 close button、三個快捷提問、`qa-question` 文字輸入欄與送出按鈕。 |
| `/zh-hant?nuxt=1&hydration=post-fix` | 繁中首頁成功顯示，非 500；繁中導覽、EN switch 與 AI QA launcher 均正常。 |
| 繁中 AI QA launcher | 實際點擊後 Vue dock 展開，出現繁中快捷提問、繁中 placeholder、close button 與送出按鈕。 |

因此，原生 Nuxt client hydration 已在英文與繁中 preview 路徑實測完成；這項驗收不同於不載入 Nuxt scripts 的 visual fallback 路徑。

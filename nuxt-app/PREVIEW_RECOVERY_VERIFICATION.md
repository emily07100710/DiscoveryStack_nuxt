# 受管預覽恢復驗證

## 驗證結果

2026-08-16，本專案的受管 Nuxt dev child 在此環境中會短時間後結束，並在 Nitro prerender 中斷時清除 `.output/public`。為先恢復可供檢視的公開首頁，3000 服務改為一個靜態 recovery preview：它以已實際由 Nuxt SSR 取得的英文與繁中首頁快照、當前全域 CSS 及受限的 preview interaction runtime 提供畫面。

| URL | 實測結果 | 主要確認內容 |
| --- | --- | --- |
| `/en?recovery=confirmed` | 可載入 | 完整英文首頁、淺色視覺、右下 AI QA icon、scroll-story 初始內容。 |
| `/zh-hant?recovery=confirmed` | 可載入 | 繁中首頁、語言切換連結、淺色 hero 與主要段落。 |

## 邊界

此 recovery preview 的目的，是讓使用者可再次預覽首頁而非取代正式 Nuxt／Nitro runtime。它不宣稱已恢復 private Audit Lab、Lead API、所有內容頁或最新 SSR hydration 行為；那些項目仍需在正常 Nuxt runtime 與完整 static generate 可穩定執行後重新驗收。

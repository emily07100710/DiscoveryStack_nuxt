# 參考式視覺驗收

驗收依據是 DiscoveryStack 的「私人銀行 × 控制室」方向，而非對任何參考網站進行逐頁複製。桌機中段 scroll-story、375px 英文首頁、375px 繁中首頁均以正式 production runtime 擷取。

| 項目 | 實測結果 |
| --- | --- |
| 紙張與色彩 | 暖米主背景、淺藍灰場景面、深墨閱讀字與少量 cobalt／黃銅訊號在桌機與手機一致；紙張顆粒為非互動層。 |
| 英文排印 | Newsreader display 於 375px hero 以縮小後多行節奏呈現，正文使用 Manrope 並維持清晰層級。 |
| 繁中排印 | Noto Serif TC 與英文 SEO／GEO 混排在 375px 不溢出；標題、摘要、journey scene 與表單維持可分辨的段落距離。 |
| 可逆故事 | 正式桌機中段截圖顯示 `02 / 04`、同步路徑、場景核心與 Clarity 文案。CDP 實測前進至 progress `0.6499`／active scene `03` 後回捲至 progress `0.0399`／active scene `01`；`--scene-turn` 同步由 `0.6499` 回到 `0.0399`。 |
| 手機輸入與游標 | 手機畫面沒有 desktop custom cursor 層；journey 視覺以垂直閱讀排列，沒有覆蓋主要文字。 |
| AI QA safe-area | 收合 launcher 位於手機右下邊緣內側，沒有覆蓋首頁 hero CTA 或 fit-review 的主要提交按鈕；展開／鍵盤驗收另載於 `AI_QA_ACCESSIBILITY_VERIFICATION.md`。 |

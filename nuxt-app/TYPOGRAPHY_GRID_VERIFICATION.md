# 排印與閱讀格線驗證

本輪將操作型 UI 收斂至 Manrope，英文的策略性大標與長段顯示字改為 Newsreader，繁中的 display text 使用 Noto Serif TC。程式碼保留系統字體 fallback，因此外部字型暫時不可用時仍可閱讀。

| 視窗與路徑 | 實測結果 |
| --- | --- |
| 桌機首頁 | 10vw 上限式 gutter 與 1180px 頂層閱讀格線保留充足留白；76px fixed blur header 維持內容起始位置。 |
| 375×812 `/en` | Newsreader 換行保持清楚層次，摘要與 CTA 未與右下 AI QA launcher 重疊。 |
| 375×812 `/zh-hant` | Noto Serif TC hero 及正文換行自然，繁中導覽、EN switch 與開場文案均未水平溢出。 |
| 正式桌機 `/en/services/seo-geo-growth-system` | Newsreader 的英文 service title、answer-first 與正文閱讀階層清楚；1180px 頂層格線下的內文欄維持可讀行長。 |
| 正式桌機 `/zh-hant/services/seo-geo-growth-system` | Noto Serif TC 與 SEO／GEO 拉丁字混排正常；摘要答案、表格欄位與延伸閱讀均由服務頁實際 SSR 輸出。 |
| 正式 375px `/en/services/seo-geo-growth-system` | 實測 `scrollWidth` 為 375px，沒有水平溢出；英文 display title、answer-first、正文與四層工作表皆在窄欄內保持閱讀順序。 |
| 正式 375px `/zh-hant/services/seo-geo-growth-system` | 實測 `scrollWidth` 為 375px，沒有水平溢出；Noto Serif TC、SEO／GEO 混排、摘要與三欄服務表均可辨識。 |

首頁的手機驗收曾使用 static recovery preview；本次新增的內容頁則在正式 Nitro runtime 實測。header 在桌機維持 76px fixed blur 規則，窄 viewport 壓縮為 68px；內容頁採 answer-first、分段 H2、帶欄名的橫列服務表和一列一項的延伸閱讀，確保桌機與手機皆有清楚的閱讀路徑。

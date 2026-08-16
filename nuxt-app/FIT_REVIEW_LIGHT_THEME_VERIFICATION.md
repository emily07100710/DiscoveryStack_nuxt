# Fit-review 淺色表單：對比、Focus 與錯誤狀態驗收

驗收日期：2026-08-16

## 範圍與方法

此驗收聚焦公開首頁的 fit-review 表單，使用由 `pnpm generate` 產生的完整 `.output/public`，並在 `http://127.0.0.1:3000/en?nuxt=1&validation=invalid#fit-review` 的**原生 Nuxt hydration** 路徑進行。驗證腳本為 `scripts/verify-fit-review-invalid-state.mjs`；它只對空白必填表單點擊 submit button，讓 HTML constraint validation 阻止送出，因此不會呼叫 Lead API、建立資料列或留下使用者資料。

| 驗收面向 | 證據與結果 |
| --- | --- |
| 正常淺色輸入辨識 | `main.css` 使用暖灰藍表單底色、深藍文字與髮絲邊線；既有 `brand-direction.contract.test.ts` 會檢查淺色表面、文字與 cobalt focus token 的 WCAG-oriented 對比契約。 |
| Focus-visible | `.fit-review-form :is(input,textarea,select):focus-visible` 套用 cobalt 邊界與 `0 3px 0 var(--cobalt)` 底線，保留明確鍵盤焦點。 |
| 使用者互動後的 invalid state | 空白 submit 後，名稱欄位回傳 `valid: false`、`userInvalid: true`、`borderBottomColor: rgb(141, 60, 71)` 與 `boxShadow: rgba(141, 60, 71, 0.35) 0px 3px 0px 0px`。初始空白欄位不會預先標紅。 |
| 轉場穩定性 | 欄位的 border 與 shadow 使用 160ms `var(--ease)` transition；驗證腳本會等待 260ms 才擷取 computed style，避免把轉場起始影格誤判為未套用狀態。 |
| 實際視覺結果 | `artifacts/fit-review-invalid-state.png` 顯示淺灰藍表面、深藍正常線與明顯但不刺眼的低彩度紅色 invalid 線。 |
| 英文／繁中全頁預覽 | 2026-08-16 以受管 preview 的完整 static build 同步擷取 `/en?nuxt=1&validation=light` 與 `/zh-hant?nuxt=1&validation=light` 桌機全頁畫面；兩者皆顯示暖米色／霧藍閱讀背景、可讀的深藍排印、完整 scroll-story 與 fit-review 表單。 |
| Production SSR HTML 與 CSS | 2026-08-16 以 `curl` 抽樣正式 `https://disco-nuxt-jcrxrcab.manus.space/en` 與 `/zh-hant`；兩者皆為 HTTP 200，具有相應 EN／ZH-Hant H1 與 3 個 hreflang link。發布傳播完成後，兩語首頁均引用 `/_nuxt/entry.CmNWA0vm.css`；正式 CSS 含 2 個 `:user-invalid` 規則，確認本輪錯誤狀態已部署。這輪不改動語意 HTML 或 JSON-LD。 |
| Canonical 的正式網域限制 | 抽樣 production HTML 的 canonical 目前仍為 `https://discoverystack.example/...`。這是尚未綁定自有正式網域前的安全 placeholder，並非可主張的正式 SEO domain；自有網域綁定、canonical 更新、Search Console／Bing 提交仍保留在正式發布人工待辦。 |

## 自動化結果

```text
pnpm vitest run tests/brand-direction.contract.test.ts tests/lead.validation.test.ts tests/accessibility-motion.test.ts
Test Files  3 passed (3)
Tests       10 passed (10)

pnpm generate
Prerendered 40 routes
Generated public .output/public
```

> 此驗收只確認公開 form 的視覺／原生 constraint-validation 邊界；螢幕閱讀器實測與登入後 Audit Lab 的完整鍵盤 walkthrough 仍保留在人工驗收待辦，未被此文件誤標為完成。

# Interactive Scroll-story 綜合驗收

驗收日期：2026-08-16

## 結論與邊界

首頁的 scroll-story 已具備可驗證的桌機連續推進、反向回捲、鍵盤焦點維持、native-hydration pointer、reduced-motion 回退與 SSR 語意內容。這是一份**互動與可及性行為驗收**，不是 Core Web Vitals 成績單；Lighthouse／PageSpeed 的 CLS 與 INP 指標仍必須在綁定自有網域後執行，並保持待辦未完成。

| 面向 | 方法 | 結果 |
| --- | --- | --- |
| 正式桌機連續回捲 | `scripts/verify-scroll-reversibility.mjs`，作用於 production `/en` | 前進時 `progress`／`sceneTurn` 為 `0.6499131944444444`、active scene 為 `03`；回捲後兩者均為 `0.039913194444444446`、active scene 為 `01`；`reversible: true`。 |
| 鍵盤與 pointer | `scripts/verify-preview-keyboard-focus.mjs`，作用於 production `/en` | 第一個 Tab 為「Skip to content」；第二個為首頁品牌連結；場景區 pointer move 前後焦點皆維持 `DISCOVERYSTACK`，`focusPreserved: true`。 |
| Native hydration pointer | `scripts/verify-native-pointer-parallax.mjs`，作用於 native `/en?nuxt=1` | fine-pointer 分支寫入 `--pointer-x: 0.6000000000000001`、`--pointer-y: -0.5`，pointerleave 後均歸零；詳見 `NATIVE_POINTER_PARALLAX_VERIFICATION.md`。 |
| Reduced motion runtime | `scripts/verify-story-reduced-motion.mjs`，作用於 production `/en` | `reducedMotion: true`、sticky 改為 `relative`、核心 transition 為 `0s`，四個 story step 全部為可見／可操作的相對定位內容。 |
| 手機閱讀回退 | `REFERENCE_VISUAL_VERIFICATION.md` 的 production 375px EN／ZH 截圖 | 手機不使用 desktop custom cursor，story 轉為垂直閱讀且不覆蓋主要文案。 |
| 未 hydration 的語意內容 | `tests/accessibility-motion.test.ts` 與 `tests/public-html-snapshots.test.ts` | 產生的公開 HTML 保有正確 H1／H2 階層、表單 label、story heading 與可爬取內容；全量 52 tests 通過。 |

## CLS／INP 風險處理

實作層將 animation 限定於 `transform`、`opacity`、scroll progress 與 `transition`，並透過 CSS `@media (prefers-reduced-motion: reduce)` 移除 sticky／動畫路徑。這降低 layout-shift 與不必要互動負擔的風險，但不等同於真實 lab 或 field 指標。

> 本專案未聲稱已取得 CLS、INP 或 Lighthouse 分數。自有正式網域、Search Console 與 PageSpeed 的人工驗收仍是 SEO/GEO production readiness 的必要後續步驟。

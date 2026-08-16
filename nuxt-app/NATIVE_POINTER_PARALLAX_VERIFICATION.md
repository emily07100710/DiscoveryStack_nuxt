# Native Hydration Pointer／Parallax 驗證

驗證日期：2026-08-16

## 目標

驗證首頁 `JourneySequence` 在**正常 Nuxt hydration URL** 中，當使用者裝置具有 fine pointer 且未要求減少動態效果時，會執行既有 pointer/parallax 分支；並確認 pointer 離開場景後可回到中性位置。

## 方法與範圍

執行 `scripts/verify-native-pointer-parallax.mjs`，目標 URL 為：

```text
http://127.0.0.1:3000/en?nuxt=1&pointer=verify
```

headless Chromium 本身不宣告硬體 `pointer: fine`，會讓產品現有的保護條件刻意關閉互動。因此腳本只在**測試瀏覽器的載入前**覆寫 `(pointer: fine)` 的 `MediaQueryList`；產品來源、正常 hydration URL、`JourneySequence.vue` 與 SSR 內容均未修改。這使測試能走進與實際桌機 fine-pointer 相同的既有程式分支，而不會誤把 headless 硬體限制當成產品失敗。

## 結果

```json
{
  "pointerFine": true,
  "reducedMotion": false,
  "moved": { "x": "0.6000000000000001", "y": "-0.5" },
  "reset": { "x": "0", "y": "0" },
  "hasStoryText": true
}
```

| 檢查 | 結果 |
| --- | --- |
| Hydrated fine-pointer guard | 通過；`pointerFine: true` 且 `reducedMotion: false`。 |
| Pointer move | 通過；canvas 寫入 `--pointer-x: 0.6000000000000001` 與 `--pointer-y: -0.5`。 |
| Pointer leave | 通過；兩個變數均回復為 `0`。 |
| SSR／語意內容 | 通過；`.story-step h3` 在同一 DOM 中存在。 |

> 此結果不取代真實使用者裝置的體感驗收；它確認 Nuxt hydration 後的可執行 pointer 分支、保護條件與 reset 行為。`prefers-reduced-motion` 的產品回退仍由既有 accessibility/motion regression 覆蓋。

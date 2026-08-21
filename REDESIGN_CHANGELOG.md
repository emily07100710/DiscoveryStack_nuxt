# DiscoveryStack UI/UX 重新設計變更記錄

## 2026-08-19 全站重新設計

### 概述
將 DiscoveryStack 網站的 UI/UX 更新為新的設計系統，以暖砂米為底色、鈷藍為訊號色、採用 Noto Serif TC（標題）和 Noto Sans TC（內文）字體。

### 主要變更

#### 1. 字體系統 (`nuxt.config.ts`)
**之前：**
- Manrope（UI 字體）
- Newsreader（標題字體）
- Noto Serif TC（中文支援）

**之後：**
- Noto Sans TC（內文，支援繁體中文）
- Noto Serif TC（標題，600/700/900 粗細）
- DM Mono（編號和標籤，保持不變）

#### 2. 新設計系統 CSS (`assets/css/redesign.css`)
創建了全新的設計系統 CSS 檔案，包含：

**色彩 Tokens（淺色模式）：**
```css
--sand:        #EFEAE0  /* 暖砂米主底色 */
--sand-deep:   #E5DFD2  /* 深砂米區段底色 */
--paper:       #FAF7F1  /* 紙白浮起元素 */
--ink:         #1A1D23  /* 墨色主文字 */
--ink-mid:     #4A463E  /* 中灰次要文字 */
--ink-soft:    #6E6659  /* 暖灰輔助文字 */
--cobalt:      #2C3E8F  /* 鈷藍訊號色 */
--cobalt-lift: #3E52AD  /* 鈷藍懸停色 */
```

**深色模式支援：**
- 自動偵測系統偏好 `(prefers-color-scheme: dark)`
- 可手動設定 `data-theme="dark"`

**主要組件樣式：**
- 路徑軌（Route Rail）：固定在左側的進度指示器
- 頁首（Site Header）：sticky 導覽，支援行動版選單
- Hero 區段：巨大標題，逐行揭露動畫
- 方法區段：承諾列表，細線分隔
- 需求路徑：sticky 巨大編號 + 互動步驟
- AI QA 區段：對話框展示
- 合作諮詢表單：乾淨的表單設計
- 頁尾：完整的導覽連結和標語

#### 3. Layout 更新 (`layouts/default.vue`)
**主要改進：**
- 新增路徑軌（route-rail）固定元素
- 更新頁首結構，包含行動版選單切換
- 完整的頁尾導覽連結結構
- 新增導覽狀態管理（navOpen）
- 新增頁首 sticky 狀態（headerStuck）
- 支援錨點導覽（#approach, #journey, #qa, #fit）

#### 4. 首頁重構 (`pages/index.vue`)
**新增功能：**
- Hero 標題逐行揭露動畫
- 捲動驅動的元素揭露（Intersection Observer）
- 全站進度軌更新
- 需求路徑 sticky 編號互動
- 完整的四步需求路徑展示：
  1. 被找到 / 抵達
  2. 被理解 / 理解
  3. 被相信 / 信任
  4. 被推進 / 推進
- AI QA 對話框展示
- 合作諮詢表單（含蜜罐防護）
- 支援繁體中文和英文內容

#### 5. 互動腳本 (`assets/js/redesign-interactions.js`)
創建了獨立的互動腳本檔案，包含：
- Hero 逐行揭露
- 捲動驅動的元素揭露
- 全站路徑進度軌
- 需求路徑 sticky 編號同步
- 行動版導覽切換

### 設計原則

1. **語意化優先：** HTML 結構完整，動畫只是增強
2. **無障礙支援：**
   - 正確的 ARIA 標籤
   - 鍵盤導覽支援
   - 支援 `prefers-reduced-motion`
3. **響應式設計：**
   - 行動版優先
   - 彈性的排版系統
   - 自適應字體大小
4. **效能優化：**
   - 使用 Intersection Observer
   - RAF 節流
   - CSS transitions 替代 JS 動畫

### 移除的元素

- 裝飾性圖形（constellation、orbit）
- 複雜的漸層背景
- 多餘的顏色（金色、黃綠色）
- 過度的動畫效果

### 保留的元素

- DM Mono 字體（編號和標籤）
- 核心的內容結構
- SEO meta 標籤
- i18n 支援

### 待辦事項

1. **測試：**
   - [ ] 在不同瀏覽器測試
   - [ ] 測試深色模式
   - [ ] 測試行動版
   - [ ] 測試無障礙功能

2. **整合：**
   - [ ] 確認與現有 `immersive.css` 的衝突
   - [ ] 整合 JourneySequence 組件（或替換）
   - [ ] 整合 AiQaDock 組件（或替換）
   - [ ] 整合 FitReviewForm 組件（或替換）

3. **優化：**
   - [ ] 檢查 CSS 檔案大小
   - [ ] 考慮將常用樣式提取到共用檔案
   - [ ] 優化字體載入策略

### 使用方式

1. **啟動開發伺服器：**
```bash
cd nuxt-app
pnpm dev:nuxt
```

2. **查看變更：**
- 訪問 `/zh-hant` 查看繁體中文版
- 訪問 `/en` 查看英文版

3. **切換設計：**
如果需要切換回舊設計，修改 `nuxt.config.ts`：
```typescript
css: ['~/assets/css/main.css', '~/assets/css/immersive.css'],
```

### 檔案清單

**新增檔案：**
- `nuxt-app/assets/css/redesign.css` - 新設計系統樣式
- `nuxt-app/assets/js/redesign-interactions.js` - 互動腳本
- `REDESIGN_CHANGELOG.md` - 本文件

**修改檔案：**
- `nuxt-app/nuxt.config.ts` - 字體和 CSS 配置
- `nuxt-app/layouts/default.vue` - Layout 結構和導覽
- `nuxt-app/pages/index.vue` - 首頁完整重構

### 注意事項

1. **pnpm 問題：** 如果遇到 pnpm 權限錯誤，嘗試：
   ```bash
   rm -rf .pnpm-store node_modules
   pnpm install
   ```

2. **樣式衝突：** 新的 `redesign.css` 和舊的 `main.css` 可能有樣式衝突。目前配置使用新設計。

3. **組件整合：**
   - `JourneySequence` 組件需要適配新樣式
   - `AiQaDock` 組件需要適配新樣式
   - `FitReviewForm` 組件需要適配新樣式

### 後續步驟

1. 解決 pnpm 環境問題
2. 測試新設計在瀏覽器中的表現
3. 調整任何樣式衝突
4. 整合或替換現有組件
5. 進行完整的無障礙測試
6. 優化效能

---

*變更完成於 2026-08-19*

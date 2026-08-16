# DiscoveryStack Nuxt 驗收矩陣

最後更新：2026-08-16（GMT+8）

本文件記錄目前可重現的技術驗收結果。它不將尚未取得的使用者登入情境、實際訓練或實驗室效能數據描述為已完成。

| 範圍 | 驗收方法 | 結果 | 說明 |
|---|---|---|---|
| Nuxt 型別安全 | `pnpm typecheck` | 通過 | Nuxt 4.5.2、Nitro routes、雙語前台與資料治理模組均通過。 |
| 行為與治理測試 | `pnpm test` | 52 項通過 | 覆蓋 Lead validation、Audit governance、Public Intelligence policy、typed artifact contract、Hugging Face credential、公開 HTML、SEO SSR initialization、視覺 preview 與 accessibility/motion regression。 |
| 公開路由 HTML | production `.output/public` 掃描 | 通過 | 16 個 EN／ZH-Hant 可索引 HTML 皆有 H1、canonical、`en`／`zh-Hant`／`x-default` alternate、JSON-LD 與內部連結。 |
| 私有路由輸出 | production artifact 路徑檢查 | 通過 | `/audit-lab`、`/en/audit-lab`、`/zh-hant/audit-lab` 不在靜態 public output。Audit Lab 的 lazy browser route 程式碼可包含 endpoint 字串，但不含私有資料、秘密或預渲染 HTML。 |
| 私有 API | 已完成的匿名 smoke test | 通過 | owner-only admin/session guard 對未登入請求回傳 401；完整 owner OAuth round-trip 留待帳號登入驗收。 |
| Lead Capture | Zod tests + 可刪除 API smoke test | 通過 | 未同意為 422、honeypot 不寫入、正常請求可持久化後清除。 |
| Public Intelligence | policy / feature contract / DB schema tests | 通過 | Source Card 的用途中止、使用層級、typed artifact locator/hash、品質 gate 與 dataset manifest lineage 均有程式邊界。 |
| 無障礙與 motion | 靜態語意／CSS regression + production runtime scripts | 通過 | 公開首頁保留標題與表單標籤；focus-visible 規則存在；production scroll-story 已實測可逆回捲、鍵盤 focus 在 pointer 後保持、reduced-motion 改為非 sticky 可讀流程。 |
| Production 產物 | `pnpm generate` | 通過 | 最新產生 40 條路由／payload 輸出；public 目錄為 2,059,707 bytes。 |
| 正式 runtime health | `curl` production smoke test | 通過 | `/en` 為 HTTP 200、HSTS 已啟用；匿名 `/api/admin/session-check` 為 401。 |
| PageSpeed mobile lab | PageSpeed Insights public API，正式 `/en` | 未取得數據 | 2026-08-16 的匿名 request 被 Google `Queries per day` quota 拒絕，因此無 LCP、CLS、TBT 或 INP proxy 可記錄；不可將此解讀為通過。 |

## 效能觀察與限制

首頁使用一張 `fetchpriority="high"` 的視覺 trace；三張 case 視覺使用 `loading="lazy"`。不過在產物目錄中仍可見 Nuxt Content 的 SQLite worker 檔，這些檔案存在於 output 並不等同於首頁 initial execution。靜態產物審核沒有偵測到 private Audit Lab 路徑被 pre-render。

尚未取得受控瀏覽器環境中的 Lighthouse lab data，因此本專案**不宣稱**目前 LCP、CLS 或 INP 已達特定數值。部署至候選正式網域後，應以實際裝置與 production CDN 再執行 Lighthouse / PageSpeed Insights；若 LCP 偏高，先檢查 hero trace 影像尺寸與傳輸格式，再檢查 Google font blocking 與 Nuxt Content runtime chunks。

## 尚待人工驗收

| 項目 | 為何不能以假資料取代 |
|---|---|
| Owner OAuth round-trip | 必須由 owner 實際登入，才可驗證授權服務、cookie 與 local user linkage。 |
| 四個既有公開來源的 Source Card 審核 | robots 是爬取交通規則，不能單獨決定 terms、著作權、PII、保留期限或可用資料用途。 |
| BGE-M3 pilot 與後續訓練 | 需要足量、已同意、去識別、品質通過且具版本的實際候選資料；未達門檻時系統只應顯示 readiness。 |
| 實驗室 Core Web Vitals | 需要 production candidate 網域、目標地區與真實瀏覽器環境，不能由靜態檔案大小推定。 |

## 唯讀原始專案行為對照

| 原始行為 | Nuxt 實作 | 結論 |
|---|---|---|
| 公開 Lead capture 接受有效 email、公司與方案意向，無效 email 在寫入前被拒絕。 | `leadInputSchema` 會正規化 email、要求 privacy consent，且 API 另有 honeypot、節流與去重；`tests/lead.validation.test.ts` 驗證 consent 與 dedupe。 | 已保留並加強資料最小化與寫入前防護。 |
| 公開 assistant 只回答 approved knowledge，對無關問題回傳固定 human handoff。 | `utils/boundedAiQa.ts` 對 SEO/GEO、Audit、AI scope 提供核准回答；所有其他問題回傳明確 strategist handoff；`tests/bounded-ai-qa.test.ts` 驗證英／繁中 fallback 與無 ranking guarantee。 | 已保留，並從原 API 改為首頁 local bounded contract，避免未配置模型時假裝有 live inference。 |
| 公開目標 URL 正規化並拒絕 file、localhost、private IP、metadata IP 與非標準 port。 | `server/audit/targetGuard.ts` 與 governance tests 延續 public-only target boundary。 | 已保留。 |
| 規則 classifier 只將具多個公開證據的 friction 排序，並拒絕由公開結構宣稱真實 conversion 表現。 | Nuxt baseline classifier 輸出 human-review-required assessment；conversion 在缺少第一方授權證據時保持 insufficient evidence。 | 已保留。 |
| human-approved training example 只保存去識別 feature vector，且必須有合格 review、label、同意與品質狀態。 | Nuxt review/training candidate pipeline、consent revoke、dataset/version fields 與 BGE readiness gate 延續此模式。 | 已保留並擴充可撤回與版本 lineage。 |
| 自動 crawler 將公開頁原文清洗為可分析 markdown。 | Nuxt Audit Lab 不啟動未授權 crawler；公開來源改為 Source Card policy review 後，由 owner／策略師新增可複核的 bounded artifact。 | 刻意調整，風險更低，且較符合目前可追溯公開研究資料策略。 |

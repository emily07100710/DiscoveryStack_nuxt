# Production Server Hosting 阻塞紀錄

發現日期：2026-08-16

## 結論

本機 Nuxt source、型別檢查與 OAuth regression 均已更新，但目前正式 domain 仍未載入最新 Nitro server route tree。這是**部署 hosting mode／runtime 選擇**阻塞，不是 OAuth callback、cookie 或前端畫面的可再修正程式問題。

| 檢查 | 觀察結果 | 意義 |
| --- | --- | --- |
| 本機 route | `server/api/oauth/callback.get.ts` 存在，且 `pnpm typecheck`／OAuth contract tests 通過 | Nuxt source 具備官方 callback path。 |
| 正式 `/api/oauth/callback` | 2026-08-16 後續 probe 為 HTTP 400 JSON：`Sign-in callback requires code and state.` | Callback handler 的靜態輸出／edge routing 可回覆輸入驗證，但不能證明整個 Nitro runtime 已啟動。 |
| 正式 `/api/auth/callback` | HTTP 400（無 query parameters） | Production 仍提供舊 callback path。 |
| 正式 login redirect | `/api/auth/login` 仍產生舊 `/api/auth/callback` | Live server 未切換至本機最新 checkpoint route。 |
| 專案設定 | `.project-config.json` 有 db/server/user capabilities，但 `template_id` 為 `web-static` | 部署可能仍按 static hosting 處理，未啟動 Nuxt `.output/server/index.mjs`。 |
| 重新套用 fullstack capability | 平台回應 `web-db-user already enabled` | 不能由 source 端再次 upgrade 修復 template/runtime 對應問題。 |
| Live log 查詢 | runtime log 工具回覆 `cloudrun service not found` | 與 server runtime 未建立或未選用的現象一致。 |
| 正式 `/api/intelligence/ingestion-jobs` | HTTP 404：`Page not found` | 2026-08-16 新增的 owner-only ingestion endpoint 未進入 production route tree。 |
| 正式 `/api/intelligence/inferences` | HTTP 404：`Page not found` | 2026-08-16 新增的 BGE-M3／baseline inference endpoint 未進入 production route tree。 |
| fullstack template 設定嘗試 | 將本機 `.project-config.json` 從 `web-static` 改為 `web-db-user` 後，checkpoint 回覆 `No changes to commit` | 此檔案不是可由 source checkpoint 更新的 production deployment metadata，無法自行重建 runtime。 |
| 最新 OAuth source checkpoint probe | source 已將 state cookie 改為 `SameSite=None`，但 production `/api/auth/login` 仍回傳 `SameSite=Lax` | 正式 API route bundle 沒有載入最新 checkpoint；因此瀏覽器 callback 不能作為最新 source 的驗收。 |

> 這份文件不主張 OAuth 已成功。已完成的內容是：前端正式 origin callback、HTTPS allowlist、nonce-bound state、官方 `clientId`／`grantType`／`redirectUri` exchange payload 與 callback route source。成功 owner session 仍取決於平台將這個 Nuxt server build 部署到正式 runtime。

## 保留的安全邊界

公開 domain 的 `/api/admin/session-check` 仍維持匿名 401。新增 OAuth code 不會以測試帳號或偽造 session 繞過 owner-only guard；待 server hosting 修正後，應重新進行一次完整、真實 owner OAuth round-trip，再驗證 Audit Lab workflow。

## 本次 ML 工作流受影響範圍

本次已在 Nuxt source 新增 `POST/GET /api/intelligence/ingestion-jobs` 與 `POST/GET /api/intelligence/inferences`，使 owner-only Audit Lab 可以對**已經通過 Source Card 政策的來源**執行有界單頁 ingestion、記憶體內 PII 清洗、typed artifact 建立、規則 baseline 與 Hugging Face BGE-M3 結構特徵 similarity。這些 server routes 目前在正式 domain 仍不可達，因此不會對任何外部來源產生實際請求，直到 production 啟動最新 Nuxt Nitro route tree。

## 2026-08-16 更新：ML route tree 已恢復

後續 production probe 已確認 `/api/intelligence/ingestion-jobs` 與 `/api/intelligence/inferences` 都回傳匿名 **401** `Private administration requires an owner session.`，不再是 404。這證實最新 Nuxt Nitro API tree 與 owner-only guard 已載入正式 runtime，原本的 static route tree blocker 已解除。

目前剩餘的私有入口阻塞收斂為 **OAuth provider exchange 在選擇 owner 帳戶後回 401**。state cookie 已確認以 `SameSite=None` 發出且 nonce 403 已消失；因此下一步是針對 provider exchange／application OAuth configuration 進行平台側診斷，而不是重新部署 ML routes。

# 自助建站與客戶所選網域：驗收說明

基準：`feature/self-serve-funnel`，疊在 `3e1b62b064bf9b3e5e2e939a95684b18346dc8cb` 上的變更。這次從原 Fresh Review 1／2／4 擴充至客戶授權的「付款後自動註冊所選網域、設定 DNS／HTTPS、正式部署與交付」。這個變更沒有新增 migration，也沒有購買網域或呼叫真實購買／部署 provider。

## 現在的完整流程

1. 客戶在第 7 步選名稱與結尾；伺服器向 Porkbun 查詢真正的可註冊狀態、一年期資格及費用。這不是保留網域。
2. 伺服器保存供應商報價與 authority；瀏覽器只能取得網域、有效期限、fingerprint 及方案中的客戶價格。
3. 客戶填寫登記人資料，勾選網站同意書與這個網域的代註冊授權。更換網域會清掉原委託。
4. 建置與付款前重新查詢。原報價過期時，仍可在同一名稱、相同 provider authority、客戶價格不變、供應商價格不超過原上限的條件下繼續。
5. Stripe webhook 的真實付款證據及商業訂單綁定通過後，排程才會採購。Stripe 測試付款不會觸發真實網域或 DNS 費用。
6. 購買只送出一個穩定的 idempotency key；真正註冊 order identity 先保存，再設定並重新讀取客戶登記資料。結果不明時停止新購買，留下待核對狀態。
7. Cloudflare 使用指定帳號建立／重用精確 zone、CNAME 與 Pages custom domain，Porkbun 設成 Cloudflare 回傳的 nameservers。每次變更前重新檢查付款與客戶委託，既有衝突設定不覆寫。
8. 正常 DNS／TLS 等待每 5 分鐘重查，最多 48 小時；不消耗一般失敗重試次數。無法完成時顯示可處理的狀態。
9. 正式部署到同一個 Pages project。只有客戶所選網址的 HTTPS、正式 deployment identity 與首頁內容全部驗證，才回傳 `liveUrl`。
10. 成功頁交換受限的 editor session 後清除同一份漏斗 token；刷新後可透過 HttpOnly cookie 查看進度與管理入口。此工作階段依既有政策為 8 小時，跨裝置或到期後仍使用既有邀請機制；未新增自助帳號恢復寄信。

## 真實啟用需要的設定與權限

下列是程式要求，並非已完成的外部驗證。只有環境變數存在，也不能證明 provider authority、資料庫 schema 或權限已就緒。

| 項目 | 必要條件 |
| --- | --- |
| 平台擁有人 | `OWNER_OPEN_ID` 能由伺服器解析成受控的 database owner |
| 持久化 | 既有 funnel、order、release、receipt、attempt、domain claim、audit、membership/session 資料表可用；此次沒有新增或套用 migration |
| 網域採購上限 | `MANAGED_SITE_FUNNEL_DOMAIN_PROCUREMENT_POLICY_JSON`：每個開放 TLD 各設定 `{ "currency": "USD", "maxAmountMinor": 正整數美分 }`；沒有設定的 TLD 不開放採購，沒有隱含匯率換算 |
| 註冊商 | 已驗證 `domain_registration`，provider `porkbun`，identity `porkbun:production`；官方 endpoint、可解析 `{ apiKey, secretApiKey }` 的 credential reference、足夠餘額與帳號/API 註冊及網域管理權限 |
| Stripe | 預設僅允許測試金鑰。正式收費需明確 `MANAGED_SITE_FUNNEL_STRIPE_LIVE_MODE=true`，並完成 verified live provider／webhook／訂單綁定；只有設定旗標不會授權購買 |
| 網站生成與檔案 | 已驗證的生成器、`DISCOVERYSTACK_MANAGED_SITE_VAULT_JSON` 指定的 S3 相容 immutable vault 與存取權 |
| Cloudflare broker | `DISCOVERYSTACK_MANAGED_SITE_INTERNAL_BROKER_JSON` 的指定 accountId、projectPrefix 與 deployment／DNS／Cloudflare credential references；對應部署、DNS provider 必須 verified |
| Cloudflare token | 可讀指定帳號的 zone，建立新 zone、DNS record，以及 Pages project／custom domain。resource scope 必須涵蓋未來新增的 zone，不能只限既有單一 zone |
| 排程 | 部署平台實際執行 Nitro tasks；相同 cron 的工作現已累加，預設建站檢查為每 5 分鐘 |
| 公開預算 | `MANAGED_SITE_FUNNEL_DAILY_BUILD_LIMIT` 預設 20，0 暫停；過期專案重試使用持久化 audit 重新佔當日一格 |

新網域目前只開放非 premium、一年期、API 可註冊且不需要額外 registry 地址驗證的種類。持有人必須配合註冊商要求完成驗證信；系統不會自行宣稱已完成這個人工驗證。客戶已有的網域需要其所有權與 DNS 權限，因此維持既有驗證流程。

官方合約參照：[Porkbun API](https://porkbun.com/api/json/v3/spec)、[Porkbun domain API 說明](https://porkbun.com/llms/domain)、[Cloudflare Create Zone](https://developers.cloudflare.com/api/resources/zones/methods/create/)、[Cloudflare Pages domain](https://developers.cloudflare.com/api/resources/pages/subresources/projects/subresources/domains/methods/create/)、[Cloudflare DNS record](https://developers.cloudflare.com/api/resources/dns/subresources/records/methods/create/)。

## 最後的真實驗收

需要明確選定的驗收網域、購買預算、客戶在網頁輸入的真實登記資料，以及允許配置的驗收環境。不要用合成測試的假付款證據購買真實網域，也不要把 preview 的 `.pages.dev` 網址當作網域交付證明。

真實驗收應保留以下可追溯證據（不包含原始 token、金鑰或完整個資）：

- 客戶選定網域與同意 fingerprint、Stripe webhook、paid order／release 對應。
- 唯一 Porkbun order、customer contacts readback、domain claim。
- Cloudflare zone/account/project/domain identity、nameservers readback、DNS／TLS receipt。
- 正式 deployment identity，以及客戶選定網址回傳預期首頁的 HTTPS 驗證。
- 關閉瀏覽器仍由排程完成，重試沒有第二筆採購；付款後的管理入口與 token 清除正常。

本機 `pnpm test:safe`（typecheck、node-server build、Vitest）與合成整合只能驗證程式和邊界；真實 provider、資料庫、付款與網域交付仍需上述流程的實際證據。

## 本次驗證結果（2026-09-08）

- `pnpm test:safe` 因 package manager registry 簽章無法驗證而拒絕執行，未略過這項安全檢查。依既定 fallback 使用 repository 的本機二進位：Nuxt typecheck 通過；Vitest 合計 **213 files passed／15 files skipped；4,480 tests passed／28 tests skipped**。其中需要綁定 `127.0.0.1` 的 3 個檔案在允許本機 socket 的環境重跑，5 個測試全部通過。
- 包含真實 wizard 程式的 4 個行為測試、完整已付款→網域註冊→DNS/TLS→正式部署合成整合，以及 owner 固定 H3 路由的既有完整旅程。
- 3 個子代理完成分工與交叉審查；可重現的配額、Stripe 重播、token 清除、排程覆蓋、報價到期、未確認採購重試、DNS 等待與付款後網域不可用問題已修正。
- 最終範圍為 `nuxt-app` 內的 managed-site 自助建站、網域、付款、部署、UX/UI、測試與這份文件；`git diff --check` 通過。
- 真實 Stripe／Porkbun／Cloudflare／S3／網域交付：**未執行**；資料庫僅完成下方唯讀設定與資料表存在性檢查，未執行真實交易整合。28 個 skipped tests 不能當作通過或外部上線證明。
## 外部啟用狀態

本機與合成測試不包含真實 Stripe 收費、Porkbun 採購、Cloudflare DNS／TLS 寫入或正式網站交付，因此不能標記正式自動交付已完成驗收。上線前仍須在受控環境依「真實啟用需要的設定與權限」配置 provider authority、credential references 與採購政策，再以明確同意的驗收網域完成端到端證據。

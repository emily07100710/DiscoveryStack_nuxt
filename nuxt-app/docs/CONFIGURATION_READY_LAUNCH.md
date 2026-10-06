# DiscoveryStack 設定與實際啟用

這份文件將一般客戶流程需要的設定集中在一處。程式驗證、設定已填、供應商已驗證及實際完成交付是不同階段；後台「上線設定」會讀取目前服務的設定，且不回傳任何秘密值。

## 先準備兩個服務

- `public-site` 是 Astro 靜態官網：安裝及 build 使用它自己的 package 與 lockfile。
- `nuxt-app` 是常駐 Node API、客戶後台與擁有人工作台。需接 MySQL/TiDB、套用 migration，並使用可持續執行背景排程的主機。

官網 build 設定 `PUBLIC_SITE_URL`、`PUBLIC_OPS_API_ORIGIN`、`PUBLIC_OPS_UI_ORIGIN`；後台 runtime 設定 `DISCOVERYSTACK_PUBLIC_SITE_ORIGIN`、`NUXT_PUBLIC_DISCOVERY_STACK_PUBLIC_SITE_ORIGIN`、`NUXT_DISCOVERYSTACK_PRIVATE_ORIGIN`。前兩者必須是相同的正式官網 origin：前者供伺服器 CORS 使用，後者才是 Nuxt 在 Docker 啟動後可覆寫的公開網址鏡像，供「返回公開網站」與客戶方案連結使用。只有前者時，執行期 CORS 可正常，但瀏覽器連結仍可能停在建置時的範例網址。API 與 UI origin 通常都是 Nuxt 後台的 origin。

Render 等會休眠的免費 Node 服務，閒置後排程不會繼續運作。驗收時必須關閉瀏覽器，確認付款後開站、編輯發布與內容排程仍能完成；只設定 cron 不能證明主機具備常駐能力。

內容背景排程另受 `NUXT_CONTENT_OPERATIONS_SCHEDULER_ENABLED=true` 控制，範本預設關閉。完成驗收後再明確啟用；這個開關不會自行建立內容計畫，也不會跳過風險審核、客戶／擁有人授權與發布目標設定。

## 設定順序

1. 使用 `nuxt-app/.env.example` 對照後台的環境變數；真實值只放 Secrets。先設定資料庫、擁有人、登入方式與 session 簽章密鑰。資料庫中的擁有人必須是 admin，設定 open ID 本身不會授予權限。
2. 設定官網、後台、客戶表單接收的 HTTPS origins，以及編輯器預覽與表單 token 的獨立密鑰。
3. 設定 Resend key、已驗證寄件網域的 From，及 provider allowlist。公司信箱負責日常收發信，Resend 負責網站的邀請、登入及表單通知，兩者可共用品牌網域，但 DNS 設定依各服務指示。
4. 設定 `NUXT_LLM_*` 與內容／編輯器開關；設定 R2 私人 vault、內部 Cloudflare broker 及 credential registry。
5. 登入「Managed Sites」，開啟「上線設定」檢查缺項。回到 Managed Sites 保存以下五個供應商設定並逐一驗證。
6. 在 Stripe 測試模式建立 webhook，設定獨立 webhook reference。完成測試付款、重播、退款／爭議及付款後登入驗收後，才安排正式收費與網域交付。

OAuth 可用 request-time `NUXT_OAUTH_SERVER_URL`、`NUXT_OAUTH_PORTAL_URL`、`NUXT_OAUTH_APP_ID` 與 `NUXT_DISCOVERY_STACK_OAUTH_ALLOWED_ORIGIN`。allowed origin 必須和後台 origin 相同。舊的 `OAUTH_SERVER_URL`、`VITE_OAUTH_PORTAL_URL`、`VITE_APP_ID`、`OAUTH_ALLOWED_ORIGIN` 仍相容，但不應同時配置互相衝突的值。

## 五個 Managed Sites 供應商設定

後台只填 opaque reference；例如 `envref:stripe-runtime`，不把 API key 貼到表單。

| Capability | Provider key | Reference 範例 | Transport 設定 |
| --- | --- | --- | --- |
| `website_generator` | `bailian-qwen` | `envref:llm-runtime` | 目前首發請使用百煉官方 OpenAI 相容完整端點；`model` 填實際模型。通用內容／編輯器 AI 與建站 verifier 是不同契約，不可只因共用 OpenAI 相容設定就推定每家建站供應商都已驗收。 |
| `payment` | `stripe` | `envref:stripe-runtime` | `endpointOrigin=https://api.stripe.com`、`checkoutOrigin=https://checkout.stripe.com`、`returnOrigin` 填 Nuxt 後台 HTTPS origin。 |
| `domain_registration` | `porkbun` | `envref:porkbun-runtime` | `endpointOrigin=https://api.porkbun.com`。reference 的秘密值是含 `apiKey`、`secretApiKey` 的 JSON 字串。 |
| `dns_tls` | `internal-dns-tls-broker-hmac-v1` | `envref:managed-dns-tls-hmac` | `endpointOrigin=https://managed-sites-broker.discoverystack.dev`。 |
| `deployment` | `internal-deployment-bearer-v1` | `envref:managed-deployment-runtime` | `endpointOrigin=https://managed-sites-broker.discoverystack.dev`。 |

網站生成驗證會發出少量模型 probe，部署驗證會檢查 Cloudflare 權限；按驗證前應已選定要使用的帳號。驗證 receipt 只代表該項能力通過，不代表整個客戶旅程完成。

Stripe webhook URL：`https://<後台網域>/api/managed-sites/payments/stripe/webhook`。必須由 Stripe 的原始簽章事件驅動付款狀態，不能從成功頁或瀏覽器請求推定已付款。

## 網域採購與測試模式

自助首發的付款交付範圍是新網域＋明確採購委託。「已有網域」與「請我們代辦」目前必須先詢問與人工確認，不進入自助收款；擁有人既有的網域權威驗證／手動交付流程仍保留。不能把 placeholder 網址當成客戶已同意的正式網域。

`MANAGED_SITE_FUNNEL_DOMAIN_PROCUREMENT_POLICY_JSON` 必須由擁有人選定各 TLD 的幣別與上限，範例形狀為 `{"com":{"currency":"USD","maxAmountMinor":2000}}`；範例數字不是費用建議或已核准預算。

Stripe 預設只允許測試模式。測試付款不會觸發真實網域採購，因此測試時不能期待新買的網域自動交付。正式採購需要 verified production 付款、精確訂單與 release 綁定，以及客戶針對該網域的委託授權。

## 客戶圖片與安全掃描

網站程式檔案的私人 vault 與客戶編輯器的圖片倉庫是兩個不同設定。需要圖片編輯的專案，在「Managed Sites → 圖片倉庫」選擇專案，保存 S3/R2 bucket、region、專案專屬 prefix、endpoint 及可公開讀取圖片的 CDN origin。

表單只填 credential 環境變數的名稱，例如 `DS_MEDIA_S3_CREDENTIAL`；實際 `{ "accessKeyId": "…", "secretAccessKey": "…" }` JSON 只放後台 Secrets。session token 可選填於 Secrets，不能貼進工作台。保存 connection 不等於已通過檢查。

後台另需 `NUXT_MEDIA_SCANNER_ENDPOINT`、`NUXT_MEDIA_SCANNER_CREDENTIAL_REF`，及 reference 指向的 bearer secret。明確確認後執行 storage 與 scanner 健康檢查，通過才會產生健康紀錄。缺少 scanner 或檢查失敗時，圖片保持隔離，不能發布到客戶網站。

頁面重新載入後會顯示「尚未檢查」，不會假裝已確認舊連線；可再執行健康檢查讀取並驗證已保存設定。這些檢查會呼叫你指定的 S3/R2 與 scanner，應使用已核准的帳號與驗收專案。

## 客戶驗收旅程

- 從官網建站入口進入實際下單流程；預覽內容與模組狀態如實顯示。
- 進入 Stripe 測試結帳，webhook 落在同一訂單與 release；取消、重播、退款與爭議不重複開站或錯誤恢復權限。
- 付款後取得管理入口；確認同瀏覽器、重新整理、登出、session 到期及 Email 重新登入。
- 成員收到邀請信，開啟頁面後需明確確認才消耗 token；被撤銷或專案停用後不能繼續操作。
- 編輯、預覽、發布及內容進度正常；客戶網站聯絡表單可保存，綁定信箱後收到通知。
- 付款客戶預設為 editor，可修改草稿、預覽及使用已配置的編輯功能；正式發布仍需 owner／administrator 權限。新增付款登入不會提升為網站管理員。
- 原生 Cloudflare 發布必須保留整站已交付內容：發布單頁不刪除其他頁或既有文章；發布文章不刪除客戶編輯頁。只有具精確審核、風險閘門與交付 lineage 的文章可併入新部署；舊資料缺少權威時須重新審核或處理遷移，不能以猜測補造發布證明。
- 網站管理員可在客戶後台「網站詢問」查看保存的聯絡訊息，即使通知寄送失敗。這個入口沿用 `data:export` 權限，僅 owner／administrator 角色可讀訪客資料；editor、reviewer、analyst 不會因本次功能獲得額外權限。系統不會自動回覆訪客或把他們加入行銷名單。
- 指定驗收網域的 DNS／HTTPS、部署 identity 及首頁內容全部確認；中斷或重試不產生第二筆採購。
- 關閉瀏覽器後背景工作仍完成，錯誤狀態有可理解的處理方式。

## 擴充功能

GEO／內容訂閱啟用會連結營運工作區，但不代表內容計畫與日曆已建立。仍須以網站證據建立或連結 governed production plan/calendar，通過風險審核及發布授權；客戶後台會逐項顯示這些條件，不把空日曆呈現為正在自動發文。

GA4／GSC 需要服務帳號唯讀權限、正確 property/site identity 與工作台 connection；沒有真資料時保持 unknown。LINE、Shopify 與其他需人工設定的模組依各自服務流程開通，未開通不得顯示自動可用。GEO 模型研究、校準與正式效益證明仍依資料、consent、holdout 及 shadow gates，不能靠填 key 跳過。

## 驗證指令

```bash
cd nuxt-app
pnpm test:safe
```

```bash
cd public-site
pnpm astro check
pnpm test
```

以上是本機程式驗證。真實寄信、Stripe、Porkbun、Cloudflare、R2、資料庫與部署驗收應各自保存 reduced receipt；不把完整 token、金鑰或客戶資料放進報告。

## 2026-10-07 正式套用與首發上線核對

本節是首發版本的歷史驗收紀錄；後續學習工程增補的驗收與部署狀態另列於下一節，不能把首發的 Live 版本當作後續程式已部署的證明。

經使用者明確授權，這次已執行以下操作；不代表所有供應商流程已驗收：

- 正式 Render 後台的資料庫設定與本機候選連線比對一致，TiDB TLS 連線已驗證。遷移前 192 張表、258 筆資料做一致性快照，另在隔離 MySQL 還原並核對每張表筆數及逐欄語意雜湊；正式資料未刪除或改寫。
- 新增式 migration `0045` 已套用，正式 ledger 為 46 筆、總表數 195；新增 3 張學習表、8 個外鍵、7 個明確索引均已核對。備份沒有提交 Git 或傳到公開網站；臨時還原／遷移測試副本已清理。本機快照不等於定期異地備份。
- 官網 `https://discoverystack-web.onrender.com/zh-hant` 的程式版本 `95b2bc4` 已 Live；後台 `https://discoverystack-api.onrender.com` 的程式版本 `3123d6e` 已 Live。後續只有文件／範本／回歸測試的提交不改動這兩個執行中的應用程式內容。
- 正式 Nuxt 打包不會攜帶獨立客戶站的程式或測試 fixture。修正跨專案測試的靜態 import 問題後，保留真實契約測試；只有 Nuxt 的隔離建置也已成功。
- 已加上非機密的 `NUXT_PUBLIC_DISCOVERY_STACK_PUBLIC_SITE_ORIGIN`，以 Save and deploy 套用。正式 DOM／HTTP 已確認「返回公開網站」指向真正官網。沒有變更 auth／DB／供應商密鑰、放寬 CORS 或模型閘門。
- 最終 Nuxt 型別檢查與新正式建置通過；完整安全測試 286 個檔案、5,607 項通過，14 個檔案／27 項外部整合跳過。Astro check 為 53 個檔案、0 error／0 warning／20 hint；正式 origin build 與 89 項測試通過。正式網站更新設定後 14 項唯讀檢查通過。
- 三種 DS 客戶網站核心範例（Atelier 電商、Bloom 電商、Alignment 預約＋部落格）已在 `services/customer-site-runtime`，53 項本機 HTTP／SQLite／mock 寄信測試通過，另檢查首頁／商品／手機預約版面。Alignment 目前為單人、容量 1 的時段預約，不是多人團課系統。資料、圖片與服務時段是示範內容；沒有付款或送出正式訂單／預約，不能等同原品牌成品或正式客戶網站交付。

## 2026-10-07 本輪學習工程增補驗收

- 在程式凍結後依序執行 Nuxt typecheck、fresh node-server build、完整安全測試，均 exit 0。完整 Vitest 為 295 個檔案／5,677 項通過，14 個檔案／27 項跳過，總計 309 個檔案／5,704 項，258.72 秒；不是沿用首發的 5,607 項結果。本機 production-origin runtime 的 7 項確實執行並通過，沒有因 listener 權限而跳過。
- 新增覆蓋包括：獨立核准的 train-only fallback、精確回退與訓練預約譜系、重啟讀回、影子評估中途撤回、DECIMAL 精度存讀、發布 receipt-bound repository diff、成效 publication 去重及時間外 holdout。全部使用合成／mock 資料；沒有向正式資料庫寫入測試模型。
- 新版 node-server 實際綁定 `127.0.0.1:3197`，工作台未登入狀態、正確官網回返連結及 390 px 手機版已在瀏覽器核對；沒有水平溢位，導覽可展開，切換工作台後自動收合。這是匿名本機 UI 驗收，不是正式 owner session／真手機 LINE 驗收；預覽與臨時分頁已關閉。
- 三個客戶站核心範例再次執行 `node:test`：53 項通過、0 失敗、0 跳過。涵蓋本機 HTTP／SQLite／庫存訂單／預約部落格／權限及 mock 通知；不包含正式品牌美術、真金流、真收信或一鍵持久部署。
- 2026-10-07 05:16（Asia/Taipei）正式 TiDB 唯讀核對：195 張表、46 筆 ledger、0045 精確 hash 相符、owner 配置有效；來源、training runs、model artifacts、calendar entries、publication targets 均為 0。沒有新增 migration，也沒有重套 0045 或改寫客戶資料。
- 本輪執行程式 `515e4fb62f66b8f02ecf3468483bf622eaf02d71` 已以非強制方式推送到既有兩個 GitHub main 遠端。Render 後台 `srv-dab7es3tqb8s73f1orlg` 已直接核對 Last successfully deployed commit 為同一版本，Auto-Deploy 耗時 2m22s，部署 `dep-db2mca3rjlhs73fk8780` 顯示 Live；首發 `3123d6e` 的狀態沒有被當作本輪證明。服務仍為 Docker Free，沒有升級、啟用模型或呼叫付費供應商。
- 新版 Live 後正式官網／後台 16 項非破壞性 HTTP 檢查全部通過，包括公開 canonical／handoff、工作台官網回返／noindex、未登入 workspace 與兩個 fallback POST 的 401／no-store、根路由 redirect、精確公共 CORS 及錯誤來源拒絕。另正式 HTML 確實引用 `/_nuxt/xDmkHttW.js`，其 SHA-256 `d3fb0ac6810760b381484c0981375f088c841553536451f0ce39dc8f094584aa` 與本機新正式建置完全一致。這些檢查不代替已登入 owner 的資料讀寫、真 LINE／發布／量測或真模型訓練驗收。
- 首次遠端 CI 與本機結果分開記錄：`515e4fb` 的遠端 typecheck／build 通過，Vitest 為 5,676 通過、1 失敗、27 跳過（518.46 秒）；唯一失敗是 modelops 的 reviewer-null／真實 fallback CPU 案例 `Test timed out in 15000ms.`。本機同項約 7.7 秒，修正僅將該案例的有界等待上限調為 60 秒；不改 fixture、斷言、資料／holdout／owner／rollback 閘門、正式程式逾時或 skip。這項是測試設定修正，不需要再次套正式資料庫或重部署執行程式；修正後完整重驗與新遠端 CI 結果另行核對，不把舊失敗改寫為通過。
- 逾時修正後再凍結測試與執行程式，重新依序完成 typecheck（19.956 秒）、fresh node-server build（56.393 秒）及完整安全 Vitest（258.10 秒），全部 exit 0；仍為 295 個檔案／5,677 項通過、14 個檔案／27 項外部整合跳過，309 個檔案／5,704 項總計。原逾時案例在完整執行中為 7.871 秒，18 項模型持久化／重啟 fixture 為 85.574 秒。本次只提交測試等待上限與驗收紀錄，正式執行程式維持 Live 的 `515e4fb`，資料庫維持 0045；未新增 migration 或啟用供應商／模型。

仍需處理的缺項：

1. **LINE／實際發布**：正式環境尚缺每週內容所需的 LINE access token、channel secret、bot user ID；仍需實際客戶綁定、內容計畫、精確稿件核准與發布目標。手機按確認到供應商發布、回執與下一輪量測回流，尚未做真實端到端驗收。
2. **Email／網域**：Resend 與 durable outbox 的程式已存在，正式 key、已驗證寄件網域、From、驗證 pepper 及真實收信驗收仍未完成。公司信箱另需信箱服務，不會由 Resend 自動建立。
3. **常駐與備援**：目前私有 Render 服務為 Free，閒置會休眠；持續排程與關閉瀏覽器後的驗收尚未完成。付費升級／新託管與定期異地備份需要選擇、成本與保存責任，這次沒有擅自升級。
4. **真實學習資料與模型**：正式 public sources、training runs、model artifacts、內容日曆項目、publication targets 均為 0。需要合法授權的來源及可追溯觀測、GSC／GA4 連線與足夠真實標籤，才能評估模型；API 回答／結構分數不能冒充消費者 AI 引用真值。
5. **尚未完整的學習工程**：已新增成效 trainer 的 server-owned 時間／baseline 譜系、publication 去重及時間外 subject holdout，與首次引用模型獨立 owner 核准的固定 train-only shadow 回退基準。第一方 Git 的正式更新也能保存精確 receipt-bound、hash-only repository change-set；但 repository revision 不是已部署頁面的 live before／after。完整 live action-learning adapter／admission、真實資料上的準確度與效果、production activation 仍未驗收，保留關閉與 owner 核准門檻；不能說只要填 API 就已完成學習品質驗證。
6. **後續一鍵客戶站交付**：Node 核心需要獨立託管與持久儲存的自動部署 adapter；現有靜態 Cloudflare 部署不能代替交易／預約後台。正式金流／退款、物流／發票、預約提醒、舊站會員與訂單匯入、HTTPS／備份／隔離與真手機驗收仍未完成。依目前優先序先完成 DS／學習閉環，不自動採購客戶網域。
7. **美術與對外宣稱**：範例目前仍有示範圖片與資料，尚需品牌素材與正式美術驗收。官網所列平台是可規劃整合方向，不是 40 個正式串接全部驗收；「亞洲唯一」等唯一性宣稱仍需獨立可驗證佐證，這次工程檢查不提供此證明。

這次沒有發真 LINE、寄真通知、呼叫真 AI／Google、向客戶站發布內容、啟用正式模型、購買網域或執行真實付款。登入後的正式資料讀寫與業務流程也不由匿名唯讀檢查代替。

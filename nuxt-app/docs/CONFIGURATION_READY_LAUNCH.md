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
- 修正提交 `9233757caf032c14e898d35f51da7b95db661887` 已正常推送並核對兩個既有遠端精確 main SHA；2026-10-07 06:03（Asia/Taipei）唯讀核對 [遠端 CI run 37536636498](https://github.com/tendertech2018/DiscoveryStack_nuxt/actions/runs/37536636498) 為 completed／success。後台的 typecheck／build／test 與公開官網的 astro check／build／test 兩個必要 job 均 success；這是新修正提交的結果，沒有改寫 `515e4fb` 的舊失敗。遠端每個 job 的成功與本機完整測試總數分開記錄，不把未擷取的遠端逐項總數冒充本機數字。最後的郵件佇列釐清與這筆驗收紀錄只改文件，不改已部署執行程式或已驗證測試。

仍需處理的缺項：

1. **LINE／實際發布**：正式環境尚缺每週內容所需的 LINE access token、channel secret、bot user ID；仍需實際客戶綁定、內容計畫、精確稿件核准與發布目標。手機按確認到供應商發布、回執與下一輪量測回流，尚未做真實端到端驗收。
2. **Email／網域**：Resend 寄信 adapter 與每週 LINE durable outbox 已存在。本輪另補 DS 平台自己的加密交易郵件佇列，涵蓋信箱驗證、重新登入、成員邀請、聯絡表單及網站上線通知；新增 migration `0046` 已正式套用，新程式 `f0daa27` 已 Live，完整分階段證據另列於下節。獨立客戶站 SQLite 核心的每站 Email outbox 仍維持隔離，沒有併入平台資料庫。正式 key、已驗證寄件網域、From、驗證 pepper、獨立郵件加密密鑰及真實收信驗收仍未完成；寄送預設關閉，公司信箱服務也沒有自動建立。
3. **常駐與備援**：目前私有 Render 服務為 Free，閒置會休眠；持續排程與關閉瀏覽器後的驗收尚未完成。付費升級／新託管與定期異地備份需要選擇、成本與保存責任，這次沒有擅自升級。
4. **真實學習資料與模型**：正式 public sources、training runs、model artifacts、內容日曆項目、publication targets 均為 0。需要合法授權的來源及可追溯觀測、GSC／GA4 連線與足夠真實標籤，才能評估模型；API 回答／結構分數不能冒充消費者 AI 引用真值。
5. **學習工程與正式品質的區分**：已新增成效 trainer 的 server-owned 時間／baseline 譜系、publication 去重及時間外 subject holdout，與首次引用模型獨立 owner 核准的固定 train-only shadow 回退基準。第一方 Git 的正式更新能保存精確 receipt-bound、hash-only repository change-set，但它不是 live before／after。本機另已實作預設關閉的第一方 HTTP 前後證據、durable recovery、獨立審查與 V3 action-aware 成效 admission，分階段證據見本文件末節；新 migration／執行版本、真客戶整合、真實資料準確度與 production activation 仍須各自驗收。不能說只要填 API 就已完成學習品質驗證。
6. **後續一鍵客戶站交付**：Node 核心需要獨立託管與持久儲存的自動部署 adapter；現有靜態 Cloudflare 部署不能代替交易／預約後台。正式金流／退款、物流／發票、預約提醒、舊站會員與訂單匯入、HTTPS／備份／隔離與真手機驗收仍未完成。依目前優先序先完成 DS／學習閉環，不自動採購客戶網域。
7. **美術與對外宣稱**：範例目前仍有示範圖片與資料，尚需品牌素材與正式美術驗收。官網所列平台是可規劃整合方向，不是 40 個正式串接全部驗收；「亞洲唯一」等唯一性宣稱仍需獨立可驗證佐證，這次工程檢查不提供此證明。

這次沒有發真 LINE、寄真通知、呼叫真 AI／Google、向客戶站發布內容、啟用正式模型、購買網域或執行真實付款。登入後的正式資料讀寫與業務流程也不由匿名唯讀檢查代替。

## 2026-10-07 平台交易郵件佇列驗收與正式資料庫套用

狀態：**IMPLEMENTED / DATABASE_APPLIED / DEPLOYED / DELIVERY_GATED**。以下分開記錄程式驗證、正式資料庫與 Live 證據；不改寫上節 `0045` 與 `515e4fb` 的歷史證據，也不代表真實收信或完整業務流程已驗收。

- 五個正式呼叫路徑接上平台獨立佇列；一次性驗證碼／登入權杖的來源雜湊與加密郵件在同一 SQL transaction 保存，provider 呼叫只在提交後執行。信件入列不是寄出成功，provider 接受也不是已確認收件匣收到。
- 加密內容與權威使用獨立密鑰及 HMAC，精確綁定 owner／project／purpose／目前收件人／來源／供應商設定；租約、到期、撤回、重試窗口及已接受後回執補登均不依賴瀏覽器宣告。回執補登不再次呼叫 provider。
- 排程寄送及過期清理分別 opt-in，範本均預設關閉；兩者關閉時 task 不查設定、identity、資料庫或 provider。擁有人「郵件紀錄」頁僅唯讀列出自己的最近 50 筆減敏狀態，未購買而尚無 owner 的驗證碼紀錄刻意不混入。
- `0046_managed_email_outbox_v1.sql` 是新增一張表及索引，不改既有業務表。隔離 MySQL 8.4 以合成資料實際執行 migration／Drizzle／repository／service，6 項通過：64 KiB 郵件與毫秒保存、併行租約、接受後重啟不重寄、清理 fencing、來源與佇列原子 rollback、owner metadata 隔離。修正 MySQL 要求 `ON UPDATE CURRENT_TIMESTAMP(3)` 的精度一致性，沒有向正式 DB 執行試驗。
- 修正正式相容性之前，凍結程式與測試後依序完成型別檢查（16.928 秒）、fresh node-server build（47.489 秒）、完整安全 Vitest（232.85 秒），全部 exit 0：302 個檔案／5,736 項通過，15 個檔案／33 項跳過，共 317 個檔案／5,769 項。其中 6 項 opt-in MySQL 在隔離環境另外實際通過，不把完整安全套件中未啟用的項目算成通過。原首次完整執行有 3 項失敗，均為原排程契約仍預期舊的 11 個工作；加入新郵件工作與 cron 後保留精確 cadence／collision／no-loss／no-duplicate 斷言，重新完成整套凍結驗收，不刪除或跳過案例。這筆歷史本機結果不代替下列修正後驗收。仍有既有 browsers data、plugin timing、ULID BigInt target 與 H3 statusMessage 警告，沒有更動依賴或隱藏警告。
- 另以新正式建置完成 4 項本機 HTTP 保護核對：未登入的郵件 API、無法由 query 借用 owner／project、公共 origin 不取得私人 API CORS、新頁面的 no-store／noindex／正確官網回返。既有正式官網與後台再次完成 16 項唯讀檢查，全部通過；它們是已部署版本的可用性證據，不代表新增郵件功能已 Live。三個獨立客戶站核心範例再次跑完 53 項、0 失敗、0 跳過。正式 Resend 接受、實際收信、已登入 owner 的新頁面與常駐主機排程驗收仍為 **NOT_RUN**。
- 最初快照操作因可能包含客戶資料而被拒絕，沒有執行。使用者後續明確授權完整本機備份與隔離還原：新一致性快照為 195 張表／260 筆，SHA-256 `72b420a96f497582672a2cd6b29642edfd2fd55950b02f0bd695dc180c1559b9`；受限目錄 0700、SQL 0600，未上傳或放 Git。隔離還原逐表筆數與逐欄語意雜湊全部相符，臨時副本已移除；保留本機備份不代表定期異地備援。
- 初次正式 CREATE TABLE 被 TiDB 以 `ER_INVALID_DEFAULT` 拒絕，沒有任何 DDL 成功；唯讀核對仍是 0045／195 表／46 ledger。將尚未套用的 SQL、schema 與 snapshot 時間 default 統一成 `CURRENT_TIMESTAMP(3)`，保留同精度 on-update，重新隔離還原並排演修正後 migration，再凍結完成 typecheck（20.978 秒）→ fresh build（58.892 秒）→完整安全 Vitest（246.33 秒），全部 exit 0：302 個檔案／5,737 項通過、15 個檔案／34 項跳過，共 317 個檔案／5,771 項，0 失敗。報告 SHA-256 `b07d5db060d28677a958ca4d20e76d29942f93719991bb01e16f2047f6538792`。隔離 MySQL 的 7 項另行全部通過，含省略時間欄位的真實 default 回歸；本機 4 項 HTTP 與三範例 53 項也再通過。
- 2026-10-07 07:20:02（Asia/Taipei）已向相同 TLS TiDB 套用 `0046`，精確 SQL SHA-256 `548a889a95f04fe9f6a05de8ade6a553b7992aaea7ca58b9cb0797ed7b76306d`；正式為 196 張表／47 ledger。22 個新欄位、毫秒精度與 4 個索引（含主鍵／唯一鍵）均核對，queue 0 筆；只寫新增表／索引及 canonical ledger，未改既有業務表。此 checkpoint 新程式仍待提交、推送及 Live 驗收。Render 仍是 Free，新郵件寄送／清理環境鍵未設定、沒有 linked environment group，依程式預設關閉；未啟用真郵件、模型、付款或客戶站發布。
- 執行版本 `f0daa2774bad818f53e8c1659d080842c446ae9e` 已在精確 43 檔案 fence 提交（秘密掃描 0、凍結後 source/test 指紋相符），正常推至兩個既有 main，沒有 force。Render `srv-dab7es3tqb8s73f1orlg` 已直接核對 Last successfully deployed commit 指向同版；部署 `dep-db2o56jrjlhs73flr8q0` 為 Live，Auto-Deploy 2m23s，仍是 Docker Free。部署截圖只存受限本機暫存，未放 Git。
- 新版 Live 後 21 項正式非破壞性 HTTP 全部通過：原 16 項官網／後台加 4 項新郵件頁／API 匿名保護與新 client artifact。正式 HTML 引用 `/_nuxt/C1Ft4Ad0.js`，served SHA-256 `8d223e68eeaa0be5c7d1d4088cde4d7f870f0de5cf91c7bc98e89075c45c2468` 與 fresh build 完全一致，含新郵件 API 引用。這不代替 owner 登入後讀寫、真郵件／LINE／模型與常駐工作驗收。
- 精確版本的遠端 [CI run 37546156904](https://github.com/tendertech2018/DiscoveryStack_nuxt/actions/runs/37546156904) 已 completed／success；公開官網的 astro check／build／test 與後台的 typecheck／build／test 兩個必要 job 均 success。這是實際完成後獨立核對的遠端結果，不把本機數字冒充未擷取的遠端逐項總數。
- 使用者自行登入正式擁有人後台後，重新載入新「郵件紀錄」頁並按唯讀「更新紀錄」：精確 `/api/managed-sites/email-outbox` 為 HTTP 200／application/json。此 route 先驗證目前 owner，再實際執行 owner-scoped SQL metadata query；DB 錯誤回 503，不以空清單假裝成功。穩定畫面顯示沒有紀錄、設定尚未完整、自動寄送關閉。僅保留 path／status／MIME 與無私人內容的空狀態截圖，沒有擷取 cookie／token／header／body／信箱或客戶資料；截圖只存受限本機暫存，未放 Git。這次補驗是正式 owner 空清單讀取，不是有資料時的正式 owner 隔離、業務寫入或真收信；沒有觸發寄信、LINE、發布、訓練、付款或啟用開關。

## 2026-10-07 發布前後證據與成效學習增補

狀態：**IMPLEMENTED / LOCAL_VALIDATED / DATABASE_APPLIED / LIVE_VERIFIED / CI_VERIFIED / OWNER_READ_SESSION_REQUIRED / PROVIDER_GATED**。本節的新工程不沿用上節郵件版本 `f0daa27` 的正式 Live／owner 讀取證據；以下為本輪備份／正式 0047／新執行版本／CI 與唯讀驗收，登入後的新 action workspace 讀取仍待使用者重新登入。

- 真正的發布前後證據路徑：在現有發布租約內保存同 URL 的受控 HTTP before 與發布前 planned features，durable dispatch boundary 先於 write；擷取後重驗客戶核准、草稿版本／hash、risk gate 與 target 配置。學習同意撤回不取消獨立核准的業務交付，但證據不能再進入學習。
- 正式收據提交後才驗證 actual HTTP canonical、標題、正文及精確 publication／draft／review／hash；repository diff、2xx 或 marker 都不是單獨證明。發布後驗證每次回應最多一筆，其餘使用 after-only recovery；部分成功只承認該 delivered target，下一輪只重試失敗的發布目標，不重複發文。這仍不是瀏覽器可見性、索引、AI 引用或成效因果證明。
- Safe owner 面板只顯示安全摘要，三項明確確認與有界理由才可記錄不可覆寫的獨立審查；審查不發布、不抓取、不訓練。另在成效工作台明確選擇原 V2 或 action-aware V3，再獨立核准確切資料集。V3 只增加十項發布前改動特徵；原資料門檻、publication 去重、subject／時間外 holdout、train-only fitting 與 production activation 門檻不變。
- 每次資料 release、訓練前後及模型使用，重新核對目前授權／保存期／精確 receipt／審查與 sidecar；撤回或 drift 不沿用歷史核准／權重。before／after／expected／planned 四份 JSON 在清理時實體清空，並 fencing 已過期 worker；原文章、客戶訂單與不可變營運歷史不因此刪除。
- 選用 Site Kit API `buildFirstPartyLiveArticleProjection()` 產生 bounded 受控 SSR 文章片段，由客戶 Astro/Nuxt 模板整合並設相同 canonical；沒有自行更改／部署客戶網站，也不是一鍵建站。詳細契約見 [發布證據規格](../LEARNING_LIVE_PUBLICATION_ACTION_V1.md) 與 [Site Kit](../FIRST_PARTY_CONTENT_SITE_KIT_V1.md)。
- `0047_live_publication_actions_v1.sql` 只新增 owner-scoped 證據表／外鍵／索引，並把既有 publication-attempt `completedAt` 擴為 `timestamp(3)`，保留 nullable 與歷史值；不回填／補造 before 證據。隔離 MySQL 8.4 以兩條真 SQL session 實測 5 項全部通過，包括精度／舊值保留、精確 target／lease、並行 CAS／stale completion、immutable review、四份 JSON 到期清理。資料全為合成，測試容器已停止並移除；沒有套正式 TiDB。
- 本機 fresh node-server 的 7 項新 API／頁面 HTTP 保護全部通過，含匿名 401、query 無法借用 owner／URL／enablement、私人 no-store／noindex／無 public CORS、原官網回返。實際 Vue 元件另在明確標註的合成預覽中操作：少一確認不可送出、重新讀取清空確認、完成審查不觸發發布／訓練、不可覆寫、到期／空清單／讀取錯誤保護與 390 px 無水平溢位。測試分頁與本次預覽均已關閉；沒有偽造正式 owner session 或新增正式測試紀錄。
- 第一次完整安全套件的失敗結果仍按原樣記錄：307 個檔案／5,818 項通過，5 個檔案失敗、16 個檔案／48 項跳過（328 個檔案／5,871 項），286.83 秒，exit 1。真正的一項 regression 是舊郵件 migration test 把 journal 最末固定為 0046；其餘兩個 suite 啟動失敗與四個 HTTP case timeout 伴隨 `listen EPERM: operation not permitted 127.0.0.1`，不是通過。限定本機權限後四個 HTTP 檔案／13 項另行全部通過；不提高逾時、不刪斷言、不跳過。歷史 migration 的完整比對保留，另新增 0047 的 44 欄／8 外鍵／3 索引、195 個既有表完整 snapshot 比對、唯一的 nullable 時間精度變更與 12 條 SQL allowlist 檢查。先前執行句柄及暫存檔在續跑時已無法讀取，不冒充最後一次型別檢查完成或原報告仍可取得；以下是重新執行且另存的最終證據。
- 最後固定 40 個執行程式／測試／規格檔，維持 `main`／HEAD `46e3626f2992b79ca128e7f8abbfadb54f658ebe`，來源清單 SHA-256 `f33282de12ec42e9beb36eae08a172d026d60e11dd3783e1ea58d94a21f5b535`。依序完成型別檢查（16.172 秒）→ fresh node-server build（20.383 秒）→完整安全 Vitest（250.93 秒，包裝程序 251.287 秒），全部 exit 0：313 個檔案／5,837 項通過、16 個檔案／39 項 opt-in 整合跳過，共 329 個檔案／5,876 項、0 失敗。報告 SHA-256 `55502ed1978a290782bdc67a9a1c7305ebe0060dbafc20076002d9f632e44ff3`，JSON success 與逐檔／逐項結果已獨立核對；跳過不是通過。子程序不繼承憑證、不讀專案 `.env`、不設定正式 DB，所有外部動作預設關閉；只限定本機 listener 權限，不安裝或更換依賴。此驗收文件不含執行程式，刻意排除在來源固定清單外，僅在通過後補記結果。
- 同版 fresh node-server 的 7 項 HTTP 再次全部通過，自有程序已停止。實際 Vue 元件重新完成合成互動與 390 px 清單／表單驗收；合成核准後顯示不可覆寫及仍需獨立資料集審查，操作計數為讀取 3／審查 1／擷取 0／發布 0／訓練 0。空狀態、到期紀錄及讀取失敗均不提供審查，手機 document／viewport 均 390 px；暫時 viewport 已恢復、測試分頁已關閉。桌面／手機截圖清楚標示「本機合成介面驗收」，保存在本輪受限本機驗收附件，不含正式帳號或客戶資料。
- 既有本機 MySQL 8.4.11 映像以 `--pull=never` 複驗，同一份 SQL／兩條真 session 的 5 項再全部通過（0.966 秒套件；含啟動約 6.709 秒）。第一輪的 SQL 本身 5 項通過，但輔助程序在容器停止後立刻觀察、背景移除尚未結束而 exit 1；不當作完整清理成功。確認移除完成後，輔助程序改為保存精確自有 ID／標籤並最多等 10 秒確認；產品 SQL、repo 與測試斷言不變，重跑後 5／5、0 跳過，且精確容器 ID 已不存在。報告 SHA-256 `cd413ac4d879d7a5c3a849446f2e7fc69cc40bd8ac630913f12daa4f199db48a`。臨時容器及其合成資料已移除；未連正式 TiDB、未讀客戶資料。這 5 項是在 opt-in 隔離環境另行執行，不改寫完整安全套件的 39 項跳過。
- 公開 Astro 官網也重新完成 check（53 個檔案，0 errors／0 warnings／20 hints）、fresh 靜態 build（21 頁）與完整 Vitest：14 個檔案／89 項通過、0 失敗、0 跳過。官網報告 SHA-256 `84abda7832de36f21127116c13aa7ed2da55b6a2e88ed150901d231c4c7339c2`。三種客戶網站共用核心再次完成 53 項 `node:test`、0 失敗／0 跳過，涵蓋合成電商／預約／部落格、本機 HTTP／SQLite／權限／mock 通知；這仍不是三個正式品牌網站美術、金流、收信或一鍵持久部署的驗收。兩邊均使用白名單環境，確認沒有實際 dotenv 檔、不繼承憑證或設定真供應商；公開官網原始碼與範例核心沒有修改，產物沒有加入 Git。
- 最終 JSON／原始本機測試報告／來源清單及截圖另存於本輪 visualizations 驗收附件，目錄 0700、檔案 0600，未上傳或放 Git。續跑／公開官網／範例驗收後再次核對原始碼指紋與 `git diff --check`，均相符；沒有用歷史通過數字代替新版執行結果。

- 使用者已明確授權「上述 0 元備份、資料庫更新與部署」，包含完整受限本機備份／隔離還原、精確 0047 apply、正常推送既有兩個 main、Render Free 部署與新 owner 唯讀檢查。新一輪唯讀 preflight 已核對 Render 仍為原 `srv-dab7es3tqb8s73f1orlg`／Docker Free／tendertech2018 main，當時 Live 仍為 `f0daa27`；本機候選 DB 與 Render 正式連線以雜湊安全比對一致，TLS 驗證及既有 0046 ledger hash 相符。兩個 main 遠端均維持 `46e3626f2992b79ca128e7f8abbfadb54f658ebe`，來源 40 檔指紋沒有變動。
- 2026-10-07 19:52:29（Asia/Taipei）新完整一致性快照包含 196 張表／261 筆資料，2,405,597 bytes，SHA-256 `3eef6d548356cb090bad6a96b877936bcb4562b0399e761ad8093564f36b17e7`。備份只存本輪受限本機附件（目錄 0700、檔案 0600），未上傳、未放 Git。隔離 MySQL 8.4.11 完整還原後，各表筆數與逐欄語意雜湊全部相符，外鍵資料完整性與精確 0047 演練通過；只用既有映像 `--pull=never`，自有暫時容器及其中正式資料副本已移除，原備份保留。這是一次可還原本機備份，不等於定期異地備份。
- 第一次備份以 `START TRANSACTION READ ONLY` 被 TiDB 拒絕，錯誤 `ER_NOT_SUPPORTED_YET / 1235`，沒有完成快照或寫入資料。依 TiDB 一致性交易契約改用 `START TRANSACTION WITH CONSISTENT SNAPSHOT`，取得快照的函式僅執行 SELECT／SHOW 與交易控制，沒有變更 no-op 相容設定。第一次隔離演練已還原 196 表／261 筆，但輔助程式把自動外鍵索引也算進四個明確索引而停止；保留原失敗記錄、只修正輔助索引分類後重做完整還原與演練成功，產品 SQL／來源／測試斷言不變。
- 正式 12 條 DDL 執行完後，寫 ledger 前的嚴格 schema 比對因 TiDB 精度欄位回傳字串 `"3"`、MySQL 回傳數字 `3` 而停止。唯讀診斷證明唯一差異正是這個輔助型別比較；沒有重跑 DDL、刪表、改歷史資料或改產品 SQL。保持提供者原本 metadata 型別後重新核對完整 schema 與既有資料，再只補一筆 canonical ledger。2026-10-07 19:58:21（Asia/Taipei）0047 正式 checkpoint 完成，SQL SHA-256 `02e56d0f906396878bd097e3778c1df6d20be8a88f1f9d228a87e4bea929d509`／journal time `1791332286275`，正式 197 張表／48 ledger。新表 44 欄、8 個外鍵、3 個明確索引加主鍵及 7 個自動外鍵索引、10 個毫秒時間欄與 default／on-update 全部核對，證據表 0 筆；195 個既有業務表 row semantics 不變，唯一既有 schema 變更為 nullable `completedAt` 精度。
- 2026-10-07 20:00:06（Asia/Taipei）另做正式唯讀回查，197 表／48 ledger／0047 hash、新表空狀態、完整既有 schema 唯一精度變更與 195 個既有業務表語意雜湊再次相符。執行版本 `6693062371add6edf3bee0c0f20634f71050ffbb` 以精確 41 檔案 fence 正常提交，真憑證與供應商 key 掃描 0，提交的 40 個執行／測試／規格 blob 與已通過的固定來源逐一相符；備份、憑證、驗收附件與生成產物均不在 Git。
- origin 正常推送成功。首次 tendertech-backup 正常推送因目前 GitHub active account 只有 READ 權限而被拒，遠端仍是舊 `46e3626`；沒有把失敗當作完成。使用電腦上原已登入的 tendertech2018 owner，在單次程序暫用既有憑證核對寫入權限、遠端舊 SHA 後正常非 force 推送成功；沒有輸出／存檔 token、切換全域帳號或新增權限。部署後兩個 main 均直接回查為 `6693062371add6edf3bee0c0f20634f71050ffbb`。
- Render 同一 Docker Free 服務的新部署 `dep-db33a5rl550s73ce9ai0`，畫面直接核對 source commit 精確 `6693062371add6edf3bee0c0f20634f71050ffbb`、`Deploy succeeded | Live`、Auto-Deploy 3m02s。沒有更改 Render 環境或升級方案；截圖只存受限本機附件，不含憑證或客戶資料。
- 新版 Live 後 16 項 GET／OPTIONS 正式非破壞性 HTTP 全部通過，涵蓋新 live-action list／release 的匿名 401、query 無法借用 owner／URL／enablement、private no-store／noindex／無公共 CORS、既有學習與郵件 owner 保護、根 redirect、官網 canonical／預覽交接／服務頁、精確公共 leads preflight 及私人拒絕。正式 HTML 引用 `/_nuxt/BQ-1xrOz.js`，served SHA-256 `c4b8b8039e183f7ff885e8ed22e73b80425c20bd6768dde55c3626e7d247762f` 與同版 fresh 驗收建置完全一致，且包含新 live-action API 路徑。沒有使用登入 cookie 或 POST 審查／reconcile，不會觸發發布／抓取／訓練。第一次輔助 HTTP 驗收誤把無資料 root redirect 當 private page header、第二次誤要求目前首頁 HTML 直接包含後台 origin；各失敗報告保留，依現有 routeRules／首頁 CTA 實際交接到 preview 的契約修正輔助程式後完整重驗成功，產品來源、所有真正 private page／API auth、header、CORS 斷言未改。
- 精確執行 SHA `6693062` 的兩個遠端 CI 已分別完成：origin run [37618061798](https://github.com/emily07100710/DiscoveryStack_nuxt/actions/runs/37618061798)、Render 連結庫 run [37618325816](https://github.com/tendertech2018/DiscoveryStack_nuxt/actions/runs/37618325816) 均為 completed／success，各自兩個必要 job（Nuxt typecheck／fresh build／完整安全測試；Astro check／build／完整測試）全部 success。這是新版遠端證據，不沿用舊版 f0daa27 的 CI，也不把單獨官網通過當成整體通過。
- 新版正式 owner 面板已在原使用者分頁開啟，並只按「重新讀取」；精確 `/api/interventions/closed-loop/live-actions` 為 HTTP 401／application/json，fromDiskCache／fromServiceWorker 均 false，畫面要求重新登入。原 owner session 已過期，這一項 **OWNER_READ_SESSION_REQUIRED**，不是成功空清單或 owner SQL 驗收。已請使用者在既有 `/owner-login` 自行重新登入，不讀取／代填密碼，不偽造 JWT，不擷取 cookie／header／body／信箱／客戶資料，也沒有新增正式合成紀錄。登入期間已停止網路觀察，重新登入後再獨立做唯讀補驗；舊郵件頁 owner 200 不能代替新 action workspace 的正式驗收。

沒有升級或購買，沒有變更既有 Render 環境值；內容 scheduler／建站執行維持關閉，新學習／live-action／郵件開關未設定、依程式預設關閉且沒有 linked environment group。既有每週審稿／LIFF 介面開關已開啟，但正式 LINE 憑證尚缺且 scheduler 關閉，不能當作真 LINE 發送／客戶發布已啟用。本次沒有啟用寄信、LINE、客戶發布、資料爬取或正式模型訓練。足夠真實資料、真供應商／手機 LINE／Google／客戶 HTTP／模型品質和常駐排程，不能由本機工程、資料庫已套用或已登入狀態代替。

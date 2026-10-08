# DiscoveryStack 設定與實際啟用

這份文件將一般客戶流程需要的設定集中在一處。程式驗證、設定已填、供應商已驗證及實際完成交付是不同階段；後台「上線設定」會讀取目前服務的設定，且不回傳任何秘密值。

**目前平台發布節點：**[2026 年 10 月 8 日發布與啟用核對](#2026-10-08-release-and-activation-checklist)。該節點記錄目前 schema／Live 程式與仍關閉的操作閘門；較早的驗收章節保留各自當時的狀態，不因後續發布而改寫。

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

狀態：**IMPLEMENTED / LOCAL_VALIDATED / DATABASE_APPLIED / LIVE_VERIFIED / CI_VERIFIED / OWNER_READ_VERIFIED / PROVIDER_GATED**。本節的新工程不沿用上節郵件版本 `f0daa27` 的正式 Live／owner 讀取證據；以下為本輪備份／正式 0047／新執行版本／CI 與唯讀驗收。使用者重新登入後，新 action workspace 的正式 owner 唯讀讀取已獨立通過；不代表有資料時的 owner 隔離、業務寫入或真供應商驗收。

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
- 新版正式 owner 面板首次在原使用者分頁開啟並只按「重新讀取」時，精確 `/api/interventions/closed-loop/live-actions` 為 HTTP 401／application/json，fromDiskCache／fromServiceWorker 均 false，畫面要求重新登入。原 owner session 當時已過期，保留這筆 **OWNER_READ_SESSION_REQUIRED** 的失敗證據，不把它當作成功空清單或 owner SQL 驗收。請使用者在既有 `/owner-login` 自行重新登入；登入期間停止網路觀察，不讀取／代填密碼，不偽造 JWT，也不擷取 cookie／header／body／信箱／客戶資料。
- 使用者確認重新登入後，2026-10-07 20:27:24（Asia/Taipei）完成新面板的獨立正式 owner 補驗：進入頁面及按唯讀「重新讀取」各一次，精確 `/api/interventions/closed-loop/live-actions` 均為 HTTP 200／application/json，兩次 fromDiskCache／fromServiceWorker 均 false。route 驗證目前 owner 後實際查詢正式資料庫；畫面顯示「目前沒有實際發布操作紀錄；不會建立示範資料」及資料擷取未啟用，沒有審查按鈕。僅保存 path／status／MIME／快取旗標及不含私人內容的空狀態截圖，存受限本機附件、未放 Git，完成後再次停止網路觀察。這是新 action workspace 的 **OWNER_READ_VERIFIED**，不是沿用舊郵件頁 owner 200；沒有建立正式合成紀錄、執行審查／擷取／發布／訓練、寄信或 LINE。使用者正常重新登入可能更新登入時間，不把先前 migration checkpoint 的資料不變證明誤稱為之後資料永遠不變。

沒有升級或購買，沒有變更既有 Render 環境值；內容 scheduler／建站執行維持關閉，新學習／live-action／郵件開關未設定、依程式預設關閉且沒有 linked environment group。既有每週審稿／LIFF 介面開關已開啟，但正式 LINE 憑證尚缺且 scheduler 關閉，不能當作真 LINE 發送／客戶發布已啟用。本次沒有啟用寄信、LINE、客戶發布、資料爬取或正式模型訓練。足夠真實資料、真供應商／手機 LINE／Google／客戶 HTTP／模型品質和常駐排程，不能由本機工程、資料庫已套用或已登入狀態代替。

## 2026 10 08 Release and activation checklist

**狀態：**`2d796067b15da47acc289be568db5125043b0a93` 已推送至兩個既有 main，正式 schema 0048、0049、0050 已套用，對應 Render Free 版本為 Live。以下 6,013 通過的測試數字屬於這個已發布 commit 的既有驗收，不代表任何後續本機變更。這不代表任何郵件、LINE、爬取、發布、訓練或模型啟用已執行。

- 正式核對結果為 200 張實體表、199 張應用 schema 表與 51 筆 migration ledger；0048／0049／0050 均在 ledger。196 張既有業務表語意未變，新增的三張表均為空。受限本機備份與隔離還原已驗證，臨時正式資料副本已移除。
- 同一來源依序通過 typecheck、fresh node-server build、完整安全 Vitest（6,013 通過、0 失敗、69 跳過）；隔離 MySQL 8.4.11 的 GEO 案例另有 5 通過、0 失敗、0 跳過，僅使用合成資料，測試容器已移除。兩個 repository 的 CI 均成功，各有兩個必要 job：[origin run 37659015905](https://github.com/emily07100710/DiscoveryStack_nuxt/actions/runs/37659015905)、[backup run 37659020429](https://github.com/tendertech2018/DiscoveryStack_nuxt/actions/runs/37659020429)。這些結果分別代表本機、隔離 SQL 與 CI，不等於真實供應商業務驗收。
- Render 維持既有 Free 方案，Live deployment `dep-db381a7f3r2c738ev6dg` 對應上述 commit。19 項正式 GET／OPTIONS 唯讀檢查通過，服務提供的 client artifact 與同版 fresh build 相符；四個擁有人頁面唯讀載入成功。驗收沒有變更操作旗標。
- 2026-10-08 發布驗收的唯讀快照中，郵件頁顯示未完整設定、寄送關閉及零筆紀錄。GEO 合格項目、訓練紀錄及模型 artifact 均為零；學習資料權利／同意與擷取未開，成效學習未啟動。每週 LINE 尚缺正式設定，scheduler 關閉。以上是該次驗收的安全停用狀態，不是空狀態成功交付或功能故障，也不是後續即時查詢。

首次真實啟用仍須逐項取得明確授權並完成對應驗收；資料庫已套用及程式 Live 不會自行打開旗標：

1. **郵件與回報：**備妥已驗證寄件網域／From、Resend API 與獨立 webhook 簽章設定及正式 webhook 註冊，再分開驗收 provider 接受、回呼觀測及實際收件。Provider 回報的 `delivered` 只表示送達收件郵件伺服器，不代表人的收件匣或閱讀；不得以合成回呼作正式證據。
2. **LINE 審稿與發布：**核對同一 LINE Provider 的 Login／LIFF 與 Messaging API、官方帳號及客戶綁定／同意；再由 owner 核准精確發布目標、策略、來源、選題計畫與預算，並由客戶確認該版本原稿。啟用全域 scheduler 前，須盤點它會一併放行的其他 Content Operations 背景工作、既有客戶、待處理項目與費用。游標公平性不保證 Render Free 常駐或睡眠期間補跑；正式 LINE 收受、發布回執與下一輪量測須分別驗收。
3. **資料與模型：**單一站點可先啟動有權利／同意的受控蒐集與流程 pilot，但不足以通過引用模型開發門檻：政策最低值為 200 候選、30 query groups、5 網站、2 引擎、20 正例、40 個已驗證 hard negatives、14 天觀測及六個非空分區；這些是最低准入條件，不是品質保證。引用模型的 site／query holdout 依跨網站、正規化查詢、run 及同 run query group 的連通元件隔離，並另設 temporal holdout；成效模型則使用獨立的 subject 分組與時間外 cohort，不能混為同一套切分。確認各來源權利、用途、同意、保存期及撤回流程；unknown 不得當作引用真值。成效模型另有獨立候選／分區門檻與 owner 核准，須按其規格驗證。V1 目前只提供實驗性 shadow/advice，不存在 `production_active` 狀態或正式模型啟用能力；正式品質與 production 能力尚未驗收，shadow 不等於正式模型。

Render Free 不承諾持續執行排程；任何付費升級或新託管需另行決定成本及保存責任。客戶一鍵建站、域名／合作工作仍依既定優先序延後。

### 目前仍待完成的自有平台工作

- **Email**：sender 網域／From、Resend 與 webhook 外部設定、真實簽章 callback 及收件驗收尚未完成；寄送、事件觀測與人工結案旗標維持關閉。
- **LINE／週更發布**：正式 LINE 設定與真實客戶綁定、逐稿同意、發布回執及後續量測尚未驗收；全域 scheduler 維持關閉，啟用前須盤點同一開關會放行的其他 Content Operations 工作與費用。
- **Impact Engine（PARTIAL）**：已有部分 Entity／Claim／Source 關聯，但尚無完整 consumer/registry 串起 affected content、schema、datasets、public API、benchmark prompts 與 required reviewers。既有 intervention/outcome V2 export 已存在，且依設計不構成訓練授權；不應把它列為缺失資料集。
- **學習閉環**：2026-10-08 發布驗收的唯讀快照中，eligible GEO observations、training runs、artifacts、learning rights 與 collection 皆為 0。單站 pilot 不代表達到引用開發或成效模型的最低樣本、站點／query／engine／時間多樣性門檻；不使用合成資料充作正式證據。

### 2026 10 08 本機請求本文安全修補驗收

**狀態：IMPLEMENTED / LOCAL_VERIFIED / NOT_DEPLOYED。** 這批修補以 `2d796067b15da47acc289be568db5125043b0a93` 為基底，尚未提交、推送或部署；不能沿用上方 Live 節點作新修補的正式證據。沒有新增 migration、依賴或付費資源，也沒有變更正式資料庫、服務旗標或供應商設定。

- Knowledge API 的 64 KiB 上限改為檢查實際 UTF-8 本文大小，包含 chunked、低報 Content-Length、adapter bytes 和 H3 快取；已解析成小物件的原始大本文仍會拒絕。精確上限可接受，多一 byte 回 413。路由仍先驗證 owner，JSON 不能提供 owner 權限；超限時不進業務服務。
- 共用 JSON／原始本文讀取器拒絕已被消耗且未保存完整原始 bytes 的 Node／Web 串流，不把尾段或空結果當完整本文。完整原始快取仍可重讀，較小的後續限制會重新核對原始大小；解析快取仍保留解析權威。郵件 webhook 的 Svix 簽章演算法未變，重建 JSON 仍不能冒充簽章原始 bytes。
- 1,531 個追蹤中來源與新測試檔在驗收前凍結，來源 SHA-256 為 `3c01e946aaac09e9d596cef47744d39e0c751ad5e292454dc482bc6b93fbac94`。本設定指南不納入來源凍結，其歷史內容與新增驗收章節另行核對；其餘修改的規格、程式與測試都在同一份 manifest，執行後逐項核對未變。
- 既有 Node 22.23.1／已安裝入口依序完成 typecheck（20.054 秒）、fresh node-server build（25.236 秒）及完整安全 Vitest（251.518 秒），全部 exit 0。350 個測試檔中 330 通過、20 跳過；6,042 項通過、0 失敗、69 跳過，總計 6,111 項。三個本文邊界測試檔另有 104／104 通過，已包含在完整測試數字內，不重複相加。
- 既有實際本機 H3 chunked webhook／固定路由／Nitro 正式建置預覽測試均通過；使用合成事件、mocked provider/storage 及 127.0.0.1，不是正式 owner／Resend／LINE／資料庫驗收。69 項跳過仍需另行設定與授權，本輪沒有以正式資料訓練或啟用正式模型。
- 失敗與重驗紀錄均保留：較早 typecheck／build 結果因後續發現 raw／parsed cache 漏洞而作廢；新增 Node fixture 一度造成 `TS2322: Type 'PassThrough' is not assignable to type 'BodyInit | undefined'`，修正為 Node adapter 的 `rawBody` 欄位後完整重驗。初次完整測試因 `listen EPERM: operation not permitted 127.0.0.1` 而有 5 項失敗、78 項跳過及 4 個未處理例外，未當成通過；在有界本機測試權限下以相同來源及 build 重跑，得到上述零失敗結果，沒有刪測試、改上限或放寬業務規則。

本指南原有 42,073 bytes 的歷史內容保持不變；六份文件的 12 個本機連結與六個發布節點連結均已核對。最新規格明確區分 schema／程式已部署與真實操作尚未啟用；這次文件與安全修補仍只完成本機驗收。

### 2026 10 08 本機 Knowledge 影響預覽驗收

**狀態：IMPLEMENTED / LOCAL_VERIFIED / NOT_DEPLOYED；完整 Impact Engine 仍為 PARTIAL。** 知識工作台新增實體、主張與來源的私有唯讀影響預覽，沿用現有資料表，沒有 migration、依賴或付費資源變更。27 個本機變更檔尚未提交、推送或部署，不能沿用上方 Live commit 作為新介面的正式驗收。

- [影響預覽規格](../KNOWLEDGE_IMPACT_PREVIEW_V1.md)定義精確 ID／關係、來源歷史版本、明確合併轉指，以及六類輸出。文章與 schema 僅涵蓋已知 native bindings；schema 只計算目前 author／publisher 投影輸入，未生成最終公開 bytes。資料集、public API、benchmark prompt 與 reviewer adapter 尚未接入，介面明確顯示無法判定，不把空清單當成完整零影響。
- 擁有人身份先於查詢解析。十類 collection 在一致性唯讀交易內按 owner 篩選，以 SQL LIMIT 2001 偵測超過 2000 筆的情況；超限、跨 owner／缺失引用、循環與不一致關係皆停止。resolver 在展開 lineage 前檢查 fan-out 與 registered dependency 上限，不以截斷資料回完整結果。回應沒有原始主張、來源全文、摘錄、metadata、provenance 或 credentials。
- 1,543 個來源檔在驗收前凍結，SHA-256 為 `0e6f4544226eb65fc1e0494e67f6b97d21c939ea6565382860fccf9c2ba5c3f5`。本設定指南明確排除於來源 manifest，以另行追加驗收紀錄；其餘規格、程式、測試均已在每階段及完整測試後重新核對未變。
- Node 22.23.1／既有已安裝入口依序完成 typecheck（20.761 秒）、fresh node-server build（24.091 秒）與完整安全 Vitest（246.129 秒），全部 exit 0。355 個測試檔中 335 通過、20 跳過；6,088 項通過、0 失敗、69 跳過，總計 6,157 項。11 個相關測試檔另有 166／166 通過，已包含在完整數字內；其中新影響預覽增補 46 項，不重複相加。
- 新測試真正載入 GET handler、編譯並掛載 Vue 元件，核對六類 coverage、下游 lineage、401／422／404／409／503、私密錯誤遮蔽、過期回應與 props 刷新；SQL 測試用 Drizzle 實際產生查詢，再以 mock MySQL transport 核對 owner／排序／limit 與一致性唯讀交易設定。這不是正式 MySQL、已登入瀏覽器視覺或客戶業務驗收。
- 兩次較早的凍結 typecheck 均 exit 2，完整保留失敗來源與 log。原因包括 Nuxt `$fetch` 路由泛型深度、implicit any 與 readonly 測試 fixture 修改。修正為精確固定 GET transport 的 unknown 回應邊界及不可變 fixture，不放寬 server 權限、資料門檻或 runtime guard；最終以新的來源重新完成全序列驗收。建置既有 browsers data 過期警告保留，未更新依賴或隱藏警告。

本輪不讀取正式 credentials／DB URL，19 個操作旗標保持關閉，測試使用合成資料、mock transports 與本機 127.0.0.1。完整六類 consumer registry、持久化 revision／影響事件、reviewer 政策及 mutation hooks 尚待補齊；真實學習資料、LINE／郵件／發布／模型品質及正式啟用仍按各自授權與驗收條件處理。

### 2026 10 08 本機 GEO 真實觀測登錄驗收

**狀態：IMPLEMENTED / LOCAL_VERIFIED / NOT_DEPLOYED；不是正式模型訓練。** GEO 工作台新增已審核來源、候選集合與觀測的登錄流程；證據驗證、使用同意與個資審核仍各自獨立。登錄、重播回執及瀏覽歷史都不能提供訓練准入或模型啟用權限。這批程式沒有 migration、依賴或付費資源變更。

- 觀測使用伺服器推導的精確來源識別，避免同一 LLM run 裡不同問題引用同頁時撞成同筆資料；既有合法來源識別仍可核對。候選集合撤回、來源未核准、相同來源重複登錄、損壞回執與交易失敗皆停止或回滾，不用儲存錯誤冒充資料不存在。
- 正式發布的精確稿件如有合法回執，可提供部分結構特徵；缺失欄位維持 unknown，不以目前新稿替代歷史稿，也不因此自動核准個資或訓練。新 intake 本文上限為 64 KiB，既有 GEO 本文上限保留 256000 bytes；同源檢查與實際 UTF-8 bytes 檢查在業務處理前執行。
- 驗收來源為 1555 個檔案，SHA-256 `ba11a989cb0f6885de5f180e812ec0ce3fceec4e929f0e8aad11db5196653ea7`；本設定指南排除於 manifest，其他來源在各階段及測試完成後均核對未變。Node 22.23.1 依序完成 typecheck（20.561 秒）、fresh node-server build（24.374 秒）及完整安全 Vitest（250.624 秒），全部 exit 0。361 個檔案中 341 通過、20 跳過；6195 項通過、0 失敗、69 跳過，總計 6264。六個登錄相關測試檔另有 107／107 通過，已包含於完整數字，不重複相加。
- 完整 JSON 報告另行核對計數及 SHA-256 `b5619cf98b32973fea13f6e1192381b400a77163dee4faed01bd768a0ea9c6ce`。已建置 Nitro 的四個本機 HTTP 檢查亦通過：匿名請求即使有重複 query、壞 JSON 或外站 Origin，均先回 401，並維持 no-store、noindex 與無 CORS。它們不是已登入 owner、正式資料庫或真實客戶操作驗收。
- 較早凍結來源的 typecheck exit 2（17 個型別錯誤）與重點測試通過紀錄均保留，未以測試通過取代編譯。修正 DTO narrowing 與 query mock 型別後，以上述新來源完整重驗；建置既有 browsers data 警告保留，未更新依賴。

本次使用合成 fixtures、mock transports 與本機伺服器，未讀取正式 DB URL、啟動 Colab、呼叫 provider、寄信、LINE 發文或發布客戶內容。跳過的正式串接測試仍未驗收，實際模型品質仍需可靠且已核准的真實資料。

### 2026 10 08 本機 Knowledge 修訂紀錄驗收

**狀態：IMPLEMENTED / LOCAL_VERIFIED / NOT_DEPLOYED。** 這批增補在既有 `main`／HEAD `2d796067b15da47acc289be568db5125043b0a93` 上完成，未提交、推送或部署。Entity／Claim／Source 的語意修訂與配對 mutation event 同一交易提交；新增 owner-only 唯讀歷史 API 與工作台元件，不提供發布、模型啟用或訓練准入權限。完整 Impact Engine 與真實資料學習閉環仍為 PARTIAL，不能因這批通過而標示整個產品完成。

- 新 subject 建立 revision 1；既有 subject 首次實際變更時保存明確標示的 legacy baseline，再建立新修訂。不推測或補造更早歷史；語意 no-op 不增加紀錄。已追蹤 subject 的 head／event 損壞或內容漂移會拒絕並 rollback，配對 event 儲存失敗也回滾原始 mutation。
- 私人歷史每頁最多 25 筆，逐筆驗證 canonical snapshot、hash、revision／event 配對及跨頁鏈結；cursor checksum 不是身份授權。HTTP DTO 不含 raw snapshot。私人 snapshot 仍可能包含名稱、主張與識別碼，不能宣稱全部去識別，也不能用 digest 完整還原原文。
- `0051_knowledge_subject_revisions_v1.sql` 已生成，只增加兩表、owner／revision 外鍵及索引；0050 的 199 個既有應用表 snapshot 與 journal prefix 核對未變，0051 為 201 個應用表。migration identifier policy 通過。本 SQL 沒有套用至正式 TiDB，正式相容性、備份與 rollout 仍須獨立驗收。
- 驗收前凍結 1,573 個來源檔，SHA-256 `e45451d49d6c349764a8c28784def4b47275251d5ee9f49389eddd92556d7c06`。本指南排除於執行來源清單，僅追加驗收紀錄；其他程式、測試與規格於各階段及完整測試後均核對未變。
- Node 22.23.1／既有入口依序完成 typecheck（21.472 秒）、fresh node-server build（22.837 秒）與完整安全 Vitest（248.75 秒，包裝程序 249.429 秒），全部 exit 0。369 個測試檔中 348 個有通過測試、21 個全為 opt-in 跳過；6,253 項通過、0 失敗、75 跳過，總計 6,328 項。九個重點檔案另有 74／74 通過，已包含於完整測試，不重複相加。完整 JSON 報告的 assertion 計數獨立核對，SHA-256 `6777b4678bdd016c4e50bf61ebe537e786fa6f9fce5e0637a02f5e8c0b954be0`。
- 另以電腦上既有原生 MySQL 9.5.0 執行隔離 SQL：TCP／MySQLX 關閉，只使用 0700 私有目錄內的 Unix socket。完整 52 份 migration 建立 202 個實體表（201 個應用表加 ledger），六項真 SQL 驗收全部通過，涵蓋建立／修改／merge／undo、配對歷史、注入失敗 rollback、並行 alias 與相反 merge、雙連線一致性讀取及資料庫 READ ONLY 禁止寫入。報告 SHA-256 `8dd10785f296eaaef7be2f8b8862655ffbbcbe98230d3190dbd5db4fa1de9e5b`。這六項是另行 opt-in 實測，不改寫完整安全套件中六項 SQL 跳過，也不是正式 TiDB 的證明。
- 較早失敗紀錄完整保留：合成 fixture UID 超過既有欄位長度、Drizzle 合併 `WITH CONSISTENT SNAPSHOT` 與 `READ ONLY` 產生無效 SQL，以及 mysql2 pool 型別差異。已修正 fixture、transaction 設定及不依賴 `$client` 的 repository 型別，沒有放寬 schema、斷言或 owner 邊界。MySQL 唯讀視圖由交易第一個 nonlocking SELECT 建立，不宣稱 transaction 開始瞬間已有 snapshot；正式 TiDB 的交易契約仍需另行核對。
- 同版 fresh Nitro 的六項匿名 GET 保護全部通過：先回 401、private no-store、noindex、無 public CORS，包含重複 query、外站 Origin 與偽造 cursor。沒有 owner session 或正式 DB；這不是已登入 owner 的業務驗收。
- 凍結來源中的實際 Vue 元件以本頁記憶體合成資料完成桌面 1280×900 與手機 390×844 驗收：25 筆第一頁、再讀兩筆到 revision 1 的明確 legacy baseline、末端停止、切換 subject 清除舊頁且不自動讀取、空紀錄與安全錯誤訊息。桌面 document／viewport 均 1280 px、手機均 390 px，沒有水平溢出。合成操作計數始終發布 0／訓練 0；截圖明確標示合成驗收，受限本機保存，未放 Git。暫時 viewport 已恢復，自建分頁及預覽程序已關閉。
- 收尾唯讀核對隔離 fixture 為 19 個 revisions、19 個 events、0 leads，MySQL 已正常 shutdown，socket 已不存在。私有合成 datadir 與失敗／成功紀錄保留，沒有聲稱整個 fixture 檔案已刪除；沒有正式資料或正式資料庫變更。本輪沒有安裝依賴、新付費資源、provider、Colab、寄信、LINE 或客戶發布，19 個操作旗標在安全驗收中保持關閉。

### 訓練方式與目前模型證據

這一輪完成的是本機工程驗收，不是新的正式模型訓練。GEO V1 的 `regularized_logistic_baseline_v1` 與 `pairwise_logistic_ranker_v1` 使用本機 CPU 的確定性數值擬合；成效方向模型也使用有界 logistic fitting。合成測試確實會執行擬合與 artifact round-trip，但這些資料不能作為真實模型品質或客戶成效證據。

既有 [101 筆 Colab 收據](../../COLAB_TRAINING_RESULT_101.md) 是 2026-08-21 的 development proof of concept。[500 筆報告](../../ml/results_500.md) 記錄 2026-08-27 Tesla T4／DistilBERT 的兩 epoch fast-path candidate，結果為 `candidate_not_ready`；[1,087 筆報告](../../ml/results_1087.md) 記錄 CPU 首個訓練 batch 中斷，沒有完成 epoch、checkpoint 或評估產物。這些是歷史報告，不是此刻正在 Colab 訓練，也不是已匯入或正式啟用的 GEO V1 模型。

2026-10-08 發布驗收快照中的 eligible GEO observations、training runs 與 artifacts 為 0，這一輪沒有重新查詢正式資料庫。下一步仍是取得有權利、同意、去識別審核與真實可驗證標籤的觀測，完成獨立網站／query／時間外驗證及 owner review；算力或開啟 Colab 不會取代上述條件。V1 仍只有實驗性 shadow/advice，沒有 production-active 模型啟用能力。

### 2026 10 08 本機 Knowledge 修訂 pin 驗收

狀態：LOCAL_VERIFIED／NOT_DEPLOYED。影響預覽現在能核對精確 adapter 登錄的 Entity／Claim／Source 語意修訂 pin；它尚未建立持久化 consumer registry，也不等於完整 Impact Engine 或正式模型閉環完成。

- 同一唯讀交易取得每個 owner／subject 的最新修訂摘要，不受歷史每頁 26 筆的內部上限影響；11 個集合各以 2001 sentinel 保護。修訂編號、content hash 與 revision fingerprint 必須同時符合 head，缺失或舊 pin 保留精確 consumer 並標示 stale。預期 pin 與目前 head 分別進入 lineage fingerprint。
- SQL 內計算私人 canonical snapshot 的 SHA-256、byte 長度及 owner／subject 識別，伺服器重算 revision fingerprint 並核對配對 mutation event；SQL 結果與 HTTP DTO 均不傳出 snapshot 原文。這是最新 ledger head 的核對，不是全部歷史稽核或當下可變資料的重新認證。
- 凍結 1575 個來源檔案，SHA-256 `ab75cc0ce33376354f0fb5600a8dc274b65cd56a98c5604e5d200d61e6d9baca`。依序通過 typecheck（25.002 秒）、fresh node-server build（23.726 秒）與完整安全 Vitest（262.54 秒）：350 個檔案／6278 項通過、21 個檔案／76 項跳過、0 失敗。JSON 報告 SHA-256 `98c4a2e19d27bed34550a5609e606d540dbf767ba7f4736ee4cbe6eb97bb7c67`；71 項 focused 測試包含在上述通過總數中，不重複加計。外部整合 skip 不是 provider 驗收。
- 已安裝的本機 MySQL 9.5.0 另完成 7 項／0 失敗／0 跳過的隔離 SQL 驗收：完整 52 個 migration、202 張實體表（含 ledger）、跨連線 MVCC、超過歷史一頁的最新 head、owner 隔離、snapshot digest／revision fingerprint／event fingerprint 三種損毀拒絕及 fixture 還原。JSON 報告 SHA-256 `47c8f1b4a0a101904dff23ca94aa08847a6338ba4fb5f15584bc2c7730066fa1`。這不是正式 TiDB 驗收。
- 首次 frozen typecheck 因新測試的 `unknown` 參數未縮窄而失敗；只補型別 guard，再以新來源凍結完整重驗，原失敗紀錄保留。兩次 SQL 執行間僅重建指定私有 socket 上自建的合成資料庫，不涉及正式資料。收尾有 50 個 revisions、50 個 events、0 leads；自建 MySQL 已正常 shutdown，socket 不存在，私有 fixture 檔案保留。
- 此 pin 增補沒有新增 migration；既有 0051 仍未因此套用正式資料庫。沒有依賴安裝、新付費 GPU／資源、Colab、正式資料庫讀寫、真 provider、寄信、LINE、客戶發布、commit、push 或部署。完整 registry、追加式 impact event、reviewer 政策、CAS／冪等寫入及真實資料訓練仍須各自完成與驗收。

### 2026 10 08 本機 native 知識依賴登錄驗收

狀態：IMPLEMENTED／LOCAL_VERIFIED／NOT_DEPLOYED。知識工作台新增 [資料集與 Prompt 知識依賴](../KNOWLEDGE_CONSUMER_BINDINGS_V1.md) 操作介面與持久化 registry；它記錄 owner 明確選取的 native ID 對確切 Entity／Claim／Source 修訂的依賴，不自動核准資料、訓練或發布。完整學習閉環與六類 Impact Engine 仍為 PARTIAL。

- Dataset anchor 重用原 GEO 不可變 manifest validator，Prompt anchor 核對 owner／project／query 與原正規化 prompt hash。每頁 25 筆、26 筆 SQL sentinel，回安全 ID／version／hash；不回 prompt text、canonical snapshot、command key 或內部 owner／依賴圖。Native 缺失保留舊登錄供撤銷；存在但不可變 hash 或 parent 關係損毀則拒絕。
- Bind／重新 pin／revoke 都追加 immutable binding，ledger 與 current-head pointer 在同一 SERIALIZABLE 交易中寫入。Subject lock、CAS、直接 predecessor 驗證及 owner＋key SHA-256 唯一鍵保護競爭與重試；相同原命令回原收據，不建立第二筆。讀取使用同一唯讀視圖，對 heads、native anchors、修訂與配對 events 作有界批次核對，不把舊 pin 靜默換成新 head。
- 新增 0052 binding ledger 與 0053 current heads／command key hash migration，僅生成、未套用正式 TiDB；0051／0052／0053 必須先完成受控 rollout，才能使用新 registry。隔離 MySQL 9.5.0 的完整 54 份 migration 建立 204 張實體表（含 ledger），14 項真 SQL 測試全數通過，涵蓋雙連線 CAS、大小寫不同 command keys、回讀／重播、owner 隔離、catalog 分頁、parent 損毀、撤銷、失效 pin 與注入失敗 rollback。報告 SHA-256 為 `ec84035ee08fc25a80dc5c1e34e62bac6421b665fe80d8f8c4aa70aa15a716b9`；此測試不是正式 TiDB 驗收。
- 凍結的實際 Vue 元件已用本頁記憶體合成 fixture 驗收 1280×900 桌面與 390×844 手機。分頁保留 #77 選取、舊 pin 提示、重新綁定、Dataset／Prompt 新登錄、native 刪除後撤銷，以及 409 重新載入恢復均通過。模擬 POST 已提交後回應遺失，兩次請求只有一次提交及一次 exact-key replay；不確定期間欄位鎖定。手機 document width 為 390、panel width 為 370，0 個操作欄位橫向溢出。空清單、401、workspace／catalog／revision 503 均明確停止對應操作，無 browser console error／warning。這是實際元件的合成介面驗收，不是已登入完整 owner 頁面或正式資料庫業務驗收。
- 驗收後 HTTP guard 新增標準 `strictKeys`，在 owner／exact-origin／有界本文檢查後、repository 建立前拒絕未知欄位；核心的嚴格八欄位 parser 仍保留。三個新測例核對 ownerUserId／consumerVersion／promptText 不能提供權威，回固定 422 且不回顯內容。修正後 fresh Nitro 的 8 項匿名 HTTP 邊界實測皆先回 401，維持 private no-store、noindex、nosniff、no-referrer 與無 public CORS；未使用 owner session 或正式 DB。
- 最終驗收來源為 1595 個檔案，SHA-256 `0b45fcb45624e3094ca9273caf47499b2afcf02f3699fa3b9300f0e5c511ad89`。Node 22.23.1 依序通過 typecheck（20.651 秒）、fresh node-server build（22.279 秒）與完整安全 Vitest（242.45 秒）：357 個檔案／6390 項通過、21 個檔案／83 項跳過、0 失敗，三項皆 exit 0。JSON 報告 SHA-256 `f01d12e1c9a75f8272797313fcfb3932c6fa1e5be58611f3dc3118faec99c0bc`，逐筆 assertion 狀態也符合 6390 passed／83 skipped。兩個 guard／路由契約檔的 28 項已包含在完整套件中，不重複加計；83 項 skip 不是外部供應商驗收。這些數字只支持本段來源，不能用於後續 Knowledge 核准權威整合的變更。
- SQL 與瀏覽器驗收執行時來源 SHA-256 為 `b85feabb50013b7f0c1c0d76562c07cfc8c823f724033ed721c307e03589c8a7`；兩份 1595 檔 manifest 比對，只有 POST route 及其 route unit test 改變，SQL schema／repositories／integration test、Vue 元件與 page wiring 均未改。SQL／畫面未在 HTTP guard 修正後重跑；其證據僅支持上述未變的 SQL 和元件範圍。新 HTTP runtime 已按最終來源獨立重驗。
- 較早失敗紀錄完整保留：fixture UID 過長、Vue custom renderer 靜態節點支援、測試語法／mysql2 client 型別差異及完整套件首次 6386 通過／1 失敗／83 跳過。最後一項是新 POST 缺少標準 route-level strictKeys；修正 route 和新增測例，沒有刪除舊 contract 或 skip。自建 MySQL 關閉 TCP／MySQLX，收尾為 56 revisions、56 mutation events、8 bindings、7 heads、0 leads；daemon 正常 shutdown、socket 不存在。預覽 server 已停止、驗收 tab 已關閉、viewport 已還原，fixture 與報告保留。

本批沒有新增付費資源、依賴安裝、Colab、正式資料庫讀寫、provider、郵件、LINE、客戶發布、commit、push 或部署。依賴登錄與過期提示尚未接進 GEO 的 dataset approval、training reservation、artifact hash、prediction、shadow 和 fallback 的使用權威；追加式下游 impact event、required reviewer 政策與 public API registry 也仍未完成。下一段需將依賴快照作為獨立、版本化的 owner approval authority，避免把事後 binding 寫回不可變 manifest 造成循環，也不能把已撤銷的空集合誤當無依賴。真實資料與模型品質仍須各自驗收。

### 2026-10-08 Knowledge 依賴核准接入 GEO 模型權威

狀態：IMPLEMENTED／LOCAL_VERIFIED（typecheck／build／無憑證完整套件）／NOT_DEPLOYED。本段接續上批登錄功能，不改寫上批來源的驗收範圍；整個 Impact Engine 與真實資料學習閉環仍為 PARTIAL。

- Dataset 核准必須由 owner 明確選擇「沒有知識依賴」或「使用已綁定的知識版本」並確認。核准快照與 immutable manifest 分開保存，包含 native dataset、精確修訂 pin 和撤銷 tombstone；舊／空／機器 reviewer 紀錄不能自動取得無依賴核准。
- Training reservation 與 artifact 的不可變 hash 現在包含確切 dataset decision ID 及 Knowledge authority fingerprint。新增 binding、修訂 head 變動、撤銷或重新核准都使舊參照失效；訓練前、保存產物前、shadow／fallback／prediction／草稿建議接受結果前重查權威。撤銷操作仍可執行。ModelOps 保留既有 owner-authorized policy 的模型 shadow admission，但不得替 owner 宣告 dataset 的 Knowledge 依賴。
- HTTP 收據與工作台 history 只回傳核准 mode、hash、active pin count，不回傳私人 heads 或 native dataset ID。冪等重播回傳歷史收據，明確標示 `receiptIsCurrentAuthority: false`；目前可訓練狀態由最新 workspace 與執行時檢查決定。UI 以實際 mounted SFC 測試確認明確選擇、確認、權限失效與不確定回應的 exact-key retry。
- 0054 migration 只新增 `geoOutcomeDatasetDecisions.knowledgeAuthority` JSON 欄位，已生成但未套用任何正式或隔離 SQL。本段新的真實 SQL、正式 TiDB、已登入完整 owner 頁面驗收仍為 NOT_RUN；上批 14 項 SQL 與桌面／手機截圖不能代替本段權威整合驗收。
- 無憑證的整合 focused suite 曾執行 7 個檔案／81 項通過、0 失敗、0 跳過，含實際 CPU 合成擬合、訓練中依賴變動、模型 policy decision await 變動及 prediction 後撤銷 fallback。該次執行包含於後續完整驗收的功能範圍，不與完整套件通過數重複加計；CPU 合成擬合不是正式資料訓練或真實模型品質證據。
- 第一個 frozen 來源為 1606 檔、SHA-256 `9c55ff7c55adc6e9786499892b11c891fb8e525d92b9625f3336f3f5636289d2`；typecheck（27.798 秒）及 fresh build（26.409 秒）通過。完整套件為 6425 通過／6 失敗／92 跳過，6 個失敗檔與 4 個 unhandled errors，JSON 報告 SHA-256 `c16097da6e365e3e76fabf82e95dc48db7f16a28b3a85bac4020d02c8eae8585`。排程測例直接改寫 owner 而沒有重建不可變核准指紋，造成 `expected 1 to be 5`；其餘五檔的本機 HTTP／SSR listener 被沙盒拒絕，直接啟動診斷也得到 `listen EPERM: operation not permitted 127.0.0.1:45290`。這次失敗不當成通過，也不刪除或 skip。排程 fixture 改成對六個 owner 各自建立真正不可變 manifest／核准，並驗證 manifest 不重複及 member owner 一致；既有最多五個 run 的斷言保持不變。只有該 cap 測例的 timeout 改為 60 秒，以容納實際合成擬合。
- 最終 frozen 來源仍為 1606 檔，SHA-256 `9572a4568db25b82d544378eef33f12895fcb214ea1b00b53c9b26ecedf66aac`。兩份 manifest 比對僅排程測例與 `tests/support/modelops-fixtures.ts` 改變，沒有在驗收期間修改應用程式。Node 22.23.1 依序通過 typecheck（26.806 秒）、fresh node-server build（27.349 秒）及完整安全 Vitest（322.38 秒，包裝程序 323.074 秒），三項 exit 0。385 個測試檔中 364 個有通過測試、21 個全部跳過；6440 項通過、0 失敗、83 跳過，總計 6523 項。完整 JSON 的逐筆 assertion 計數獨立核對，報告 SHA-256 `af16fca988ecbcd0a6d6b0e9e33d2dbc1896b0319627daf1749b99aff0ef5356`。測試結束後核對 frozen source 未變。
- 完整套件僅允許本機 HTTP／SSR listener 在受核准的非沙盒程序中綁定；環境不繼承任何憑證、Nuxt 使用空 env 檔，19 個操作旗標關閉，9 個外部測試旗標為 0。先前五個 listener 失敗檔本次均通過。83 項 skip 包含 GEO 真 MySQL 的五項及其他 opt-in SQL／provider／正式部署驗收；這些不能計為真資料庫或供應商通過。本批 0054 與已登入 owner 業務驗收仍為 NOT_RUN。

本批沒有啟動 Colab、呼叫真 provider、正式資料庫讀寫、寄信、LINE、客戶發布、commit、push、部署、安裝依賴或新增付費資源。追加式下游 impact event、完整 reviewer 政策、public API registry 與真實訓練資料仍需各自完成及驗收。

### 2026-10-08 後台工作總覽與 Do Alignment 草稿接收器

狀態：DS 後台第一輪整理為 IMPLEMENTED／LOCAL_VERIFIED／NOT_DEPLOYED；Do Alignment 接收器為 IMPLEMENTED／LOCAL_VERIFIED（型別、無憑證單元回歸與記憶體程式配對）／NOT_DEPLOYED。完整跨站發布與真實資料學習閉環仍為 PARTIAL。使用者另行明確授權 duduyoga 接收器的本機實作與合成測試，不包含部署、發文或真實預約／會員資料操作。

#### 員工日常操作順序

1. 進入「工作總覽」，先看四個工作入口，不必先理解模型、SQL 或各種技術代號。
2. 「客戶與內容」先處理客戶名單、內容策略、內容工作台，再進「文章送審與 LINE」核對該版本原稿的客戶確認。客戶確認不等於文章已發布。
3. 「成效與改善」核對發布收據、成效觀察與改善追蹤；AI 搜尋能見度的觀測不能直接當成模型品質保證。
4. 「知識與資料」管理知識資料庫與網站資料；另行取得資料用途、訓練同意與去識別審查。文章發布同意不等於模型訓練同意。
5. 「系統與設定」查看郵件紀錄；模型、訓練、一鍵建站等低頻工作收進可展開的「進階工具」。首頁原有技術表單也保留於預設收合區，沒有刪除既有 URL 或業務能力。

這是導覽及首頁資訊架構的第一輪整理，不是每個子頁都已重設計，也沒有因此建立員工角色或新增操作權限；既有 owner 身份、API 權威與授權規則保持不變。Do Alignment 首頁指引仍標示正式串接待核對，不以合成範例顯示假的待辦數字。

#### DS 本機驗收

- 最終凍結 1,611 個來源檔，SHA-256 `426d3cf7cc70d5c91e4e48ac9a253a9ce3d1eed02b8da4fb262ee92fd8e75002`；以既有 Node 22.23.1 依序完成 typecheck（24.875 秒）、fresh node-server build（25.853 秒）及完整安全 Vitest（314.31 秒，包裝程序 314.982 秒），全部 exit 0。388 個測試檔中 367 個有通過測試、21 個全為 opt-in 跳過；6,451 項通過、0 失敗、83 跳過，總計 6,534 項。JSON SHA-256 `64608c8bcdc672a15b47d2f1c30164b9a803ab428eed8691cfa021695e7d735d`，逐筆 assertion 計數獨立核對，執行前後來源凍結未變。本指南排除於來源凍結，只追加本段交接紀錄。
- 環境不繼承憑證、Nuxt 使用空 env 檔、19 個操作旗標關閉、9 個外部測試旗標為 0；受核准的本機 HTTP／SSR listener 可綁定。83 項 skip 不計為資料庫、供應商或正式部署驗收。
- 實際四個 Vue SFC 以記憶體合成 GET fixture 驗收桌面 1280×900 與手機 390×844，document width 分別為 1280／390，無水平溢出。手機選單可開關、切頁自動收合；每頁只有一個正確的目前頁面標記，進階頁會展開對應導覽。從子頁返回首頁會重新讀取 overview，技術表單預設收合；401／503 明確顯示安全登入／錯誤狀態，不暴露可操作表單。
- 畫面驗收使用實際首頁、導覽及指引元件；其他子頁內容為導覽驗收 stub，不宣稱完整子頁業務驗收。Console warning／error 為 0，合成發布／訓練計數始終為 0。截圖標示「合成驗收」，僅存受限本機附件，未放 Git；自建預覽程序與分頁已關閉、viewport 已恢復。
- 較早 typecheck 的新測試型別錯誤，以及首次完整套件 6,445 通過／6 失敗／83 跳過的紀錄均保留。六個失敗是原本直接搜尋靜態導覽標籤的 contract，已改為核對資料驅動導覽與實際 layout wiring，身份／API／公開邊界斷言仍保留；沒有刪除或 skip 測試。最終數字僅屬上述重新凍結來源。

#### Do Alignment 本機接收契約與證據

- 新增固定 `POST /api/first-party/content-ingest`，預設停用。HMAC 綁定原始本文、方法、路徑、確切站點 origin、時間與 nonce；128 KiB 串流上限、嚴格欄位、人工送審狀態、內容與命令指紋都在資料庫前核對。不依請求本文指定作者，作者只取伺服器設定且須為既有 teacher。
- 只新增私有 Blog 草稿與 CREATE revision；沒有公開欄位寫入、沒有覆寫現有老師文章。草稿、收據與 nonce ledger 必須同一交易；相同原命令重試回原始收據，不重建或修改文章。不同內容、轉換器版本／產物、slug 衝突或跨命令 nonce 重用拒絕。支持有界文字段落、標題、引用與粗／斜體；不支持的 HTML、圖片、連結、code、列表等明確拒絕，不默默丟掉內容。
- 回 HTTP 202 `draft_received`、`published:false`、`receiptScope: draft_ingest_outcome`、`receiptIsCurrentState:false`，沒有 `remoteRevision`。收據描述初次接收結果，不保證文章日後仍是 v1 或未公開；不能作目前發布狀態查詢。
- 最終凍結 duduyoga 447 個來源檔，SHA-256 `2fc88a3c9ac318be9c18e985720684811e7f5af6477abe9b00f788612cc38b4a`。既有 Node 22.23.1 typecheck（5.723 秒）與無憑證完整 Vitest（4.63 秒，包裝程序 4.964 秒）均 exit 0；115 個測試檔中 98 個有通過測試、17 個全跳過，814 項通過、0 失敗、126 跳過，總計 940 項。新增接收器 47 項已包含在 814 項中，不重複加計。JSON SHA-256 `638dafab693a344972d0a5c9e1da2895262c81364ce6f55ad063898ef18fe48d` 已獨立核對；來源執行前後未變。
- 使用空 env directory／不繼承憑證、關閉 PostgreSQL opt-in，僅 fake SQL 驗證交易命令及安全分支；126 項 skip 不是 PostgreSQL 通過。Prisma schema 用私有複本與 dummy localhost URL 完成 validate，不建立連線。新 migration、RLS 規則及 nonce／receipt 表僅準備於來源，沒有套用任何真 PostgreSQL；Do Alignment 的 Next／OpenNext build、Cloudflare worker 與真實 SQL runtime 仍為 NOT_RUN。
- 另用實際 DS sender 與實際 Do handler 做 1 項合成程式配對，記憶體 fetch／store、無 socket／DB，1／1 通過：Do 產生私人草稿收據，DS 因缺少正式發布 `remoteRevision` 安全停止，不會誤報 delivered。此 private harness 不增加跨 repo CI 依賴，也不是 HTTPS／正式 worker 證據。

#### 尚未打通的下一段

1. DS 必須增加明確的「草稿已收到、等待老師審核」狀態，並接受 draft-only 收據；目前 sender 會以 `REMOTE_IDENTITY_COLLISION` 停止，因此尚不是可啟用的日常跨站送稿流程。不得補假的 `remoteRevision` 將私人草稿當成正式發布。
2. 另行授權並完成 Do Alignment 的受控 PostgreSQL migration、備份／還原驗收、伺服器設定與簽章 key 交接、Next／OpenNext build、Cloudflare runtime 及私有／公開查詢驗收。不要用本輪 fake SQL 替代。
3. 再完成真實 LINE 客戶綁定與逐稿確認、老師／客戶的精確發布權威、真發布回執與後續成效回收。發布同意與訓練資料授權必須分開；真資料、獨立驗證與模型審核仍未因單站 pilot 完成。

本輪沒有啟動 Colab 或以正式資料訓練、修改正式資料庫、寄信、LINE、客戶發文、變更會員／預約、commit、push、部署、安裝依賴或新增付費資源。使用者看到的現有線上後台尚未包含本段本機整理。

### 2026-10-08 DS 接住 Do Alignment 私人草稿回執

狀態：IMPLEMENTED／LOCAL_VERIFIED／NOT_DEPLOYED。本段完成上一節「尚未打通的下一段」第 1 項的本機程式與測試：DS 能辨識、保存及重播 Do Alignment 的 draft-only 202 回執，並顯示「草稿已收到，等待網站老師審核」。上一節 sender 安全停止的結果是當時版本的歷史紀錄；本段不改寫它，也沒有因此完成第 2、3 項或整個真實資料學習閉環。

#### 使用者看得懂的狀態與安全邊界

- 客戶確認、網站收到草稿、老師正式發布是三個不同階段。內容工作台與「文章送審與 LINE」現在區分待網站審核；不把私人草稿標成已發布，也不提供同稿重新送出的按鈕。回執明示「這是歷史接收回執，不代表文章目前狀態或已發布」，不補造網址、`remoteRevision` 或發布日期。
- First-party sender 僅接受 Next.js signed adapter 的嚴格九欄位草稿回執，必須為 HTTP 202、`published:false`、`receiptScope:draft_ingest_outcome`、`receiptIsCurrentState:false`，且 publication ID／content hash 與原命令一致。未知、矛盾、跨命令或損毀回執拒絕，不退回當成一般 delivered。Managed Site 頁面編輯器也明確拒絕以文章草稿回執證明頁面發布。
- DS 保存 `draft_received` attempt 與授權狀態，calendar 進入 `awaiting_site_review`；送稿工作成功代表本次接收完成，不代表公開發布。私有接收不產生 delivered 的學習快照、發布後成效或 live-before 資料。重新讀取需核對 owner／client／entry／target、本文與命令指紋及原始回執；錯誤或跨 owner 資料不呈現為可信收據。
- 單一與多目標送稿均保留確切回執；已接收的目標不重送，只有未完成的目標可重試。重複 route ID 在對外操作前拒絕；部分草稿加部分正式 delivered 不會被合併成「全部發布」。接收後的 machine authorization 不能循環回新一次執行，只保留撤銷路徑。
- 修正三個實際 sender 的邊界相容問題：含 `|` 的 calendar key 在 wire 層變為穩定 opaque 指紋；Next.js 原命令時間固定為最初 attempt，回應遺失後重試不因當下時間改變 artifact／idempotency key；V4 的原始授權 SHA 僅在 wire review reference 層映射為 `ref-autopilot-v4-…`，持久化權威指紋保持原值。不放寬原 parser、owner 核准或精確內容限制。

#### 本機驗收與來源紀錄

- 基於既有 `main`／HEAD `2d796067b15da47acc289be568db5125043b0a93`；未 commit、push 或部署。最終凍結 1,621 個來源項目，SHA-256 `5911d7f2b6164b0ab0bcbc1c8d73a14dacb91b5410d4e9995539701f2141b3ed`。本指南排除於執行來源清單，只追加驗收紀錄；相對上一段 1,611 個來源的命名變更範圍之外全部保持不變，各階段與完整套件後均核對 frozen source 未變。
- Node 22.23.1 依序通過 typecheck（21.719 秒）、fresh node-server build（22.843 秒）與完整安全 Vitest（279.14 秒，包裝程序 279.781 秒），三項 exit 0。393 個測試檔中 372 個有通過測試、21 個全為 opt-in 跳過；6,491 項通過、0 失敗、83 跳過，總計 6,574 項。逐筆 assertion 狀態獨立核對一致，完整 JSON SHA-256 `6c1a90ebd1e367ef81ab04f60950342972ace6a31ffdfd0cbd1cf8b1836edcd2`。Build 保留資料索引過期提示與四個 BigInt／ES2019 警告，不宣稱無警告。
- 七個 focused 檔案另有 95／95 通過，已包含於上述完整套件，不重複加計。涵蓋嚴格回執、單目標／多目標持久化及重播、legacy calendar identity、6 分鐘後回應遺失重試、實際 V4 一／二目標排程經 sender 的合成配對、損毀及跨 owner 拒絕、managed-page 防誤報，以及實際 Vue 元件顯示／操作限制。沒有新增 skip 或以降低既有斷言取得通過。
- 實際 DS sender 與實際 Do handler 的 private harness 重新執行 1／1 通過：記憶體 fetch／store、合成文章、無 socket／DB，回執現在是 `draft_received` 而不是 delivered。這一項在 DS 全套之外，不宣稱 HTTPS／Cloudflare／真 SQL 已通。Do Alignment 447 個來源的 SHA-256 仍為 `2fc88a3c9ac318be9c18e985720684811e7f5af6477abe9b00f788612cc38b4a`，本段沒有修改 Do 專案；上段 814 項回歸不是本段重新執行的正式驗收。
- 實際 `OwnerDraftReceipt.vue` 以記憶體合成 fixture 驗收 1280×800 桌面及 390×844 手機，document／viewport width 分別為 1280／390，沒有水平溢出；回執元件只有一份，歷史、未發布及等待老師審核的文字正確，console warning／error 為 0。這是元件畫面驗收，不是已登入完整工作台或正式 DB 業務驗收；自建預覽 server／分頁已關閉，viewport 已恢復。
- 安全驗收不繼承任何憑證；Nuxt 使用空 env 檔，Vitest 使用私人空 env directory，19 個操作旗標關閉、9 個外部整合旗標為 0，只允許受核准的本機測試 listener。83 項 skip 不是資料庫、provider 或正式部署通過。
- 較早 typecheck 的 union 相容性與新測試型別錯誤已修正；一次完整套件因補上實際 V4 sender 邊界測例而主動中止，exit 130，不計為通過。失敗與中止紀錄保留於 `/private/tmp/ds-draft-state-20261008-KgKHXa`；最終數字只屬重新凍結後的來源。最終 manifests、結果、完整 JSON、logs、安全執行器與 private pair fixture 另保存於 `/Users/emilyyy/.codex/visualizations/2026/10/05/01a10d75-6003-77a0-975b-7701e90aa374/ds-draft-receipt-20261008-jhTjDhcM`，未放入 Git。

#### 尚未驗收／下一段

- `0055_private_draft_review_receipts.sql` 已生成，只在三個既有 enum 的末端增加接收／待網站審核狀態；snapshot 對比及 journal 的前 55 筆核對保持不變。沒有套用至任何正式或隔離 SQL；SQL runtime、正式 TiDB 相容性、備份／還原與 rollout 均為 NOT_RUN。既有 0051–0054 的未部署工作保留，不能只套 0055 就宣稱整個分支已上線。
- 已測 owner-approved 的回應遺失後穩定命令重試；V4 在對站已接收但 DS DB rollback、授權仍為 executing 時的自動恢復尚未端到端驗收，沒有放寬 machine authorization 的再授權規則，也不宣稱跨資料庫 exactly-once。
- 仍須完成 Do Alignment 真 PostgreSQL／Next／OpenNext／Cloudflare、設定與簽章 key 的受控驗收，再串接「老師核准 → 真正公開發布 → 可信發布回執 → 成效回收」。現有歷史草稿回執不能用來推斷老師現在是否已發布。
- 真實 LINE 客戶綁定與逐稿確認、實際發布權威、可驗證成效、資料用途同意／去識別與獨立模型驗證仍須各自驗收。發布同意不等於訓練資料授權；本段沒有新正式模型或 Colab 訓練。

本段沒有正式資料庫讀寫、寄信、LINE、客戶發文、會員／預約變更、commit、push、部署、依賴安裝或新增付費資源。現有線上後台尚未包含本段新增狀態。

### 2026-10-08 網站發布狀態的簽章核驗

狀態：IMPLEMENTED／LOCAL_VERIFIED／NOT_DEPLOYED。這一段完成「網站端回報發布快照 → DS 驗簽 → 工作台顯示獨立歷史核驗紀錄」，不是完整成效／模型學習閉環，也沒有將草稿回執改造成正式 delivered 收據。新增使用者提示均為繁體中文。

#### 操作與證據語義

- 工作台新增「核對網站發布狀態」，只在伺服器確認原始收稿回執、有效目標與客戶範圍後顯示。按下時才查詢，不在載入或排程自動連線。回應不確定時保留原命令鍵；重試回原核驗時間，不假裝重新觀察。
- 可區分核驗當時公開內容一致、公開內容已修改、公開版本一致但另有未發布編輯、未公開、已封存，以及舊收件紀錄缺少原始文件指紋。每筆都標明只代表觀察當時，不保證網站日後仍維持同一狀態；404、逾時或簽章錯誤不推定文章已刪除或取消發布。
- 原始來源 Markdown hash 與 Do 的 canonical BlogDocument hash 分開。只比較 ingest 當下保存的不可變 received document hash 與目前 published snapshot hash，不比較可變私人草稿；舊收據缺值時不從現在的 draft 或可能已裁切的 revision 回填。
- 狀態查詢重用 server-only signing secret，但使用獨立版本與 request／response HMAC，綁定固定 POST 路徑、精確 origin、原始 request／response hash、時間與 nonce。本文各限 4 KiB，時間窗正負 300 秒，拒絕 redirect。Do 的 `DS_PUBLICATION_STATUS_ENABLED` 預設關閉，與 ingest 開關獨立；沒有新機器發布權限。
- DS 在交易內重查 owner/client/calendar/entry/target/binding/attempt context，只追加 `site_publication_observed` event，不修改 entry、原始 attempt、run 或 machine authorization。每 entry 最多 500 筆、501 sentinel 防止截斷歷史假裝完整；context 不符或 checksum 損毀時不顯示可信發布。最新狀態依 observation timestamp，而非遠端版本大小排序，網站回滾也不會被舊高版本掩蓋。
- 命令鍵作用域為 owner＋entry 的一次核驗要求；同鍵更換 target 或 context 回 409，介面依 entry＋target 保存不同 UUID。合成雙 binding 測試核對兩個目標各自的公開／未公開投影，不回傳錯站資料。這是記憶體 repository 驗收，不是多目標 SQL runtime 驗收。
- 查詢結果一律 `workflowChanged:false`、`learningAuthorized:false`；即使公開內容一致，也不直接產生 delivered event、learning snapshot、measurement handoff 或模型訓練。既有老師發布操作及版本 CAS 不變；這份觀察不證明某位老師在某時刻親自點擊發布。文章已修改亦不能沿用舊客戶同意。

#### 本機驗收與來源

- DS 凍結 1,629 個來源檔，SHA-256 `2881894e8230ddde6d85ccfdf694814d6f580370edc2842824d53701034bb013`。Node 22.23.1 依序通過 typecheck（23.917 秒）、fresh node-server build（22.461 秒）、完整安全 Vitest（282.68 秒，包裝程序 283.222 秒），全部 exit 0。397 個檔案中 376 個有通過測試、21 個全部跳過；6,557 項通過、0 失敗、83 跳過，總計 6,640 項。JSON SHA-256 `4aabcf3d44a9e7e4646f340c9dc312af56db44cd0e5b5913504123d83b2a910b`，逐筆 assertion 狀態獨立核對。新 client／核心／route／狀態元件四個檔案的 65 項已包含於完整套件，不重複加計。
- Do Alignment 凍結 452 個來源檔，SHA-256 `57f3c3ea2343d5e62d091f8c8ca5ffffff1b2277ecd01d05763993b188324feb`。typecheck 7.777 秒；完整無憑證 Vitest 3.65 秒（包裝程序 3.933 秒），全部 exit 0。116 個檔案中 99 個有通過測試、17 個全部跳過；825 項通過、0 失敗、126 跳過，總計 951 項。JSON SHA-256 `4ad22d7c739205bae8f9ab2d6e3781f1b0be0e089488058f21e4dbdb56bda29e`。PostgreSQL opt-in 關閉，126 項 skip 不算真 DB 驗收。
- 實際 DS checker、實際 Do status handler／reader 與既有 `changeBlogPost`，以有界 fake SQL 完成另行 1／1 配對測試：私人 → 發布 → 編輯私人草稿 → 重新發布修改內容 → 取消發布 → 封存 → 還原為私人。沒有 socket、實際 SQL 或客戶文章。配對 JSON SHA-256 `02b1abbc3eeaa456951677c133267ce299e7569402d4e850290c4cabf0052033`。
- 同版 fresh Nitro 的四種匿名 POST 實測均先回 401，保留 private no-store／noindex／無 public CORS，涵蓋一般、跨站 Origin、壞 JSON 與超大未知欄位。沒有 owner session 或正式 DB，不代表已登入完整工作台業務驗收。
- 實際兩個 Vue SFC 與 scoped CSS 使用六種記憶體合成狀態，完成桌面 1280×900、手機 390×844 驗收；document width 分別為 1280／390，狀態區水平溢出為 0，console warning／error 為 0。文字為繁體中文，CSP 禁止 API 連線。截圖標示本機合成預覽，不是正式後台或老師操作驗收。自建靜態預覽與 Nitro server 已停止、驗收分頁已關閉、viewport 已恢復。
- Prisma schema 用私有複本、dummy localhost URL 再次 validate 通過，沒有 DB 連線；既有 driverAdapters deprecation warning 保留。Do 新 migration 只加 nullable `receivedDocumentHash` 及 hash check，沒有 DML／回填；未套用任何 PostgreSQL。Next／OpenNext build、正式 Cloudflare route、SQL／RLS、備份還原與 rollout 均 NOT_RUN；沒有移動真實環境檔或繞過 build 安全守門。
- 前兩次 DS typecheck、Do 初次 typecheck 及 archived fixture 失敗均保留：修正明確回傳型別、合法合成資料與測試型別縮窄，未放寬驗證器。Do 完整套件初次 819 通過／6 失敗／126 跳過，原因是本機 Workers listener 的 `listen EPERM: operation not permitted 127.0.0.1`；只核准 localhost listener 後同版重跑，825 項通過，沒有刪除或 skip 失敗測試。
- 執行前後 manifests 一致、舊變更與本段範圍外來源未變。安全驗收不繼承憑證，使用空 env 檔／directory、DS 19 個操作旗標關閉與 9 個外部整合旗標為 0。最終 reports、manifests、logs、private 配對 fixture 與畫面另保存於 `/Users/emilyyy/.codex/visualizations/2026/10/05/01a10d75-6003-77a0-975b-7701e90aa374/ds-site-publication-20261008-YlzCcTuH`，不放 Git；較早失敗保留於 `/private/tmp/ds-site-publication-status-20261008-FUUgNYa5`。本指南與 Do 交接文件排除於來源凍結，僅追加驗收紀錄。

下一段仍須把發布觀察安全接入正式 publication／measurement resolver，處理文章撤下、公開版變更、客戶同意／訓練授權撤銷及有效的成效觀測，再接模型資料准入。現有工作流程仍是 `awaiting_site_review`，沒有自動宣告 delivered。本段沒有正式 DB／provider／LINE／郵件／客戶發文、會員／預約變更、Colab／正式訓練、依賴安裝、付費資源、commit、push 或部署；線上後台尚未包含這批新功能。

### 2026-10-08 網站發布版本的成效觀察接入

狀態：IMPLEMENTED／LOCAL_VERIFIED／NOT_DEPLOYED；瀏覽器畫面驗收 NOT_RUN。本段接通「網站簽章核驗 → 擁有人明確確認 → 既有成效量測排程 → 彙總成效保存」的本機路徑。這是獨立的網站版本觀察，不將原始私人收稿回執升級為正式發布收據，不證明老師點擊發布的操作者身分，也不授予模型訓練權限。新增介面均為繁體中文。

#### 這次完成的操作與安全界線

- 工作台新增「確認接入成效觀察」，先顯示範圍，再按「我確認接入成效觀察」才送出要求。載入、取消或核對網站本身都不會自動確認、收數或訓練。已確認狀態明確標為歷史確認；既有工作流程與下一步提示不變。
- 伺服器先驗證擁有人，再讀取有界本文；只接受目標、伺服器版本指紋、明確確認及命令鍵四個欄位。確認時重新核驗網站簽章與目前客戶／原始內容／人工審稿／風險／目標／必要客戶同意，交易內再次核對。新增獨立事件，保持 entry、publication attempt、原始 ingest run 與機器授權不變；同鍵重試回歷史收據，不能把重播當成最新網站授權。
- 目前只支援原始單目標、人工審稿的 `draft_received` 路徑。routing／machine 路徑因尚未接妥精確歷史授權而被阻擋，不假裝多目標或自動駕駛已可使用。原始網址／內容身分、最新負面觀察、過期或損壞歷史、錯站與跨擁有人範圍均不得被舊正面紀錄掩蓋。
- 經獨立確認及有效資料連線後，既有量測服務可建立發布後第 7、15、30、60、90 天的檢查點。乾跑與建立排程不呼叫網站、Google 或取得憑證；只有後續已授權的收數工作才執行。服務在呼叫資料提供者之前、回應之後與保存評估前重新核驗網站及資料連線，不因保存連線中繼資訊而恢復已暫停／撤銷連線。
- 未發布的私人編輯不改變已公開版本身分；公開內容重新發布、撤下／封存、目標設定改變、審稿／客戶同意撤銷或簽章無法核驗時，停止該版本的後續收數。不把 404 或逾時直接視為文章已刪除。先前合法取得的快照保留為歷史證據，不宣告資料提供者之間具有跨服務原子交易。
- 成效只保存有來源與版本綁定的彙總指標，獨立標示 `site_publication_confirmation`／`learningCandidate:false`，不產生訓練候選；通用內容學習資料集也明確排除此類觀察。這次確認不替代客戶的模型使用同意或資料集審查；成效差異不是已證明的因果提升。
- 本段重用既有事件與成效表，沒有新增資料庫 migration。真正啟用仍需 DS／Do 正式接線、前一段 Do nullable 文件指紋 migration／接收端部署、有效的量測來源憑證、已授權 worker，以及正式 DB／網站／provider 驗收。

#### 同版本機驗收

- DS 凍結 1,639 個來源檔，SHA-256 `a4c92d36c56b31e50dafdc64a5dd648868cf2211fe48cc45598460e730004374`。Node 22.23.1 依序 typecheck 22.107 秒、fresh node-server build 24.359 秒、完整 Vitest 285.03 秒（包裝程序 285.687 秒），全部 exit 0。402 個檔案中 381 個有通過測試、21 個全部跳過；6,656 項通過、0 失敗、83 跳過，總計 6,739 項。JSON SHA-256 `21595f6deb9256bc8faa746fdd5f283e6fc9ccc0704877d52fe7379b29e777a5`。逐筆 assertion 狀態、來源與 logs 的 checksum 另行核對通過。
- 同版聚焦驗收 10 檔／174 項通過；包含確認核心、必要客戶同意、owner route、量測服務、實際 Vue 元件與既有發布／量測回歸。聚焦項目已包含於完整套件，不重複加計。新增合成串接測試驗證實際確認核心 → 五個排程 → 實際 GSC adapter 的合成回應 → 兩筆彙總快照及一筆非訓練成效；網站撤下會在取得 Google 憑證前被擋住。
- 另行 1／1 跨專案配對通過：使用實際 DS 確認核心、Do 狀態 reader／HMAC handler 及既有 `changeBlogPost`，以合成 SQL 驗證私人 → 公開原稿 → 明確確認 → 私人編輯 → 修改內容重新發布 → 撤下 → 封存 → 還原私人。沒有真正資料庫或客戶文章。JSON SHA-256 `cb85ddef3ee82f9352de3a4557319095e0c08970d769edf421279fba766e4c75`。第一次失敗紀錄保留；原因是合成 fixture 把順序操作設於相同觀察時間，修正測試時鐘後通過，未放寬來源驗證器。
- Do 452 檔來源維持前段 SHA-256 `57f3c3ea2343d5e62d091f8c8ca5ffffff1b2277ecd01d05763993b188324feb`，本段未修改 Do。本段僅重跑上述配對及來源一致性核對，沒有將前段 Do 完整測試誤計為本段重跑。
- 同版 fresh Nitro 的四種匿名確認 POST 皆回 401，涵蓋一般、跨站 Origin、壞 JSON、超大未知欄位，保留 private no-store／noindex／無 public CORS。這不是已登入擁有人或正式資料庫業務驗收；本機 Nitro 服務已停止。
- 實際新 Vue 元件的 16 項 mounted runtime 測試通過，確認／取消與繁體文案有本機測試；實際 SFC／scoped CSS 的隔離合成預覽已成功編譯，CSP 禁止 API 連線。但 Mac 鎖定且瀏覽器不可用，桌機／手機畫面、水平溢位、console 與完整工作台互動尚未驗收，沒有本段截圖。預覽伺服器已停止，未留下分頁或 viewport 變更。
- 來源凍結前後與範圍外舊變更均一致，`git diff --check` 通過。安全程序使用空 env、不繼承憑證，19 個外部操作旗標關閉與 9 個整合旗標為 0。瀏覽器／production DB／provider／LINE／郵件／客戶發文／預約會員／Colab／正式訓練／付費資源／依賴安裝／commit／push／部署均沒有執行。建置保留既有非阻斷的相容性資料庫過期提醒，沒有更新依賴。
- 完整 reports、來源 manifest、logs、匿名 HTTP／配對證據、失敗 fixture 紀錄及預覽 QA 紀錄保存於 `/Users/emilyyy/.codex/visualizations/2026/10/05/01a10d75-6003-77a0-975b-7701e90aa374/ds-site-measurement-20261008-Py8CKS5X`，不放 Git。本指南排除於來源凍結，僅追加驗收紀錄。

下一段：在獨立客戶同意與資料權利審查後，處理這類成效觀察的模型資料准入／撤銷與有效評估；同時補足 machine／routing 的精確歷史授權及正式接線驗收。現有確認不是訓練開關，完整機器學習閉環與線上可用性仍未宣告完成。

### 2026-10-08 網站成效資料的學習准入、審查與撤銷

狀態：IMPLEMENTED／LOCAL_VERIFIED／GATED／NOT_DEPLOYED。使用者已要求進行下一階段並正式部署；本段完成程式及本機驗證，但正式資料庫目標尚未通過本輪指紋核對。沒有將本機成功改寫為上線成功。

#### 本段完成

- 「學習閉環」新增獨立的「網站成效資料准入」區塊，依序處理來源授權與精確網站版本、逐筆成效審查、候選摘要。兩個接入確認、個資審查、限制理解與撤銷確認均不預先勾選；載入頁面不收數、不訓練、不發文。全部新增操作說明維持繁體中文。
- 接入綁定既有客戶模型用途授權、來源權利與保存期限，並明示擁有人只是申明證明存在，不能代客戶同意。網站公開、LINE 同意發文與學習用途同意不互相替代。
- Collector 僅採用伺服器核發、取得資料前後完全相同的十一欄 `site-learning-collection-proof-v1`。供應商自行附帶的標記先剝除；錯誤欄位、accessor、Proxy trap、跨 owner／entry／client／target、過期、保存期限外或版本不一致皆拒絕准入。缺少測試 resolver 不會回退讀正式資料庫。
- 基準與追蹤快照都必須在收數當時具備同一份合法證據；舊快照不回填、不因新授權升級。成效仍屬網站版本觀察，維持 `runId:null`、`learningCandidate:false` 與非正式發布回執邊界，不併入引用模型或既有正式 delivered 成效 trainer。
- 審查和釋出再次核對公開版本、目前來源／接入授權、完整 publication identity、assessment row／內層內容指紋及 owner review；等待期間的版本漂移、撤銷、排除與資料修改會阻擋。即使來源已失效或網站不可用，歷史接入仍保留撤銷入口，不宣稱該來源仍有效。
- Release 只回傳候選狀態、數量、指紋與 manifest 摘要，不回傳原始特徵或可直接訓練資料；固定 `modelTrainingAllowed:false`、`citationTrainingEligible:false`。最終多次讀取不是跨網站／資料庫的序列化快照，因此這份摘要不是可永久沿用的訓練或匯出權杖。真正接入後續資料匯出／訓練 consumer 時，必須在消費時重新核對目前權威及撤銷，另行驗收併發邊界。雜湊與 PII scanner 也不是客戶簽章、法律效力或匿名保證。
- 五個 owner API 先驗證身分，才解析本文及建立資料庫依賴；寫入核對同來源、精確欄位及大小限制，回應採 private／no-store／noindex，不開放 public CORS。新流程只使用既有授權與事件表，本段沒有新增 migration。

#### 最終同版本機驗收

- `main`／HEAD 保持 `2d796067b15da47acc289be568db5125043b0a93`，沒有 commit、push 或 reset；先前累積的未部署變更保留。本段命名範圍外的來源與前段 manifest 比對未變。本指南排除於凍結來源，僅追加證據與交接紀錄。
- 最終 1,653 個來源項目，SHA-256 `96586d9c7b0b068affb58a0bb400a17fdd2ec1071c84169aff79a259342589ab`。既有 Node 22.23.1 依序通過 typecheck（22.316 秒）、fresh node-server build（24.265 秒）、完整安全 Vitest（289.55 秒，包裝程序 290.221 秒），全部 exit 0。406 個檔案中 385 個有通過測試、21 個全部跳過；6,720 項通過、0 失敗、83 跳過，總計 6,803 項。完整 JSON SHA-256 `ecf8823be909f9a6a477771d791ba68dd32a7c0a38c0740bd23bbd257a1b6a2f`；逐筆 assertion、log／report 雜湊與執行前後 frozen source 已獨立核對。
- 驗證不繼承憑證，Nuxt 使用空 env 檔、Vitest 使用私有空 env directory，19 個外部操作旗標關閉、9 個外部整合旗標為 0；僅核准本機 loopback listener。83 項 skip 不算正式資料庫、支付、LINE、網站或供應商成功。
- 最終同版另行聚焦六個檔案共 83 項通過（3.60 秒，包裝程序 3.978 秒），涵蓋准入核心、owner routes、收數證據、既有網站版本確認、實際 mounted 元件與整頁 SSR；這些項目已包含於完整套件，不重複加計。
- 同版 fresh Nitro 的五個 API 共 20 項匿名請求通過，涵蓋一般、缺少／錯誤來源、壞 JSON 及過大本文，全部先回 401 並保留私有安全標頭。服務已自動停止；未建立正式資料庫或 provider 依賴。
- 實際 `OwnerSiteLearningAdmission.vue`／scoped CSS 的合成預覽完成 1280 px 桌機與 390×844 手機驗收，頁面寬度等於 viewport、無水平溢出，兩個同意 checkbox 均為 false。保留失效來源的歷史撤銷入口及無 grant 的 legacy 阻擋顯示；沒有操作真實同意、收數或發布。元件 SHA-256 `5a7586daf76869aea66f8da389bc2af21370f0ceed4258018f7c899793d2e50e` 與最終來源一致。這是隔離元件畫面，不是已登入正式工作台驗收。三個自建預覽程序與合成分頁已關閉，viewport 已恢復。
- 較早 typecheck 型別錯誤與一次 build／focus 同時執行造成 `.nuxt/tsconfig.json` 缺失的紀錄保留。前一輪完整回歸為 6,701 通過、10 失敗、92 跳過，另有 4 個 listener 未捕捉例外；涉及 `listen EPERM: operation not permitted 127.0.0.1`、SSR 未就緒與既有 page harness 無法載入新 SFC。後者改為編譯渲染真實新元件，保留原斷言及 no-mutation／unchecked 檢查；核准 loopback 並重新凍結後完整重跑為上述零失敗，沒有刪除或 skip 失敗案例。建置仍有既有瀏覽器相容性資料過期提醒，沒有更新依賴。

#### 資料庫與正式部署狀態

- 先前累積的 0051–0055 必須先處理，不能只部署本段。隔離本機 MySQL 9.5／私有 Unix socket、TCP 與 MySQL X Plugin 關閉的演練已完成 56 筆官方 migrator 遷移，原 51 筆前綴一致，最終 203 張應用表加 migration ledger；0052 → 0053 的新 binding 表空表前提、0054 nullable JSON、0055 三個舊值與追加 enum 狀態均以合成資料核對通過。伺服器已停止。此演練不是正式 TiDB 相容性或真 repository 併發驗收。
- 正式更新計畫與受 gate 保護的 preflight／backup／本機 restore 工具已準備於私有附件。未提供核准 gate 的負面測試回 `GATE_REQUIRED`，且不讀 `.env`。本輪尚未執行正式 preflight、備份、還原、DDL 或 migration ledger 寫入。
- Render 唯讀核對為 `discoverystack-api`／Docker／Free，連結 `tendertech2018/DiscoveryStack_nuxt` 的 main；Live 仍為 `2d796067b15da47acc289be568db5125043b0a93`、部署 `dep-db381a7f3r2c738ev6dg`。沒有按部署、改環境設定或升級方案。
- 安全審核拒絕點擊「Show secret」核對正式 DATABASE_URL；未揭露憑證。已請使用者另行確認「只在私有程序比對 Render 與本機 DATABASE_URL 的 SHA-256 指紋、立即隱藏、不輸出／保存／傳送連線字串」，尚待回覆。因此不得繞過此限制套正式 DB 或將整批待遷移程式推上自動部署的 main。
- 後續順序：取得上述窄範圍核對授權 → 核對正式目標與 schema／ledger → 0 元私有一致性備份與隔離還原驗收 → 受控套用 0051–0055 並核對舊資料 → 提交精確來源、推送與 Render 部署 → Live SHA、匿名端點及擁有人唯讀正式驗收。任何額外付費、Do Alignment 正式寫入或自動收數／訓練／客戶發文仍需各自明確核准。

完整最終證據、manifest、logs、JSON、截圖、失敗歷史、本機 SQL 演練摘要與離線正式更新工具保存於 `/Users/emilyyy/.codex/visualizations/2026/10/05/01a10d75-6003-77a0-975b-7701e90aa374/ds-site-learning-20261008-nDsMs3zR`，不放 Git。本段沒有正式資料庫連線、Colab／真資料訓練、LINE、寄信、客戶發文、會員／預約變更、Do Alignment 修改／部署、付費資源或依賴安裝。

### 2026-10-08 正式資料庫更新與部署交接

此追加紀錄承接使用者「授權僅核對 DATABASE_URL 指紋」及先前的 0 元備份、資料庫更新與部署授權。上節 NOT_DEPLOYED 是核對前的歷史狀態；本節記錄提交／部署前已完成的正式資料庫驗收，不將推送預先視為 Live。

- 2026-10-08 18:27（Asia/Taipei）在私有程序比對 Render 與本機 DATABASE_URL 的 SHA-256，結果一致，立即重新隱藏。未輸出、保存或傳送連線字串，沒有讀取其他 Render 秘密、變更環境設定或升級 Free 方案。
- 正式 TiDB 唯讀 preflight 已通過：199 張應用表、51 筆 canonical ledger。最初的結構檢查失敗紀錄保留；確認 BOOL／BOOLEAN 的 TINYINT(1) 表示、TiDB 產生的精確 FK 支援索引、七個早期 SQL 使用的短 FK 名稱，以及 0029 建立／0032 移除外鍵後保留的單一 reviewerUserId 索引。不接受任意新索引或 FK 漂移。依據 [TiDB 數值型別文件](https://docs.pingcap.com/tidb/v7.5/data-type-numeric/) 與 [TiDB 外鍵文件](https://docs.pingcap.com/tidb/stable/foreign-key/) 核對引擎表示。
- 私有更新工具新增欄位 default、字元集／collation、canonical SQL 物理欄序、索引 full-length／BTREE、ledger schema 與目前部署 default policy 的精確核對。重播 0000–0050 對照全部 3,078 欄一致；snapshots 50–55 的正面／反例共 41 項通過、0 失敗，未連資料庫。SQL 字面值中的引號不當作等價 delimiter，語意校驗使用一致的 ASCII 表名排序，備份 ledger 依 canonical 時間排序。
- 18:50 完成正式一致性唯讀備份，包含 200 張實體表、265 筆資料（含 migration ledger）、2,574,739 bytes。備份 SHA-256 `6cadeb9f6543216cbfd670be74700c485fa8ff575239d1c998f6fccef75ded26`；schema SHA-256 `5fc8b28b4a48c01caf512160e6849612248aa1d5e3534bc617e54af620c22632`。備份只存本機受限目錄，檔案 0600／目錄 0700，未放 Git、未上傳或包含於一般驗收附件。
- 18:51 在新建的本機 MySQL 9.5／私有 Unix socket 還原 200 表、265 筆資料；TCP 關閉、MySQL X Plugin 不啟用。每表 row count／semantic hash 一致，521 組外鍵關係檢查通過。還原報告 SHA-256 `7cf04de72c04c555ebcb53bbe90a313cbad92c9aaed84648c7ff7d15df24789a`。完成後正常停止本輪私有 MySQL；socket 已不存在，未刪除備份及還原 datadir。
- 0051–0055 正式更新已成功：21 個白名單 DDL、5 筆 canonical ledger 寫入，每段均核對 schema／ledger／原 199 張應用表的資料語意一致、新表空表，最終 203 張應用表加 ledger（204 張實體表）、56 筆遷移。0053 加非空 idempotency hash 前確認 bindings 空表。每步有意圖／回應 checkpoint；沒有自動 retry／resume、刪表、客戶 DML 或 provider 呼叫。
- 準備提交的來源仍為最終 1,653 項、SHA-256 `96586d9c7b0b068affb58a0bb400a17fdd2ec1071c84169aff79a259342589ab`；之前 typecheck、fresh build、6,720 通過／0 失敗／83 跳過與 20 項本機匿名 API 證據保持同版。精確 staging 清單為 203 個 nuxt-app 路徑（80 個已追蹤修改、123 個新增），不含 .env、建置產物、私有備份或範圍外變更。
- 此節寫入時，Render Live 仍為舊 `2d796067b15da47acc289be568db5125043b0a93`；接續推送至既有 tendertech2018 main 的 On Commit 部署流程。最終 commit、Live deployment、線上匿名 API／畫面與 CI 結果另存下述 `production-release/` 安全摘要，不以此提交前紀錄冒充部署驗收。已登入 owner 業務讀取若未完成，須明確保持 UNVERIFIED。

安全摘要保存於既有本機驗收附件的 `production-release/`；原始備份及還原資料只留在 `/private/tmp/ds-prod-migration-0051-0055-YSIUmqm9` 的受限區域。未啟用新收數／自動訓練／客戶發布、沒有寄信／LINE／Colab／真資料訓練、Do Alignment 正式修改／部署或付費資源。真正資料 consumer、供應商、模型品質與首次實際發布仍需各自取得授權和外部驗收。

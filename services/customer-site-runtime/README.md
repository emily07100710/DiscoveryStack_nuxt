# DS 客戶網站核心

這是客戶自己的網站，不是 DS 內部後台或公開 Astro 官網。Node 22.23.1 以上，零新增套件；每個網站各自一個 process、SQLite 檔、媒體資料夾與管理者密碼。品牌資料是 JSON，不允許 AI 加入任意程式、script 或依賴。

## 本機預览與生成

`node scripts/preview.mjs atelier`、`bloom` 或 `alignment` 可看三種品牌版型。預览僅使用新臨時資料庫與合成商品／文章／預約時段，不寄信、不扣款。預設不提供管理者登入；需要測後台時由操作者以環境設定提供專用測試密碼，不得把正式密碼放進指令歷史或截圖。

在 DS 擁有人後台「客戶交易網站」以既存 project/version 產生 manifest。將 JSON 存為 manifest.json，再執行 `node scripts/generate.mjs manifest.json <全新輸出資料夾>`。輸出包含前台、後台、資料型設定、Dockerfile 與啟動入口；不複製 DS 內部資料庫、工作階段、客戶資料或密碼，也不覆寫既有資料夾。生成不是部署或付款證據。

## 已具備的流程

- 電商：搜尋、分類、商品詳情／規格、購物車、伺服器重新計價、庫存保留、訂單查询、人工付款確認、出貨、取消／人工退款紀錄。整數分單位價格，訂單明細不可被後續商品調價改寫。
- 預約＋部落格：服務與時段、會員登入、點數帳本、原子預約、取消／改期、訪客預約申請及人工確認、草稿、發布、固定網址與版本還原。每個 resource 時段容量為一，不是多人課程或醫療排班。
- 後台：商品、訂單、服務、時段、會員點數、文章、圖片上傳、品牌外觀設定、聯絡收件匣。
- Email：每站持久化 outbox，未設定寄信不呼叫供應商；Resend 設定後可重試／冪等，不把寄送失敗誤認為付款失敗。

## 正式設定與驗收（尚未代操）

將 `.env.example` 設定透過平台安全注入；伺服器不自動讀取 .env。必須設定 HTTPS `SITE_ORIGIN`、獨立資料庫／uploads 的持久磁碟、至少 14 字管理密碼與至少 32 字隨機 session secret。Docker 容器的 `/data` 要先由平台建立並給 node 使用者寫入權；禁止使用 ephemeral disk。單個資料庫只能由一個網站身份及 mode 開啟；preview 資料庫不能改標為 production。

正式預設付款 `disabled`。經商家確認後可選 `manual` 並填寫付款指示；它不會扣款，也不保證款項已入帳。`sandbox` 不可用在 production。Stripe／綠界／藍新實際扣款與對帳 adapter、物流與電子發票尚未接入；不能把人工確認當成供應商成功證據。

Resend 必須先有經驗證的寄件網域、有效 API key 與 `RESEND_FROM`，再把 `SITE_NOTIFICATIONS_ENABLED` 設 true。客戶資料、寄件身份与 DS 自己的金流必須分開。現在 outbox 含訂單建立、會員 Email 驗證與忘記密碼通知。驗證／重設連結為 30 分鐘單次 token；內容在伺服器 outbox 以 session secret 衍生的 AES-GCM key 加密，寄送完成清除正文。輪換 secret 前需處理舊佇列，不能將正式 secret 換成臨時值。預約提醒尚未提供，不應宣稱已完成。

反向代理必須保留原始 Host，並使用配置的完整 canonical origin；本版本不信任任何 forwarded IP header。代理後的防濫用可在入口按真實 IP 做限制；應用內 remoteAddress 限流可能對同個 proxy 共用額度。勿直接公開 HTTP、管理預览或啟用真實付款。

正式部署之前還需驗證 HTTPS／網域、cookie、跨客戶隔離、備份與還原、寄信、實際付款／退款、人工營運流程、手機排版。当前 Cloudflare Pages 靜態發布不能部署本 Node 核心；DS manifest 回報 `runtime_deployment_adapter_required`，不偽造 live release。需提供隔離 Node 託管能力後再接自動部署 adapter。

操作者可用 `node scripts/backup.mjs <site.sqlite> <uploads> <全新備份資料夾>` 做一致的 SQLite snapshot 與媒體副本。它不覆寫來源或既存備份；備份含客戶個資，必須限制權限並保留原加密 secret。還原必須在網站停機時，先保留回復點，再把副本配置到新獨立路徑並確認 siteId／mode；禁止直接覆寫正在交易的資料庫。

舊網站資料不由 crawler 或公開頁面擅自搬遷。先由商家匯出商品／文章，確認授權與欄位；密碼、金流 token、Cookie 不搬移。會員與歷史訂單需額外經核准的遷移方案、乾跑、對帳及回復點；本版本不聲稱全平台一鍵搬家。

## 免費美術調整

正式交付後 30 天，原功能內的排版、色彩、字體与圖片配置調整免費。DS 客戶工作區可提交、查詢進度；僅從有付款／部署／工作區權威證據的交付通知計時，重新部署不延長期限。新增功能、資料搬遷、新串接及第三方費用另行確認。

## 安全測試

`node --test tests/*.test.mjs`，僅本機／記憶體 SQLite、合成資料與 mocked Email。沒有真實供應商呼叫。測試不是 production 驗收。

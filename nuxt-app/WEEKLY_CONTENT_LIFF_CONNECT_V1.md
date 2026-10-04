# 搜尋王 LIFF 客戶連結 V1

LIFF 固定入口為 `/weekly-content/connect`。官方帳號卡片、圖文選單與 owner 邀約畫面只連固定入口；邀約碼另由服務人員私下提供。登入後客戶貼碼、看公司名稱及網站、勾選確認，再綁定。邀約碼與 ID token 不放網址、應用程式 localStorage、事件、資料表或回覆。LINE SDK 自己的 OAuth 初始參數由 init 消耗後立即從目前頁面 history 移除；應用程式不自行解析其中身分。

## 正式啟用前的獨立平台門檻

- LINE Login channel、其 LIFF app 與「搜尋王」Messaging API channel 必須由同一 LINE Provider 建立，並核對連結到同一官方帳號。不同 Provider 的使用者 ID 不可當同一身分；單純登入成功不能證明 Messaging 可收稿。這是人工平台驗收門檻，尚未實測。
- LIFF Endpoint URL 與 login redirect 必須為已配置 HTTPS origin 加 `/weekly-content/connect`；scope 只選 `openid`，不選 email、profile 或 chat_message.write。
- `NUXT_WEEKLY_CONTENT_APPROVAL_ENABLED` 與新增 `NUXT_WEEKLY_CONTENT_LIFF_ENABLED` 都須精確 `true`。缺少任一旗標、合法 `NUXT_WEEKLY_CONTENT_LIFF_ID`、`NUXT_WEEKLY_CONTENT_LINE_LOGIN_CHANNEL_ID`、review origin 或 token key，配置回 disabled，context/confirm 在 provider/資料庫之前停止。
- `NUXT_WEEKLY_CONTENT_REVIEW_ORIGIN` 必須是純 HTTPS origin；ID token verifier audience 只取 server 的 Login channel ID。不能使用 Messaging channel ID 替代。
- 官方帳號加好友與解除封鎖需另外完成；綁定不代表推播額度、帳號好友状态或每週文章發布已實測。

## 伺服器權威與隱私

`POST context` 僅接受 idToken 與可選 invitationToken。伺服器向固定官方 LINE verify endpoint 以表單 POST，拒絕 redirect，設 deadline 並逐段限制回覆至 12KiB。再核對 issuer、audience、U 型 subject、exp/iat 與 LIFF 一小時有效期；不解碼信任 browser profile，不保存 raw token 或回覆。

帶邀約時只顯示 exact 客戶的名稱、HTTPS 網站、邀約 expiry 與 opaque 公司確認碼。不帶邀約只列該 verified LINE 使用者自己目前 active 的綁定；最多二十筆，沒有公司選單或客戶目錄。

`POST confirm` 另須 consent:true 與 context 產生的 HMAC confirmationToken。公司名稱、origin、配置、邀約、有效期或登入人改變，就必須重新核對。交易鎖全部取得後再查 fresh clock 與 ID token expiry，接入既有一次性邀約 claim／durable inbox。LIFF event 由 server 派生，使用獨立 namespace；重送不重綁，也不偽造 LINE webhook event。

JSON API 僅接受已配置同 origin、raw body 最多 12KiB；回覆 no-store/noindex/no-referrer，錯誤只給固定繁體中文。沒有瀏覽器 owner/client/LINE ID authority。LIFF 綁定不寫文章同意；逐篇按同意仍走既有簽章 sender、原稿 hash、風險與 publication reservation guards。

## 證據範圍

本機測試使用 synthetic ID token、官方回覆 mock、交易 fixture 與真 in-process HTTP handlers。真 LINE verify、官方帳號/LIFF 平台設定、真客戶綁定、推播、AI、DDL、發布均 NOT_RUN。

官方依據：[LINE ID token verification](https://developers.line.biz/en/reference/line-login/#verify-id-token)、[LIFF server-side user data](https://developers.line.biz/en/docs/liff/using-user-profile/)、[SDK init／URL 處理](https://developers.line.biz/en/docs/liff/developing-liff-apps/)。

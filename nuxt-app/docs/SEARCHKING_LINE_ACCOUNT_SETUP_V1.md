# 搜尋王 LINE 官方帳號與客戶綁定 V1

## 實際範圍與證據

OA 搜尋王（@453ojflc）已建立。品牌圖片、歡迎文字、Flex 卡片、底部選單 payload 與 LIFF 客戶頁是本機交付。尚未套用 LINE 帳號頭像／歡迎訊息／選單，也未建立或公開 LINE Login／LIFF channel。完整候選最後 typecheck/build/full safe 以 root 最後交付收據為準，focused mock 不代表 LINE 收發或真實客戶綁定。

原先帳號建立與資訊使用同意已完成；後台另外要求 2025-02-19 官方帳號更新條款。此更新條款尚待使用者明確核准，聯絡信箱尚未更正。正確信箱依使用者更正；不得將舊表單截图當更正成功證據。

## 客戶操作

1. 加入搜尋王好友，開啟「綁定我的公司」。
2. LIFF 載入完成後以 LINE 登入，貼上搜尋王服務窗口私下提供的一次性邀請碼。邀請有效十分鐘，原始碼不進資料庫、Git、分享文件或 URL。
3. 伺服器核對 LINE ID token、官方 audience/issuer/TTL，依邀請查出單一公司與網站。客戶目錄不公開，前端不能傳 owner/client/LINE user ID 或自行指定公司。
4. 客戶核對公司與網站，明確按同意。confirmationToken 固定邀約、已驗證收稿人、公司與目前配置；確認資料改動即拒絕，要求重新核對。
5. 綁定後「我的公司」僅顯示此已驗證 LINE 使用者目前仍有效的公司。服務窗口更換收稿人需另走明確管理流程；此版本不提供自助接管。
6. 文章完成後送來独立 Flex 卡片，先閱讀全文，再點同意或要求修改。公司綁定不是文章發佈同意。每一份文章同意固定原稿、版本、來源、政策與目標；客戶要求修改時保留待修，不把原同意帶到修改版。

## 本機品牌檔

- public/brand/searchking-avatar-v1.png：1254×1254，不透明，圓形安全邊界；使用內建 imagegen 生成。
- public/brand/searchking-rich-menu-v1.png：2500×843，三欄選單；由同品牌 SVG 排版輸出。
- assets/brand/searchking-rich-menu-v1.svg：可編輯原始選單排版。
- server/weekly-content/line-onboarding.ts：正式歡迎文字、Flex payload、三個固定 rich-menu message actions。只產 payload，不執行平台建立或指派。

頭像生成提示（內建 imagegen；沒有使用專案 API 金鑰）：

> Use case: logo-brand. Create one polished square LINE Official Account profile avatar for the Taiwanese AI content and search optimization service named 搜尋王 / Discovery Stack. Icon-only, no written words, no letters, no slogan, no watermark. A friendly, confident small golden crown integrated into a clean magnifying glass symbol, suggesting thoughtful discovery and search. Premium modern minimal flat brand illustration, crisp geometric silhouette, very legible as a tiny circular LINE avatar. Deep ink navy background, warm golden yellow symbol, a subtle cream highlight. Centered composition with generous safe margins so no part is clipped in a circular crop. Full opaque background. No photo, no chatbot face, no busy details, no search-engine trademark.

## 準備給 LINE 的配置

Messaging API 和 LINE Login 必須放在同一個 LINE Provider 並把搜尋王 OA 連到該 Login channel。否則同一個人的跨 channel user ID 無法作為可驗證的相同收稿人。實際 Provider/channel/OA 連結需要從平台核對，不能以本機格式驗證當證據。

- Webhook：https://discoverystack-api.onrender.com/api/weekly-content/webhooks/line
- LIFF endpoint：https://discoverystack-api.onrender.com/weekly-content/connect
- LIFF size：Full；scope：openid；不請求 email/profile/chat_message.write。
- LINE Login 加好友選項 normal 可另於開通時核對。LIFF ID 尚未建立，不可把測試 placeholder 保存到平台。
- Webhook 用 exact raw bytes 驗 HMAC 與 destination，只處理一對一的有效事件。歡迎及固定指令進 durable inbox，重送不再次回覆。回覆通知失敗不撤回已提交的綁定／客戶決定；回覆接受不當作已送達。
- 使用 webhook 歡迎卡片時，OA Manager 的預設歡迎訊息應關閉以免重複。僅在真正完成對接驗收後才切換；未完成之前不得關閉唯一可用的基本歡迎訊息。
- 底部選單：綁定公司／我的公司／使用說明；固定 message action，不含客戶識別或邀請碼。

## 伺服器設定名稱（值由安全輸入流程處理）

既有 NUXT_WEEKLY_CONTENT_APPROVAL_ENABLED、NUXT_WEEKLY_CONTENT_TOKEN_KEY、NUXT_WEEKLY_CONTENT_LINE_CHANNEL_SECRET、NUXT_WEEKLY_CONTENT_LINE_ACCESS_TOKEN、NUXT_WEEKLY_CONTENT_LINE_BOT_USER_ID、NUXT_WEEKLY_CONTENT_REVIEW_ORIGIN。

新增 NUXT_WEEKLY_CONTENT_LIFF_ENABLED、NUXT_WEEKLY_CONTENT_LIFF_ID、NUXT_WEEKLY_CONTENT_LINE_LOGIN_CHANNEL_ID、NUXT_WEEKLY_CONTENT_LINE_ONBOARDING_ENABLED。布林值只有 exact true 才啟用；缺失配置預設關閉，先拒絕再載入資料庫或呼叫 LINE。安全值不得存到 public runtime config、Git、文件、聊天或 log。

## 目前正式啟用門檻

- 更新條款核准及信箱修正。
- 整份新候選的 commit/push/deploy、資料庫新增 migration，皆須另行逐項核准。
- LINE Messaging API/Login/LIFF 權限與資料傳送需要確切開通核准；新 credentials 的輸入／儲存由本人完成必要手續。
- Do Alignment 對應的 client、target、V4 每週規則、資料來源／選題、老師 grant，以及 LINE 收稿人邀請，必須由 owner 核准並建立真實範圍。
- Do signed ingest 預設關閉。DS target、receiver env 與持久 grant 的 origin/contentRoot/keyReference/clientReference 必須一致；Do 預定 contentRoot 是 journal，不能讓 DS 預設 content 混入。
- Render 若仍為 Free，閒置會休眠，機內排程不能當作準時每週送稿證據；改為持續運作主機或另行核准可靠觸發方式後才正式啟用。
- 真實測試：加入好友→確認公司→同一份稿收到卡片→客戶同意→Do 只發一篇→同事件／同 business key 重送不重复→修改/到期/錯誤收稿人均不發文。尚未執行，不用 mock 冒充。
- 新真實 AI 寫稿費用需核准確切預算；此輪沒有新增百煉寫稿呼叫。

## 主要官方依據

- https://developers.line.biz/en/docs/liff/using-user-profile/
- https://developers.line.biz/en/reference/line-login/#verify-id-token
- https://developers.line.biz/en/docs/messaging-api/verify-webhook-signature/
- https://developers.line.biz/en/reference/messaging-api/#send-reply-message
- https://render.com/docs/free

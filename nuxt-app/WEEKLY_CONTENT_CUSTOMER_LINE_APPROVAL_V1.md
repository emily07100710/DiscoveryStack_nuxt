# 每週 GEO/SEO 文章與 LINE 客戶同意 V1

本功能使用既有 Content Operations 的客戶、經營策略、核准來源、選題與正式發布器。它不要求建立付費 Managed Site 專案，也不使用客戶按鈕假造 owner 的 SEO 審核。

## 真正的順序

1. Owner 先核對或建立自己名下的 active 客戶及公司網站，即可發出身分綁定邀請；此步不要求已有每週文章配置、發布目標或 V4 政策。
2. Owner 私下交付十分鐘有效的一次性綁定碼。LIFF 已啟用時，客戶開啟固定 `/weekly-content/connect` 入口，以 LINE 登入後貼上 `wli_...`，核對公司與網站並明確同意，伺服器才綁定；在 LINE 聊天貼碼只引導到確認頁，不直接綁定。僅保留的 LIFF 關閉模式可由通過 LINE 簽章、官方帳號 destination 核對的 active 一對一 sender 私訊完整碼直接綁定。兩種模式都拒絕群組、過期或另一人已使用的碼，成功綁定後其他人無法改綁。此步的 `purpose` 為 `identity_binding`，只確認公司與 LINE 身分；不新增文章配置、費用預算、逐篇同意或發布佇列，也不啟用文章服務。未啟用或已暫停文章服務的 active 客戶，仍可完成身分綁定。
3. 後續由 owner 另行核准發布目標、V4 機器政策、來源及選題計畫，再啟用每週文章送審。每週頻率、語言、模型、修訂上限及費用預算仍由既有政策決定；介面的預設預算值及身分綁定均不代表已核准支出。客戶仍須同意每篇原稿，才能進入正式發布。
4. 每週排程使用 owner 已核准計畫中尚未使用的選題，完成 AI 草稿、品質與風險檢查，僅排入發布佇列（`queueOnly`）。一位客戶同時只能有一份待完成的審稿；來源過期、選題用完、預算用完或配置暫停時停止。
5. Durable outbox 傳送私密預覽網址及 LINE「同意發布／需要修改」按鈕。預覽 read token 只允許閱讀，不具同意權；action token 只出現在 LINE postback。
6. 按鈕 HTTP 回覆只寫入同意／修改紀錄與發布佇列。它不呼叫 AI、LINE push 或發布器。簽章 sender 必須等於原綁定人；同意精確綁定 job、draft ID/version、文章 hash、類型、語言、來源、目標、政策、配置與 recipient binding。
7. 發文前以目前的政策、來源、風險、品質及原稿重新核對。純本機重驗可 CAS 續租同一機器授權記錄的十五分鐘短租約；不產生新授權 ID、不改文章、不重新 AI 修訂，不恢復 revoked/executing 的授權。正常發布仍必須持有未過期的完整 V4 授權。
8. 所有正式發布路徑共用 job-lock reservation 交易，並在新增 planned attempt 前重驗最新客戶同意。預先唯讀檢查也會在 lease／publication budget 扣除前攔下未同意文章。客戶同意不會略過原先 owner 政策、來源、風險、品質或正式回執檢查。
9. 發文後保留成功 run、append-only delivered attempt、回執與 public URL。歷史 V4 `published` 權威可供既有 GEO/SEO 回收識別；它不因執行短租約過期而消失，也不能再次當作新發布的權限。

## 失效與明確重開

文章版本、內容、語言、目標、政策、綁定、來源或風險改變時，舊同意無效。需要修改的原稿不得直接重新核准；需新修訂及新審稿。在正式 reservation 尚未開始前，客戶可以從同意改為需要修改，最新 append-only decision 立即阻擋發布。

普通 `createReviewRequest` 不會偷偷續期：原稿審稿過期回 `WEEKLY_REVIEW_EXPIRED`。Owner 可明確呼叫 `reopenReviewRequest({ownerUserId,clientId,entryId,idempotencyKey},deps)`，只允許同一原稿的過期審稿，或 pending 但通知已 failed/cancelled 的審稿。共同交易先檢查未開始 reservation，再撤銷舊 request、建立新 opaque request/token/outbox；舊同意保留，新稿永遠從 pending 開始。相同 owner reopen key 重送重用同一新 request。

## 預設與持久性

- `NUXT_WEEKLY_CONTENT_APPROVAL_ENABLED` 必須精確為 `true`，才開啟 LINE 與 weekly domain。
- 背景 tick 另需既有 `NUXT_CONTENT_OPERATIONS_SCHEDULER_ENABLED` 精確為 `true`；註冊 cron 不代表啟用。所有旗標及金鑰僅 server 使用。 此開關同時放行既有 Content Operations materialize／execution 背景工作，不是單一客戶開關；正式開啟前必須盤點同 owner 已啟用客戶、政策、待處理 entries 與費用範圍。
- 固定每五分鐘觸發一次 weekly tick；全域 worker 以該 owner 的持久配置游標，按穩定配置 ID 讀取目前 active 配置，每輪最多十位客戶、尾端回繞，paused/revoked 不占處理名額。候選選取與游標前移共用一個短 SQL 交易及 exact-owner row lock，不把 AI、LINE 或發布放進該交易；commit 失敗不能開始處理。第 51 筆以後不再被清單上限永久排除，程序重啟不會重設游標，但游標本身不是作業租約、同意、成本或發布權限。每位客戶開始處理前重新查目前配置；owner、ID、政策、目標、指紋或 active 狀態漂移即停止該客戶。通知仍最多十筆。擁有人介面 `listConfigs` 的五十筆讀取上限不是 worker 的選取來源。
- 每週流程的日曆在 SQL `LIMIT` 前以 owner/client 限縮，不再從 owner 全域前一百筆中事後篩客戶。每位客戶的歷史上限仍為一百張；多讀一筆作截斷哨兵，若無法證明歷史完整就停止排程，不能把已用選題或預算當成未使用。這不是無上限歷史或大規模 worker fleet 的承諾。
- 持久游標需要另行審查及套用新增式 `0050`；未套用時保持全域 scheduler 關閉。任何新增式 migration 都不由啟動自動套用。公平候選選取不證明主機持續運作、準時送稿、睡眠期間補跑或每次只產生一篇；仍需獨立主機與真實範圍驗收。游標及候選選取契約見 [Scheduler Cursor V1](WEEKLY_CONTENT_SCHEDULER_CURSOR_V1.md)。
- `NUXT_WEEKLY_CONTENT_TOKEN_KEY` 至少 32 bytes；HMAC 派生的 read/action token 只存 hash，變更 token key 後舊派生 token 無法重新送出或使用。
- `requireCustomerApproval` 為 server-owned client flag，預設 false。舊客戶不查 weekly 表。已 opt-in 客戶即使功能關閉、配置暫停／撤銷或資料缺失，仍 fail closed，不能回到無客戶同意的發文路徑。
- 七張 weekly 表保存配置、邀約 hash、私密 sender binding、精確審稿 request、append-only decision、LINE outbox 與 verified semantic event inbox。不得保存原始 webhook、LINE/channel keys 或 raw action/read token 到事件或公開 DTO。
- Webhook 唯一事件競態只接受 `weekly_webhook_event_uq` 的實際重複鍵，交易回滾後另讀精確 committed winner；不同 semantic fingerprint 拒絕，不做無限重试。
- Outbox 使用交易 claim、最多十筆、兩分鐘 lease、exact lease CAS。首次 payload hash 固定 actual recipient/messages/bot identity，相同 retry UUID 不能換人或換內容；LINE 重送上限為六次、且保守限在 row createdAt 後二十四小時內。租約過期的 sender 不可完成紀錄。
- `0044` 只生成供審查：七張新表、client opt-in flag、client/target 的 Next.js enum。啟用正式功能前需要單獨核准並套用；程式啟動不會自動套用。

## LIFF 平台與瀏覽器邊界

身分綁定版使用 `weekly-liff-identity-confirm-v1` 的公司確認 HMAC，包含邀約、到期時間、公司、owner/client、Login channel 與已驗證 recipient；不再依賴每週配置。舊版 `weekly-liff-confirm-v1` 的 confirmation token 不沿用，升級前已開啟的確認頁須重新取得 context 並再次核對公司。邀約格式、十分鐘時效、既有綁定及 `weekly-liff-bind-v1` durable replay 邊界不變；這兩種 confirmation purpose 不是同時可接受的替代授權。

Login／LIFF 與 Messaging API 必須使用同一 LINE Provider，並核對連結至同一「搜尋王」官方帳號；實際平台連結尚未驗收。LIFF scope 僅選 `openid`；公司綁定不是加好友、解除封鎖、推播額度或文章同意的證據。持續每週收稿前需先加入官方帳號好友並保持未封鎖；LINE API 接受通知或 outbox 標成 `sent`，也不代表客戶已收到或閱讀，真實驗收須確認卡片出現在客戶 LINE。[LINE 官方推播限制](https://developers.line.biz/en/reference/messaging-api/nojs/#send-push-message)

應用程式不將邀約或 ID token 寫入 localStorage、sessionStorage、資料表、事件或 log；ID token 只由 LIFF SDK 取得後送至同源伺服器驗證。官方 SDK 自身可能管理登入 token／context 與瀏覽器儲存，本機測試沒有稽核第三方 SDK 的實際儲存，不能宣稱整個瀏覽器「零 token 儲存」。SDK 初始化完成後才清理 OAuth URL；不能在初始化前刪除 SDK 需要的參數。[LINE 官方 SDK 初始化規則](https://developers.line.biz/en/reference/liff/#liff-init)、[官方 context 儲存紀錄](https://developers.line.biz/en/docs/liff/release-notes/)

## 證據界線

本機測試涵蓋 disabled 零 I/O、owner/sender 隔離、未配置文章服務的身分綁定、公司明確確認與 own-company 清單、綁定不寫文章設定或同意、簽章至真服務同意、read-only 預覽、並行重送、版本／類型／語言／來源／政策／風險變更、暫停、精確 TTL、同意撤回、過期重開、不可變 outbox、SQL 租約條件與 V4 原稿續租。

真實 LINE 官方帳號、資料庫 migration、正式 AI 成本、Do 接收器部署、真實客戶推播／同意／自動發布，以及 Google/AI 搜尋成效尚需分別設定、核准及實測；本機／mock PASS 不代表以上已完成。

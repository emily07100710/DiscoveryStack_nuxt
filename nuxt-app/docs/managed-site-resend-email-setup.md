# Managed Site：Resend 交易郵件設定

這份文件只處理 Managed Site 的交易郵件：收信信箱驗證碼、客戶重新進入後台、聯絡表單轉寄、會員邀請與網站上線通知。它不涵蓋行銷電子報，也不提供日常收件匣。

## 1. Resend 後台準備

1. 在 Resend 新增寄件網域並完成 DNS 驗證。Resend 建議交易郵件使用獨立子網域；完成驗證後，`From` 才能使用該網域的地址。參考 [Domains](https://resend.com/docs/dashboard/domains/introduction)。
2. 建立只供 DiscoveryStack 伺服器使用的 API key。不要把 key 寫進 Git、瀏覽器環境或任何 `NUXT_PUBLIC_*` 變數。
3. 決定單一寄件身分，例如 `DiscoveryStack <notifications@example.com>`。其中 `example.com` 必須換成已驗證的實際網域。

DiscoveryStack 使用 Resend 官方的 [`POST /emails`](https://resend.com/docs/api-reference/emails/send-email) 契約：Bearer API key、JSON request，以及成功回應中的 `id`。寄件請求會帶 [`Idempotency-Key`](https://resend.com/docs/dashboard/emails/idempotency-keys)；Resend 在 24 小時內對相同 key 與相同 payload 回傳原結果，不會重複寄送。

## 2. 伺服器環境變數

以下值只能設定在伺服器／部署平台的秘密設定，不可放進公開 runtime config：

```dotenv
NUXT_MANAGED_SITE_EMAIL_API_KEY=re_replace_with_server_secret
NUXT_MANAGED_SITE_EMAIL_FROM=DiscoveryStack <notifications@example.com>
DISCOVERYSTACK_MANAGED_SITE_ALLOWED_PROVIDER_ORIGINS=https://api.resend.com
```

如果 allowlist 已有 Stripe、Bailian 或其他 provider origin，請保留原值並以逗號加入 Resend：

```dotenv
DISCOVERYSTACK_MANAGED_SITE_ALLOWED_PROVIDER_ORIGINS=https://api.resend.com,https://api.stripe.com
```

選填設定：

```dotenv
# 省略時固定使用官方端點 https://api.resend.com/emails
NUXT_MANAGED_SITE_EMAIL_ENDPOINT=https://api.resend.com/emails

# 1000–30000 毫秒；預設 10000
NUXT_MANAGED_SITE_EMAIL_TIMEOUT_MS=10000
```

收信信箱驗證碼另需一個長期、不可公開的 pepper；更換它會讓尚未確認的舊驗證碼失效：

```dotenv
NUXT_MANAGED_SITE_EMAIL_CODE_PEPPER=replace_with_at_least_32_random_bytes
```

平台交易郵件先以加密內容保存在 MySQL/TiDB 佇列中，再於資料提交後檢查當前授權並嘗試送出。新增佇列表前，須先審核並套用 `0046_managed_email_outbox_v1.sql`；產生 SQL、建置或部署程式都不會自動套用資料庫，也不會開啟寄信。

```dotenv
# 獨立的 32 至 4096 bytes 隨機密鑰；不要重用 API key、登入密鑰或 pepper。
NUXT_MANAGED_SITE_EMAIL_OUTBOX_ENCRYPTION_KEY=replace_with_independent_random_key
# 同時控制即時寄送及背景重試；預設關閉。
NUXT_MANAGED_SITE_EMAIL_OUTBOX_ENABLED=false
# migration 驗收後可獨立啟用，到期清除內容，不會寄信。
NUXT_MANAGED_SITE_EMAIL_OUTBOX_RETENTION_ENABLED=false
MANAGED_SITE_EMAIL_OUTBOX_CRON=*/1 * * * *
```

應先完成資料庫、DNS 與寄件設定，再安排指定自有測試信箱的受控寄送驗收；驗收期間才暫時開啟 execution 開關。需要持續服務時，排程主機須常駐。暫停寄送時仍可保留 retention 開關，清除到期郵件中的私密內容。更換密鑰、寄件人、端點或其他 authority 設定時，舊佇列不能直接換設定重送，會保守停止並需要重新確認。

重新存取與會員邀請的連結還需要平台既有的固定 HTTPS origin：

```dotenv
NUXT_DISCOVERYSTACK_PRIVATE_ORIGIN=https://your-private-portal.example.com
```

## 3. 啟用前檢查

- `NUXT_MANAGED_SITE_EMAIL_FROM` 是單一合法信箱或 `顯示名稱 <信箱>`，而且網域已在 Resend 顯示為 verified。
- allowlist 必須包含端點的完整 origin `https://api.resend.com`，不可放 path、query、帳密或萬用字元。
- `managedSiteEmailReadinessFromEnv()` 只做本機設定格式與 allowlist 檢查，不會呼叫 Resend，也不會回傳任何 secret。`configured: true` **不代表** API key、DNS 或實際投遞已由 Resend 驗證成功。
- 自動化測試使用假 transport／假 HTTP response，不會真的寄信。正式啟用後仍要由操作人員用自有測試收件匣完成一次驗證碼、重新存取與表單轉寄驗收。
- 上線通知只在精確付款、正式部署與客戶工作區權威都成立後寄送，不含登入 bearer token。寄信失敗不會撤銷已完成的網站交付；後續交付重試會嘗試補寄，不會因此建立第二個工作區。
- 原始驗證碼與邀請／登入連結和來源資料在同一交易中保存；服務重啟可以恢復同一封郵件。相同 provider key 的自動重試限首次嘗試後保守的 23 小時內，而且不得超過郵件／連結本身期限。無法確認結果時，不會逾期盲目補寄。
- Provider 接受請求的 UUID 回應先持久保存；若本地回執補登失敗，後續只補登回執，不再呼叫寄信服務。佇列不會提前產生「已交付」或「已收信」證據。
- 後台「郵件紀錄」只供讀取最近 50 筆屬於擁有人的專案／登入通知；不顯示信箱、驗證碼、原文、bearer、加密內容或 raw provider receipt，也不把尚未歸屬擁有人的購買前挑戰列入其他 scope。
- Provider 的錯誤本文不會回傳給客戶；成功本文上限 16 KiB，request timeout 預設 10 秒。常見 Resend 狀態可查 [Errors](https://resend.com/docs/api-reference/errors)。

## 4. 舊自訂端點遷移

`NUXT_MANAGED_SITE_EMAIL_ENDPOINT` 仍可指定自架、且已列入 exact-origin allowlist 的相容端點，但現在會明確要求：

- HTTPS URL，path 必須是 `/emails`；
- 接受 Resend 相同的 `from`、`to`、`subject`、`text`、`reply_to` JSON 欄位與 `Idempotency-Key` header；
- 成功時回 `application/json`，本文至少包含 UUID 格式的 `id`。

若舊端點不是這個契約，請先加一層相容 adapter；不要直接把舊 URL 留在設定中，否則 readiness 會標示為 invalid 並 fail closed。

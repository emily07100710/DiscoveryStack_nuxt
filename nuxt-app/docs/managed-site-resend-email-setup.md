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
- Provider 的錯誤本文不會回傳給客戶；成功本文上限 16 KiB，request timeout 預設 10 秒。常見 Resend 狀態可查 [Errors](https://resend.com/docs/api-reference/errors)。

## 4. 舊自訂端點遷移

`NUXT_MANAGED_SITE_EMAIL_ENDPOINT` 仍可指定自架、且已列入 exact-origin allowlist 的相容端點，但現在會明確要求：

- HTTPS URL，path 必須是 `/emails`；
- 接受 Resend 相同的 `from`、`to`、`subject`、`text`、`reply_to` JSON 欄位與 `Idempotency-Key` header；
- 成功時回 `application/json`，本文至少包含 UUID 格式的 `id`。

若舊端點不是這個契約，請先加一層相容 adapter；不要直接把舊 URL 留在設定中，否則 readiness 會標示為 invalid 並 fail closed。

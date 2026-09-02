# Managed Sites 內部 Broker 設定指南 V1

這份指南給網站擁有者或帳號管理者使用。所有範例值都是假的，不能直接拿去正式環境。真正的密鑰只放在部署平台的「環境變數／Secrets」設定，不要貼到 Git、資料庫、瀏覽器、聊天、工單或截圖裡。

## 1. 先在 Cloudflare 準備資源

1. 登入 Cloudflare Dashboard。
2. 在 **R2 Object Storage** 建立一個私人 bucket，例如 `discoverystack-managed-sites-prod`。不要開放 public access。
3. 在 **My Profile → API Tokens → Create Token** 建立 Cloudflare API Token。權限至少要能編輯該帳號的 **Cloudflare Pages**（Account / Cloudflare Pages / Edit），資源範圍只選實際使用的帳號。建立後只會顯示一次，請直接存進部署平台的 secret。
4. 在 R2 的 **Manage R2 API Tokens** 建立 S3 相容憑證，只授權剛才的 bucket。記下 Access Key ID 與 Secret Access Key，兩者都只能放在部署平台 secret。
5. Account ID 可在 Cloudflare Dashboard 的帳號首頁或右側 Account details 找到。它是 32 位小寫十六進位字串，例如 `0123456789abcdef0123456789abcdef`。

Pages 專案不用預先建立。第一次 preview 時，Broker 會以固定名稱建立專案，並使用 preview branch Direct Upload；不會把 preview 當成 production deployment。

## 2. 產生兩個 DiscoveryStack 內部密鑰

在自己的電腦終端機各執行一次：

```bash
openssl rand -hex 32
openssl rand -hex 32
```

第一個值給 deployment bearer，第二個值給 DNS/TLS HMAC。不要重複使用，也不要把輸出貼進任何檔案。Cloudflare API Token 是第三個獨立 secret。

## 3. 設定環境變數

以下全部設在私有 Nuxt 服務的部署環境。JSON 建議壓成單行。範例中的 `<...>` 都要換成真正值。

### Credential registry

注意：deployment reference 名稱使用 `envref:managed-deployment-runtime`。現有 transport 的防洩漏驗證會拒絕 reference 名稱本身含有 `bearer`、`token`、`secret` 或 `credential` 等字樣。

```text
DISCOVERYSTACK_MANAGED_SITE_CREDENTIALS_JSON={"envref:managed-deployment-runtime":"<openssl-first-output>","envref:managed-dns-tls-hmac":"<openssl-second-output>","envref:cloudflare-pages-access":"<cloudflare-api-token>"}
```

### Internal broker

```text
DISCOVERYSTACK_MANAGED_SITE_INTERNAL_BROKER_JSON={"deploymentCredentialReference":"envref:managed-deployment-runtime","dnsTlsCredentialReference":"envref:managed-dns-tls-hmac","cloudflare":{"accountId":"0123456789abcdef0123456789abcdef","apiTokenReference":"envref:cloudflare-pages-access","projectPrefix":"ds"}}
```

`projectPrefix` 可省略，預設是 `ds`；只能使用小寫英數字與連字號，最多 16 字元。

### R2 artifact vault

```text
DISCOVERYSTACK_MANAGED_SITE_VAULT_JSON={"bucket":"discoverystack-managed-sites-prod","region":"auto","prefix":"managed-sites-v1","endpoint":"https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com"}
AWS_ACCESS_KEY_ID=<r2-access-key-id>
AWS_SECRET_ACCESS_KEY=<r2-secret-access-key>
```

### Provider origin allowlist

固定 sentinel origin 必須在 allowlist 裡。它看起來像 HTTPS 網址，但程式永遠不會對它做 DNS 或網路連線；只會在 Nuxt process 內直接 dispatch。其他既有 provider origin 以逗號分隔保留。

```text
DISCOVERYSTACK_MANAGED_SITE_ALLOWED_PROVIDER_ORIGINS=https://managed-sites-broker.discoverystack.dev,https://provider.acme.taipei
```

若 Broker JSON、reference 或 secret 缺少／格式錯誤，sentinel request 會直接回 503，不會改用外部網路。

## 4. 由擁有者設定並驗證兩個 capability

先登入私有 Nuxt owner 後台。以下範例用 `curl` 表示兩個 API 步驟；`<private-nuxt-origin>` 換成私有 Nuxt 網址，`<owner-session-cookie>` 換成目前登入 session。不要把 cookie 存進 shell history 或分享出去。擁有者 mutation 必須是 same-origin request，因此命令列呼叫必須明確送出 `Origin` header。

### Deployment

```bash
curl -X POST 'https://<private-nuxt-origin>/api/managed-sites/live-connectors/provider-configurations' \
  -H 'content-type: application/json' \
  -H 'origin: https://<private-nuxt-origin>' \
  -H 'cookie: <owner-session-cookie>' \
  --data '{"capability":"deployment","providerKey":"internal-deployment-bearer-v1","readinessStatus":"configured","credentialReference":"envref:managed-deployment-runtime","transportConfiguration":{"endpointOrigin":"https://managed-sites-broker.discoverystack.dev"},"idempotencyKey":"configure-internal-deployment-v1"}'

curl -X POST 'https://<private-nuxt-origin>/api/managed-sites/live-connectors/providers/deployment/verify' \
  -H 'content-type: application/json' \
  -H 'origin: https://<private-nuxt-origin>' \
  -H 'cookie: <owner-session-cookie>' \
  --data '{}'
```

Deployment verify 會真的呼叫 Cloudflare Pages API 做有時限的權限 probe。只有 Cloudflare 回覆成功，狀態才會成為 `verified`。

### DNS/TLS ownership

```bash
curl -X POST 'https://<private-nuxt-origin>/api/managed-sites/live-connectors/provider-configurations' \
  -H 'content-type: application/json' \
  -H 'origin: https://<private-nuxt-origin>' \
  -H 'cookie: <owner-session-cookie>' \
  --data '{"capability":"dns_tls","providerKey":"internal-dns-tls-broker-hmac-v1","readinessStatus":"configured","credentialReference":"envref:managed-dns-tls-hmac","transportConfiguration":{"endpointOrigin":"https://managed-sites-broker.discoverystack.dev"},"idempotencyKey":"configure-internal-dns-ownership-v1"}'

curl -X POST 'https://<private-nuxt-origin>/api/managed-sites/live-connectors/providers/dns_tls/verify' \
  -H 'content-type: application/json' \
  -H 'origin: https://<private-nuxt-origin>' \
  -H 'cookie: <owner-session-cookie>' \
  --data '{}'
```

DNS/TLS verify 驗證的是本機具備 DNS TXT 與 well-known file 檢查能力，不會替你修改 DNS，也不會宣稱已擁有任何網域。真正 ownership verification 仍必須讀到指定的 TXT 或 well-known 內容。

## 5. 執行選配的真實測試

真實部署測試會把一個小型 fixture 存入 R2、建立 Cloudflare Pages preview、等待公開 URL 回 200，並確認 HTML 內有 marker：

```bash
pnpm test:real-deployment
```

真實 ownership 測試第一階段只會印出要建立的 TXT，不會假裝驗證成功：

```bash
DS_REAL_OWNERSHIP_DOMAIN=your-real-domain.com pnpm test:real-ownership
```

依照輸出建立 TXT，等待 DNS 傳播後，再明確要求 verified：

```bash
DS_REAL_OWNERSHIP_DOMAIN=your-real-domain.com DS_EXPECT_OWNERSHIP_VERIFIED=1 pnpm test:real-ownership
```

若 DNS 尚未真的回傳完全相同的內容，第二階段必須失敗，不能算 pass。

## 誠實邊界

- 真實功能：Cloudflare credential probe、R2 bundle 讀取、固定模板靜態渲染、Cloudflare Pages preview Direct Upload、preview URL readiness poll、DNS TXT ownership、HTTPS well-known-file ownership。
- 預設測試：所有 Cloudflare、DNS、vault 與 HTTPS 行為均由測試注入，不會碰網路，也不能當成 Cloudflare 帳號已可用的證明。
- 尚未執行：production deploy 與 rollback 會明確回 503；payment、domain quote/purchase、DNS/TLS apply 也不在此 segment。系統不會因 preview 成功就宣稱正式站已上線。

# GEOFlow Runtime Transport V1

> **定位：generation transport adapter ready for controlled runtime use.** 本模組把 DiscoveryStack 的既有 GEOFlow generation contract 接到正式 GEOFlow REST routes；它不是 publication executor，也不是 WordPress、Astro、Nuxt 或 client-site writer。

## 1. Scope and upstream compatibility

本 adapter 以 pinned GEOFlow upstream reference `9d70db04ee9c5d308f5fa29b4c65834229af9eea` 的既有 contract documentation 為相容性依據。Repository base 沒有 `services/geoflow/routes/api.php` 或 PHP route tree，因此本輪沒有偽造或修改 PHP routes；正式 transport 只依下列既有 upstream route contract。

| Operation | Method and route | Adapter function |
|---|---|---|
| Enqueue generation task | `POST /api/v1/tasks/{task}/enqueue` | `planGeoFlowEnqueueRequest()`、`executeGeoFlowEnqueue()` |
| Poll generation job | `GET /api/v1/jobs/{job}` | `executeGeoFlowJobPoll()` |
| Fetch generated article candidate | `GET /api/v1/articles/{article}` | `executeGeoFlowArticleFetch()` |

所有 upstream requests 使用 server-side Bearer token，但 token 只可經由 injected `GeoFlowCredentialResolver` 由 opaque `credentialReference` 解析。Adapter 不讀 `process.env`、不保存 credential、不把 credential 放入 plan、result、error 或 log，也沒有 credential default、secret resolver 或 vault implementation。

**Review、publish、WordPress、PHP arbitrary HTTP executor、external delivery ledger 與 client-site write 不屬於本模組。** Adapter 永遠不呼叫 `/review` 或 `/publish`，只接受 generation candidate；remote `approved`、`published`、`delivered`、`publishing` 與 `ready_to_publish` 都 fail closed。

## 2. Runtime dependency boundary

Adapter 不使用 global `fetch` fallback。每次 execution 必須注入：

```ts
{
  fetch: GeoFlowFetch,
  credentialResolver: GeoFlowCredentialResolver,
  clock: { now: () => string },
  sleep?: (milliseconds: number) => Promise<void>
}
```

`GeoFlowFetch` 是唯一 network seam，request init 固定包含 `redirect: 'manual'`。Production caller 必須自行提供有 timeout/abort、bounded response stream、TLS/egress policy、DNS pinning、redirect revalidation、credential storage 與 durable idempotency/nonce strategy 的實作；本 adapter 不自行建立上述 infrastructure。

## 3. Enqueue request contract

`planGeoFlowEnqueueRequest(request, target)` 先呼叫既有 `validateGeoFlowRequest()` public contract，重新計算並驗證 request/brief fingerprint，再驗證 target：

| Field | Rule |
|---|---|
| `baseUrl` | public HTTPS origin；無 credentials、query、fragment、non-default port、path、special-use/local/private target；只接受 root origin |
| `taskId` | positive safe integer，bounded to signed 32-bit maximum |
| `credentialReference` | opaque server-side reference，不是 token |
| `attempt` | safe integer 1–10 |
| limits | timeout 1–120,000 ms；response body 1–10 MiB；max attempts 1–10；max polls 1–100；poll interval 0–60,000 ms；Retry-After 0–3,600 s |

Enqueue body 會包含 `request_id`、`request_fingerprint`、`idempotency_key`、project/calendar/deliverable identities、task ID、`evidence_snapshot_hash`、`brief_fingerprint`、selected rules、requested capabilities、attempt、generation mode、revision context、brief、content type/language 與 authority source IDs。`job_type` 的 upstream task capability 由固定 route contract 表示；adapter 不接受 caller 自由指定任意 route 或 operation。

實際 request headers 為：

```text
Accept: application/json
Authorization: Bearer <resolved server credential>
Content-Type: application/json
X-Idempotency-Key: <request.idempotencyKey>
X-Request-Id: <request.requestId>
```

Plan 只保存 header names，不保存 Authorization value。Plan、enqueue result 與 transport error 均為 deep-frozen 或 sanitized data；verified plan/result 被 runtime-local identity seal 保護，caller clone 不會被當成已驗證物件。

## 4. Response validation and lineage

Adapter 只接受 JSON response，要求 `Content-Type: application/json`、bounded body bytes、HTTP status 2xx、`{ success: true, data: object }` envelope 與 matching `request_id`。所有 task/job/article IDs、request ID、request fingerprint、attempt 與 content hash 都重新驗證；不會將 remote raw payload 直接交給 downstream。

### 4.1 Enqueue

Enqueue 必須回傳 matching `request_id`、positive `task_id` 與 positive `job_id`。Missing/wrong task or job identity 立即 fail closed。成功 result 只含 request fingerprint、request ID、task ID、job ID、attempt、remote request ID 與 bounded remote status。

### 4.2 Job poll

Poll URL 的 job ID 必須來自 verified enqueue result，不接受 caller 另外提供 article ID。Remote job summary 必須 matching task/job/request identity、request fingerprint、attempt、bounded status 與 positive `article_id`。只有 `completed`、`succeeded`、`success`、`draft_ready`、`review_required`、`ready` 或 `candidate` 這些 bounded terminal statuses 才能交給 article fetch；pending status 會在 bounded poll count 內等待，failed/blocked/cancelled 會停止。

### 4.3 Article candidate

Article URL 的 article ID 必須來自 verified job summary。Adapter 會要求 matching task/job/article/request/brief/evidence identities、exact UTF-8 `bodyHash`、bounded title/summary/body/limitations、valid provider provenance、valid completion time、valid `appliedRuleIds` 與 candidate status。結果再經既有 `validateGeoFlowResponse()` 及 `verifyGeoFlowLineage()` 驗證。

產出的 response 只允許 `draft_ready` 或 `review_required`，並以固定 external article key `article-{calendarEntryId}-{deliverableId}` 綁定 DiscoveryStack identity。它不是 approved、published、delivered 或 production-ready result。

## 5. Retry and idempotency

`classifyGeoFlowTransportFailure()` 使用 bounded policy：

| Condition | Retry policy |
|---|---|
| timeout / abort | retryable |
| network failure | retryable |
| HTTP 429 | retryable only with numeric bounded `Retry-After` or no header |
| HTTP 500–599 | retryable |
| HTTP 401/403 | permanent unauthorized |
| HTTP 404 | permanent not found |
| HTTP 409/422 | permanent conflict/unprocessable |
| 3xx | permanent redirect blocked |
| malformed/content-type/oversized/identity/hash/status | permanent |

所有 enqueue、job poll、article fetch 的 retries 都受 target `maxAttempts` 1–10 限制。`Retry-After` 只接受 bounded integer seconds；HTTP-date、negative、non-numeric 或超過 target limit 都回 `RETRY_AFTER_INVALID`。Sleep 必須使用 injected function；沒有 hidden timer、background task 或 scheduler。

Process-local enqueue coalescing 以 `(idempotencyKey, requestFingerprint)` pair 去除同一 process 內的 concurrent duplicate calls；同一 key 搭配不同 request fingerprint 會回 `IDEMPOTENCY_COLLISION`，不會再發出 remote request。正式多 process deployment 仍必須在 DiscoveryStack-side 以 durable unique key/transaction/compare-and-set 等價機制實作 idempotency。

## 6. Error hygiene and security

Error result 只回 bounded code、retryable、必要的 HTTP status、bounded retry-after seconds 或 bounded existing contract reason；不回 remote body、raw provider error、stack、URL query secret、Bearer token、credential value、request body 或 arbitrary remote metadata。Credential resolver 的 false、throw、reject 都轉為 `CREDENTIAL_RESOLUTION_FAILED`。

URL guard 重用既有 GEOFlow public HTTPS policy，包含 decoded sensitive query keys/values、userinfo、fragment、special-use domain、private/loopback/link-local/documentation/mapped IPv4/IPv6 ranges 與 no-DNS policy。Adapter 的 target guard 另外要求 base URL 為 public root origin，避免 caller 把 route 或 query 注入 base URL。

## 7. Public API

```ts
planGeoFlowEnqueueRequest(request, target)
executeGeoFlowEnqueue({ request, target }, dependencies)
executeGeoFlowJobPoll({ plan, enqueue }, dependencies)
executeGeoFlowArticleFetch({ plan, job }, dependencies)
validateGeoFlowTransportResult({ request, plan, result })
classifyGeoFlowTransportFailure(input)
parseGeoFlowRetryAfter(value, maximumSeconds)
retryAllowedForAttempt(attempt, error, maxAttempts)
validateGeoFlowBaseUrl(value)
validateGeoFlowTaskId(value)
validateGeoFlowCredentialReference(value)
```

Enqueue、poll、article fetch 保持分離，讓每一段都可在 mock fetch 下獨立測試；沒有 route handler、Nuxt API endpoint、database、queue、scheduler、UI、deploy 或 production credential configuration。

## 8. Testing and limitations

`tests/geoflow-runtime-transport.test.ts` 使用 injected mock fetch、mock credential resolver、mock clock 與 mock sleep，不向真實 GEOFlow 發 request。測試涵蓋正常 enqueue → poll → article flow、固定 methods/paths/headers/body、all required identity/hash checks、malformed/oversized/content-type/redirect、401/403/404/409/422/429/5xx、timeout/network、retry bound、credential failures、SSRF guards、attempt limits、article readiness、candidate/publication separation、idempotency replay/collision/concurrency 與 secret non-disclosure。

本模組可在 caller 提供正式 dependency 時執行 REST transport，但本 commit 沒有 production caller、credential resolver、real fetch binding、durable idempotency store、real upstream interoperability environment 或 deployment。**因此不可宣稱 GEOFlow runtime 已在 production connected，也不可宣稱 generation quality、ranking、traffic、conversion、ROI 或 publication 已運作。**

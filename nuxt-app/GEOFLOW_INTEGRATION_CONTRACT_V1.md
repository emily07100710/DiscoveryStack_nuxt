# DiscoveryStack ↔ GEOFlow Integration Contract V1

> **定位：internal contract ready for connector implementation。** 本文件定義 DiscoveryStack Nuxt control plane 與未來 GEOFlow Laravel content engine 之間的 deterministic、offline、pure TypeScript、fail-closed wire contract。本輪只修復可驗證的資料、狀態、lineage、fingerprint、URL policy 與 signing-envelope 規則；沒有建立 API route、HTTP transport、database persistence、queue、scheduler、UI、provider call、credential resolver 或部署。

## 1. 真實上游相容性與本輪邊界

本契約以 pinned GEOFlow upstream source SHA `9d70db04ee9c5d308f5fa29b4c65834229af9eea` 的現況作為相容性參照。該上游目前公開的 API surface 是：

| 上游能力 | 目前實際路由／認證 | V1 contract 對應 |
| --- | --- | --- |
| Task 建立／管理 | `/api/v1/tasks`；Bearer token + scopes | 只保留未來 adapter 所需的外部 identity 欄位 |
| Job 查詢 | `/api/v1/jobs/{job}`；Bearer token + scopes | 只定義 generation progress/result 的資料 union |
| Article 建立／查詢 | `/api/v1/articles`；Bearer token + scopes | 只定義 candidate content artifact，不授予發布權 |
| Article review | `/api/v1/articles/{article}/review`；Bearer token + scopes | DiscoveryStack-side human review 與 risk gate 仍為 authority |
| Article publish | `/api/v1/articles/{article}/publish`；Bearer token + scopes | 不在本 V1 接受、映射或執行；必須另建 governed delivery contract |

上游目前**不存在** `/api/internal/discoverystack/v1/generation-jobs`。本路徑只是一個固定 signing-envelope operation label，用於未來 adapter 的 canonical planning；它不是本輪建立的 endpoint，也不是可呼叫的 HMAC service。

因此本輪完成後只能稱為 **internal contract ready for connector implementation**，不得稱為 GEOFlow connected、runtime integrated、HMAC endpoint available、Qwen connected、content generation working、publication working、production-ready 或 deployed。下一階段若要真正接通，必須另行完成 DiscoveryStack server adapter、GEOFlow Laravel internal adapter route、PHP/TypeScript golden-fixture interoperability tests、credential/key management、persistent nonce/idempotency storage 與 real runtime integration。本輪不順便實作上述內容。

**Human review、risk gate、approval 與 delivery ledger 仍由 DiscoveryStack 管理。** GEOFlow 在本 V1 最多回傳 candidate content；任何 WordPress、Astro、Nuxt、PHP、signed API 或其他站點發布，都必須通過獨立的 governed delivery contract，不能由 GEOFlow response status 或本契約的 lineage helper 推導成 delivered。

## 2. Request contract 與 Content Brief

`buildGeoFlowRequest()` 接受 `unknown`，先對固定 protocol version、完整 server-owned identity、Content Brief、revision lineage、evidence snapshot、capabilities 與 timestamp 做 strict normalization，再自動計算 fingerprints。所有成功值都是 detached normalized copies；unknown keys、null、undefined、array、primitive、malformed nested records、accessor/proxy exception、unsafe JavaScript values 與 over-limit aggregates 都 fail closed。Failure 值不回傳 raw input、stack、secret 或 arbitrary provider error。

`GeoFlowRequestDraft` 必須包含下列 strict brief：

```ts
{
  title: string
  audience: string
  goals: string[]
  constraints: string[]
}
```

| Brief 欄位 | V1 normalization 與限制 |
| --- | --- |
| `title` | NFKC、trim、連續 whitespace 正規化；1–300 字元 |
| `audience` | 同上；1–300 字元 |
| `goals` | array；1–10 項；每項 1–500 字元；保留原始順序；normalized 後不得重複 |
| `constraints` | array；0–20 項；每項 1–500 字元；保留原始順序；normalized 後不得重複 |

`briefFingerprint` 不能由 caller 任意指定。Builder 會使用 normalized `{ title, audience, contentType, language, goals, constraints }`，以既有 canonical code-unit JSON 與 SHA-256 自動產生。Caller-supplied `briefFingerprint` 不會覆寫計算結果；request fingerprint 也會涵蓋完整 normalized brief、計算後的 brief fingerprint 與其他 request fields。Opaque IDs 不做 Unicode normalization。

## 3. Revision lineage

Request 的 generation mode 是 discriminated contract：

```ts
// draft
{ generationMode: 'draft', revisionContext: null }

// revision
{
  generationMode: 'revision',
  revisionContext: {
    parentDraftId: number,
    parentContentHash: string,
    changeRequestReviewId: number,
    instructions: string
  }
}
```

Draft 帶非 null `revisionContext` 必須拒絕。Revision 缺少 context、parent draft ID、lowercase parent content hash、change-request review ID 或 normalized 1–4000 字元 instructions 必須拒絕。所有 revision context 欄位都納入 request fingerprint；任何 parent hash、review ID 或 instructions mutation 都會改變 fingerprint。這是 generation lineage binding，不是 delivery approval 或 publication authority。

## 4. Evidence integrity 與 capability prerequisites

每個 evidence chunk 都包含 `sourceId`、`artifactId`、`chunkId`、`chunkHash`、`reviewedText` 與 `locator`。`chunkHash` 的定義固定為：

> `sha256(normalized reviewedText UTF-8 bytes)`

Normalizer 會重新計算並比對傳入 hash；reviewed text 改變而 hash 未改變時回傳 `EVIDENCE_CHUNK_HASH_MISMATCH`。同一 `(sourceId, artifactId, chunkId)` identity 不得重複，即使兩筆 hash 或 reviewedText 不同也拒絕。Evidence source 必須位於 request authority allowlist；`evidenceSnapshotHash` 必須是 lowercase SHA-256 並綁定到 result response。

| Requested capability | 必備前置條件與 result 驗證 |
| --- | --- |
| `knowledge_rag` | `authoritySourceIds` 與 `evidenceChunks` 都至少一項；draft result 必須有 citations，且每個 binding 精確符合 source、artifact、chunk、chunkHash |
| `autogeo_optimization` | `selectedRuleIds` 至少一項；draft result `appliedRuleIds` 必須非空且與 selected rule IDs 完全一致，不接受 subset 或只修改 metadata 的假套用 |
| `qwen_generation` | provenance mode 必須是 `provider`，provider 必須明確為 Qwen／Bailian adapter identity；deterministic scaffold 不得冒充 Qwen |
| `prompt_pack` | 不額外要求 evidence，但仍受一般 request、artifact 與 identity 驗證 |
| `human_review` | 表示 downstream 需要 DiscoveryStack-side review；不把 review authority 移交 GEOFlow |

`deterministic_scaffold` 必須使用固定 limitation `No external provider generation was executed.`，不得宣稱外部 provider/model。`reference_fallback` 必須提供 bounded、非空 `fallbackReason`，且不得宣稱 provider generation 已執行。

## 5. Canonicalization、fingerprint 與 idempotency

`canonicalizeContractValue()` 使用 deterministic JSON：object keys 只按 JavaScript code-unit ordering 排序；arrays 保留順序；不使用 `localeCompare`、ICU 或 host locale。它拒絕 `undefined`、非有限數字、function、symbol、bigint、Date、Map、Set、circular reference、accessor getter/setter 與讀取失敗的 proxy。Human-visible strings 才套用 NFKC/trim/whitespace normalization；exact Markdown bytes 不得被改寫。

`resolveGeoFlowIdempotency()` 以完整 `(idempotencyKey, requestFingerprint)` pair 做判定：missing record 是 `new_request`，相同 pair 是 `replay`，相同 key 搭配不同 fingerprint 是 `IDEMPOTENCY_COLLISION`；malformed stored record fail closed，不能被當成新工作。

## 6. Discriminated response union

Response 只允許三個 discriminator family，不能再要求所有 status 都帶假 title、summary 或 content hash。

### Progress response

適用 `queued`、`running`、`retry_wait`。它只包含完整 request/owner/client/job identity、external project/task/job/article identity、status、`observedAt`、bounded limitations，以及 `retry_wait` 所需的 fixed retry metadata。Progress response 不接受 `contentArtifact`。

### Failure response

適用 `blocked`、`failed`。它包含完整 identity、status、`observedAt`、固定 bounded `{ code, retryable }` failure 與 limitations。不得接受 content artifact、raw provider error、stack、raw response 或 arbitrary metadata。

### Draft result response

適用 `draft_ready`、`review_required`。它必須包含 deterministic `externalArticleKey`、`draftIdentity`、`contentArtifact`、`evidenceSnapshotHash`、`citationBindings`、`appliedRuleIds`、`providerProvenance`、limitations 與 `completedAt`。外部 article identity 固定由 server-owned IDs 推導為 `article-{calendarEntryId}-{deliverableId}`，不由 title 推導。

固定 artifact schema：

```ts
{
  schemaVersion: 'geoflow-content-artifact-v1',
  contentType: request.contentType,
  language: request.language,
  title: string,
  summary: string,
  bodyMarkdown: string,
  bodyHash: string
}
```

`bodyMarkdown` 必須非空、最多 200,000 UTF-8 bytes、拒絕 NUL，且不得 NFKC、trim、whitespace rewrite 或改變 newline；`bodyHash` 必須由 exact UTF-8 bytes 計算並為 lowercase SHA-256。`contentType`、`language` 必須與 request 完全一致；`completedAt` 不得早於 request `createdAt`。Progress/failure 帶 artifact、或 draft result 缺 artifact，都必須拒絕。所有 response family 都必須滿足 `eventTime >= request.createdAt`：progress/failure/retry 使用 `observedAt`，draft result 使用 `completedAt`。`retry_wait.retryAt` 必須嚴格晚於 `observedAt`，`attempt` 是 1–10 的 safe integer；`blocked.failure.retryable` 必須固定為 `false`。這些時間與 retry guards 在 progress/failure family 也會先於 success 執行。

## 7. GEOFlow-only status 與 combined state-event validation

GEOFlow V1 status 僅允許：

`queued`、`running`、`draft_ready`、`review_required`、`blocked`、`failed`、`retry_wait`。

`approved`、`publishing`、`published` 都必須拒絕。DiscoveryStack 的 delivery vocabulary 也不能被轉成 GEOFlow publication authority：

| DiscoveryStack status | V1 行為 |
| --- | --- |
| `awaiting_generation` | 可映射為 GEOFlow `running` |
| `awaiting_review` | 可映射為 GEOFlow `review_required` |
| `blocked` | 可映射為 GEOFlow `blocked` |
| `failed` | 可映射為 GEOFlow `failed` |
| `retry_wait` | 可映射為 GEOFlow `retry_wait` |
| `ready_to_publish`、`publishing`、`delivered` | fail closed；不映射 |
| GEOFlow `published` | fail closed；絕不映射為 DiscoveryStack `delivered` |

Public helper `validateGeoFlowStatusEventForStoredState({ previousResponse, request, response, explicitRetry })` 不接受 caller-provided `previousStatus`；它依固定順序執行：validate request、validate current response against request、以同一 request validate non-null `previousResponse`、比較 previous/current 的 project/task/job/article identities、由 `previousResponse.status` 推導 transition、檢查 current event time 不得早於 previous event time、對相同 timestamp 要求完整 canonical response fingerprint 相同，最後才驗證 transition 與 explicit retry，並回傳 accepted normalized event。固定 transition 為：

| Previous state | Allowed next state |
| --- | --- |
| none | `queued` only |
| `queued` | `queued`、`running`、`blocked`、`failed`、`retry_wait` |
| `running` | `running`、`draft_ready`、`review_required`、`blocked`、`failed`、`retry_wait` |
| `draft_ready` | `draft_ready`、`review_required` |
| `review_required` | `review_required`、`blocked`、`failed` |
| `retry_wait` | GEOFlow 只可依 GEOFlow vocabulary 進入 `queued`、`running`、`blocked`、`failed`；需 `explicitRetry: true` |
| `blocked` | terminal；只可維持 `blocked` |
| `failed` | GEOFlow 只可用 explicit retry 回 `queued`；DiscoveryStack machine 則只可用 explicit retry 回 `awaiting_generation` |

DiscoveryStack 與 GEOFlow 的 retry vocabulary 必須分開驗證：DiscoveryStack 不接受以 `queued` 表示重試，GEOFlow 不接受以 `awaiting_generation` 表示重試。`delivered` 維持不可 rollback。

本 combined helper 不是 delivery acceptance；它只驗證 generation event。`verifyGeoFlowLineage()` 只驗證 candidate request/response identity、article key、fingerprint、evidence snapshot 與 artifact binding；已移除 `verifyPublishedGeoFlowLineage` public export。

## 8. Fixed HMAC envelope planning／verification

Signing operation fields 固定為：

```text
algorithm: hmac-sha256
method: POST
path: /api/internal/discoverystack/v1/generation-jobs
```

`planSigningEnvelope()` 的 input 只能有 `request`、`timestamp`、`nonce`、`sender`、`receiver`、`keyId`；caller 不能提供 `bodyHash`。Planner 先 validate request，再以 canonical validated request bytes 自動計算 `bodyHash = sha256(canonicalBody UTF-8 bytes)`。Nonce 為 32–128 字元 base64url；key ID 是 bounded opaque non-secret ID；timestamp 與 nonce 必須由 caller 注入。

Canonical signing input 依固定欄位順序並以真正的 LF `\n` 連接：

```text
algorithm
method
path
protocolVersion
requestId
idempotencyKey
requestFingerprint
bodyHash
timestamp
nonce
sender
receiver
keyId
```

`verifySigningEnvelope()` 回傳 `Promise<ValidationResult<true>>`，並固定依序執行：parse/validate envelope、validate request/context、驗證 protocol/method/path/sender/receiver/keyId、驗證 request identity/fingerprint/body hash、驗證 clock skew、呼叫 async-capable `signatureVerifier`，只有 signature 成功後才呼叫 async-capable `nonceClaimVerifier`，atomic claim 成功後才 accepted。`NonceClaimVerifier` 的 input 固定包含 `{ nonce, sender, receiver, keyId, timestamp }`；它不是 freshness check。無效或 throwing/rejecting signature 不得 claim nonce；claim throw/reject fail closed 為 `NONCE_REPLAYED`。Nonce scope 必須包含 sender、receiver、keyId、nonce，同一 scope concurrent request 至多一個成功。Verification context 必須注入 `verificationTime`、1–300 秒的 `maxClockSkewSeconds`、expected sender/receiver/keyId、nonce claim verifier 與 signature verifier。超出 clock skew 回傳 `SIGNATURE_EXPIRED`；nonce 已使用回傳 `NONCE_REPLAYED`；operation/context 不符回傳 `SIGNATURE_CONTEXT_MISMATCH`。

這仍是 injected verifier contract；沒有 production key vault、real secret resolver、real HMAC signing service、network call、`process.env` 或 `Date.now()`。Production adapter 必須以 durable store 的 unique constraint 或 compare-and-set/等價原子操作實作 nonce claim；本 pure TypeScript contract 不新增 DB、Redis、credential 或 persistence。

## 9. Public HTTPS URL policy

Evidence locator 只做 syntax/policy guard。它要求 public HTTPS、預設 443、無 credentials、無 fragment，並使用 `URLSearchParams` 讀取 decoded query parameter names；因此 `%74oken`、`api%5Fkey` 等 encoded credential keys 也會被拒絕。它不只對 raw `url.search` 做 regex。

拒絕範圍包括 localhost、single-label/local/internal/onion suffix、HTTP/FTP/file/data/javascript scheme、private、loopback、link-local、CGNAT、benchmark、reserved、multicast、IPv4 documentation blocks `198.51.100.0/24`、`192.0.2.0/24`、`203.0.113.0/24`，以及 IPv6 `::/128`、`::1/128`、`fc00::/7`、`fe80::/10`、`100::/64`、`2001:db8::/32` 與 IPv4-mapped special addresses。

此 guard 不做 DNS resolution，也沒有 network request。正式 connector 仍需要 DNS pinning、egress allowlist、redirect revalidation 與完整 SSRF 防護；通過本 policy 不代表 URL 已可信、可達或已被抓取。

## 10. Fixed reason taxonomy

V1 使用 bounded reason codes，包括 `INVALID_PROTOCOL_VERSION`、`INVALID_INPUT`、`UNKNOWN_FIELD`、`LIMIT_EXCEEDED`、`INVALID_HASH`、`INVALID_TIMESTAMP`、`INVALID_PUBLIC_URL`、`PRIVATE_OR_SPECIAL_TARGET`、`INVALID_OPAQUE_IDENTIFIER`、`UNKNOWN_STATE`、`REQUEST_FINGERPRINT_MISMATCH`、`IDEMPOTENCY_COLLISION`、`IDENTITY_MISMATCH`、`EVIDENCE_SNAPSHOT_MISMATCH`、`BRIEF_FINGERPRINT_MISMATCH`、`CITATION_OUTSIDE_APPROVED_EVIDENCE`、`APPLIED_RULE_OUTSIDE_SELECTION`、`PROVIDER_PROVENANCE_MISSING`、`INVALID_STATUS_TRANSITION`、`UNTRUSTED_PUBLISHED_RESULT`、`EVIDENCE_CHUNK_HASH_MISMATCH`、`DUPLICATE_EVIDENCE_IDENTITY`、`DUPLICATE_IDENTIFIER`、`REQUIRED_EVIDENCE_MISSING`、`REQUIRED_RULE_MISSING`、`CONTENT_HASH_MISMATCH`、`RESPONSE_TIME_INVALID`、`UNTRUSTED_DELIVERY_STATE`、`SIGNATURE_CONTEXT_MISMATCH`、`SIGNATURE_EXPIRED` 與 `NONCE_REPLAYED`。

## 11. Fixtures、測試與限制聲明

Golden fixtures 使用 synthetic IDs、lowercase hashes、public example URLs、approved evidence metadata 與 non-secret provider labels。`tests/geoflow-integration-contract.test.ts` 目前包含 **378 個 targeted public-function tests**，其中保留原有 332 項安全意圖並新增本輪的 async signature→atomic nonce claim order/concurrency、所有 response family 時間與 retry bounds、previousResponse stored-state lineage/replay fingerprint、all-family article identity、雙 machine retry vocabulary 與 duplicate fail-closed tests。測試覆蓋 brief normalization/fingerprints、revision lineage、evidence hash/duplicate/prerequisite、canonicalization、idempotency、三種 response discriminator、artifact exact bytes/hash、capability-result consistency、status mapping/combined transitions、candidate lineage、fixed signing envelope、clock skew、nonce replay、decoded credential query keys、IPv4/IPv6 special ranges 與不回傳 raw sensitive metadata 等 adversarial safety intent。

本模組沒有宣稱 Qwen 或其他 provider 被呼叫、沒有宣稱產生高品質文章、沒有宣稱 GEOFlow runtime 已接通、沒有宣稱 client website 已發布，也沒有宣稱排名、流量、轉換或 ROI 改善。它只是供未來 connector implementation 使用的 deterministic internal contract。

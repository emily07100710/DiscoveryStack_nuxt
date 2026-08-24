# DiscoveryStack Governed Delivery Automation Engine V1

## 定位與範圍

DiscoveryStack Governed Delivery Automation Engine V1 是一個 **純 server-side、離線、同步、deterministic、fail-closed 的決策與 metadata 核心**，為未來 GEOFlow delivery 流程提供可驗證的 eligibility、target safety、完整 identity、idempotency、command planning、failure classification 與狀態轉換規則。

本版本不是 delivery executor。它不會執行 WordPress、CMS、HTTP、webhook、DNS、外部 API 或任何其他網路操作，也不會建立排程工作、背景 worker、queue、資料庫 migration 或 provider integration。所有必要時間都必須由呼叫者注入帶有 timezone 的 `now`；核心不讀取系統時鐘、不使用 `Date.now()`、不依賴環境變數，也不產生或接收 credential、token、secret、private header、文章正文或外部 raw response。

> V1 只回答「在目前輸入與精確政策下，是否允許形成一筆 metadata-only delivery plan，以及狀態是否能合法轉換」。它不回答「是否已發布」，也不執行發布。

## 公開介面

實作位於 `server/delivery-automation/`，由 `index.ts` 提供受控的 public surface。主要介面如下：

| 介面 | 作用 | V1 行為 |
| --- | --- | --- |
| `validateDeliveryTarget` | 驗證 target origin、DNS/IP literal 與 endpoint path | 同步、純函式；拒絕不安全、超界或無法嚴格驗證的輸入 |
| `computeDeliveryIdempotencyKey` | 建立 canonical publication identity 的 SHA-256 key | 只使用完整 identity、engine version 與 content/evidence hash |
| `computeDeliveryResultFingerprint` | 建立 canonical success-result identity | 涵蓋 key、remote ID、published time、normalized URL/no-public-url、response fingerprint、canonical HTTP 2xx status 與 target origin |
| `evaluateDeliveryEligibility` | 評估 publication 是否可進入 delivery planning | 任一必要 gate 失敗即 blocked |
| `planDeliveryAttempt` | 建立 metadata-only command | 只支援 `wordpress_rest` 與 `generic_http`；從不回傳 delivered |
| `classifyDeliveryFailure` | 將已提供的結構化失敗資料分類 | 檢查 code/status 相容性，產生固定 retry/block 結果，不執行重試 |
| `reduceDeliveryAttemptState` | 套用合法的狀態轉換事件 | 非法、終止狀態或不完整證據一律 blocked；`retry_due`、failure 與 success 都必須綁定 persisted attempt proof |

V1 支援三種 adapter：`wordpress_rest`、`generic_http` 與 `manual_export`。前兩者最多只會形成未發送的 metadata command；`manual_export` 明確要求人工處理，不得由 autonomous planning path 形成 dispatch command。

## Eligibility gates

Eligibility 的輸入必須同時包含已驗證 target、已核准 publication metadata，以及注入的 timezone-bearing `now`。實作會對未知、缺欄位、錯誤型別、不精確 policy version 與不一致資料採取 fail-closed 行為，而不是猜測預設值。

| Gate | 必要條件 | 失敗結果 |
| --- | --- | --- |
| Draft | draft stage 必須為 `optimized` | `INVALID_INPUT` 或 blocked |
| Review | review decision 必須為 `approved_for_delivery` | blocked |
| Risk | risk gate status 必須為 `passed` | blocked |
| Target status | target 必須為 `active` | `TARGET_NOT_ACTIVE` |
| Credential flag | server-side credential configured flag 必須為 true | `CREDENTIAL_NOT_CONFIGURED` |
| Owner scope | target 與 publication owner scope 必須完全相同且為 opaque ID | `OWNER_SCOPE_MISMATCH` 或 blocked |
| Adapter | 必須是 V1 支援的 autonomous adapter | `UNSUPPORTED_ADAPTER`；manual export 為 `MANUAL_EXPORT_REQUIRES_HUMAN` |
| Content type | content type 必須在 target normalized allowlist | `CONTENT_TYPE_NOT_ALLOWED` |
| Language | language 必須在 target normalized allowlist | `LANGUAGE_NOT_ALLOWED` |
| Payload size | content byte length 必須是非負 safe integer，且不得超過 target limit | `CONTENT_TOO_LARGE` 或 blocked |
| Hashes | content 與 evidence snapshot 必須是有效 SHA-256 | `INVALID_SHA256` |
| Schedule | scheduled time 必須為有效 timezone-bearing timestamp，且不得晚於 injected now | `INVALID_TIMESTAMP` 或 `SCHEDULED_IN_FUTURE` |

Target 的 `policyVersion` 必須精確等於 `delivery-policy-v1`；missing、empty、大小寫差異、前後空白、`v0`、`v2`、`default` 與 `latest` 都回傳 `POLICY_VERSION_MISMATCH`。Eligibility 與 planning 不會 fallback 到 current/latest policy。

## Target 與 endpoint 安全

Target guard 只進行本地字串、URL、IP literal 與 path 分析，不做 DNS lookup，不連線，不發送探測請求。origin 必須是 HTTPS、不得帶 userinfo、query、fragment 或不受允許的 port；hostname 必須是符合 DNS label 規則的 public hostname，或是明確可判定的 public IPv4 literal。loopback、private、link-local、metadata service、broadcast、multicast、unspecified、documentation、benchmarking、transition、NAT64、mapped 與其他 reserved IPv4/IPv6 範圍都會被拒絕。

IPv6 特殊範圍採 fail-closed，包括完整 `0100:0000:0000:0000::/64`、IPv4-mapped IPv6、`64:ff9b::/96`、`64:ff9b:1::/48`、`2001::/32` Teredo、`2001:2::/48` benchmarking、`2001:10::/28` ORCHID、`2001:20::/28` ORCHIDv2、`2002::/16` 6to4、`2001:db8::/32` documentation、`fc00::/7`、`fe80::/10` 與 `ff00::/8`。`100::`、`100::1`、`100::ffff` 及同一 `/64` 內任意後四個 words 都會被拒絕。

Endpoint path 必須是明確的絕對 path，且不得包含 query、fragment、CRLF、NUL、encoded slash、encoded backslash、dot-segment traversal、double-encoded traversal、double-slash network path 或其他會改變實際路由語意的模糊表示。target 的 normalized origin、normalized allowlists 與 normalized endpoint path 會寫入 metadata command，供未來真正 executor 在自己的邊界重新驗證；command 內已明確標記 `executor_must_revalidate`。

## Opaque identity 與 canonical identity

所有 identity 欄位都必須先通過固定 opaque identifier validator。適用欄位包括 `targetId`、`ownerScopeKey`、`scheduleEntryId`、`productionPlanId`、`jobId`、`draftId`、`reviewId`、`scheduleKey` 與 `remoteContentId`。一般欄位長度為 1 至 128，`scheduleKey` 最長 256；只允許英數、底線、連字號、冒號與句點。空白、CR/LF/NUL、斜線、反斜線、`@`、URL、email、Bearer、token、secret、password、credential 與完整文章片段都會 blocked，輸入不會先 trim 後偷偷接受。

`computeDeliveryIdempotencyKey` 的 canonical payload 固定包含 engine version、owner scope、target ID、adapter、schedule entry、schedule key、production plan、job、draft/version、review、evidence snapshot hash 與 content hash。未知 body、query、credential 或其他欄位既不會影響 key，也不會被納入 command。每一個 hash 都必須是 64 字元 SHA-256；輸入無法被安全 canonicalize 時不產生弱 key。

`planDeliveryAttempt` 先完成 target validation、publication validation 與 idempotency key 計算，再驗證 attempt history。每筆 history 與 prior delivery record 都必須保留並比對完整 identity。相同 key 下任何一個 identity 欄位不同都回 `IDEMPOTENCY_COLLISION`；完整相同才回 `DUPLICATE_PUBLICATION`。

## Retry timing 與 attempt evidence

V1 固定最多五次 delivery attempts，沒有 jitter，沒有隨機因素。每筆 `DeliveryAttemptRecord` 至少要有 `attemptNumber`、`state`、`occurredAt`、`idempotencyKey`、failure evidence 及必要的 `retryEligibleAt`。attempt number 必須從 1 開始連續遞增；timestamps 必須帶 timezone、依序不倒退且不得晚於 injected now；所有 history key 必須等於目前 publication 計算出的完整 key。

| Attempt | 固定 policy delay |
| ---: | ---: |
| 1 | 60 秒 |
| 2 | 300 秒 |
| 3 | 1,800 秒 |
| 4 | 7,200 秒 |
| 5 | 0 秒，達到上限後不再 retry |

空 history 只允許建立 attempt 1。非空 history 只有最後狀態為 `retry_wait` 才能建立下一次 command；最後狀態為 `scheduled`、`eligible`、`dispatch_planned`、任何 terminal state 或 `cancelled` 都不能直接建立下一次 command。`dispatch_planned` 明確回 `ATTEMPT_STILL_IN_FLIGHT`，terminal state 回 `TERMINAL_STATE`。

對 retryable failure，核心會以 `classifyDeliveryFailure` 重新計算 policy delay，精確驗證 `retryEligibleAt = occurredAt + delaySeconds`，並保存 canonical UTC ISO。`now < retryEligibleAt` 回 `RETRY_NOT_DUE`；只有 `now >= retryEligibleAt` 才能產生下一次 command，而且 `command.eligibleAt` 是實際計算出的 retry eligibility time，不是無條件的 current now。`retry_due` 不接受 caller 自行捏造的 deadline、key 或 attempt number；它必須重新驗證 bounded persisted history 的最後一筆 retry_wait、failure evidence、canonical key、連續 attempt number 與重新計算的 deadline。history 的 retry evidence、key、時間順序或 retry deadline 不一致時，回 `ATTEMPT_RETRY_EVIDENCE_INVALID` 或 `ATTEMPT_IDEMPOTENCY_MISMATCH`，不會模糊成一般 input error。

## Failure、retry 與狀態政策

暫時性 timeout、connection reset、408、429 與明確允許的 5xx 可被分類為 `retry_wait`；HTTP 409 只有 `confirmedSameIdempotentDelivery: true` 且該證據被保存於 `DeliveryAttemptRecord` 時才可重試。有效的 429 `retryAfterSeconds` 必須為 1 至 86,400 秒，且只有 429 可以提供；最終 delay 是 `max(policy delay, remote delay)`。無效 retry-after、code/status 矛盾或型別不正確時，結果為 `status=blocked`、`code=INVALID_INPUT`、`nextState=blocked`、`retryable=false`。

允許的 code/status 組合只有 timeout 或 connection reset 且沒有 HTTP status、`http_408 + 408`、`http_409 + 409`、`http_429 + 429`、`http_5xx + 500–599`、`http_400 + 400`、`http_401 + 401`、`http_403 + 403` 與 `http_404 + 404`。401、403、credential missing、revoked target、policy violation、invalid remote identity、content hash mismatch 與 evidence hash mismatch 永遠不得 retry，會進入 blocked；timeout 或 connection reset 不得覆蓋這些安全結果。failure event 同樣必須綁定 persisted 最新 `dispatch_planned` attempt，不能只依賴 caller 的 current-state 字串。

合法狀態集合是 `scheduled`、`eligible`、`dispatch_planned`、`retry_wait`、`delivered`、`permanent_failed`、`blocked` 與 `cancelled`。reducer 只接受 policy catalog 定義的 transition。`retry_wait -> dispatch_planned` 只能透過帶有 persisted `attempts`、`now`、`retryEligibleAt`、`expectedIdempotencyKey` 與 2–5 safe integer `attemptNumber` 的 `retry_due` 事件；缺少任何欄位、時間尚未到、persisted latest attempt 不符或 key malformed 都 blocked。failure/success 也必須證明 persisted 最新 attempt 是同一 key、同一 attempt number 且狀態為 `dispatch_planned`；terminal state 不得再被一般事件改寫。

## Metadata-only planning

`planDeliveryAttempt` 會先重新執行 eligibility，再計算完整 idempotency key、驗證 bounded attempt history 與 prior delivery identity。只有未達 attempt cap、沒有 terminal/in-flight history、沒有相同 identity 的既有 delivery record，且 retry deadline 已到時，才會回傳 `dispatch_planned` 與 `DeliveryCommandMetadata`。

command 只包含下列可追溯 metadata：command version、target ID、adapter、normalized target origin、normalized endpoint path、publication identity、content hash、evidence snapshot hash、idempotency key、attempt number、實際 `eligibleAt`、固定 timeout class，以及限制標記。它不包含文章 body、credential、token、secret、private headers、raw response 或任何可以直接執行外部請求的 callable。

`dispatch_planned` 代表「通過 V1 的 planning gates 並產生待重新驗證的 metadata」，**永遠不等於 `delivered`**。V1 沒有 executor，也沒有把 planned command 轉成外部寫入的路徑；外部 delivery 在本版本中保持 `NONE`。

## Success result 與完整 replay identity

未來 executor 若在自身邊界取得外部結果，送回 V1 的只能是結構化、最小化的 result metadata。success event 必須同時提供 timezone-bearing `now`、`attemptStartedAt`、`expectedIdempotencyKey`、`targetOrigin`、persisted `attempts` 與 current `attemptNumber`。result 必須有相同 idempotency key、opaque `remoteContentId`、有效 `publishedAt`、`noPublicUrl` 布林值、64 字元 SHA-256 `responseFingerprint` 與唯一 canonical `httpStatus`；`httpStatus` 必須是 safe integer 200–299，不能由 event 另帶第二份 status。若 `noPublicUrl=false` 必須有 URL，若仍提供 URL 則即使 `noPublicUrl=true` 也必須合法。

所有 timezone-bearing timestamps 都先經過 strict calendar parser：格式、month/day、leap year、hour/minute/second 與 offset component 必須逐項合法，不存在的日期、leap second 與 malformed offset 都拒絕；通過後才 canonicalize 成 UTC ISO。Success time gate 強制 `attemptStartedAt <= publishedAt <= now`，並回傳專用 `PUBLISHED_AT_BEFORE_ATTEMPT` 或 `PUBLISHED_AT_IN_FUTURE`。target origin 會重新經過 target validator；remote URL 必須是 HTTPS、無 userinfo/query/fragment、無不允許的 port、無 private/special-use host，且 normalized origin 必須與 target origin 完全相同。

第一次成功 transition 會回傳 deterministic `deliveryResultFingerprint`。fingerprint 至少涵蓋 idempotency key、remote content ID、canonical UTC `publishedAt`、normalized remote URL 或 no-public-url state、response fingerprint、canonical HTTP status 與 target origin。已是 `delivered` 時，replay event 必須攜帶 `priorDeliveryResultFingerprint`；只有新 fingerprint 完全相同才允許 `delivered -> delivered`。remoteContentId、remoteUrl、publishedAt、responseFingerprint、noPublicUrl、targetOrigin 或 prior fingerprint 任一不同或缺漏，都回 `REMOTE_IDENTITY_COLLISION`，不得只比較 remoteContentId。

## Fail-closed 與純度保證

核心函式沒有系統時鐘、外部 I/O、DNS、socket、HTTP client、process environment access、資料庫操作、webhook handler 或 background execution。所有決策輸入都透過函式參數傳入；相同輸入必須產生相同輸出。未知 adapter、異常 URL、混合大小寫或不完整 hash、proxy object、array、額外敏感欄位與 malformed nested values 都不能讓核心進入允許路徑。正式 implementation 也不包含 HTTP/networking library 或 credential transport primitive。

這個邊界意味著：V1 可以被 server-side workflow 呼叫來做 preflight decision 或 metadata ledger preparation，但不能單獨完成 delivery。若未來要增加 executor，必須在另一個明確受控的層實作，並在呼叫前重新套用 target、authorization、idempotency、result 與 state gates；不得把本核心的 `dispatch_planned` 重新解釋為已發送或已發布。

## 測試與驗證保證

唯一正式 targeted suite 位於 `tests/governed-delivery-automation-engine.test.ts`，包含 360 項 deterministic offline tests，涵蓋 adapter、eligibility、target/path safety、完整 IPv4/IPv6 reserved range、exact policy version、opaque identity、idempotency、metadata-only command contents、duplicate/collision、attempt cap、retry deadline、persisted retry_due proof、409 confirmation persistence、invalid retry-after、conflicting failure evidence、401/403 non-retry、state transitions、strict calendar timestamps、canonical HTTP 2xx success proof、success time bounds、result fingerprint replay、malformed/proxy input 與 static forbidden-token scan。測試只使用 synthetic fixtures 與注入的 `now`，不建立外部 mock server，不發送任何真正 delivery request。

本版本交付前必須通過 frozen-lockfile install、typecheck、V1 targeted tests、既有 SEO/GEO regression tests、production build、diff whitespace check、restricted-path audit、implementation no-network scan、secret/artifact scan 與 symlink scan。Full Vitest 與 migration runtime validation 不屬於此引擎的 delivery proof；若本任務指令要求不執行，報告必須明確標示 `NOT RUN`，不可用 targeted pass 代稱全套通過。

> V1 的最終限制：它是 **decision core / metadata only**，不是已啟用的 delivery executor。任何外部發布、WordPress/CMS 寫入、HTTP request、webhook、部署與 production migration 都保持未執行。

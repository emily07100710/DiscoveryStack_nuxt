# DiscoveryStack Governed Delivery Automation Engine V1

## 定位與範圍

DiscoveryStack Governed Delivery Automation Engine V1 是一個 **純 server-side、離線、同步、deterministic、fail-closed 的決策與 metadata 核心**，為未來 GEOFlow delivery 流程提供可驗證的 eligibility、target safety、idempotency、command planning、failure classification 與狀態轉換規則。

本版本不是 delivery executor。它不會執行 WordPress、CMS、HTTP、webhook、DNS、外部 API 或任何其他網路操作，也不會建立排程工作、背景 worker、queue、資料庫 migration 或 provider integration。所有必要時間都必須由呼叫者注入帶有 timezone 的 `now`；核心不讀取系統時鐘，不依賴環境變數，也不產生或接收 credential、token、secret、private header、文章正文或外部 raw response。

> V1 只回答「在目前輸入與政策下，是否允許形成一筆 metadata-only delivery plan，以及狀態是否能合法轉換」。它不回答「是否已發布」，也不執行發布。

## 公開介面

實作位於 `server/delivery-automation/`，由 `index.ts` 提供受控的 public surface。主要介面如下：

| 介面 | 作用 | V1 行為 |
| --- | --- | --- |
| `validateDeliveryTarget` | 驗證 target origin 與 endpoint path | 同步、純函式；拒絕不安全或無法嚴格驗證的輸入 |
| `computeDeliveryIdempotencyKey` | 建立 canonical publication identity 的 SHA-256 key | 只使用明確 identity、engine version 與 content/evidence hash |
| `evaluateDeliveryEligibility` | 評估 publication 是否可進入 delivery planning | 任一必要 gate 失敗即 blocked |
| `planDeliveryAttempt` | 建立 metadata-only command | 只支援 `wordpress_rest` 與 `generic_http`；從不回傳 delivered |
| `classifyDeliveryFailure` | 將已提供的結構化失敗資料分類 | 產生固定 retry/block 結果，不執行重試 |
| `reduceDeliveryAttemptState` | 套用合法的狀態轉換事件 | 非法、終止狀態或不完整證據一律 blocked |

V1 支援三種 adapter：`wordpress_rest`、`generic_http` 與 `manual_export`。前兩者最多只會形成未發送的 metadata command；`manual_export` 明確要求人工處理，不得由 autonomous planning path 形成 dispatch command。

## Eligibility gates

Eligibility 的輸入必須同時包含已驗證 target、已核准 publication metadata，以及注入的 timezone-bearing `now`。實作會對未知、缺欄位、錯誤型別與不一致資料採取 fail-closed 行為，而不是猜測預設值。

| Gate | 必要條件 | 失敗結果 |
| --- | --- | --- |
| Draft | draft stage 必須為 `optimized` | `INVALID_INPUT` 或 blocked |
| Review | review decision 必須為 `approved_for_delivery` | blocked |
| Risk | risk gate status 必須為 `passed` | blocked |
| Target status | target 必須為 `active` | `TARGET_NOT_ACTIVE` |
| Credential flag | server-side credential configured flag 必須為 true | `CREDENTIAL_NOT_CONFIGURED` |
| Owner scope | target 與 publication owner scope 必須完全相同 | `OWNER_SCOPE_MISMATCH` |
| Adapter | 必須是 V1 支援的 autonomous adapter | `UNSUPPORTED_ADAPTER`；manual export 為 `MANUAL_EXPORT_REQUIRES_HUMAN` |
| Content type | content type 必須在 target allowlist | `CONTENT_TYPE_NOT_ALLOWED` |
| Language | language 必須在 target allowlist | `LANGUAGE_NOT_ALLOWED` |
| Payload size | content byte length 不得超過 target limit | `CONTENT_TOO_LARGE` |
| Hashes | content 與 evidence snapshot 必須是有效 SHA-256 | `INVALID_SHA256` |
| Schedule | scheduled time 必須為有效 timezone-bearing timestamp，且不得晚於 injected now | `INVALID_TIMESTAMP` 或 `SCHEDULED_IN_FUTURE` |

Eligibility 只會使用 metadata 與 hash，不需要文章正文。內容長度由呼叫者提供並且必須是有限的非負整數；輸入資料若不能明確證明符合 policy，就不會被視為 eligible。

## Target 與 endpoint 安全

Target guard 只進行本地字串、URL、IP literal 與 path 分析，不做 DNS lookup，不連線，不發送探測請求。origin 必須是 HTTPS、不得帶 userinfo、query、fragment 或不受允許的 port；hostname 必須可被判定為 public hostname。loopback、private、link-local、保留用途、metadata service、broadcast、multicast、unspecified 與其他 reserved IPv4/IPv6 範圍都會被拒絕。

Endpoint path 必須是明確的絕對 path，且不得包含 query、fragment、CRLF、控制字元、encoded slash、encoded backslash、dot-segment traversal、雙重編碼 traversal 或其他會改變實際路由語意的模糊表示。target 的 normalized origin 與 normalized endpoint path 會寫入 metadata command，供未來真正 executor 在自己的邊界重新驗證；command 內已明確標記 `executor_must_revalidate`。

## Metadata-only planning

`planDeliveryAttempt` 會先重新執行 eligibility，再驗證 attempt history 與 prior delivery identity。只有未達 attempt cap、沒有 terminal history、沒有相同 identity 的既有 delivery record 時，才會回傳 `dispatch_planned` 與 `DeliveryCommandMetadata`。

command 只包含下列可追溯 metadata：command version、target ID、adapter、normalized target origin、normalized endpoint path、publication identity、content hash、evidence snapshot hash、idempotency key、attempt number、eligibleAt、固定 timeout class，以及限制標記。它不包含文章 body、credential、token、secret、private headers、raw response 或任何可以直接執行外部請求的 callable。

`dispatch_planned` 代表「通過 V1 的 planning gates 並產生待重新驗證的 metadata」，**永遠不等於 `delivered`**。V1 沒有 executor，也沒有把 planned command 轉成外部寫入的路徑；外部 delivery 在本版本中保持 `NONE`。

## Idempotency

Idempotency key 由固定的 engine version 與 canonical payload 建立。payload 僅包含 owner scope、target、adapter、schedule identity、job、draft/version、review、evidence hash 與 content hash。任意額外 body、query、credential 或未知欄位都不會影響 key，也不會被納入可執行 metadata。

所有 identity 欄位與兩個 SHA-256 hash 都必須先通過格式及型別驗證；無法 canonicalize 的資料會回傳 blocked，而不是產生弱 key。planning 遇到相同 key 時會進行 publication identity 比對：相同 identity 視為 duplicate publication，矛盾 identity 視為 `IDEMPOTENCY_COLLISION`。這使 retry 與 replay 不會因為呼叫者任意改動未授權欄位而繞過去重。

## Failure、retry 與狀態政策

V1 固定最多五次 delivery attempts，沒有 jitter，沒有隨機因素，retry delay 由 attempt number 決定：

| Attempt | 固定 policy delay |
| ---: | ---: |
| 1 | 60 秒 |
| 2 | 300 秒 |
| 3 | 1,800 秒 |
| 4 | 7,200 秒 |
| 5 | 0 秒，達到上限後不再 retry |

暫時性 timeout、connection reset、408、429、部分 5xx 與其他明確允許的 temporary failure 可被分類為 `retry_wait`。有效的 429 `retryAfterSeconds` 必須為 1 至 86,400 秒，並取 `max(policy delay, remote delay)`；無效的 retry-after 輸入採 fail-closed blocked，而不是忽略它或猜測等待時間。401、403、credential missing、revoked target、policy violation、invalid remote identity、hash mismatch 與其他 configuration failure 不會 retry，並進入 blocked。attempt number、HTTP status 或 failure input 不合法時也會 blocked。

合法狀態集合為 `scheduled`、`eligible`、`dispatch_planned`、`retry_wait`、`delivered`、`permanent_failed`、`blocked` 與 `cancelled`。reducer 只接受 policy catalog 定義的 transition；terminal state 不得再被一般事件改寫。唯一的 terminal replay 例外是：目前已是 `delivered`，事件是 success，idempotency key、remote content ID、published result identity 與既有記錄完全一致，此時回傳明確的 `delivered->delivered` idempotent replay。不同 remote identity 或其他 terminal transition 都會 blocked。

## Result validation

未來 executor 若在自身邊界取得外部結果，送回 V1 的只能是結構化、最小化的 result metadata。success result 必須同時通過以下檢查：idempotency key 與預期 key 完全相同；存在 remote content ID；`publishedAt` 是有效時間戳；存在 `remoteUrl` 或明確的 `noPublicUrl: true`；存在 response fingerprint；若提供 remote URL，則必須是 HTTPS、不得含 userinfo/query/fragment，且 hostname 必須與原 target origin hostname 完全相同。

V1 不接受 raw response，也不接受只表示 HTTP 2xx 的模糊成功。缺少 remote content ID、錯誤 published time、remote identity 不一致、fingerprint 缺漏、URL host 不相符或 idempotency mismatch 都會阻止 `delivered` transition。`noPublicUrl` 只表示結果沒有公開 URL，不能省略 remote content ID、publishedAt 或 response fingerprint。

## Fail-closed 與純度保證

核心函式沒有系統時鐘、外部 I/O、DNS、socket、HTTP client、process environment access、資料庫操作、webhook handler 或 background execution。所有決策輸入都透過函式參數傳入；相同輸入必須產生相同輸出。未知 adapter、異常 URL、混合大小寫或不完整 hash、proxy object、array、額外敏感欄位與 malformed nested values 都不能讓核心進入允許路徑。

這個邊界意味著：V1 可以被 server-side workflow 呼叫來做 preflight decision 或 metadata ledger preparation，但不能單獨完成 delivery。若未來要增加 executor，必須在另一個明確受控的層實作，並在呼叫前重新套用 target、authorization、idempotency、result 與 state gates；不得把本核心的 `dispatch_planned` 重新解釋為已發送或已發布。

## 測試與驗證保證

V1 的 synthetic offline suite 覆蓋 adapter、eligibility、target/path safety、IPv4/IPv6 reserved range、idempotency、metadata-only command contents、duplicate/collision、attempt cap、固定 retry policy、invalid retry-after、401/403 non-retry、state transitions、terminal replay、remote result identity、malformed input、proxy input 與 static forbidden-token scan。測試只使用 deterministic fixtures 與注入的 `now`，不建立外部 mock server，不發送任何真正 delivery request。

本版本交付前必須通過 typecheck、V1 targeted tests、既有 SEO/GEO regression tests、production build、diff whitespace check、restricted-path audit、implementation no-network scan、secret/artifact scan 與 symlink scan。Full Vitest 與 migration runtime validation 不屬於此引擎的 delivery proof；若本任務指令要求不執行，報告必須明確標示 `NOT RUN`，不可用 targeted pass 代稱全套通過。

> V1 的最終限制：它是 **decision core / metadata only**，不是已啟用的 delivery executor。任何外部發布、WordPress/CMS 寫入、HTTP request、webhook、部署與 production migration 都保持未執行。

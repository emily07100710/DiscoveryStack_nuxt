# First-party Astro/Nuxt Site Publishing Runtime V1

## 定位與邊界

First-party Site Publishing Runtime V1 是 server-side publishing runtime 的 **planning 與 execution boundary**。它只接受已核准、已通過 risk gate 的 optimized publication，建立 deterministic Markdown artifact 與 metadata-only command，並在明確的 `execute` 模式下，透過可注入的 server-side adapter dependency 執行第一方 transport。它不是 WordPress publisher，也不是 generic HTTP executor；V1 的實際 adapters 僅為 `first_party_git` 與 `first_party_signed_api`。

本次驗證不對 GitHub Contents API、客戶網站或任何外部 target 發出真實 request。所有 executor tests 只使用 injected mocked fetch。正式部署仍必須由 runtime wiring 提供受控 fetch、credential resolver、nonce provider 與 target registry；本模組不會由前端提供 secret、不會啟動背景工作，也不會自行排程。

## 支援 contract

`FirstPartyPublishTarget` 必須包含 target identity、owner scope、`astro | nuxt` framework、`first_party_git | first_party_signed_api` transport、target origin、content root、branch、transport-specific repository/endpoint fields、opaque credential reference、active status、content/language allowlists、payload limit 與 `executionEnabled`。credential reference 只描述 server-side secret 的 lookup key；credential value 不會進入 command、provenance、result、error 或 log。

`ApprovedFirstPartyPublication` 必須包含完整 publication identity、optimized draft stage、`approved_for_delivery` review decision、passed risk gate、canonical evidence/content SHA-256、title/body/slug/content metadata、schedule timestamp、authority sources 與 applied rules。未知欄位、null、array、getter/proxy 讀取錯誤與 malformed values 都會 fail closed。

## Deterministic artifact

Artifact builder 會以固定順序產生 frontmatter：`title`、`slug`、`language`、`contentType`、`publicationId`、`scheduleEntryId`、`productionPlanId`、`draftId`、`reviewId`、`evidenceSnapshotHash`、`contentHash`、`publishedAt`、`authoritySourceIds`、`appliedRuleIds`。Scalar 使用 JSON quoting，list 使用 deterministic JSON list，避免 frontmatter injection。body 的 UTF-8 SHA-256 必須與 approved `contentHash` 完全相等；系統不會自行修正文體後沿用舊 hash。

預設 path 為 `content/zh-hant/articles/{slug}.md` 或 `content/en/articles/{slug}.md`，其他 language 使用其已驗證的 language segment。slug 只允許小寫 ASCII、數字與連字號；content root、path segments、percent encoding、斜線、反斜線與 traversal 均經 bounded validation。artifact fingerprint 涵蓋 path、frontmatter、body、body bytes 與完整 publication identity。

## Target guard

Target guard 只允許 HTTPS。Git transport 僅接受 exact origin `https://api.github.com`，不接受任意 Git provider 或 GitHub Enterprise；repository owner/name、branch、content root、endpoint field 會分別驗證。Signed API transport 的 origin 必須是 public HTTPS exact origin，endpoint path 固定為 `/api/first-party/content-ingest`，不可由 publication 或前端任意改寫。

Target guard 會拒絕 HTTP、localhost、private/loopback/link-local/reserved/special-use IPv4/IPv6、特殊 DNS suffix、malformed DNS labels、URL credentials、query、fragment、非允許 port、paused/revoked target、missing credential reference、unknown framework/transport 與 unknown keys；executor 另行拒絕 disabled execution 與 owner mismatch。此檢查是 deterministic syntax/policy guard，不執行 DNS lookup。

## Plan 與 execute

`planFirstPartyPublication()` 是 pure metadata planner。它重新驗證 target、publication approval、owner scope、allowlists、strict timezone-bearing schedule timestamp、content/evidence hashes、artifact path、artifact size 與 identity key。輸出 command、artifact、完整 provenance、deterministic idempotency key 與限制標記；command 不包含 body、credential、token、secret、authorization header 或 raw response。

`executeFirstPartyPublication()` 需要明確的 `mode: 'execute'`、active target、`executionEnabled === true`、approved optimized publication、passed risk gate、valid hashes、成功的 injected server credential resolver、injected fetch 與尚未被 terminal delivered 的 execution boundary。Signed API 還必須明確注入 nonce provider；runtime 不提供固定或可預測的 fallback nonce。任何前置 gate 失敗時 fetch 呼叫次數必須為零。

`mode: 'dry_run'` 只回傳 request preview metadata，不解析 credential、不呼叫 fetch、不包含完整 body、Authorization 或 secret。`dispatch_planned` 或 planned metadata 不能被宣稱為 delivered；只有 trusted adapter response 通過 identity validation 才會回傳 delivered。

## GitHub Contents adapter

Git adapter 僅執行單一 canonical content path 的 GET 與 PUT。GET 以 `ref` query 選定 branch；PUT 依 GitHub Contents contract 將 branch 放在 request body，不在 write URL 加入 `ref` query。建立檔案時先確認 404 再 PUT；更新檔案時必須使用 GET 回傳的 remote blob SHA。branch 只能來自已驗證 target，commit message 僅使用 deterministic publication identifier 與 content hash prefix，不包含客戶全文。

Authorization header 只在 adapter 最後 request boundary 建構。401/403 回傳 credential/policy failure；409/422 回傳 conflict，不盲目重試；429/5xx 可由既有 delivery automation 分類為 retryable。3xx redirect 永不跟隨。GET/PUT response 必須以 canonical GitHub content URL 或完整 repository echo 綁定 repository/path，並驗證 blob SHA 與 commit SHA；branch 由 GET request query 與 PUT body 綁定，因 GitHub 的正式 response schema 不回傳 branch。HTTP 2xx 本身不等於可信成功。

只有 leading canonical frontmatter 的 publication ID/content hash 相同，且 remote artifact bytes 與本次 deterministic artifact 完全一致時，才回傳 idempotent replay。正文內偽造的 metadata、重複或 malformed frontmatter、相同 publication ID 但不同 hash/bytes 都會回傳 identity collision 並 fail closed。Malformed JSON/base64/UTF-8、錯誤 repository/path、無效 SHA、timeout 與 network exception 都不會產生 delivered。

## Signed API adapter

Signed API 使用 HMAC-SHA256。canonical signature input 依固定 newline 順序綁定 command version、target ID、publication ID、idempotency key、content hash、evidence hash、artifact fingerprint、injected timestamp 與 injected nonce。request body 同樣包含 artifact 與 identity binding；header 只包含版本、publication、idempotency、timestamp、nonce 與 signature metadata，不含 Authorization header。

secret 只能由 injected server credential resolver 取得；nonce 只能由必要的 injected nonce provider 產生。timestamp 與可選的 serverNow 都先通過 strict timezone-bearing ISO parser，並以固定 bounded tolerance policy 比較；本 runtime 不讀取 system clock，receiver 仍必須在其端重新驗證時間窗、nonce、signature、body 與 replay policy。response 必須回傳並精確匹配 publication ID、content hash 與 opaque remote revision，任何 mismatch 都是 blocked 而不是 delivered。

兩個 adapter 在解析 credential 或發出 request 前，都會重新建立 canonical publication plan，並逐一比對 supplied command 與 artifact；direct adapter call 不能繞過 owner、approval、risk gate、schedule、target、hash、idempotency、artifact fingerprint 或 execution-enabled 邊界。

## Existing delivery automation compatibility

既有 delivery automation contract 保留 `wordpress_rest`、`generic_http` 與 `manual_export`，並新增 `first_party_git` 與 `first_party_signed_api` adapter values，以保持舊資料 compatibility。既有 legacy adapter values 在本 runtime 中只是 metadata compatibility；本模組沒有新增 WordPress executor 或 generic HTTP executor。既有 governed delivery tests 必須維持原有安全條件並獨立通過。

## 驗證保證與限制

本版本應以兩個 targeted test files 驗證 artifact、target guard、approval gates、dry-run zero-fetch、credential isolation、Git create/update/replay/collision/status handling、signed HMAC binding、response identity、timeout/network errors、unknown keys 與 malformed inputs。測試中的所有 external execution 都使用 mocked fetch；不做真實 GitHub Contents write、不做客戶網站 write。

尚未驗證真實 GitHub App credential、真實 HMAC receiver、production target registry、production deployment、remote concurrency semantics 或 GitHub API 的 live contract。任何 production wiring 都必須在 adapter boundary 重新驗證 target、credential、command、idempotency、request status 與 remote identity，並保留可追溯 execution audit。

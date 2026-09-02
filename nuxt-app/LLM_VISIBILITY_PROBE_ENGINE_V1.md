# LLM Visibility Probe Planning & Provider Observation Engine V1

## 定位與治理

Probe engine 是 server-side、deterministic、fail-closed 的 provider observation 核心，不是 consumer UI scraper。正式 runtime 已有 owner-only provider route、persistence 與 resumable benchmark orchestration；但所有 provider evidence 仍固定為 `provider_api_observation`、`verifiedByOwner=false`、`secondary_only`、`consumerSurfaceEquivalent=false`、`provider_api_not_consumer_surface`。它不代表搜尋排名、consumer UI 曝光、流量、轉換、營收或 ROI。

`server/llm-visibility-probes/index.ts` 是唯一 public barrel。所有 public entrypoint 以 `unknown` 為輸入，對 null、array、extra key、enumerable symbol、throwing getter、錯誤型別與 malformed lineage fail closed。Planner、plan validator、runner、adapter response 與 candidate 都維持 strict exact-key/lineage validation。Scope、target、prompt、window、metadata、citation 或 governance field tamper 會在 persistence 前 fail closed。

## Deterministic plan contract

`buildVisibilityProbePlan(input: unknown)` 只接受固定 owner scope、project identity、active query snapshots、provider targets、observation window、maximum 與 engine version。Provider V1 僅接受 `chatgpt`、`gemini`、`perplexity`；`google_ai_overview` 與 `manual_other` 不在此 automatic probe 範圍。

Planner 使用 `normalizeProbePlanInput()` 重新 normalization project、queries、targets、prompt hash、locale、identifier 與 bounds。active queries、active targets、brand aliases、competitors 與所有 order-insensitive collection 以明確 code-unit comparator canonical sorting；不使用 runtime locale sorting。相同語意而輸入排列不同時，plan fingerprint 與 probe ordering 完全一致。

`normalizeVisibilityProbePlan(value: unknown)` 是正式的 strict plan validator。Plan 只允許以下 exact keys：`status`、`engineVersion`、`ownerScopeKey`、`project`、`observationWindowKey`、`maximumProbes`、`providerTargets`、`probes`、`planFingerprint`、`limitationCode`。它重新 normalize project、targets 與 probes，不接受 TypeScript cast 作為信任邊界。Plan 必須是 `planned`、固定 engine version、固定 limitation code，probes 數量為 1–50 且不得超過 maximum；每個 target 必須 active、locale eligible、timeout/response byte 在上限內，且 provider/model/adapter identity 不得重複。

Planner 與 validator 共用 `buildCanonicalPlanBody()`。Plan fingerprint 由 canonical body 重新計算：

```text
expectedPlanFingerprint = canonicalFingerprint(canonicalPlanBody)
```

每個 probe 的 request fingerprint 由固定 identity、normalized prompt hash、engine version 計算，probe ID 由 `identityKey + requestFingerprint` 計算。Validator 重新計算並精確比對 `requestFingerprint`、`identityKey`、`probeId`、owner/project/query/locale/window、target identity、provenance 與治理欄位；任何 prompt、project、target、scope 或 lineage tamper 都在 adapter 呼叫前 blocked。它同時拒絕重複 request fingerprint、probe ID 與 identity key，以及空 probes plan。

## Identity and benchmark sampling

Engine identity is unchanged:

```text
provider | model | query | locale
```

`canonicalProbeIdentity` additionally fingerprints normalized prompt hash, engine version, owner/project scope, and `observationWindowKey`. A benchmark deliberately builds one one-probe plan for each query/target/repetition and assigns:

```text
benchmark:<benchmarkId>:sample:<k>
```

The same query/provider/model/locale therefore remains the same engine identity while each repetition receives a deterministic, mutually distinct request fingerprint. `PROBE_KEYS`, duplicate-combination rules, and the planner algorithm are not changed. The benchmark mother row is inserted first inside a transaction so its ID can be used while inserting every pending sample in that same transaction.

## Validated-plan analyzer

`analyzeProviderObservation(input: unknown)` 的正式輸入只有：

```ts
{
  plan: unknown,
  probeId: unknown,
  response: unknown,
}
```

Analyzer 先完整呼叫 `normalizeVisibilityProbePlan()`，再要求 probe ID 是 canonical lowercase SHA-256，從 validated plan 找到唯一 probe 與 active locale-eligible target。Project、provider target、plan fingerprint、owner scope 與 observation window 全部只能來自 validated plan/probe；caller 不可另外注入 project 或 target。

Response 也採 exact-key contract。Success response 只允許 `ok`、`provider`、`modelLabel`、`responseText`、`citationUrls`、`observedAt` 以及 bounded optional `providerRequestId`、`responseMetadata`、`citationDates`。Provider/model 必須與 validated target 精確一致；response text 受 UTF-8 byte ceiling；citation 只接受 canonical public HTTPS URL，去除 duplicate，拒絕 credentials、localhost、private/reserved IP 與 fragment；`citationDates` 最多 50 筆、必須能正規化為日期且只能引用 canonical citation list；metadata 的 unknown keys、symbol、getter exception 與不一致 token totals 都 blocked。

Candidate 的 lineage 必須保存 `planFingerprint`、`ownerScopeKey`、`projectId`、`queryId`、`provider`、`modelLabel`、`observationWindowKey` 與 `provenance.adapterKey/engineVersion`。`normalizeObservationCandidate()` 是 internal full validator，不在 public barrel 暴露，且不再 spread 未驗證 caller fields。Replay 與 completed result 都必須使用同一個完整 candidate validator。

所有 analyzer 成功 candidate 固定為：

```text
observationMode = provider_api_observation
verifiedByOwner = false
status = completed
metricEligibility = secondary_only
consumerSurfaceEquivalent = false
limitationCode = provider_api_not_consumer_surface
persistenceStatus = not_persisted_v1
```

Runtime persistence 會再次以 strict schema 驗證 candidate，並只把 persistence copy 標記為 `persisted_secondary_only`；它不會把 evidence 升級成 owner-verified 或 primary evidence。Candidate 不能通過既有 `ownerManualObservationImportSchema`；既有 primary metrics 仍維持 `metricBasis = manual_verified_v1`。

## Timestamp、Unicode 與 evidence contract

`observedAt` 必須是完整 timezone-bearing ISO datetime，僅接受 `Z` 或 `±HH:MM`，並拒絕 date-only、無 timezone、空字串、不存在 calendar date、Invalid Date 與非法 offset。合法 offset 會 canonicalize 到 UTC ISO，例如 `2026-08-24T08:00:00+08:00` 變為 `2026-08-24T00:00:00.000Z`；candidate validator 要求保存值已是 canonical UTC。

Brand/competitor analysis 使用保留原始大小寫的 NFKC、whitespace-normalized canonical surface，並以 Unicode case-insensitive matching 判斷提及。mention position 從 1 開始，單位是 Unicode code point；bounded excerpt 也從同一 canonical surface 以 `Array.from()` code-point slicing，避免 whitespace normalization、UTF-16 offset 與 excerpt 座標混用。測試包含品牌名稱前 400 個 emoji。

Evidence locator 使用完整 response hash，而非前 16 字元：

```text
`${provider}:${probeId}:${responseHash}`
```

因此 response hash 只有 suffix 不同時，locator 仍一定不同。Candidate 只保留 exact hash、bounded excerpt、derived mentions、canonical citations、bounded provider request reference、evidence locator、timestamp 與 safe metadata，不保存 raw response。

## Adapter success and citation dates

The success response required keys remain `ok`, provider/model, bounded response text, canonical citation URLs, and timezone-bearing `observedAt`. Optional exact keys are request ID, safe response metadata, and `citationDates: Record<url, ISO date>` bounded to 50 entries. `citationDates` is normalized and must reference returned citations. Analyzer carries it to the strictly validated observation candidate.

Perplexity maps documented `search_results[].{url,date}` only when the canonical URL is already present in the response citation list; invalid, duplicate, unlisted, or unparseable entries are omitted. Plain `citations` have no date. OpenAI and Gemini omit dates unless an actual dated provider field exists. A missing date is never invented.

## Atomic idempotency 與 bounded runner

`executeVisibilityProbeBatch(input: unknown)` 頂層只允許 `plan`、`adapters`、`idempotencyRegistry`、optional `concurrency` 與 optional `abortSignal`；extra credential-like key、symbol、getter 或 malformed object 都 fail closed。Runner 先完整 normalize plan，才接受 1–5 concurrency、最多 50 probes 與 exact adapter map。

Registry 是 injected atomic contract：

```ts
type IdempotencyClaimResult =
  | { status: 'acquired'; claimToken: string }
  | { status: 'replay'; record: IdempotencyRecord }
  | { status: 'in_progress' }
  | { status: 'collision' }

interface VisibilityProbeIdempotencyRegistry {
  claim(input: { requestFingerprint: string; identityKey: string }): Promise<IdempotencyClaimResult>
  complete(input: { requestFingerprint: string; identityKey: string; claimToken: string; result: ProbeExecutionResult }): Promise<void>
  release(input: { requestFingerprint: string; identityKey: string; claimToken: string }): Promise<void>
}
```

Claim 必須在 adapter execute 前完成；只有 acquired 且持有 claim token 的 worker 可呼叫 adapter。`replay` 只有在完整驗證 record、result、candidate lineage、治理欄位、response metadata、timestamp、citation 與 evidence locator 後才可回傳 `replayed: true`。`in_progress` 不重呼叫 adapter，回傳 bounded `IDEMPOTENCY_IN_PROGRESS_RETRYABLE`；collision 不呼叫 adapter，回傳 `IDENTITY_COLLISION`。Adapter failure、analysis blocked、abort、complete failure 或其他未完成狀態會 release claim；registry exception 只回傳 bounded failure，不洩漏 raw error、stack、token 或 registry record。

SyntheticRegistry 以同步 map state transition 實作真正 atomic claim，不使用先 get 再 set。兩個 Promise 並行執行相同 plan/registry 時，adapter call count 精確為 1；另一個 execution 只能取得 `in_progress` bounded retryable 或稍後得到 validated replay。Batch 結果 stable ordered，單一 probe failure 不抹除其他結果，也不會在同一 batch 內 sleep 或無限 retry。

Runner 自己以 target `timeoutMs` 建立 bounded deadline，不只依賴 adapter 自行實作 timeout。若 caller 傳入 `abortSignal`，adapter 仍收到同一 signal identity；runner 另外以 deadline race fail closed，並在完成後清除 timer 與 upstream listener。

## Retry policy

固定不可重試類別包含 invalid input、owner/project/query mismatch、unsupported locale、adapter mismatch、response too large、malformed response、citation validation、identity collision、redirect，以及 HTTP 400／401／403／404／409／422。可重試類別包含 timeout、network unavailable、HTTP 429 與 HTTP 500–599。輸出只有 boolean、bounded delay category（none／short／medium／long）與 reason code，不提供 duration、不 sleep、不回傳原始錯誤。

## Execution, retry, reconciliation, and persistence

The existing runner retains concurrency range 1–5, target deadline up to 120 seconds, atomic injected idempotency registry, stable results, and failure classification. It does not sleep internally. Benchmark orchestration invokes it on one-probe plans with a single in-memory idempotency registry per execution, a worker pool of five, short injected delays, and at most three attempts for a retryable sample in one execution.

Before every call, durable owner/fingerprint state is reconciled. If a run plus observation already exists, the sample links to them and becomes succeeded without calling the adapter. A unique-fingerprint 409 during persistence repeats this reconciliation instead of becoming a false failure. Each persisted run receives prompt version, benchmark ID, and sample index; each observation receives its own prompt version and citation freshness. Every row result updates counters and `lastProgressAt` immediately.

Resume never executes succeeded samples. Pending, failed, and interrupted stale-running rows are eligible. Fresh `running` rows cannot be claimed by another executor. No Nitro scheduler or automatic retry loop exists.

## Citation HEAD safety

Provider/URL dates are pure. Optional HTTP `HEAD` is enabled only by `LLM_VISIBILITY_CITATION_HEAD_FETCH=true`; default/off produces `unknown` without network. Fetch and DNS are injectable. Benchmark execution and each synchronous provider batch share one cache and 100-request budget within their execution, use a five-second AbortController timeout, and follow at most three redirects manually.

Before the first request and after every redirect, only credential-free HTTP/HTTPS URLs are allowed; the hostname is resolved and every returned address must be public. Localhost, private/loopback/link-local/carrier-grade/zero-network IPv4, IPv6 loopback/unique-local/link-local, and mapped forms are blocked. Fake or unreliable Last-Modified values remain unknown.

## Existing V1 non-regression boundary

The engine is now called by `server/llm-visibility/repository.ts`, `server/llm-visibility/benchmark-runtime.ts`, and the owner routes. This current integration adds provider persistence and benchmark orchestration while leaving these contracts untouched:

- manual observation import contract
- `manual_verified_v1` primary metrics denominator
- owner verification semantics

Provider candidates remain `verifiedByOwner=false` and `secondary_only`; runtime persistence marks them `persisted_secondary_only` and never converts them to a manual verified snapshot.

## Mocked-by-default operation

Provider adapters use official fixed endpoints and opaque env credentials only through the existing opt-in mechanism. Missing credentials fail closed. Unit and contract tests inject adapters, clocks, delays, fetch, and DNS; they make no real provider request or citation HEAD request. Operational reports must state `real provider calls NOT RUN` and `HEAD real fetch NOT RUN` unless separately and explicitly exercised.

## Testing and limitations

`tests/llm-visibility-probe-engine.test.ts` 保留原有 targeted safety coverage，並新增 adversarial tests，現有 targeted suite 共 **192 direct tests**。覆蓋 planner deterministic ordering、strict exact-key/symbol/getter validation、全部 probe lineage tamper、plan fingerprint recomputation、paused/locale-ineligible target、validated-plan analyzer、candidate governance/replay lineage、atomic concurrent duplicate、collision/in-progress/release exceptions、runner-owned timeout、strict timezone offset、multiline response、canonical mention/excerpt coordinate、metadata totals、400 emoji code-point position、full-hash evidence locator、canonical array reorder、response/runner extra keys，以及 existing manual import fail-closed regression。

V1 仍不是 consumer UI 曝光證據。Provider API response 不等於 consumer UI visibility；candidate 不代表搜尋排名、流量、轉換、營收、ROI 或因果成效。Runtime 現已具 owner route、database persistence、durable fingerprint reconciliation 與 dashboard/benchmark wiring，但沒有 Nitro scheduler、automatic retry loop、consumer UI scraper 或 deployment proof；response text 也不宣稱已完成完整語意匿名化，production admission 仍需可信的上游 data governance。

## References

[1]: https://github.com/emily07100710/DiscoveryStack_nuxt — DiscoveryStack_nuxt repository.
[2]: https://github.com/emily07100710/DiscoveryStack_nuxt/tree/feature/llm-visibility-probe-engine-v1 — delivered feature branch.

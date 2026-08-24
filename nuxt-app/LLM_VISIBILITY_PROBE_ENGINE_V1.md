# LLM Visibility Probe Planning & Provider Observation Engine V1

## 定位與安全邊界

本 package 是未來自動監測的 **純 server-side、offline、deterministic、fail-closed safety core**，不是 consumer ChatGPT、Gemini 或 Perplexity UI scraper，也不是既有 LLM Visibility Monitor V1 的 dashboard 替代品。它提供 governed probe planning、注入式 provider adapter contract、response evidence normalization、品牌／競品提及分析、citation URL analysis、secondary-only provider observation candidate、bounded retry classification 與 atomic idempotency contract。

V1 不呼叫真實 OpenAI、Gemini、Perplexity 或其他付費 provider API，不登入 consumer account，不 scraping consumer UI，不繞過 provider 限制，不新增 API route、scheduler task、database schema、migration、persistence 或 deployment。所有 provider execution tests 都使用 injected synthetic mock adapter；response text 只在 analyzer function memory 中處理。

`server/llm-visibility-probes/index.ts` 是唯一 public barrel。所有 public entrypoint 以 `unknown` 為輸入，對 null、array、extra key、enumerable symbol、throwing getter、錯誤型別與 malformed lineage fail closed。新模組沒有 network client、environment credential、browser automation、scraper、crawler、database write 或檔案 write。

## Deterministic plan contract

`buildVisibilityProbePlan(input: unknown)` 只接受固定 owner scope、project identity、active query snapshots、provider targets、observation window、maximum 與 engine version。Provider V1 僅接受 `chatgpt`、`gemini`、`perplexity`；`google_ai_overview` 與 `manual_other` 不在此 automatic probe 範圍。

Planner 使用 `normalizeProbePlanInput()` 重新 normalization project、queries、targets、prompt hash、locale、identifier 與 bounds。active queries、active targets、brand aliases、competitors 與所有 order-insensitive collection 以明確 code-unit comparator canonical sorting；不使用 runtime locale sorting。相同語意而輸入排列不同時，plan fingerprint 與 probe ordering 完全一致。

`normalizeVisibilityProbePlan(value: unknown)` 是正式的 strict plan validator。Plan 只允許以下 exact keys：`status`、`engineVersion`、`ownerScopeKey`、`project`、`observationWindowKey`、`maximumProbes`、`providerTargets`、`probes`、`planFingerprint`、`limitationCode`。它重新 normalize project、targets 與 probes，不接受 TypeScript cast 作為信任邊界。Plan 必須是 `planned`、固定 engine version、固定 limitation code，probes 數量為 1–50 且不得超過 maximum；每個 target 必須 active、locale eligible、timeout/response byte 在上限內，且 provider/model/adapter identity 不得重複。

Planner 與 validator 共用 `buildCanonicalPlanBody()`。Plan fingerprint 由 canonical body 重新計算：

```text
expectedPlanFingerprint = canonicalFingerprint(canonicalPlanBody)
```

每個 probe 的 request fingerprint 由固定 identity、normalized prompt hash、engine version 計算，probe ID 由 `identityKey + requestFingerprint` 計算。Validator 重新計算並精確比對 `requestFingerprint`、`identityKey`、`probeId`、owner/project/query/locale/window、target identity、provenance 與治理欄位；任何 prompt、project、target、scope 或 lineage tamper 都在 adapter 呼叫前 blocked。它同時拒絕重複 request fingerprint、probe ID 與 identity key，以及空 probes plan。

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

Response 也採 exact-key contract。Success response 只允許 `ok`、`provider`、`modelLabel`、`responseText`、`citationUrls`、`observedAt` 以及 bounded optional request ID/metadata。Provider/model 必須與 validated target 精確一致；response text 受 UTF-8 byte ceiling；citation 只接受 canonical public HTTPS URL，去除 duplicate，拒絕 credentials、localhost、private/reserved IP 與 fragment；metadata 的 unknown keys、symbol、getter exception 與不一致 token totals 都 blocked。

Candidate 的 lineage 必須保存 `planFingerprint`、`ownerScopeKey`、`projectId`、`queryId`、`provider`、`modelLabel`、`observationWindowKey` 與 `provenance.adapterKey/engineVersion`。`normalizeObservationCandidate()` 是 internal full validator，不在 public barrel 暴露，且不再 spread 未驗證 caller fields。Replay 與 completed result 都必須使用同一個完整 candidate validator。

所有成功 candidate 固定為：

```text
observationMode = provider_api_observation
verifiedByOwner = false
status = completed
metricEligibility = secondary_only
consumerSurfaceEquivalent = false
limitationCode = provider_api_not_consumer_surface
persistenceStatus = not_persisted_v1
```

Candidate 不能通過既有 `ownerManualObservationImportSchema`；runner 不呼叫 `importObservationSnapshot()`，也不會寫入既有 manual dashboard。既有 primary metrics 仍維持 `metricBasis = manual_verified_v1`。

## Timestamp、Unicode 與 evidence contract

`observedAt` 必須是完整 timezone-bearing ISO datetime，僅接受 `Z` 或 `±HH:MM`，並拒絕 date-only、無 timezone、空字串、不存在 calendar date、Invalid Date 與非法 offset。合法 offset 會 canonicalize 到 UTC ISO，例如 `2026-08-24T08:00:00+08:00` 變為 `2026-08-24T00:00:00.000Z`；candidate validator 要求保存值已是 canonical UTC。

Brand/competitor analysis 使用 NFKC、case-folded、whitespace-normalized analysis text。mention position 從 1 開始，單位是 Unicode code point；bounded excerpt 也使用同一 position system 與 `Array.from()` code-point slicing，避免 UTF-16 offset 與 code-point slicing 混用。測試包含品牌名稱前 400 個 emoji。

Evidence locator 使用完整 response hash，而非前 16 字元：

```text
`${provider}:${probeId}:${responseHash}`
```

因此 response hash 只有 suffix 不同時，locator 仍一定不同。Candidate 只保留 exact hash、bounded excerpt、derived mentions、canonical citations、bounded provider request reference、evidence locator、timestamp 與 safe metadata，不保存 raw response。

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

## Retry policy

固定不可重試類別包含 invalid input、owner/project/query mismatch、unsupported locale、adapter mismatch、response too large、malformed response、citation validation、identity collision、redirect，以及 HTTP 400／401／403／404／409／422。可重試類別包含 timeout、network unavailable、HTTP 429 與 HTTP 500–599。輸出只有 boolean、bounded delay category（none／short／medium／long）與 reason code，不提供 duration、不 sleep、不回傳原始錯誤。

## Existing V1 non-regression boundary

新 package 可以 import existing pure helpers/types，但不修改：

- `server/llm-visibility/**`
- `server/api/llm-visibility/**`
- `pages/audit-lab/llm-visibility.vue`
- manual observation import contract
- `manual_verified_v1` primary metrics denominator
- owner verification semantics

Provider mock candidate 永遠是 `verifiedByOwner=false`、`secondary_only`、`not_persisted_v1`，不會被轉換為 manual verified snapshot。

## Testing and limitations

`tests/llm-visibility-probe-engine.test.ts` 保留原有 targeted safety coverage，並新增 adversarial tests，現有 targeted suite 共 **185 direct tests**。覆蓋 planner deterministic ordering、strict exact-key/symbol/getter validation、全部 probe lineage tamper、plan fingerprint recomputation、paused/locale-ineligible target、validated-plan analyzer、candidate governance/replay lineage、atomic concurrent duplicate、collision/in-progress/release exceptions、strict timestamp、metadata totals、400 emoji code-point position、full-hash evidence locator、canonical array reorder、response/runner extra keys，以及 existing manual import fail-closed regression。

V1 是 mocked adapter safety core，尚未接 live provider，也不代表 consumer UI 曝光。Provider API response 不等於 consumer UI visibility；candidate 不代表搜尋排名、流量、轉換、營收、ROI 或因果成效。V1 沒有 scheduler、durable idempotency persistence、API route、database persistence、dashboard wiring 或 deployment；response text 也不宣稱已完成完整語意匿名化，production admission 仍需可信的上游 data governance。

## References

[1]: https://github.com/emily07100710/DiscoveryStack_nuxt — DiscoveryStack_nuxt repository.
[2]: https://github.com/emily07100710/DiscoveryStack_nuxt/tree/feature/llm-visibility-probe-engine-v1 — delivered feature branch.

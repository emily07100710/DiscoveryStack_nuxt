# LLM Visibility Probe Planning & Provider Observation Engine V1

## 定位

本 package 是未來自動監測的安全核心，不是 consumer ChatGPT、Gemini 或 Perplexity UI scraper，也不是現有 LLM Visibility Monitor V1 的替代 dashboard。它只提供 deterministic probe planning、注入式 provider adapter contract、response evidence normalization、品牌／競品提及分析、citation URL analysis、provider observation candidate、retry classification 與 idempotency fingerprint。

V1 不呼叫真實 OpenAI、Gemini、Perplexity 或其他付費 provider API，不登入 consumer account，不 scraping consumer UI，不繞過 provider 限制，不新增 scheduler task，不寫 database，不執行 migration，也不 deploy。所有 provider execution tests 都使用 injected synthetic mock adapter。

## Public API

`server/llm-visibility-probes/index.ts` 是唯一 public barrel，公開：

```ts
buildVisibilityProbePlan(input: unknown): ProbePlanResult
executeVisibilityProbeBatch(input: unknown): Promise<ProbeBatchResult | ProbeBatchBlockedResult>
analyzeProviderObservation(input: unknown): ProbeAnalysisResult
classifyVisibilityProbeFailure(input: unknown): RetryDecision
```

所有 entrypoint 都在 unknown／malformed／null／array／proxy/getter failure 邊界 fail closed。新模組不讀 `process.env`，不呼叫 `fetch`、`$fetch`、`ofetch`、axios、browser automation、scraper 或 crawler，不讀寫 DB、不寫檔案、不執行 scheduler，也不回傳 raw stack、secret、credential 或完整 raw response。

## Probe planning

`buildVisibilityProbePlan()` 要求 owner scope、project identity、canonical public domain、brand／alias／competitor、project locale、active query snapshots、provider targets、observation window、explicit maximum 與固定 engine version。Provider V1 僅接受 `chatgpt`、`gemini`、`perplexity`；`google_ai_overview` 與 `manual_other` 不在此自動監測範圍。

Provider target 不含 API key、secret、Authorization header、endpoint、cookie 或 credential；只含 provider、model label、adapter key、active／paused、allowed locales、response byte ceiling 與 timeout ceiling。Query snapshot 的 prompt hash 必須是 normalized prompt 的 exact SHA-256；query 必須屬於同一 project、active、locale 與 project／provider policy 相容。normalized prompt、provider/model/query combination、超過 50 probes 與 maximum 1–50 都有固定 fail-closed reason code。

Probe 以 provider → modelLabel → locale → queryId → promptHash stable ordering 產生。每個 probe 都有 `probeId`、`requestFingerprint`、owner/project/query identity、normalized prompt、window、limitation code、provenance 與 `status: planned`。`requestFingerprint` 覆蓋 engine version、owner scope、project、query/hash、provider、model、locale 與 observation window，因此相同 window identity 可 replay，不同 window／provider／model／query 會分離。

## Injected adapter boundary

Runner 只接受外部注入的 `Record<adapterKey, VisibilityProbeAdapter>`。Adapter input 只有 probe identity、normalized prompt、locale、bounded timeout metadata 與 optional abort signal；不提供 credential 或 endpoint。Adapter 缺少、adapter key unknown、provider/model mismatch 會 blocked，不會自動 fallback 到其他 provider。

Adapter success 只能帶 provider、model label、response text、citation URLs、observed timestamp、optional bounded opaque request ID 與 bounded response metadata allowlist。Adapter failure 只能帶固定 failure kind、retryable hint、bounded code 與 optional HTTP status；runner 會重新使用 fixed retry policy，不會把 raw error、request body、Authorization、token 或 secret 傳到結果。

## Response safety 與 observation candidate

Response text 只在函式記憶體中使用。Analyzer 先檢查 exact UTF-8 byte ceiling，再計算 exact response SHA-256；超過 target ceiling 立即 blocked。輸出不包含 `responseText` 或完整 raw response，只保留 response hash、最多 1000 個 Unicode code points 的 bounded excerpt、品牌／競品 derived fields、canonical citation URLs、exact cited domain、bounded provider request reference、evidence locator、observedAt、limitation 與 provenance。

Bounded excerpt 在有品牌提及時以首次提及附近為中心，無品牌提及時取 deterministic leading excerpt，透過 `Array.from()` 避免切斷 surrogate pair。品牌與競品 matching 重用既有 `canonicalBrandKey`、`countBrandMentions` 與 `countCompetitorMentions`，保留 Unicode NFKC 與 token boundary，避免 `Acme` 誤配 `AcmePlus` 或 brand／competitor collision。

Citation URL 只接受 adapter 明確回傳的最多 50 個 public HTTPS URL，去除 duplicate、stable sort、拒絕 credentials、localhost、private／reserved IP 與 fragment。Analyzer 不從 response text 猜 URL。`citedDomain` 只有在至少一個 canonical citation URL 的 hostname 精確等於 project canonical domain 時才設定；subdomain 不視為 exact domain。

成功 candidate 固定包含：

```text
observationMode = provider_api_observation
verifiedByOwner = false
status = completed
metricEligibility = secondary_only
consumerSurfaceEquivalent = false
limitationCode = provider_api_not_consumer_surface
persistenceStatus = not_persisted_v1
```

Candidate 不能直接通過既有 `ownerManualObservationImportSchema`，runner 不呼叫 `importObservationSnapshot()`，也不會寫入既有 manual dashboard。既有 primary metrics 仍維持 `metricBasis = manual_verified_v1`。

> Provider API observation 只能說明該 API/model/request 的結果，不能證明一般使用者在 consumer ChatGPT、Gemini、Perplexity 介面一定看到相同答案。

## Bounded batch runner

`executeVisibilityProbeBatch()` 接受 validated planned plan、injected adapters、injected idempotency registry 與 explicit concurrency。Concurrency 只接受 1–5，預設 1；worker 數量上限為 5，最多處理 50 probes。每個 probe 在一次 batch 最多呼叫 adapter 一次，一個 probe 失敗不會抹除其他結果，結果依 plan stable order 回傳並提供 completed／blocked／failed／retryable counts。

Idempotency registry 是 injected interface，不使用 module-global Map 作 production truth。已存在且 identity key 相符的 completed fingerprint 會 replay existing metadata，不重新呼叫 adapter；相同 fingerprint 配不同 identity 會 blocked。Registry durability 不在 V1 保證，因為本 package 不寫 DB。Runner 不自行 sleep、不做同次呼叫無限 retry；durable retry 留給未來 scheduler integration。

## Retry policy

固定不可重試類別包含 invalid input、owner/project/query mismatch、unsupported locale、adapter mismatch、response too large、malformed response、citation validation、identity collision、redirect，以及 HTTP 400／401／403／404／409／422。可重試類別包含 timeout、network unavailable、HTTP 429 與 HTTP 500–599。輸出只包含 boolean、bounded delay category（none／short／medium／long）與 reason code，不提供 duration、不 sleep、不回傳原始錯誤。

## Existing V1 non-regression boundary

本 package 可以 import existing pure helpers/types，但不修改：

- `server/llm-visibility/**`
- `server/api/llm-visibility/**`
- `pages/audit-lab/llm-visibility.vue`
- manual observation import contract
- `manual_verified_v1` primary metrics denominator
- owner verification semantics

Provider mock candidate 不會被寫入現有 dashboard，`verifiedByOwner` 永遠為 false，`provider_api_observation` 不會被轉換為 manual verified snapshot。

## Testing

`tests/llm-visibility-probe-engine.test.ts` 與 synthetic fixture 覆蓋 131 個 direct tests，包含 planning deterministic／ordering／scope／locale／duplicate／max 50、adapter missing／mismatch／timeouts／network／4xx／429／5xx／malformed／oversize、response hash／excerpt／surrogate／brand／competitor／citation safety、batch concurrency／partial failure／stable order／idempotency／collision／registry isolation、retry policy 與 existing manual runtime fail-closed boundary。Fixtures 不含真實客戶 prompt、provider response、token、cookie 或 account data。

## Explicit limitations

這是自動監測核心與 mocked adapter contract，尚未接 live provider，也不代表 consumer UI 曝光。Provider API response 不等於 consumer UI visibility；candidate 不代表搜尋排名、流量、轉換、營收、ROI 或因果成效。V1 不保證 response text 內所有自然語言內容都沒有 PII，因為 analyzer 只保留 bounded derived evidence，且不做完整語意匿名化；實際 production admission 仍需可信的上游 data governance。

V1 registry 非 durable，provider execution 尚未接 scheduler，沒有 API route、database persistence、dashboard wiring 或 deployment。Metadata、adapter output 與 citation safety 由 runtime caller／adapter contract 負責；此 package 只在自身邊界拒絕未授權形狀與不安全輸出。

## References

[1]: https://github.com/emily07100710/DiscoveryStack_nuxt — DiscoveryStack_nuxt repository.
[2]: https://github.com/emily07100710/DiscoveryStack_nuxt/tree/main — fixed main base used for this package.

# Evidence-bound GEO Content Quality & Prompt/RAG Contract V1

## Scope and non-goals

本 package 是未來 GEOFlow＋Qwen 生成內容前的 **pure contract and quality-governance core**。它不是模型接入，不呼叫 Qwen／百煉、OpenAI、Gemini 或 Claude，不做 embedding、vector database、crawler、scraper、Firecrawl、API route、page/UI、migration、database persistence 或真實網站內容寫入。它也不把 deterministic heuristic 宣稱為真實內容品質、排名、流量、轉換、ROI 或 LLM 引用預測。

所有 public functions 都是 server-side、offline、deterministic、fail-closed 的 pure-style boundaries。Provider output 只能由外部 caller 以 structured object 傳入；本 package 不執行 provider call，也不接受 credential、token、raw header、raw response、browser approval 或 fake success flag。

`server/geo-content-quality/index.ts` 是唯一 public barrel。新模組不改既有 `server/geo/**`、`services/geoflow/**`、既有 SEO/Authority/Content Operations、API、UI、database 或 deployment。

## Fixed input contract

`ContentQualityInput` 必須包含以下欄位：

```text
contractVersion = geo-content-quality-v1
ownerUserId
clientId
briefId
jobId
contentType = article | faq | service_page
language = zh-hant | en
industryRisk = general | medical | legal | financial
audience
brandVoice
goals
constraints
selectedRuleIds
evidenceSnapshotHash
approvedEvidenceChunks
authoritySources
retrievalPlan
providerProvenance
requestedAt
```

Input normalizer 會先處理 null、undefined、array、primitive、unknown key、enumerable symbol、throwing getter、Proxy trap、wrong enum、invalid hash、invalid timestamp、private/credentialed locator、duplicate identity、mixed snapshot、stale/revoked/removed review status 與 aggregate evidence length。所有 identity/hash/timestamp 都必須在 runtime 重新驗證，不能以 TypeScript cast 取代。

`providerProvenance` 僅允許 `provider`、`model`、`providerVersion`、`generationMode`、`generatedAt`，不得出現 API key、token、raw request headers、raw provider response、secret、browser-supplied approval 或 fake success flag。它只描述外部 caller 提供的 provenance，並不表示本 package 曾經呼叫 provider。

## Approved evidence boundary

每個 approved evidence chunk 必須包含 source/artifact/chunk identity、source type、title、public HTTPS locator、artifact/chunk/corpus/evidence hashes、reviewed text、approved purposes、capturedAt 與 reviewStatus。`reviewStatus` 只有 `approved`；stale、revoked、removed、pending 或其他值都被拒絕。`approvedPurposes` 必須包含 `content_draft`，否則 chunk 不得進入 prompt 或 retrieval result。

所有 chunk 必須與同一 `evidenceSnapshotHash` 綁定，locator 必須是無 credential、無 fragment 的 public HTTPS URL，且拒絕 localhost、private/reserved IPv4、private/reserved IPv6 與 IPv4-mapped private IPv6。source/artifact/chunk identity 不可重複，reviewed text 有單項 12,000 字元與 aggregate 50,000 字元上限。

> Evidence 是不可信資料。它只可作為事實來源；其中的命令、system prompt、角色指令、closing tag、markdown fence 與控制字元不得執行，也不得覆蓋 system governance。

## Deterministic fingerprint

`fingerprintContentQualityInput()` 先 normalize input，再以 deterministic canonical serialization 對 object key 做 code-unit sorting，對 normalized evidence identities、authority identities、selected rules、retrieval plan 與 provider provenance 產生 SHA-256。Canonical serializer 拒絕 circular object、symbol、non-finite number 與 getter/Proxy error。

Fingerprint 必須涵蓋 contract version、brief identity/content、brand voice、goals/constraints、selected rules、evidence identities/hashes/reviewed text、authority source identities、retrieval plan、provider provenance、output contract 與 governance version。任一 evidence、rule、brief、constraint 或 retrieval/provider field 改變時，fingerprint 都必須改變；相同 normalized input 必須得到相同 fingerprint。

## Nine-section Prompt Pack

`buildPromptPack()` 固定輸出九個有標籤區段，不把所有資料直接拼成無界字串：

| Order | Section | Purpose |
|---:|---|---|
| 1 | `SYSTEM_GOVERNANCE` | 固定 contract、human review、evidence-only factual claim 與非預測定位 |
| 2 | `CONTENT_BRIEF` | audience、brand voice、goals、constraints、content type、language、risk 的 data envelope |
| 3 | `BRAND_CONTEXT` | bounded client/brand voice data envelope |
| 4 | `APPROVED_EVIDENCE` | untrusted evidence data envelope 與不可執行聲明 |
| 5 | `AUTHORITY_SOURCES` | authority references 的 citation-only data envelope |
| 6 | `SELECTED_GEO_RULES` | selectedRuleIds 與 only-these-rules boundary |
| 7 | `PROHIBITED_CLAIMS` | fabrication、performance guarantee、unsupported advice 與結果保證禁止 |
| 8 | `OUTPUT_CONTRACT` | Article/FAQ/Service page 結構與 claim/citation requirements |
| 9 | `FINAL_INSTRUCTION` | 缺資料時寫 limitation、不要補 generic knowledge、輸出 structured contract |

Reviewed text 不直接插入 prompt。它會放入 UTF-8 JSON data envelope 後再 base64 encode，使 `ignore previous instructions`、`system:`、`</evidence>`、triple backticks、JSON closing syntax 與 Unicode control character 無法逃離 evidence data boundary。Prompt 明確要求：factual claims 只能基於 approved evidence；數字、百分比、日期、比較、排名、醫療、法律、金融主張必須 citation binding；不得捏造案例、客戶、認證、研究結果、價格、SLA、成效或結果；不得保證排名、流量、轉換、營收、ROI 或 LLM 引用；缺資料須寫 limitation；selected rule 以外不得宣稱 applied；zh-hant 不輸出簡體中文作主要正文；FAQ 問答要可追蹤 evidence；service page 不捏造 customer outcomes。

## Pure RAG retrieval contract

本輪只提供 retrieval contract，不做 embedding、vector database 或 retrieval network call。`RetrievalPlan` 固定包含 retrieval version、query fingerprint、corpus/evidence snapshot、bounded `topK`（1–20）、allowed source/artifact IDs 與 required purposes。

`buildRetrievalResult()` 只接受 approved chunks，重新驗證 identity、hash、review status、snapshot、purpose、allowlist、duplicate 與 scoreBasis。Result 只回傳 stable code-unit sorted chunks，每個 chunk 保存 `scoreBasis` 與 limitations；scoreBasis 是 retrieval heuristic label，不是 evidence-veracity measure，也不可在不同 provider 間混合比較。沒有可接受 chunk 時只回傳 `status: not_ready`，不建立假 context，不用 generic knowledge fallback 冒充客戶資料。

Prompt pack 對 supplied retrieval result 會再次驗證 chunk identity、artifact/chunk hash、reviewed text、snapshot、allowlist 與正式 RAG result，避免 caller 以 allowlist-only chunk 注入 prompt。

## Provider output contract

`ProviderOutput` 必須是 structured object，固定包含：

```text
outputVersion
title
summary
body
bodyHash
faqPairs
claims
citations
appliedRuleIds
limitations
```

Provider output validator 拒絕 raw prose、malformed JSON-like input、unknown key、symbol、getter/Proxy exception、circular collection、non-finite value、oversize title/body/FAQ/claims/citations、body hash mismatch、duplicate claimId/citationId、citation outside approved evidence、citation hash mismatch、claim/FAQ citation binding error 與 appliedRuleIds outside selectedRuleIds。

每個 claim 必須有 claimId、text、claimType、bodyLocator、citationIds；每個 citation 必須有 citationId、sourceId、artifactId、chunkId、chunkHash。`factual`、`quantitative`、`comparative`、`medical`、`legal`、`financial` claim 的 citation completeness 由 quality gate 再檢查。Provider output 不保存 raw request、raw response、credential 或 token。

Unsafe commercial/case/performance language 會以 fixed reason code 拒絕；quality gate 不會把 heuristic detection 說成已驗證的事實。

## Markdown structure parser

`parseMarkdownStructure()` 不以「全文是否包含 `##`」作為通過。它會解析：

- title heading、H2/H3 levels 與 heading jump；
- empty section、duplicate normalized heading；
- first meaningful paragraph 與 direct-answer-first；
- paragraph duplication；
- FAQ section、question/answer pair 與 duplicate question；
- citation marker placement；
- conclusion/CTA heading；
- template filler；
- zh-hant simplified character signal。

Heading、FAQ question 與 paragraph duplicate normalization 使用 NFKC、case normalization、whitespace normalization 與 punctuation normalization。Parser 使用 fenced-code state，不把 code fence 內 heading 當正文 heading。Direct-answer-first 只看第一個 meaningful prose block，不因全文後段出現 keyword 就通過。FAQ duplicate 以 normalized question identity 比較，而不是只比原始字串。

## Deterministic heuristic quality gates

`evaluateContentQuality()` 的 status 僅有：

```text
passed
needs_human_review
blocked
```

輸出包含 `sourceCoverage`、`claimCoverage`、`citationCoverage` 與 `structureChecks`，其 metric name 固定為 `deterministic heuristic / coverage metric`，並保存 numerator、denominator、ratio。這些 coverage metrics 不是 truth score、ranking score、GEO success probability、conversion prediction，也不是品質、排名、流量、轉換、ROI 或 LLM citation uplift 的預測。

Quality gate 會先驗證 input、retrieval、provider output 與 provider body/Markdown exact binding，再評估：

| Check family | Examples |
|---|---|
| Evidence | approved availability、same snapshot、source coverage、citation binding、stale/revoked/removed |
| Claim safety | citation completeness、unsupported quantitative claim、fabricated customer case、performance guarantee |
| Structure | direct answer、heading hierarchy、empty section、duplicate heading/paragraph、FAQ integrity、citation marker placement、conclusion/CTA |
| Governance | selected/applied rule consistency、brand voice boundary、content length、limitations |
| Risk | medical/legal/financial content always requires human review even when cited |
| Conflict | conflicting evidence, ambiguous or incomplete authority/source coverage requires human review |

至少以下條件會 blocked：citation outside approved evidence、mixed evidence snapshot、unsupported quantitative claim、fabricated customer case、ranking/traffic/conversion/ROI guarantee、medical/legal/financial advice without sufficient binding、stale/revoked evidence、applied rule outside selection、malformed provider output、content/body hash mismatch、template filler 或 unsupported zh-hant output。Source coverage insufficient、conflicting evidence、high-risk industry、missing direct answer、heading/FAQ/paragraph concerns 會至少產生 `needs_human_review`；它們不代表可自動發布。

即使 status 是 `passed`，result 仍保存 limitations，且 `qualityGateIsPublishApproval()` 永遠回傳 false。Passed 不等於 auto-approved、publication-ready 或任何 GEO/SEO outcome。

## Fixed reason codes

本 package 的 reason-code catalog 包含：

```text
INVALID_INPUT
UNKNOWN_FIELD
LIMIT_EXCEEDED
INVALID_HASH
INVALID_TIMESTAMP
EVIDENCE_NOT_APPROVED
EVIDENCE_PURPOSE_NOT_ALLOWED
EVIDENCE_SNAPSHOT_MISMATCH
DUPLICATE_EVIDENCE
STALE_EVIDENCE
RETRIEVAL_CORPUS_MISMATCH
RETRIEVAL_OUTSIDE_ALLOWLIST
PROMPT_INPUT_LIMIT_EXCEEDED
PROVIDER_OUTPUT_MALFORMED
CONTENT_HASH_MISMATCH
CITATION_OUTSIDE_APPROVED_EVIDENCE
CLAIM_WITHOUT_CITATION
UNSUPPORTED_QUANTITATIVE_CLAIM
FABRICATED_CASE_CLAIM
PROHIBITED_PERFORMANCE_GUARANTEE
APPLIED_RULE_OUTSIDE_SELECTION
INVALID_HEADING_HIERARCHY
DUPLICATE_FAQ
DUPLICATE_PARAGRAPH
HIGH_RISK_REVIEW_REQUIRED
CONFLICTING_EVIDENCE
SOURCE_COVERAGE_INSUFFICIENT
INVALID_CONTENT_TYPE
INVALID_LANGUAGE
INVALID_INDUSTRY_RISK
RETRIEVAL_NOT_READY
PROVIDER_PROVENANCE_INVALID
INVALID_CITATION_BINDING
INVALID_BODY_LOCATOR
EMPTY_REQUIRED_FIELD
UNSUPPORTED_LOCALE_OUTPUT
EMPTY_SECTION
DUPLICATE_HEADING
TEMPLATE_FILLER
DIRECT_ANSWER_MISSING
FAQ_INTEGRITY_FAILURE
CONTENT_LENGTH_OUT_OF_BOUNDS
BRAND_VOICE_CONSTRAINT
EVIDENCE_CONFLICT_UNRESOLVED
PROMPT_INJECTION_DATA_BOUNDARY
```

## Testing

`tests/geo-content-quality-prompt-rag.test.ts` 使用 synthetic fixtures，所有測試呼叫正式 public functions，沒有只做 source-text assertion，也沒有真實網站內容或 provider call。Targeted suite 目前有 **178 direct tests**，覆蓋三種 content type、zh-hant/en、四種 industry risk、完整 normalization/fingerprint、prompt injection payload、closing tags、triple backticks、JSON closing syntax、Unicode control character、RAG topK/corpus/allowlist/not_ready、provider output malformed/unknown/circular/hash/citation/rule/case/guarantee、Markdown parser hierarchy/FAQ/duplicate/filler/locale，以及 quality status/coverage/limitations/high-risk/conflict。

## Required verification and delivery boundaries

在 `nuxt-app` 執行：

```bash
pnpm install --frozen-lockfile
pnpm typecheck
pnpm vitest run tests/geo-content-quality-prompt-rag.test.ts
pnpm vitest run tests/seo-geo*.test.ts tests/geo-workbench.contract.test.ts tests/authority-source-policy-engine.test.ts tests/content-operations-execution-*.test.ts
NODE_OPTIONS=--max-old-space-size=1536 NITRO_PRESET=node-server pnpm build
```

Build 後只清理 fresh isolated worktree 內的 `.nuxt`、`.output`、`.nitro`，並保留 tracked `nuxt-app/dist` symlink。另執行 allowed-path、package/lockfile unchanged、database/migration/API/UI unchanged、secret/private-key、network/provider/database static scan 與 `git diff --check`。

Full Vitest、migration、deploy 與 provider calls 固定為：

```text
Full Vitest: NOT RUN
Migration: NOT RUN
Deploy: NOT RUN
Provider calls: NONE
```

## Explicit limitations

這是 evidence-bound contract、mocked structured output validator、pure retrieval contract、Markdown parser 與 deterministic heuristic gate，不是 Qwen 接入、不是真實 RAG、不代表已使用 GEOFlow、不代表已產生高品質文章、不代表已發布，也不表示 GEO、排名、流量、轉換、ROI 或 LLM citation 已提升。Evidence 與 authority 的內容正確性仍需 owner/human review；`passed` 永遠保存 limitations 且不得當成自動核准。V1 不做完整語意 PII anonymization，不做 durable retrieval persistence，也不接任何 scheduler、API、database 或 UI。

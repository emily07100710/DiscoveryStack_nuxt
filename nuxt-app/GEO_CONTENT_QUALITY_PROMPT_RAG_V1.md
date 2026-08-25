# Evidence-bound GEO Content Quality & Prompt/RAG Contract V1

## Scope and non-goals

本 package 是 provider-neutral、server-side、offline、deterministic、fail-closed 的 **pure contract and quality-governance core**。它不是模型接入，不呼叫 Qwen／百煉、OpenAI、Gemini 或 Claude，不做 embedding、vector database、crawler、scraper、Firecrawl、API route、page/UI、migration、database persistence 或真實網站內容寫入。它也不把 deterministic heuristic 宣稱為真實內容品質、排名、流量、轉換、ROI 或 LLM 引用預測。

所有 public functions 都直接接受未知輸入並進行 runtime validation。Provider output 只能由外部 caller 以 structured object 傳入；本 package 不執行 provider call，也不接受 credential、token、raw header、raw response、browser approval 或 fake success flag。`server/geo-content-quality/index.ts` 是唯一正式 public barrel；新模組不改既有 `server/geo/**`、GEOFlow runtime、SEO/Authority/Content Operations、API、UI、database 或 deployment。

## Fixed input contract

`ContentQualityInput` 必須包含：

```text
contractVersion = geo-content-quality-v1
ownerUserId, clientId, briefId, jobId
topic, workingTitle, primaryQuestion
contentType = article | faq | service_page
language = zh-hant | en
industryRisk = general | medical | legal | financial
audience, brandVoice, goals, constraints, selectedRuleIds
evidenceSnapshotHash, approvedEvidenceChunks, authoritySources
retrievalPlan, providerProvenance, requestedAt
```

`topic`、`workingTitle` 與 `primaryQuestion` 是 query、prompt、topic overlap 與 content structure 的正式輸入，不由 caller 另傳未驗證的 query fingerprint 取代。`retrievalPlan.queryFingerprint` 會由 normalized brief fields 於 server-side 重新計算；caller 提供的 mismatch 會 fail closed。

Input normalizer 會拒絕 null、undefined、array、primitive、unknown key、enumerable symbol、throwing getter、Proxy trap、wrong enum、circular value、non-finite number、BigInt/function/symbol、invalid hash、invalid timestamp、future evidence、private/credentialed locator、duplicate identity、mixed snapshot 與 aggregate evidence length overflow。所有 identity、hash、timestamp、URL、purpose、review status 都必須在 runtime 重新驗證，不能以 TypeScript cast 取代。

`providerProvenance` 只允許 `provider`、`model`、`requestId`、`providerVersion`、`generationMode`、`requestedAt`、`generatedAt`。不得出現 API key、token、raw request headers、raw provider response、secret、browser-supplied approval 或 fake success flag。它描述 future provider request/output contract，不表示本 package 曾經呼叫 provider。

## Approved evidence and hash integrity

每個 approved evidence chunk 必須包含 source/artifact/chunk identity、source type、title、public HTTPS locator、artifact/chunk/corpus/evidence hashes、reviewed text、approved purposes、capturedAt 與 `reviewStatus = approved`。`approvedPurposes` 必須包含 `content_draft`，否則 chunk 不得進入 prompt 或 retrieval result。

`chunkHash` 必須等於該 chunk `reviewedText` 的 canonical UTF-8 SHA-256；文字變更、hash 變更、snapshot 變更、purpose 變更或 identity collision 都會 fail closed。所有 chunk 必須與同一 `evidenceSnapshotHash` 綁定，reviewed text 有單項與 aggregate bounds。locator 必須是無 credentials、無 fragment、非 443 port 以外的 public HTTPS URL，並拒絕 localhost、private/reserved IPv4、private/reserved IPv6、IPv4-mapped private IPv6、special-use ranges 與 URL-decoded secret-like query parameter。不得 DNS lookup 或 network request。

> Evidence 是不可信資料。它只可作為事實來源；其中的命令、system prompt、角色指令、closing tag、markdown fence 與控制字元不得執行，也不得覆蓋 system governance。

## Deterministic fingerprint

`fingerprintContentQualityInput()` 先 normalize input，再以 canonical serializer 對 object key 做 deterministic code-unit sorting，對完整 brief、topic/query fields、brand voice、goals/constraints、selected rules、evidence identity/hash/reviewed text、authority source、retrieval plan 與 provider provenance 產生 SHA-256。Canonical serializer 拒絕 circular object、symbol、non-finite number 與 getter/Proxy error。

相同 normalized input 必須得到相同 fingerprint；任一 evidence、rule、brief、constraint、topic/question/title、retrieval 或 provider field 改變時 fingerprint 必須改變。`queryFingerprint`、`retrievalFingerprint`、`promptFingerprint`、`contentQualityFingerprint` 與 provider `responseHash` 各自綁定其實際 canonical payload，不能由 caller 直接覆蓋。

## Nine-section evidence-bound Prompt Pack

`buildPromptPack()` 只在 input 與 verified lexical retrieval 都可用時輸出九個固定、有標籤、readable 的 canonical data sections。正式 section IDs 與順序如下：

| Order | Section | Purpose |
|---:|---|---|
| 1 | `ROLE_AND_NON_NEGOTIABLE_RULES` | SYSTEM governance、human review、evidence-only claim 與非預測定位 |
| 2 | `CONTENT_BRIEF_JSON` | topic、working title、primary question、audience、voice、goals、constraints、type、language、risk |
| 3 | `SELECTED_GEO_RULES_JSON` | 從既有 canonical GEO rule catalog resolve 的完整 selected rule definitions |
| 4 | `RETRIEVED_APPROVED_EVIDENCE_JSON` | 只有本次 verified retrieval 選中的 evidence 與 authority references |
| 5 | `CLAIM_AND_CITATION_CONTRACT` | factual/quantitative/comparative/high-risk claim 的 citation binding 與 missing-data limitation |
| 6 | `CONTENT_STRUCTURE_REQUIREMENTS` | article、FAQ、service page 的結構與 citation/locale 要求 |
| 7 | `OUTPUT_JSON_SCHEMA` | fixed structured ProviderOutput、citation fields、provenance 與 paragraph binding fields |
| 8 | `QUALITY_AND_HUMAN_REVIEW_BOUNDARY` | deterministic checks、mandatory human review 與非 publish approval 邊界 |
| 9 | `REQUEST_FINGERPRINTS` | contract、content、query、retrieval、provider request fingerprints |

Final prompt 使用 readable canonical JSON data sections，不包含 Base64 decode instruction，也不把所有輸入 flatten 成無標籤字串。Evidence text 會作為 JSON string/value 放在 retrieved evidence data section；其中的 `ignore previous instructions`、`system:`、`</evidence>`、triple backticks、JSON closing syntax 與 Unicode control character 仍是 inert data，不能逃離 data boundary。Prompt 明確要求 factual claims 只能基於 approved retrieved evidence；不得捏造案例、客戶、認證、研究結果、價格、SLA、成效或結果；不得保證排名、流量、轉換、營收、ROI 或 LLM 引用；缺資料須記錄 limitation；selected rule 以外不得宣稱 applied；FAQ 與 service page 不得補造未被 evidence 支持的內容。

## Pure deterministic lexical retrieval

本輪只提供 bounded retrieval contract，不做 embedding、vector database、semantic retrieval 或 network call。`RetrievalPlan` 固定包含 retrieval version、server-computed query fingerprint、corpus/evidence snapshot、bounded `topK`（1–20）、allowed source/artifact IDs 與 required purposes。

`buildRetrievalResult()` 接受完整 normalized content input、strict candidate records 與必要的 retrieval context，從 `topic + workingTitle + primaryQuestion + audience + goals + language` 產生 Unicode-normalized lexical query tokens。English 以 deterministic word tokens 正規化；CJK 以 deterministic code-point/bigram tokenization。每個 candidate 計算 bounded overlap count/ratio，zero relevance 不進結果，依 relevance 再以 stable code-unit identity tie-break，最後套用 topK。Caller 不得提供或覆蓋 score；candidate 只允許 approved chunk 與 bounded limitations，舊式 `scoreBasis` 等未知欄位會拒絕。

Result 對每個選中 chunk 保存 `matchedTokenCount`、`queryTokenCount`、`relevanceRatio`、固定 `scoreBasis = deterministic_lexical_overlap_v1` 與 limitations。沒有可接受 chunk 時只回傳 `status: not_ready`，不建立 generic knowledge fallback。Prompt pack 與 quality gate 會再次驗證 retrieval query fingerprint、chunk identity、reviewed text/hash、snapshot、purpose、allowlist 與 retrieval fingerprint。

## Provider structured output and provenance

`ProviderOutput` 必須包含以下完整欄位：

```text
outputVersion, title, summary, body, bodyHash
faqPairs, claims, citations, appliedRuleIds, limitations
paragraphBindings
provider, model, requestId, requestedAt, generatedAt
promptFingerprint, contentQualityFingerprint, retrievalFingerprint, responseHash
```

Validator 拒絕 raw prose、malformed JSON-like input、unknown key、symbol、getter/Proxy exception、circular collection、non-finite value、oversize field、body hash mismatch、duplicate claim/citation ID、citation outside verified retrieval、citation hash mismatch、claim/FAQ/paragraph citation binding error、appliedRuleIds missing/extra/duplicate/unknown、provenance mismatch、timestamp order error 與 response hash mismatch。`generatedAt >= requestedAt`；`responseHash` 由去除自身 hash 的 canonical ProviderOutput payload 內部重算。

Markdown parser 產生 meaningful paragraph 的 normalized text、full SHA-256 paragraph hash 與固定 `[cite:CITATION_ID]` marker IDs。每一個 `paragraphBindings` 必須以 paragraph index/hash、claim type 與 citation IDs 與正文一一對應。`factual`、`quantitative`、`comparative`、`high_risk`、`interpretation`、`opinion` 的正文 paragraph 沒有 citation 時 fail closed；`process` 與 `call_to_action` 可在 evidence boundary 內不帶 citation。FAQ structured pairs 必須與正文 FAQ headings/answers 數量、正規化 question/answer、citation binding 一一相同；非 FAQ body 不得憑空提供 FAQ pairs。

Provider output 的 provenance 必須 echo server request metadata：provider、model、requestId、requestedAt 必須相同，prompt/content/retrieval fingerprints 必須分別等於本次實際 pack、normalized input、verified retrieval。不得由 client/provider output 反向覆蓋 request provenance。

## Markdown structure parser

`parseMarkdownStructure()` 使用 fenced-code state，不把 code fence 內 heading 當正文 heading；它解析 title/H1、H2/H3 levels、heading jump、empty section、NFKC/case/whitespace/punctuation-normalized duplicate headings、first meaningful paragraph/direct-answer-first、duplicate meaningful paragraphs、FAQ pairs/duplicate questions、固定 `[cite:ID]` marker placement、conclusion/CTA、template filler、zh-hant simplified-character signal 與 paragraph identities。

`[cite:ID]` 是唯一正式 inline citation marker；裸 `[ID]` 不再視為 citation marker。Parser 只回報結構與 coverage signals，不宣稱語意真實性。

## Deterministic heuristic quality gates

`evaluateContentQuality()` 只輸出 `passed`、`needs_human_review` 或 `blocked`，且 `humanReviewRequired` 永遠為 true。它先驗證 input、verified retrieval、provider output 與 provider body/Markdown exact binding，再評估 evidence、claim safety、structure、governance、risk、conflict 與 content operational bounds。

`sourceCoverage`、`claimCoverage`、`citationCoverage`、`goalCoverage` 都是固定名稱 `deterministic heuristic / coverage metric` 的 coverage objects，包含 `applicable`、`numerator`、`denominator`、`ratio` 與 reason codes。denominator 為 0 時 `applicable = false`、`ratio = null`；不會把 not-applicable 當作 100%，也沒有總品質分數。

| Result class | V1 boundary |
|---|---|
| `blocked` | malformed input/provider、evidence hash/snapshot/purpose/status、retrieval not-ready/outside allowlist、content/body/response hash、citation/claim binding、provider provenance、FAQ/body mismatch、forbidden fabricated case、performance guarantee、unsupported quantitative claim 等 integrity/safety failure |
| `needs_human_review` | source coverage insufficient、conflicting evidence、medical/legal/financial risk、content length、topic overlap、direct answer、heading/duplicate/template/locale/selected-rule heuristic concern |
| `passed` | 只表示 bounded deterministic checks 未發現阻斷或 review reason；仍必須人工審查 |

Content operational bounds 為 V1 bounded heuristic，不是 Google、AutoGEO 或 GEOFlow 官方排名標準：article 英文至少 600、最多 4000 words；zh-hant 至少 1000、最多 8000 effective characters；service page 英文至少 350、最多 2500 words；zh-hant 至少 700、最多 5000 effective characters；FAQ 必須 3–20 組，英文 answer 至少 25 words、zh-hant answer 至少 40 effective characters，且所有 answer 有上限。不得用重複段落、重複 FAQ 或 keyword stuffing 滿足長度。`workingTitle` 必須與 H1 normalized identity 相同；body 與 topic/primaryQuestion 必須有 deterministic lexical overlap；selected rule 的 required deterministic check 失敗不得 passed；`qualityGateIsPublishApproval()` 永遠為 false。

## URL and timestamp boundary

URL guard 拒絕非 HTTPS、credentials、非 443 port、單一 hostname、localhost、`.local`、`.internal`、`.localhost`、`.onion`、private/loopback/link-local/multicast/reserved/documentation/CGNAT IPv4、IPv6 loopback/link-local/unique-local/IPv4-mapped private/special-use ranges，以及 URL-decoded query parameter name `token`、`secret`、`key`、`api_key`、`apikey`、`access_token`、`signature`、`sig`、`credential`、`password`。不得 DNS lookup 或 network request。

Timestamp 必須是嚴格 RFC3339、含 `Z` 或明確 offset、calendar date 有效、offset 合理，並正規化為 UTC ISO。evidence `capturedAt` 不得晚於 request `requestedAt`；future evidence 拒絕；provider `generatedAt` 不得早於 `requestedAt`。

## Fixed reason-code governance

所有 reason codes 都來自 server-side fixed catalog，包含 input/hash/timestamp/evidence、query/retrieval、prompt/provider、citation/paragraph/FAQ、structure/locale、quality/risk/metric 類別，例如 `EVIDENCE_CHUNK_HASH_MISMATCH`、`QUERY_FINGERPRINT_MISMATCH`、`RETRIEVAL_NOT_READY`、`PROVIDER_OUTPUT_MALFORMED`、`PROVIDER_PROVENANCE_MISMATCH`、`RESPONSE_HASH_MISMATCH`、`PARAGRAPH_BINDING_MISMATCH`、`FAQ_BODY_MISMATCH`、`CONTENT_LENGTH_OUT_OF_BOUNDS`、`CONTENT_TOPIC_MISMATCH`、`CONFLICTING_EVIDENCE`、`SOURCE_COVERAGE_INSUFFICIENT`、`RULE_CHECK_FAILED` 與 `METRIC_NOT_APPLICABLE`。未知 reason code 不可由 caller 注入。

## Testing and limitations

`tests/geo-content-quality-prompt-rag.test.ts` 使用完全 synthetic fixtures，所有測試直接呼叫正式 public functions，沒有真實網站內容或 provider call。Targeted suite 目前有 **178 direct tests**，涵蓋 strict input/evidence/hash/timestamp/URL、topic/query fingerprint、English/CJK lexical retrieval、topK/allowlist/zero relevance、canonical JSON prompt injection boundary、canonical GEO rule resolution、provider provenance/responseHash、paragraph/citation/FAQ binding、Markdown structure、0/0 metrics、content length、topic overlap、risk/conflict、blocked/review/passed status 與 mandatory human review。

這是 evidence-bound contract、mocked structured output validator、pure lexical retrieval、Markdown parser 與 deterministic heuristic gate，不是 Qwen/百煉接入、不是真實 semantic RAG、不代表已使用 GEOFlow、不代表已產生或發布高品質文章，也不表示 GEO、排名、流量、轉換、ROI 或 LLM citation 已提升。Evidence 與 authority 的內容正確性仍需 owner/human review。V1 不做完整 semantic PII anonymization、不做 durable retrieval persistence、不接 scheduler、API、database 或 UI。

## Verification and delivery boundaries

在 `nuxt-app` 執行：

```bash
pnpm install --frozen-lockfile
pnpm typecheck
pnpm vitest run tests/geo-content-quality-prompt-rag.test.ts
pnpm vitest run tests/geoflow-integration-contract.test.ts tests/geo-content-quality-prompt-rag.test.ts tests/seo-geo*.test.ts tests/geo-workbench.contract.test.ts tests/llm*.test.ts tests/market-intelligence-signal-engine.test.ts tests/authority-source-policy-engine.test.ts
NODE_OPTIONS=--max-old-space-size=1536 NITRO_PRESET=node-server pnpm build
```

Build 後只清理 fresh isolated worktree 內的 `.nuxt`、`.output`、`.nitro`，並保留 tracked `nuxt-app/dist` symlink。另執行 `git diff --check`、allowed-path、package/lockfile unchanged、既有 database/migration/API/UI unchanged、secret/private-key、network/provider/database static scan 與 clean worktree checks。

Full Vitest 固定為 `NOT RUN`，理由是避免觸發既有外部 credential validation。Migration、Deploy、Real provider/API calls 與 External content write 固定為 `NOT RUN`、`NOT RUN`、`NONE`、`NONE`。

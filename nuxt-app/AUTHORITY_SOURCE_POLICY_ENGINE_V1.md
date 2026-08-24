# Authority Source Policy Engine V1

## 這是什麼

Authority Source Policy Engine V1 是一個 **server-side TypeScript、deterministic、offline、fail-closed** 的來源資格判斷核心。它接受已經由治理流程整理的來源 metadata，正規化可比較欄位、驗證 metadata hash，然後判斷某個來源是否適合指定客戶產業、內容主題、locale、jurisdiction 與用途。

輸出是明確的 `approved`、`review_required`、`not_ready` 或 `blocked` 決策，並附上 authority tier、matched sectors/topics、reason codes、limitations、source hash 與 deterministic fingerprint。只有 `approved` decision 可以回傳非空 `allowedPurposes`；`review_required`、`not_ready` 與 `blocked` 的 `allowedPurposes` 永遠是 `[]`。相同輸入會產生相同輸出與穩定的多來源排序。

## 這不是什麼

本 V1 不是爬蟲、文獻搜尋器、自動發布器、來源全文品質評分器或 LLM 推論器。它不會因為網域知名就自動核准，也不會使用模糊分數猜測來源品質；authority tier 只是政策分類，不能繞過 relevance、hash、授權、terms、著作權、PII、jurisdiction 或高風險複核規則。

`approved` **不代表內容為真**，也不代表搜尋排名、LLM 一定引用、流量、轉換或 ROI。輸出不提供法律、醫療或投資建議。

## Input / output contract

單來源 request 必須包含固定欄位：

```ts
interface AuthorityPolicyRequest {
  purpose: 'research_reference' | 'content_citation' | 'evidence_support' | 'model_evaluation' | 'model_training'
  clientSector: string
  contentTopics: string[]
  targetLocale: 'en' | 'zh-hant'
  targetJurisdiction: string | null
  workflowMode: 'manual_review' | 'automated_ingestion'
  asOf: string
  candidate: AuthoritySourceCandidate
}
```

`AuthoritySourceCandidate` 包含來源識別、公開 HTTPS URL、publisher domain、source type、sectors、topics、locale、jurisdiction、publisher、日期、licence、terms、robots、copyright、PII、access method、evidence locator 與 `sourceHash`。所有文字採 NFKC、trim 與連續 whitespace 合併；用於比較的 sector、topic、domain 轉為 lowercase；陣列會去空值、去重並 stable sort。

輸出至少包含 `status`、`authorityTier`、`allowedPurposes`、`matchedSectors`、`matchedTopics`、`reasonCodes`、`limitations`、`policyVersion`、`sourceId`、`sourceHash` 與 `decisionFingerprint`。多來源輸出包含 `selected`、`reviewRequired`、`blocked`、整體 `status`、limitations 與 `selectionFingerprint`；`selected` 永遠只含 `approved`。

## Hash contract

`canonicalAuthoritySourcePayload(candidateWithoutHash)` 只保留正規化後的來源 metadata，排除 `sourceHash`，也不包含衍生的 decision、limitations 或 fingerprint。`authoritySourceHash(candidateWithoutHash)` 對該 canonical payload 的 stable serialization 計算 SHA-256。陣列輸入順序不影響 hash；大寫 SHA-256 hex 會先正規化為 lowercase。

任何 metadata 改變而未同步更新 hash 都會產生 `SOURCE_HASH_MISMATCH` 並回傳 `blocked`。不符合 64 字元 SHA-256 hex 的值產生 `INVALID_SOURCE_HASH`。URL 必須是公開 HTTPS，不得含帳密、private/loopback/link-local/reserved 位址或保留 hostname；非 IP hostname 必須至少包含一個 `.`，因此單一 hostname 一律拒絕；`.onion` 及其子網域也一律拒絕；`publisherDomain` 必須與 URL hostname 精確一致。不進行 DNS lookup 或 network request。

日期必須是帶 `Z` 或明確 offset 的 ISO datetime，並保存為 UTC ISO。非 null 日期必須符合 `publishedAt <= updatedAt <= capturedAt <= asOf`；不能用假日期取代缺失的 null metadata。

## Source tier

| Tier | Source types |
|---|---|
| `primary` | `government`、`standards_body`、`peer_reviewed_paper` |
| `high` | `academic_institution`、`professional_association`、`first_party_expert` |
| `contextual` | `preprint_repository`、`industry_publication`、`news` |
| `weak` | `commercial_blog`、`community`、`social` |
| `ineligible` | malformed 或未知 source type |

Tier 不代表 truth score，也不能繞過來源 relevance、hash、licence、terms、copyright、PII、jurisdiction 或高風險產業規則。

## arXiv 與 preprint 限制

`arxiv.org` 與所有 `.arxiv.org` 子網域只能在 metadata `sourceType` 為 `preprint_repository` 時被辨識為 preprint repository，且仍需有 sector 或 topic relevance；`export.arxiv.org`、`subdomain.arxiv.org` 等子網域不得繞過規則。所有 arXiv/preprint 都附帶 `preprint_not_peer_reviewed` limitation；本 engine 不得把 preprint 描述成已完成同儕審查。

一般技術或 AI 主題的 preprint 在 `research_reference` 且治理欄位完整時可以 `approved`。在 healthcare、medical、medicine、pharmaceutical、legal、law、finance、financial services、investment 或 insurance 等高風險產業，用於 `content_citation` 或 `evidence_support` 時至少 `review_required`。

## 高風險產業與 fail-closed 政策

以下情況一律 `blocked`：malformed input、invalid URL、domain mismatch、invalid 或 mismatch source hash、`copyrightRisk: blocked`、`piiStatus: restricted`、`model_training`、automated ingestion 搭配 automation prohibition 或 robots restriction，以及 sector 與 topic 都沒有 relevance match。

以下情況至少 `review_required`：licence 或 terms unknown/restricted、copyright high/unreviewed、PII possible/unreviewed、automated ingestion 的 robots 未審查、manual review 的 robots restriction、preprint 高風險用途、weak source 用於 evidence support、jurisdiction 不一致，以及缺少可支持時效性主張的來源日期。

固定 reason codes 包含 `INVALID_INPUT`、`INVALID_SOURCE_URL`、`SOURCE_DOMAIN_MISMATCH`、`INVALID_SOURCE_HASH`、`SOURCE_HASH_MISMATCH`、`COPYRIGHT_BLOCKED`、`PII_RESTRICTED`、`MODEL_TRAINING_NOT_SUPPORTED_V1`、`AUTOMATION_PROHIBITED`、`ROBOTS_RESTRICT_AUTOMATION`、`NO_RELEVANCE_MATCH`、`LICENCE_REVIEW_REQUIRED`、`TERMS_REVIEW_REQUIRED`、`COPYRIGHT_REVIEW_REQUIRED`、`PII_REVIEW_REQUIRED`、`ROBOTS_REVIEW_REQUIRED`、`PREPRINT_REQUIRES_EXPERT_REVIEW`、`WEAK_SOURCE_FOR_EVIDENCE`、`JURISDICTION_REVIEW_REQUIRED` 與 `RECENCY_REVIEW_REQUIRED`。

## Multi-source selection ordering

`selectAuthoritySources` 最多接受 50 筆 candidate，`maxSelected` 必須是 1 至 10 的整數，且每筆都以相同的 `evaluateAuthoritySource` 規則判斷。當 `candidates.length > 50` 時，engine 在任何 candidate sort、欄位讀取、hash 或 evaluate 之前立即回傳 `rejected`，所有輸出 decision arrays 都是空陣列，並加入 `MAX_CANDIDATES_EXCEEDED` limitation；不會讀取或處理第 51 筆或其他 candidate 欄位。malformed candidate 不會被靜默忽略。相同 normalized `sourceId` 或相同 `sourceHash` 視為 duplicate，重複項目會以 `DUPLICATE_SOURCE` fail closed。

穩定排序依序是：`approved`、`review_required`、`not_ready`、`blocked`；接著是 `primary`、`high`、`contextual`、`weak`、`ineligible`；再接著是 matched topic 數量由多到少；最後是 sourceId 字典序。`selected` 不會用 review_required 補位；approved 不足時整體 status truthful 並說明不足。selection fingerprint 共同納入 policy version、normalized request context、stable ordered decision fingerprints 與 `maxSelected`，所以 candidates 原始順序不影響結果。

## Limitations

本 V1 的 decision 是來源治理資格結果，不是內容真值或效果預測。它不判斷全文是否正確，不保證任何搜尋曝光或 LLM 引用，不預測流量、轉換或 ROI，也不取代法律、醫療或投資專業意見。來源的 licence、terms、robots、copyright、PII 與 jurisdiction metadata 必須由適當治理流程提供；欄位未知時本 engine 不會自行猜測。

本 engine 只讀取呼叫者傳入的 metadata，不讀環境、資料庫或檔案，不發出 network request，也不自動取得 arXiv 或任何其他網站內容。所有 decision 與 selection 都是 deterministic pure output。

## V1 不含的功能

V1 不含來源擷取、crawler、scraping、全文儲存、文獻自動搜尋、LLM 品質判斷、主張真偽驗證、consumer LLM 曝光驗證、自動發布、資料庫 schema、migration、API route、deploy 或 production integration，也不含模型訓練。

## 未來分層接入

未來可由 **Diagnosis** 先產生客戶產業、內容主題、locale、jurisdiction、用途與 workflow context；再由 **AutoGEO Strategy** 將治理後的來源 metadata 交給本 engine，取得可追溯的 decisions 與 selection fingerprint；最後由 **GEOFlow Production** 在明確的人工作業與既有發布閘門中消費 `approved` 結果。這些是未來的分層接入方向，本輪沒有修改 Diagnosis、AutoGEO Strategy 或 GEOFlow Production runtime，也沒有完成 production integration。

任何下游接入都必須保留 reason codes、limitations、source hash 與 fingerprint，並不得把結果改稱搜尋排名、LLM 引用、流量、轉換或 ROI 預測。

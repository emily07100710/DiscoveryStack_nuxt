# GEO ENGINEERING SPEC v2.0

**文件性質：Production Engineering Baseline**  
**版本日期：2026-08-29**  
**目標：建立世界頂規、可驗證、可持續學習的 AI Search / GEO Infrastructure**

---

## 0. 規格語言

本文件中的關鍵字定義如下：

- **MUST**：未完成即不得算完成，屬驗收阻擋項。
- **SHOULD**：預設必須完成；若不做，必須留下 Architecture Decision Record（ADR）說明理由與替代方案。
- **MAY**：可依場景選配。
- **EXPERIMENTAL**：尚未證明是穩定引用或排名訊號，不得包裝成保證效果。

P0／P1／P2 代表工程優先順序，不代表功能重要性的永久高低。

---

# 1. 產品定義

本專案不是 Schema 外掛、FAQ 產生器、llms.txt 產生器，也不是大量生成內容的 SEO 工具。

本專案要建立的是一個多租戶、可觀測、可驗證、可回滾的：

# GEO Control Plane + Knowledge Infrastructure + AI Visibility Observatory

完整閉環：

```text
Discover
→ Access
→ Render
→ Understand
→ Verify
→ Retrieve
→ Cite
→ Visit
→ Convert
→ Learn
→ Improve
```

平台必須回答以下問題：

1. 哪些 AI crawler 可以進入網站？
2. 哪一層正在阻擋 crawler：robots、CDN、WAF、應用程式、驗證、限流或 JavaScript？
3. crawler 第一次收到的 HTML 是否包含真正內容？
4. 網站的 Entity、Author、Claim、Source 是否一致、可信且沒有互相矛盾？
5. 哪些平台、主題、語言和 Prompt 正在引用網站？
6. 競爭者被引用的內容類型與證據模式是什麼？
7. 哪一個工程或內容修改之後，crawler、citation、referral 和 conversion 發生了什麼變化？

本平台不得承諾「保證被 AI 引用」。外部搜尋與生成系統的檢索、排序和回答均不受本平台控制。平台的責任是：

- 提升被發現、取得、理解與驗證的資格與機率。
- 找出可修正的阻礙。
- 建立可重複的測量方法。
- 以實驗資料判斷哪些介入真正有效。

---

# 2. 不可妥協的原則

## 2.1 不做假 GEO

MUST NOT：

```text
hidden AI text
white text
bot-only content
cloaking
fake author
fake credentials
fake citations
fake review
fake statistics
fake update dates
fake Reddit mentions
scaled doorway pages
consumer UI scraping without written permission
```

## 2.2 人與機器使用同一份事實來源

HTML、JSON-LD、CSV、JSON、API、Markdown 與 llms.txt 必須由同一套 Content／Entity／Claim 資料來源產生。

禁止：

```text
人類看到 A
crawler 看到 B
API 回傳 C
```

## 2.3 API Surface 不等於 Consumer Surface

OpenAI API Web Search、Claude API Web Search、Perplexity API 與各平台消費者產品的搜尋介面，必須視為不同 measurement surface。

不同 surface 的結果不得混在同一個指標中，除非報表明確分層。

## 2.4 所有自動修改必須可預覽、核准、稽核與回滾

任何會改變下列項目的動作都必須先產生 Change Set：

```text
robots.txt
WAF rules
canonical
redirect
schema
sitemap
content
internal links
IndexNow submission
public API output
```

Change Set 必須包含：

```text
before
proposed_after
reason
risk
affected_urls
validation_plan
rollback_plan
approved_by
applied_at
```

---

# 3. 2026 平台政策基線

平台必須將 crawler 按用途拆分，不得把「搜尋」、「模型訓練」、「使用者即時讀取」與「廣告驗證」混為一談。

| Vendor | Search / Discovery | Model training | User-triggered fetch | 其他 |
|---|---|---|---|---|
| OpenAI | OAI-SearchBot | GPTBot | ChatGPT-User | OAI-AdsBot |
| Anthropic | Claude-SearchBot | ClaudeBot | Claude-User | — |
| Perplexity | PerplexityBot | 依官方政策 | Perplexity-User | — |
| Google | Googlebot + Search Console generative AI control | Google-Extended 管理不同用途 | Browser / agent surface 分開測試 | Ads crawler 分開 |
| Microsoft | Bingbot | 依官方政策 | Copilot surface 分開測試 | IndexNow / Bing Webmaster Tools |

工程上必須允許客戶分別選擇：

```text
Allow search discovery
Allow model training
Allow user-directed fetch
Allow ads validation
```

不得把 `Google-Extended = Allow` 當成 Google AI Overviews 或 AI Mode 的必要條件。Google Search 的搜尋資格以 Googlebot、索引資格與 Search Console 相關控制為準。

llms.txt 可作相容層，但不得宣稱它對 Google Search 有特殊排名或 AI Search 加權。

FAQ 內容仍可保留給使用者，但不得把 FAQPage Rich Result 當作核心策略。

平台政策資料必須版本化，並保留：

```text
provider
policy_version
source_name
reviewed_at
next_review_at
change_summary
```

---

# 4. 系統總體架構

```text
Customer Website / CMS / Git / CDN / WAF / Analytics
                         │
                         ▼
┌──────────────────────────────────────────────────────┐
│ Connector & Verification Layer                       │
│ DNS / HTML verify / Cloudflare / WAF / GSC / Bing   │
│ GA4 / CMS / GitHub / Nginx / Vercel / Render logs   │
└──────────────────────────────────────────────────────┘
                         │
                         ▼
┌──────────────────────────────────────────────────────┐
│ Crawl & Edge Observability Plane                      │
│ Bot identity / robots / WAF / HTTP / raw HTML / JS   │
│ URL inventory / sitemap / canonical / indexability   │
└──────────────────────────────────────────────────────┘
                         │
                         ▼
┌──────────────────────────────────────────────────────┐
│ Knowledge & Publishing Plane                         │
│ Content / Entity Graph / Claim Ledger / Source Graph │
│ Author / Dataset / Schema / Public API / versioning  │
└──────────────────────────────────────────────────────┘
                         │
                         ▼
┌──────────────────────────────────────────────────────┐
│ AI Visibility Observatory                            │
│ Prompt benchmark / provider adapters / citations     │
│ competitors / referrals / conversions / freshness    │
└──────────────────────────────────────────────────────┘
                         │
                         ▼
┌──────────────────────────────────────────────────────┐
│ Intervention & Learning Plane                         │
│ recommendations / change sets / experiments / lift   │
│ decay detection / refresh queue / outcome dataset    │
└──────────────────────────────────────────────────────┘
```

## 4.1 Reference Stack

可採以下基準，但工程團隊可用 ADR 替換：

```text
Control Plane UI/API: Nuxt 3 + Nitro
OLTP / Knowledge Core: PostgreSQL + Drizzle
Event Analytics: ClickHouse 或等價 columnar warehouse
Queue / Workflow: Temporal、Cloud Tasks 或可靠 queue worker
Cache / Locks: Redis
Object Storage: S3-compatible storage
Telemetry: OpenTelemetry + metrics/logs/traces backend
```

架構原則：

- 初期採 **modular monolith + independent workers**，不要為了看起來高級而過早微服務化。
- Control Plane 與 high-volume telemetry ingestion 必須有清楚邊界。
- 所有跨模組事件必須有版本化 schema。
- Graph 第一版以 PostgreSQL adjacency tables 建立；只有實際查詢與規模證明需要時才導入專用 graph database。

---

# 5. Multi-Tenant、權限與網站驗證

## 5.1 Tenant Isolation

MUST：

- 所有業務資料含 `tenant_id`。
- 資料庫使用 Row-Level Security 或等價隔離。
- Object storage 路徑以 tenant 隔離。
- Cache key、queue payload、trace context 都必須包含 tenant scope。
- 自動化測試必須包含 cross-tenant leakage 測試。

## 5.2 RBAC

至少支援：

```text
Owner
Admin
Engineer
SEO / GEO Analyst
Editor
Reviewer
Viewer
```

其中：

- 修改 crawler policy、WAF、redirect、public API、production content 必須具備特定權限。
- 高風險網站可要求雙人核准。

## 5.3 Site Ownership Verification

任何 production write action 前，網站必須完成擁有權驗證。

優先順序：

```text
1. DNS TXT
2. HTML verification file
3. Meta tag
4. Approved connector ownership
```

驗證必須定期重新確認；驗證失效後立即停用所有寫入權限，但保留唯讀歷史資料。

---

# 6. Connector Layer

至少支援下列接入類型：

## Edge / WAF / Server Logs

```text
Cloudflare Logpush / API
AWS WAF
Akamai
Fastly
Nginx
Apache
Vercel
Netlify
Render
generic S3 log import
signed webhook ingestion
```

## Search / Analytics

```text
Google Search Console
Bing Webmaster Tools
GA4
server-side referral and conversion events
```

## Content / Deployment

```text
GitHub
CMS webhook
WordPress
headless CMS
custom REST / webhook connector
```

單一 JavaScript snippet 不足以觀察 CDN 或 WAF 在 edge 層做出的決策。若客戶只安裝前端 snippet，UI 必須清楚標示：

```text
Edge visibility: unavailable
WAF decision visibility: unavailable
Crawler requests blocked before application: not observable
```

Connector 必須具備：

```text
least-privilege scopes
encrypted credentials
health status
last successful sync
last error
backfill cursor
rate limit handling
idempotency
audit trail
```

---

# 7. AI Bot Policy Engine

## 7.1 Policy Model

每個 crawler 身分必須保存：

```text
vendor
bot_name
purpose: search | training | user_fetch | ads | general_search
robots_token
user_agent_patterns[]
verification_method
official_identity_source
policy_source_version
last_identity_refresh_at
```

每個 site 可設定：

```text
site-level default
path-level override
environment override
locale override
allow / disallow
crawl-delay when supported
policy reason
approved_by
```

## 7.2 robots.txt Generator

robots.txt 必須由 policy engine 產生，而不是散落在模板裡手寫。

範例政策：

```txt
User-agent: OAI-SearchBot
Allow: /

User-agent: GPTBot
Disallow: /

User-agent: Claude-SearchBot
Allow: /

User-agent: Claude-User
Allow: /

User-agent: ClaudeBot
Disallow: /

User-agent: PerplexityBot
Allow: /

User-agent: Googlebot
Allow: /

User-agent: Google-Extended
Disallow: /

Sitemap: https://example.com/sitemap.xml
```

此範例不得硬編碼成所有客戶預設；Google-Extended、training bots 與 user-triggered fetch 必須由客戶政策決定。

Generator 必須提供：

```text
syntax validation
precedence simulation
path tester
before/after diff
staging preview
production rollback
```

---

# 8. Crawler Identity、WAF 與 Gateway

## 8.1 不信任 User-Agent

Crawler identity 狀態：

```text
verified
unverified
spoofed
unknown
stale_verification
```

驗證方式依供應商使用：

```text
User-Agent + official IP range
reverse DNS + forward DNS
provider verified-bot signal
signed provider metadata when available
```

官方 IP range 必須定期抓取，支援 ETag／Last-Modified，並以 atomic update 更新。若身分資料過期，不得繼續把流量標記為 verified。

## 8.2 WAF Allow 原則

Verified crawler 也不得取得全面信任。

允許規則最多只能：

```text
GET / HEAD
public content paths
crawler-specific rate limit
skip inappropriate browser challenge
```

不得：

```text
bypass application authorization
access admin / preview / internal routes
execute POST / PUT / PATCH / DELETE
read tenant-private content
receive user session or credentials
bypass all rate limiting
```

## 8.3 Crawler Event Schema

```json
{
  "event_id": "evt_...",
  "tenant_id": "tenant_...",
  "site_id": "site_...",
  "occurred_at": "2026-08-29T00:00:00Z",
  "vendor": "openai",
  "bot_name": "OAI-SearchBot",
  "bot_purpose": "search",
  "identity_status": "verified",
  "identity_source_version": "...",
  "method": "GET",
  "host": "example.com",
  "path": "/research/geo-benchmark",
  "normalized_url": "https://example.com/research/geo-benchmark",
  "edge_status": 200,
  "origin_status": 200,
  "response_time_ms": 142,
  "response_bytes": 48392,
  "cache_status": "HIT",
  "country": "US",
  "robots_decision": "allow",
  "waf_decision": "allow",
  "waf_rule_id": "rule_...",
  "challenge_type": null,
  "rate_limit_decision": "allow",
  "trace_id": "trace_..."
}
```

Query string 預設必須移除或依 allowlist 保存，避免收集 token、email、搜尋字詞或個資。

## 8.4 Dashboard

至少顯示：

```text
Verified AI crawler requests
Successful 2xx rate
403 / 404 / 429 / 5xx rate
WAF challenge rate
Crawler by vendor and purpose
Top crawled URLs
Never-crawled priority URLs
Last verified crawl
Response latency
Cache hit rate
robots allow but WAF deny mismatch
spoofed bot traffic
```

---

# 9. URL Inventory、Crawlability 與 Rendering

## 9.1 URL Inventory

URL 必須從多來源合併：

```text
sitemaps
CMS
internal crawl
server logs
Search Console
Bing Webmaster Tools
analytics
public API inventory
```

每個 URL 保存：

```text
canonical_url
locale
page_type
content_id
indexability
robots state
http status
canonical target
hreflang set
sitemap membership
last substantive modification
last human crawl
last verified crawler crawl
```

## 9.2 Raw HTML Requirement

所有核心內容頁的第一次 HTML response 必須含：

```text
<title>
meta description
canonical
H1
main content
Direct Answer when applicable
author
published / modified dates
sources or evidence section
internal links
JSON-LD when applicable
```

核心內容不得依賴：

```text
empty shell
→ JavaScript boot
→ API fetch
→ client-only body
```

## 9.3 Raw vs Rendered Diff

平台必須同時保存：

```text
raw HTML snapshot metadata
rendered DOM snapshot metadata
main-content extraction
content hash
link set
structured data set
```

偵測：

```text
raw HTML missing main content
client render changes canonical
client render changes noindex
JS-only internal links
hydration error
content mismatch
bot-only content
```

## 9.4 Canonical 與 URL Normalization

Canonical 以「相同或高度重複內容」為單位，不是強迫一個概念只能有一頁。

正確模型：

```text
Query
→ Intent Cluster
→ Content Purpose
→ Locale
→ Primary URL
```

必須處理：

```text
http → https
www / non-www
trailing slash
UTM and tracking params
sort / filter params
pagination
locale / hreflang
duplicate category paths
redirect chains
soft 404
```

## 9.5 Sitemap

MUST：

- 自動產生 sitemap 或 sitemap index。
- 只放 canonical、可索引的 URL。
- `lastmod` 只在實質內容更新時改變。
- sitemap 與 URL inventory 每日對帳。
- deleted、redirected、noindex URL 必須從 active sitemap 移除。

---

# 10. Knowledge Core：Entity Graph

Entity Graph 是內容一致性與 provenance 基礎，不得宣稱它本身是排名捷徑。

## 10.1 Entity Types

至少支援：

```text
Person
Organization
Brand
Product
Service
Concept
Topic
Location
Author
Research
Dataset
Claim
Source
Article
Question
Event
Statistic
```

## 10.2 Entity Fields

```text
id: immutable UUID / ULID
entity_type
canonical_name
aliases[]
slug
canonical_uri
locale
summary
status
public_visibility
external_ids[]
provenance
created_at
updated_at
```

Entity ID 永遠不得重用。

## 10.3 Edges

```text
subject_entity_id
predicate
object_entity_id
valid_from
valid_to
source_id
verification_status
reviewed_by
```

常見關係：

```text
Person → worksFor → Organization
Article → about → Topic
Article → authoredBy → Person
Claim → supportedBy → Source
Service → offeredBy → Organization
Research → supports → Claim
Question → answeredBy → Article
Article → mentions → Entity
Dataset → producedBy → Organization
```

## 10.4 Entity Resolution

MUST：

- deterministic matching 優先。
- alias、external ID、domain、author profile 等證據分開保存。
- 高風險 merge 進 review queue。
- 所有 merge／split 可回溯。
- 不得因名稱相同就自動合併人物或公司。

## 10.5 Public Entity Pages

Internal entity 一律可存在；Public entity page 只有在對人類有實質價值時才發布。

不得為每個 entity 自動生成只有名稱與兩句描述的 thin page。

---

# 11. Claim Ledger / Evidence Graph

不要為每一句普通敘述建立昂貴 claim workflow。完整 Claim Ledger 優先用於：

```text
statistics
pricing
laws and regulations
medical / financial / legal claims
product capabilities
research findings
competitive comparisons
first-party measurements
time-sensitive facts
```

## 11.1 Claim Model

```json
{
  "claim_id": "claim_000123",
  "statement": "...",
  "claim_type": "statistic",
  "materiality": "high",
  "risk_level": "medium",
  "entity_ids": [],
  "valid_from": "...",
  "valid_to": null,
  "verification_status": "source_backed",
  "verified_at": "...",
  "expires_at": "...",
  "reviewed_by": "user_...",
  "locale": "zh-TW"
}
```

避免使用未校準的 `confidence: 0.95`。第一版使用可解釋狀態：

```text
unverified
source_backed
independently_confirmed
first_party_measured
disputed
expired
retracted
```

## 11.2 Evidence Relationship

Claim 與 Source 為 many-to-many：

```text
supports
contradicts
contextualizes
supersedes
```

Evidence 必須保存：

```text
source_id
locator: page / section / paragraph / table / URL fragment
retrieved_at
source_version
content_hash
review_notes
```

除非有授權，不得任意保存完整受著作權保護的來源全文。優先保存 metadata、locator、hash、必要摘錄與合法快照。

## 11.3 Impact Engine

當 Entity、Claim 或 Source 改變時，系統必須列出：

```text
affected content
affected schema
affected datasets
affected public API output
affected benchmark prompts
required reviewers
```

---

# 12. Source Quality Graph

Source quality 不得只是一個神祕總分。

每個來源至少評估：

```text
source class
authority
primary vs secondary
independence
freshness
accessibility
retraction / correction status
jurisdiction
applicability
```

Source Class：

```text
official documentation
government
academic / peer-reviewed
primary research
first-party company data
major publication
secondary media
expert publication
blog
forum
social
unknown
```

高風險內容必須有 risk-specific evidence policy。例如法律內容不可只靠匿名部落格；產品自述可證明功能存在，但不能單獨證明產品優於競爭者。

---

# 13. GEO Content CMS

## 13.1 Content Model

每篇內容至少支援：

```text
id
title
slug
canonical_url
locale
page_type
intent
primary_query
query_cluster[]
primary_entity
related_entities[]
author
reviewer
direct_answer
structured_body_blocks[]
claims[]
sources[]
first_party_data
methodology
limitations
published_at
modified_at
refresh_policy
schema_types[]
internal_links[]
content_version
risk_level
status
```

## 13.2 Workflow

```text
draft
→ evidence review
→ editorial review
→ technical validation
→ approved
→ scheduled
→ published
→ superseded / archived
```

## 13.3 Page Standard

知識型頁面 SHOULD 支援：

```text
H1
Direct Answer
Key Takeaways
Detailed Explanation
Evidence / Data
Examples
Comparison
Methodology
Limitations
Sources
Author
Reviewed By
Published Date
Last Substantive Update
Change Log
```

Direct Answer 是為了閱讀與 retrieval clarity，不得強迫固定字數，也不得為 AI 故意切成大量短碎片。

## 13.4 Publish Gates

硬性阻擋項：

```text
missing canonical
accidental noindex
raw HTML missing body
missing required author
material high-risk claim without evidence
invalid structured data required by page type
broken primary sources
contradictory active claims
non-canonical page in sitemap
```

GEO Quality Score 不得單獨成為唯一 publish gate。

---

# 14. First-Party Research 與 Dataset Layer

CMS 必須原生支援：

```text
original research
dataset
survey
benchmark
experiment
case study
calculator
statistics
original chart
original image
original video
methodology
raw data
```

Dataset fields：

```text
dataset_id
name
description
version
license
creator
contributors
methodology
coverage
limitations
published_at
updated_at
files[]
checksums[]
citation_instructions
related_research
related_claims
```

公開格式 MAY 包含：

```text
CSV
JSON
XLSX
Parquet
HTML table
public API
```

所有格式必須對應同一 dataset version，並保留 checksum 與變更紀錄。

---

# 15. Structured Data Engine

JSON-LD 必須由 Content + Entity + Claim 資料模型產生，不得由工程師逐頁手動拼接。

至少支援：

```text
Organization
Person
ProfilePage
Article
BreadcrumbList
WebSite
WebPage
Dataset
Product
Service
LocalBusiness
VideoObject
ImageObject
```

MUST：

- `@id` 穩定。
- Author 指向真實 author page。
- Schema 內容與可見內容一致。
- `dateModified` 只在實質修改時改。
- 發布前執行 JSON syntax、Schema.org 與平台相關規則驗證。
- 保存 schema version 與 validation result。

不得建立不存在的作者、評價、價格、評分、證照或研究。

---

# 16. Publishing & Freshness Engine

Content publish/update/delete 使用事件驅動流程：

```text
1. validate content and claims
2. write immutable content version
3. regenerate HTML
4. regenerate JSON-LD
5. update URL inventory
6. update sitemap and truthful lastmod
7. update RSS / Atom
8. purge CDN
9. submit IndexNow when applicable
10. update public API / dataset outputs
11. create deployment log
12. enqueue recrawl validation
13. mark affected benchmark prompts
```

事件必須 idempotent，具 retry、dead-letter queue 與 replay 能力。

事件名稱示例：

```text
content.published.v1
content.updated.v1
content.deleted.v1
claim.changed.v1
source.expired.v1
entity.merged.v1
dataset.version_published.v1
```

IndexNow 只用於支援它的搜尋系統；不得把它包裝成 Google instant indexing。必須 debounce 同一 URL 的重複提交並記錄回應。

---

# 17. Query Graph 與 Internal Link Graph

## 17.1 Query Graph

資料模型：

```text
Query
→ Intent
→ Intent Cluster
→ Topic
→ Canonical Content
→ Supporting Content
```

Query fan-out 只用於理解使用者可能需要的子問題，不得自動為每個子 query 生成低價值頁面。

系統必須偵測：

```text
duplicate intent
keyword cannibalization
missing canonical page
coverage gaps
query without evidence-backed answer
commercial query without conversion path
```

## 17.2 Internal Links

推薦依據：

```text
entity relationship
intent relationship
topic hierarchy
claim dependency
research support
user journey
```

Dashboard：

```text
orphan pages
broken links
incoming / outgoing links
topic depth
click depth
weak clusters
entity without authoritative page
content without supporting research
```

第一版預設產生 recommendation，不自動插入 production links；自動插入必須走 Change Set。

---

# 18. AI Agent-Friendly Website

網站互動必須優先使用 native semantic HTML：

```text
button
input
select
textarea
form
label
fieldset
legend
nav
main
article
```

MUST：

- 所有 controls 有 accessible name。
- 表單欄位有 visible label。
- 錯誤訊息與欄位關聯。
- loading、expanded、selected、disabled、invalid 等狀態可被 accessibility tree 取得。
- 完整鍵盤操作。
- destructive action 有確認與可恢復策略。
- transaction API 具 idempotency key。
- 不使用 `<div onclick>` 取代真正 button。

## Agent Test Harness

使用瀏覽器自動化與 accessibility tree 測試：

```text
find product / service
search content
apply filter
submit contact form
book appointment
add to cart
complete a safe test checkout
recover from validation error
```

測試必須驗證任務成功、焦點管理、狀態回饋與錯誤復原，而不只是元素存在。

---

# 19. AI Visibility Observatory

## 19.1 Measurement Surface 分層

### A. First-Party / Official Measurement

```text
CDN / WAF / server logs
Google Search Console
Bing Webmaster Tools
GA4
server-side referral
server-side conversion
```

### B. Synthetic API Benchmark

```text
OpenAI web search API
Anthropic web search API
Perplexity search / agent API
other providers only after terms review
```

### C. Consumer Surface Observation

```text
manual or explicitly approved observation
separate dataset
separate methodology
never mixed with API benchmark
```

不得以未授權爬蟲大量刷 consumer UI。

## 19.2 Provider Compliance Registry

每個 provider/surface 必須保存：

```text
terms_version
allowed_storage
allowed_link_extraction
allowed_analysis
retention_limit
required_attribution
rate_limit
reviewed_by
reviewed_at
next_review_at
```

若服務條款不允許把 grounded links 拿來建立索引或 competitor citation database，該 surface 不得用於此用途。

## 19.3 Prompt Benchmark

Benchmark 分為：

```text
Frozen Core Set
Rotating Discovery Set
Campaign Set
Diagnostic Set
```

Prompt taxonomy：

```text
informational
commercial
comparison
recommendation
brand
non-brand
long-tail
local
research
transactional
navigational
support
```

每個 prompt 保存：

```text
prompt_id
prompt_version
language
country
persona / context when applicable
intent
topic
business_value
expected_entity_set
owned_target_urls[]
competitor_set[]
created_by
active_from
active_to
```

## 19.4 Benchmark Run

```text
run_id
prompt_id
surface
provider
model
model_version
country
language
account_state when applicable
timestamp
repeat_index
request_config_hash
response_storage_policy
response_hash
brand_mentioned
owned_url_cited
cited_urls[] when legally permitted
cited_domains[] when legally permitted
validity_status
error_type
latency
cost
```

同一 prompt 必須重複執行，並保留 run-level 結果。一次結果不得代表穩定趨勢。

## 19.5 Metrics

### Citation Coverage

```text
Unique prompts with ≥1 owned citation
--------------------------------------
Eligible unique prompts
```

### Run Citation Rate

```text
Valid runs with ≥1 owned citation
----------------------------------
All valid runs
```

### Brand Inclusion Rate

```text
Valid responses mentioning brand
---------------------------------
All valid responses
```

### Citation Share of Voice

```text
Owned citations
--------------------------------
Owned + tracked competitor citations
```

### Owned Source Citation Rate

```text
Responses citing an owned domain
--------------------------------
Responses citing any source
```

### Citation Freshness Lag

```text
First observed citation time
-
Last substantive content update time
```

另須顯示：

```text
citation stability
citation by platform
citation by topic
citation by language
top citation URLs
competitor source mix
sample size
confidence interval
measurement surface
```

樣本不足時顯示 `insufficient sample`，不得硬算看似精準的百分比。

---

# 20. Referral 與 Conversion Measurement

至少辨識：

```text
chatgpt.com
perplexity.ai
google
bing
copilot
claude-related referrers when observable
utm_source=chatgpt.com
```

保存：

```text
session_id
landing_url
referrer
utm fields
AI source classification
first-touch source
last-touch source
assisted-touch sources
conversion event
conversion value
consent state
```

報表分開顯示：

```text
AI referral sessions
engaged sessions
conversion rate
assisted conversions
revenue / lead value
landing pages
citation-to-referral lag when inferable
```

不能僅靠 referrer 宣稱所有 AI 影響；direct traffic、copy/paste 與隱私限制會造成不可觀測區域，報表必須標示限制。

---

# 21. Competitor Citation Intelligence

每個 citation URL 可分類：

```text
article
dataset
research
comparison
product page
forum
Reddit
YouTube
news
official documentation
tool / calculator
unknown
```

系統輸出應稱為：

# Why competitor may be winning

不得在沒有實驗或足夠證據時直接宣稱因果。

分析至少包含：

```text
source type distribution
first-party data presence
methodology presence
author transparency
freshness
claim evidence density
query intent fit
citation stability
```

---

# 22. Intervention & Experiment Engine

真正的資料護城河是：

```text
Site state
+
Intervention
+
Verified recrawl
+
Citation outcome
+
Referral outcome
+
Conversion outcome
```

## 22.1 Intervention Model

```text
intervention_id
site_id
intervention_type
hypothesis
target_urls[]
target_entities[]
target_claims[]
affected_prompts[]
baseline_window
change_set_id
go_live_at
verified_recrawl_at
post_window
control_group when available
owner
status
rollback_status
```

## 22.2 Experiment Rules

MUST：

- 先保存 baseline。
- 變更後確認實際 deployment。
- 確認 crawler 或搜尋系統已重新抓取後，才開始合理的 post-observation 解讀。
- 保留同期間外部事件與其他變更。
- 能設 control pages、control prompts 或 staggered rollout 時應使用。
- 沒有足夠設計時只報 correlation，不報 causal lift。

---

# 23. GEO Quality Score

GEO Quality Score 是 diagnostic score，不是外部平台排名預測器。

必須拆成：

```text
Technical Eligibility
Crawler Access
Content Integrity
Entity Consistency
Claim Evidence
Source Quality
First-Party Data
Author Transparency
Internal Linking
Freshness
Structured Data
Agent Accessibility
Measurement Readiness
```

每個分數需顯示：

```text
score
weight version
evidence
confidence
blockers
recommended action
```

權重必須版本化，並隨 Intervention → Outcome Dataset 校準。不得只顯示一個沒有解釋的 `87/100`。

---

# 24. Content Decay Detector

定期偵測：

```text
source 404 / redirect
source expired / retracted
statistics outdated
claim conflict
entity changed
price changed
law changed
API version changed
product feature changed
citation lost
competitor citation gained
traffic dropped
conversion dropped
orphan page
schema regression
crawler 403 / 429 spike
```

輸出 Refresh Queue：

```text
severity
business impact
affected pages
supporting evidence
suggested owner
due policy
recommended action
```

不得盲目把所有內容標記為「需要每天更新」。

---

# 25. Public Knowledge API 與 llms Compatibility

## 25.1 Public API

```text
GET /api/public/v1/entities/{id}
GET /api/public/v1/topics/{id}
GET /api/public/v1/research/{id}
GET /api/public/v1/datasets/{id}
GET /api/public/v1/claims/{id}
```

MUST：

```text
same source as HTML
versioned response
ETag / Last-Modified
stable IDs
rate limiting
public-only fields
license and attribution where needed
no private or review-only data
```

## 25.2 llms.txt

MAY 提供：

```text
/llms.txt
/llms-full.txt
/article/{slug}.md
```

但必須標記為 experimental compatibility layer，並由 canonical content 自動生成。不得為 llms.txt 建立與 HTML 不一致的特殊內容。

---

# 26. 核心資料表

至少包含：

```text
tenants
users
tenant_memberships
sites
site_environments
site_verifications
connectors
connector_sync_runs
bot_identities
bot_identity_versions
bot_policies
robots_versions
waf_change_sets
crawler_events
url_inventory
crawl_snapshots
render_snapshots
sitemaps
entities
entity_aliases
entity_external_ids
entity_edges
sources
source_versions
claims
claim_evidence
content_items
content_versions
content_blocks
content_entities
content_claims
authors
reviews
datasets
dataset_versions
query_clusters
queries
internal_link_edges
prompts
prompt_versions
benchmark_runs
citations
competitors
referral_sessions
conversion_events
interventions
experiment_results
quality_score_versions
refresh_queue
audit_logs
```

Critical constraints：

- `tenant_id` 不得遺漏。
- Crawler events append-only。
- Published content versions immutable。
- Entity IDs immutable。
- Active canonical URL 在 site + locale 下不得重複。
- Claim 與 evidence 必須保留 version relation。
- Benchmark run 必須關聯 prompt version 與 surface version。
- Delete 使用 tombstone，避免 ID 被重用。

---

# 27. API 與 Event Contracts

內部 API 至少分為：

```text
/api/v1/sites
/api/v1/connectors
/api/v1/crawler-policies
/api/v1/crawl-audits
/api/v1/content
/api/v1/entities
/api/v1/claims
/api/v1/sources
/api/v1/datasets
/api/v1/benchmarks
/api/v1/competitors
/api/v1/interventions
/api/v1/reports
```

MUST：

```text
OpenAPI specification
Zod or equivalent schema as source of truth
idempotency keys for writes
signed webhooks
cursor pagination
request IDs
structured errors
versioned events
backward compatibility policy
```

---

# 28. Security 與 Compliance

## 28.1 URL Fetcher / Crawler Security

必須防止：

```text
SSRF
DNS rebinding
private IP access
cloud metadata access
infinite redirects
oversized responses
decompression bombs
malicious MIME
script execution
credential leakage
```

Fetch policy：

```text
public HTTP/HTTPS only
private/reserved networks denied
redirect limit
response size limit
timeout
content-type allowlist
no cookie reuse
no customer auth header by default
```

## 28.2 LLM Extraction Security

所有抓取內容視為不可信輸入。

MUST：

- 不執行頁面指令。
- 防 prompt injection。
- 使用 structured output schema。
- 將 extraction 與 privileged tools 隔離。
- 記錄 model、prompt version、input hash、output validation。
- 重要 entity merge、claim verification 不得只靠單次 LLM 判斷。

## 28.3 Secrets / Privacy

```text
KMS-backed encryption
least privilege OAuth scopes
secret rotation
PII redaction
configurable retention
data export / deletion
audit logging
regional storage policy when required
```

## 28.4 Terms Compliance

每個 provider connector 上線前必須完成 terms review。若條款改變，能停用特定資料收集功能，而不影響其他 observability 功能。

---

# 29. SLO 與 Operational Requirements

建議基準：

```text
Control plane availability: 99.9%
Crawler event ingestion P95: < 5 minutes
Internal publish event processing P95: < 5 minutes
Bot identity source refresh: at least daily
Stale identity alert: > 48 hours
Audit log coverage for production writes: 100%
Change Set rollback support: mandatory
Connector freshness timestamp: always visible
```

外部搜尋引擎何時重抓、索引或引用不屬於內部 SLO，不得對客戶承諾固定時間。

MUST 建立 runbook：

```text
crawler 403 spike
429 spike
connector token expiry
bad robots deploy
bad canonical deploy
sitemap corruption
schema regression
cross-tenant incident
benchmark cost spike
provider API outage
queue backlog
```

---

# 30. Testing Strategy

## Unit Tests

```text
robots precedence
URL normalization
canonical resolution
bot identity matching
source scoring rules
claim status transitions
content publish gates
metric formulas
```

## Integration Tests

```text
official bot IP source refresh
spoofed User-Agent detection
WAF decision ingestion
raw vs rendered comparison
sitemap reconciliation
schema validation
IndexNow retry / debounce
GSC / Bing / GA4 sync
```

## End-to-End Tests

```text
verify domain
connect logs
run crawl audit
create issue
create Change Set
approve and apply
validate recrawl
run benchmark
observe referral / conversion
rollback
```

## Security / Red-Team Tests

```text
cross-tenant data access
SSRF
DNS rebinding
malicious HTML prompt injection
poisoned source metadata
fake crawler UA
private route exposure
signed webhook replay
connector credential leakage
```

## Regression Fixtures

至少保留下列網站型態的 fixtures：

```text
SSR
SSG
ISR
client-only SPA
multilingual site
headless CMS
WordPress
ecommerce
local business
paywalled content
WAF-challenged site
```

---

# 31. 分階段工程優先順序

## PHASE 0 — Foundation

```text
multi-tenant auth and RBAC
site ownership verification
connector framework
secrets and audit logs
URL normalization service
event contracts
observability foundation
```

**Exit Gate：** 可安全連接一個 production 網域並只讀取得資料，且無 tenant leakage。

## PHASE 1 — Observe & Diagnose

```text
bot policy matrix
robots audit and generator
crawler identity verification
WAF / edge log ingestion
crawler dashboard
URL inventory
raw vs rendered audit
canonical / noindex / sitemap audit
GSC / Bing / GA4 integration
AI referral baseline
```

**Exit Gate：** 能清楚回答「crawler 在哪一層失敗、哪些重要頁不可取得、目前有哪些可驗證流量」。

## PHASE 2 — Knowledge & Publishing

```text
GEO CMS
Entity Graph
Claim Ledger
Source Quality Graph
Author pages
Structured Data Engine
Content versioning
Freshness Engine
Dataset / research support
public exports
```

**Exit Gate：** 一篇 production research page 能由同一資料源產生 HTML、Schema、API、Dataset，且每個重要 claim 可追溯。

## PHASE 3 — Observatory

```text
prompt registry
provider adapters
benchmark orchestration
citation normalization
competitor registry
statistical reporting
citation freshness
content decay
```

**Exit Gate：** Benchmark 可重複執行、surface 分層、結果有樣本數與不確定性，且符合 provider terms。

## PHASE 4 — Intervention Loop

```text
recommendation engine
Change Sets
experiment registry
verified recrawl gating
pre/post outcome analysis
refresh queue
quality score calibration
```

**Exit Gate：** 至少完成一次可稽核的 `Issue → Change → Recrawl → Citation/Referral/Conversion outcome` 閉環。

## PHASE 5 — Agent & Advanced Research

```text
ARIA / semantic audit
browser-agent task harness
Preferred Source module
advanced knowledge API
automated research workflow
cross-site intervention outcome models
```

**Exit Gate：** 核心互動任務可透過 accessibility tree 完成，且高風險動作具確認、冪等與稽核。

---

# 32. 第一條必須跑通的 Vertical Slice

在擴大功能之前，必須先完成：

```text
1. Connect one real domain
2. Verify ownership
3. Detect hosting / CDN / WAF / CMS
4. Ingest edge or server logs
5. Audit robots and bot policies
6. Verify official crawler identity
7. Audit raw HTML, rendered HTML, canonical, sitemap, noindex
8. Connect GSC, Bing and analytics where available
9. Create an initial stratified prompt benchmark
10. Identify one concrete issue
11. Produce an approved Change Set
12. Apply and validate deployment
13. Confirm recrawl or index-side observation when available
14. Observe citation, referral and conversion outcomes
15. Record the intervention and limitations
```

若這條閉環尚未跑通，不得把空的 Entity Graph、假 GEO Score 或只有幾筆測試資料的 Observatory 宣稱完成。

---

# 33. Definition of Done

## Crawler & Access

```text
[ ] Googlebot access tested
[ ] OAI-SearchBot policy tested
[ ] Claude-SearchBot policy tested
[ ] PerplexityBot policy tested
[ ] spoofed bot does not become verified
[ ] robots allow / WAF deny mismatch observable
[ ] 403 / 429 / challenge observable
```

## Rendering & URL Integrity

```text
[ ] important page raw HTML contains main content
[ ] canonical resolves correctly
[ ] no accidental noindex
[ ] redirect chain within policy
[ ] sitemap contains only canonical indexable URLs
[ ] truthful lastmod
[ ] raw / rendered mismatch detected
```

## Knowledge & Evidence

```text
[ ] core entities have stable IDs
[ ] author is a real entity with profile
[ ] material claims link to evidence
[ ] source version and locator retained
[ ] conflicting claims are detected
[ ] entity merge is reviewable and reversible
```

## Publishing

```text
[ ] JSON-LD valid and matches visible content
[ ] content versions immutable
[ ] publish pipeline idempotent
[ ] CDN purge and sitemap update logged
[ ] IndexNow used only where applicable
[ ] rollback tested
```

## Measurement

```text
[ ] crawler coverage measurable
[ ] AI referral measurable
[ ] prompt benchmark versioned
[ ] run-level results retained as permitted
[ ] measurement surfaces separated
[ ] sample size and confidence displayed
[ ] competitor share measurable where legally permitted
[ ] citation freshness measurable
[ ] conversion from AI referral measurable
```

## Learning Loop

```text
[ ] intervention registered
[ ] baseline preserved
[ ] deployment confirmed
[ ] recrawl observation recorded
[ ] post-outcome measured
[ ] causal limitations stated
[ ] result added to intervention-outcome dataset
```

## Agent Compatibility

```text
[ ] semantic HTML audit passed
[ ] accessible names and labels passed
[ ] keyboard flow passed
[ ] form error recovery passed
[ ] destructive action confirmation passed
[ ] agent task harness passed core journeys
```

## Security

```text
[ ] tenant isolation tests passed
[ ] SSRF / DNS rebinding tests passed
[ ] secret rotation tested
[ ] signed webhooks protected against replay
[ ] production writes fully audited
[ ] provider terms registry current
```

---

# 34. 工程交付物

工程團隊必須交付：

```text
Architecture Decision Records
System architecture diagram
Threat model
ERD
OpenAPI specification
Event schemas
Bot policy registry
Connector permission matrix
Data retention matrix
Provider terms matrix
Migration plan
Rollback plan
Test plan and fixtures
Operational runbooks
Dashboard definitions
Sample tenant and reproducible demo
```

不得把以下內容算作完成：

```text
placeholder dashboard
hard-coded sample data
empty Entity Graph tables
fake quality score
single-run benchmark
manual-only crawler verification
UI exists but no ingestion
API exists but HTML uses a different source
recommendation without validation
```

---

# 35. 最終工程原則

世界頂規 GEO 的核心不是偷偷塞一段 code，而是建立一套可證明的資訊與測量基礎設施：

```text
Crawler Infrastructure
+
Content & Entity Integrity
+
Claim / Evidence Provenance
+
First-Party Research
+
Citation & Referral Observatory
+
Intervention → Outcome Learning Loop
```

最終產品必須做到：

```text
我們知道發布了什麼
我們知道每個重要事實從哪裡來
我們知道 crawler 是否真的拿得到
我們知道 AI 是否真的引用
我們知道引用是否帶來流量與轉換
我們知道哪一次修改可能造成了什麼結果
我們能在證據不足時明確說不知道
```

這才是「世界頂規 GEO Infrastructure」的 Definition of Excellence。

---

## 官方政策維護來源

工程團隊應定期檢查並版本化以下官方文件的變更：

- OpenAI：Overview of OpenAI Crawlers；Publishers and Developers FAQ；Web Search API docs
- Anthropic：Crawler policy；Web Search Tool docs
- Perplexity：Perplexity Crawlers；Search / Agent API docs
- Google Search Central：Generative AI optimization guide；Google crawlers；Search generative AI control；Preferred Sources；Structured Data；Search documentation updates
- Google AI：Gemini API Additional Terms for Grounding with Google Search
- IndexNow：Documentation and FAQ
- Bing Webmaster Tools：Crawler verification、URL inspection、performance、IndexNow
- W3C WAI-ARIA Authoring Practices

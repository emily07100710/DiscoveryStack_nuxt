# First-party Astro/Nuxt GEO Content Site Kit V1

## 定位

First-party Astro/Nuxt GEO Content Site Kit V1 是一套 **headless、無視覺樣式、純 server-side、deterministic 的內容讀取與 projection 工具**。它讓由 DiscoveryStack first-party publisher 產生的 approved Markdown article，在客戶 Astro 或 Nuxt content site 中被安全解析，並投影為 route、canonical URL、SEO metadata、Open Graph metadata、JSON-LD、breadcrumb、hreflang、sitemap entry 與 deterministic content manifest。

本套件只負責讀取、驗證與轉換輸入資料；不修改 DiscoveryStack 後台、scheduler、資料庫、content calendar、SEO/GEO service、發布 executor、公開官網或客戶網站。所有 public entrypoint 都接受 `unknown`，遇到 malformed input 會回傳結構化 blocked result，不拋出 raw stack、不讀取環境變數、不存取資料庫、不寫檔、不 deploy、不依賴 browser，也不發送 network request。

> 本版本是客戶網站的 reference integration kit，不代表已套用到任何客戶網站，也不代表 production publishing 已驗證。

## 正式 artifact contract

Parser 直接對照 `server/first-party-publishing/types.ts` 與 `artifact.ts` 的正式 contract，不重新發明 publication identity。輸入 Markdown 必須只有一個位於文件最前方的 leading frontmatter block，欄位與順序固定為：`title`、`slug`、`language`、`contentType`、`publicationId`、`scheduleEntryId`、`productionPlanId`、`draftId`、`reviewId`、`evidenceSnapshotHash`、`contentHash`、`publishedAt`、`authoritySourceIds`、`appliedRuleIds`。

每一行 frontmatter value 使用受限 JSON scalar/list syntax；V1 不執行 YAML object construction、custom tag 或任意程式碼。未知欄位、敏感欄位、重複欄位、第二個 frontmatter block、錯誤型別、null、控制字元、錯誤的 field order、frontmatter injection、quote/newline injection 與 parser getter/proxy exception 都會 fail closed。

`contentHash` 必須等於正文 UTF-8 SHA-256；`evidenceSnapshotHash` 必須是 lowercase 64-character SHA-256。`language` 只接受 `en` 與 `zh-hant`；`contentType` 只接受 `article`、`faq` 與 `service_page`。所有 publication identity fields 都使用正式 publisher 的欄位名稱與 bounded opaque reference validation。`authoritySourceIds` 與 `appliedRuleIds` 必須是非空、bounded、無重複的 opaque string arrays，解析後以 deterministic lexical order 保存。

## Normalized document 與 route

`parseFirstPartyContentDocument()` 成功時回傳 verified normalized document，至少包含正式 publication identity、title、slug、language、contentType、body、bodyHash、evidenceSnapshotHash、authoritySourceIds、appliedRuleIds、publishedAt、sourcePath、routePath、canonicalPath 與 documentFingerprint。`publishedAt` 通過 strict timezone-bearing ISO calendar validation 後 canonicalize 為 UTC ISO。

固定 route 規則如下：

| Content type | Route pattern |
| --- | --- |
| `article` | `/{language}/articles/{slug}` |
| `faq` | `/{language}/faq/{slug}` |
| `service_page` | `/{language}/services/{slug}` |

slug 只允許 lowercase ASCII、數字與連字號；不從 title 猜 slug。`sourcePath` 必須位於傳入的 relative `contentRoot` 下，並拒絕 absolute path、`.`、`..`、encoded traversal、backslash、duplicate slash、query、fragment、null byte 與其他模糊 path representation。document fingerprint 涵蓋 normalized publication identity、route/canonical path、title、language、content type、content/evidence hashes、authority/rule arrays 與 publishedAt。

## Deterministic content manifest

`buildFirstPartyContentManifest()` 只接受 parser 驗證的 normalized documents，最多處理 500 篇。結果依 `language → contentType → slug → publicationId` stable sort，並在下列任一情況回傳整包 blocked，而不靜默保留第一筆：duplicate publication ID、duplicate route、duplicate language/contentType/slug、同 publication ID 的不一致 identity 或 content hash、偽造的 verified document、未驗證 wrapper、超過 500 篇或 malformed collection。

verified manifest 只輸出 verified documents，並以穩定的 document projection 產生 `manifestFingerprint`。manifest builder 不會掃描檔案系統、不會讀取測試 fixture，也不會自行發現或混入失敗文件。

## SEO 與 JSON-LD projection

`buildFirstPartySeoProjection()` 接受 verified document、public site origin、site/organization name，以及可選 logo URL、alternate documents、明確 fallback document 與 verified FAQ pairs。site origin 必須為 public HTTPS origin，不得含 credentials、path、query、fragment 或非 443 port，亦不得是 localhost、private、loopback、link-local、reserved/special-use IP 或 `.local`、`.internal`、`.onion` hostname。logo URL 也遵守 public HTTPS URL guard。

SEO projection 產生 deterministic bounded plain-text description，不呼叫 LLM，也不自行增加 author、dateModified、rating、review count、organization founding date、awards、traffic、ranking、ROI、citation 或其他未提供 claim。輸出包含：

| Projection | V1 output |
| --- | --- |
| Basic metadata | title、description、canonicalUrl、`robots: index, follow` |
| Open Graph | type、title、description、url、locale、published time |
| Language | exact hreflang alternates；只有明確 fallback document 才有 x-default |
| Navigation | Home、section、article breadcrumb items |
| Sitemap | canonical loc、canonical published lastmod、alternate URLs |
| Schema | Article；FAQPage 僅在輸入 verified FAQ pairs 時產生；service page 使用 minimal WebPage |

Article JSON-LD 使用 normalized title、canonical URL、language、publishedAt 與 verified publisher identity。FAQ Markdown 標題不會被猜成問題答案；沒有 verified FAQ pairs 時不會產生 FAQPage。Service page 不會虛構 offer、price 或 rating。所有 JSON-LD 都必須可被 `JSON.stringify`，且不得含 `undefined`、`NaN`、`Infinity` 或 circular value。

## Astro 與 Nuxt reference projections

`buildAstroContentProjection()` 與 `buildNuxtContentProjection()` 都只回傳 headless data。Astro projection 提供 route params、collection-compatible data、page props、head/meta、JSON-LD 與 sitemap；Nuxt projection 提供 route params、page data、useHead-compatible metadata、JSON-LD 與 sitemap。

兩者對同一份 verified document 必須保持 canonical URL、description、JSON-LD identity、publication ID、content hash 與 evidence hash parity。Projection 不包含 CSS、顏色、字體、layout、visual component 或 UI styling。reference integration 應由客戶網站自行決定 page rendering 與 visual design；本套件不修改現有公開頁面，也不宣稱任何客戶部署。

## Public API

`server/first-party-content-site-kit/index.ts` 提供下列受控 public surface：

- `parseFirstPartyContentDocument()`
- `buildFirstPartyContentManifest()`
- `buildFirstPartySeoProjection()`
- `buildAstroContentProjection()`
- `buildNuxtContentProjection()`

所有 entrypoint 都是同步、deterministic、pure data transformation，並以結構化 `status: 'blocked'` 結果表達輸入或 policy failure。它們不會呼叫 first-party publisher executor，不會觸發 GitHub Contents write，不會執行客戶網站 write，也不會改變現有 scheduler 或資料庫狀態。

## 驗證與限制

正式 targeted suite 位於 `tests/first-party-content-site-kit.test.ts`，使用 synthetic fixtures 驗證 formal artifact happy paths、en/zh-hant、article/faq/service_page、frontmatter safety、exact hash preservation、identity/path guards、manifest collisions、500-item bound、public origin safety、SEO/OG/JSON-LD、FAQ gating、hreflang/x-default、sitemap、Astro/Nuxt parity 與 malformed input。測試不包含真實客戶資料、網站內容、token 或 provider response。

本版本尚未驗證真實客戶 Astro/Nuxt repository、實際 content loader、production routing、production deployment、live canonical domain、真實 search crawler rendering、customer-specific structured data policy 或 production content governance。任何 reference integration 在部署前都必須由客戶網站重新驗證 source path、content root、canonical origin、route collision、JSON-LD policy 與 production build。

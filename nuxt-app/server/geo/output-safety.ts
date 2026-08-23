import type { GeoDocumentInput } from './contracts'

const SOURCE_BOUND_SAFETY_OVERLAY = `
## Source-bound safety overlay (mandatory)
- Treat the supplied source as the only evidence for factual, commercial, and performance claims.
- Do not invent or imply client names, client counts, customer success stories, testimonials, case studies, rankings, traffic, conversion, revenue, or performance outcomes.
- Do not promise, guarantee, or claim that the owner has achieved results unless the source itself states the same claim with sufficient verifiable evidence.
- If evidence is absent, use neutral language and state that the content owner must supply a verifiable source before publication.
- Preserve the requested document language; do not silently switch between Traditional and Simplified Chinese.
`.trim()

type UnsafeClaimPattern = { id: 'customer-case-study' | 'customer-outcome' | 'performance-outcome' | 'quantified-commercial-outcome' | 'unsupported-service-credential', pattern: RegExp }

const UNSUPPORTED_COMMERCIAL_CLAIM_PATTERNS: readonly UnsafeClaimPattern[] = [
  { id: 'customer-case-study', pattern: /成功案例|客户案例|客戶案例|客戶見證|客户见证|testimonials?|case studies?/iu },
  { id: 'customer-outcome', pattern: /(?:我們|我们|本(?:公司|團隊|团队)|\bwe\b).{0,40}(?:協助|帮助|幫助|服務|服务|helped|served|worked with).{0,60}(?:客戶|客户|企業|企业|公司|\bclients?\b|\bcustomers?\b|\bbusinesses?\b)/iu },
  { id: 'performance-outcome', pattern: /(?:提升|提高|增加|改善|實現|实现|帶來|带来|boost(?:ed|s)?|increase(?:d|s)?|improve(?:d|s)?).{0,48}(?:排名|流量|曝光|轉換|转化|營收|营收|訂單|订单|業績|业绩|滿意度|满意度|成效|成果|線上表現|在线表现|roi|traffic|ranking|conversion|revenue|sales)/iu },
  { id: 'quantified-commercial-outcome', pattern: /(?:提升|提高|增加|改善|實現|实现|帶來|带来|boost(?:ed|s)?|increase(?:d|s)?|improve(?:d|s)?).{0,64}(?:\d+(?:\.\d+)?\s?%|百分之\s?\d+|諮詢量|咨询量|新業務|新业务|合作夥伴|合作伙伴|客戶數|客户数)/iu },
  { id: 'unsupported-service-credential', pattern: /(?:經驗豐富|经验丰富).{0,32}(?:顧問|顾问|團隊|团队)|(?:量身(?:打造|定做)|持續支持|持续支持).{0,48}(?:客戶|客户|企業|企业|組織|组织)/iu },
]
const SIMPLIFIED_ONLY_CHARACTERS = /[让们务与为个这从对专业业转化联络]/u

export class AutoGeoUnsafeOutputError extends Error {
  constructor(readonly findingIds: UnsafeClaimPattern['id'][]) {
    super('The provider rewrite contains unsupported commercial or customer-success claims.')
    this.name = 'AutoGeoUnsafeOutputError'
  }
}

function contains(pattern: RegExp, value: string): boolean { pattern.lastIndex = 0; return pattern.test(value) }
export function sourceBoundSafetyOverlay(): string { return SOURCE_BOUND_SAFETY_OVERLAY }

export function assertSourceBoundRewrite(document: GeoDocumentInput, optimizedTitle: string, optimizedContent: string): void {
  const source = `${document.title}\n${document.content}\n${document.approvedEvidenceContext || ''}`
  const rewrite = `${optimizedTitle}\n${optimizedContent}`
  const findings = UNSUPPORTED_COMMERCIAL_CLAIM_PATTERNS.filter(({ pattern }) => contains(pattern, rewrite) && !contains(pattern, source)).map(({ id }) => id)
  if (document.language === 'zh-hant' && contains(SIMPLIFIED_ONLY_CHARACTERS, rewrite) && !contains(SIMPLIFIED_ONLY_CHARACTERS, source)) findings.push('unsupported-service-credential')
  if (findings.length) throw new AutoGeoUnsafeOutputError(findings)
}

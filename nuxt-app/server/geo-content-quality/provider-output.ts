import { normalizeContentQualityInput, isRecord, readField, hasExactKeys, normalizeSha256 } from './normalization'
import { sha256Text } from './fingerprint'
import { CLAIM_TYPES, CONTENT_QUALITY_CONTRACT_VERSION, PROVIDER_OUTPUT_VERSION, type ContentQualityInput, type FaqPair, type ProviderClaim, type ProviderCitation, type ProviderOutput, type ProviderOutputValidationResult } from './types'
import type { ReasonCode } from './reason-codes'

const OUTPUT_KEYS = ['outputVersion', 'title', 'summary', 'body', 'bodyHash', 'faqPairs', 'claims', 'citations', 'appliedRuleIds', 'limitations'] as const
const CLAIM_KEYS = ['claimId', 'text', 'claimType', 'bodyLocator', 'citationIds'] as const
const CITATION_KEYS = ['citationId', 'sourceId', 'artifactId', 'chunkId', 'chunkHash'] as const
const FAQ_KEYS = ['question', 'answer', 'citationIds'] as const

function invalid(reasonCodes: ReasonCode[]): ProviderOutputValidationResult {
  return { status: 'invalid', output: null, reasonCodes: [...new Set(reasonCodes)] }
}

function text(value: unknown, min: number, max: number, reasonCode: ReasonCode = 'PROVIDER_OUTPUT_MALFORMED'): string {
  if (typeof value !== 'string' || value.length < min || value.length > max || value.includes('\u0000')) throw new Error(reasonCode)
  return value
}

function boundedIds(value: unknown, max: number): string[] {
  if (!Array.isArray(value) || value.length > max || value.some(item => typeof item !== 'string' || !/^[A-Za-z0-9._:-]{1,160}$/u.test(item))) throw new Error('PROVIDER_OUTPUT_MALFORMED')
  const ids = [...value] as string[]
  if (new Set(ids).size !== ids.length) throw new Error('PROVIDER_OUTPUT_MALFORMED')
  return ids
}

function safeBodyLocator(value: unknown): string {
  const locator = text(value, 1, 200, 'INVALID_BODY_LOCATOR')
  if (!/^body(?:\.section)?(?::[A-Za-z0-9._-]+)?$/u.test(locator)) throw new Error('INVALID_BODY_LOCATOR')
  return locator
}

function normalizeFaq(value: unknown): FaqPair {
  if (!hasExactKeys(value, FAQ_KEYS)) throw new Error('PROVIDER_OUTPUT_MALFORMED')
  return { question: text(readField(value, 'question'), 1, 1000), answer: text(readField(value, 'answer'), 1, 8000), citationIds: boundedIds(readField(value, 'citationIds'), 30) }
}

function normalizeClaim(value: unknown): ProviderClaim {
  if (!hasExactKeys(value, CLAIM_KEYS)) throw new Error('PROVIDER_OUTPUT_MALFORMED')
  const claimType = readField(value, 'claimType')
  if (!CLAIM_TYPES.includes(claimType as typeof CLAIM_TYPES[number])) throw new Error('PROVIDER_OUTPUT_MALFORMED')
  return { claimId: text(readField(value, 'claimId'), 1, 160), text: text(readField(value, 'text'), 1, 5000), claimType: claimType as ProviderClaim['claimType'], bodyLocator: safeBodyLocator(readField(value, 'bodyLocator')), citationIds: boundedIds(readField(value, 'citationIds'), 30) }
}

function normalizeCitation(value: unknown): ProviderCitation {
  if (!hasExactKeys(value, CITATION_KEYS)) throw new Error('PROVIDER_OUTPUT_MALFORMED')
  return { citationId: text(readField(value, 'citationId'), 1, 160), sourceId: text(readField(value, 'sourceId'), 1, 160), artifactId: text(readField(value, 'artifactId'), 1, 160), chunkId: text(readField(value, 'chunkId'), 1, 160), chunkHash: normalizeSha256(readField(value, 'chunkHash')) }
}

function contentForSafety(output: ProviderOutput): string {
  return [output.title, output.summary, output.body, ...output.faqPairs.flatMap(pair => [pair.question, pair.answer]), ...output.claims.map(claim => claim.text)].join('\n')
}

export function prohibitedClaimReasonCodes(value: string): ReasonCode[] {
  const reasons: ReasonCode[] = []
  if (/(?:fabricat|invent|fake|虛構|捏造).{0,80}(?:customer|client|case|testimonial|客戶|客戶案例|案例|見證)/iu.test(value) || /(?:customer|client|case study|testimonial|客戶案例|客戶見證)/iu.test(value)) reasons.push('FABRICATED_CASE_CLAIM')
  if (/(?:guarantee|guaranteed|保證|保证).{0,80}(?:ranking|traffic|conversion|revenue|roi|引用|排名|流量|轉換|转换|營收|营收)/iu.test(value)) reasons.push('PROHIBITED_PERFORMANCE_GUARANTEE')
  if (/(?:排名第一|第一名|top\s*rank|increase\s+traffic|提升流量|提升轉換|提升转换|提升營收|提升营收|提升\s*ROI)/iu.test(value)) reasons.push('PROHIBITED_PERFORMANCE_GUARANTEE')
  return reasons
}

export function validateProviderOutput(qualityInputValue: unknown, outputValue: unknown): ProviderOutputValidationResult {
  const normalizedInput = normalizeContentQualityInput(qualityInputValue)
  if (normalizedInput.status !== 'valid') return invalid(normalizedInput.reasonCodes)
  const input = normalizedInput.input
  try {
    if (!isRecord(outputValue)) return invalid(['PROVIDER_OUTPUT_MALFORMED'])
    if (!hasExactKeys(outputValue, OUTPUT_KEYS)) return invalid(['UNKNOWN_FIELD'])
    if (readField(outputValue, 'outputVersion') !== PROVIDER_OUTPUT_VERSION) return invalid(['PROVIDER_OUTPUT_MALFORMED'])
    const title = text(readField(outputValue, 'title'), 1, 240)
    const summary = text(readField(outputValue, 'summary'), 1, 3000)
    const body = text(readField(outputValue, 'body'), 1, 60000)
    const bodyHash = normalizeSha256(readField(outputValue, 'bodyHash'))
    if (bodyHash !== sha256Text(body)) return invalid(['CONTENT_HASH_MISMATCH'])
    const faqRaw = readField(outputValue, 'faqPairs')
    const claimsRaw = readField(outputValue, 'claims')
    const citationsRaw = readField(outputValue, 'citations')
    if (!Array.isArray(faqRaw) || faqRaw.length > 50 || !Array.isArray(claimsRaw) || claimsRaw.length > 200 || !Array.isArray(citationsRaw) || citationsRaw.length > 200) return invalid(['LIMIT_EXCEEDED'])
    const faqPairs = faqRaw.map(normalizeFaq)
    const claims = claimsRaw.map(normalizeClaim)
    const citations = citationsRaw.map(normalizeCitation)
    if (new Set(claims.map(claim => claim.claimId)).size !== claims.length || new Set(citations.map(citation => citation.citationId)).size !== citations.length) return invalid(['PROVIDER_OUTPUT_MALFORMED'])
    const citationById = new Map(citations.map(citation => [citation.citationId, citation]))
    const approvedChunks = new Map(input.approvedEvidenceChunks.map(chunk => [`${chunk.sourceId}|${chunk.artifactId}|${chunk.chunkId}`, chunk]))
    for (const citation of citations) {
      const chunk = approvedChunks.get(`${citation.sourceId}|${citation.artifactId}|${citation.chunkId}`)
      if (!chunk || citation.chunkHash !== chunk.chunkHash) return invalid(['CITATION_OUTSIDE_APPROVED_EVIDENCE'])
    }
    for (const claim of claims) for (const citationId of claim.citationIds) if (!citationById.has(citationId)) return invalid(['INVALID_CITATION_BINDING'])
    for (const faq of faqPairs) for (const citationId of faq.citationIds) if (!citationById.has(citationId)) return invalid(['INVALID_CITATION_BINDING'])
    const appliedRuleIds = boundedIds(readField(outputValue, 'appliedRuleIds'), 40)
    if (appliedRuleIds.some(ruleId => !input.selectedRuleIds.includes(ruleId))) return invalid(['APPLIED_RULE_OUTSIDE_SELECTION'])
    const limitations = readField(outputValue, 'limitations')
    if (!Array.isArray(limitations) || limitations.length < 1 || limitations.length > 30 || limitations.some(item => typeof item !== 'string' || item.length < 1 || item.length > 1000)) return invalid(['PROVIDER_OUTPUT_MALFORMED'])
    const output: ProviderOutput = { outputVersion: PROVIDER_OUTPUT_VERSION, title, summary, body, bodyHash, faqPairs, claims, citations, appliedRuleIds, limitations: [...limitations] as string[] }
    const prohibited = prohibitedClaimReasonCodes(contentForSafety(output))
    if (prohibited.length) return invalid(prohibited)
    return { status: 'valid', output, reasonCodes: [] }
  } catch (error: unknown) {
    const reason = error instanceof Error && ['INVALID_BODY_LOCATOR', 'CONTENT_HASH_MISMATCH', 'APPLIED_RULE_OUTSIDE_SELECTION', 'CITATION_OUTSIDE_APPROVED_EVIDENCE', 'INVALID_CITATION_BINDING', 'FABRICATED_CASE_CLAIM', 'PROHIBITED_PERFORMANCE_GUARANTEE'].includes(error.message) ? error.message as ReasonCode : 'PROVIDER_OUTPUT_MALFORMED'
    return invalid([reason])
  }
}

export function providerOutputText(value: ProviderOutput): string {
  return [value.title, value.summary, value.body, ...value.faqPairs.flatMap(pair => [pair.question, pair.answer]), ...value.claims.map(claim => claim.text)].join('\n')
}

export function providerOutputContractVersion(): string {
  return `${CONTENT_QUALITY_CONTRACT_VERSION}:${PROVIDER_OUTPUT_VERSION}`
}

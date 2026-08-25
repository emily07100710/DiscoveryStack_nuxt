import { resolveCanonicalGeoRules } from '../geo/rules'
import { normalizeContentQualityInput, isRecord, readField, hasExactKeys, normalizeSha256, normalizeTimestamp } from './normalization'
import { sha256Text, canonicalizeQualityValue, contentQualityFingerprintForNormalizedInput } from './fingerprint'
import { buildPromptPack } from './prompt-pack'
import { buildRetrievalResult, verifyRetrievalResult } from './rag-contract'
import { parseMarkdownStructure } from './markdown-structure'
import { CLAIM_TYPES, CONTENT_QUALITY_CONTRACT_VERSION, PROVIDER_OUTPUT_VERSION, type ContentQualityInput, type FaqPair, type ParagraphBinding, type ProviderClaim, type ProviderCitation, type ProviderOutput, type ProviderOutputValidationContext, type ProviderOutputValidationResult, type PromptPack, type RetrievalResult } from './types'
import type { ReasonCode } from './reason-codes'

const OUTPUT_KEYS = ['outputVersion', 'title', 'summary', 'body', 'bodyHash', 'faqPairs', 'claims', 'citations', 'appliedRuleIds', 'limitations', 'paragraphBindings', 'provider', 'model', 'requestId', 'requestedAt', 'generatedAt', 'promptFingerprint', 'contentQualityFingerprint', 'retrievalFingerprint', 'responseHash'] as const
const CLAIM_KEYS = ['claimId', 'text', 'claimType', 'bodyLocator', 'citationIds'] as const
const CITATION_KEYS = ['citationId', 'sourceId', 'artifactId', 'chunkId', 'chunkHash', 'artifactHash', 'sourceLocator'] as const
const FAQ_KEYS = ['question', 'answer', 'citationIds'] as const
const PARAGRAPH_BINDING_KEYS = ['paragraphIndex', 'paragraphHash', 'claimType', 'citationIds', 'claimIds'] as const
const CITED_CLAIM_TYPES = new Set(['factual', 'quantitative', 'comparative', 'high_risk'])

function invalid(reasonCodes: ReasonCode[]): ProviderOutputValidationResult { return { status: 'invalid', output: null, reasonCodes: [...new Set(reasonCodes)] } }
function fail(reasonCode: ReasonCode): never { throw new Error(reasonCode) }
function text(value: unknown, min: number, max: number, reasonCode: ReasonCode = 'PROVIDER_OUTPUT_MALFORMED'): string { if (typeof value !== 'string' || value.length < min || value.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)) fail(reasonCode); return value }
function boundedIds(value: unknown, max: number, duplicateReason: ReasonCode = 'PROVIDER_OUTPUT_MALFORMED'): string[] { if (!Array.isArray(value) || value.length > max || value.some(item => typeof item !== 'string' || !/^[A-Za-z0-9._:-]{1,160}$/u.test(item))) fail('PROVIDER_OUTPUT_MALFORMED'); const ids = [...value] as string[]; if (new Set(ids).size !== ids.length) fail(duplicateReason); return ids }
function safeBodyLocator(value: unknown): string { const locator = text(value, 1, 200, 'INVALID_BODY_LOCATOR'); if (!/^(?:summary|body\.paragraph:(?:0|[1-9]\d*))$/u.test(locator)) fail('INVALID_BODY_LOCATOR'); return locator }
function normalizeFaq(value: unknown): FaqPair { if (!hasExactKeys(value, FAQ_KEYS)) fail('PROVIDER_OUTPUT_MALFORMED'); const citationIds = boundedIds(readField(value, 'citationIds'), 30, 'INVALID_CITATION_BINDING'); if (citationIds.length === 0) fail('INVALID_CITATION_BINDING'); return { question: text(readField(value, 'question'), 1, 1000), answer: text(readField(value, 'answer'), 1, 8000), citationIds } }
function normalizeClaim(value: unknown): ProviderClaim { if (!hasExactKeys(value, CLAIM_KEYS)) fail('PROVIDER_OUTPUT_MALFORMED'); const claimType = readField(value, 'claimType'); if (!CLAIM_TYPES.includes(claimType as typeof CLAIM_TYPES[number])) fail('UNSUPPORTED_PARAGRAPH_CLAIM_TYPE'); return { claimId: text(readField(value, 'claimId'), 1, 160), text: text(readField(value, 'text'), 1, 5000), claimType: claimType as ProviderClaim['claimType'], bodyLocator: safeBodyLocator(readField(value, 'bodyLocator')), citationIds: boundedIds(readField(value, 'citationIds'), 30, 'INVALID_CITATION_BINDING') } }
function normalizeCitation(value: unknown): ProviderCitation { if (!hasExactKeys(value, CITATION_KEYS)) fail('PROVIDER_OUTPUT_MALFORMED'); return { citationId: text(readField(value, 'citationId'), 1, 160), sourceId: text(readField(value, 'sourceId'), 1, 160), artifactId: text(readField(value, 'artifactId'), 1, 160), chunkId: text(readField(value, 'chunkId'), 1, 160), chunkHash: normalizeSha256(readField(value, 'chunkHash')), artifactHash: normalizeSha256(readField(value, 'artifactHash')), sourceLocator: text(readField(value, 'sourceLocator'), 1, 2048) } }
function normalizeBinding(value: unknown): ParagraphBinding { if (!hasExactKeys(value, PARAGRAPH_BINDING_KEYS)) fail('PROVIDER_OUTPUT_MALFORMED'); const index = readField(value, 'paragraphIndex'); if (typeof index !== 'number' || !Number.isInteger(index) || index < 0 || index > 10000) fail('PARAGRAPH_BINDING_MISMATCH'); const claimType = readField(value, 'claimType'); if (!CLAIM_TYPES.includes(claimType as typeof CLAIM_TYPES[number])) fail('UNSUPPORTED_PARAGRAPH_CLAIM_TYPE'); const claimIds = boundedIds(readField(value, 'claimIds'), 10, 'PARAGRAPH_BINDING_MISMATCH'); if (claimIds.length !== 1) fail('PARAGRAPH_BINDING_MISMATCH'); return { paragraphIndex: index, paragraphHash: normalizeSha256(readField(value, 'paragraphHash'), 'PARAGRAPH_BINDING_MISMATCH'), claimType: claimType as ParagraphBinding['claimType'], citationIds: boundedIds(readField(value, 'citationIds'), 30, 'INVALID_CITATION_BINDING'), claimIds } }
function contentForSafety(output: Pick<ProviderOutput, 'title' | 'summary' | 'body' | 'faqPairs' | 'claims'>): string { return [output.title, output.summary, output.body, ...output.faqPairs.flatMap(pair => [pair.question, pair.answer]), ...output.claims.map(claim => claim.text)].join('\n') }
function normalizeComparable(value: string): string { return value.normalize('NFKC').toLowerCase().replace(/[\p{P}\p{S}]+/gu, ' ').replace(/\s+/gu, ' ').trim() }
function stripCitationMarkers(value: string): string { return value.replace(/\[cite:[A-Za-z0-9._:-]{1,160}\]/gu, '').replace(/\[[A-Za-z0-9._:-]{1,160}\]/gu, '').replace(/\s+/gu, ' ').trim() }
function citationMarkerIds(value: string): string[] { const ids: string[] = []; const markerPattern = /\[cite:([A-Za-z0-9._:-]{1,160})\]/gu; for (const match of value.matchAll(markerPattern)) ids.push(match[1]!); return ids }
function arraysEqual(left: readonly string[], right: readonly string[]): boolean { return left.length === right.length && left.every((value, index) => value === right[index]) }
function summaryNeedsCitation(value: string): boolean { return /(?:\d|%|\b(?:more|less|higher|lower|best|worst|compare|compared|versus|vs)\b|比較|較高|較低|第一名|最多|最少)/iu.test(value) }
function responseHashPayload(output: Omit<ProviderOutput, 'responseHash'>): string { return canonicalizeQualityValue(output) }
function responseHashForOutput(output: Omit<ProviderOutput, 'responseHash'>): string { return sha256Text(responseHashPayload(output)) }

export function prohibitedClaimReasonCodes(value: string): ReasonCode[] {
  const reasons: ReasonCode[] = []
  if (/(?:fabricat|invent|fake|虛構|捏造).{0,100}(?:customer\s+(?:case\s+study|testimonial|story)|client\s+(?:case\s+study|testimonial|story)|客戶(?:案例|見證|故事)|案例)/iu.test(value) || /(?:customer|client)\s+(?:case\s+study|testimonial|story)/iu.test(value)) reasons.push('FABRICATED_CASE_CLAIM')
  if (/(?:guarantee|guaranteed|保證|保证).{0,80}(?:ranking|traffic|conversion|revenue|roi|引用|排名|流量|轉換|转换|營收|营收)/iu.test(value) || /(?:排名第一|第一名|top\s*rank|increase\s+traffic|提升流量|提升轉換|提升转换|提升營收|提升营收|提升\s*ROI)/iu.test(value)) reasons.push('PROHIBITED_PERFORMANCE_GUARANTEE')
  return reasons
}

function canonicalServerContext(input: ContentQualityInput, context?: ProviderOutputValidationContext): { retrieval: RetrievalResult, promptPack: PromptPack } | null {
  const retrieval = context?.retrievalResult === undefined
    ? buildRetrievalResult(input, input.approvedEvidenceChunks.map(chunk => ({ chunk })))
    : verifyRetrievalResult(context.retrievalResult, input)
  if (!retrieval || retrieval.status !== 'ready') return null
  const promptResult = buildPromptPack(input, retrieval)
  if (promptResult.status !== 'ready') return null
  if (context?.promptPack !== undefined) {
    if (!isRecord(context.promptPack) || canonicalizeQualityValue(context.promptPack) !== canonicalizeQualityValue(promptResult.promptPack)) return null
  }
  return { retrieval, promptPack: promptResult.promptPack }
}

export function validateProviderOutput(qualityInputValue: unknown, outputValue: unknown, context?: ProviderOutputValidationContext): ProviderOutputValidationResult {
  const normalizedInput = normalizeContentQualityInput(qualityInputValue)
  if (normalizedInput.status !== 'valid') return invalid(normalizedInput.reasonCodes)
  const input = normalizedInput.input
  const serverContext = canonicalServerContext(input, context)
  if (!serverContext) return invalid([context?.retrievalResult !== undefined ? 'RETRIEVAL_FINGERPRINT_MISMATCH' : 'RETRIEVAL_NOT_READY'])
  try {
    if (!isRecord(outputValue)) return invalid(['PROVIDER_OUTPUT_MALFORMED'])
    if (!hasExactKeys(outputValue, OUTPUT_KEYS)) return invalid(['UNKNOWN_FIELD'])
    if (readField(outputValue, 'outputVersion') !== PROVIDER_OUTPUT_VERSION) return invalid(['PROVIDER_OUTPUT_MALFORMED'])
    const title = text(readField(outputValue, 'title'), 1, 240)
    const summary = text(readField(outputValue, 'summary'), 1, 3000)
    const body = text(readField(outputValue, 'body'), 1, 60000)
    const bodyHash = normalizeSha256(readField(outputValue, 'bodyHash'))
    if (bodyHash !== sha256Text(body)) return invalid(['CONTENT_HASH_MISMATCH'])
    if (title !== input.workingTitle) return invalid(['CONTENT_TOPIC_MISMATCH'])
    const faqRaw = readField(outputValue, 'faqPairs')
    const claimsRaw = readField(outputValue, 'claims')
    const citationsRaw = readField(outputValue, 'citations')
    const bindingsRaw = readField(outputValue, 'paragraphBindings')
    if (!Array.isArray(faqRaw) || faqRaw.length > 50 || !Array.isArray(claimsRaw) || claimsRaw.length > 200 || !Array.isArray(citationsRaw) || citationsRaw.length > 200 || !Array.isArray(bindingsRaw) || bindingsRaw.length > 1000) return invalid(['LIMIT_EXCEEDED'])
    const faqPairs = faqRaw.map(normalizeFaq)
    const claims = claimsRaw.map(normalizeClaim)
    const citations = citationsRaw.map(normalizeCitation)
    const paragraphBindings = bindingsRaw.map(normalizeBinding)
    if (new Set(claims.map(claim => claim.claimId)).size !== claims.length || new Set(citations.map(citation => citation.citationId)).size !== citations.length) return invalid(['PROVIDER_OUTPUT_MALFORMED'])
    const appliedRuleIds = boundedIds(readField(outputValue, 'appliedRuleIds'), 40, 'RULE_CHECK_FAILED')
    try {
      const canonicalRules = resolveCanonicalGeoRules(appliedRuleIds)
      if (appliedRuleIds.length !== input.selectedRuleIds.length || canonicalRules.length !== input.selectedRuleIds.length || appliedRuleIds.some((id, index) => id !== input.selectedRuleIds[index] || canonicalRules[index]?.id !== input.selectedRuleIds[index])) return invalid(['RULE_CHECK_FAILED'])
    } catch { return invalid(['APPLIED_RULE_OUTSIDE_SELECTION']) }
    const limitations = readField(outputValue, 'limitations')
    if (!Array.isArray(limitations) || limitations.length < 1 || limitations.length > 30 || limitations.some(item => typeof item !== 'string' || item.length < 1 || item.length > 1000)) return invalid(['PROVIDER_OUTPUT_MALFORMED'])
    const provider = text(readField(outputValue, 'provider'), 1, 160)
    const model = text(readField(outputValue, 'model'), 1, 160)
    const requestId = text(readField(outputValue, 'requestId'), 1, 160)
    const requestedAt = normalizeTimestamp(readField(outputValue, 'requestedAt'))
    const generatedAt = normalizeTimestamp(readField(outputValue, 'generatedAt'))
    if (provider !== input.providerProvenance.provider || model !== input.providerProvenance.model || requestId !== input.providerProvenance.requestId || requestedAt !== input.providerProvenance.requestedAt || generatedAt !== input.providerProvenance.generatedAt) return invalid(['PROVIDER_PROVENANCE_MISMATCH'])
    const promptFingerprint = normalizeSha256(readField(outputValue, 'promptFingerprint'))
    const contentQualityFingerprint = normalizeSha256(readField(outputValue, 'contentQualityFingerprint'))
    const retrievalFingerprint = normalizeSha256(readField(outputValue, 'retrievalFingerprint'))
    if (promptFingerprint !== serverContext.promptPack.promptFingerprint) return invalid(['PROVIDER_PROVENANCE_MISMATCH'])
    if (contentQualityFingerprint !== contentQualityFingerprintForNormalizedInput(input)) return invalid(['PROVIDER_PROVENANCE_MISMATCH'])
    if (retrievalFingerprint !== serverContext.retrieval.retrievalFingerprint) return invalid(['RETRIEVAL_FINGERPRINT_MISMATCH'])
    const responseHash = normalizeSha256(readField(outputValue, 'responseHash'), 'RESPONSE_HASH_MISMATCH')
    const outputWithoutHash: Omit<ProviderOutput, 'responseHash'> = { outputVersion: PROVIDER_OUTPUT_VERSION, title, summary, body, bodyHash, faqPairs, claims, citations, appliedRuleIds, limitations: [...limitations] as string[], paragraphBindings, provider, model, requestId, requestedAt, generatedAt, promptFingerprint, contentQualityFingerprint, retrievalFingerprint }
    if (responseHash !== responseHashForOutput(outputWithoutHash)) return invalid(['RESPONSE_HASH_MISMATCH'])
    const prohibited = prohibitedClaimReasonCodes(contentForSafety({ title, summary, body, faqPairs, claims }))
    if (prohibited.length) return invalid(prohibited)
    const parsedMarkdown = parseMarkdownStructure(body)
    if (parsedMarkdown.status === 'invalid' && parsedMarkdown.reasonCodes.some(reason => ['INVALID_INPUT', 'EMPTY_REQUIRED_FIELD'].includes(reason))) return invalid(parsedMarkdown.reasonCodes)
    const paragraphs = parsedMarkdown.report.paragraphs
    if (parsedMarkdown.report.titleHeading === null || normalizeComparable(parsedMarkdown.report.titleHeading) !== normalizeComparable(input.workingTitle)) return invalid(['CONTENT_TOPIC_MISMATCH'])
    const citationById = new Map(citations.map(citation => [citation.citationId, citation]))
    const selectedChunks = new Map(serverContext.retrieval.chunks.map(chunk => [`${chunk.sourceId}|${chunk.artifactId}|${chunk.chunkId}`, chunk]))
    for (const citation of citations) {
      const chunk = selectedChunks.get(`${citation.sourceId}|${citation.artifactId}|${citation.chunkId}`)
      if (!chunk || citation.chunkHash !== chunk.chunkHash || citation.artifactHash !== chunk.artifactHash || citation.sourceLocator !== chunk.locator) return invalid(['CITATION_OUTSIDE_APPROVED_EVIDENCE'])
    }
    for (const claim of claims) if (!claim.citationIds.every(citationId => citationById.has(citationId))) return invalid(['INVALID_CITATION_BINDING'])
    const summaryClaims = claims.filter(claim => claim.bodyLocator === 'summary')
    if (summaryClaims.length !== 1) return invalid(['PARAGRAPH_BINDING_MISSING'])
    const summaryClaim = summaryClaims[0]!
    if (normalizeComparable(summaryClaim.text) !== normalizeComparable(summary)) return invalid(['PARAGRAPH_BINDING_MISMATCH'])
    if (summaryNeedsCitation(summary) && summaryClaim.citationIds.length === 0) return invalid(['CLAIM_WITHOUT_CITATION'])
    if (CITED_CLAIM_TYPES.has(summaryClaim.claimType) && summaryClaim.citationIds.length === 0) return invalid([summaryClaim.claimType === 'quantitative' ? 'UNSUPPORTED_QUANTITATIVE_CLAIM' : 'CLAIM_WITHOUT_CITATION'])
    const bodyClaims = claims.filter(claim => claim.bodyLocator !== 'summary')
    if (bodyClaims.length !== paragraphs.length) return invalid(['PARAGRAPH_BINDING_MISSING'])
    const claimsByParagraph = new Map<number, ProviderClaim>()
    for (const claim of bodyClaims) {
      const match = /^body\.paragraph:(0|[1-9]\d*)$/u.exec(claim.bodyLocator)
      if (!match) return invalid(['INVALID_BODY_LOCATOR'])
      const index = Number(match[1])
      if (claimsByParagraph.has(index)) return invalid(['PARAGRAPH_BINDING_DUPLICATE'])
      const paragraph = paragraphs.find(item => item.paragraphIndex === index)
      if (!paragraph || normalizeComparable(stripCitationMarkers(claim.text)) !== paragraph.normalizedText) return invalid(['PARAGRAPH_BINDING_MISMATCH'])
      if (paragraph.citationMarkerIds.length > 0 && !CITED_CLAIM_TYPES.has(claim.claimType)) return invalid(['UNSUPPORTED_PARAGRAPH_CLAIM_TYPE'])
      if (CITED_CLAIM_TYPES.has(claim.claimType) && claim.citationIds.length === 0) return invalid([claim.claimType === 'quantitative' ? 'UNSUPPORTED_QUANTITATIVE_CLAIM' : 'CLAIM_WITHOUT_CITATION'])
      if (!claim.citationIds.every(citationId => citationById.has(citationId))) return invalid(['INVALID_CITATION_BINDING'])
      if (!arraysEqual(claim.citationIds, paragraph.citationMarkerIds)) return invalid(['INVALID_CITATION_BINDING'])
      claimsByParagraph.set(index, claim)
    }
    if (claimsByParagraph.size !== paragraphs.length || paragraphs.some(paragraph => !claimsByParagraph.has(paragraph.paragraphIndex))) return invalid(['PARAGRAPH_BINDING_MISSING'])
    if (paragraphBindings.length !== paragraphs.length) return invalid(['PARAGRAPH_BINDING_MISSING'])
    const boundIndexes = new Set<number>()
    const boundClaimIds = new Set<string>()
    for (const binding of paragraphBindings) {
      if (boundIndexes.has(binding.paragraphIndex)) return invalid(['PARAGRAPH_BINDING_DUPLICATE'])
      boundIndexes.add(binding.paragraphIndex)
      const paragraph = paragraphs.find(item => item.paragraphIndex === binding.paragraphIndex)
      const claim = claimsByParagraph.get(binding.paragraphIndex)
      if (!paragraph || !claim || paragraph.paragraphHash !== binding.paragraphHash) return invalid(['PARAGRAPH_BINDING_MISMATCH'])
      if (binding.claimIds.length !== 1 || boundClaimIds.has(binding.claimIds[0]!) || binding.claimIds[0] !== claim.claimId) return invalid(['PARAGRAPH_BINDING_MISMATCH'])
      if (binding.claimType !== claim.claimType || !arraysEqual(binding.citationIds, paragraph.citationMarkerIds) || !arraysEqual(binding.citationIds, claim.citationIds)) return invalid(['INVALID_CITATION_BINDING'])
      if (CITED_CLAIM_TYPES.has(binding.claimType) && binding.citationIds.length === 0) return invalid([binding.claimType === 'quantitative' ? 'UNSUPPORTED_QUANTITATIVE_CLAIM' : 'CLAIM_WITHOUT_CITATION'])
      boundClaimIds.add(binding.claimIds[0]!)
    }
    if (boundIndexes.size !== paragraphs.length || boundClaimIds.size !== bodyClaims.length) return invalid(['PARAGRAPH_BINDING_MISSING'])
    const markerIds = paragraphs.flatMap(paragraph => paragraph.citationMarkerIds)
    const markerSet = new Set(markerIds)
    const citationSet = new Set(citations.map(citation => citation.citationId))
    if (markerIds.some(marker => !citationById.has(marker))) return invalid(['INVALID_CITATION_BINDING'])
    if ([...citationSet].some(citationId => !markerSet.has(citationId))) return invalid(['UNUSED_CITATION'])
    const faqReportPairs = parsedMarkdown.report.faqPairs
    if (faqPairs.length > 0) {
      if (!parsedMarkdown.report.faqSectionFound || faqReportPairs.length !== faqPairs.length) return invalid(['FAQ_BODY_MISMATCH'])
      for (let index = 0; index < faqPairs.length; index += 1) {
        const expected = faqReportPairs[index]!
        const actual = faqPairs[index]!
        const answerMarkerIds = citationMarkerIds(actual.answer)
        if (actual.citationIds.length === 0 || !actual.citationIds.every(citationId => citationById.has(citationId)) || !arraysEqual(actual.citationIds, answerMarkerIds)) return invalid(['INVALID_CITATION_BINDING'])
        if (normalizeComparable(actual.question) !== normalizeComparable(expected.question) || normalizeComparable(stripCitationMarkers(actual.answer)) !== normalizeComparable(stripCitationMarkers(expected.answer))) return invalid(['FAQ_BODY_MISMATCH'])
      }
    } else if (parsedMarkdown.report.faqSectionFound && faqReportPairs.length > 0) return invalid(['FAQ_BODY_MISMATCH'])
    const output: ProviderOutput = { ...outputWithoutHash, responseHash }
    return { status: 'valid', output, reasonCodes: [] }
  } catch (error: unknown) {
    const allowed: ReasonCode[] = ['INVALID_BODY_LOCATOR', 'CONTENT_HASH_MISMATCH', 'INVALID_CITATION_BINDING', 'CITATION_OUTSIDE_APPROVED_EVIDENCE', 'CLAIM_WITHOUT_CITATION', 'UNSUPPORTED_QUANTITATIVE_CLAIM', 'UNSUPPORTED_PARAGRAPH_CLAIM_TYPE', 'PARAGRAPH_BINDING_MISMATCH', 'PARAGRAPH_BINDING_MISSING', 'PARAGRAPH_BINDING_DUPLICATE', 'UNUSED_CITATION', 'FAQ_BODY_MISMATCH', 'PROVIDER_PROVENANCE_MISMATCH', 'RESPONSE_HASH_MISMATCH', 'RETRIEVAL_FINGERPRINT_MISMATCH', 'RULE_CHECK_FAILED', 'APPLIED_RULE_OUTSIDE_SELECTION', 'FABRICATED_CASE_CLAIM', 'PROHIBITED_PERFORMANCE_GUARANTEE', 'INVALID_TIMESTAMP', 'UNKNOWN_FIELD', 'CONTENT_TOPIC_MISMATCH']
    const reason = error instanceof Error && allowed.includes(error.message as ReasonCode) ? error.message as ReasonCode : 'PROVIDER_OUTPUT_MALFORMED'
    return invalid([reason])
  }
}

export function providerOutputText(value: ProviderOutput): string { return [value.title, value.summary, value.body, ...value.faqPairs.flatMap(pair => [pair.question, pair.answer]), ...value.claims.map(claim => claim.text)].join('\n') }
export function providerOutputContractVersion(): string { return `${CONTENT_QUALITY_CONTRACT_VERSION}:${PROVIDER_OUTPUT_VERSION}` }

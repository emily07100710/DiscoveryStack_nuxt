import { resolveCanonicalGeoRules } from '../geo/rules'
import { normalizeContentQualityInput, isRecord, readField, hasExactKeys, normalizeSha256, normalizeWhitespaceText } from './normalization'
import { validateProviderOutput, prohibitedClaimReasonCodes } from './provider-output'
import { parseMarkdownStructure } from './markdown-structure'
import { buildRetrievalResult, tokenizeLexical } from './rag-contract'
import { isReasonCode, type ReasonCode } from './reason-codes'
import type { ContentQualityInput, CoverageMetric, QualityGateResult, QualityStatus, RetrievalResult, StructureChecks, ProviderOutput, PromptPack } from './types'

const RETRIEVAL_RESULT_KEYS = ['status', 'retrievalVersion', 'queryFingerprint', 'retrievalFingerprint', 'corpusSnapshotHash', 'evidenceSnapshotHash', 'chunks', 'reasonCodes', 'limitations'] as const
const CHUNK_KEYS = ['sourceId', 'artifactId', 'chunkId', 'sourceType', 'title', 'locator', 'artifactHash', 'chunkHash', 'corpusSnapshotHash', 'evidenceSnapshotHash', 'reviewedText', 'approvedPurposes', 'capturedAt', 'reviewStatus', 'matchedTokenCount', 'queryTokenCount', 'relevanceRatio', 'scoreBasis', 'limitations'] as const
const QUALITY_KEYS = ['qualityInput', 'providerOutput', 'markdown', 'retrievalResult', 'promptPack'] as const
const BLOCKING_REASONS = new Set<ReasonCode>(['INVALID_INPUT', 'UNKNOWN_FIELD', 'LIMIT_EXCEEDED', 'INVALID_HASH', 'INVALID_TIMESTAMP', 'FUTURE_EVIDENCE', 'EVIDENCE_CHUNK_HASH_MISMATCH', 'EVIDENCE_NOT_APPROVED', 'EVIDENCE_PURPOSE_NOT_ALLOWED', 'EVIDENCE_SNAPSHOT_MISMATCH', 'DUPLICATE_EVIDENCE', 'STALE_EVIDENCE', 'QUERY_FINGERPRINT_MISMATCH', 'RETRIEVAL_NOT_READY', 'RETRIEVAL_CORPUS_MISMATCH', 'RETRIEVAL_OUTSIDE_ALLOWLIST', 'PROMPT_INPUT_LIMIT_EXCEEDED', 'PROVIDER_OUTPUT_MALFORMED', 'CONTENT_HASH_MISMATCH', 'CITATION_OUTSIDE_APPROVED_EVIDENCE', 'CLAIM_WITHOUT_CITATION', 'UNSUPPORTED_QUANTITATIVE_CLAIM', 'FABRICATED_CASE_CLAIM', 'PROHIBITED_PERFORMANCE_GUARANTEE', 'INVALID_CITATION_BINDING', 'UNUSED_CITATION', 'FAQ_BODY_MISMATCH', 'RESPONSE_HASH_MISMATCH', 'RETRIEVAL_FINGERPRINT_MISMATCH'])

function metric(numerator: number, denominator: number): CoverageMetric {
  const boundedDenominator = Math.max(0, denominator)
  const applicable = boundedDenominator > 0
  const safeNumerator = Math.max(0, Math.min(Math.max(0, numerator), boundedDenominator))
  return { metricName: 'deterministic heuristic / coverage metric', applicable, numerator: safeNumerator, denominator: boundedDenominator, ratio: applicable ? safeNumerator / boundedDenominator : null, reasonCodes: applicable ? [] : ['METRIC_NOT_APPLICABLE'] }
}

function emptyChecks(): StructureChecks { return { directAnswer: false, headingHierarchy: false, emptySections: false, duplicateHeadings: false, duplicateParagraphs: false, faqIntegrity: false, citationPlacement: false, conclusionOrCta: false, workingTitleMatchesH1: false, topicOverlap: false, paragraphBindings: false, claimSafety: false, selectedRuleChecks: false } }
function emptyMetric(): CoverageMetric { return metric(0, 0) }
function blockedResult(reasonCodes: ReasonCode[]): QualityGateResult { return { status: 'blocked', reasonCodes: [...new Set(reasonCodes)], sourceCoverage: emptyMetric(), claimCoverage: emptyMetric(), citationCoverage: emptyMetric(), goalCoverage: emptyMetric(), structureChecks: emptyChecks(), limitations: ['Quality gate blocked the output; no publication approval is implied.'], humanReviewRequired: true } }
function emptyRetrieval(status: 'blocked' | 'not_ready', reason: ReasonCode): RetrievalResult { return { status, retrievalVersion: 'geo-content-quality-retrieval-v1', queryFingerprint: '', retrievalFingerprint: null, corpusSnapshotHash: '', evidenceSnapshotHash: '', chunks: [], reasonCodes: [reason], limitations: [] } }

function normalizeRetrievalForQuality(value: unknown, input: ContentQualityInput): RetrievalResult {
  if (value === undefined) return buildRetrievalResult(input, input.approvedEvidenceChunks.map(chunk => ({ chunk })), input)
  if (!isRecord(value) || !hasExactKeys(value, RETRIEVAL_RESULT_KEYS)) return emptyRetrieval('blocked', 'INVALID_INPUT')
  try {
    const status = readField(value, 'status')
    if (status === 'blocked' || status === 'not_ready') {
      const reasonValues = readField(value, 'reasonCodes')
      const reasonCodes: ReasonCode[] = Array.isArray(reasonValues) ? reasonValues.filter(isReasonCode) : ['INVALID_INPUT']
      return emptyRetrieval(status, reasonCodes[0] || 'RETRIEVAL_NOT_READY')
    }
    if (status !== 'ready' || readField(value, 'retrievalVersion') !== 'geo-content-quality-retrieval-v1') return emptyRetrieval('blocked', 'INVALID_INPUT')
    const presentedQueryFingerprint = normalizeSha256(readField(value, 'queryFingerprint'))
    const presentedRetrievalFingerprint = normalizeSha256(readField(value, 'retrievalFingerprint'))
    if (presentedQueryFingerprint !== input.retrievalPlan.queryFingerprint) return emptyRetrieval('blocked', 'QUERY_FINGERPRINT_MISMATCH')
    if (normalizeSha256(readField(value, 'corpusSnapshotHash')) !== input.retrievalPlan.corpusSnapshotHash) return emptyRetrieval('blocked', 'RETRIEVAL_CORPUS_MISMATCH')
    if (normalizeSha256(readField(value, 'evidenceSnapshotHash')) !== input.evidenceSnapshotHash) return emptyRetrieval('blocked', 'EVIDENCE_SNAPSHOT_MISMATCH')
    const chunks = readField(value, 'chunks')
    if (!Array.isArray(chunks)) return emptyRetrieval('blocked', 'INVALID_INPUT')
    const candidates = chunks.map(chunk => {
      if (!isRecord(chunk) || !hasExactKeys(chunk, CHUNK_KEYS)) throw new Error('INVALID_INPUT')
      const baseChunk: Record<string, unknown> = {}
      for (const key of CHUNK_KEYS.slice(0, 14)) baseChunk[key] = readField(chunk, key)
      return { chunk: baseChunk, limitations: readField(chunk, 'limitations') }
    })
    const recomputed = buildRetrievalResult(input, candidates, input)
    if (recomputed.status !== 'ready' || recomputed.retrievalFingerprint !== presentedRetrievalFingerprint) return emptyRetrieval('blocked', 'RETRIEVAL_FINGERPRINT_MISMATCH')
    return recomputed
  } catch (error: unknown) {
    const reason = error instanceof Error && BLOCKING_REASONS.has(error.message as ReasonCode) ? error.message as ReasonCode : 'INVALID_INPUT'
    return emptyRetrieval('blocked', reason)
  }
}

function normalizedComparable(value: string): string { return value.normalize('NFKC').toLowerCase().replace(/\s+/gu, ' ').trim() }
function effectiveLength(value: string, language: ContentQualityInput['language']): number {
  const withoutMarkers = value.replace(/\[cite:[A-Za-z0-9._:-]{1,160}\]/gu, '').replace(/^#{1,6}\s.+$/gmu, ' ')
  if (language === 'zh-hant') return Array.from(withoutMarkers).filter(char => /[\p{L}\p{N}]/u.test(char)).length
  return (withoutMarkers.match(/[\p{L}\p{N}]+/gu) || []).length
}
function withinContentBounds(input: ContentQualityInput, report: ReturnType<typeof parseMarkdownStructure>['report'], markdown: string): boolean {
  if (input.contentType === 'faq') {
    if (report.faqPairs.length < 3 || report.faqPairs.length > 20) return false
    return report.faqPairs.every(pair => { const answerLength = effectiveLength(pair.answer, input.language); return input.language === 'zh-hant' ? answerLength >= 40 && answerLength <= 1200 : answerLength >= 25 && answerLength <= 500 })
  }
  const count = effectiveLength(markdown, input.language)
  const min = input.contentType === 'article' ? (input.language === 'zh-hant' ? 1000 : 600) : (input.language === 'zh-hant' ? 700 : 350)
  const max = input.contentType === 'article' ? (input.language === 'zh-hant' ? 8000 : 4000) : (input.language === 'zh-hant' ? 5000 : 2500)
  return count >= min && count <= max
}
function overlaps(left: readonly string[], right: readonly string[]): boolean { const rightSet = new Set(right); return left.some(token => rightSet.has(token)) }
function validRuleChecks(input: ContentQualityInput, checks: StructureChecks): boolean {
  try {
    const rules = resolveCanonicalGeoRules(input.selectedRuleIds)
    for (const rule of rules) {
      if (rule.id === 'direct-answer-first' && !checks.directAnswer) return false
      if (rule.id === 'heading-hierarchy' && !checks.headingHierarchy) return false
      if (rule.id === 'faq-question-answer' && input.contentType === 'faq' && !checks.faqIntegrity) return false
      if (rule.id === 'citation-readiness' && !checks.citationPlacement) return false
      if (rule.id === 'evidence-boundary' && !checks.paragraphBindings) return false
      if (rule.id === 'claim-safety' && !checks.claimSafety) return false
      if (rule.id === 'structured-data-safety' && !checks.faqIntegrity) return false
    }
    return true
  } catch { return false }
}
function finalStatus(reasonCodes: readonly ReasonCode[], input: ContentQualityInput, checks: StructureChecks, retrieval: RetrievalResult): QualityStatus {
  if (reasonCodes.some(reason => BLOCKING_REASONS.has(reason))) return 'blocked'
  if (retrieval.status !== 'ready') return 'blocked'
  if (reasonCodes.length || input.industryRisk !== 'general' || !checks.conclusionOrCta) return 'needs_human_review'
  return 'passed'
}

export function evaluateContentQuality(value: unknown): QualityGateResult {
  if (!isRecord(value)) return blockedResult(['INVALID_INPUT'])
  const keys = (() => { try { return Object.keys(value) } catch { return [] } })()
  if (!(keys.length === 4 || keys.length === 5) || keys.some(key => !QUALITY_KEYS.includes(key as typeof QUALITY_KEYS[number])) || !keys.includes('qualityInput') || !keys.includes('providerOutput') || !keys.includes('markdown') || !keys.includes('retrievalResult')) return blockedResult(['INVALID_INPUT'])
  const normalizedInput = normalizeContentQualityInput(readField(value, 'qualityInput'))
  if (normalizedInput.status !== 'valid') return blockedResult(normalizedInput.reasonCodes)
  const input = normalizedInput.input
  const retrieval = normalizeRetrievalForQuality(readField(value, 'retrievalResult'), input)
  if (retrieval.status !== 'ready') return blockedResult(retrieval.reasonCodes.length ? retrieval.reasonCodes : ['RETRIEVAL_NOT_READY'])
  const suppliedPrompt = keys.includes('promptPack') ? readField(value, 'promptPack') : undefined
  const promptResult = suppliedPrompt === undefined ? null : suppliedPrompt
  const promptPack = promptResult && isRecord(promptResult) ? promptResult as unknown as PromptPack : undefined
  const provider = validateProviderOutput(input, readField(value, 'providerOutput'), { retrievalResult: retrieval, promptPack })
  if (provider.status !== 'valid') return blockedResult(provider.reasonCodes)
  const markdownValue = readField(value, 'markdown')
  if (typeof markdownValue !== 'string' || markdownValue !== provider.output.body) return blockedResult(['CONTENT_HASH_MISMATCH'])
  const parsedMarkdown = parseMarkdownStructure(markdownValue)
  const report = parsedMarkdown.report
  const output = provider.output
  const topicTokens = tokenizeLexical(`${input.topic} ${input.primaryQuestion}`)
  const bodyTokens = tokenizeLexical(markdownValue)
  const topicOverlap = overlaps(topicTokens, bodyTokens)
  const workingTitleMatchesH1 = report.titleHeading !== null && normalizedComparable(report.titleHeading) === normalizedComparable(input.workingTitle)
  const paragraphBindings = output.paragraphBindings.length === report.paragraphs.length && output.paragraphBindings.every(binding => report.paragraphs.some(paragraph => paragraph.paragraphIndex === binding.paragraphIndex && paragraph.paragraphHash === binding.paragraphHash))
  const claimSafety = prohibitedClaimReasonCodes([output.title, output.summary, output.body, ...output.claims.map(claim => claim.text)].join('\n')).length === 0
  const structureChecks: StructureChecks = { directAnswer: report.directAnswerFirst, headingHierarchy: !report.headingLevelJump && report.headingLevels[0] === 1, emptySections: !report.emptySection, duplicateHeadings: report.duplicateNormalizedHeadings.length === 0, duplicateParagraphs: report.duplicateParagraphs.length === 0, faqIntegrity: !report.faqSectionFound || (report.faqPairs.length > 0 && report.duplicateFaqQuestions.length === 0), citationPlacement: report.citationMarkerPlacementValid, conclusionOrCta: report.conclusionOrCtaFound, workingTitleMatchesH1, topicOverlap, paragraphBindings, claimSafety, selectedRuleChecks: false }
  structureChecks.selectedRuleChecks = validRuleChecks(input, structureChecks)
  const evidenceSourceIds = new Set(input.approvedEvidenceChunks.map(chunk => chunk.sourceId))
  const citedSourceIds = new Set(output.citations.map(citation => citation.sourceId))
  const eligibleClaims = output.claims.filter(claim => ['factual', 'quantitative', 'comparative', 'high_risk'].includes(claim.claimType))
  const boundClaims = eligibleClaims.filter(claim => claim.citationIds.length > 0)
  const citationsUsed = new Set(output.claims.flatMap(claim => claim.citationIds))
  const sourceCoverage = metric([...citedSourceIds].filter(sourceId => evidenceSourceIds.has(sourceId)).length, evidenceSourceIds.size)
  const claimCoverage = metric(boundClaims.length, eligibleClaims.length)
  const citationCoverage = metric(citationsUsed.size, output.citations.length)
  const goalCoverage = metric(input.goals.filter(goal => overlaps(tokenizeLexical(goal), bodyTokens)).length, input.goals.length)
  const reasonCodes: ReasonCode[] = []
  if (!topicOverlap) reasonCodes.push('CONTENT_TOPIC_MISMATCH')
  if (!workingTitleMatchesH1) reasonCodes.push('CONTENT_TOPIC_MISMATCH')
  if (!withinContentBounds(input, report, markdownValue)) reasonCodes.push('CONTENT_LENGTH_OUT_OF_BOUNDS')
  if (parsedMarkdown.status === 'invalid') reasonCodes.push(...parsedMarkdown.reasonCodes)
  if (!structureChecks.selectedRuleChecks) reasonCodes.push('RULE_CHECK_FAILED')
  if (sourceCoverage.applicable && (sourceCoverage.ratio === null || sourceCoverage.ratio < 0.5)) reasonCodes.push('SOURCE_COVERAGE_INSUFFICIENT')
  if (input.industryRisk !== 'general') reasonCodes.push('HIGH_RISK_REVIEW_REQUIRED')
  if (retrieval.chunks.some(chunk => chunk.limitations.some(limitation => /conflict|衝突|矛盾/iu.test(limitation))))     reasonCodes.push('CONFLICTING_EVIDENCE')
  const limitations = [...output.limitations, 'All coverage values are deterministic heuristic / coverage metric outputs with null ratio when not applicable; they are not factual-veracity signals, search placement outcomes, GEO outcomes, conversion outcomes, traffic outcomes, revenue outcomes, ROI outcomes, or LLM citation predictions.', 'Passed does not mean auto-approved, production-ready, delivery-ready, or ready for publication; mandatory human review remains required.']
  const status = finalStatus([...new Set(reasonCodes)], input, structureChecks, retrieval)
  return { status, reasonCodes: [...new Set(reasonCodes)], sourceCoverage, claimCoverage, citationCoverage, goalCoverage, structureChecks, limitations, humanReviewRequired: true }
}

export function qualityGateIsPublishApproval(value: unknown): false { void value; return false }
export function qualityMetricLabel(): CoverageMetric['metricName'] { return 'deterministic heuristic / coverage metric' }

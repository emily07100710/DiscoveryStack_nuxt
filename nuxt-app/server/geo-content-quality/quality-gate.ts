import { normalizeContentQualityInput, isRecord, readField, hasExactKeys } from './normalization'
import { validateProviderOutput, prohibitedClaimReasonCodes } from './provider-output'
import { parseMarkdownStructure } from './markdown-structure'
import { buildRetrievalResult } from './rag-contract'
import type { ReasonCode } from './reason-codes'
import type { ContentQualityInput, CoverageMetric, QualityGateResult, QualityStatus, RetrievalResult, StructureChecks, ProviderOutput } from './types'

const RETRIEVAL_RESULT_KEYS = ['status', 'retrievalVersion', 'corpusSnapshotHash', 'evidenceSnapshotHash', 'chunks', 'reasonCodes', 'limitations'] as const
const CHUNK_KEYS = ['sourceId', 'artifactId', 'chunkId', 'sourceType', 'title', 'locator', 'artifactHash', 'chunkHash', 'corpusSnapshotHash', 'evidenceSnapshotHash', 'reviewedText', 'approvedPurposes', 'capturedAt', 'reviewStatus', 'scoreBasis', 'limitations'] as const

function metric(numerator: number, denominator: number): CoverageMetric {
  const safeNumerator = Math.max(0, Math.min(numerator, denominator))
  return { metricName: 'deterministic heuristic / coverage metric', numerator: safeNumerator, denominator, ratio: denominator === 0 ? 1 : safeNumerator / denominator }
}

function blockedResult(reasonCodes: ReasonCode[]): QualityGateResult {
  return { status: 'blocked', reasonCodes: [...new Set(reasonCodes)], sourceCoverage: metric(0, 0), claimCoverage: metric(0, 0), citationCoverage: metric(0, 0), structureChecks: { directAnswer: false, headingHierarchy: false, emptySections: false, duplicateHeadings: false, duplicateParagraphs: false, faqIntegrity: false, citationPlacement: false, conclusionOrCta: false }, limitations: ['Quality gate blocked the output; no publication approval is implied.'] }
}

function normalizeRetrievalForQuality(value: unknown, input: ContentQualityInput): RetrievalResult {
  if (value === undefined) {
    return buildRetrievalResult(input.retrievalPlan, input.approvedEvidenceChunks.map(chunk => ({ chunk, scoreBasis: 'approved-evidence', limitations: ['No provider score was used.'] })))
  }
  if (!isRecord(value) || !hasExactKeys(value, RETRIEVAL_RESULT_KEYS)) return { status: 'blocked', retrievalVersion: 'geo-content-quality-retrieval-v1', corpusSnapshotHash: '', evidenceSnapshotHash: '', chunks: [], reasonCodes: ['INVALID_INPUT'], limitations: [] }
  try {
    const status = readField(value, 'status')
    const chunks = readField(value, 'chunks')
    if (status === 'blocked' || status === 'not_ready') {
      const reasonCodesValue = readField(value, 'reasonCodes')
      const limitationsValue = readField(value, 'limitations')
      const reasonCodes: ReasonCode[] = Array.isArray(reasonCodesValue) ? reasonCodesValue.filter((item: unknown): item is ReasonCode => typeof item === 'string') : ['INVALID_INPUT']
      const limitations: string[] = Array.isArray(limitationsValue) ? limitationsValue.filter((item: unknown): item is string => typeof item === 'string') : []
      if (status !== 'blocked' && status !== 'not_ready') throw new Error('INVALID_INPUT')
      return { status, retrievalVersion: 'geo-content-quality-retrieval-v1', corpusSnapshotHash: String(readField(value, 'corpusSnapshotHash')), evidenceSnapshotHash: String(readField(value, 'evidenceSnapshotHash')), chunks: [], reasonCodes, limitations }
    }
    if (status !== 'ready' || readField(value, 'retrievalVersion') !== 'geo-content-quality-retrieval-v1' || readField(value, 'corpusSnapshotHash') !== input.retrievalPlan.corpusSnapshotHash || readField(value, 'evidenceSnapshotHash') !== input.evidenceSnapshotHash || !Array.isArray(chunks)) throw new Error('RETRIEVAL_CORPUS_MISMATCH')
    const candidates = chunks.map(chunk => {
      if (!isRecord(chunk) || !hasExactKeys(chunk, CHUNK_KEYS)) throw new Error('INVALID_INPUT')
      const baseChunk: Record<string, unknown> = {}
      for (const key of CHUNK_KEYS.slice(0, 14)) baseChunk[key] = readField(chunk, key)
      return { chunk: baseChunk, scoreBasis: readField(chunk, 'scoreBasis'), limitations: readField(chunk, 'limitations') }
    })
    return buildRetrievalResult(input.retrievalPlan, candidates)
  } catch (error: unknown) {
    const reason = error instanceof Error && ['RETRIEVAL_CORPUS_MISMATCH', 'RETRIEVAL_OUTSIDE_ALLOWLIST', 'EVIDENCE_SNAPSHOT_MISMATCH', 'DUPLICATE_EVIDENCE', 'EVIDENCE_PURPOSE_NOT_ALLOWED'].includes(error.message) ? error.message as ReasonCode : 'INVALID_INPUT'
    return { status: 'blocked', retrievalVersion: 'geo-content-quality-retrieval-v1', corpusSnapshotHash: '', evidenceSnapshotHash: '', chunks: [], reasonCodes: [reason], limitations: [] }
  }
}

function emptyChecks(): StructureChecks { return { directAnswer: false, headingHierarchy: false, emptySections: false, duplicateHeadings: false, duplicateParagraphs: false, faqIntegrity: false, citationPlacement: false, conclusionOrCta: false } }

function finalStatus(reasonCodes: ReasonCode[], input: ContentQualityInput, structure: StructureChecks, output: ProviderOutput, retrieval: RetrievalResult, claimCoverage: CoverageMetric, sourceCoverage: CoverageMetric, citationCoverage: CoverageMetric, limitations: string[]): QualityStatus {
  if (reasonCodes.some(reason => ['CITATION_OUTSIDE_APPROVED_EVIDENCE', 'CONTENT_HASH_MISMATCH', 'UNSUPPORTED_QUANTITATIVE_CLAIM', 'FABRICATED_CASE_CLAIM', 'PROHIBITED_PERFORMANCE_GUARANTEE', 'RETRIEVAL_CORPUS_MISMATCH', 'RETRIEVAL_OUTSIDE_ALLOWLIST', 'EVIDENCE_SNAPSHOT_MISMATCH', 'STALE_EVIDENCE', 'APPLIED_RULE_OUTSIDE_SELECTION', 'PROVIDER_OUTPUT_MALFORMED', 'TEMPLATE_FILLER', 'UNSUPPORTED_LOCALE_OUTPUT', 'CLAIM_WITHOUT_CITATION'].includes(reason))) return 'blocked'
  if (retrieval.status !== 'ready') return 'blocked'
  if (reasonCodes.length > 0) return 'needs_human_review'
  if (structure.emptySections && structure.duplicateHeadings && structure.duplicateParagraphs && structure.directAnswer && structure.faqIntegrity && structure.citationPlacement && structure.headingHierarchy && claimCoverage.ratio === 1 && sourceCoverage.ratio === 1 && citationCoverage.ratio === 1 && !prohibitedClaimReasonCodes([output.title, output.summary, output.body, ...output.claims.map(claim => claim.text)].join('\n')).length) {
    if (input.industryRisk !== 'general' || !structure.conclusionOrCta || limitations.length < 1) return 'needs_human_review'
    return 'passed'
  }
  return 'needs_human_review'
}

export function evaluateContentQuality(value: unknown): QualityGateResult {
  if (!isRecord(value) || !hasExactKeys(value, ['qualityInput', 'providerOutput', 'markdown', 'retrievalResult'])) return blockedResult(['INVALID_INPUT'])
  const normalizedInput = normalizeContentQualityInput(readField(value, 'qualityInput'))
  if (normalizedInput.status !== 'valid') return blockedResult(normalizedInput.reasonCodes)
  const input = normalizedInput.input
  const retrieval = normalizeRetrievalForQuality(readField(value, 'retrievalResult'), input)
  if (retrieval.status !== 'ready') return blockedResult(retrieval.reasonCodes.length ? retrieval.reasonCodes : ['RETRIEVAL_NOT_READY'])
  const provider = validateProviderOutput(input, readField(value, 'providerOutput'))
  if (provider.status !== 'valid') return blockedResult(provider.reasonCodes)
  const markdownValue = readField(value, 'markdown')
  if (typeof markdownValue !== 'string' || markdownValue !== provider.output.body) return blockedResult(['CONTENT_HASH_MISMATCH'])
  const parsedMarkdown = parseMarkdownStructure(markdownValue)
  const report = parsedMarkdown.report
  const output = provider.output
  const availableEvidence = input.approvedEvidenceChunks
  const evidenceSourceIds = new Set(availableEvidence.map(chunk => chunk.sourceId))
  const citedSourceIds = new Set(output.citations.map(citation => citation.sourceId))
  const eligibleClaims = output.claims.filter(claim => ['factual', 'quantitative', 'comparative', 'medical', 'legal', 'financial'].includes(claim.claimType))
  const boundClaims = eligibleClaims.filter(claim => claim.citationIds.length > 0)
  const citationIds = new Set(output.citations.map(citation => citation.citationId))
  const citationsUsed = new Set(eligibleClaims.flatMap(claim => claim.citationIds).filter(id => citationIds.has(id)))
  const sourceCoverage = metric([...citedSourceIds].filter(sourceId => evidenceSourceIds.has(sourceId)).length, evidenceSourceIds.size)
  const claimCoverage = metric(boundClaims.length, eligibleClaims.length)
  const citationCoverage = metric(citationsUsed.size, output.citations.length)
  const structureChecks: StructureChecks = { directAnswer: report.directAnswerFirst, headingHierarchy: !report.headingLevelJump, emptySections: !report.emptySection, duplicateHeadings: report.duplicateNormalizedHeadings.length === 0, duplicateParagraphs: report.duplicateParagraphs.length === 0, faqIntegrity: !report.faqSectionFound || (report.faqPairs.length > 0 && report.duplicateFaqQuestions.length === 0), citationPlacement: report.citationMarkerPlacementValid, conclusionOrCta: report.conclusionOrCtaFound }
  const reasonCodes: ReasonCode[] = []
  if (eligibleClaims.some(claim => claim.citationIds.length === 0)) reasonCodes.push('CLAIM_WITHOUT_CITATION')
  if (eligibleClaims.some(claim => claim.claimType === 'quantitative' && claim.citationIds.length === 0)) reasonCodes.push('UNSUPPORTED_QUANTITATIVE_CLAIM')
  if (sourceCoverage.ratio < 0.5 && evidenceSourceIds.size > 0) reasonCodes.push('SOURCE_COVERAGE_INSUFFICIENT')
  if (parsedMarkdown.status === 'invalid') reasonCodes.push(...parsedMarkdown.reasonCodes)
  if (input.industryRisk !== 'general') reasonCodes.push('HIGH_RISK_REVIEW_REQUIRED')
  if (retrieval.chunks.some(chunk => chunk.limitations.some(limitation => /conflict|衝突|矛盾/iu.test(limitation)))) reasonCodes.push('CONFLICTING_EVIDENCE')
  if (input.language === 'zh-hant' && report.simplifiedChineseFound) reasonCodes.push('UNSUPPORTED_LOCALE_OUTPUT')
  const limitations = [...output.limitations, 'All coverage values are deterministic heuristic / coverage metric outputs, not factual-veracity signals, search placement outcomes, GEO outcomes, conversion outcomes, traffic outcomes, revenue outcomes, ROI outcomes, or LLM citation predictions.', 'Passed does not mean auto-approved or ready for publication; human review remains required.']
  const status = finalStatus(reasonCodes, input, structureChecks, output, retrieval, claimCoverage, sourceCoverage, citationCoverage, limitations)
  return { status, reasonCodes: [...new Set(reasonCodes)], sourceCoverage, claimCoverage, citationCoverage, structureChecks, limitations }
}

export function qualityGateIsPublishApproval(value: unknown): false {
  void value
  return false
}

export function qualityMetricLabel(): CoverageMetric['metricName'] { return 'deterministic heuristic / coverage metric' }

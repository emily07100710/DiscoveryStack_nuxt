import {
  buildPromptPack,
  buildRetrievalResult,
  canonicalizeQualityValue,
  evaluateContentQuality,
  fingerprintContentQualityInput,
  normalizeContentQualityInput,
  parseMarkdownStructure,
  sha256Text,
  type ContentLanguage,
  type ContentQualityInput,
  type ContentType,
  type ProviderOutput,
  type ProviderProvenance,
  type QualityGateResult,
  type RetrievalResult,
} from '../geo-content-quality'
import type {
  EvaluationFingerprintResult,
  EvaluationReasonCode,
  GeoContentEvaluationCandidateInput,
  GeoContentEvaluationCase,
} from './types'
import { EVALUATION_SUITE_VERSION } from './types'

const CANDIDATE_KEYS = ['caseId', 'candidateId', 'variantLabel', 'qualityInput', 'providerOutput', 'markdown'] as const

type CanonicalContext = {
  input: ContentQualityInput
  providerOutput: ProviderOutput | null
  markdown: string | null
  retrieval: RetrievalResult | null
  promptFingerprint: string | null
  qualityGateResult: QualityGateResult | null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  try {
    const actual = Object.keys(value)
    return actual.length === keys.length && actual.every(key => keys.includes(key))
  } catch {
    return false
  }
}

function safeRead(value: Record<string, unknown>, key: string): unknown {
  try {
    return value[key]
  } catch {
    return undefined
  }
}

function stringField(value: unknown, maxLength = 256): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength ? value : null
}

function safeCanonicalHash(value: unknown): string | null {
  try {
    return sha256Text(canonicalizeQualityValue(value))
  } catch {
    return null
  }
}

function briefFingerprint(input: ContentQualityInput): string | null {
  return safeCanonicalHash({
    briefId: input.briefId,
    topic: input.topic,
    workingTitle: input.workingTitle,
    primaryQuestion: input.primaryQuestion,
    audience: input.audience,
    brandVoice: input.brandVoice,
    goals: input.goals,
    constraints: input.constraints,
  })
}

function emptyCase(caseId: string, candidateId: string, variantLabel: string, reasonCodes: EvaluationReasonCode[]): GeoContentEvaluationCase {
  return {
    suiteVersion: EVALUATION_SUITE_VERSION,
    status: reasonCodes.includes('EVALUATION_DATA_INSUFFICIENT') ? 'insufficient_data' : 'blocked',
    caseId,
    contentType: null,
    locale: null,
    topic: null,
    briefFingerprint: null,
    promptPackFingerprint: null,
    retrievalFingerprint: null,
    evidenceSnapshotHash: null,
    selectedRuleIds: null,
    candidateId,
    variantLabel,
    exactMarkdown: null,
    contentHash: null,
    providerProvenance: null,
    qualityInput: null,
    providerOutput: null,
    qualityGateResult: null,
    metrics: [],
    reasonCodes: [...new Set(reasonCodes)],
  }
}

function metricReasonCodes(value: QualityGateResult): EvaluationReasonCode[] {
  return value.reasonCodes.map(reason => reason as EvaluationReasonCode)
}

function contextForCandidate(candidate: Record<string, unknown>): { context: CanonicalContext | null, reasonCodes: EvaluationReasonCode[] } {
  const normalizedInput = normalizeContentQualityInput(safeRead(candidate, 'qualityInput'))
  if (normalizedInput.status !== 'valid') {
    return { context: null, reasonCodes: ['EVALUATION_INVALID_INPUT', ...normalizedInput.reasonCodes.map(reason => reason === 'UNKNOWN_FIELD' ? 'EVALUATION_UNKNOWN_FIELD' : reason as EvaluationReasonCode)] }
  }

  const input = normalizedInput.input
  const markdownValue = safeRead(candidate, 'markdown')
  const markdown = typeof markdownValue === 'string' ? markdownValue : null
  const providerValue = safeRead(candidate, 'providerOutput')
  const providerOutput = isRecord(providerValue) ? providerValue as unknown as ProviderOutput : null
  const retrieval = buildRetrievalResult(input, input.approvedEvidenceChunks.map(chunk => ({ chunk })))
  const prompt = buildPromptPack(input, retrieval)
  const promptFingerprint = prompt.status === 'ready' ? prompt.promptPack.promptFingerprint : null
  const qualityGateResult = markdown !== null && providerOutput !== null
    ? evaluateContentQuality({ qualityInput: input, providerOutput, markdown, retrievalResult: retrieval, promptPack: prompt.status === 'ready' ? prompt.promptPack : undefined })
    : null

  const reasons: EvaluationReasonCode[] = []
  if (retrieval.status !== 'ready') reasons.push('EVALUATION_DATA_INSUFFICIENT')
  if (prompt.status !== 'ready') reasons.push('EVALUATION_DATA_INSUFFICIENT')
  if (qualityGateResult !== null) reasons.push(...metricReasonCodes(qualityGateResult))
  if (markdown === null || providerOutput === null) reasons.push('EVALUATION_DATA_INSUFFICIENT')

  return {
    context: { input, providerOutput, markdown, retrieval, promptFingerprint, qualityGateResult },
    reasonCodes: [...new Set(reasons)],
  }
}

function metricsFromQualityGate(result: QualityGateResult, input: ContentQualityInput, output: ProviderOutput): GeoContentEvaluationCase['metrics'] {
  const checks = result.structureChecks
  const booleanMetric = (metricName: GeoContentEvaluationCase['metrics'][number]['metricName'], value: boolean, evidenceLocator: string[]): GeoContentEvaluationCase['metrics'][number] => ({
    metricName,
    applicable: true,
    numerator: value ? 1 : 0,
    denominator: 1,
    ratio: value ? 1 : 0,
    reasonCodes: value ? [] : result.reasonCodes.map(reason => reason as EvaluationReasonCode),
    evidenceLocator,
  })

  return [
    booleanMetric('direct-answer-presence', checks.directAnswer, ['markdown:first-meaningful-paragraph']),
    booleanMetric('heading-hierarchy', checks.headingHierarchy, ['markdown:heading-levels']),
    booleanMetric('paragraph-bounds', result.reasonCodes.includes('CONTENT_LENGTH_OUT_OF_BOUNDS') === false, ['markdown:meaningful-paragraph-count']),
    input.contentType === 'faq'
      ? booleanMetric('faq-binding', checks.faqIntegrity, ['markdown:faq'])
      : { metricName: 'faq-binding', applicable: false, numerator: 0, denominator: 0, ratio: null, reasonCodes: ['METRIC_NOT_APPLICABLE'], evidenceLocator: ['markdown:faq'] },
    booleanMetric('selected-autogeo-rule-coverage', checks.selectedRuleChecks, ['quality-gate:selected-rule-checks']),
    booleanMetric('citation-marker-coverage', checks.citationPlacement, ['markdown:citation-markers']),
    { ...result.sourceCoverage, metricName: 'selected-evidence-utilization', evidenceLocator: ['quality-gate:source-coverage'] },
    { metricName: 'unused-citation-count', applicable: true, numerator: Math.max(0, result.citationCoverage.denominator - result.citationCoverage.numerator), denominator: result.citationCoverage.denominator, ratio: result.citationCoverage.denominator === 0 ? null : (result.citationCoverage.denominator - result.citationCoverage.numerator) / result.citationCoverage.denominator, reasonCodes: result.citationCoverage.denominator === 0 ? ['METRIC_NOT_APPLICABLE'] : [], evidenceLocator: ['quality-gate:citation-coverage'] },
    (() => {
      const factualClaims = output.claims.filter(claim => ['factual', 'quantitative', 'comparative', 'high_risk'].includes(claim.claimType))
      const unsupportedCount = factualClaims.filter(claim => claim.citationIds.length === 0).length
      return { metricName: 'unsupported-factual-claim-findings', applicable: factualClaims.length > 0, numerator: unsupportedCount, denominator: factualClaims.length, ratio: factualClaims.length > 0 ? unsupportedCount / factualClaims.length : null, reasonCodes: unsupportedCount > 0 ? ['CLAIM_WITHOUT_CITATION'] : [], evidenceLocator: ['quality-gate:reason-codes'] }
    })(),
    (() => {
      const authorityIds = new Set(input.authoritySources.map(source => source.sourceId))
      const authorityCitations = output.citations.filter(citation => authorityIds.has(citation.sourceId))
      return { metricName: 'authority-source-binding', applicable: input.authoritySources.length > 0, numerator: authorityCitations.length > 0 ? 1 : 0, denominator: input.authoritySources.length > 0 ? 1 : 0, ratio: input.authoritySources.length > 0 ? (authorityCitations.length > 0 ? 1 : 0) : null, reasonCodes: input.authoritySources.length > 0 && authorityCitations.length === 0 ? ['AUTHORITY_SOURCE_BINDING_MISSING'] : [], evidenceLocator: ['quality-input:authority-sources', 'provider-output:citations'] }
    })(),
    booleanMetric('title-h1-alignment', checks.workingTitleMatchesH1, ['markdown:title-h1']),
    booleanMetric('topic-lexical-relevance', checks.topicOverlap, ['quality-input:topic']),
    booleanMetric('content-bounds', !result.reasonCodes.includes('CONTENT_LENGTH_OUT_OF_BOUNDS'), ['markdown:content-bounds']),
    booleanMetric('provider-provenance-integrity', !result.reasonCodes.includes('PROVIDER_PROVENANCE_MISMATCH'), ['provider-output:provenance']),
    booleanMetric('human-review-requirement', result.humanReviewRequired === true, ['quality-gate:human-review']),
  ]
}

function buildCase(candidate: Record<string, unknown>, context: CanonicalContext, identity: { caseId: string, candidateId: string, variantLabel: string }): GeoContentEvaluationCase {
  const input = context.input
  const qualityGateResult = context.qualityGateResult
  const markdown = context.markdown
  const contentFingerprint = fingerprintContentQualityInput(input)
  const reasonCodes: EvaluationReasonCode[] = [...(qualityGateResult?.reasonCodes.map(reason => reason as EvaluationReasonCode) ?? [])]
  const status = qualityGateResult === null
    ? 'insufficient_data'
    : qualityGateResult.status === 'blocked'
      ? 'blocked'
      : 'review_ready'

  return {
    suiteVersion: EVALUATION_SUITE_VERSION,
    status,
    caseId: identity.caseId,
    contentType: input.contentType,
    locale: input.language,
    topic: input.topic,
    briefFingerprint: briefFingerprint(input),
    promptPackFingerprint: context.promptFingerprint,
    retrievalFingerprint: context.retrieval?.status === 'ready' ? context.retrieval.retrievalFingerprint : null,
    evidenceSnapshotHash: input.evidenceSnapshotHash,
    selectedRuleIds: [...input.selectedRuleIds],
    candidateId: identity.candidateId,
    variantLabel: identity.variantLabel,
    exactMarkdown: markdown,
    contentHash: markdown === null ? null : sha256Text(markdown),
    providerProvenance: context.providerOutput === null ? null : {
      provider: context.providerOutput.provider,
      model: context.providerOutput.model,
      requestId: context.providerOutput.requestId,
      providerVersion: input.providerProvenance.providerVersion,
      generationMode: input.providerProvenance.generationMode,
      requestedAt: context.providerOutput.requestedAt,
      generatedAt: context.providerOutput.generatedAt,
    },
    qualityInput: input,
    providerOutput: context.providerOutput,
    qualityGateResult,
    metrics: qualityGateResult === null || context.providerOutput === null ? [] : metricsFromQualityGate(qualityGateResult, input, context.providerOutput),
    reasonCodes: [...new Set(reasonCodes)],
  }
}

export function createGeoContentEvaluationCase(value: unknown): GeoContentEvaluationCase {
  if (!isRecord(value) || !exactKeys(value, CANDIDATE_KEYS)) {
    return emptyCase('', '', '', ['EVALUATION_INVALID_INPUT', 'EVALUATION_UNKNOWN_FIELD'])
  }

  const caseId = stringField(safeRead(value, 'caseId'), 160)
  const candidateId = stringField(safeRead(value, 'candidateId'), 160)
  const variantLabel = stringField(safeRead(value, 'variantLabel'), 160)
  if (caseId === null || candidateId === null || variantLabel === null) {
    return emptyCase(caseId ?? '', candidateId ?? '', variantLabel ?? '', ['EVALUATION_INVALID_INPUT'])
  }

  const { context, reasonCodes } = contextForCandidate(value)
  if (context === null) return emptyCase(caseId, candidateId, variantLabel, reasonCodes)
  const result = buildCase(value, context, { caseId, candidateId, variantLabel })
  if (reasonCodes.length > 0 && result.status === 'review_ready') {
    return { ...result, status: 'insufficient_data', reasonCodes: [...new Set([...result.reasonCodes, ...reasonCodes])] }
  }

  return { ...result, reasonCodes: [...new Set([...result.reasonCodes, ...reasonCodes])] }
}

export function computeEvaluationFingerprint(value: unknown): EvaluationFingerprintResult {
  if (!isRecord(value)) return { status: 'invalid', fingerprint: null, canonicalValue: null, reasonCodes: ['EVALUATION_INVALID_INPUT'] }
  try {
    const canonicalValue = canonicalizeQualityValue(value)
    return { status: 'valid', fingerprint: sha256Text(canonicalValue), canonicalValue, reasonCodes: [] }
  } catch {
    return { status: 'invalid', fingerprint: null, canonicalValue: null, reasonCodes: ['EVALUATION_INVALID_INPUT'] }
  }
}

export function evaluationCaseFingerprint(value: GeoContentEvaluationCase): EvaluationFingerprintResult {
  return computeEvaluationFingerprint({
    suiteVersion: value.suiteVersion,
    caseId: value.caseId,
    contentType: value.contentType,
    locale: value.locale,
    topic: value.topic,
    briefFingerprint: value.briefFingerprint,
    promptPackFingerprint: value.promptPackFingerprint,
    retrievalFingerprint: value.retrievalFingerprint,
    evidenceSnapshotHash: value.evidenceSnapshotHash,
    selectedRuleIds: value.selectedRuleIds,
    candidateId: value.candidateId,
    variantLabel: value.variantLabel,
    exactMarkdown: value.exactMarkdown,
    contentHash: value.contentHash,
    providerProvenance: value.providerProvenance,
    qualityGateResult: value.qualityGateResult,
    metrics: value.metrics,
    reasonCodes: value.reasonCodes,
  })
}

export type { GeoContentEvaluationCandidateInput }

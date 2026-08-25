import {
  buildPromptPack,
  buildRetrievalResult,
  canonicalizeQualityValue,
  evaluateContentQuality,
  fingerprintContentQualityInput,
  normalizeContentQualityInput,
  sha256Text,
  validateProviderOutput,
  type ContentQualityInput,
  type ProviderOutput,
  type QualityGateResult,
  type RetrievalResult,
} from '../geo-content-quality'
import { makeEvaluationMetric } from './metrics'
import type {
  EvaluationFingerprintResult,
  EvaluationReasonCode,
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
  providerMissing: boolean
  providerInvalid: boolean
  markdownMissing: boolean
}

type ContextResult = {
  context: CanonicalContext | null
  reasonCodes: EvaluationReasonCode[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  try {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
  } catch {
    return false
  }
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

function normalizeInputReason(reason: string): EvaluationReasonCode {
  return reason === 'UNKNOWN_FIELD' ? 'EVALUATION_UNKNOWN_FIELD' : reason as EvaluationReasonCode
}

function contextForCandidate(candidate: Record<string, unknown>): ContextResult {
  try {
    const normalizedInput = normalizeContentQualityInput(safeRead(candidate, 'qualityInput'))
    if (normalizedInput.status !== 'valid') {
      return { context: null, reasonCodes: ['EVALUATION_INVALID_INPUT', ...normalizedInput.reasonCodes.map(normalizeInputReason)] }
    }

    const input = normalizedInput.input
    const markdownValue = safeRead(candidate, 'markdown')
    const markdownMissing = typeof markdownValue !== 'string'
    const markdown = typeof markdownValue === 'string' ? markdownValue : null
    const providerValue = safeRead(candidate, 'providerOutput')
    const providerMissing = providerValue === null || providerValue === undefined || !isRecord(providerValue)
    const providerInvalid = !providerMissing

    const retrieval = buildRetrievalResult(input, input.approvedEvidenceChunks.map(chunk => ({ chunk })))
    const prompt = buildPromptPack(input, retrieval)
    const promptFingerprint = prompt.status === 'ready' ? prompt.promptPack.promptFingerprint : null
    const reasons: EvaluationReasonCode[] = []
    if (retrieval.status !== 'ready' || prompt.status !== 'ready') reasons.push('EVALUATION_DATA_INSUFFICIENT')
    if (markdownMissing) reasons.push('EVALUATION_DATA_INSUFFICIENT')

    if (providerMissing) {
      reasons.push('EVALUATION_DATA_INSUFFICIENT')
      return {
        context: { input, providerOutput: null, markdown, retrieval, promptFingerprint, qualityGateResult: null, providerMissing: true, providerInvalid: false, markdownMissing },
        reasonCodes: [...new Set(reasons)],
      }
    }

    const providerResult = validateProviderOutput(input, providerValue, {
      retrievalResult: retrieval,
      promptPack: prompt.status === 'ready' ? prompt.promptPack : undefined,
    })
    if (providerResult.status !== 'valid') {
      reasons.push(...providerResult.reasonCodes.map(reason => reason as EvaluationReasonCode))
      if (providerResult.reasonCodes.length === 0) reasons.push('EVALUATION_INVALID_INPUT')
      return {
        context: { input, providerOutput: null, markdown, retrieval, promptFingerprint, qualityGateResult: null, providerMissing: false, providerInvalid: true, markdownMissing },
        reasonCodes: [...new Set(reasons)],
      }
    }

    const providerOutput = providerResult.output
    const qualityGateResult = markdownMissing
      ? null
      : evaluateContentQuality({ qualityInput: input, providerOutput, markdown, retrievalResult: retrieval, promptPack: prompt.status === 'ready' ? prompt.promptPack : undefined })
    if (qualityGateResult !== null) reasons.push(...qualityGateResult.reasonCodes.map(reason => reason as EvaluationReasonCode))
    return {
      context: { input, providerOutput, markdown, retrieval, promptFingerprint, qualityGateResult, providerMissing: false, providerInvalid: false, markdownMissing },
      reasonCodes: [...new Set(reasons)],
    }
  } catch {
    return { context: null, reasonCodes: ['EVALUATION_INVALID_INPUT'] }
  }
}

function metricsFromQualityGate(result: QualityGateResult, input: ContentQualityInput, output: ProviderOutput): GeoContentEvaluationCase['metrics'] {
  const checks = result.structureChecks
  const booleanMetric = (metricName: GeoContentEvaluationCase['metrics'][number]['metricName'], value: boolean, failureCode: EvaluationReasonCode, evidenceLocator: string[]): GeoContentEvaluationCase['metrics'][number] => makeEvaluationMetric(metricName, value ? 1 : 0, 1, value ? [] : [failureCode], evidenceLocator)
  const citationDenominator = result.citationCoverage.denominator
  const unusedCitationCount = Math.max(0, citationDenominator - result.citationCoverage.numerator)
  const factualClaims = output.claims.filter(claim => ['factual', 'quantitative', 'comparative', 'high_risk'].includes(claim.claimType))
  const unsupportedCount = factualClaims.filter(claim => claim.citationIds.length === 0).length
  const authorityIds = new Set(input.authoritySources.map(source => source.sourceId))
  const authorityCitationFound = output.citations.some(citation => authorityIds.has(citation.sourceId))

  return [
    booleanMetric('direct-answer-presence', checks.directAnswer, 'EVALUATION_DIRECT_ANSWER_MISSING', ['markdown:first-meaningful-paragraph']),
    booleanMetric('heading-hierarchy', checks.headingHierarchy, 'EVALUATION_HEADING_HIERARCHY_FAILED', ['markdown:heading-levels']),
    booleanMetric('paragraph-binding-integrity', checks.paragraphBindings, 'EVALUATION_PARAGRAPH_BINDING_FAILED', ['provider-output:paragraph-bindings']),
    input.contentType === 'faq'
      ? booleanMetric('faq-binding', checks.faqIntegrity, 'EVALUATION_FAQ_BINDING_FAILED', ['markdown:faq'])
      : makeEvaluationMetric('faq-binding', 0, 0, ['METRIC_NOT_APPLICABLE'], ['markdown:faq']),
    booleanMetric('selected-autogeo-rule-coverage', checks.selectedRuleChecks, 'EVALUATION_RULE_COVERAGE_FAILED', ['quality-gate:selected-rule-checks']),
    booleanMetric('citation-marker-coverage', checks.citationPlacement, 'EVALUATION_CITATION_MARKER_FAILED', ['markdown:citation-markers']),
    makeEvaluationMetric('selected-evidence-utilization', result.sourceCoverage.numerator, result.sourceCoverage.denominator, result.sourceCoverage.numerator === result.sourceCoverage.denominator ? [] : ['EVALUATION_EVIDENCE_UTILIZATION_FAILED'], ['quality-gate:source-coverage']),
    makeEvaluationMetric('unused-citation-count', unusedCitationCount, citationDenominator, unusedCitationCount === 0 ? [] : ['EVALUATION_UNUSED_CITATIONS_FOUND'], ['quality-gate:citation-coverage']),
    makeEvaluationMetric('unsupported-factual-claim-findings', unsupportedCount, factualClaims.length, unsupportedCount === 0 ? [] : ['EVALUATION_UNSUPPORTED_FACTUAL_CLAIMS_FOUND'], ['quality-gate:reason-codes']),
    makeEvaluationMetric('authority-source-binding', authorityCitationFound ? 1 : 0, input.authoritySources.length > 0 ? 1 : 0, input.authoritySources.length === 0 ? ['METRIC_NOT_APPLICABLE'] : authorityCitationFound ? [] : ['EVALUATION_AUTHORITY_BINDING_FAILED'], ['quality-input:authority-sources', 'provider-output:citations']),
    booleanMetric('title-h1-alignment', checks.workingTitleMatchesH1, 'EVALUATION_TITLE_H1_MISMATCH', ['markdown:title-h1']),
    booleanMetric('topic-lexical-relevance', checks.topicOverlap, 'EVALUATION_TOPIC_RELEVANCE_FAILED', ['quality-input:topic']),
    booleanMetric('content-bounds', !result.reasonCodes.includes('CONTENT_LENGTH_OUT_OF_BOUNDS'), 'EVALUATION_CONTENT_BOUNDS_FAILED', ['markdown:content-bounds']),
    makeEvaluationMetric('provider-provenance-integrity', 1, 1, [], ['provider-output:provenance']),
    makeEvaluationMetric('human-review-requirement', 1, 1, ['EVALUATION_HUMAN_REVIEW_REQUIRED'], ['quality-gate:human-review']),
  ]
}

function buildCase(context: CanonicalContext, identity: { caseId: string, candidateId: string, variantLabel: string }, extraReasons: EvaluationReasonCode[]): GeoContentEvaluationCase {
  const input = context.input
  const qualityGateResult = context.qualityGateResult
  const markdown = context.markdown
  const contentFingerprint = fingerprintContentQualityInput(input)
  const qualityReasons: EvaluationReasonCode[] = qualityGateResult?.reasonCodes.map(reason => reason as EvaluationReasonCode) ?? []
  const reasonCodes = [...new Set([...qualityReasons, ...extraReasons])]
  const status = context.providerInvalid
    ? 'blocked'
    : qualityGateResult === null
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
    reasonCodes,
  }
}

export function createGeoContentEvaluationCase(value: unknown): GeoContentEvaluationCase {
  try {
    if (!isRecord(value) || !exactKeys(value, CANDIDATE_KEYS)) return emptyCase('', '', '', ['EVALUATION_INVALID_INPUT', 'EVALUATION_UNKNOWN_FIELD'])
    const caseId = stringField(safeRead(value, 'caseId'), 160)
    const candidateId = stringField(safeRead(value, 'candidateId'), 160)
    const variantLabel = stringField(safeRead(value, 'variantLabel'), 160)
    if (caseId === null || candidateId === null || variantLabel === null) return emptyCase(caseId ?? '', candidateId ?? '', variantLabel ?? '', ['EVALUATION_INVALID_INPUT'])
    const result = contextForCandidate(value)
    if (result.context === null) return emptyCase(caseId, candidateId, variantLabel, result.reasonCodes)
    return buildCase(result.context, { caseId, candidateId, variantLabel }, result.reasonCodes)
  } catch {
    return emptyCase('', '', '', ['EVALUATION_INVALID_INPUT'])
  }
}

export function computeEvaluationFingerprint(value: unknown): EvaluationFingerprintResult {
  try {
    if (!isRecord(value)) return { status: 'invalid', fingerprint: null, canonicalValue: null, reasonCodes: ['EVALUATION_INVALID_INPUT'] }
    const canonicalValue = canonicalizeQualityValue(value)
    return { status: 'valid', fingerprint: sha256Text(canonicalValue), canonicalValue, reasonCodes: [] }
  } catch {
    return { status: 'invalid', fingerprint: null, canonicalValue: null, reasonCodes: ['EVALUATION_INVALID_INPUT'] }
  }
}

export function evaluationCaseFingerprint(value: unknown): EvaluationFingerprintResult {
  try {
    if (!isRecord(value)) return { status: 'invalid', fingerprint: null, canonicalValue: null, reasonCodes: ['EVALUATION_INVALID_INPUT'] }
    return computeEvaluationFingerprint({
      suiteVersion: safeRead(value, 'suiteVersion'),
      caseId: safeRead(value, 'caseId'),
      contentType: safeRead(value, 'contentType'),
      locale: safeRead(value, 'locale'),
      topic: safeRead(value, 'topic'),
      briefFingerprint: safeRead(value, 'briefFingerprint'),
      promptPackFingerprint: safeRead(value, 'promptPackFingerprint'),
      retrievalFingerprint: safeRead(value, 'retrievalFingerprint'),
      evidenceSnapshotHash: safeRead(value, 'evidenceSnapshotHash'),
      selectedRuleIds: safeRead(value, 'selectedRuleIds'),
      candidateId: safeRead(value, 'candidateId'),
      variantLabel: safeRead(value, 'variantLabel'),
      exactMarkdown: safeRead(value, 'exactMarkdown'),
      contentHash: safeRead(value, 'contentHash'),
      providerProvenance: safeRead(value, 'providerProvenance'),
      qualityGateResult: safeRead(value, 'qualityGateResult'),
      metrics: safeRead(value, 'metrics'),
      reasonCodes: safeRead(value, 'reasonCodes'),
    })
  } catch {
    return { status: 'invalid', fingerprint: null, canonicalValue: null, reasonCodes: ['EVALUATION_INVALID_INPUT'] }
  }
}

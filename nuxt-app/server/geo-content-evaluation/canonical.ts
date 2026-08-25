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
import { EVALUATION_METRIC_NAMES, EVALUATION_STATUSES, EVALUATION_SUITE_VERSION } from './types'
import { validateRawCandidateEnvelope } from './raw-candidate'

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

type CanonicalInputContext = {
  input: ContentQualityInput
  retrieval: RetrievalResult | null
  promptResult: ReturnType<typeof buildPromptPack>
  promptFingerprint: string | null
  baseReasonCodes: EvaluationReasonCode[]
}

export type CanonicalEvaluationCache = WeakMap<object, CanonicalInputContext>

function isRecord(value: unknown): value is Record<string, unknown> {
  try {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
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

function contextForCandidate(candidate: Record<string, unknown>, cache?: WeakMap<object, CanonicalInputContext>): ContextResult {
  try {
    const qualityInputValue = safeRead(candidate, 'qualityInput')
    let inputContext: CanonicalInputContext | null = null
    if (isRecord(qualityInputValue) && cache?.has(qualityInputValue)) inputContext = cache.get(qualityInputValue) ?? null
    if (inputContext === null) {
      const normalizedInput = normalizeContentQualityInput(qualityInputValue)
      if (normalizedInput.status !== 'valid') return { context: null, reasonCodes: ['EVALUATION_INVALID_INPUT', ...normalizedInput.reasonCodes.map(normalizeInputReason)] }
      const input = normalizedInput.input
      const retrieval = buildRetrievalResult(input, input.approvedEvidenceChunks.map(chunk => ({ chunk })))
      const promptResult = buildPromptPack(input, retrieval)
      inputContext = {
        input,
        retrieval,
        promptResult,
        promptFingerprint: promptResult.status === 'ready' ? promptResult.promptPack.promptFingerprint : null,
        baseReasonCodes: retrieval.status !== 'ready' || promptResult.status !== 'ready' ? ['EVALUATION_DATA_INSUFFICIENT'] : [],
      }
      if (isRecord(qualityInputValue) && cache) cache.set(qualityInputValue, inputContext)
    }

    const { input, retrieval } = inputContext
    const markdownValue = safeRead(candidate, 'markdown')
    const markdownMissing = markdownValue === null
    const markdown = typeof markdownValue === 'string' ? markdownValue : null
    const providerValue = safeRead(candidate, 'providerOutput')
    const providerMissing = providerValue === null
    const providerInvalid = !providerMissing && !isRecord(providerValue)
    const reasons: EvaluationReasonCode[] = [...inputContext.baseReasonCodes]
    if (markdownMissing || providerMissing) reasons.push('EVALUATION_DATA_INSUFFICIENT')

    if (providerMissing) {
      return {
        context: { input, providerOutput: null, markdown, retrieval, promptFingerprint: inputContext.promptFingerprint, qualityGateResult: null, providerMissing: true, providerInvalid: false, markdownMissing },
        reasonCodes: [...new Set(reasons)],
      }
    }

    const providerResult = validateProviderOutput(input, providerValue, {
      retrievalResult: retrieval ?? undefined,
      promptPack: inputContext.promptResult.status === 'ready' ? inputContext.promptResult.promptPack : undefined,
    })
    if (providerResult.status !== 'valid') {
      reasons.push(...providerResult.reasonCodes.map(reason => reason as EvaluationReasonCode))
      if (providerResult.reasonCodes.length === 0) reasons.push('EVALUATION_INVALID_INPUT')
      return {
        context: { input, providerOutput: null, markdown, retrieval, promptFingerprint: inputContext.promptFingerprint, qualityGateResult: null, providerMissing: false, providerInvalid: true, markdownMissing },
        reasonCodes: [...new Set(reasons)],
      }
    }

    const providerOutput = providerResult.output
    const qualityGateResult = markdownMissing
      ? null
      : evaluateContentQuality({ qualityInput: input, providerOutput, markdown, retrievalResult: retrieval, promptPack: inputContext.promptResult.status === 'ready' ? inputContext.promptResult.promptPack : undefined })
    if (qualityGateResult !== null) reasons.push(...qualityGateResult.reasonCodes.map(reason => reason as EvaluationReasonCode))
    return {
      context: { input, providerOutput, markdown, retrieval, promptFingerprint: inputContext.promptFingerprint, qualityGateResult, providerMissing: false, providerInvalid, markdownMissing },
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

export function createGeoContentEvaluationCaseWithCache(value: unknown, cache: CanonicalEvaluationCache): GeoContentEvaluationCase {
  try {
    const raw = validateRawCandidateEnvelope(value)
    if (raw.status !== 'valid') return emptyCase(raw.caseId, raw.candidateId, raw.variantLabel, raw.reasonCodes)
    const result = contextForCandidate(raw.value, cache)
    if (result.context === null) return emptyCase(raw.value.caseId, raw.value.candidateId, raw.value.variantLabel, result.reasonCodes)
    return buildCase(result.context, { caseId: raw.value.caseId, candidateId: raw.value.candidateId, variantLabel: raw.value.variantLabel }, result.reasonCodes)
  } catch {
    return emptyCase('', '', '', ['EVALUATION_INVALID_INPUT'])
  }
}

export function createGeoContentEvaluationCase(value: unknown): GeoContentEvaluationCase {
  return createGeoContentEvaluationCaseWithCache(value, new WeakMap<object, CanonicalInputContext>())
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

const EVALUATION_CASE_FINGERPRINT_KEYS = [
  'suiteVersion', 'status', 'caseId', 'contentType', 'locale', 'topic', 'briefFingerprint', 'promptPackFingerprint',
  'retrievalFingerprint', 'evidenceSnapshotHash', 'selectedRuleIds', 'candidateId', 'variantLabel', 'exactMarkdown',
  'contentHash', 'providerProvenance', 'qualityInput', 'providerOutput', 'qualityGateResult', 'metrics', 'reasonCodes',
] as const

function readEvaluationCaseFields(value: Record<string, unknown>): Record<string, unknown> | null {
  try {
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) return null
    const ownKeys = Reflect.ownKeys(value)
    if (ownKeys.some(key => typeof key !== 'string')) return null
    const stringKeys = ownKeys as string[]
    if (stringKeys.length !== EVALUATION_CASE_FINGERPRINT_KEYS.length || EVALUATION_CASE_FINGERPRINT_KEYS.some(key => !stringKeys.includes(key))) return null
    for (const key of stringKeys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (!descriptor || descriptor.enumerable !== true || descriptor.get !== undefined || descriptor.set !== undefined) return null
    }
    const fields: Record<string, unknown> = {}
    for (const key of EVALUATION_CASE_FINGERPRINT_KEYS) fields[key] = value[key]
    return fields
  } catch {
    return null
  }
}

function validNullableString(value: unknown): boolean { return value === null || typeof value === 'string' }
function validStringList(value: unknown): boolean { return value === null || Array.isArray(value) && value.every(item => typeof item === 'string') }
function validMetricCatalog(value: unknown): boolean {
  if (!Array.isArray(value) || value.length !== EVALUATION_METRIC_NAMES.length) return false
  return value.every((item, index) => {
    if (!isRecord(item) || item.metricName !== EVALUATION_METRIC_NAMES[index]) return false
    const applicable = item.applicable
    const numerator = item.numerator
    const denominator = item.denominator
    const ratio = item.ratio
    if (typeof applicable !== 'boolean' || typeof numerator !== 'number' || typeof denominator !== 'number' || !Number.isSafeInteger(numerator) || !Number.isSafeInteger(denominator) || !Array.isArray(item.reasonCodes) || !item.reasonCodes.every(reason => typeof reason === 'string') || !Array.isArray(item.evidenceLocator) || !item.evidenceLocator.every(locator => typeof locator === 'string')) return false
    if (!applicable) return numerator === 0 && denominator === 0 && ratio === null && item.reasonCodes.some(reason => reason === 'METRIC_NOT_APPLICABLE' || reason === 'EVALUATION_NON_FINITE_METRIC' || reason === 'EVALUATION_METRIC_BOUNDS')
    return denominator > 0 && numerator >= 0 && numerator <= denominator && typeof ratio === 'number' && ratio === numerator / denominator
  })
}

function evaluationCaseIsCoherent(fields: Record<string, unknown>): boolean {
  const status = fields.status
  if (fields.suiteVersion !== EVALUATION_SUITE_VERSION || !EVALUATION_STATUSES.includes(status as typeof EVALUATION_STATUSES[number])) return false
  if (![fields.caseId, fields.candidateId, fields.variantLabel].every(value => typeof value === 'string' && value.length > 0)) return false
  if (![fields.contentType, fields.locale, fields.topic, fields.briefFingerprint, fields.promptPackFingerprint, fields.retrievalFingerprint, fields.evidenceSnapshotHash].every(validNullableString)) return false
  if (!validStringList(fields.selectedRuleIds) || !Array.isArray(fields.metrics) || fields.metrics.length > 0 && !validMetricCatalog(fields.metrics) || !Array.isArray(fields.reasonCodes) || !fields.reasonCodes.every(reason => typeof reason === 'string')) return false
  const markdown = fields.exactMarkdown
  const contentHash = fields.contentHash
  if (typeof markdown !== 'string' && markdown !== null) return false
  if (markdown === null ? contentHash !== null : contentHash !== sha256Text(markdown)) return false
  const qualityInput = fields.qualityInput
  let normalizedInput: ContentQualityInput | null = null
  let expectedRetrieval: RetrievalResult | null = null
  let expectedPromptResult: ReturnType<typeof buildPromptPack> | null = null
  if (qualityInput !== null) {
    if (!isRecord(qualityInput)) return false
    const normalized = normalizeContentQualityInput(qualityInput)
    if (normalized.status !== 'valid') return false
    normalizedInput = normalized.input
    if (fields.contentType !== normalizedInput.contentType || fields.locale !== normalizedInput.language || fields.topic !== normalizedInput.topic || fields.briefFingerprint !== briefFingerprint(normalizedInput) || fields.evidenceSnapshotHash !== normalizedInput.evidenceSnapshotHash) return false
    if (!Array.isArray(fields.selectedRuleIds) || fields.selectedRuleIds.length !== normalizedInput.selectedRuleIds.length || fields.selectedRuleIds.some((rule, index) => rule !== normalizedInput!.selectedRuleIds[index])) return false
    expectedRetrieval = buildRetrievalResult(normalizedInput, normalizedInput.approvedEvidenceChunks.map(chunk => ({ chunk })))
    const expectedRetrievalFingerprint = expectedRetrieval.status === 'ready' ? expectedRetrieval.retrievalFingerprint : null
    if (fields.retrievalFingerprint !== expectedRetrievalFingerprint) return false
    expectedPromptResult = buildPromptPack(normalizedInput, expectedRetrieval)
    const expectedPromptFingerprint = expectedPromptResult.status === 'ready' ? expectedPromptResult.promptPack.promptFingerprint : null
    if (fields.promptPackFingerprint !== expectedPromptFingerprint) return false
  } else return false
  const providerOutput = fields.providerOutput
  if (providerOutput !== null && !isRecord(providerOutput)) return false
  const providerValidation = providerOutput !== null && normalizedInput !== null
    ? validateProviderOutput(normalizedInput, providerOutput, { retrievalResult: expectedRetrieval ?? undefined, promptPack: expectedPromptResult?.status === 'ready' ? expectedPromptResult.promptPack : undefined })
    : null
  if (providerOutput !== null && providerValidation?.status !== 'valid') return false
  if (fields.providerProvenance !== null && !isRecord(fields.providerProvenance)) return false
  if ((providerOutput === null) !== (fields.providerProvenance === null)) return false
  if (providerOutput !== null && normalizedInput !== null && fields.providerProvenance !== null) {
    const expectedProvenance = {
      provider: providerOutput.provider,
      model: providerOutput.model,
      requestId: providerOutput.requestId,
      providerVersion: normalizedInput.providerProvenance.providerVersion,
      generationMode: normalizedInput.providerProvenance.generationMode,
      requestedAt: providerOutput.requestedAt,
      generatedAt: providerOutput.generatedAt,
    }
    if (canonicalizeQualityValue(fields.providerProvenance) !== canonicalizeQualityValue(expectedProvenance)) return false
  }
  const qualityGateResult = fields.qualityGateResult
  if (qualityGateResult !== null && !isRecord(qualityGateResult)) return false
  if (qualityGateResult !== null && providerOutput === null) return false
  let expectedQualityGateResult: QualityGateResult | null = null
  if (providerValidation?.status === 'valid' && markdown !== null && normalizedInput !== null) {
    const gateInput = {
      qualityInput: normalizedInput,
      providerOutput: providerValidation.output,
      markdown,
      retrievalResult: expectedRetrieval,
      ...(expectedPromptResult?.status === 'ready' ? { promptPack: expectedPromptResult.promptPack } : {}),
    }
    expectedQualityGateResult = evaluateContentQuality(gateInput)
  }
  if (qualityGateResult === null ? expectedQualityGateResult !== null : expectedQualityGateResult === null || canonicalizeQualityValue(qualityGateResult) !== canonicalizeQualityValue(expectedQualityGateResult)) return false
  if (status === 'review_ready') {
    if (qualityInput === null || providerOutput === null || markdown === null || qualityGateResult === null || qualityGateResult.status === 'blocked' || fields.reasonCodes.includes('EVALUATION_CASE_BLOCKED') || !Array.isArray(fields.metrics) || fields.metrics.length !== EVALUATION_METRIC_NAMES.length) return false
  }
  if (status === 'insufficient_data') {
    if (qualityGateResult !== null || (providerOutput !== null && markdown !== null) || !fields.reasonCodes.includes('EVALUATION_DATA_INSUFFICIENT')) return false
  }
  if (status === 'blocked' && qualityGateResult !== null && qualityGateResult.status !== 'blocked') return false
  return true
}

export function evaluationCaseFingerprint(value: unknown): EvaluationFingerprintResult {
  try {
    if (!isRecord(value)) return { status: 'invalid', fingerprint: null, canonicalValue: null, reasonCodes: ['EVALUATION_INVALID_INPUT'] }
    const fields = readEvaluationCaseFields(value)
    if (fields === null || !evaluationCaseIsCoherent(fields)) return { status: 'invalid', fingerprint: null, canonicalValue: null, reasonCodes: ['EVALUATION_INVALID_INPUT'] }
    return computeEvaluationFingerprint(fields)
  } catch {
    return { status: 'invalid', fingerprint: null, canonicalValue: null, reasonCodes: ['EVALUATION_INVALID_INPUT'] }
  }
}

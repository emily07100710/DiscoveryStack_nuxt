import {
  OUTCOME_ALLOWED_CONSENT_USES,
  OUTCOME_DATA_CONTRACT_VERSION,
  OUTCOME_EVALUATION_CONTRACT_VERSION,
  OUTCOME_FORBIDDEN_REASON_CODES,
  OUTCOME_LEARNING_POLICY_VERSION,
  OUTCOME_MAX_CANDIDATE_LIMITATIONS,
  OUTCOME_MAX_DATASET_CANDIDATES,
  OUTCOME_MAX_EVALUATION_CASES,
  OUTCOME_MAX_MEASUREMENTS,
  OUTCOME_MAX_METRIC_FIELDS,
  OUTCOME_MAX_PUBLICATIONS,
  OUTCOME_MAX_FOLLOW_UP_DAYS,
  OUTCOME_MIN_CONTENT_TYPE_COUNT,
  OUTCOME_MIN_DATASET_CANDIDATES,
  OUTCOME_MIN_EVALUATION_CASES,
  OUTCOME_MIN_FOLLOW_UP_DAYS,
  OUTCOME_MIN_LANGUAGE_COUNT,
  OUTCOME_MIN_READY_SOURCES,
  OUTCOME_MIN_TASK_QUALITY_IMPROVEMENT,
  OUTCOME_POLICY_LIMITATIONS,
  OUTCOME_POLICY_LIMITATIONS_FOR_CANDIDATE,
  OUTCOME_POLICY_LIMITATIONS_FOR_DATASET,
  OUTCOME_POLICY_LIMITATIONS_FOR_RELEASE,
  OUTCOME_SOURCE_ORDER,
  OUTCOME_SOURCE_HASHES_PER_SOURCE,
  OUTCOME_SPLIT_TEST_RATIO,
  OUTCOME_SPLIT_TRAIN_RATIO,
  OUTCOME_SPLIT_VALIDATION_RATIO,
} from './policy-catalog'
import {
  containsForbiddenOutcomeKey,
  domainSeparatedOutcomeSha256,
  isOutcomeSha256,
  normalizeModelReleaseGateRequest,
  normalizeOutcomeFeatureRecord,
  normalizeOutcomeLearningCandidate,
  normalizeOutcomeMeasurement,
  normalizeOutcomeReferenceIdentifier,
  normalizeOutcomeReferenceText,
  outcomeHashValidationReason,
  normalizeOutcomeText,
  normalizeOutcomeTimestamp,
  normalizePublicationIdentity,
  outcomeSha256,
} from './normalization'
import { buildOutcomeMetricComparison, combineSignals } from './metrics'
import {
  OUTCOME_LEARNING_ENGINE_VERSION,
  outcomeContentTypes,
  outcomeLanguages,
  outcomeMeasurementSources,
  type ConsentLineage,
  type ModelEvaluationMetrics,
  type ModelReleaseGateRequest,
  type ModelReleaseGateResult,
  type NormalizedOutcomeMeasurement,
  type OutcomeDatasetManifest,
  type OutcomeLearningCandidate,
  type OutcomeLearningCandidateResult,
  type OutcomeSignal,
  type OutcomeStatus,
  type OutcomeLanguage,
  type PublishedContentOutcomeAssessment,
  type PublicationIdentity,
} from './types'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) => left < right ? -1 : left > right ? 1 : 0)
}

function safeReasonCodes(values: readonly string[]): string[] {
  return uniqueSorted(values.filter((value) => typeof value === 'string' && value.length > 0))
}

function safeLimitations(values: readonly string[]): string[] {
  return uniqueSorted(values.filter((value) => typeof value === 'string' && value.length > 0))
}

function publicationIdentityHash(publication: PublicationIdentity): string {
  return outcomeSha256({
    scheduleEntryId: publication.scheduleEntryId,
    scheduleKey: publication.scheduleKey,
    productionPlanId: publication.productionPlanId,
    jobId: publication.jobId,
    draftId: publication.draftId,
    draftVersion: publication.draftVersion,
    contentHash: publication.contentHash,
    evidenceSnapshotHash: publication.evidenceSnapshotHash,
  })
}

function baseAssessment(publication: PublicationIdentity | null, reasons: readonly string[] = [], statusOverride?: OutcomeStatus): PublishedContentOutcomeAssessment {
  const safePublication = publication ?? {
    deidentifiedSubjectKey: '', scheduleEntryId: '', scheduleKey: '', productionPlanId: '', jobId: '', draftId: '', draftVersion: '', contentHash: '', evidenceSnapshotHash: '', publishedAt: '', contentType: 'other' as const, language: 'en' as const, appliedRuleIds: [], topicClusterCode: '',
  }
  const status: OutcomeStatus = statusOverride ?? (reasons.length > 0 ? 'blocked' : 'insufficient_data')
  const result = {
    status,
    signal: 'insufficient_data' as const,
    publication: safePublication,
    comparisons: [] as PublishedContentOutcomeAssessment['comparisons'],
    validPairCount: 0,
    validSourceCount: 0,
    reasonCodes: safeReasonCodes(reasons),
    limitations: [...OUTCOME_POLICY_LIMITATIONS],
    policyVersion: OUTCOME_LEARNING_POLICY_VERSION,
    engineVersion: OUTCOME_LEARNING_ENGINE_VERSION,
    dataContractVersion: OUTCOME_DATA_CONTRACT_VERSION,
  }
  return { ...result, assessmentFingerprint: outcomeSha256(result) }
}

function metricFieldCount(values: readonly unknown[]): number | null {
  let count = 0
  try {
    for (const measurement of values) {
      if (!isRecord(measurement)) return null
      const metrics = measurement.metrics
      if (!isRecord(metrics)) return null
      count += Object.keys(metrics).length
      if (count > OUTCOME_MAX_METRIC_FIELDS) return count
    }
    return count
  } catch {
    return null
  }
}

function shallowPublicationCount(input: Record<string, unknown>): number | null {
  if (input.publications === undefined) return 1
  if (!Array.isArray(input.publications)) return null
  return input.publications.length
}

function asMeasurementArray(value: unknown): unknown[] | null {
  return Array.isArray(value) ? value : null
}

function pairMismatchReasons(baselineInputs: readonly unknown[], followUpInputs: readonly unknown[]): string[] {
  if (baselineInputs.length !== 1 || followUpInputs.length !== 1 || !isRecord(baselineInputs[0]) || !isRecord(followUpInputs[0])) return []
  const baseline = baselineInputs[0]
  const followUp = followUpInputs[0]
  const reasons: string[] = []
  if (baseline.source !== followUp.source) reasons.push('SOURCE_MISMATCH')
  if (baseline.deidentifiedSubjectKey !== followUp.deidentifiedSubjectKey) reasons.push('SUBJECT_MISMATCH')
  if (baseline.scopeFingerprint !== followUp.scopeFingerprint) reasons.push('SCOPE_MISMATCH')
  return reasons
}

function validatePairWindow(baseline: NormalizedOutcomeMeasurement, followUp: NormalizedOutcomeMeasurement, publishedAt: number): string[] {
  const reasons: string[] = []
  if (Date.parse(baseline.windowEnd) > publishedAt) reasons.push('WINDOW_MISMATCH')
  if (Date.parse(followUp.windowStart) < publishedAt) reasons.push('WINDOW_MISMATCH')
  if (followUp.durationDays < OUTCOME_MIN_FOLLOW_UP_DAYS || followUp.durationDays > OUTCOME_MAX_FOLLOW_UP_DAYS) reasons.push('WINDOW_MISMATCH')
  if (Date.parse(baseline.windowEnd) > Date.parse(followUp.windowStart)) reasons.push('OVERLAPPING_WINDOWS')
  return reasons
}

function comparableMeasurementPair(baselines: readonly NormalizedOutcomeMeasurement[], followUps: readonly NormalizedOutcomeMeasurement[], publication: PublicationIdentity): { comparisons: PublishedContentOutcomeAssessment['comparisons']; reasons: string[] } {
  const reasons: string[] = []
  const comparisons: PublishedContentOutcomeAssessment['comparisons'] = []
  const seenSourceHash = new Set<string>()
  const seenWindows = new Set<string>()
  const publishedAt = Date.parse(publication.publishedAt)
  for (const measurement of [...baselines, ...followUps]) {
    if (seenSourceHash.has(measurement.sourceHash)) reasons.push('DUPLICATE_SOURCE_HASH')
    seenSourceHash.add(measurement.sourceHash)
    const windowKey = `${measurement.source}|${measurement.windowStart}|${measurement.windowEnd}|${measurement.scopeFingerprint}`
    if (seenWindows.has(windowKey)) reasons.push('DUPLICATE_MEASUREMENT')
    seenWindows.add(windowKey)
  }
  for (const source of OUTCOME_SOURCE_ORDER) {
    const sourceBaselines = baselines.filter((measurement) => measurement.source === source)
    const sourceFollowUps = followUps.filter((measurement) => measurement.source === source)
    if (sourceBaselines.length === 0 || sourceFollowUps.length === 0) continue
    const baseline = sourceBaselines[0]
    const followUp = sourceFollowUps[0]
    if (!baseline || !followUp) continue
    if (sourceBaselines.length !== 1 || sourceFollowUps.length !== 1) reasons.push('DUPLICATE_MEASUREMENT')
    if (baseline.deidentifiedSubjectKey !== publication.deidentifiedSubjectKey || followUp.deidentifiedSubjectKey !== publication.deidentifiedSubjectKey) reasons.push('SUBJECT_MISMATCH')
    if (baseline.scopeFingerprint !== followUp.scopeFingerprint) reasons.push('SCOPE_MISMATCH')
    const windowReasons = validatePairWindow(baseline, followUp, publishedAt)
    reasons.push(...windowReasons)
    if (windowReasons.length === 0 && baseline.deidentifiedSubjectKey === followUp.deidentifiedSubjectKey && baseline.scopeFingerprint === followUp.scopeFingerprint) comparisons.push(buildOutcomeMetricComparison(baseline, followUp))
  }
  return { comparisons, reasons: safeReasonCodes(reasons) }
}

function normalizeAssessmentRequest(input: unknown): { publication: PublicationIdentity | null; baselineInputs: unknown[]; followUpInputs: unknown[]; reasons: string[] } {
  if (!isRecord(input) || containsForbiddenOutcomeKey(input)) return { publication: null, baselineInputs: [], followUpInputs: [], reasons: ['INVALID_INPUT', 'FORBIDDEN_PAYLOAD_KEY'] }
  try {
    const publication = normalizePublicationIdentity(input.publication)
    const baselineInputs = asMeasurementArray(input.baselineMeasurements)
    const followUpInputs = asMeasurementArray(input.followUpMeasurements)
    const dataContractVersion = normalizeOutcomeText(input.dataContractVersion)
    const reasons: string[] = []
    if (!publication) reasons.push('INVALID_PUBLICATION_IDENTITY')
    if (!baselineInputs || !followUpInputs) reasons.push('INVALID_INPUT')
    const publicationCount = shallowPublicationCount(input)
    if (publicationCount === null) reasons.push('INVALID_INPUT')
    else if (publicationCount > OUTCOME_MAX_PUBLICATIONS) reasons.push('TOO_MANY_PUBLICATIONS')
    if (!dataContractVersion) reasons.push('DATA_CONTRACT_MISSING')
    else if (dataContractVersion !== OUTCOME_DATA_CONTRACT_VERSION) reasons.push('DATA_CONTRACT_MISMATCH')
    const all = [...(baselineInputs ?? []), ...(followUpInputs ?? [])]
    if (all.length > OUTCOME_MAX_MEASUREMENTS) reasons.push('TOO_MANY_MEASUREMENTS')
    const rawSourceHashes = all.filter(isRecord).map((measurement) => measurement.sourceHash).filter((hash): hash is string => typeof hash === 'string')
    if (new Set(rawSourceHashes).size !== rawSourceHashes.length) reasons.push('DUPLICATE_SOURCE_HASH')
    const fieldCount = metricFieldCount(all)
    if (fieldCount === null) reasons.push('INVALID_METRIC')
    else if (fieldCount > OUTCOME_MAX_METRIC_FIELDS) reasons.push('TOO_MANY_METRIC_FIELDS')
    reasons.push(...pairMismatchReasons(baselineInputs ?? [], followUpInputs ?? []))
    return { publication, baselineInputs: baselineInputs ?? [], followUpInputs: followUpInputs ?? [], reasons: safeReasonCodes(reasons) }
  } catch {
    return { publication: null, baselineInputs: [], followUpInputs: [], reasons: ['INVALID_INPUT'] }
  }
}

export function assessPublishedContentOutcome(input: unknown): PublishedContentOutcomeAssessment {
  try {
    const normalized = normalizeAssessmentRequest(input)
    if (normalized.reasons.length > 0 || !normalized.publication) return baseAssessment(normalized.publication, normalized.reasons)
    const baselineMeasurements: NormalizedOutcomeMeasurement[] = []
    const followUpMeasurements: NormalizedOutcomeMeasurement[] = []
    const reasons: string[] = []
    for (const raw of normalized.baselineInputs) {
      const measurement = normalizeOutcomeMeasurement(raw)
      if (!measurement || measurement.phase !== 'baseline') reasons.push('INVALID_METRIC')
      else baselineMeasurements.push(measurement)
    }
    for (const raw of normalized.followUpInputs) {
      const measurement = normalizeOutcomeMeasurement(raw)
      if (!measurement || measurement.phase !== 'follow_up') reasons.push('INVALID_METRIC')
      else followUpMeasurements.push(measurement)
    }
    const allSubjectMatch = [...baselineMeasurements, ...followUpMeasurements].every((measurement) => measurement.deidentifiedSubjectKey === normalized.publication!.deidentifiedSubjectKey)
    if (!allSubjectMatch) reasons.push('SUBJECT_MISMATCH')
    if (reasons.length > 0) return baseAssessment(normalized.publication, reasons)
    const pairing = comparableMeasurementPair(baselineMeasurements, followUpMeasurements, normalized.publication)
    if (pairing.reasons.length > 0) {
      const blocked = baseAssessment(normalized.publication, pairing.reasons)
      const result = { ...blocked, comparisons: pairing.comparisons, validPairCount: pairing.comparisons.length, validSourceCount: new Set(pairing.comparisons.map((comparison) => comparison.source)).size }
      return { ...result, assessmentFingerprint: outcomeSha256(result) }
    }
    if (pairing.comparisons.length === 0) return baseAssessment(normalized.publication, ['NO_VALID_PAIR'], 'insufficient_data')
    const signal = combineSignals(pairing.comparisons.map((comparison) => comparison.signal))
    const validSourceCount = new Set(pairing.comparisons.map((comparison) => comparison.source)).size
    const status: OutcomeStatus = validSourceCount >= OUTCOME_MIN_READY_SOURCES ? 'ready' : 'partial'
    const result = { status, signal, publication: normalized.publication, comparisons: pairing.comparisons, validPairCount: pairing.comparisons.length, validSourceCount, reasonCodes: [], limitations: [...OUTCOME_POLICY_LIMITATIONS], policyVersion: OUTCOME_LEARNING_POLICY_VERSION, engineVersion: OUTCOME_LEARNING_ENGINE_VERSION, dataContractVersion: OUTCOME_DATA_CONTRACT_VERSION }
    return { ...result, assessmentFingerprint: outcomeSha256(result) }
  } catch {
    return baseAssessment(null, ['INVALID_INPUT'])
  }
}

function blockedCandidate(reasonCodes: readonly string[], fingerprintSeed: unknown = null): OutcomeLearningCandidateResult {
  const normalizedReasons = safeReasonCodes(reasonCodes)
  return { candidateStatus: 'blocked', reasonCodes: normalizedReasons, limitations: safeLimitations([...OUTCOME_POLICY_LIMITATIONS, 'Learning candidate was not admitted.']), policyVersion: OUTCOME_LEARNING_POLICY_VERSION, engineVersion: OUTCOME_LEARNING_ENGINE_VERSION, candidateFingerprint: outcomeSha256({ status: 'blocked', reasonCodes: normalizedReasons, seed: typeof fingerprintSeed === 'string' ? fingerprintSeed : null }) }
}

function normalizeConsent(value: unknown): ConsentLineage | null {
  if (!isRecord(value) || containsForbiddenOutcomeKey(value)) return null
  const consentStatus = value.consentStatus
  const consentVersion = normalizeOutcomeReferenceIdentifier(value.consentVersion) ?? ''
  const consentedAt = value.consentedAt === null ? null : normalizeOutcomeTimestamp(value.consentedAt)
  const consentAllowedUses = Array.isArray(value.consentAllowedUses) ? uniqueSorted(value.consentAllowedUses.filter((item): item is string => typeof item === 'string').map((item) => item.normalize('NFKC').trim().toLocaleLowerCase('en-US')).filter(Boolean)) : []
  const consentRevokedAt = value.consentRevokedAt === null ? null : normalizeOutcomeTimestamp(value.consentRevokedAt)
  const rightsConfirmed = value.rightsConfirmed === true
  if ((consentStatus !== 'granted' && consentStatus !== 'not_granted' && consentStatus !== 'unknown') || !consentVersion || !consentedAt || !consentAllowedUses.length || value.consentRevokedAt !== null && !consentRevokedAt) return null
  if (consentAllowedUses.some((item) => !OUTCOME_ALLOWED_CONSENT_USES.includes(item as never))) return null
  return { consentStatus, consentVersion, consentedAt, consentAllowedUses, consentRevokedAt, rightsConfirmed }
}

function aggregateFeatures(comparisons: readonly PublishedContentOutcomeAssessment['comparisons'][number][]): Record<string, number> {
  const features: Record<string, number> = {}
  for (const comparison of comparisons) {
    for (const [key, numeric] of Object.entries(comparison.baselineDailyMetrics)) {
      features[`${comparison.source}.${key}.baseline`] = numeric
      const followUpValue = comparison.followUpDailyMetrics[key]
      if (typeof followUpValue === 'number') features[`${comparison.source}.${key}.delta`] = followUpValue - numeric
    }
    for (const [key, numeric] of Object.entries(comparison.followUpDailyMetrics)) features[`${comparison.source}.${key}.follow_up`] = numeric
  }
  return Object.fromEntries(Object.entries(features).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0))
}

function assessmentShapeKeys(value: Record<string, unknown>): string[] {
  return Object.keys(value).sort((left, right) => left < right ? -1 : left > right ? 1 : 0)
}

function assessmentIsSuppliedAndExact(supplied: unknown, expected: PublishedContentOutcomeAssessment): 'missing' | 'invalid' | 'mismatch' | 'valid' {
  if (supplied === undefined || supplied === null) return 'missing'
  if (!isRecord(supplied)) return 'invalid'
  const expectedRecord = expected as unknown as Record<string, unknown>
  if (typeof supplied.assessmentFingerprint !== 'string' || supplied.assessmentFingerprint !== expected.assessmentFingerprint) return 'mismatch'
  if (assessmentShapeKeys(supplied).join('|') !== assessmentShapeKeys(expectedRecord).join('|')) return 'invalid'
  try {
    const { assessmentFingerprint: _ignored, ...suppliedBody } = supplied
    if (outcomeSha256(suppliedBody) !== expected.assessmentFingerprint) return 'mismatch'
  } catch {
    return 'invalid'
  }
  return 'valid'
}

function candidateReferenceHashes(publication: PublicationIdentity): { topicClusterHash: string; appliedRuleHashes: string[] } | null {
  const topic = normalizeOutcomeReferenceText(publication.topicClusterCode)
  const rules = publication.appliedRuleIds.map((rule) => normalizeOutcomeReferenceText(rule))
  if (!topic || rules.some((rule): rule is null => rule === null)) return null
  const normalizedRules = rules.filter((rule): rule is string => rule !== null)
  return { topicClusterHash: domainSeparatedOutcomeSha256('topic_cluster', topic), appliedRuleHashes: uniqueSorted(normalizedRules.map((rule) => domainSeparatedOutcomeSha256('applied_rule', rule))) }
}

export function buildOutcomeLearningCandidate(input: unknown): OutcomeLearningCandidateResult {
  try {
    if (!isRecord(input) || containsForbiddenOutcomeKey(input)) return blockedCandidate(['INVALID_INPUT', 'FORBIDDEN_PAYLOAD_KEY'])
    const outcomeRequest = input.outcomeRequest
    const suppliedAssessment = input.assessment
    const assessment = assessPublishedContentOutcome(outcomeRequest)
    const consent = normalizeConsent(input.consent)
    const reasons: string[] = []
    if (!isRecord(outcomeRequest) || outcomeRequest.dataContractVersion !== OUTCOME_DATA_CONTRACT_VERSION) reasons.push('DATA_CONTRACT_MISMATCH')
    if (input.dataContractVersion !== OUTCOME_DATA_CONTRACT_VERSION) reasons.push(typeof input.dataContractVersion === 'string' && input.dataContractVersion.trim() ? 'DATA_CONTRACT_MISMATCH' : 'DATA_CONTRACT_MISSING')
    if (isRecord(suppliedAssessment) && suppliedAssessment.dataContractVersion !== OUTCOME_DATA_CONTRACT_VERSION) reasons.push('DATA_CONTRACT_MISMATCH')
    const assessmentState = assessmentIsSuppliedAndExact(suppliedAssessment, assessment)
    if (assessmentState === 'missing') reasons.push('ASSESSMENT_REQUIRED')
    else if (assessmentState === 'invalid') reasons.push('ASSESSMENT_INVALID', 'CANDIDATE_NOT_ELIGIBLE')
    else if (assessmentState === 'mismatch') reasons.push('ASSESSMENT_FINGERPRINT_MISMATCH', 'CANDIDATE_NOT_ELIGIBLE')
    if (!consent || consent.consentStatus !== 'granted') reasons.push('CONSENT_REQUIRED')
    if (consent?.consentRevokedAt) reasons.push('CONSENT_REVOKED')
    if (!consent?.consentAllowedUses.includes('model_improvement')) reasons.push('CONSENT_USE_NOT_ALLOWED')
    if (!consent?.rightsConfirmed) reasons.push('RIGHTS_NOT_CONFIRMED')
    if (input.piiScanStatus !== 'none_detected') reasons.push('PII_DETECTED')
    if (assessment.status !== 'ready' && assessment.status !== 'partial') reasons.push('CANDIDATE_NOT_ELIGIBLE')
    if (assessment.validPairCount < 1) reasons.push('NO_VALID_PAIR')
    const references = assessment.publication ? candidateReferenceHashes(assessment.publication) : null
    if (!references) reasons.push('VALUE_POLICY_VIOLATION')
    if (reasons.length > 0 || !consent || !references) return blockedCandidate(reasons.length > 0 ? reasons : ['INVALID_INPUT'], assessment.assessmentFingerprint)
    const publication = assessment.publication
    const candidateBase: Omit<OutcomeLearningCandidate, 'candidateFingerprint'> = {
      candidateStatus: 'eligible',
      deidentifiedSubjectKey: publication.deidentifiedSubjectKey,
      publicationIdentityHashes: [publicationIdentityHash(publication)],
      contentType: publication.contentType,
      language: publication.language,
      appliedRuleHashes: references.appliedRuleHashes,
      topicClusterHash: references.topicClusterHash,
      aggregateNumericFeatures: aggregateFeatures(assessment.comparisons),
      directionalLabels: assessment.comparisons.map((comparison) => ({ source: comparison.source, signal: comparison.signal })).sort((left, right) => left.source < right.source ? -1 : left.source > right.source ? 1 : 0),
      sourceHashes: uniqueSorted(assessment.comparisons.flatMap((comparison) => comparison.sourceHashes)),
      measurementSources: uniqueSorted(assessment.comparisons.map((comparison) => comparison.source)) as OutcomeLearningCandidate['measurementSources'],
      policyVersion: OUTCOME_LEARNING_POLICY_VERSION,
      engineVersion: OUTCOME_LEARNING_ENGINE_VERSION,
      consentLineage: consent,
      dataContractVersion: OUTCOME_DATA_CONTRACT_VERSION,
      limitations: safeLimitations([...OUTCOME_POLICY_LIMITATIONS, ...OUTCOME_POLICY_LIMITATIONS_FOR_CANDIDATE]),
    }
    return { ...candidateBase, candidateFingerprint: outcomeSha256(candidateBase) }
  } catch {
    return blockedCandidate(['INVALID_INPUT'])
  }
}

function blockedManifest(reasons: readonly string[]): OutcomeDatasetManifest {
  const result = { status: 'gate_blocked' as const, eligibleCandidateCount: 0, trainCandidateFingerprints: [] as string[], validationCandidateFingerprints: [] as string[], testCandidateFingerprints: [] as string[], candidateFingerprints: [] as string[], sourceCombinationCount: 0, contentTypeCounts: {}, languageCounts: {}, policyVersion: OUTCOME_LEARNING_POLICY_VERSION, engineVersion: OUTCOME_LEARNING_ENGINE_VERSION, reasonCodes: safeReasonCodes(reasons), limitations: safeLimitations([...OUTCOME_POLICY_LIMITATIONS, ...OUTCOME_POLICY_LIMITATIONS_FOR_DATASET]) }
  return { ...result, manifestFingerprint: outcomeSha256(result) }
}

function candidateLineage(candidate: OutcomeLearningCandidate): string {
  return candidate.publicationIdentityHashes.slice().sort((left, right) => left < right ? -1 : left > right ? 1 : 0).join('|')
}

function candidateValidationReasons(raw: Record<string, unknown>): string[] {
  const reasons: string[] = []
  if (raw.candidateStatus !== 'eligible') reasons.push('CANDIDATE_NOT_ELIGIBLE')
  const consentLineage = raw.consentLineage
  if (isRecord(consentLineage) && consentLineage.consentRevokedAt !== null) reasons.push('CONSENT_REVOKED')
  for (const field of ['sourceHashes', 'publicationIdentityHashes', 'appliedRuleHashes'] as const) {
    const values = raw[field]
    if (!Array.isArray(values)) continue
    for (const hash of values) {
      const reason = outcomeHashValidationReason(hash)
      if (reason) reasons.push(reason)
    }
  }
  for (const field of ['deidentifiedSubjectKey', 'topicClusterHash', 'candidateFingerprint'] as const) {
    const reason = outcomeHashValidationReason(raw[field])
    if (reason) reasons.push(reason)
  }
  const declaredSources = Array.isArray(raw.measurementSources) && raw.measurementSources.every((source) => outcomeMeasurementSources.includes(source as never)) ? [...new Set(raw.measurementSources as OutcomeLearningCandidate['measurementSources'])].sort() : []
  const featureRecord = normalizeOutcomeFeatureRecord(raw.aggregateNumericFeatures, declaredSources)
  let featureSchemaValid = false
  try {
    if (isRecord(raw.aggregateNumericFeatures)) {
      const schemaProbe = Object.fromEntries(Object.keys(raw.aggregateNumericFeatures).map((key) => [key, 0]))
      featureSchemaValid = normalizeOutcomeFeatureRecord(schemaProbe, declaredSources) !== null
    }
  } catch {
    featureSchemaValid = false
  }
  const featureSources = featureRecord ? [...new Set(Object.keys(featureRecord).map((key) => key.split('.')[0]))].sort() : []
  if (!featureSchemaValid || (featureRecord && featureSources.join('|') !== declaredSources.join('|'))) reasons.push('CANDIDATE_FEATURE_LINEAGE_INVALID')
  if (Array.isArray(raw.sourceHashes) && raw.sourceHashes.length !== declaredSources.length * OUTCOME_SOURCE_HASHES_PER_SOURCE) reasons.push('CANDIDATE_FEATURE_LINEAGE_INVALID')
  if (typeof raw.candidateFingerprint === 'string' && isOutcomeSha256(raw.candidateFingerprint) && reasons.length === 0) reasons.push('CANDIDATE_FINGERPRINT_MISMATCH')
  return safeReasonCodes(reasons.length > 0 ? reasons : ['INVALID_CANDIDATE_SHAPE'])
}

function splitRatiosValid(): boolean {
  return Math.abs(OUTCOME_SPLIT_TRAIN_RATIO + OUTCOME_SPLIT_VALIDATION_RATIO + OUTCOME_SPLIT_TEST_RATIO - 1) < Number.EPSILON
}

function deterministicSplit(candidates: readonly OutcomeLearningCandidate[]): { train: string[]; validation: string[]; test: string[] } {
  const ordered = candidates.slice().sort((left, right) => {
    const leftScore = outcomeSha256({ kind: 'outcome_split_score', lineage: candidateLineage(left), candidateFingerprint: left.candidateFingerprint })
    const rightScore = outcomeSha256({ kind: 'outcome_split_score', lineage: candidateLineage(right), candidateFingerprint: right.candidateFingerprint })
    if (leftScore !== rightScore) return leftScore < rightScore ? -1 : 1
    return left.candidateFingerprint < right.candidateFingerprint ? -1 : left.candidateFingerprint > right.candidateFingerprint ? 1 : 0
  })
  const trainCount = Math.floor(ordered.length * OUTCOME_SPLIT_TRAIN_RATIO)
  const validationCount = Math.floor(ordered.length * OUTCOME_SPLIT_VALIDATION_RATIO)
  return {
    train: ordered.slice(0, trainCount).map((candidate) => candidate.candidateFingerprint),
    validation: ordered.slice(trainCount, trainCount + validationCount).map((candidate) => candidate.candidateFingerprint),
    test: ordered.slice(trainCount + validationCount).map((candidate) => candidate.candidateFingerprint),
  }
}

export function buildOutcomeDatasetManifest(input: unknown): OutcomeDatasetManifest {
  try {
    if (!isRecord(input)) return blockedManifest(['INVALID_MANIFEST_SHAPE'])
    let topLevelKeys: string[]
    try {
      topLevelKeys = Object.keys(input)
      if (Object.getOwnPropertySymbols(input).length > 0) return blockedManifest(['INVALID_MANIFEST_SHAPE'])
    } catch {
      return blockedManifest(['INVALID_MANIFEST_SHAPE'])
    }
    if (topLevelKeys.length !== 1 || topLevelKeys[0] !== 'candidates') return blockedManifest(['INVALID_MANIFEST_SHAPE'])
    let rawCandidates: unknown
    try {
      rawCandidates = input.candidates
    } catch {
      return blockedManifest(['INVALID_MANIFEST_SHAPE'])
    }
    if (!Array.isArray(rawCandidates)) return blockedManifest(['INVALID_MANIFEST_SHAPE'])
    let candidateCount: number
    try {
      candidateCount = rawCandidates.length
    } catch {
      return blockedManifest(['INVALID_MANIFEST_SHAPE'])
    }
    if (candidateCount > OUTCOME_MAX_DATASET_CANDIDATES) return blockedManifest(['TOO_MANY_DATASET_CANDIDATES'])
    const candidates: OutcomeLearningCandidate[] = []
    const seenFingerprints = new Set<string>()
    const seenLineages = new Set<string>()
    const reasons: string[] = []
    for (const raw of rawCandidates) {
      const candidate = normalizeOutcomeLearningCandidate(raw)
      if (!candidate) {
        if (isRecord(raw)) {
          reasons.push(...candidateValidationReasons(raw))
          const rawPublicationHashes = Array.isArray(raw.publicationIdentityHashes) && raw.publicationIdentityHashes.every((hash) => isOutcomeSha256(hash)) ? raw.publicationIdentityHashes.map((hash) => String(hash)).sort().join('|') : null
          if (rawPublicationHashes && seenLineages.has(rawPublicationHashes)) reasons.push('DUPLICATE_PUBLICATION_LINEAGE')
        } else reasons.push('INVALID_CANDIDATE_SHAPE')
        continue
      }
      if (seenFingerprints.has(candidate.candidateFingerprint)) reasons.push('DUPLICATE_CANDIDATE')
      const lineage = candidateLineage(candidate)
      if (seenLineages.has(lineage)) reasons.push('DUPLICATE_PUBLICATION_LINEAGE')
      seenFingerprints.add(candidate.candidateFingerprint)
      seenLineages.add(lineage)
      candidates.push(candidate)
    }
    if (reasons.length > 0) return blockedManifest(reasons)
    const sorted = candidates.slice().sort((left, right) => left.candidateFingerprint < right.candidateFingerprint ? -1 : left.candidateFingerprint > right.candidateFingerprint ? 1 : 0)
    const contentTypeCounts: Record<string, number> = {}
    const languageCounts: Record<string, number> = {}
    const combinations = new Set<string>()
    for (const candidate of sorted) {
      contentTypeCounts[candidate.contentType] = (contentTypeCounts[candidate.contentType] ?? 0) + 1
      languageCounts[candidate.language] = (languageCounts[candidate.language] ?? 0) + 1
      combinations.add([...candidate.measurementSources].sort().join('+'))
    }
    const missingGate: string[] = []
    if (sorted.length < OUTCOME_MIN_DATASET_CANDIDATES) missingGate.push('DATASET_ADMISSION_GATE_BLOCKED')
    for (const contentType of ['article', 'faq', 'service_page']) if ((contentTypeCounts[contentType] ?? 0) < OUTCOME_MIN_CONTENT_TYPE_COUNT) missingGate.push('DATASET_ADMISSION_GATE_BLOCKED')
    for (const language of ['zh-hant', 'en']) if ((languageCounts[language] ?? 0) < OUTCOME_MIN_LANGUAGE_COUNT) missingGate.push('DATASET_ADMISSION_GATE_BLOCKED')
    if (combinations.size < 2) missingGate.push('DATASET_ADMISSION_GATE_BLOCKED')
    if (!splitRatiosValid()) missingGate.push('INVALID_INPUT')
    if (missingGate.length > 0) return blockedManifest(missingGate)
    const split = deterministicSplit(sorted)
    const result = { status: 'ready_for_dataset_review' as const, eligibleCandidateCount: sorted.length, trainCandidateFingerprints: split.train, validationCandidateFingerprints: split.validation, testCandidateFingerprints: split.test, candidateFingerprints: sorted.map((candidate) => candidate.candidateFingerprint), sourceCombinationCount: combinations.size, contentTypeCounts: Object.fromEntries(Object.entries(contentTypeCounts).sort()), languageCounts: Object.fromEntries(Object.entries(languageCounts).sort()), policyVersion: OUTCOME_LEARNING_POLICY_VERSION, engineVersion: OUTCOME_LEARNING_ENGINE_VERSION, reasonCodes: [], limitations: safeLimitations([...OUTCOME_POLICY_LIMITATIONS, ...OUTCOME_POLICY_LIMITATIONS_FOR_DATASET]) }
    return { ...result, manifestFingerprint: outcomeSha256(result) }
  } catch {
    return blockedManifest(['INVALID_INPUT'])
  }
}

function validEvaluationMetrics(value: unknown): value is ModelEvaluationMetrics {
  if (!isRecord(value)) return false
  const keys = ['factualErrorRate', 'blockedContentEscapeRate', 'citationReadiness', 'taskQuality']
  const actual = Object.keys(value).sort()
  if (actual.length !== keys.length || actual.some((key, index) => key !== [...keys].sort()[index])) return false
  return keys.every((key) => typeof value[key] === 'number' && Number.isFinite(value[key]) && value[key] >= 0 && value[key] <= 1)
}

function releaseResult(decision: ModelReleaseGateResult['decision'], reasons: readonly string[], canonicalRequest: ModelReleaseGateRequest | null = null): ModelReleaseGateResult {
  const result = { decision, reasonCodes: safeReasonCodes(reasons), limitations: safeLimitations([...OUTCOME_POLICY_LIMITATIONS, ...OUTCOME_POLICY_LIMITATIONS_FOR_RELEASE]), policyVersion: OUTCOME_LEARNING_POLICY_VERSION, engineVersion: OUTCOME_LEARNING_ENGINE_VERSION }
  return { ...result, releaseFingerprint: outcomeSha256({ result, canonicalRequest }) }
}

const RELEASE_REQUEST_KEYS = ['baselineModelArtifactHash', 'candidateModelArtifactHash', 'datasetManifestHash', 'evaluationContractVersion', 'evaluationCaseCount', 'baselineMetrics', 'candidateMetrics', 'shadowRunStatus', 'canaryRunStatus', 'rollbackArtifactAvailable', 'safetyIncidents', 'evaluatedAt'] as const

function releaseShapeReasons(input: Record<string, unknown>): string[] {
  const reasons: string[] = []
  const actualKeys = Object.keys(input).sort((left, right) => left < right ? -1 : left > right ? 1 : 0)
  const expectedKeys = [...RELEASE_REQUEST_KEYS].sort((left, right) => left < right ? -1 : left > right ? 1 : 0)
  if (actualKeys.length !== expectedKeys.length || actualKeys.some((key, index) => key !== expectedKeys[index])) reasons.push('INVALID_RELEASE_SHAPE')
  if (input.evaluationContractVersion !== OUTCOME_EVALUATION_CONTRACT_VERSION) reasons.push('EVALUATION_CONTRACT_MISMATCH')
  const baselineHashReason = outcomeHashValidationReason(input.baselineModelArtifactHash)
  const candidateHashReason = outcomeHashValidationReason(input.candidateModelArtifactHash)
  const datasetHashReason = outcomeHashValidationReason(input.datasetManifestHash)
  if (baselineHashReason) reasons.push(baselineHashReason)
  if (candidateHashReason) reasons.push(candidateHashReason)
  if (datasetHashReason) reasons.push(datasetHashReason)
  if (!baselineHashReason && !candidateHashReason && isOutcomeSha256(input.baselineModelArtifactHash) && isOutcomeSha256(input.candidateModelArtifactHash) && input.baselineModelArtifactHash === input.candidateModelArtifactHash) reasons.push('MODEL_ARTIFACTS_NOT_DISTINCT')
  if (typeof input.evaluationCaseCount !== 'number' || !Number.isSafeInteger(input.evaluationCaseCount) || input.evaluationCaseCount > OUTCOME_MAX_EVALUATION_CASES || input.evaluationCaseCount < 0) reasons.push('EVALUATION_CASES_INVALID')
  else if (input.evaluationCaseCount < OUTCOME_MIN_EVALUATION_CASES) reasons.push('EVALUATION_CASES_INSUFFICIENT')
  if (!validEvaluationMetrics(input.baselineMetrics) || !validEvaluationMetrics(input.candidateMetrics)) reasons.push('INVALID_MODEL_EVIDENCE')
  if (input.shadowRunStatus === 'pending' && input.canaryRunStatus === 'passed') reasons.push('SHADOW_CANARY_ORDER_INVALID')
  if (input.shadowRunStatus === 'failed' || input.canaryRunStatus === 'failed') reasons.push('SAFETY_REGRESSION')
  if (!isRecord(input.baselineMetrics) || !isRecord(input.candidateMetrics) || baselineHashReason || candidateHashReason || datasetHashReason || !normalizeOutcomeTimestamp(input.evaluatedAt) || !['pending', 'passed', 'failed'].includes(input.shadowRunStatus as string) || !['pending', 'passed', 'failed'].includes(input.canaryRunStatus as string) || typeof input.rollbackArtifactAvailable !== 'boolean' || typeof input.safetyIncidents !== 'number' || !Number.isSafeInteger(input.safetyIncidents) || input.safetyIncidents < 0) reasons.push('INVALID_MODEL_EVIDENCE')
  return safeReasonCodes(reasons)
}

export function evaluateModelReleaseGate(input: unknown): ModelReleaseGateResult {
  try {
    if (!isRecord(input) || containsForbiddenOutcomeKey(input)) return releaseResult('gate_blocked', ['INVALID_MODEL_EVIDENCE'])
    const request = normalizeModelReleaseGateRequest(input)
    if (!request) return releaseResult('gate_blocked', releaseShapeReasons(input))
    const reasons: string[] = []
    if (request.candidateMetrics.factualErrorRate > request.baselineMetrics.factualErrorRate) reasons.push('FACTUAL_ERROR_REGRESSION')
    if (request.candidateMetrics.blockedContentEscapeRate > request.baselineMetrics.blockedContentEscapeRate) reasons.push('BLOCKED_CONTENT_ESCAPE_REGRESSION')
    if (request.candidateMetrics.citationReadiness < request.baselineMetrics.citationReadiness) reasons.push('CITATION_READINESS_REGRESSION')
    if (request.candidateMetrics.taskQuality < request.baselineMetrics.taskQuality + OUTCOME_MIN_TASK_QUALITY_IMPROVEMENT) reasons.push('TASK_QUALITY_NOT_IMPROVED')
    if (request.safetyIncidents !== 0) reasons.push('SAFETY_REGRESSION')
    if (!request.rollbackArtifactAvailable) reasons.push('ROLLBACK_ARTIFACT_REQUIRED')
    if (request.shadowRunStatus === 'pending' && request.canaryRunStatus === 'passed') reasons.push('SHADOW_CANARY_ORDER_INVALID')
    if (request.shadowRunStatus === 'failed' || request.canaryRunStatus === 'failed') reasons.push('SAFETY_REGRESSION')
    if (reasons.length > 0) return releaseResult('gate_blocked', reasons, request)
    if (request.shadowRunStatus !== 'passed') return releaseResult('shadow_ready', ['SHADOW_RUN_REQUIRED'], request)
    if (request.canaryRunStatus !== 'passed') return releaseResult('canary_ready', ['CANARY_RUN_REQUIRED'], request)
    return releaseResult('promotion_ready', [], request)
  } catch {
    return releaseResult('gate_blocked', ['INVALID_MODEL_EVIDENCE'])
  }
}

export function isOutcomeLearningEnginePure(): boolean {
  return outcomeMeasurementSources.length === 4 && outcomeContentTypes.length === 5 && outcomeLanguages.length === 2 && OUTCOME_FORBIDDEN_REASON_CODES.length > 0 && OUTCOME_MAX_CANDIDATE_LIMITATIONS > 0
}

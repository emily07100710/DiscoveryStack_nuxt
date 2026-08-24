import {
  OUTCOME_FORBIDDEN_REASON_CODES,
  OUTCOME_LEARNING_POLICY_VERSION,
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
  OUTCOME_POLICY_LIMITATIONS_FOR_DATASET,
  OUTCOME_POLICY_LIMITATIONS_FOR_RELEASE,
  OUTCOME_SOURCE_ORDER,
  OUTCOME_SPLIT_TEST_RATIO,
  OUTCOME_SPLIT_TRAIN_RATIO,
} from './policy-catalog'
import {
  containsForbiddenOutcomeKey,
  isOutcomeSha256,
  normalizeOutcomeComparable,
  normalizeOutcomeMeasurement,
  normalizeOutcomeText,
  normalizeOutcomeTimestamp,
  normalizePublicationIdentity,
  outcomeSha256,
  outcomeSourceCombinationKey,
  stableOutcomeStringify,
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
  type OutcomeLearningInput,
  type OutcomeMeasurementSource,
  type OutcomeMetricComparison,
  type OutcomeSignal,
  type OutcomeStatus,
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
    comparisons: [] as OutcomeMetricComparison[],
    validPairCount: 0,
    validSourceCount: 0,
    reasonCodes: safeReasonCodes(reasons),
    limitations: [...OUTCOME_POLICY_LIMITATIONS],
    policyVersion: OUTCOME_LEARNING_POLICY_VERSION,
    engineVersion: OUTCOME_LEARNING_ENGINE_VERSION,
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

function comparableMeasurementPair(baselines: readonly NormalizedOutcomeMeasurement[], followUps: readonly NormalizedOutcomeMeasurement[], publication: PublicationIdentity): { comparisons: OutcomeMetricComparison[]; reasons: string[] } {
  const reasons: string[] = []
  const comparisons: OutcomeMetricComparison[] = []
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

function normalizeAssessmentRequest(input: unknown): { publication: PublicationIdentity | null; baselineInputs: unknown[]; followUpInputs: unknown[]; dataContractVersion: string; reasons: string[] } {
  if (!isRecord(input) || containsForbiddenOutcomeKey(input)) return { publication: null, baselineInputs: [], followUpInputs: [], dataContractVersion: '', reasons: ['INVALID_INPUT', 'FORBIDDEN_PAYLOAD_KEY'] }
  try {
    const publication = normalizePublicationIdentity(input.publication)
    const baselineInputs = asMeasurementArray(input.baselineMeasurements)
    const followUpInputs = asMeasurementArray(input.followUpMeasurements)
    const dataContractVersion = normalizeOutcomeText(input.dataContractVersion) ?? ''
    const reasons: string[] = []
    if (!publication) reasons.push('INVALID_PUBLICATION_IDENTITY')
    if (!baselineInputs || !followUpInputs) reasons.push('INVALID_INPUT')
    const publicationCount = shallowPublicationCount(input)
    if (publicationCount === null) reasons.push('INVALID_INPUT')
    else if (publicationCount > OUTCOME_MAX_PUBLICATIONS) reasons.push('TOO_MANY_PUBLICATIONS')
    if (!dataContractVersion) reasons.push('DATA_CONTRACT_MISSING')
    const all = [...(baselineInputs ?? []), ...(followUpInputs ?? [])]
    if (all.length > OUTCOME_MAX_MEASUREMENTS) reasons.push('TOO_MANY_MEASUREMENTS')
    const rawSourceHashes = all.filter(isRecord).map((measurement) => measurement.sourceHash).filter((hash): hash is string => typeof hash === 'string')
    if (new Set(rawSourceHashes).size !== rawSourceHashes.length) reasons.push('DUPLICATE_SOURCE_HASH')
    const fieldCount = metricFieldCount(all)
    if (fieldCount === null) reasons.push('INVALID_METRIC')
    else if (fieldCount > OUTCOME_MAX_METRIC_FIELDS) reasons.push('TOO_MANY_METRIC_FIELDS')
    reasons.push(...pairMismatchReasons(baselineInputs ?? [], followUpInputs ?? []))
    return { publication, baselineInputs: baselineInputs ?? [], followUpInputs: followUpInputs ?? [], dataContractVersion, reasons: safeReasonCodes(reasons) }
  } catch {
    return { publication: null, baselineInputs: [], followUpInputs: [], dataContractVersion: '', reasons: ['INVALID_INPUT'] }
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
      return { ...blocked, comparisons: pairing.comparisons, validPairCount: pairing.comparisons.length, validSourceCount: new Set(pairing.comparisons.map((comparison) => comparison.source)).size, assessmentFingerprint: outcomeSha256({ ...blocked, comparisons: pairing.comparisons }) }
    }
    if (pairing.comparisons.length === 0) {
      const insufficient = baseAssessment(normalized.publication, ['NO_VALID_PAIR'], 'insufficient_data')
      return insufficient
    }
    const signals = pairing.comparisons.map((comparison) => comparison.signal)
    const signal = combineSignals(signals)
    const validSourceCount = new Set(pairing.comparisons.map((comparison) => comparison.source)).size
    const status: OutcomeStatus = validSourceCount >= OUTCOME_MIN_READY_SOURCES ? 'ready' : 'partial'
    const result = { status, signal, publication: normalized.publication, comparisons: pairing.comparisons, validPairCount: pairing.comparisons.length, validSourceCount, reasonCodes: [], limitations: [...OUTCOME_POLICY_LIMITATIONS], policyVersion: OUTCOME_LEARNING_POLICY_VERSION, engineVersion: OUTCOME_LEARNING_ENGINE_VERSION }
    return { ...result, assessmentFingerprint: outcomeSha256(result) }
  } catch {
    return baseAssessment(null, ['INVALID_INPUT'])
  }
}

function blockedCandidate(reasonCodes: readonly string[], fingerprintSeed: unknown = null): OutcomeLearningCandidateResult {
  const normalizedReasons = safeReasonCodes(reasonCodes)
  return { candidateStatus: 'blocked', reasonCodes: normalizedReasons, limitations: safeLimitations([...OUTCOME_POLICY_LIMITATIONS, 'Learning candidate was not admitted.']), policyVersion: OUTCOME_LEARNING_POLICY_VERSION, engineVersion: OUTCOME_LEARNING_ENGINE_VERSION, candidateFingerprint: outcomeSha256({ status: 'blocked', reasonCodes: normalizedReasons, seed: fingerprintSeed }) }
}

function normalizeConsent(value: unknown): ConsentLineage | null {
  if (!isRecord(value) || containsForbiddenOutcomeKey(value)) return null
  const consentStatus = value.consentStatus
  const consentVersion = normalizeOutcomeText(value.consentVersion) ?? ''
  const consentedAt = value.consentedAt === null ? null : normalizeOutcomeTimestamp(value.consentedAt)
  const consentAllowedUses = Array.isArray(value.consentAllowedUses) ? uniqueSorted(value.consentAllowedUses.filter((item): item is string => typeof item === 'string').map((item) => item.normalize('NFKC').trim().toLocaleLowerCase('en-US')).filter(Boolean)) : []
  const consentRevokedAt = value.consentRevokedAt === null ? null : normalizeOutcomeTimestamp(value.consentRevokedAt)
  const rightsConfirmed = value.rightsConfirmed === true
  if ((consentStatus !== 'granted' && consentStatus !== 'not_granted' && consentStatus !== 'unknown') || !consentVersion || !consentedAt || !consentAllowedUses.length || value.consentRevokedAt !== null && !consentRevokedAt) return null
  return { consentStatus, consentVersion, consentedAt, consentAllowedUses, consentRevokedAt, rightsConfirmed }
}

function aggregateFeatures(comparisons: readonly OutcomeMetricComparison[]): Record<string, number> {
  const features: Record<string, number> = {}
  for (const comparison of comparisons) {
    for (const [key, value] of Object.entries(comparison.baselineDailyMetrics)) {
      features[`${comparison.source}.${key}.baseline`] = value
      const followUpValue = comparison.followUpDailyMetrics[key]
      if (typeof followUpValue === 'number') features[`${comparison.source}.${key}.delta`] = followUpValue - value
    }
    for (const [key, value] of Object.entries(comparison.followUpDailyMetrics)) features[`${comparison.source}.${key}.follow_up`] = value
  }
  return Object.fromEntries(Object.entries(features).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0))
}

export function buildOutcomeLearningCandidate(input: unknown): OutcomeLearningCandidateResult {
  try {
    if (!isRecord(input) || containsForbiddenOutcomeKey(input)) return blockedCandidate(['INVALID_INPUT', 'FORBIDDEN_PAYLOAD_KEY'])
    const outcomeRequest = input.outcomeRequest
    const assessment = assessPublishedContentOutcome(outcomeRequest)
    const consent = normalizeConsent(input.consent)
    const reasons: string[] = []
    if (!consent || consent.consentStatus !== 'granted') reasons.push('CONSENT_REQUIRED')
    if (consent?.consentRevokedAt) reasons.push('CONSENT_REVOKED')
    if (!consent?.consentAllowedUses.includes('model_improvement')) reasons.push('CONSENT_USE_NOT_ALLOWED')
    if (!consent?.rightsConfirmed) reasons.push('RIGHTS_NOT_CONFIRMED')
    if (input.piiScanStatus !== 'none_detected') reasons.push('PII_DETECTED')
    const dataContractVersion = normalizeOutcomeText(input.dataContractVersion) ?? ''
    if (!dataContractVersion) reasons.push('DATA_CONTRACT_MISSING')
    if (assessment.status !== 'ready' && assessment.status !== 'partial') reasons.push('CANDIDATE_NOT_ELIGIBLE')
    if (assessment.validPairCount < 1) reasons.push('NO_VALID_PAIR')
    const suppliedAssessment = input.assessment
    if (isRecord(suppliedAssessment) && suppliedAssessment.assessmentFingerprint !== assessment.assessmentFingerprint) reasons.push('CANDIDATE_NOT_ELIGIBLE')
    if (reasons.length > 0 || !consent) return blockedCandidate(reasons.length > 0 ? reasons : ['INVALID_INPUT'], assessment.assessmentFingerprint)
    const publication = assessment.publication
    const candidate: Omit<OutcomeLearningCandidate, 'candidateFingerprint'> = {
      candidateStatus: 'eligible',
      deidentifiedSubjectKey: publication.deidentifiedSubjectKey,
      publicationIdentityHashes: [publicationIdentityHash(publication)],
      contentType: publication.contentType,
      language: publication.language,
      appliedRuleIds: [...publication.appliedRuleIds].sort((left, right) => left < right ? -1 : left > right ? 1 : 0),
      topicClusterCode: publication.topicClusterCode,
      aggregateNumericFeatures: aggregateFeatures(assessment.comparisons),
      directionalLabels: assessment.comparisons.map((comparison) => ({ source: comparison.source, signal: comparison.signal })).sort((left, right) => left.source < right.source ? -1 : left.source > right.source ? 1 : 0),
      sourceHashes: uniqueSorted(assessment.comparisons.flatMap((comparison) => comparison.sourceHashes)),
      measurementSources: [...new Set(assessment.comparisons.map((comparison) => comparison.source))].sort((left, right) => left < right ? -1 : left > right ? 1 : 0),
      policyVersion: OUTCOME_LEARNING_POLICY_VERSION,
      engineVersion: OUTCOME_LEARNING_ENGINE_VERSION,
      consentLineage: consent,
      dataContractVersion,
      limitations: safeLimitations([...OUTCOME_POLICY_LIMITATIONS, 'Learning candidate stores aggregate numeric features and deidentified references only.']),
    }
    return { ...candidate, candidateFingerprint: outcomeSha256(candidate) }
  } catch {
    return blockedCandidate(['INVALID_INPUT'])
  }
}

function blockedManifest(reasons: readonly string[]): OutcomeDatasetManifest {
  const result = { status: 'gate_blocked' as const, eligibleCandidateCount: 0, trainCandidateFingerprints: [] as string[], validationCandidateFingerprints: [] as string[], testCandidateFingerprints: [] as string[], candidateFingerprints: [] as string[], sourceCombinationCount: 0, contentTypeCounts: {}, languageCounts: {}, policyVersion: OUTCOME_LEARNING_POLICY_VERSION, engineVersion: OUTCOME_LEARNING_ENGINE_VERSION, reasonCodes: safeReasonCodes(reasons), limitations: safeLimitations([...OUTCOME_POLICY_LIMITATIONS, ...OUTCOME_POLICY_LIMITATIONS_FOR_DATASET]), }
  return { ...result, manifestFingerprint: outcomeSha256(result) }
}

function candidateLineage(candidate: OutcomeLearningCandidate): string {
  return candidate.publicationIdentityHashes.slice().sort((left, right) => left < right ? -1 : left > right ? 1 : 0).join('|')
}

function deterministicSplit(candidates: readonly OutcomeLearningCandidate[]): { train: string[]; validation: string[]; test: string[] } {
  const groups = new Map<string, OutcomeLearningCandidate[]>()
  for (const candidate of candidates) {
    const lineage = candidateLineage(candidate)
    const group = groups.get(lineage) ?? []
    group.push(candidate)
    groups.set(lineage, group)
  }
  const train: string[] = []
  const validation: string[] = []
  const test: string[] = []
  for (const [lineage, group] of [...groups.entries()].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)) {
    const bucketHash = outcomeSha256({ lineage, candidateFingerprints: group.map((candidate) => candidate.candidateFingerprint).sort() })
    const bucket = Number.parseInt(bucketHash.slice(0, 8), 16) / 0xffffffff
    const target = bucket < OUTCOME_SPLIT_TRAIN_RATIO ? train : bucket < OUTCOME_SPLIT_TRAIN_RATIO + 0.1 ? validation : test
    target.push(...group.map((candidate) => candidate.candidateFingerprint).sort((left, right) => left < right ? -1 : left > right ? 1 : 0))
  }
  return { train: train.sort(), validation: validation.sort(), test: test.sort() }
}

export function buildOutcomeDatasetManifest(input: unknown): OutcomeDatasetManifest {
  try {
    if (!isRecord(input) || containsForbiddenOutcomeKey(input) || !Array.isArray(input.candidates)) return blockedManifest(['INVALID_INPUT'])
    const rawCandidates = input.candidates
    const candidates: OutcomeLearningCandidate[] = []
    const seenFingerprints = new Set<string>()
    const seenLineages = new Set<string>()
    const reasons: string[] = []
    for (const raw of rawCandidates) {
      if (!isRecord(raw) || raw.candidateStatus !== 'eligible' || containsForbiddenOutcomeKey(raw) || typeof raw.candidateFingerprint !== 'string' || !isOutcomeSha256(raw.candidateFingerprint)) {
        reasons.push('CANDIDATE_NOT_ELIGIBLE')
        continue
      }
      const candidate = raw as unknown as OutcomeLearningCandidate
      if (candidate.consentLineage.consentRevokedAt !== null) reasons.push('CONSENT_REVOKED')
      if (!candidate.sourceHashes.length || candidate.sourceHashes.some((hash) => !isOutcomeSha256(hash))) reasons.push('INVALID_HASH')
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
      combinations.add(outcomeSourceCombinationKey(candidate.measurementSources))
    }
    const missingGate: string[] = []
    if (sorted.length < OUTCOME_MIN_DATASET_CANDIDATES) missingGate.push('DATASET_ADMISSION_GATE_BLOCKED')
    for (const contentType of ['article', 'faq', 'service_page']) if ((contentTypeCounts[contentType] ?? 0) < OUTCOME_MIN_CONTENT_TYPE_COUNT) missingGate.push('DATASET_ADMISSION_GATE_BLOCKED')
    for (const language of ['zh-hant', 'en']) if ((languageCounts[language] ?? 0) < OUTCOME_MIN_LANGUAGE_COUNT) missingGate.push('DATASET_ADMISSION_GATE_BLOCKED')
    if (combinations.size < 2) missingGate.push('DATASET_ADMISSION_GATE_BLOCKED')
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
  return ['factualErrorRate', 'blockedContentEscapeRate', 'citationReadiness', 'taskQuality'].every((key) => typeof value[key] === 'number' && Number.isFinite(value[key]) && value[key] >= 0 && value[key] <= 1)
}

function releaseResult(decision: ModelReleaseGateResult['decision'], reasons: readonly string[], evidence: unknown = null): ModelReleaseGateResult {
  const result = { decision, reasonCodes: safeReasonCodes(reasons), limitations: safeLimitations([...OUTCOME_POLICY_LIMITATIONS, ...OUTCOME_POLICY_LIMITATIONS_FOR_RELEASE]), policyVersion: OUTCOME_LEARNING_POLICY_VERSION, engineVersion: OUTCOME_LEARNING_ENGINE_VERSION }
  return { ...result, releaseFingerprint: outcomeSha256({ ...result, evidence }) }
}

export function evaluateModelReleaseGate(input: unknown): ModelReleaseGateResult {
  try {
    if (!isRecord(input) || containsForbiddenOutcomeKey(input)) return releaseResult('gate_blocked', ['INVALID_MODEL_EVIDENCE'], input)
    const request = input as unknown as ModelReleaseGateRequest
    const hashes = [request.baselineModelArtifactHash, request.candidateModelArtifactHash, request.datasetManifestHash]
    const reasons: string[] = []
    if (hashes.some((hash) => !isOutcomeSha256(hash))) reasons.push('INVALID_MODEL_EVIDENCE')
    if (!normalizeOutcomeText(request.evaluationContractVersion) || !normalizeOutcomeTimestamp(request.evaluatedAt)) reasons.push('INVALID_MODEL_EVIDENCE')
    if (!Number.isInteger(request.evaluationCaseCount) || request.evaluationCaseCount < OUTCOME_MIN_EVALUATION_CASES) reasons.push('EVALUATION_CASES_INSUFFICIENT')
    if (!validEvaluationMetrics(request.baselineMetrics) || !validEvaluationMetrics(request.candidateMetrics)) reasons.push('INVALID_MODEL_EVIDENCE')
    if (!['pending', 'passed', 'failed'].includes(request.shadowRunStatus) || !['pending', 'passed', 'failed'].includes(request.canaryRunStatus) || typeof request.rollbackArtifactAvailable !== 'boolean' || !Number.isInteger(request.safetyIncidents) || request.safetyIncidents < 0) reasons.push('INVALID_MODEL_EVIDENCE')
    if (reasons.length > 0) return releaseResult('gate_blocked', reasons, request)
    const baseline = request.baselineMetrics
    const candidate = request.candidateMetrics
    if (candidate.factualErrorRate > baseline.factualErrorRate) reasons.push('FACTUAL_ERROR_REGRESSION')
    if (candidate.blockedContentEscapeRate > baseline.blockedContentEscapeRate) reasons.push('BLOCKED_CONTENT_ESCAPE_REGRESSION')
    if (candidate.citationReadiness < baseline.citationReadiness) reasons.push('CITATION_READINESS_REGRESSION')
    if (candidate.taskQuality < baseline.taskQuality + OUTCOME_MIN_TASK_QUALITY_IMPROVEMENT) reasons.push('TASK_QUALITY_NOT_IMPROVED')
    if (request.safetyIncidents !== 0) reasons.push('SAFETY_REGRESSION')
    if (!request.rollbackArtifactAvailable) reasons.push('ROLLBACK_ARTIFACT_REQUIRED')
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
  return outcomeMeasurementSources.length === 4 && outcomeContentTypes.length === 5 && outcomeLanguages.length === 2 && OUTCOME_FORBIDDEN_REASON_CODES.length > 0
}

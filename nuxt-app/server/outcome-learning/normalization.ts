import { createHash } from 'node:crypto'
import {
  OUTCOME_ALLOWED_CONSENT_USES,
  OUTCOME_DATA_CONTRACT_VERSION,
  OUTCOME_EVALUATION_CONTRACT_VERSION,
  OUTCOME_FEATURE_FIELDS,
  OUTCOME_MAX_CANDIDATE_APPLIED_RULE_HASHES,
  OUTCOME_MAX_CANDIDATE_DIRECTIONAL_LABELS,
  OUTCOME_MAX_CANDIDATE_FEATURES,
  OUTCOME_MAX_CANDIDATE_LIMITATIONS,
  OUTCOME_MAX_CANDIDATE_MEASUREMENT_SOURCES,
  OUTCOME_MAX_CANDIDATE_PUBLICATION_HASHES,
  OUTCOME_MAX_CANDIDATE_SOURCE_HASHES,
  OUTCOME_MAX_REFERENCE_TEXT_LENGTH,
  OUTCOME_MAX_EVALUATION_CASES,
  OUTCOME_POLICY_LIMITATIONS,
  OUTCOME_POLICY_LIMITATIONS_FOR_CANDIDATE,
  OUTCOME_POLICY_LIMITATIONS_FOR_RELEASE,
  OUTCOME_LEARNING_POLICY_VERSION,
} from './policy-catalog'
import {
  outcomeContentTypes,
  outcomeLanguages,
  outcomeMeasurementSources,
  outcomeSignals,
  OUTCOME_LEARNING_ENGINE_VERSION,
  type BlockedOutcomeLearningCandidate,
  type ConsentLineage,
  type ModelEvaluationMetrics,
  type ModelReleaseGateRequest,
  type NormalizedOutcomeMeasurement,
  type OutcomeContentType,
  type OutcomeLanguage,
  type OutcomeLearningCandidate,
  type OutcomeMeasurementSource,
  type OutcomeSignal,
  type PublishedContentOutcomeAssessment,
  type PublicationIdentity,
} from './types'

const FORBIDDEN_KEYS = new Set([
  'email', 'phone', 'name', 'companyname', 'url', 'rawurl', 'rawcontent', 'rawsearchquery', 'rawcrmrecord', 'rawpagecontent', 'articlebody', 'prompt', 'response', 'ip', 'visitorid', 'contact',
  ['cre', 'dential'].join(''), 'token', ['sec', 'ret'].join(''), 'password',
])

const SOURCE_METRICS: Record<OutcomeMeasurementSource, readonly string[]> = {
  google_search_console: ['impressions', 'clicks', 'averagePosition'],
  llm_visibility: ['queryCount', 'mentionCount', 'citationCount'],
  first_party_analytics: ['sessions', 'engagedSessions'],
  crm_aggregate: ['qualifiedLeads', 'conversions'],
}

const CANONICAL_OUTCOME_LIMITATIONS = [...OUTCOME_POLICY_LIMITATIONS]
const CANONICAL_CANDIDATE_LIMITATIONS = [...OUTCOME_POLICY_LIMITATIONS, ...OUTCOME_POLICY_LIMITATIONS_FOR_CANDIDATE]
const CANONICAL_RELEASE_LIMITATIONS = [...OUTCOME_POLICY_LIMITATIONS, ...OUTCOME_POLICY_LIMITATIONS_FOR_RELEASE]

function hasMalformedUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1)
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true
      index += 1
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true
    }
  }
  return false
}

export function normalizeOutcomeText(value: unknown): string | null {
  if (typeof value !== 'string' || hasMalformedUnicode(value)) return null
  try {
    const normalized = value.normalize('NFKC').trim().replace(/\s+/gu, ' ')
    return normalized || null
  } catch {
    return null
  }
}

export function normalizeOutcomeComparable(value: unknown): string | null {
  const normalized = normalizeOutcomeText(value)
  return normalized ? normalized.toLocaleLowerCase('en-US') : null
}

export function normalizeOutcomeReferenceText(value: unknown): string | null {
  if (typeof value !== 'string' || hasMalformedUnicode(value)) return null
  if (value.length === 0 || value.length > OUTCOME_MAX_REFERENCE_TEXT_LENGTH) return null
  if (/[\r\n\u0000-\u001f\u007f]/u.test(value)) return null
  let normalized: string
  try {
    normalized = value.normalize('NFKC').trim()
  } catch {
    return null
  }
  if (!normalized || normalized.length > OUTCOME_MAX_REFERENCE_TEXT_LENGTH || /[\r\n\u0000-\u001f\u007f]/u.test(normalized)) return null
  if (/(?:https?:\/\/|www\.)/iu.test(normalized) || /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(normalized)) return null
  const digits = (normalized.match(/\d/gu) ?? []).length
  if (digits >= 7 && /^[+\d().\s-]+$/u.test(normalized)) return null
  return normalized.replace(/\s+/gu, ' ')
}

export function isOutcomeSha256(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value.trim())
}

export function normalizeOutcomeTimestamp(value: unknown): string | null {
  if (typeof value !== 'string' || hasMalformedUnicode(value)) return null
  const text = value.normalize('NFKC').trim()
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u.test(text)) return null
  const date = new Date(text)
  return Number.isFinite(date.getTime()) ? date.toISOString() : null
}

export function stableOutcomeStringify(value: unknown): string {
  if (value === undefined) throw new Error('UNDEFINED_NOT_ALLOWED')
  if (value === null) return 'null'
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('NONFINITE_NOT_ALLOWED')
    return JSON.stringify(value)
  }
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value)
  if (typeof value === 'bigint' || typeof value === 'function' || typeof value === 'symbol') throw new Error('UNSUPPORTED_VALUE')
  if (Array.isArray(value)) return `[${value.map((item) => stableOutcomeStringify(item)).join(',')}]`
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>
    return `{${Object.keys(record).sort((left, right) => left < right ? -1 : left > right ? 1 : 0).map((key) => `${JSON.stringify(key)}:${stableOutcomeStringify(record[key])}`).join(',')}}`
  }
  throw new Error('UNSUPPORTED_VALUE')
}

export function outcomeSha256(value: unknown): string {
  return createHash('sha256').update(stableOutcomeStringify(value), 'utf8').digest('hex')
}

export function domainSeparatedOutcomeSha256(kind: string, value: string): string {
  return outcomeSha256({ kind, value })
}

function normalizedKey(value: string): string {
  return value.normalize('NFKC').replace(/[_-]/gu, '').toLocaleLowerCase('en-US')
}

export function containsForbiddenOutcomeKey(value: unknown, seen = new WeakSet<object>()): boolean {
  if (value === null || typeof value !== 'object') return false
  if (seen.has(value)) return true
  seen.add(value)
  try {
    if (Array.isArray(value)) return value.some((item) => containsForbiddenOutcomeKey(item, seen))
    const record = value as Record<string, unknown>
    return Object.keys(record).some((key) => FORBIDDEN_KEYS.has(normalizedKey(key)) || containsForbiddenOutcomeKey(record[key], seen))
  } catch {
    return true
  } finally {
    seen.delete(value)
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function normalizeStringList(value: unknown, allowEmpty: boolean): string[] | null {
  if (!Array.isArray(value)) return null
  const normalized: string[] = []
  for (const item of value) {
    const text = normalizeOutcomeText(item)
    if (!text) return null
    normalized.push(text)
  }
  if (!allowEmpty && normalized.length === 0) return null
  return [...new Set(normalized)].sort((left, right) => left < right ? -1 : left > right ? 1 : 0)
}

function normalizeComparableList(value: unknown, allowEmpty: boolean): string[] | null {
  const texts = normalizeStringList(value, allowEmpty)
  return texts ? texts.map((item) => item.toLocaleLowerCase('en-US')) : null
}

function normalizeMetricNumber(value: unknown, integer: boolean, positive = false): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  if (integer && (!Number.isInteger(value) || value < 0)) return null
  if (positive && value <= 0) return null
  return value
}

function durationDays(start: string, end: string): number | null {
  const value = (Date.parse(end) - Date.parse(start)) / 86_400_000
  return Number.isFinite(value) && value > 0 ? value : null
}

function normalizeMetrics(source: OutcomeMeasurementSource, value: unknown): { metrics: Record<string, number>; derivedMetrics: Record<string, number> } | null {
  if (!isRecord(value)) return null
  const allowed = SOURCE_METRICS[source]
  const keys = Object.keys(value)
  if (keys.length !== allowed.length || keys.some((key) => !allowed.includes(key))) return null
  const metrics: Record<string, number> = {}
  for (const key of allowed) {
    const numeric = normalizeMetricNumber(value[key], source === 'google_search_console' ? key !== 'averagePosition' : true, source === 'google_search_console' && key === 'averagePosition')
    if (numeric === null) return null
    metrics[key] = numeric
  }
  const derivedMetrics: Record<string, number> = {}
  const metric = (key: string): number => {
    const numeric = metrics[key]
    if (typeof numeric !== 'number') throw new Error('MISSING_NORMALIZED_METRIC')
    return numeric
  }
  if (source === 'google_search_console') {
    const clicks = metric('clicks')
    const impressions = metric('impressions')
    if (clicks > impressions) return null
    derivedMetrics.ctr = impressions === 0 ? 0 : clicks / impressions
  } else if (source === 'llm_visibility') {
    const queryCount = metric('queryCount')
    const mentionCount = metric('mentionCount')
    const citationCount = metric('citationCount')
    if (mentionCount > queryCount || citationCount > queryCount) return null
    derivedMetrics.mentionRate = queryCount === 0 ? 0 : mentionCount / queryCount
    derivedMetrics.citationRate = queryCount === 0 ? 0 : citationCount / queryCount
  } else if (source === 'first_party_analytics') {
    const sessions = metric('sessions')
    const engagedSessions = metric('engagedSessions')
    if (engagedSessions > sessions) return null
    derivedMetrics.engagementRate = sessions === 0 ? 0 : engagedSessions / sessions
  } else {
    const qualifiedLeads = metric('qualifiedLeads')
    const conversions = metric('conversions')
    if (conversions > qualifiedLeads) return null
    derivedMetrics.conversionRate = qualifiedLeads === 0 ? 0 : conversions / qualifiedLeads
  }
  return { metrics, derivedMetrics }
}

export function normalizePublicationIdentity(value: unknown): PublicationIdentity | null {
  if (!isRecord(value) || containsForbiddenOutcomeKey(value)) return null
  try {
    const sourceKey = normalizeOutcomeText(value.deidentifiedSubjectKey)
    const scheduleEntryId = normalizeOutcomeText(value.scheduleEntryId)
    const scheduleKey = normalizeOutcomeText(value.scheduleKey)
    const productionPlanId = normalizeOutcomeText(value.productionPlanId)
    const jobId = normalizeOutcomeText(value.jobId)
    const draftId = normalizeOutcomeText(value.draftId)
    const draftVersion = normalizeOutcomeText(value.draftVersion)
    const contentHash = typeof value.contentHash === 'string' && isOutcomeSha256(value.contentHash) ? value.contentHash.trim().toLocaleLowerCase('en-US') : null
    const evidenceSnapshotHash = typeof value.evidenceSnapshotHash === 'string' && isOutcomeSha256(value.evidenceSnapshotHash) ? value.evidenceSnapshotHash.trim().toLocaleLowerCase('en-US') : null
    const publishedAt = normalizeOutcomeTimestamp(value.publishedAt)
    const contentType = value.contentType
    const language = value.language
    const appliedRuleIds = normalizeStringList(value.appliedRuleIds, true)
    const topicClusterCode = normalizeOutcomeText(value.topicClusterCode)
    if (!sourceKey || !isOutcomeSha256(sourceKey) || !scheduleEntryId || !scheduleKey || !productionPlanId || !jobId || !draftId || !draftVersion || !contentHash || !evidenceSnapshotHash || !publishedAt || !outcomeContentTypes.includes(contentType as never) || !outcomeLanguages.includes(language as never) || !appliedRuleIds || !topicClusterCode) return null
    return { deidentifiedSubjectKey: sourceKey.toLocaleLowerCase('en-US'), scheduleEntryId, scheduleKey, productionPlanId, jobId, draftId, draftVersion, contentHash, evidenceSnapshotHash, publishedAt, contentType: contentType as PublicationIdentity['contentType'], language: language as PublicationIdentity['language'], appliedRuleIds, topicClusterCode }
  } catch {
    return null
  }
}

export function normalizeOutcomeMeasurement(value: unknown): NormalizedOutcomeMeasurement | null {
  if (!isRecord(value) || containsForbiddenOutcomeKey(value)) return null
  try {
    const source = value.source
    const deidentifiedSubjectKey = typeof value.deidentifiedSubjectKey === 'string' && isOutcomeSha256(value.deidentifiedSubjectKey) ? value.deidentifiedSubjectKey.trim().toLocaleLowerCase('en-US') : null
    const scopeFingerprint = typeof value.scopeFingerprint === 'string' && isOutcomeSha256(value.scopeFingerprint) ? value.scopeFingerprint.trim().toLocaleLowerCase('en-US') : null
    const phase = value.phase
    const windowStart = normalizeOutcomeTimestamp(value.windowStart)
    const windowEnd = normalizeOutcomeTimestamp(value.windowEnd)
    const capturedAt = normalizeOutcomeTimestamp(value.capturedAt)
    const sourceHash = typeof value.sourceHash === 'string' && isOutcomeSha256(value.sourceHash) ? value.sourceHash.trim().toLocaleLowerCase('en-US') : null
    if (!outcomeMeasurementSources.includes(source as never) || !deidentifiedSubjectKey || !scopeFingerprint || !sourceHash || (phase !== 'baseline' && phase !== 'follow_up') || !windowStart || !windowEnd || !capturedAt) return null
    const days = durationDays(windowStart, windowEnd)
    if (!days || Date.parse(capturedAt) < Date.parse(windowEnd)) return null
    const normalizedMetrics = normalizeMetrics(source as OutcomeMeasurementSource, value.metrics)
    if (!normalizedMetrics) return null
    const canonicalPayload = { source, deidentifiedSubjectKey, scopeFingerprint, phase, windowStart, windowEnd, capturedAt, metrics: normalizedMetrics.metrics }
    if (outcomeSha256(canonicalPayload) !== sourceHash) return null
    return { source: source as OutcomeMeasurementSource, deidentifiedSubjectKey, scopeFingerprint, phase, windowStart, windowEnd, capturedAt, sourceHash, metrics: normalizedMetrics.metrics, derivedMetrics: normalizedMetrics.derivedMetrics, durationDays: days }
  } catch {
    return null
  }
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort((left, right) => left < right ? -1 : left > right ? 1 : 0)
  const required = [...expected].sort((left, right) => left < right ? -1 : left > right ? 1 : 0)
  return actual.length === required.length && actual.every((key, index) => key === required[index])
}

function boundedHashList(value: unknown, max: number, nonEmpty: boolean): string[] | null {
  if (!Array.isArray(value) || value.length > max || (nonEmpty && value.length === 0)) return null
  if (value.some((item) => !isOutcomeSha256(item))) return null
  const hashes = value.map((item) => (item as string).toLowerCase())
  if (new Set(hashes).size !== hashes.length) return null
  return [...hashes].sort((left, right) => left < right ? -1 : left > right ? 1 : 0)
}

function boundedStringList(value: unknown, max: number): string[] | null {
  if (!Array.isArray(value) || value.length > max) return null
  const normalized: string[] = []
  for (const item of value) {
    const text = normalizeOutcomeReferenceText(item)
    if (!text) return null
    normalized.push(text)
  }
  const result = [...new Set(normalized)].sort((left, right) => left < right ? -1 : left > right ? 1 : 0)
  return result.length === normalized.length ? result : null
}

function boundedCanonicalLimitations(value: unknown): string[] | null {
  const normalized = boundedStringList(value, OUTCOME_MAX_CANDIDATE_LIMITATIONS)
  if (!normalized) return null
  const expected = [...CANONICAL_CANDIDATE_LIMITATIONS].sort((left, right) => left < right ? -1 : left > right ? 1 : 0)
  return normalized.length === expected.length && normalized.every((item, index) => item === expected[index]) ? normalized : null
}

function isFixedEnum(value: unknown, values: readonly string[]): boolean {
  return typeof value === 'string' && values.includes(value)
}

function normalizeConsentLineage(value: unknown): ConsentLineage | null {
  if (!isRecord(value) || containsForbiddenOutcomeKey(value) || !exactKeys(value, ['consentStatus', 'consentVersion', 'consentedAt', 'consentAllowedUses', 'consentRevokedAt', 'rightsConfirmed'])) return null
  const consentStatus = value.consentStatus
  const consentVersion = normalizeOutcomeReferenceText(value.consentVersion)
  const consentedAt = value.consentedAt === null ? null : normalizeOutcomeTimestamp(value.consentedAt)
  const consentAllowedUses = normalizeComparableList(value.consentAllowedUses, false)
  const consentRevokedAt = value.consentRevokedAt === null ? null : normalizeOutcomeTimestamp(value.consentRevokedAt)
  if (consentStatus !== 'granted' && consentStatus !== 'not_granted' && consentStatus !== 'unknown') return null
  if (!consentVersion || !consentedAt || !consentAllowedUses || value.consentRevokedAt !== null && !consentRevokedAt || typeof value.rightsConfirmed !== 'boolean') return null
  if (consentAllowedUses.some((item) => !OUTCOME_ALLOWED_CONSENT_USES.includes(item as never))) return null
  return { consentStatus, consentVersion, consentedAt, consentAllowedUses, consentRevokedAt, rightsConfirmed: value.rightsConfirmed }
}

function normalizeFeatureRecord(value: unknown): Record<string, number> | null {
  if (!isRecord(value)) return null
  const keys = Object.keys(value)
  if (keys.length === 0 || keys.length > OUTCOME_MAX_CANDIDATE_FEATURES) return null
  const allowed = new Set(Object.values(OUTCOME_FEATURE_FIELDS).flat().map((field) => `${field}`))
  const features: Record<string, number> = {}
  for (const key of keys) {
    if (!/^(?:google_search_console|llm_visibility|first_party_analytics|crm_aggregate)\.[A-Za-z]+\.(?:baseline|follow_up|delta)$/u.test(key)) return null
    const featureName = key.split('.')[1]
    if (!featureName || !allowed.has(featureName)) return null
    const numeric = value[key]
    if (typeof numeric !== 'number' || !Number.isFinite(numeric)) return null
    features[key] = numeric
  }
  return Object.fromEntries(Object.entries(features).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0))
}

function normalizeDirectionalLabels(value: unknown): Array<{ source: OutcomeMeasurementSource; signal: OutcomeSignal }> | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > OUTCOME_MAX_CANDIDATE_DIRECTIONAL_LABELS) return null
  const labels: Array<{ source: OutcomeMeasurementSource; signal: OutcomeSignal }> = []
  for (const item of value) {
    if (!isRecord(item) || !exactKeys(item, ['source', 'signal']) || !isFixedEnum(item.source, outcomeMeasurementSources) || !isFixedEnum(item.signal, outcomeSignals)) return null
    labels.push({ source: item.source as OutcomeMeasurementSource, signal: item.signal as OutcomeSignal })
  }
  if (new Set(labels.map((item) => item.source)).size !== labels.length) return null
  return labels.sort((left, right) => left.source < right.source ? -1 : left.source > right.source ? 1 : 0)
}

function candidateBody(value: Omit<OutcomeLearningCandidate, 'candidateFingerprint'>): Omit<OutcomeLearningCandidate, 'candidateFingerprint'> {
  return {
    candidateStatus: 'eligible',
    deidentifiedSubjectKey: value.deidentifiedSubjectKey,
    publicationIdentityHashes: [...value.publicationIdentityHashes],
    contentType: value.contentType,
    language: value.language,
    appliedRuleHashes: [...value.appliedRuleHashes],
    topicClusterHash: value.topicClusterHash,
    aggregateNumericFeatures: { ...value.aggregateNumericFeatures },
    directionalLabels: value.directionalLabels.map((item) => ({ ...item })),
    sourceHashes: [...value.sourceHashes],
    measurementSources: [...value.measurementSources],
    policyVersion: value.policyVersion,
    engineVersion: value.engineVersion,
    consentLineage: { ...value.consentLineage, consentAllowedUses: [...value.consentLineage.consentAllowedUses] },
    dataContractVersion: value.dataContractVersion,
    limitations: [...value.limitations],
  }
}

export function normalizeOutcomeLearningCandidate(value: unknown): OutcomeLearningCandidate | null {
  if (!isRecord(value) || containsForbiddenOutcomeKey(value)) return null
  const required = ['candidateStatus', 'deidentifiedSubjectKey', 'publicationIdentityHashes', 'contentType', 'language', 'appliedRuleHashes', 'topicClusterHash', 'aggregateNumericFeatures', 'directionalLabels', 'sourceHashes', 'measurementSources', 'policyVersion', 'engineVersion', 'consentLineage', 'dataContractVersion', 'limitations', 'candidateFingerprint']
  if (!exactKeys(value, required) || value.candidateStatus !== 'eligible') return null
  const deidentifiedSubjectKey = isOutcomeSha256(value.deidentifiedSubjectKey) ? value.deidentifiedSubjectKey.toLowerCase() : null
  const publicationIdentityHashes = boundedHashList(value.publicationIdentityHashes, OUTCOME_MAX_CANDIDATE_PUBLICATION_HASHES, true)
  const appliedRuleHashes = boundedHashList(value.appliedRuleHashes, OUTCOME_MAX_CANDIDATE_APPLIED_RULE_HASHES, false)
  const topicClusterHash = isOutcomeSha256(value.topicClusterHash) ? value.topicClusterHash.toLowerCase() : null
  const aggregateNumericFeatures = normalizeFeatureRecord(value.aggregateNumericFeatures)
  const directionalLabels = normalizeDirectionalLabels(value.directionalLabels)
  const sourceHashes = boundedHashList(value.sourceHashes, OUTCOME_MAX_CANDIDATE_SOURCE_HASHES, true)
  const measurementSourceValues = Array.isArray(value.measurementSources) ? value.measurementSources : []
  const measurementSources = measurementSourceValues.length > 0 && measurementSourceValues.length <= OUTCOME_MAX_CANDIDATE_MEASUREMENT_SOURCES && measurementSourceValues.every((source) => isFixedEnum(source, outcomeMeasurementSources)) && new Set(measurementSourceValues).size === measurementSourceValues.length ? [...new Set(measurementSourceValues as OutcomeMeasurementSource[])].sort((left, right) => left < right ? -1 : left > right ? 1 : 0) : null
  const consentLineage = normalizeConsentLineage(value.consentLineage)
  const limitations = boundedCanonicalLimitations(value.limitations)
  if (!deidentifiedSubjectKey || !publicationIdentityHashes || !appliedRuleHashes || !topicClusterHash || !aggregateNumericFeatures || !directionalLabels || !sourceHashes || !measurementSources || !consentLineage || !limitations) return null
  if (!isFixedEnum(value.contentType, outcomeContentTypes) || !isFixedEnum(value.language, outcomeLanguages)) return null
  if (value.policyVersion !== OUTCOME_LEARNING_POLICY_VERSION || value.engineVersion !== OUTCOME_LEARNING_ENGINE_VERSION || value.dataContractVersion !== OUTCOME_DATA_CONTRACT_VERSION) return null
  if (consentLineage.consentStatus !== 'granted' || !consentLineage.consentAllowedUses.includes('model_improvement') || consentLineage.consentRevokedAt !== null || consentLineage.rightsConfirmed !== true) return null
  const labelSources = directionalLabels.map((item) => item.source).sort()
  const sourceList = [...measurementSources].sort()
  if (labelSources.length !== sourceList.length || labelSources.some((source, index) => source !== sourceList[index])) return null
  const canonical = candidateBody({ candidateStatus: 'eligible', deidentifiedSubjectKey, publicationIdentityHashes, contentType: value.contentType as OutcomeContentType, language: value.language as OutcomeLanguage,
 appliedRuleHashes, topicClusterHash, aggregateNumericFeatures, directionalLabels, sourceHashes, measurementSources, policyVersion: OUTCOME_LEARNING_POLICY_VERSION, engineVersion: OUTCOME_LEARNING_ENGINE_VERSION, consentLineage, dataContractVersion: OUTCOME_DATA_CONTRACT_VERSION, limitations }) as Omit<OutcomeLearningCandidate, 'candidateFingerprint'>
  if (typeof value.candidateFingerprint !== 'string' || !isOutcomeSha256(value.candidateFingerprint) || outcomeSha256(canonical) !== value.candidateFingerprint.toLowerCase()) return null
  return { ...canonical, candidateFingerprint: value.candidateFingerprint.toLowerCase() }
}

export function normalizeModelReleaseGateRequest(value: unknown): ModelReleaseGateRequest | null {
  const required = ['baselineModelArtifactHash', 'candidateModelArtifactHash', 'datasetManifestHash', 'evaluationContractVersion', 'evaluationCaseCount', 'baselineMetrics', 'candidateMetrics', 'shadowRunStatus', 'canaryRunStatus', 'rollbackArtifactAvailable', 'safetyIncidents', 'evaluatedAt']
  if (!isRecord(value) || containsForbiddenOutcomeKey(value) || !exactKeys(value, required)) return null
  if (!isOutcomeSha256(value.baselineModelArtifactHash) || !isOutcomeSha256(value.candidateModelArtifactHash) || !isOutcomeSha256(value.datasetManifestHash)) return null
  const baselineModelArtifactHash = (value.baselineModelArtifactHash as string).toLowerCase()
  const candidateModelArtifactHash = (value.candidateModelArtifactHash as string).toLowerCase()
  const datasetManifestHash = (value.datasetManifestHash as string).toLowerCase()
  if (baselineModelArtifactHash === candidateModelArtifactHash) return null
  if (value.evaluationContractVersion !== OUTCOME_EVALUATION_CONTRACT_VERSION) return null
  if (typeof value.evaluationCaseCount !== 'number' || !Number.isSafeInteger(value.evaluationCaseCount) || value.evaluationCaseCount < 0 || value.evaluationCaseCount < 100 || value.evaluationCaseCount > OUTCOME_MAX_EVALUATION_CASES) return null
  const metricKeys = ['factualErrorRate', 'blockedContentEscapeRate', 'citationReadiness', 'taskQuality'] as const
  const normalizeMetricsValue = (metrics: unknown): ModelEvaluationMetrics | null => {
    if (!isRecord(metrics) || !exactKeys(metrics, metricKeys)) return null
    if (metricKeys.some((key) => typeof metrics[key] !== 'number' || !Number.isFinite(metrics[key]) || metrics[key] < 0 || metrics[key] > 1)) return null
    return { factualErrorRate: metrics.factualErrorRate as number, blockedContentEscapeRate: metrics.blockedContentEscapeRate as number, citationReadiness: metrics.citationReadiness as number, taskQuality: metrics.taskQuality as number }
  }
  const baselineMetrics = normalizeMetricsValue(value.baselineMetrics)
  const candidateMetrics = normalizeMetricsValue(value.candidateMetrics)
  const shadowRunStatus = value.shadowRunStatus
  const canaryRunStatus = value.canaryRunStatus
  const evaluatedAt = normalizeOutcomeTimestamp(value.evaluatedAt)
  if (!baselineMetrics || !candidateMetrics || !['pending', 'passed', 'failed'].includes(shadowRunStatus as string) || !['pending', 'passed', 'failed'].includes(canaryRunStatus as string) || typeof value.rollbackArtifactAvailable !== 'boolean' || typeof value.safetyIncidents !== 'number' || !Number.isSafeInteger(value.safetyIncidents) || value.safetyIncidents < 0 || !evaluatedAt) return null
  return { baselineModelArtifactHash, candidateModelArtifactHash, datasetManifestHash, evaluationContractVersion: OUTCOME_EVALUATION_CONTRACT_VERSION, evaluationCaseCount: value.evaluationCaseCount, baselineMetrics, candidateMetrics, shadowRunStatus: shadowRunStatus as ModelReleaseGateRequest['shadowRunStatus'], canaryRunStatus: canaryRunStatus as ModelReleaseGateRequest['canaryRunStatus'], rollbackArtifactAvailable: value.rollbackArtifactAvailable, safetyIncidents: value.safetyIncidents, evaluatedAt }
}

export function canonicalAssessmentForFingerprint(value: PublishedContentOutcomeAssessment): PublishedContentOutcomeAssessment {
  return { ...value, dataContractVersion: OUTCOME_DATA_CONTRACT_VERSION }
}

export function canonicalReleaseLimitations(): readonly string[] {
  return CANONICAL_RELEASE_LIMITATIONS
}

export function outcomeMetricKeys(source: OutcomeMeasurementSource): readonly string[] {
  return SOURCE_METRICS[source]
}

export function outcomeSourceCombinationKey(sources: readonly OutcomeMeasurementSource[]): string {
  return [...new Set(sources)].sort((left, right) => left < right ? -1 : left > right ? 1 : 0).join('+')
}

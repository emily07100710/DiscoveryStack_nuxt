import { performance } from 'node:perf_hooks'
import { buildOutcomeDatasetManifest } from '../outcome-learning/engine'
import { normalizeOutcomeLearningCandidate, outcomeSha256, isOutcomeSha256 } from '../outcome-learning/normalization'
import { OUTCOME_FEATURE_FIELDS, OUTCOME_MIN_DATASET_CANDIDATES } from '../outcome-learning/policy-catalog'
import type { OutcomeLearningCandidate, OutcomeMeasurementSource, OutcomeSignal } from '../outcome-learning/types'

export const CONTENT_EFFECT_ARTIFACT_SCHEMA = 'discoverystack.content-effect-logistic.v2' as const
export const CONTENT_EFFECT_TASK = 'observational_content_effect_direction_from_gsc_v1' as const
const MAX_ROWS = 500
const MAX_FEATURES = 80
const EPOCHS = 250
const MAX_DEADLINE_MS = 5_000
const DEFAULT_DEADLINE_MS = 2_000
const MIN_BINARY_ROWS = 100
const MIN_SUBJECTS = 10
const TRAIN_MIN_PER_CLASS = 20
const HOLDOUT_MIN_PER_CLASS = 5
const METRIC_SOURCES: readonly OutcomeMeasurementSource[] = ['google_search_console', 'first_party_analytics', 'crm_aggregate']

export type BinaryMetrics = {
  logLoss: number
  brierScore: number
  f1: number
  balancedAccuracy: number
  positiveCount: number
  negativeCount: number
  rowCount: number
}

export type ContentEffectArtifact = {
  schema: typeof CONTENT_EFFECT_ARTIFACT_SCHEMA
  task: typeof CONTENT_EFFECT_TASK
  features: string[]
  coefficients: number[]
  intercept: number
  normalization: Array<{ feature: string; mean: number; scale: number }>
  config: { seed: 0; epochs: number; learningRate: number; l2: number; maxRows: number; maxFeatures: number }
  datasetDigest: string
  lineageFingerprint: string
  publicationMetadataFingerprint: string
  splits: {
    strategy: 'subject_hash_70_15_15_plus_temporal_subject_holdout'
    uniquePublications: number
    train: { rows: number; subjects: number; positiveCount: number; negativeCount: number }
    validation: { rows: number; subjects: number; positiveCount: number; negativeCount: number }
    test: { rows: number; subjects: number; positiveCount: number; negativeCount: number }
    temporalHoldout: {
      status: 'AVAILABLE'
      rows: number
      subjects: number
      publications: number
      positiveCount: number
      negativeCount: number
      publishedAtCutoff: string
      latestTrainingWindowEnd: string
      trainingAsOf: string
      selectedFingerprint: string
      excludedFingerprint: string
      deduplicatedExcludedFingerprint: string
      historicalSubjectExcludedFingerprint: string
    }
  }
  metrics: {
    train: BinaryMetrics
    validation: BinaryMetrics
    test: BinaryMetrics
    temporalHoldout: BinaryMetrics
    validationMajorityBaseline: BinaryMetrics
    testMajorityBaseline: BinaryMetrics
    temporalMajorityBaseline: BinaryMetrics
  }
  limitations: string[]
  artifactHash: string
}

export type TrainContentEffectModelInput = {
  candidates: unknown[]
  datasetDigest: string
  lineageFingerprint: string
  publicationMetadata: EffectPublicationMetadataSidecar
  deadlineMs?: number
}

export type EffectPublicationMetadata = {
  candidateFingerprint: string
  publicationGroupFingerprint: string
  baselineMetadataFingerprint: string
  latestBaselineCapturedAt: string
  publishedAt: string
  gscFollowUpWindowStart: string
  gscFollowUpWindowEnd: string
  capturedAt: string
}

export type EffectPublicationMetadataSidecar = {
  schema: 'content-effect-publication-metadata.v1'
  trainingAsOf: string
  entries: EffectPublicationMetadata[]
  sidecarFingerprint: string
}

export type TrainContentEffectModelResult = {
  status: 'completed' | 'blocked'
  artifact: ContentEffectArtifact | null
  reasonCodes: string[]
  counts: {
    admittedCandidates: number
    binaryRows: number
    subjects: number
    excludedSignals: {
      mixed_signal: number
      no_material_change: number
      insufficient_data: number
      missing_gsc_label: number
      ambiguous_gsc_label: number
    }
  }
}

type Row = { candidate: OutcomeLearningCandidate; metadata: EffectPublicationMetadata; label: 0 | 1; raw: number[] }
type SplitName = 'train' | 'validation' | 'test'
type Split = { rows: Row[]; subjects: Set<string> }
type ArtifactBody = Omit<ContentEffectArtifact, 'artifactHash'>

const LIMITATIONS = [
  'observational_not_causal',
  'GSC is the only source used for binary direction labels; AI citation evidence is not a label in this task.',
  'Temporal holdout is publication-time ordered and subject-held-out; it is an observational check and does not establish causal effect.',
  'Multiple horizons for one canonical publication are reduced by a fixed earliest-window rule before admission and fitting.',
  'A directional GSC aggregate signal is not verified business impact, causal effectiveness, or proof of a specific content change.',
  'Majority baseline predicts the training majority class and uses the training positive prevalence as its probability prior.',
  'Experimental offline artifact only; productionActivation is false and no provider, deployment, or production model is changed.',
]

function blocked(reasonCodes: string[], counts: TrainContentEffectModelResult['counts']): TrainContentEffectModelResult {
  return { status: 'blocked', artifact: null, reasonCodes: [...new Set(reasonCodes)].sort(), counts }
}

function validInputHash(value: unknown): value is string {
  return isOutcomeSha256(value)
}

function sigmoid(value: number): number {
  if (value >= 0) {
    const z = Math.exp(-value)
    return 1 / (1 + z)
  }
  const z = Math.exp(value)
  return z / (1 + z)
}

function isCountFeature(name: string): boolean {
  const field = name.split('.')[1]
  return ['impressions', 'clicks', 'sessions', 'engagedSessions', 'qualifiedLeads', 'conversions'].includes(field ?? '')
}

function featureNames(): string[] {
  const metrics = METRIC_SOURCES.flatMap((source) => OUTCOME_FEATURE_FIELDS[source].map((field) => `${source}.${field}.baseline`)).sort()
  return [
    ...['article', 'faq', 'service_page', 'landing_page', 'other'].map((item) => `contentType.${item}`),
    ...['en', 'zh-hant'].map((item) => `language.${item}`),
    ...metrics.flatMap((item) => [`${item}.${isCountFeature(item) ? 'log1p' : 'value'}`, `${item}.missing`]),
  ]
}

function vector(candidate: OutcomeLearningCandidate, names: readonly string[]): number[] {
  return names.map((name) => {
    if (name.startsWith('contentType.')) return candidate.contentType === name.slice('contentType.'.length) ? 1 : 0
    if (name.startsWith('language.')) return candidate.language === name.slice('language.'.length) ? 1 : 0
    if (name.endsWith('.missing')) {
      const key = name.slice(0, -'.missing'.length)
      return Object.hasOwn(candidate.aggregateNumericFeatures, key) ? 0 : 1
    }
    const transform = name.endsWith('.log1p') ? '.log1p' : '.value'
    const key = name.slice(0, -transform.length)
    const value = candidate.aggregateNumericFeatures[key]
    if (typeof value !== 'number' || !Number.isFinite(value)) return 0
    return transform === '.log1p' ? Math.log1p(Math.max(0, value)) : Math.max(0, value)
  })
}

function signalLabel(candidate: OutcomeLearningCandidate): { label: 0 | 1 | null; exclusion: keyof TrainContentEffectModelResult['counts']['excludedSignals'] | null } {
  const gsc = candidate.directionalLabels.filter((item) => item.source === 'google_search_console').map((item) => item.signal)
  if (gsc.length === 0) return { label: null, exclusion: 'missing_gsc_label' }
  if (gsc.length !== 1) return { label: null, exclusion: 'ambiguous_gsc_label' }
  const signal: OutcomeSignal = gsc[0]!
  if (signal === 'positive_signal') return { label: 1, exclusion: null }
  if (signal === 'negative_signal') return { label: 0, exclusion: null }
  if (signal === 'mixed_signal') return { label: null, exclusion: 'mixed_signal' }
  if (signal === 'no_material_change') return { label: null, exclusion: 'no_material_change' }
  return { label: null, exclusion: 'insufficient_data' }
}

function splitRows(rows: readonly Row[]): Record<SplitName, Split> {
  const bySubject = new Map<string, Row[]>()
  for (const row of rows) {
    const group = bySubject.get(row.candidate.deidentifiedSubjectKey) ?? []
    group.push(row)
    bySubject.set(row.candidate.deidentifiedSubjectKey, group)
  }
  const groups = [...bySubject.entries()].map(([subject, subjectRows]) => ({
    subject,
    rows: subjectRows.sort((a, b) => rowSortKey(a) < rowSortKey(b) ? -1 : rowSortKey(a) > rowSortKey(b) ? 1 : 0),
    score: outcomeSha256({ seed: 0, subject }),
  })).sort((a, b) => a.score < b.score ? -1 : a.score > b.score ? 1 : a.subject < b.subject ? -1 : 1)
  const trainEnd = Math.max(1, Math.floor(groups.length * 0.70))
  const validationEnd = Math.max(trainEnd + 1, Math.floor(groups.length * 0.85))
  const out: Record<SplitName, Split> = {
    train: { rows: [], subjects: new Set() },
    validation: { rows: [], subjects: new Set() },
    test: { rows: [], subjects: new Set() },
  }
  groups.forEach((group, index) => {
    const split: SplitName = index < trainEnd ? 'train' : index < validationEnd ? 'validation' : 'test'
    out[split].rows.push(...group.rows)
    out[split].subjects.add(group.subject)
  })
  for (const split of Object.values(out)) split.rows.sort((a, b) => rowSortKey(a) < rowSortKey(b) ? -1 : rowSortKey(a) > rowSortKey(b) ? 1 : 0)
  return out
}

function rowSortKey(row: Row): string {
  return outcomeSha256({ raw: row.raw, publicationGroupFingerprint: row.metadata.publicationGroupFingerprint, publishedAt: row.metadata.publishedAt })
}

const UTC_ISO_MILLIS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
const METADATA_SCHEMA = 'content-effect-publication-metadata.v1' as const

function canonicalUtcIso(value: unknown): value is string {
  if (typeof value !== 'string' || !UTC_ISO_MILLIS.test(value)) return false
  const time = Date.parse(value)
  return Number.isFinite(time) && new Date(time).toISOString() === value
}

function metadataSidecar(value: unknown, candidates: readonly OutcomeLearningCandidate[]): EffectPublicationMetadataSidecar | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const raw = value as Record<string, unknown>
  if (!exactKeys(raw, ['schema', 'trainingAsOf', 'entries', 'sidecarFingerprint']) || raw.schema !== METADATA_SCHEMA || !canonicalUtcIso(raw.trainingAsOf) || !isOutcomeSha256(raw.sidecarFingerprint) || !Array.isArray(raw.entries) || raw.entries.length !== candidates.length) return null
  const fingerprints = new Set(candidates.map((candidate) => candidate.candidateFingerprint))
  const entries: EffectPublicationMetadata[] = []
  const seen = new Set<string>()
  for (const item of raw.entries) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return null
    const entry = item as Record<string, unknown>
    if (!exactKeys(entry, ['candidateFingerprint', 'publicationGroupFingerprint', 'baselineMetadataFingerprint', 'latestBaselineCapturedAt', 'publishedAt', 'gscFollowUpWindowStart', 'gscFollowUpWindowEnd', 'capturedAt']) || !isOutcomeSha256(entry.candidateFingerprint) || !isOutcomeSha256(entry.publicationGroupFingerprint) || !isOutcomeSha256(entry.baselineMetadataFingerprint) || !canonicalUtcIso(entry.latestBaselineCapturedAt) || !canonicalUtcIso(entry.publishedAt) || !canonicalUtcIso(entry.gscFollowUpWindowStart) || !canonicalUtcIso(entry.gscFollowUpWindowEnd) || !canonicalUtcIso(entry.capturedAt)) return null
    if (!fingerprints.has(entry.candidateFingerprint) || seen.has(entry.candidateFingerprint) || entry.latestBaselineCapturedAt > entry.publishedAt || entry.gscFollowUpWindowStart >= entry.gscFollowUpWindowEnd || entry.gscFollowUpWindowStart < entry.publishedAt || entry.capturedAt < entry.gscFollowUpWindowEnd) return null
    seen.add(entry.candidateFingerprint)
    entries.push(entry as unknown as EffectPublicationMetadata)
  }
  if (seen.size !== candidates.length) return null
  entries.sort((a, b) => a.candidateFingerprint < b.candidateFingerprint ? -1 : a.candidateFingerprint > b.candidateFingerprint ? 1 : 0)
  const maxCapturedAt = entries.map((entry) => entry.capturedAt).sort().at(-1)
  if (raw.trainingAsOf !== maxCapturedAt) return null
  const expected = outcomeSha256({ schema: METADATA_SCHEMA, trainingAsOf: raw.trainingAsOf, entries })
  if (expected !== raw.sidecarFingerprint) return null
  return { schema: METADATA_SCHEMA, trainingAsOf: raw.trainingAsOf, entries, sidecarFingerprint: expected }
}

function deduplicatePublications(rows: readonly Row[]): { rows: Row[]; excludedRows: Row[]; conflict: boolean } {
  const groups = new Map<string, Row[]>()
  for (const row of rows) {
    const key = row.metadata.publicationGroupFingerprint
    const group = groups.get(key) ?? []
    group.push(row)
    groups.set(key, group)
  }
  const selected: Row[] = []
  for (const group of groups.values()) {
    const first = group[0]!
    const baselineSignature = (row: Row) => outcomeSha256({
      publicationIdentityHashes: row.candidate.publicationIdentityHashes,
      contentType: row.candidate.contentType,
      language: row.candidate.language,
      appliedRuleHashes: row.candidate.appliedRuleHashes,
      topicClusterHash: row.candidate.topicClusterHash,
      measurementSources: row.candidate.measurementSources,
      baselineFeatures: Object.fromEntries(Object.entries(row.candidate.aggregateNumericFeatures).filter(([key]) => key.endsWith('.baseline')).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)),
      baselineMetadataFingerprint: row.metadata.baselineMetadataFingerprint,
      latestBaselineCapturedAt: row.metadata.latestBaselineCapturedAt,
    })
    if (group.some((row) => row.candidate.deidentifiedSubjectKey !== first.candidate.deidentifiedSubjectKey || row.metadata.publishedAt !== first.metadata.publishedAt || baselineSignature(row) !== baselineSignature(first))) return { rows: [], excludedRows: [], conflict: true }
    group.sort((a, b) => {
      const left = [a.metadata.gscFollowUpWindowEnd, a.metadata.gscFollowUpWindowStart, a.metadata.capturedAt]
      const right = [b.metadata.gscFollowUpWindowEnd, b.metadata.gscFollowUpWindowStart, b.metadata.capturedAt]
      for (let index = 0; index < left.length; index += 1) if (left[index] !== right[index]) return left[index]! < right[index]! ? -1 : 1
      return 0
    })
    if (group.length > 1 && group[0]!.metadata.gscFollowUpWindowEnd === group[1]!.metadata.gscFollowUpWindowEnd && group[0]!.metadata.gscFollowUpWindowStart === group[1]!.metadata.gscFollowUpWindowStart && group[0]!.metadata.capturedAt === group[1]!.metadata.capturedAt) return { rows: [], excludedRows: [], conflict: true }
    selected.push(group[0]!)
  }
  selected.sort((a, b) => rowSortKey(a) < rowSortKey(b) ? -1 : rowSortKey(a) > rowSortKey(b) ? 1 : 0)
  const selectedFingerprints = new Set(selected.map((row) => row.candidate.candidateFingerprint))
  return { rows: selected, excludedRows: rows.filter((row) => !selectedFingerprints.has(row.candidate.candidateFingerprint)), conflict: false }
}

type TemporalPartition = { historicalRows: Row[]; temporalRows: Row[]; excludedRows: Row[]; cutoff: string | null }

function temporalPartition(rows: readonly Row[], trainingAsOf: string): TemporalPartition | null {
  const publications = [...rows].sort((a, b) => a.metadata.publishedAt < b.metadata.publishedAt ? -1 : a.metadata.publishedAt > b.metadata.publishedAt ? 1 : rowSortKey(a) < rowSortKey(b) ? -1 : rowSortKey(a) > rowSortKey(b) ? 1 : 0)
  if (publications.length < MIN_BINARY_ROWS) return null
  const holdoutStart = Math.floor(publications.length * 0.8)
  if (holdoutStart < 1 || publications.length - holdoutStart < 10) return null
  const cutoff = publications[holdoutStart]!.metadata.publishedAt
  const futureRows = publications.filter((row) => row.metadata.publishedAt >= cutoff)
  if (futureRows.length < 10) return null
  const temporalSubjects = new Set(futureRows.map((row) => row.candidate.deidentifiedSubjectKey))
  const historicalRows: Row[] = []
  const temporalRows: Row[] = []
  const excludedRows: Row[] = []
  for (const row of publications) {
    if (row.metadata.publishedAt >= cutoff) {
      if (!temporalSubjects.has(row.candidate.deidentifiedSubjectKey) || row.metadata.gscFollowUpWindowStart < cutoff || row.metadata.gscFollowUpWindowEnd > trainingAsOf || row.metadata.capturedAt > trainingAsOf) return null
      temporalRows.push(row)
    } else if (temporalSubjects.has(row.candidate.deidentifiedSubjectKey)) {
      excludedRows.push(row)
    } else {
      if (row.metadata.latestBaselineCapturedAt >= cutoff || row.metadata.gscFollowUpWindowEnd >= cutoff || row.metadata.capturedAt >= cutoff) return null
      historicalRows.push(row)
    }
  }
  if (new Set(temporalRows.map((row) => row.metadata.publicationGroupFingerprint)).size < 10) return null
  return { historicalRows, temporalRows, excludedRows, cutoff }
}

function classCounts(rows: readonly Row[]): { positiveCount: number; negativeCount: number } {
  const positiveCount = rows.reduce((total, row) => total + row.label, 0)
  return { positiveCount, negativeCount: rows.length - positiveCount }
}

function normalizationFor(rows: readonly Row[], featureList: readonly string[]): Array<{ feature: string; mean: number; scale: number }> {
  return featureList.map((feature, column) => {
    const values = rows.map((row) => row.raw[column]!)
    const mean = values.reduce((sum, value) => sum + value, 0) / values.length
    const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length
    return { feature, mean, scale: Math.sqrt(variance) > 1e-9 ? Math.sqrt(variance) : 1 }
  })
}

function standardized(rows: readonly Row[], normalization: readonly { mean: number; scale: number }[]): number[][] {
  return rows.map((row) => row.raw.map((value, index) => (value - normalization[index]!.mean) / normalization[index]!.scale))
}

function fit(rows: readonly Row[], inputs: readonly number[][], deadlineAt: number): { weights: number[]; intercept: number } | null {
  let weights = new Array(inputs[0]?.length ?? 0).fill(0) as number[]
  let intercept = 0
  const learningRate = 0.04
  const l2 = 0.01
  for (let epoch = 0; epoch < EPOCHS; epoch += 1) {
    if (performance.now() >= deadlineAt) return null
    const gradients = new Array(weights.length).fill(0) as number[]
    let biasGradient = 0
    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index]!
      const x = inputs[index]!
      const p = sigmoid(intercept + weights.reduce((sum, weight, column) => sum + weight * x[column]!, 0))
      const error = p - row.label
      biasGradient += error
      for (let column = 0; column < weights.length; column += 1) gradients[column]! += error * x[column]!
    }
    const inverseRows = 1 / rows.length
    intercept -= learningRate * biasGradient * inverseRows
    weights = weights.map((weight, column) => weight - learningRate * (gradients[column]! * inverseRows + l2 * weight))
  }
  return { weights, intercept }
}

function metrics(rows: readonly Row[], inputs: readonly number[][], weights: readonly number[], intercept: number, threshold = 0.5): BinaryMetrics {
  let logLoss = 0
  let brierScore = 0
  let tp = 0; let fp = 0; let tn = 0; let fn = 0
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index]!
    const x = inputs[index]!
    const probability = Math.min(1 - 1e-15, Math.max(1e-15, sigmoid(intercept + weights.reduce((sum, weight, column) => sum + weight * x[column]!, 0))))
    logLoss -= row.label * Math.log(probability) + (1 - row.label) * Math.log(1 - probability)
    brierScore += (probability - row.label) ** 2
    const prediction = probability >= threshold ? 1 : 0
    if (prediction && row.label) tp += 1
    else if (prediction) fp += 1
    else if (row.label) fn += 1
    else tn += 1
  }
  const positiveCount = tp + fn
  const negativeCount = tn + fp
  return {
    logLoss: logLoss / rows.length,
    brierScore: brierScore / rows.length,
    f1: 2 * tp + fp + fn > 0 ? (2 * tp) / (2 * tp + fp + fn) : 0,
    balancedAccuracy: ((positiveCount ? tp / positiveCount : 0) + (negativeCount ? tn / negativeCount : 0)) / 2,
    positiveCount,
    negativeCount,
    rowCount: rows.length,
  }
}

function majorityMetrics(rows: readonly Row[], majorityPositive: boolean, trainingPositivePrevalence: number): BinaryMetrics {
  const prediction = majorityPositive ? 1 : 0
  let tp = 0; let fp = 0; let tn = 0; let fn = 0
  for (const row of rows) {
    if (prediction === 1 && row.label === 1) tp += 1
    else if (prediction === 1) fp += 1
    else if (row.label === 0) tn += 1
    else fn += 1
  }
  const positiveCount = tp + fn
  const negativeCount = tn + fp
  const probability = Math.min(1 - 1e-15, Math.max(1e-15, trainingPositivePrevalence))
  const logLoss = rows.reduce((sum, row) => sum - (row.label * Math.log(probability) + (1 - row.label) * Math.log(1 - probability)), 0) / rows.length
  const brierScore = rows.reduce((sum, row) => sum + (probability - row.label) ** 2, 0) / rows.length
  return { logLoss, brierScore, f1: 2 * tp + fp + fn > 0 ? (2 * tp) / (2 * tp + fp + fn) : 0, balancedAccuracy: ((positiveCount ? tp / positiveCount : 0) + (negativeCount ? tn / negativeCount : 0)) / 2, positiveCount, negativeCount, rowCount: rows.length }
}

function bodyForHash(body: ArtifactBody): ArtifactBody {
  return body
}

export function trainContentEffectModel(input: TrainContentEffectModelInput): TrainContentEffectModelResult {
  const startedAt = performance.now()
  const duration = typeof input?.deadlineMs === 'number' && Number.isFinite(input.deadlineMs) ? Math.min(MAX_DEADLINE_MS, Math.max(1, input.deadlineMs)) : DEFAULT_DEADLINE_MS
  const deadlineAt = startedAt + duration
  const emptyCounts: TrainContentEffectModelResult['counts'] = { admittedCandidates: 0, binaryRows: 0, subjects: 0, excludedSignals: { mixed_signal: 0, no_material_change: 0, insufficient_data: 0, missing_gsc_label: 0, ambiguous_gsc_label: 0 } }
  try {
    if (!input || !Array.isArray(input.candidates) || !validInputHash(input.datasetDigest) || !validInputHash(input.lineageFingerprint)) return blocked(['INVALID_INPUT_OR_DATASET_FINGERPRINT'], emptyCounts)
    if (input.deadlineMs !== undefined && (typeof input.deadlineMs !== 'number' || !Number.isSafeInteger(input.deadlineMs) || input.deadlineMs < 1 || input.deadlineMs > MAX_DEADLINE_MS)) return blocked(['INVALID_CPU_DEADLINE'], emptyCounts)
    if (input.candidates.length > MAX_ROWS) return blocked(['CANDIDATE_CAP_EXCEEDED'], { ...emptyCounts, admittedCandidates: input.candidates.length })
    if (performance.now() >= deadlineAt) return blocked(['CPU_DEADLINE_REACHED'], emptyCounts)

    // The supplied digest and lineage fingerprint bind the persisted request but are not admission authority.
    const canonicalCandidates: OutcomeLearningCandidate[] = []
    for (const raw of input.candidates) {
      if (performance.now() >= deadlineAt) return blocked(['CPU_DEADLINE_REACHED'], { ...emptyCounts, admittedCandidates: canonicalCandidates.length })
      const canonical = normalizeOutcomeLearningCandidate(raw)
      if (!canonical) return blocked(['CANDIDATE_REVALIDATION_FAILED'], { ...emptyCounts, admittedCandidates: canonicalCandidates.length })
      canonicalCandidates.push(canonical)
    }
    if (performance.now() >= deadlineAt) return blocked(['CPU_DEADLINE_REACHED'], { ...emptyCounts, admittedCandidates: canonicalCandidates.length })
    const sidecar = metadataSidecar(input.publicationMetadata, canonicalCandidates)
    if (!sidecar) return blocked(['PUBLICATION_METADATA_INVALID'], { ...emptyCounts, admittedCandidates: canonicalCandidates.length })
    const metadataByFingerprint = new Map(sidecar.entries.map((entry) => [entry.candidateFingerprint, entry]))
    const allRows: Row[] = []
    for (const candidate of canonicalCandidates) {
      const metadata = metadataByFingerprint.get(candidate.candidateFingerprint)
      if (!metadata) return blocked(['PUBLICATION_METADATA_MISSING'], emptyCounts)
      const outcome = signalLabel(candidate)
      allRows.push({ candidate, metadata, label: outcome.label ?? 0, raw: vector(candidate, featureNames()) })
    }
    const deduped = deduplicatePublications(allRows)
    if (deduped.conflict) return blocked(['PUBLICATION_GROUP_METADATA_CONFLICT'], { ...emptyCounts, admittedCandidates: canonicalCandidates.length })
    const uniqueRows = deduped.rows
    const uniqueCandidates = uniqueRows.map((row) => row.candidate)
    const selectedManifest = buildOutcomeDatasetManifest({ candidates: canonicalCandidates })
    const expectedDatasetDigest = outcomeSha256({ manifestFingerprint: selectedManifest.manifestFingerprint, candidateFingerprints: canonicalCandidates.map((candidate) => candidate.candidateFingerprint).sort(), policy: 'secondary_hash_only_dataset_review_v1' })
    if (expectedDatasetDigest !== input.datasetDigest) return blocked(['DATASET_DIGEST_MISMATCH'], { ...emptyCounts, admittedCandidates: canonicalCandidates.length })
    if (performance.now() >= deadlineAt) return blocked(['CPU_DEADLINE_REACHED'], { ...emptyCounts, admittedCandidates: uniqueCandidates.length })
    const manifest = buildOutcomeDatasetManifest({ candidates: uniqueCandidates })
    if (manifest.status !== 'ready_for_dataset_review' || manifest.eligibleCandidateCount !== uniqueCandidates.length) return blocked(['DATASET_ADMISSION_GATE_BLOCKED', ...manifest.reasonCodes], { ...emptyCounts, admittedCandidates: manifest.eligibleCandidateCount })
    if (uniqueCandidates.length < OUTCOME_MIN_DATASET_CANDIDATES) return blocked(['DATASET_ADMISSION_GATE_BLOCKED'], { ...emptyCounts, admittedCandidates: uniqueCandidates.length })

    const featureList = featureNames()
    if (featureList.length === 0 || featureList.length > MAX_FEATURES) return blocked(['FEATURE_CAP_EXCEEDED'], { ...emptyCounts, admittedCandidates: canonicalCandidates.length })
    const metricNames = featureList.filter((name) => name.endsWith('.log1p') || name.endsWith('.value')).map((name) => name.slice(0, name.endsWith('.log1p') ? -'.log1p'.length : -'.value'.length))
    const rows: Row[] = []
    const counts: TrainContentEffectModelResult['counts'] = { ...emptyCounts, admittedCandidates: uniqueCandidates.length, excludedSignals: { ...emptyCounts.excludedSignals } }
    for (const row of uniqueRows) {
      const outcome = signalLabel(row.candidate)
      if (outcome.exclusion) counts.excludedSignals[outcome.exclusion] += 1
      else rows.push({ ...row, label: outcome.label!, raw: vector(row.candidate, featureList) })
    }
    counts.binaryRows = rows.length
    counts.subjects = new Set(rows.map((row) => row.candidate.deidentifiedSubjectKey)).size
    if (rows.length > MAX_ROWS) return blocked(['ROW_CAP_EXCEEDED'], counts)
    if (rows.length < MIN_BINARY_ROWS) return blocked(['BINARY_ROW_COUNT_INSUFFICIENT'], counts)
    if (counts.subjects < MIN_SUBJECTS) return blocked(['SUBJECT_COUNT_INSUFFICIENT'], counts)
    const temporal = temporalPartition(uniqueRows, sidecar.trainingAsOf)
    if (!temporal || !temporal.cutoff) return blocked(['TEMPORAL_HOLDOUT_UNAVAILABLE'], counts)
    const temporalBinaryRows = temporal.temporalRows.filter((row) => !signalLabel(row.candidate).exclusion).map((row) => ({ ...row, label: signalLabel(row.candidate).label!, raw: vector(row.candidate, featureList) }))
    const historicalBinaryRows = temporal.historicalRows.filter((row) => !signalLabel(row.candidate).exclusion).map((row) => ({ ...row, label: signalLabel(row.candidate).label!, raw: vector(row.candidate, featureList) }))
    const split = splitRows(historicalBinaryRows)
    const reasons: string[] = []
    const trainClass = classCounts(split.train.rows)
    const validationClass = classCounts(split.validation.rows)
    const testClass = classCounts(split.test.rows)
    const temporalClass = classCounts(temporalBinaryRows)
    if (trainClass.positiveCount < TRAIN_MIN_PER_CLASS || trainClass.negativeCount < TRAIN_MIN_PER_CLASS) reasons.push('TRAIN_CLASS_COUNTS_INSUFFICIENT')
    if (validationClass.positiveCount < HOLDOUT_MIN_PER_CLASS || validationClass.negativeCount < HOLDOUT_MIN_PER_CLASS) reasons.push('VALIDATION_CLASS_COUNTS_INSUFFICIENT')
    if (testClass.positiveCount < HOLDOUT_MIN_PER_CLASS || testClass.negativeCount < HOLDOUT_MIN_PER_CLASS) reasons.push('TEST_CLASS_COUNTS_INSUFFICIENT')
    if (temporalClass.positiveCount < HOLDOUT_MIN_PER_CLASS || temporalClass.negativeCount < HOLDOUT_MIN_PER_CLASS) reasons.push('TEMPORAL_CLASS_COUNTS_INSUFFICIENT')
    if (temporal.temporalRows.length < 10) reasons.push('TEMPORAL_PUBLICATION_COUNT_INSUFFICIENT')
    if (trainClass.positiveCount === 0 || trainClass.negativeCount === 0) reasons.push('ONE_CLASS_LABELS')
    if (reasons.length) return blocked(reasons, counts)

    const normalization = normalizationFor(split.train.rows, featureList)
    const trainX = standardized(split.train.rows, normalization)
    const validationX = standardized(split.validation.rows, normalization)
    const testX = standardized(split.test.rows, normalization)
    const temporalX = standardized(temporalBinaryRows, normalization)
    const fitted = fit(split.train.rows, trainX, deadlineAt)
    if (!fitted) return blocked(['CPU_DEADLINE_REACHED'], counts)
    const trainMetrics = metrics(split.train.rows, trainX, fitted.weights, fitted.intercept)
    const validationMetrics = metrics(split.validation.rows, validationX, fitted.weights, fitted.intercept)
    const testMetrics = metrics(split.test.rows, testX, fitted.weights, fitted.intercept)
    const temporalMetrics = metrics(temporalBinaryRows, temporalX, fitted.weights, fitted.intercept)
    if (performance.now() >= deadlineAt) return blocked(['CPU_DEADLINE_REACHED'], counts)
    const majorityPositive = trainClass.positiveCount >= trainClass.negativeCount
    const baseBody: ArtifactBody = {
      schema: CONTENT_EFFECT_ARTIFACT_SCHEMA,
      task: CONTENT_EFFECT_TASK,
      features: featureList,
      coefficients: fitted.weights,
      intercept: fitted.intercept,
      normalization,
      config: { seed: 0, epochs: EPOCHS, learningRate: 0.04, l2: 0.01, maxRows: MAX_ROWS, maxFeatures: MAX_FEATURES },
      datasetDigest: input.datasetDigest,
      lineageFingerprint: input.lineageFingerprint,
      publicationMetadataFingerprint: sidecar.sidecarFingerprint,
      splits: {
        strategy: 'subject_hash_70_15_15_plus_temporal_subject_holdout',
        uniquePublications: uniqueRows.length,
        train: { rows: split.train.rows.length, subjects: split.train.subjects.size, ...trainClass },
        validation: { rows: split.validation.rows.length, subjects: split.validation.subjects.size, ...validationClass },
        test: { rows: split.test.rows.length, subjects: split.test.subjects.size, ...testClass },
        temporalHoldout: {
          status: 'AVAILABLE',
          rows: temporalBinaryRows.length,
          subjects: new Set(temporalBinaryRows.map((row) => row.candidate.deidentifiedSubjectKey)).size,
          publications: temporal.temporalRows.length,
          positiveCount: temporalClass.positiveCount,
          negativeCount: temporalClass.negativeCount,
          publishedAtCutoff: temporal.cutoff,
          latestTrainingWindowEnd: temporal.historicalRows.map((row) => row.metadata.gscFollowUpWindowEnd).sort().at(-1)!,
          trainingAsOf: sidecar.trainingAsOf,
          selectedFingerprint: outcomeSha256(temporal.temporalRows.map((row) => row.candidate.candidateFingerprint).sort()),
          excludedFingerprint: outcomeSha256([...deduped.excludedRows, ...temporal.excludedRows].map((row) => row.candidate.candidateFingerprint).sort()),
          deduplicatedExcludedFingerprint: outcomeSha256(deduped.excludedRows.map((row) => row.candidate.candidateFingerprint).sort()),
          historicalSubjectExcludedFingerprint: outcomeSha256(temporal.excludedRows.map((row) => row.candidate.candidateFingerprint).sort()),
        },
      },
      metrics: {
        train: trainMetrics,
        validation: validationMetrics,
        test: testMetrics,
        temporalHoldout: temporalMetrics,
        validationMajorityBaseline: majorityMetrics(split.validation.rows, majorityPositive, trainClass.positiveCount / split.train.rows.length),
        testMajorityBaseline: majorityMetrics(split.test.rows, majorityPositive, trainClass.positiveCount / split.train.rows.length),
        temporalMajorityBaseline: majorityMetrics(temporalBinaryRows, majorityPositive, trainClass.positiveCount / split.train.rows.length),
      },
      limitations: LIMITATIONS,
    }
    // Defensive invariant: feature construction and source-policy evolution may never silently exceed the public cap.
    if (metricNames.length * 2 + 7 !== featureList.length || featureList.length > MAX_FEATURES) return blocked(['FEATURE_SCHEMA_INVALID'], counts)
    const artifactHash = outcomeSha256(bodyForHash(baseBody))
    return { status: 'completed', artifact: { ...baseBody, artifactHash }, reasonCodes: [], counts }
  } catch {
    return blocked(['INVALID_INPUT'], emptyCounts)
  }
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  return actual.length === expected.length && actual.every((key, index) => key === expected[index])
}

function majorityBaselineMatches(baseline: Record<string, unknown>, target: Record<string, unknown>, training: Record<string, unknown>): boolean {
  const positive = training.positiveCount as number
  const negative = training.negativeCount as number
  const rowCount = (target.positiveCount as number) + (target.negativeCount as number)
  const probability = Math.min(1 - 1e-15, Math.max(1e-15, positive / (positive + negative)))
  const positiveRows = target.positiveCount as number
  const negativeRows = target.negativeCount as number
  const logLoss = -(positiveRows * Math.log(probability) + negativeRows * Math.log(1 - probability)) / rowCount
  const brierScore = (positiveRows * (1 - probability) ** 2 + negativeRows * probability ** 2) / rowCount
  const predictPositive = positive >= negative
  const f1 = predictPositive ? (2 * positiveRows) / (2 * positiveRows + negativeRows) : 0
  const balancedAccuracy = 0.5
  const expected = { logLoss, brierScore, f1, balancedAccuracy }
  return Object.entries(expected).every(([key, value]) => Math.abs((baseline[key] as number) - value) <= 1e-12 * Math.max(1, Math.abs(value)))
}

function artifactBodyFromUnknown(value: unknown): ArtifactBody | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const raw = value as Record<string, unknown>
  const artifactKeys = ['schema', 'task', 'features', 'coefficients', 'intercept', 'normalization', 'config', 'datasetDigest', 'lineageFingerprint', 'publicationMetadataFingerprint', 'splits', 'metrics', 'limitations', 'artifactHash']
  if (!exactKeys(raw, artifactKeys) || raw.schema !== CONTENT_EFFECT_ARTIFACT_SCHEMA || raw.task !== CONTENT_EFFECT_TASK || !validInputHash(raw.datasetDigest) || !validInputHash(raw.lineageFingerprint) || !validInputHash(raw.publicationMetadataFingerprint) || !validInputHash(raw.artifactHash)) return null
  if (!Array.isArray(raw.features) || raw.features.length === 0 || raw.features.length > MAX_FEATURES || raw.features.some((item) => typeof item !== 'string' || item.length > 128)) return null
  const features = raw.features as unknown[]
  if (features.length !== featureNames().length || features.some((feature, index) => feature !== featureNames()[index])) return null
  if (!Array.isArray(raw.coefficients) || raw.coefficients.length !== features.length || raw.coefficients.some((item) => typeof item !== 'number' || !Number.isFinite(item))) return null
  if (typeof raw.intercept !== 'number' || !Number.isFinite(raw.intercept)) return null
  if (!Array.isArray(raw.normalization) || raw.normalization.length !== features.length || raw.normalization.some((item, index) => !item || typeof item !== 'object' || Array.isArray(item) || !exactKeys(item as Record<string, unknown>, ['feature', 'mean', 'scale']) || (item as Record<string, unknown>).feature !== features[index] || typeof (item as Record<string, unknown>).mean !== 'number' || !Number.isFinite((item as Record<string, unknown>).mean) || typeof (item as Record<string, unknown>).scale !== 'number' || !Number.isFinite((item as Record<string, unknown>).scale) || ((item as Record<string, unknown>).scale as number) <= 0)) return null
  if (!raw.config || typeof raw.config !== 'object' || Array.isArray(raw.config) || !exactKeys(raw.config as Record<string, unknown>, ['seed', 'epochs', 'learningRate', 'l2', 'maxRows', 'maxFeatures'])) return null
  const config = raw.config as Record<string, unknown>
  if (config.seed !== 0 || config.epochs !== EPOCHS || config.maxRows !== MAX_ROWS || config.maxFeatures !== MAX_FEATURES || config.learningRate !== 0.04 || config.l2 !== 0.01) return null
  if (!raw.splits || typeof raw.splits !== 'object' || Array.isArray(raw.splits) || !exactKeys(raw.splits as Record<string, unknown>, ['strategy', 'uniquePublications', 'train', 'validation', 'test', 'temporalHoldout'])) return null
  const splits = raw.splits as Record<string, unknown>
  if (splits.strategy !== 'subject_hash_70_15_15_plus_temporal_subject_holdout' || !splits.temporalHoldout || typeof splits.temporalHoldout !== 'object' || Array.isArray(splits.temporalHoldout)) return null
  if (typeof splits.uniquePublications !== 'number' || !Number.isSafeInteger(splits.uniquePublications) || splits.uniquePublications < OUTCOME_MIN_DATASET_CANDIDATES || splits.uniquePublications > MAX_ROWS) return null
  const temporal = splits.temporalHoldout as Record<string, unknown>
  if (!exactKeys(temporal, ['status', 'rows', 'subjects', 'publications', 'positiveCount', 'negativeCount', 'publishedAtCutoff', 'latestTrainingWindowEnd', 'trainingAsOf', 'selectedFingerprint', 'excludedFingerprint', 'deduplicatedExcludedFingerprint', 'historicalSubjectExcludedFingerprint']) || temporal.status !== 'AVAILABLE' || !canonicalUtcIso(temporal.publishedAtCutoff) || !canonicalUtcIso(temporal.latestTrainingWindowEnd) || !canonicalUtcIso(temporal.trainingAsOf) || !isOutcomeSha256(temporal.selectedFingerprint) || !isOutcomeSha256(temporal.excludedFingerprint) || !isOutcomeSha256(temporal.deduplicatedExcludedFingerprint) || !isOutcomeSha256(temporal.historicalSubjectExcludedFingerprint) || temporal.latestTrainingWindowEnd >= temporal.publishedAtCutoff || temporal.publishedAtCutoff > temporal.trainingAsOf) return null
  for (const key of ['rows', 'subjects', 'publications', 'positiveCount', 'negativeCount']) if (typeof temporal[key] !== 'number' || !Number.isSafeInteger(temporal[key]) || temporal[key] < 0) return null
  if ((temporal.positiveCount as number) < HOLDOUT_MIN_PER_CLASS || (temporal.negativeCount as number) < HOLDOUT_MIN_PER_CLASS || (temporal.positiveCount as number) + (temporal.negativeCount as number) !== temporal.rows || (temporal.publications as number) < 10 || (temporal.publications as number) > (splits.uniquePublications as number) || (temporal.rows as number) > (temporal.publications as number) || (temporal.subjects as number) < 1 || (temporal.subjects as number) > (temporal.rows as number)) return null
  for (const name of ['train', 'validation', 'test']) {
    const part = splits[name]
    if (!part || typeof part !== 'object' || Array.isArray(part) || !exactKeys(part as Record<string, unknown>, ['rows', 'subjects', 'positiveCount', 'negativeCount'])) return null
    const fields = part as Record<string, unknown>
    if (['rows', 'subjects', 'positiveCount', 'negativeCount'].some((key) => typeof fields[key] !== 'number' || !Number.isSafeInteger(fields[key]) || (fields[key] as number) < 0) || (fields.rows as number) < 1 || (fields.subjects as number) < 1 || (fields.subjects as number) > (fields.rows as number) || (fields.positiveCount as number) + (fields.negativeCount as number) !== fields.rows) return null
    if (name === 'train' && ((fields.positiveCount as number) < TRAIN_MIN_PER_CLASS || (fields.negativeCount as number) < TRAIN_MIN_PER_CLASS)) return null
    if (name !== 'train' && ((fields.positiveCount as number) < HOLDOUT_MIN_PER_CLASS || (fields.negativeCount as number) < HOLDOUT_MIN_PER_CLASS)) return null
  }
  const metricKeys = ['logLoss', 'brierScore', 'f1', 'balancedAccuracy', 'positiveCount', 'negativeCount', 'rowCount']
  const metricContainer = raw.metrics
  if (!metricContainer || typeof metricContainer !== 'object' || Array.isArray(metricContainer) || !exactKeys(metricContainer as Record<string, unknown>, ['train', 'validation', 'test', 'temporalHoldout', 'validationMajorityBaseline', 'testMajorityBaseline', 'temporalMajorityBaseline'])) return null
  for (const part of Object.values(metricContainer as Record<string, unknown>)) {
    if (!part || typeof part !== 'object' || Array.isArray(part) || !exactKeys(part as Record<string, unknown>, metricKeys)) return null
    const metric = part as Record<string, unknown>
    if (metricKeys.some((key) => typeof metric[key] !== 'number' || !Number.isFinite(metric[key]) || (metric[key] as number) < 0) || !Number.isSafeInteger(metric.positiveCount) || !Number.isSafeInteger(metric.negativeCount) || !Number.isSafeInteger(metric.rowCount) || (metric.logLoss as number) > 40 || (metric.brierScore as number) > 1 || (metric.f1 as number) > 1 || (metric.balancedAccuracy as number) > 1 || (metric.positiveCount as number) + (metric.negativeCount as number) !== metric.rowCount) return null
  }
  for (const name of ['train', 'validation', 'test', 'temporalHoldout'] as const) {
    const metric = (metricContainer as Record<string, Record<string, unknown>>)[name]!
    const split = name === 'temporalHoldout' ? temporal : splits[name] as Record<string, unknown>
    if (metric.rowCount !== split.rows || metric.positiveCount !== split.positiveCount || metric.negativeCount !== split.negativeCount) return null
  }
  const trainSplit = splits.train as Record<string, number> | undefined
  const validationSplit = splits.validation as Record<string, number> | undefined
  const testSplit = splits.test as Record<string, number> | undefined
  if (!trainSplit || !validationSplit || !testSplit) return null
  if (typeof trainSplit.rows !== 'number' || typeof validationSplit.rows !== 'number' || typeof testSplit.rows !== 'number') return null
  const historicalRows = trainSplit.rows + validationSplit.rows + testSplit.rows
  if (historicalRows + (temporal.rows as number) > (splits.uniquePublications as number) || historicalRows + (temporal.rows as number) > MAX_ROWS) return null
  for (const [baselineKey, targetKey] of [['validationMajorityBaseline', 'validation'], ['testMajorityBaseline', 'test'], ['temporalMajorityBaseline', 'temporalHoldout']] as const) {
    const baseline = (metricContainer as Record<string, Record<string, number>>)[baselineKey]!
    const target = (metricContainer as Record<string, Record<string, number>>)[targetKey]!
    if (baseline.rowCount !== target.rowCount || baseline.positiveCount !== target.positiveCount || baseline.negativeCount !== target.negativeCount || !majorityBaselineMatches(baseline, target, splits.train as Record<string, unknown>)) return null
  }
  if (!Array.isArray(raw.limitations) || raw.limitations.length !== LIMITATIONS.length || raw.limitations.some((item, index) => item !== LIMITATIONS[index])) return null
  const { artifactHash: _hash, ...body } = raw
  return { ...body, schema: CONTENT_EFFECT_ARTIFACT_SCHEMA, task: CONTENT_EFFECT_TASK } as ArtifactBody
}

export function verifyContentEffectArtifact(artifact: unknown): boolean {
  try {
    const body = artifactBodyFromUnknown(artifact)
    if (!body || !artifact || typeof artifact !== 'object' || Array.isArray(artifact)) return false
    const hash = (artifact as Record<string, unknown>).artifactHash
    return isOutcomeSha256(hash) && outcomeSha256(body) === hash
  } catch {
    return false
  }
}

export function summarizeContentEffectArtifact(artifact: unknown): {
  status: 'verified' | 'invalid'
  schema: typeof CONTENT_EFFECT_ARTIFACT_SCHEMA | null
  task: typeof CONTENT_EFFECT_TASK | null
  artifactHash: string | null
  datasetDigest: string | null
  lineageFingerprint: string | null
  productionActivation: false
  temporalHoldout: ContentEffectArtifact['splits']['temporalHoldout'] | null
  splits: ContentEffectArtifact['splits'] | null
  metrics: ContentEffectArtifact['metrics'] | null
  reasonCodes: string[]
} {
  if (!verifyContentEffectArtifact(artifact)) return { status: 'invalid', schema: null, task: null, artifactHash: null, datasetDigest: null, lineageFingerprint: null, productionActivation: false, temporalHoldout: null, splits: null, metrics: null, reasonCodes: ['ARTIFACT_HASH_OR_SCHEMA_INVALID'] }
  const value = artifact as ContentEffectArtifact
  return { status: 'verified', schema: value.schema, task: value.task, artifactHash: value.artifactHash, datasetDigest: value.datasetDigest, lineageFingerprint: value.lineageFingerprint, productionActivation: false, temporalHoldout: value.splits.temporalHoldout, splits: value.splits, metrics: value.metrics, reasonCodes: [] }
}

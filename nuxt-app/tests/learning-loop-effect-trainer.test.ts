import { describe, expect, it } from 'vitest'
import { trainContentEffectModel, summarizeContentEffectArtifact, verifyContentEffectArtifact } from '../server/learning-loop/effect-trainer'
import { buildOutcomeDatasetManifest } from '../server/outcome-learning/engine'
import { OUTCOME_DATA_CONTRACT_VERSION, OUTCOME_FEATURE_FIELDS, OUTCOME_LEARNING_POLICY_VERSION, OUTCOME_POLICY_LIMITATIONS, OUTCOME_POLICY_LIMITATIONS_FOR_CANDIDATE } from '../server/outcome-learning/policy-catalog'
import { outcomeSha256 } from '../server/outcome-learning/normalization'
import { OUTCOME_LEARNING_ENGINE_VERSION, type OutcomeLearningCandidate, type OutcomeMeasurementSource, type OutcomeSignal } from '../server/outcome-learning/types'

const sourcesA: OutcomeMeasurementSource[] = ['google_search_console', 'first_party_analytics']
const sourcesB: OutcomeMeasurementSource[] = ['google_search_console', 'crm_aggregate']

function candidate(index: number, options: { label?: OutcomeSignal; llmLabel?: OutcomeSignal; followup?: number; tamper?: boolean } = {}): OutcomeLearningCandidate {
  const deidentifiedSubjectKey = outcomeSha256(`subject-${Math.floor(index / 4)}`)
  const contentType = (['article', 'faq', 'service_page', 'landing_page', 'other'] as const)[index % 5]!
  const language = index % 2 ? 'en' : 'zh-hant'
  const measurementSources = (index % 2 ? sourcesA : sourcesB).slice().sort()
  const aggregateNumericFeatures: Record<string, number> = {}
  for (const source of measurementSources) {
    for (const field of OUTCOME_FEATURE_FIELDS[source]) {
      for (const phase of ['baseline', 'follow_up', 'delta']) {
        let value = source === 'google_search_console' && field === 'impressions' && phase === 'baseline'
          ? options.label === 'positive_signal' ? 900 + index : 5 + index
          : 20 + ((index * 17 + field.length) % 11)
        if (phase === 'follow_up' && field === 'impressions') value = options.followup ?? 1_000_000 + index
        if (phase === 'delta' && field === 'impressions') value = 999_999
        aggregateNumericFeatures[`${source}.${field}.${phase}`] = value
      }
    }
  }
  const directionalLabels = measurementSources.map((source) => ({
    source,
    signal: source === 'google_search_console' ? options.label ?? (index % 2 ? 'negative_signal' : 'positive_signal') : options.llmLabel ?? 'no_material_change',
  })).sort((a, b) => a.source < b.source ? -1 : a.source > b.source ? 1 : 0) as Array<{ source: OutcomeMeasurementSource; signal: OutcomeSignal }>
  const base: Omit<OutcomeLearningCandidate, 'candidateFingerprint'> = {
    candidateStatus: 'eligible',
    deidentifiedSubjectKey,
    publicationIdentityHashes: [outcomeSha256(`publication-${index}`)],
    contentType,
    language,
    appliedRuleHashes: [outcomeSha256('rule-alpha')],
    topicClusterHash: outcomeSha256('topic-cluster'),
    aggregateNumericFeatures,
    directionalLabels,
    sourceHashes: measurementSources.flatMap((source) => [outcomeSha256(`${source}-${index}-baseline`), outcomeSha256(`${source}-${index}-followup`)]).sort(),
    measurementSources,
    policyVersion: OUTCOME_LEARNING_POLICY_VERSION,
    engineVersion: OUTCOME_LEARNING_ENGINE_VERSION,
    consentLineage: {
      consentStatus: 'granted',
      consentVersion: 'consent-v1',
      consentedAt: '2026-01-01T00:00:00.000Z',
      consentAllowedUses: ['evaluation', 'model_improvement'],
      consentRevokedAt: null,
      rightsConfirmed: true,
    },
    dataContractVersion: OUTCOME_DATA_CONTRACT_VERSION,
    limitations: [...OUTCOME_POLICY_LIMITATIONS, ...OUTCOME_POLICY_LIMITATIONS_FOR_CANDIDATE].sort(),
  }
  const output = { ...base, candidateFingerprint: outcomeSha256(base) }
  return options.tamper ? { ...output, aggregateNumericFeatures: { ...output.aggregateNumericFeatures, 'google_search_console.impressions.baseline': -9999 } } : output
}

function trainingCandidates(count = 160) {
  return Array.from({ length: count }, (_, index) => candidate(index))
}

function train(candidates = trainingCandidates()) {
  const manifest = buildOutcomeDatasetManifest({ candidates })
  const datasetDigest = outcomeSha256({ manifestFingerprint: manifest.manifestFingerprint, candidateFingerprints: candidates.map((item) => item.candidateFingerprint).sort(), policy: 'secondary_hash_only_dataset_review_v1' })
  return trainContentEffectModel({ candidates, datasetDigest, lineageFingerprint: outcomeSha256('durable-lineage') })
}

describe('offline observational content-effect trainer', () => {
  it('fits a deterministic bounded logistic model and produces verifiable metrics/artifact', () => {
    const first = train()
    const second = train()
    expect(first.status).toBe('completed')
    expect(first.artifact).not.toBeNull()
    expect(first.artifact).toEqual(second.artifact)
    expect(first.artifact?.config).toMatchObject({ seed: 0, epochs: 250, maxRows: 500, maxFeatures: 80 })
    expect(first.artifact?.features.length).toBeLessThanOrEqual(80)
    expect(first.artifact?.splits.temporalHoldout).toBe('UNAVAILABLE')
    expect(verifyContentEffectArtifact(first.artifact)).toBe(true)
    expect(first.artifact?.metrics.test.rowCount).toBeGreaterThan(0)
    expect(first.artifact?.metrics.test.logLoss).toBeLessThan(1)
  })

  it('keeps all rows from each subject within one deterministic split without publishing subject IDs', () => {
    const result = train()
    expect(result.status).toBe('completed')
    const groups = new Map<string, number>()
    for (const row of trainingCandidates()) groups.set(row.deidentifiedSubjectKey, (groups.get(row.deidentifiedSubjectKey) ?? 0) + 1)
    const ordered = [...groups.keys()].sort((a, b) => {
      const left = outcomeSha256({ seed: 0, subject: a })
      const right = outcomeSha256({ seed: 0, subject: b })
      return left < right ? -1 : left > right ? 1 : a < b ? -1 : 1
    })
    const trainEnd = Math.max(1, Math.floor(ordered.length * 0.7))
    const validationEnd = Math.max(trainEnd + 1, Math.floor(ordered.length * 0.85))
    const expectedRows = [ordered.slice(0, trainEnd), ordered.slice(trainEnd, validationEnd), ordered.slice(validationEnd)].map((subjects) => subjects.reduce((sum, subject) => sum + groups.get(subject)!, 0))
    expect(result.artifact?.splits.train.rows).toBe(expectedRows[0])
    expect(result.artifact?.splits.validation.rows).toBe(expectedRows[1])
    expect(result.artifact?.splits.test.rows).toBe(expectedRows[2])
    expect(JSON.stringify(result.artifact)).not.toContain(ordered[0]!)
  })

  it('uses only pre-publication baseline features and train-only normalization; ignores follow-up and delta values', () => {
    const baseline = trainingCandidates()
    const changedPostPublication = baseline.map((row, index) => {
      const changed = { ...row, aggregateNumericFeatures: { ...row.aggregateNumericFeatures } }
      for (const key of Object.keys(changed.aggregateNumericFeatures)) {
        if (key.endsWith('.follow_up')) changed.aggregateNumericFeatures[key] = -100_000 - index
        if (key.endsWith('.delta')) changed.aggregateNumericFeatures[key] = 88_000_000 + index
      }
      const { candidateFingerprint: _old, ...body } = changed
      return { ...body, candidateFingerprint: outcomeSha256(body) }
    })
    const result = train(baseline)
    const postPublicationResult = train(changedPostPublication)
    expect(postPublicationResult.status).toBe('completed')
    expect(postPublicationResult.artifact?.coefficients).toEqual(result.artifact?.coefficients)
    expect(postPublicationResult.artifact?.normalization).toEqual(result.artifact?.normalization)
    expect(postPublicationResult.artifact?.metrics).toEqual(result.artifact?.metrics)
    expect(result.status).toBe('completed')
    expect(result.artifact?.features.every((name) => !name.includes('follow_up') && !name.includes('.delta') && !name.includes('subject') && !name.includes('label') && !name.includes('citation'))).toBe(true)
    expect(result.artifact?.normalization.map((item) => item.feature)).toEqual(result.artifact?.features)
    expect(result.artifact?.normalization).toEqual(expect.arrayContaining(result.artifact!.features.map((feature) => expect.objectContaining({ feature, mean: expect.any(Number), scale: expect.any(Number) }))))

    const subjectKeys = [...new Set(baseline.map((row) => row.deidentifiedSubjectKey))].sort((a, b) => {
      const left = outcomeSha256({ seed: 0, subject: a }), right = outcomeSha256({ seed: 0, subject: b })
      return left < right ? -1 : left > right ? 1 : a < b ? -1 : 1
    })
    const trainEnd = Math.max(1, Math.floor(subjectKeys.length * 0.70))
    const validationEnd = Math.max(trainEnd + 1, Math.floor(subjectKeys.length * 0.85))
    const holdoutSubjects = new Set(subjectKeys.slice(trainEnd, validationEnd).concat(subjectKeys.slice(validationEnd)))
    const validationChanged = baseline.map((row, index) => {
      if (!holdoutSubjects.has(row.deidentifiedSubjectKey)) return row
      const modified = { ...row, aggregateNumericFeatures: { ...row.aggregateNumericFeatures, 'google_search_console.impressions.baseline': 500_000 + index } }
      const { candidateFingerprint: _old, ...body } = modified
      return { ...body, candidateFingerprint: outcomeSha256(body) }
    })
    const holdoutOnlyFit = train(validationChanged)
    expect(holdoutOnlyFit.status).toBe('completed')
    expect(holdoutOnlyFit.artifact?.normalization).toEqual(result.artifact?.normalization)
    expect(holdoutOnlyFit.artifact?.coefficients).toEqual(result.artifact?.coefficients)
  })

  it('revalidates candidate content instead of trusting the supplied dataset digest', () => {
    const candidates = trainingCandidates()
    candidates[0] = candidate(0, { label: 'positive_signal', tamper: true })
    const result = train(candidates)
    expect(result.status).toBe('blocked')
    expect(result.artifact).toBeNull()
    expect(result.reasonCodes).toContain('CANDIDATE_REVALIDATION_FAILED')
  })

  it('excludes mixed, no-change, insufficient, and missing GSC labels rather than treating them as negatives', () => {
    const candidates = trainingCandidates().map((row, index) => {
      if (index < 4) return candidate(index, { label: 'mixed_signal' })
      if (index < 8) return candidate(index, { label: 'no_material_change' })
      if (index < 12) return candidate(index, { label: 'insufficient_data' })
      return row
    })
    const result = train(candidates)
    expect(result.status).toBe('completed')
    expect(result.counts.excludedSignals).toEqual({ mixed_signal: 4, no_material_change: 4, insufficient_data: 4, missing_gsc_label: 0, ambiguous_gsc_label: 0 })
  })

  it('uses GSC only even when non-GSC directional labels disagree', () => {
    const candidates = Array.from({ length: 160 }, (_, index) => candidate(index, { llmLabel: index % 2 ? 'positive_signal' : 'negative_signal' }))
    const result = train(candidates)
    expect(result.status).toBe('completed')
    expect(result.artifact?.task).toBe('observational_content_effect_direction_from_gsc_v1')
    expect(result.artifact?.limitations.join(' ')).toMatch(/AI citation evidence is not a label/)
  })

  it('blocks insufficient, one-class, and over-capacity data without emitting a model', () => {
    expect(train(trainingCandidates().slice(0, 149))).toMatchObject({ status: 'blocked', artifact: null, reasonCodes: expect.arrayContaining(['DATASET_ADMISSION_GATE_BLOCKED']) })
    const oneClass = trainingCandidates().map((_, index) => candidate(index, { label: 'positive_signal' }))
    expect(train(oneClass)).toMatchObject({ status: 'blocked', artifact: null })
    expect(train(trainingCandidates(501))).toMatchObject({ status: 'blocked', artifact: null, reasonCodes: ['CANDIDATE_CAP_EXCEEDED'] })
  })

  it('detects tampering and summarizes without exposing coefficients or normalization weights', () => {
    const artifact = train().artifact!
    expect(verifyContentEffectArtifact(artifact)).toBe(true)
    expect(verifyContentEffectArtifact({ ...artifact, intercept: artifact.intercept + 0.25 })).toBe(false)
    const summary = summarizeContentEffectArtifact(artifact)
    expect(summary).toMatchObject({ status: 'verified', productionActivation: false, temporalHoldout: 'UNAVAILABLE' })
    expect(summary).not.toHaveProperty('coefficients')
    expect(summary).not.toHaveProperty('intercept')
    expect(summary).not.toHaveProperty('normalization')
    expect(artifact.limitations.join(' ')).toMatch(/not verified business impact/)
  })

  it('does not silently extend its CPU deadline', () => {
    const result = trainContentEffectModel({ candidates: trainingCandidates(), datasetDigest: outcomeSha256('d'), lineageFingerprint: outcomeSha256('l'), deadlineMs: 1 })
    expect(result.status).toBe('blocked')
    expect(result.reasonCodes).toContain('CPU_DEADLINE_REACHED')
    expect(result.artifact).toBeNull()
  })
})

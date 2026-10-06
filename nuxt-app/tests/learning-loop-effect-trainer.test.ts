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

function relabel(item: OutcomeLearningCandidate, signal: OutcomeSignal): OutcomeLearningCandidate {
  const base = { ...item, directionalLabels: item.directionalLabels.map((label) => label.source === 'google_search_console' ? { ...label, signal } : label) }
  const { candidateFingerprint: _previous, ...body } = base
  return { ...body, candidateFingerprint: outcomeSha256(body) }
}

function baselineMetadata(index: number, publishedAt: string) {
  const rows = [{
    source: 'google_search_console',
    scopeFingerprint: outcomeSha256(`gsc-scope-${index}`),
    windowStart: new Date(Date.parse(publishedAt) - 30 * 86400000).toISOString(),
    windowEnd: new Date(Date.parse(publishedAt) - 86400000).toISOString(),
    capturedAt: new Date(Date.parse(publishedAt) - 86400000).toISOString(),
    sourceHash: outcomeSha256(`gsc-baseline-source-${index}`),
  }]
  rows.sort((a, b) => {
    const left = [a.source, a.windowStart, a.windowEnd, a.scopeFingerprint, a.capturedAt, a.sourceHash]
    const right = [b.source, b.windowStart, b.windowEnd, b.scopeFingerprint, b.capturedAt, b.sourceHash]
    for (let i = 0; i < left.length; i += 1) if (left[i] !== right[i]) return left[i]! < right[i]! ? -1 : 1
    return 0
  })
  return { fingerprint: outcomeSha256({ kind: 'content_effect_baseline_metadata_v1', rows }), latestCapturedAt: rows.map(row => row.capturedAt).sort().at(-1)! }
}

function metadataFor(candidates: OutcomeLearningCandidate[], overrides: (entry: { candidateFingerprint: string; publicationGroupFingerprint: string; baselineMetadataFingerprint: string; latestBaselineCapturedAt: string; publishedAt: string; gscFollowUpWindowStart: string; gscFollowUpWindowEnd: string; capturedAt: string }, index: number) => void = () => {}) {
  const entries = candidates.map((item, index) => {
    const publishedAt = new Date(Date.UTC(2020, 0, 1 + index * 30)).toISOString()
    const baseline = baselineMetadata(index, publishedAt)
    const entry = {
      candidateFingerprint: item.candidateFingerprint,
      publicationGroupFingerprint: outcomeSha256(`publication-group-${index}`),
      baselineMetadataFingerprint: baseline.fingerprint,
      latestBaselineCapturedAt: baseline.latestCapturedAt,
      publishedAt,
      gscFollowUpWindowStart: new Date(Date.parse(publishedAt) + 7 * 86400000).toISOString(),
      gscFollowUpWindowEnd: new Date(Date.parse(publishedAt) + 14 * 86400000).toISOString(),
      capturedAt: new Date(Date.parse(publishedAt) + 14 * 86400000).toISOString(),
    }
    overrides(entry, index)
    return entry
  }).sort((a, b) => a.candidateFingerprint < b.candidateFingerprint ? -1 : a.candidateFingerprint > b.candidateFingerprint ? 1 : 0)
  return rehashMetadata(entries)
}

function rehashMetadata(entries: Array<{ candidateFingerprint: string; publicationGroupFingerprint: string; baselineMetadataFingerprint: string; latestBaselineCapturedAt: string; publishedAt: string; gscFollowUpWindowStart: string; gscFollowUpWindowEnd: string; capturedAt: string }>) {
  entries.sort((a, b) => a.candidateFingerprint < b.candidateFingerprint ? -1 : a.candidateFingerprint > b.candidateFingerprint ? 1 : 0)
  const trainingAsOf = entries.map((entry) => entry.capturedAt).sort().at(-1)!
  return { schema: 'content-effect-publication-metadata.v1' as const, trainingAsOf, entries, sidecarFingerprint: outcomeSha256({ schema: 'content-effect-publication-metadata.v1', trainingAsOf, entries }) }
}

function train(candidates = trainingCandidates(), metadata = metadataFor(candidates), digestCandidates = candidates) {
  const manifest = buildOutcomeDatasetManifest({ candidates: digestCandidates })
  const datasetDigest = outcomeSha256({ manifestFingerprint: manifest.manifestFingerprint, candidateFingerprints: digestCandidates.map((item) => item.candidateFingerprint).sort(), policy: 'secondary_hash_only_dataset_review_v1' })
  return trainContentEffectModel({ candidates, datasetDigest, lineageFingerprint: outcomeSha256('durable-lineage'), publicationMetadata: metadata })
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
    expect(first.artifact?.splits.temporalHoldout.status).toBe('AVAILABLE')
    expect(first.artifact?.metrics.temporalHoldout.rowCount).toBeGreaterThanOrEqual(10)
    expect(verifyContentEffectArtifact(first.artifact)).toBe(true)
    expect(first.artifact?.metrics.test.rowCount).toBeGreaterThan(0)
    expect(first.artifact?.metrics.test.logLoss).toBeLessThan(1)
  })

  it('keeps all rows from each subject within one deterministic split without publishing subject IDs', () => {
    const result = train()
    expect(result.status).toBe('completed')
    const allRows = trainingCandidates()
    const latestSubjects = new Set(allRows.slice(128).map((row) => row.deidentifiedSubjectKey))
    const groups = new Map<string, number>()
    for (const row of allRows.slice(0, 128)) if (!latestSubjects.has(row.deidentifiedSubjectKey)) groups.set(row.deidentifiedSubjectKey, (groups.get(row.deidentifiedSubjectKey) ?? 0) + 1)
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
    expect(summary).toMatchObject({ status: 'verified', productionActivation: false, temporalHoldout: { status: 'AVAILABLE' } })
    expect(summary).not.toHaveProperty('coefficients')
    expect(summary).not.toHaveProperty('intercept')
    expect(summary).not.toHaveProperty('normalization')
    expect(artifact.limitations.join(' ')).toMatch(/not verified business impact/)
  })

  it('does not silently extend its CPU deadline', () => {
    const candidates = trainingCandidates()
    const result = trainContentEffectModel({ candidates, datasetDigest: outcomeSha256('d'), lineageFingerprint: outcomeSha256('l'), publicationMetadata: metadataFor(candidates), deadlineMs: 1 })
    expect(result.status).toBe('blocked')
    expect(result.reasonCodes).toContain('CPU_DEADLINE_REACHED')
    expect(result.artifact).toBeNull()
  })

  it('is invariant to candidate and metadata input order', () => {
    const candidates = trainingCandidates()
    const metadata = metadataFor(candidates)
    const first = train(candidates, metadata)
    const second = train([...candidates].reverse(), { ...metadata, entries: [...metadata.entries].reverse() })
    expect(second.status).toBe('completed')
    expect(second.artifact).toEqual(first.artifact)
  })

  it('deduplicates repeated horizons before admission and reports conflicting publication metadata', () => {
    const candidates = trainingCandidates(180)
    const mixedEarliest = relabel(candidates[0]!, 'mixed_signal')
    const duplicate = candidate(0, { followup: 2_000_000 })
    const withDuplicate = [mixedEarliest, ...candidates.slice(1), duplicate]
    const sidecar = metadataFor(withDuplicate, (entry, index) => {
      if (index === 180) {
        entry.publicationGroupFingerprint = outcomeSha256('publication-group-0')
        entry.publishedAt = new Date(Date.UTC(2020, 0, 1)).toISOString()
        const baseline = baselineMetadata(0, entry.publishedAt)
        entry.baselineMetadataFingerprint = baseline.fingerprint
        entry.latestBaselineCapturedAt = baseline.latestCapturedAt
        entry.gscFollowUpWindowStart = new Date(Date.UTC(2020, 0, 22)).toISOString()
        entry.gscFollowUpWindowEnd = new Date(Date.UTC(2020, 0, 29)).toISOString()
        entry.capturedAt = entry.gscFollowUpWindowEnd
      }
    })
    const result = train(withDuplicate, sidecar)
    expect(result.status).toBe('completed')
    expect(result.artifact).not.toBeNull()
    expect(result.counts.admittedCandidates).toBe(180)
    expect(result.counts.excludedSignals.mixed_signal).toBe(1)
    expect(result.artifact!.splits.train.rows + result.artifact!.splits.validation.rows + result.artifact!.splits.test.rows + result.artifact!.splits.temporalHoldout.rows).toBe(179)

    const conflict = metadataFor(candidates, (entry, index) => {
      if (index === 159) entry.publicationGroupFingerprint = outcomeSha256('publication-group-0')
    })
    expect(train(candidates, conflict)).toMatchObject({ status: 'blocked', reasonCodes: ['PUBLICATION_GROUP_METADATA_CONFLICT'], artifact: null })

    const baselineConflict = metadataFor(withDuplicate, (entry, index) => {
      if (index === 180) {
        entry.publicationGroupFingerprint = outcomeSha256('publication-group-0')
        entry.publishedAt = new Date(Date.UTC(2020, 0, 1)).toISOString()
        entry.gscFollowUpWindowStart = new Date(Date.UTC(2020, 0, 22)).toISOString()
        entry.gscFollowUpWindowEnd = new Date(Date.UTC(2020, 0, 29)).toISOString()
        entry.capturedAt = entry.gscFollowUpWindowEnd
        entry.baselineMetadataFingerprint = outcomeSha256('different-baseline-provenance')
        entry.latestBaselineCapturedAt = new Date(Date.UTC(2019, 11, 31)).toISOString()
      }
    })
    expect(train(withDuplicate, baselineConflict)).toMatchObject({ status: 'blocked', reasonCodes: ['PUBLICATION_GROUP_METADATA_CONFLICT'], artifact: null })
  })

  it('fails closed on missing metadata and publication/window boundary violations', () => {
    const candidates = trainingCandidates()
    const sidecar = metadataFor(candidates)
    expect(train(candidates, { ...sidecar, entries: sidecar.entries.slice(1) })).toMatchObject({ status: 'blocked', reasonCodes: ['PUBLICATION_METADATA_INVALID'], artifact: null })
    const missingBaselineMetadata = metadataFor(candidates)
    const missingBaselineEntry = { ...missingBaselineMetadata.entries[0]! } as Record<string, unknown>
    delete missingBaselineEntry.baselineMetadataFingerprint
    expect(train(candidates, rehashMetadata([missingBaselineEntry as never, ...missingBaselineMetadata.entries.slice(1)]) as never)).toMatchObject({ status: 'blocked', reasonCodes: ['PUBLICATION_METADATA_INVALID'], artifact: null })

    const badPublishedBoundary = metadataFor(candidates, (entry, index) => {
      if (index === 127) entry.gscFollowUpWindowStart = new Date(Date.parse(entry.publishedAt) - 1).toISOString()
    })
    expect(train(candidates, badPublishedBoundary)).toMatchObject({ status: 'blocked', reasonCodes: ['PUBLICATION_METADATA_INVALID'], artifact: null })

    const badBaselineCapturedAt = metadataFor(candidates, (entry, index) => {
      if (index === 127) entry.latestBaselineCapturedAt = new Date(Date.parse(entry.publishedAt) + 1).toISOString()
    })
    expect(train(candidates, badBaselineCapturedAt)).toMatchObject({ status: 'blocked', reasonCodes: ['PUBLICATION_METADATA_INVALID'], artifact: null })

    const cutoff = sidecar.entries.find((entry) => entry.candidateFingerprint === candidates[128]!.candidateFingerprint)!.publishedAt
    const touchingCutoff = metadataFor(candidates, (entry, index) => {
      if (index === 127) {
        entry.gscFollowUpWindowEnd = cutoff
        entry.capturedAt = cutoff
      }
    })
    expect(train(candidates, touchingCutoff)).toMatchObject({ status: 'blocked', reasonCodes: ['TEMPORAL_HOLDOUT_UNAVAILABLE'], artifact: null })
  })

  it('rejects a legacy artifact that claims temporal holdout is unavailable', () => {
    const artifact = train().artifact!
    expect(verifyContentEffectArtifact({ ...artifact, schema: 'discoverystack.content-effect-logistic.v1', splits: { ...artifact.splits, temporalHoldout: 'UNAVAILABLE' } })).toBe(false)
  })

  it('rejects semantically invalid artifacts even when their checksum is recomputed', () => {
    const artifact = train().artifact!
    const { artifactHash: _oldHash, ...body } = artifact
    const leakedFeature = { ...body, features: [...body.features] }
    leakedFeature.features[0] = 'google_search_console.impressions.follow_up.log1p'
    expect(verifyContentEffectArtifact({ ...leakedFeature, artifactHash: outcomeSha256(leakedFeature) })).toBe(false)

    const badMetric = { ...body, metrics: { ...body.metrics, temporalHoldout: { ...body.metrics.temporalHoldout, brierScore: 1.5 } } }
    expect(verifyContentEffectArtifact({ ...badMetric, artifactHash: outcomeSha256(badMetric) })).toBe(false)

    const badMajorityBaseline = { ...body, metrics: { ...body.metrics, temporalMajorityBaseline: { ...body.metrics.temporalMajorityBaseline, logLoss: body.metrics.temporalMajorityBaseline.logLoss + 0.1 } } }
    expect(verifyContentEffectArtifact({ ...badMajorityBaseline, artifactHash: outcomeSha256(badMajorityBaseline) })).toBe(false)

    const badCounts = { ...body, splits: { ...body.splits, temporalHoldout: { ...body.splits.temporalHoldout, subjects: body.splits.temporalHoldout.rows + 1 } } }
    expect(verifyContentEffectArtifact({ ...badCounts, artifactHash: outcomeSha256(badCounts) })).toBe(false)
  })
})

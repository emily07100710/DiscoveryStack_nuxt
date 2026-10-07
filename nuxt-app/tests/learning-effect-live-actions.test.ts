import { describe, expect, it } from 'vitest'
import { buildOutcomeDatasetManifest } from '../server/outcome-learning/engine'
import { normalizeOutcomeLearningCandidate, outcomeSha256 } from '../server/outcome-learning/normalization'
import { OUTCOME_DATA_CONTRACT_VERSION, OUTCOME_FEATURE_FIELDS, OUTCOME_LEARNING_POLICY_VERSION, OUTCOME_POLICY_LIMITATIONS, OUTCOME_POLICY_LIMITATIONS_FOR_CANDIDATE } from '../server/outcome-learning/policy-catalog'
import { OUTCOME_LEARNING_ENGINE_VERSION, type OutcomeLearningCandidate, type OutcomeMeasurementSource } from '../server/outcome-learning/types'
import { buildEffectLiveActionMetadata, validateEffectLiveActionMetadata, type EffectLiveActionMetadata } from '../server/learning-loop/effect-live-action-metadata'
import { CONTENT_EFFECT_LIVE_ACTION_ARTIFACT_SCHEMA, CONTENT_EFFECT_LIVE_ACTION_TASK, CONTENT_EFFECT_ARTIFACT_SCHEMA, trainContentEffectModel, verifyContentEffectArtifact, summarizeContentEffectArtifact, type EffectPublicationMetadata } from '../server/learning-loop/effect-trainer'
import { buildEffectPublicationMetadata } from '../server/learning-loop/effect-publication-metadata'

const sourcesA: OutcomeMeasurementSource[] = ['google_search_console', 'first_party_analytics']
const sourcesB: OutcomeMeasurementSource[] = ['google_search_console', 'crm_aggregate']
const sha = (value: unknown) => outcomeSha256(value)

function candidate(index: number): OutcomeLearningCandidate {
  const measurementSources = (index % 2 ? sourcesA : sourcesB).slice().sort()
  const aggregateNumericFeatures: Record<string, number> = {}
  for (const source of measurementSources) for (const field of OUTCOME_FEATURE_FIELDS[source]) for (const phase of ['baseline', 'follow_up', 'delta']) {
    aggregateNumericFeatures[`${source}.${field}.${phase}`] = source === 'google_search_console' && field === 'impressions' && phase === 'baseline'
      ? (index % 2 ? 5 + index : 900 + index)
      : phase === 'follow_up' && field === 'impressions' ? 1_000_000 + index : phase === 'delta' && field === 'impressions' ? 999_999 : 20 + ((index * 17 + field.length) % 11)
  }
  const base: Omit<OutcomeLearningCandidate, 'candidateFingerprint'> = {
    candidateStatus: 'eligible', deidentifiedSubjectKey: sha(`subject-${Math.floor(index / 4)}`), publicationIdentityHashes: [sha(`publication-${index}`)],
    contentType: (['article', 'faq', 'service_page', 'landing_page', 'other'] as const)[index % 5]!, language: index % 2 ? 'en' : 'zh-hant',
    appliedRuleHashes: [sha('rule-alpha')], topicClusterHash: sha('topic-cluster'), aggregateNumericFeatures,
    directionalLabels: measurementSources.map(source => ({ source, signal: source === 'google_search_console' ? index % 2 ? 'negative_signal' as const : 'positive_signal' as const : 'no_material_change' as const })).sort((a, b) => a.source < b.source ? -1 : a.source > b.source ? 1 : 0),
    sourceHashes: measurementSources.flatMap(source => [sha(`${source}-${index}-baseline`), sha(`${source}-${index}-followup`)]).sort(), measurementSources,
    policyVersion: OUTCOME_LEARNING_POLICY_VERSION, engineVersion: OUTCOME_LEARNING_ENGINE_VERSION,
    consentLineage: { consentStatus: 'granted', consentVersion: 'consent-v1', consentedAt: '2026-01-01T00:00:00.000Z', consentAllowedUses: ['evaluation', 'model_improvement'], consentRevokedAt: null, rightsConfirmed: true },
    dataContractVersion: OUTCOME_DATA_CONTRACT_VERSION, limitations: [...OUTCOME_POLICY_LIMITATIONS, ...OUTCOME_POLICY_LIMITATIONS_FOR_CANDIDATE].sort(),
  }
  return { ...base, candidateFingerprint: sha(base) }
}

function candidates(count = 160): OutcomeLearningCandidate[] {
  return Array.from({ length: count }, (_, index) => {
    const value = candidate(index)
    const normalized = normalizeOutcomeLearningCandidate(value)
    if (!normalized) throw new Error('invalid synthetic candidate')
    return normalized
  })
}

function publicationMetadata(rows: OutcomeLearningCandidate[]): ReturnType<typeof buildEffectPublicationMetadata> {
  const entries: EffectPublicationMetadata[] = rows.map((row, index) => {
    const publishedAt = new Date(Date.UTC(2020, 0, 1 + index * 30)).toISOString()
    return {
      candidateFingerprint: row.candidateFingerprint,
      publicationGroupFingerprint: sha(`pub-group-${index}`), baselineMetadataFingerprint: sha(`baseline-${index}`),
      latestBaselineCapturedAt: new Date(Date.parse(publishedAt) - 86_400_000).toISOString(), publishedAt,
      gscFollowUpWindowStart: new Date(Date.parse(publishedAt) + 7 * 86_400_000).toISOString(),
      gscFollowUpWindowEnd: new Date(Date.parse(publishedAt) + 14 * 86_400_000).toISOString(),
      capturedAt: new Date(Date.parse(publishedAt) + 14 * 86_400_000).toISOString(),
    }
  })
  return buildEffectPublicationMetadata(entries)
}

function liveEntries(rows: OutcomeLearningCandidate[], metadata: NonNullable<ReturnType<typeof publicationMetadata>>): EffectLiveActionMetadata[] {
  const timing = new Map(metadata.entries.map(row => [row.candidateFingerprint, row]))
  return rows.map((row, index) => {
    const publication = timing.get(row.candidateFingerprint)!
    const published = Date.parse(publication.publishedAt)
    const beforeCount = index % 4
    const added = (index % 3) + 1
    const unmodified = index % 5
    const features = {
      newPage: 0, titleChanged: index % 2,
      paragraphsAdded: added, paragraphsRemoved: index % 2, paragraphsReplaced: index % 3, paragraphsUnmodified: unmodified,
      beforeTextLength: beforeCount * 120, plannedTextLength: (added + unmodified + 1) * 130,
      beforeParagraphCount: (index % 2) + (index % 3) + unmodified,
      plannedParagraphCount: added + (index % 3) + unmodified,
    }
    return {
      candidateFingerprint: row.candidateFingerprint,
      actionEvidenceFingerprint: sha(`action-evidence-${index}`), actionReviewFingerprint: sha(`action-review-${index}`), actionReleaseFingerprint: sha(`action-release-${index}`),
      plannedActionFingerprint: sha(`planned-action-${index}`), receiptFingerprint: sha(`receipt-${index}`), authorizationFingerprint: sha(`auth-${index}`), sourceFingerprint: sha(`source-${index}`),
      beforeCapturedAt: new Date(published - 10_000).toISOString(), dispatchStartedAt: new Date(published - 1_000).toISOString(),
      publishedAt: publication.publishedAt, verifiedAt: new Date(published + 1_000).toISOString(), expiresAt: new Date(published + 2 * 86_400_000).toISOString(), features,
    }
  })
}

function datasetDigest(rows: OutcomeLearningCandidate[]): string {
  const manifest = buildOutcomeDatasetManifest({ candidates: rows })
  return sha({ manifestFingerprint: manifest.manifestFingerprint, candidateFingerprints: rows.map(row => row.candidateFingerprint).sort(), policy: 'secondary_hash_only_dataset_review_v1' })
}

function makeArtifactInput(rows = candidates()) {
  const pub = publicationMetadata(rows)!
  const entries = liveEntries(rows, pub)
  const live = buildEffectLiveActionMetadata(entries)!
  return { candidates: rows, datasetDigest: datasetDigest(rows), lineageFingerprint: sha('durable-lineage'), publicationMetadata: pub, liveActionMetadata: live }
}

describe('effect live-action metadata sidecar and V3 training', () => {
  it('trains a V3 artifact only with an exact validated sidecar and verifies its strict schema', () => {
    const input = makeArtifactInput()
    expect(validateEffectLiveActionMetadata(input.liveActionMetadata, input.candidates, input.publicationMetadata)).not.toBeNull()
    const result = trainContentEffectModel(input)
    expect(result.status).toBe('completed')
    expect(result.artifact).toMatchObject({ schema: CONTENT_EFFECT_LIVE_ACTION_ARTIFACT_SCHEMA, task: CONTENT_EFFECT_LIVE_ACTION_TASK, liveActionMetadataFingerprint: input.liveActionMetadata.sidecarFingerprint })
    expect(result.artifact?.features.slice(-10)).toEqual([
      'liveAction.paragraphsAdded.log1p', 'liveAction.paragraphsRemoved.log1p', 'liveAction.paragraphsReplaced.log1p', 'liveAction.paragraphsUnmodified.log1p',
      'liveAction.beforeTextLength.log1p', 'liveAction.plannedTextLength.log1p', 'liveAction.beforeParagraphCount.log1p', 'liveAction.plannedParagraphCount.log1p',
      'liveAction.newPage.value', 'liveAction.titleChanged.value',
    ])
    expect(result.artifact?.normalization.map(item => item.feature)).toEqual(result.artifact?.features)
    expect(verifyContentEffectArtifact(result.artifact)).toBe(true)
    const summary = summarizeContentEffectArtifact(result.artifact)
    expect(summary.schema).toBe(CONTENT_EFFECT_LIVE_ACTION_ARTIFACT_SCHEMA)
    expect(summary).toHaveProperty('liveActionMetadataFingerprint', input.liveActionMetadata.sidecarFingerprint)
  })

  it('preserves the original V2 training path and rejects V2 artifacts with V3 claims', () => {
    const input = makeArtifactInput()
    const { liveActionMetadata: _ignored, ...v2Input } = input
    const result = trainContentEffectModel(v2Input)
    expect(result.status).toBe('completed')
    expect(result.artifact?.schema).toBe(CONTENT_EFFECT_ARTIFACT_SCHEMA)
    expect(result.artifact).not.toHaveProperty('liveActionMetadataFingerprint')
    expect(verifyContentEffectArtifact(result.artifact)).toBe(true)
    expect(summarizeContentEffectArtifact(result.artifact)).not.toHaveProperty('liveActionMetadataFingerprint')
    expect(verifyContentEffectArtifact({ ...result.artifact, schema: CONTENT_EFFECT_LIVE_ACTION_ARTIFACT_SCHEMA })).toBe(false)
  })

  it('rejects missing, extra, tampered and privacy-bearing sidecar shapes', () => {
    const input = makeArtifactInput()
    expect(trainContentEffectModel({ ...input, liveActionMetadata: { ...input.liveActionMetadata, entries: input.liveActionMetadata.entries.slice(1) } })).toMatchObject({ status: 'blocked', reasonCodes: ['LIVE_ACTION_METADATA_INVALID'] })
    expect(trainContentEffectModel({ ...input, liveActionMetadata: { ...input.liveActionMetadata, rawUrl: 'https://private.invalid' } })).toMatchObject({ status: 'blocked', reasonCodes: ['LIVE_ACTION_METADATA_INVALID'] })
    const [first, ...rest] = input.liveActionMetadata.entries
    const changed = { ...first!, features: { ...first!.features, paragraphsAdded: first!.features.paragraphsAdded + 1 } }
    const tampered = { ...input.liveActionMetadata, entries: [changed, ...rest] }
    expect(validateEffectLiveActionMetadata(tampered, input.candidates, input.publicationMetadata)).toBeNull()
    const pii = { ...first!, url: 'https://private.invalid' } as unknown as EffectLiveActionMetadata
    expect(buildEffectLiveActionMetadata([pii, ...rest])).toBeNull()
    const getter = { ...first! }
    Object.defineProperty(getter, 'sourceFingerprint', { enumerable: true, get: () => { throw new Error('must not invoke') } })
    expect(buildEffectLiveActionMetadata([getter as EffectLiveActionMetadata, ...rest])).toBeNull()
    const symbol = { ...first!, [Symbol('private')]: true }
    expect(buildEffectLiveActionMetadata([symbol as EffectLiveActionMetadata, ...rest])).toBeNull()
  })

  it('rejects late proof, expired evidence, timestamp order and inconsistent bounded action counts', () => {
    const input = makeArtifactInput()
    const first = input.liveActionMetadata.entries[0]!
    const invalid = (entry: EffectLiveActionMetadata) => buildEffectLiveActionMetadata([entry, ...input.liveActionMetadata.entries.slice(1)])
    expect(invalid({ ...first, beforeCapturedAt: new Date(Date.parse(first.dispatchStartedAt) - 30_001).toISOString() })).toBeNull()
    expect(invalid({ ...first, verifiedAt: input.publicationMetadata.entries[0]!.gscFollowUpWindowEnd })).toBeNull()
    expect(invalid({ ...first, expiresAt: first.verifiedAt })).toBeNull()
    expect(invalid({ ...first, dispatchStartedAt: new Date(Date.parse(first.publishedAt) + 1).toISOString() })).toBeNull()
    expect(invalid({ ...first, features: { ...first.features, plannedParagraphCount: first.features.plannedParagraphCount + 1 } })).toBeNull()
    expect(invalid({ ...first, features: { ...first.features, beforeTextLength: 512 * 1024 } })).toBeNull()
    const newPage = { ...first, features: { ...first.features, newPage: 1 } }
    expect(invalid(newPage)).toBeNull()
  })

  it('requires exact candidate coverage and matching publication time from the outcome sidecar', () => {
    const input = makeArtifactInput()
    expect(validateEffectLiveActionMetadata(input.liveActionMetadata, input.candidates.slice(1), input.publicationMetadata)).toBeNull()
    const first = input.liveActionMetadata.entries[0]!
    const moved = { ...first, publishedAt: new Date(Date.parse(first.publishedAt) + 1).toISOString() }
    const altered = buildEffectLiveActionMetadata([moved, ...input.liveActionMetadata.entries.slice(1)])!
    expect(validateEffectLiveActionMetadata(altered, input.candidates, input.publicationMetadata)).toBeNull()
  })

  it('rejects conflicting action evidence or planned features for one deduplicated publication', () => {
    const input = makeArtifactInput()
    const original = input.candidates[0]!
    const changedCandidateBody = { ...original, aggregateNumericFeatures: { ...original.aggregateNumericFeatures, 'google_search_console.impressions.follow_up': original.aggregateNumericFeatures['google_search_console.impressions.follow_up']! + 7 } }
    const { candidateFingerprint: _oldFingerprint, ...body } = changedCandidateBody
    const duplicate = normalizeOutcomeLearningCandidate({ ...body, candidateFingerprint: sha(body) })!
    const rows = [...input.candidates, duplicate]
    const sourceTiming = input.publicationMetadata.entries.find(row => row.candidateFingerprint === original.candidateFingerprint)!
    const duplicateTiming: EffectPublicationMetadata = {
      ...sourceTiming, candidateFingerprint: duplicate.candidateFingerprint,
      gscFollowUpWindowStart: new Date(Date.parse(sourceTiming.gscFollowUpWindowStart) + 86_400_000).toISOString(),
      gscFollowUpWindowEnd: new Date(Date.parse(sourceTiming.gscFollowUpWindowEnd) + 86_400_000).toISOString(),
      capturedAt: new Date(Date.parse(sourceTiming.capturedAt) + 86_400_000).toISOString(),
    }
    const publication = buildEffectPublicationMetadata([...input.publicationMetadata.entries, duplicateTiming])!
    const originalAction = input.liveActionMetadata.entries.find(row => row.candidateFingerprint === original.candidateFingerprint)!
    const duplicateAction = { ...originalAction, candidateFingerprint: duplicate.candidateFingerprint }
    for (const conflicted of [
      { ...duplicateAction, actionEvidenceFingerprint: sha('conflicting-action-evidence') },
      { ...duplicateAction, features: { ...duplicateAction.features, paragraphsAdded: duplicateAction.features.paragraphsAdded + 1, plannedParagraphCount: duplicateAction.features.plannedParagraphCount + 1 } },
    ]) {
      const actionMetadata = buildEffectLiveActionMetadata([...input.liveActionMetadata.entries, conflicted])!
      const result = trainContentEffectModel({ candidates: rows, datasetDigest: datasetDigest(rows), lineageFingerprint: input.lineageFingerprint, publicationMetadata: publication, liveActionMetadata: actionMetadata })
      expect(result).toMatchObject({ status: 'blocked', reasonCodes: ['PUBLICATION_GROUP_METADATA_CONFLICT'], artifact: null })
    }
  })

  it('keeps live-action holdout values out of train-only normalization and fitting', () => {
    const input = makeArtifactInput()
    const base = trainContentEffectModel(input)
    const changedEntries = input.liveActionMetadata.entries.map(entry => {
      const index = input.candidates.findIndex(row => row.candidateFingerprint === entry.candidateFingerprint)
      if (index < 128) return entry
      const added = entry.features.paragraphsAdded + 25
      return { ...entry, features: { ...entry.features, paragraphsAdded: added, plannedParagraphCount: added + entry.features.paragraphsReplaced + entry.features.paragraphsUnmodified } }
    })
    const changedSidecar = buildEffectLiveActionMetadata(changedEntries)!
    const changed = trainContentEffectModel({ ...input, liveActionMetadata: changedSidecar })
    expect(base.status).toBe('completed')
    expect(changed.status).toBe('completed')
    expect(changed.artifact?.normalization).toEqual(base.artifact?.normalization)
    expect(changed.artifact?.coefficients).toEqual(base.artifact?.coefficients)
  })
})

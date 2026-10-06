import { normalizeOutcomeMeasurement, outcomeSha256 } from '../outcome-learning/normalization'
import type { PublishedContentOutcomeAssessment } from '../outcome-learning/types'
import type { EffectPublicationMetadata, EffectPublicationMetadataSidecar } from './effect-trainer'

type PublicationTiming = Omit<EffectPublicationMetadata, 'candidateFingerprint'>
const canonicalDate = (value: unknown): value is string => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value

/** Called only after resolving the durable receipt, measurement, consent and source again. */
export function projectEffectPublicationTiming(input: {
  ownerUserId: number
  receiptFingerprint: string
  assessment: PublishedContentOutcomeAssessment
  baselineMeasurements: unknown
  followUpMeasurements: unknown
  measuredAt: Date
  checkedAt: Date
}): PublicationTiming | null {
  const { assessment, checkedAt, measuredAt } = input
  if (!Number.isSafeInteger(input.ownerUserId) || input.ownerUserId <= 0 || !/^[a-f0-9]{64}$/.test(input.receiptFingerprint) || !Number.isFinite(checkedAt.getTime()) || !Number.isFinite(measuredAt.getTime()) || measuredAt > checkedAt || !Array.isArray(input.followUpMeasurements) || !Array.isArray(input.baselineMeasurements)) return null
  const comparisons = assessment.comparisons.filter(row => row.source === 'google_search_console')
  // No favourable-scope selection: one exact GSC comparison and one corresponding source row.
  if (comparisons.length !== 1) return null
  const comparison = comparisons[0]!
  const followUps = input.followUpMeasurements.map(normalizeOutcomeMeasurement).filter(row => row?.source === 'google_search_console' && row.phase === 'follow_up')
  if (followUps.length !== 1) return null
  const followUp = followUps[0]!
  const publishedAt = assessment.publication.publishedAt
  if (!canonicalDate(publishedAt) || Date.parse(publishedAt) > checkedAt.getTime() || followUp.deidentifiedSubjectKey !== assessment.publication.deidentifiedSubjectKey || followUp.windowStart !== comparison.followUpWindow.start || followUp.windowEnd !== comparison.followUpWindow.end || !comparison.sourceHashes.includes(followUp.sourceHash) || Date.parse(followUp.capturedAt) > measuredAt.getTime() || Date.parse(followUp.capturedAt) > checkedAt.getTime()) return null
  const normalizedBaselines = input.baselineMeasurements.map(normalizeOutcomeMeasurement)
  if (!normalizedBaselines.length || normalizedBaselines.some(row => !row || row.phase !== 'baseline') || normalizedBaselines.length !== assessment.comparisons.length) return null
  const baselines = normalizedBaselines.filter(row => row !== null)
  if (new Set(baselines.map(row => row.source)).size !== baselines.length) return null
  for (const baseline of baselines) {
    const matched = assessment.comparisons.filter(row => row.source === baseline.source)
    if (matched.length !== 1 || baseline.deidentifiedSubjectKey !== assessment.publication.deidentifiedSubjectKey || baseline.windowStart !== matched[0]!.baselineWindow.start || baseline.windowEnd !== matched[0]!.baselineWindow.end || !matched[0]!.sourceHashes.includes(baseline.sourceHash) || baseline.capturedAt > publishedAt || baseline.windowEnd > publishedAt || (baseline.source === 'google_search_console' && baseline.scopeFingerprint !== followUp.scopeFingerprint)) return null
  }
  const rows = baselines.map(({ source, scopeFingerprint, windowStart, windowEnd, capturedAt, sourceHash }) => ({ source, scopeFingerprint, windowStart, windowEnd, capturedAt, sourceHash }))
    .sort((left, right) => {
      for (const key of ['source', 'windowStart', 'windowEnd', 'scopeFingerprint', 'capturedAt', 'sourceHash'] as const) {
        if (left[key] !== right[key]) return left[key] < right[key] ? -1 : 1
      }
      return 0
    })
  return {
    publicationGroupFingerprint: outcomeSha256({ kind: 'content_effect_publication_group_v1', ownerScopeFingerprint: outcomeSha256({ kind: 'content_effect_owner_scope_v1', ownerUserId: input.ownerUserId }), publicationReceiptFingerprint: input.receiptFingerprint }),
    publishedAt,
    gscFollowUpWindowStart: followUp.windowStart,
    gscFollowUpWindowEnd: followUp.windowEnd,
    capturedAt: followUp.capturedAt,
    baselineMetadataFingerprint: outcomeSha256({ kind: 'content_effect_baseline_metadata_v1', rows }),
    latestBaselineCapturedAt: rows.map(row => row.capturedAt).sort().at(-1)!,
  }
}

/** Stable for an immutable approved subset; wall-clock time is not part of this checksum. */
export function buildEffectPublicationMetadata(entries: EffectPublicationMetadata[]): EffectPublicationMetadataSidecar | null {
  if (!entries.length || entries.length > 500 || new Set(entries.map(row => row.candidateFingerprint)).size !== entries.length || entries.some(row => !/^[a-f0-9]{64}$/.test(row.candidateFingerprint) || !/^[a-f0-9]{64}$/.test(row.publicationGroupFingerprint) || !/^[a-f0-9]{64}$/.test(row.baselineMetadataFingerprint) || ![row.publishedAt, row.gscFollowUpWindowStart, row.gscFollowUpWindowEnd, row.capturedAt, row.latestBaselineCapturedAt].every(canonicalDate) || row.latestBaselineCapturedAt > row.publishedAt || row.gscFollowUpWindowStart < row.publishedAt || row.gscFollowUpWindowStart >= row.gscFollowUpWindowEnd || row.capturedAt < row.gscFollowUpWindowEnd)) return null
  const canonicalEntries = [...entries].sort((a, b) => a.candidateFingerprint.localeCompare(b.candidateFingerprint))
  const trainingAsOf = canonicalEntries.map(row => row.capturedAt).sort().at(-1)!
  const body = { schema: 'content-effect-publication-metadata.v1' as const, trainingAsOf, entries: canonicalEntries }
  return { ...body, sidecarFingerprint: outcomeSha256(body) }
}

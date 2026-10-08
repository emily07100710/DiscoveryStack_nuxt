import { createHash } from 'node:crypto'
import type { ContentOperationsRepository } from '../content-operations/repository'
import { assessPublishedContentOutcome, OUTCOME_DATA_CONTRACT_VERSION } from '../outcome-learning'
import { stableFingerprint } from '../content-operations/normalization'
import type { SiteConfirmationMeasurementPublicationLineage } from './types'
import type { SiteLearningCollectionProof } from '../content-operations/site-learning'
import { normalizeSiteLearningCollectionProof, sameSiteLearningCollectionProof, siteLearningCaptureAllowed, snapshotSiteLearningProof } from './site-learning-proof'

const sha256 = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex')
const NO_CONSENT = { consentStatus: 'unknown', consentVersion: 'site-publication-measurement-no-training', consentedAt: null, consentAllowedUses: [], consentRevokedAt: null, rightsConfirmed: false }

function safeSnapshot(values: unknown[]) {
  return values.slice(0, 100).map(value => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return { invalid: true }
    const row = value as Record<string, unknown>
    const metrics = row.metrics && typeof row.metrics === 'object' && !Array.isArray(row.metrics)
      ? Object.fromEntries(Object.entries(row.metrics as Record<string, unknown>).filter(([, metric]) => typeof metric === 'number' && Number.isFinite(metric)).slice(0, 50))
      : {}
    const proof = snapshotSiteLearningProof(row.providerProvenance)
    return { source: row.source, deidentifiedSubjectKey: row.deidentifiedSubjectKey, scopeFingerprint: row.scopeFingerprint, phase: row.phase,
      windowStart: row.windowStart, windowEnd: row.windowEnd, capturedAt: row.capturedAt, sourceHash: row.sourceHash, metrics,
      ...(proof ? { providerProvenance: { siteLearningCollectionProof: proof } } : {}) }
  })
}

/** Persists an aggregate assessment against an owner-confirmed site publication, outside the formal delivery/learning bridge. */
export async function recordSitePublicationMeasurementAssessment(input: {
  ownerUserId: number
  lineage: SiteConfirmationMeasurementPublicationLineage
  checkpointDays: number
  baselineMeasurements: unknown[]
  followUpMeasurements: unknown[]
  measuredAt: Date
  repository: ContentOperationsRepository
  revalidate: () => Promise<SiteConfirmationMeasurementPublicationLineage | null>
  revalidateForPersistence: (transaction: ContentOperationsRepository) => Promise<SiteConfirmationMeasurementPublicationLineage | null>
  resolveCollectionProof?: (transaction?: ContentOperationsRepository) => Promise<SiteLearningCollectionProof | null>
}) {
  const { ownerUserId, lineage, repository } = input
  if (lineage.evidenceKind !== 'site_publication_confirmation' || lineage.ownerUserId !== ownerUserId
    || !/^[a-f0-9]{64}$/u.test(lineage.confirmationFingerprint) || lineage.publicationReceiptFingerprint !== lineage.confirmationFingerprint
    || !Number.isSafeInteger(lineage.productionPlanId) || !lineage.appliedRuleIds.length
    || !Number.isSafeInteger(input.checkpointDays) || input.checkpointDays < 1
    || !(input.measuredAt instanceof Date) || !Number.isFinite(input.measuredAt.getTime())) throw new Error('Invalid site publication measurement assessment lineage.')

  const sameConfirmation = (fresh: SiteConfirmationMeasurementPublicationLineage | null) => Boolean(fresh
    && fresh.ownerUserId === lineage.ownerUserId && fresh.entryId === lineage.entryId && fresh.targetId === lineage.targetId
    && fresh.confirmationFingerprint === lineage.confirmationFingerprint && fresh.contentHash === lineage.contentHash
    && fresh.evidenceSnapshotHash === lineage.evidenceSnapshotHash && fresh.canonicalPage === lineage.canonicalPage
    && fresh.clientId === lineage.clientId && fresh.timeZone === lineage.timeZone && fresh.publicationLocalDate === lineage.publicationLocalDate
    && fresh.publishedAt.getTime() === lineage.publishedAt.getTime()
    && fresh.draftId === lineage.draftId && fresh.draftVersion === lineage.draftVersion)
  if (!sameConfirmation(await input.revalidate())) throw new Error('Site publication measurement confirmation became stale before assessment.')

  const publication = {
    deidentifiedSubjectKey: sha256(`content-operations:${ownerUserId}`),
    scheduleEntryId: lineage.scheduleKey,
    scheduleKey: lineage.scheduleKey,
    productionPlanId: String(lineage.productionPlanId),
    jobId: String(lineage.jobId),
    draftId: String(lineage.draftId),
    draftVersion: String(lineage.draftVersion),
    contentHash: lineage.contentHash,
    evidenceSnapshotHash: lineage.evidenceSnapshotHash,
    publishedAt: lineage.publishedAt.toISOString(),
    contentType: lineage.contentType,
    language: lineage.language,
    appliedRuleIds: lineage.appliedRuleIds,
    topicClusterCode: lineage.topicClusterCode,
  }
  const outcomeRequest = { publication, baselineMeasurements: input.baselineMeasurements, followUpMeasurements: input.followUpMeasurements, dataContractVersion: OUTCOME_DATA_CONTRACT_VERSION }
  const assessment = assessPublishedContentOutcome(outcomeRequest)
  const baselineSnapshot = safeSnapshot(input.baselineMeasurements)
  const followUpSnapshot = safeSnapshot(input.followUpMeasurements)
  const resolveSnapshot = async (transaction?: ContentOperationsRepository) => {
    const proof = normalizeSiteLearningCollectionProof(await input.resolveCollectionProof?.(transaction))
    const allSnapshots = [...baselineSnapshot, ...followUpSnapshot]
    const usable = proof && baselineSnapshot.length > 0 && followUpSnapshot.length > 0 && allSnapshots.every(snapshot => {
      const row = snapshot as Record<string, unknown>
      return sameSiteLearningCollectionProof(snapshotSiteLearningProof(row.providerProvenance), proof)
        && siteLearningCaptureAllowed(proof, row.capturedAt, lineage.confirmationFingerprint, input.measuredAt)
        && typeof row.windowEnd === 'string' && Number.isFinite(Date.parse(row.windowEnd)) && Date.parse(String(row.capturedAt)) >= Date.parse(row.windowEnd)
    })
    return { ...assessment, evidenceKind: 'site_publication_confirmation', targetId: lineage.targetId,
      confirmationFingerprint: lineage.confirmationFingerprint, checkpointDays: input.checkpointDays, learningCandidate: false as const,
      ...(usable ? { siteLearningCollectionProof: proof } : {}) }
  }
  let assessmentSnapshot = await resolveSnapshot()
  let assessmentFingerprint = stableFingerprint(assessmentSnapshot)
  const idempotencyKey = `site-measurement-outcome:${sha256(JSON.stringify({ ownerUserId, entryId: lineage.entryId, targetId: lineage.targetId,
    checkpointDays: input.checkpointDays, confirmationFingerprint: lineage.confirmationFingerprint,
    sourceHashes: [...baselineSnapshot, ...followUpSnapshot].map(row => row && typeof row === 'object' ? (row as Record<string, unknown>).sourceHash : null).sort() }))}`
  const existing = await repository.findOutcomeByIdempotency(ownerUserId, idempotencyKey)
  if (existing) {
    if (existing.targetId !== lineage.targetId || existing.publicationReceiptFingerprint !== lineage.confirmationFingerprint
      || existing.contentHash !== lineage.contentHash || existing.evidenceSnapshotHash !== lineage.evidenceSnapshotHash
      || existing.assessmentFingerprint !== assessmentFingerprint) throw new Error('Site publication measurement outcome idempotency collision.')
    return { assessment, learningCandidate: null, persisted: existing, evidenceKind: 'site_publication_confirmation' as const }
  }

  if (!sameConfirmation(await input.revalidate())) throw new Error('Site publication measurement confirmation became stale before persistence.')
  const result = await repository.transaction(async transaction => {
    // A revoked/changed grant is never retained as active assessment authority after an await.
    assessmentSnapshot = await resolveSnapshot(transaction)
    assessmentFingerprint = stableFingerprint(assessmentSnapshot)
    const raced = await transaction.findOutcomeByIdempotency(ownerUserId, idempotencyKey)
    if (raced) {
      if (raced.targetId !== lineage.targetId || raced.publicationReceiptFingerprint !== lineage.confirmationFingerprint
        || raced.contentHash !== lineage.contentHash || raced.evidenceSnapshotHash !== lineage.evidenceSnapshotHash
        || raced.assessmentFingerprint !== assessmentFingerprint) throw new Error('Site publication measurement outcome idempotency collision.')
      return raced
    }
    if (!sameConfirmation(await input.revalidateForPersistence(transaction))) throw new Error('Site publication measurement confirmation became stale before persistence.')
    assessmentSnapshot = await resolveSnapshot(transaction)
    assessmentFingerprint = stableFingerprint(assessmentSnapshot)
    return transaction.insertOutcome({ ownerUserId, entryId: lineage.entryId, runId: null, targetId: lineage.targetId, draftId: lineage.draftId,
      publicationReceiptFingerprint: lineage.confirmationFingerprint, publishedUrl: lineage.canonicalPage, contentHash: lineage.contentHash,
      evidenceSnapshotHash: lineage.evidenceSnapshotHash, assessmentStatus: assessment.status, assessmentFingerprint, baselineSnapshot,
      followUpSnapshot, assessmentSnapshot, consentLineageSnapshot: NO_CONSENT, idempotencyKey, measuredAt: input.measuredAt })
  })
  return { assessment, learningCandidate: null, persisted: result, evidenceKind: 'site_publication_confirmation' as const }
}

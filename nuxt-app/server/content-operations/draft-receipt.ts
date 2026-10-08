import { normalizeFirstPartyDraftReceipt, type FirstPartyDraftReceipt } from '../first-party-publishing/draft-receipt'
import { fingerprint } from '../publication-routing/canonical'
import { stableFingerprint } from './normalization'
import type { ContentOperationCalendarEntryRow, ContentOperationPublicationAttemptRow, ContentOperationPublicationTargetRow } from './types'

type DraftAttemptIdentity = Pick<ContentOperationPublicationAttemptRow, 'ownerUserId' | 'clientId' | 'entryId' | 'runId' | 'targetId' | 'idempotencyKey' | 'inputFingerprint' | 'publicationId' | 'publicationSlug' | 'publicationPath' | 'contentHash' | 'publicationContentHash' | 'evidenceSnapshotHash' | 'artifactFingerprint'>

/** Bind a historical draft receipt to this exact owner/entry/target attempt, not a live publication. */
export function singleDraftReceiptFingerprint(attempt: DraftAttemptIdentity, receipt: FirstPartyDraftReceipt): string {
  return stableFingerprint({
    schemaVersion: 'content-operation-private-draft-ingest-v1',
    ownerUserId: attempt.ownerUserId, clientId: attempt.clientId, entryId: attempt.entryId,
    runId: attempt.runId, targetId: attempt.targetId, idempotencyKey: attempt.idempotencyKey,
    inputFingerprint: attempt.inputFingerprint, publicationId: attempt.publicationId,
    publicationSlug: attempt.publicationSlug, publicationPath: attempt.publicationPath,
    contentHash: attempt.contentHash, publicationContentHash: attempt.publicationContentHash,
    evidenceSnapshotHash: attempt.evidenceSnapshotHash, artifactFingerprint: attempt.artifactFingerprint,
    receipt,
  })
}

/** Safe owner-workspace projection. This never grants publication or learning authority. */
export function draftReceiptFromAttempt(attempt: ContentOperationPublicationAttemptRow, entry: ContentOperationCalendarEntryRow, target: ContentOperationPublicationTargetRow): FirstPartyDraftReceipt | null {
  try {
    if (attempt.status !== 'draft_received' || attempt.mode !== 'execute' || attempt.remoteState !== 'draft_received'
      || target.framework !== 'nextjs' || target.transport !== 'first_party_signed_api'
      || attempt.ownerUserId !== entry.ownerUserId || attempt.ownerUserId !== target.ownerUserId
      || attempt.entryId !== entry.id || attempt.targetId !== target.id || attempt.clientId !== target.clientId
      || attempt.contentHash !== entry.contentHash || attempt.evidenceSnapshotHash !== entry.evidenceSnapshotHash
      || attempt.remoteRevision != null || attempt.publicationUrl != null || attempt.errorCode != null || attempt.errorSummary != null
      || !/^[a-f0-9]{64}$/u.test(attempt.receiptFingerprint || '') || !/^[a-f0-9]{64}$/u.test(attempt.artifactFingerprint || '')
      || !/^[a-f0-9]{64}$/u.test(attempt.publicationContentHash || '')
      || !Array.isArray(attempt.receiptLedger) || attempt.receiptLedger.length !== 1) return null
    const value: unknown = attempt.receiptLedger[0]
    if (!attempt.routeId) {
      const receipt = normalizeFirstPartyDraftReceipt(value)
      if (!receipt || receipt.publicationId !== `deliverable-${entry.productionDeliverableId}` || receipt.contentHash !== attempt.publicationContentHash
        || singleDraftReceiptFingerprint(attempt, receipt) !== attempt.receiptFingerprint) return null
      return receipt
    }
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
    const raw = value as Record<string, unknown>
    const receipt = normalizeFirstPartyDraftReceipt(raw.draftReceipt)
    const destination = target.destinationPublicationIdentity || `destination-${stableFingerprint({ targetId: target.targetId, targetOrigin: target.targetOrigin, contentRoot: target.contentRoot }).slice(0, 32)}`
    if (!receipt || raw.status !== 'draft_received' || raw.planFingerprint !== attempt.routingPlanId || raw.routeId !== attempt.routeId
      || raw.targetId !== target.targetId || raw.destinationPublicationIdentity !== destination || receipt.publicationId !== destination
      || raw.draftId !== `draft-${entry.draftId}` || raw.sourcePublicationIdentity !== `source-${entry.id}-${attempt.contentHash.slice(0, 32)}`
      || raw.contentHash !== attempt.publicationContentHash || receipt.contentHash !== attempt.publicationContentHash
      || raw.evidenceSnapshotHash !== attempt.evidenceSnapshotHash || raw.executor !== 'first_party_signed_api'
      || raw.executorRunId !== attempt.executorRunId || raw.attempt !== attempt.attemptNumber
      || fingerprint(raw) !== attempt.receiptFingerprint) return null
    return receipt
  } catch { return null }
}

import type { RunInsert } from './repository'
import type { ContentOperationCalendarEntryRow } from './types'
import { stableFingerprint } from './normalization'

export const CONTENT_OPERATION_RUN_IDENTITY_VERSION = 'content-operation-run-identity-v2' as const

export function canonicalContentOperationRunIdentity(
  entry: ContentOperationCalendarEntryRow,
  stage: RunInsert['stage'],
): { inputFingerprint: string; idempotencyKey: string } {
  const lineage = stage === 'generation'
    ? {
        calendarId: entry.calendarId,
        productionDeliverableId: entry.productionDeliverableId,
        evidenceSnapshotHash: entry.evidenceSnapshotHash,
      }
    : {
        jobId: entry.jobId,
        draftId: entry.draftId,
        evidenceSnapshotHash: entry.evidenceSnapshotHash,
      }
  const inputFingerprint = stableFingerprint({
    version: CONTENT_OPERATION_RUN_IDENTITY_VERSION,
    entryId: entry.id,
    stage,
    lineage,
  })
  return {
    inputFingerprint,
    idempotencyKey: `orchestrator:${stage}:${entry.id}:${inputFingerprint.slice(0, 32)}`.slice(0, 128),
  }
}

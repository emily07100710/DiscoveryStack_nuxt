import type { ContentOperationsRepository } from '../content-operations/repository'
import { createContentOperationsDeliveredPublicationSource } from '../intervention-loop/content-operations-source'
import type { InterventionLoopDependencies } from '../intervention-loop/dependencies'
import type { registerDeliveredPublication } from '../intervention-loop/tick'
import type { scheduleMeasurementForEntry, MeasurementCollectionDependencies } from '../measurement-collection/service'
import { fingerprint } from '../geo-outcome-model/canonical'
import { contentFingerprint } from '../seo-geo-core/riskGate'

export type PublicationBridgeDependencies = {
  enabled?: boolean
  intervention?: Partial<InterventionLoopDependencies>
  measurement?: MeasurementCollectionDependencies
  register?: typeof registerDeliveredPublication
  schedule?: typeof scheduleMeasurementForEntry
}

/** Hash-only immutable description of exactly what was accepted, not an invented pre-publish page. */
export function publicationLearningSnapshot(input: { draftId: number; draftVersion: number; draftContentHash: string; title: string; body: string; targetId: number; publicationContentHash: string; receiptFingerprint: string }) {
  if (![input.draftContentHash, input.publicationContentHash, input.receiptFingerprint].every(hash => /^[a-f0-9]{64}$/.test(hash)) || ![input.draftId, input.draftVersion, input.targetId].every(id => Number.isSafeInteger(id) && id > 0) || contentFingerprint(input.title, input.body) !== input.draftContentHash) throw new Error('Invalid publication learning identity.')
  const allUnits = input.body.split(/\n\s*\n/u).filter(unit => unit.trim())
  const bodyUnits = allUnits.slice(0, 512).map((unit, index) => ({ index, hash: fingerprint(unit) }))
  const snapshot = { contractVersion: 'publication-learning-snapshot-v1', draftId: input.draftId, draftVersion: input.draftVersion, draftContentHash: input.draftContentHash, targetId: input.targetId, publicationContentHash: input.publicationContentHash, receiptFingerprint: input.receiptFingerprint, titleHash: fingerprint(input.title), bodyUnits, bodyUnitCount: allUnits.length, bodyUnitsTruncated: allUnits.length > 512, beforeState: 'unknown' as const, comparisonKind: 'exact_published_draft_snapshot' as const, causalChangeSetEligible: false as const }
  return { ...snapshot, snapshotFingerprint: fingerprint(snapshot) }
}

/** Post-commit only: failures must never turn a successful remote write into a re-publication retry. */
export async function notifyLearningLoopPublicationDelivered(ownerUserId: number, entryId: number, operations: ContentOperationsRepository, dependencies: PublicationBridgeDependencies = {}) {
  if (!(dependencies.enabled ?? process.env.NUXT_LEARNING_LOOP_ENABLED === 'true')) return { status: 'disabled' as const, interventionId: null, scheduled: 0, reasonCodes: [] }
  const reasons: string[] = [], source = createContentOperationsDeliveredPublicationSource(operations)
  let interventionId: number | null = null, scheduled = 0
  try {
    // Re-read the durable receipt. Caller-supplied draft, URL or success booleans are never authority.
    const publication = await source.resolveDeliveredPublication!(ownerUserId, entryId)
    if (!publication) return { status: 'blocked' as const, interventionId, scheduled, reasonCodes: ['EXACT_DELIVERED_RECEIPT_REQUIRED'] }
    const lineage = await operations.resolveDeliveredPublication(ownerUserId, entryId)
    // Load downstream workers after the delivery commit, avoiding a publisher -> measurement ->
    // publisher barrel cycle in Nitro chunks and keeping default-off imports side-effect free.
    const register = dependencies.register || (await import('../intervention-loop/tick')).registerDeliveredPublication
    const result = await register(ownerUserId, { ...publication, briefId: lineage?.job?.briefId || null, draftId: lineage?.draft?.id || null, changeSummary: `內容營運正式發布（排程項目 #${entryId}）` }, { ...dependencies.intervention, deliveredPublications: source })
    interventionId = result.interventionId
  } catch { reasons.push('INTERVENTION_REGISTRATION_DEFERRED') }
  try { const schedule = dependencies.schedule || (await import('../measurement-collection/service')).scheduleMeasurementForEntry; const result = await schedule(ownerUserId, entryId, { ...dependencies.measurement, contentOperations: operations }); scheduled = result.scheduled } catch { reasons.push('MEASUREMENT_SCHEDULING_DEFERRED') }
  return { status: reasons.length ? 'deferred' as const : 'completed' as const, interventionId, scheduled, reasonCodes: reasons, limitations: ['metadata_only_no_measurement_provider_fetch', 'receipt_replay_safe', 'no_invented_pre_publication_baseline'] }
}

/** Crash recovery from formal attempt/event ledgers, bounded independently of live publishing. */
export async function reconcileLearningPublications(ownerUserId: number, operations: ContentOperationsRepository, dependencies: PublicationBridgeDependencies = {}, clientId?: number) {
  if (!(dependencies.enabled ?? process.env.NUXT_LEARNING_LOOP_ENABLED === 'true')) return { status: 'disabled', considered: 0, completed: 0, deferred: 0 }
  const entries = (await operations.listEntries(ownerUserId)).filter(row => ['delivered', 'completed'].includes(row.status)).sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
  const offset = entries.length ? (Math.floor(Date.now() / 300000) * 25) % entries.length : 0
  const fairEntries = [...entries.slice(offset), ...entries.slice(0, offset)]
  const selected = []
  for (const row of fairEntries) {
    if (selected.length >= 25) break
    if (clientId !== undefined) { const calendar = await operations.findCalendar(ownerUserId, row.calendarId); if (calendar?.clientId !== clientId) continue }
    selected.push(row)
  }
  let completed = 0, deferred = 0
  for (const row of selected) { const result = await notifyLearningLoopPublicationDelivered(ownerUserId, row.id, operations, dependencies); if (result.status === 'completed') completed += 1; else deferred += 1 }
  return { status: 'completed', considered: selected.length, completed, deferred }
}

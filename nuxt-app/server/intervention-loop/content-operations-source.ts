import { createContentOperationsRepository, type ContentOperationsRepository } from '../content-operations/repository'
import type { InterventionDeliveredPublicationSource } from './dependencies'
import { resolvePublicationActionEvidence } from '../learning-loop/action-release'
import type { LearningLoopRepository } from '../learning-loop/types'
import { projectDeliveredPublicationReceipt } from './delivered-publication-receipt'
export { projectDeliveredPublicationReceipt } from './delivered-publication-receipt'

export function createContentOperationsDeliveredPublicationSource(repository?: ContentOperationsRepository, learning?: LearningLoopRepository): InterventionDeliveredPublicationSource {
  let db = repository
  return {
    async resolvePublicationActionEvidence(ownerUserId, entryId, now) {
      if (!db) db = createContentOperationsRepository()
      return resolvePublicationActionEvidence(ownerUserId, entryId, { operations: db, learning, now: typeof now === 'function' ? now : () => now })
    },
    async resolveDeliveredPublication(ownerUserId, entryId) {
      if (!db) db = createContentOperationsRepository()
      const delivered = await db.resolveDeliveredPublication(ownerUserId, entryId)
      const client = delivered ? await db.findClient(ownerUserId, delivered.calendar.clientId) : null
      return delivered ? projectDeliveredPublicationReceipt(ownerUserId, client, delivered) : null
    },
    async listDeliveredPublications(ownerUserId, limit) {
    if (!db) db = createContentOperationsRepository()
    const entries = (await db.listEntries(ownerUserId)).filter(entry => entry.status === 'delivered' || entry.status === 'completed').sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime()).slice(0, Math.max(1, Math.min(200, limit)))
    const result = []
    for (const entry of entries) { try { const delivered = await db.resolveDeliveredPublication(ownerUserId, entry.id); const client = delivered ? await db.findClient(ownerUserId, delivered.calendar.clientId) : null; const value = delivered ? projectDeliveredPublicationReceipt(ownerUserId, client, delivered) : null; if (value) result.push(value) } catch { /* a stale calendar row must not stop owner tick */ } }
    return result
  } }
}

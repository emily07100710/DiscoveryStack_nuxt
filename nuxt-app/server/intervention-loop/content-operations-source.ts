import { createContentOperationsRepository, type ContentOperationsRepository } from '../content-operations/repository'
import { resolvePublicationPublicUrl } from '../content-operations/publication-public-url'
import type { DeliveredPublication } from '../content-operations/types'
import type { InterventionDeliveredPublicationSource } from './dependencies'

/** Project only a canonical repository-resolved receipt; this does not grant publication authority. */
export function projectDeliveredPublicationReceipt(ownerUserId: number, client: Awaited<ReturnType<ContentOperationsRepository['findClient']>>, delivered: DeliveredPublication) {
  const { entry, publicationAttempt: attempt, publicationRun: run, publicationTarget: target, draft, job } = delivered
  if (!attempt || !target || !run || !['delivered', 'completed'].includes(entry.status) || attempt.status !== 'delivered' || attempt.mode !== 'execute' || run.stage !== 'publication' || run.state !== 'succeeded' || attempt.runId !== run.id || attempt.targetId !== target.id || typeof attempt.receiptFingerprint !== 'string' || !/^[a-f0-9]{64}$/u.test(attempt.receiptFingerprint)) return null
  if (entry.ownerUserId !== ownerUserId || target.ownerUserId !== ownerUserId || target.clientId !== delivered.calendar.clientId || delivered.calendar.ownerUserId !== ownerUserId || client?.ownerUserId !== ownerUserId || client.id !== delivered.calendar.clientId || attempt.ownerUserId !== ownerUserId || attempt.clientId !== delivered.calendar.clientId || attempt.entryId !== entry.id || run.ownerUserId !== ownerUserId || run.entryId !== entry.id) return null
  if (!entry.contentHash || !/^[a-f0-9]{64}$/u.test(entry.contentHash) || attempt.contentHash !== entry.contentHash || draft?.contentHash !== entry.contentHash) return null
  const publicPage = resolvePublicationPublicUrl({ ownerUserId, client, entry, target, identity: { publicationId: attempt.publicationId, slug: attempt.publicationSlug, path: attempt.publicationPath }, publicationUrl: attempt.publicationUrl })
  if (!publicPage.configured) return null
  const publicationUrl = publicPage.publicationUrl
  const deliveredAt = attempt.completedAt
  if (!publicationUrl || !(deliveredAt instanceof Date) || !Number.isFinite(deliveredAt.getTime())) return null
  return { entryId: entry.id, targetId: target.id, publicationUrl, contentHash: entry.contentHash || null, receiptFingerprint: attempt.receiptFingerprint, deliveredAt, briefId: job?.briefId || null, draftId: draft?.id || null, changeSummary: `內容營運自動發布（排程項目 #${entry.id}）` }
}

export function createContentOperationsDeliveredPublicationSource(repository?: ContentOperationsRepository): InterventionDeliveredPublicationSource {
  let db = repository
  return {
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

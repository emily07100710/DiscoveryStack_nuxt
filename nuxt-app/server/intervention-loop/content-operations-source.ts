import { createContentOperationsRepository, type ContentOperationsRepository } from '../content-operations/repository'
import type { DeliveredPublication } from '../content-operations/types'
type InterventionDeliveredPublicationSource = { listDeliveredPublications(ownerUserId: number, limit: number): Promise<Array<{ entryId: number, targetId: number | null, publicationUrl: string, contentHash: string | null, receiptFingerprint: string, deliveredAt: Date, briefId: number | null, draftId: number | null, changeSummary: string }>> }

function project(delivered: DeliveredPublication) {
  const { entry, publicationAttempt: attempt, publicationRun: run, publicationTarget: target, draft, job } = delivered
  if (!attempt || !target || !run || !['delivered', 'completed'].includes(entry.status) || attempt.status !== 'delivered' || run.stage !== 'publication' || run.state !== 'succeeded' || attempt.runId !== run.id || attempt.targetId !== target.id || typeof attempt.receiptFingerprint !== 'string' || !/^[a-f0-9]{64}$/u.test(attempt.receiptFingerprint)) return null
  const publicationUrl = attempt.publicationUrl || (entry.publicationPath ? `${target.targetOrigin}${entry.publicationPath.startsWith('/') ? '' : '/'}${entry.publicationPath}` : null)
  const deliveredAt = attempt.completedAt || run.completedAt || entry.updatedAt
  if (!publicationUrl || !(deliveredAt instanceof Date) || !Number.isFinite(deliveredAt.getTime())) return null
  return { entryId: entry.id, targetId: target.id, publicationUrl, contentHash: entry.contentHash || null, receiptFingerprint: attempt.receiptFingerprint, deliveredAt, briefId: job?.briefId || null, draftId: draft?.id || null, changeSummary: `內容營運自動發布（排程項目 #${entry.id}）` }
}

export function createContentOperationsDeliveredPublicationSource(repository?: ContentOperationsRepository): InterventionDeliveredPublicationSource {
  let db = repository
  return { async listDeliveredPublications(ownerUserId, limit) {
    if (!db) db = createContentOperationsRepository()
    const entries = (await db.listEntries(ownerUserId)).filter(entry => entry.status === 'delivered' || entry.status === 'completed').sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime()).slice(0, Math.max(1, Math.min(200, limit)))
    const result = []
    for (const entry of entries) { try { const delivered = await db.resolveDeliveredPublication(ownerUserId, entry.id); const value = delivered ? project(delivered) : null; if (value) result.push(value) } catch { /* a stale calendar row must not stop owner tick */ } }
    return result
  } }
}

import { and, desc, eq, lt } from 'drizzle-orm'
import { createError } from 'h3'
import { getDatabase } from '../../database'
import { managedSiteContactSubmissions, managedSiteProjects, type ManagedSiteContactSubmission } from '../../database/schema'
import { roleAllows, type ManagedSiteRole } from '../types'

export type ContactInboxActor = { ownerUserId: number; projectId: number; role: ManagedSiteRole }
export type ContactMessageRepository = { list(actor: ContactInboxActor, beforeId: number | undefined, limit: number): Promise<ManagedSiteContactSubmission[]> }

export function makeContactMessageRepository(database: any): ContactMessageRepository {
  return {
    async list(actor, beforeId, limit) {
      const rows = await database.select({ message: managedSiteContactSubmissions }).from(managedSiteContactSubmissions)
        .innerJoin(managedSiteProjects, eq(managedSiteContactSubmissions.projectId, managedSiteProjects.id))
        .where(and(eq(managedSiteProjects.ownerUserId, actor.ownerUserId), eq(managedSiteProjects.id, actor.projectId), beforeId ? lt(managedSiteContactSubmissions.id, beforeId) : undefined))
        .orderBy(desc(managedSiteContactSubmissions.id)).limit(limit)
      return rows.map((row: { message: ManagedSiteContactSubmission }) => row.message)
    },
  }
}

function statusMessage(row: ManagedSiteContactSubmission): string {
  if (row.status === 'forwarded') return '已寄到網站綁定信箱'
  if (row.status === 'received') return '已保存，通知狀態尚未確認'
  if (row.forwardErrorCode === 'no_bound_inbox') return '已保存；尚未綁定收信信箱'
  if (row.forwardErrorCode === 'transport_unconfigured') return '已保存；平台寄信尚未設定'
  return '已保存；寄信未完成，可直接在這裡查看訊息'
}

/** PII access uses the existing administrator/owner data permission; not an editor or analyst grant. */
export async function listManagedSiteContactMessages(actor: ContactInboxActor, input: { beforeId?: number } = {}, repository?: ContactMessageRepository) {
  if (!Number.isSafeInteger(actor.ownerUserId) || actor.ownerUserId < 1 || !Number.isSafeInteger(actor.projectId) || actor.projectId < 1 || !roleAllows(actor.role, 'data:export')) throw createError({ statusCode: 403, statusMessage: '只有網站管理員可以查看訪客聯絡資料。' })
  if (input.beforeId !== undefined && (!Number.isSafeInteger(input.beforeId) || input.beforeId < 1)) throw createError({ statusCode: 422, statusMessage: '訊息分頁格式不正確。' })
  const database = repository ? undefined : getDatabase()
  if (!repository && !database) throw createError({ statusCode: 503, statusMessage: '網站詢問暫時無法讀取，請稍後再試。' })
  const rows = await (repository || makeContactMessageRepository(database)).list(actor, input.beforeId, 51)
  if (rows.some(row => row.projectId !== actor.projectId)) throw createError({ statusCode: 503, statusMessage: '網站詢問的專案範圍無法確認。' })
  const messages = rows.slice(0, 50).map(row => ({ id: row.id, name: row.submittedName, email: row.submittedEmail, phone: row.submittedPhone, message: row.submittedMessage, status: row.status, deliveryNote: statusMessage(row), createdAt: row.createdAt.toISOString() }))
  return { messages, nextBeforeId: rows.length > 50 ? messages[messages.length - 1]!.id : null }
}

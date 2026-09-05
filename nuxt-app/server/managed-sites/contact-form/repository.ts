import { and, desc, eq, gt } from 'drizzle-orm'
import { createError } from 'h3'
import { getDatabase } from '../../database'
import { managedSiteContactInboxBindings, managedSiteContactSubmissions, managedSiteProjects, type ManagedSiteContactInboxBinding, type ManagedSiteContactSubmission, type ManagedSiteProject } from '../../database/schema'

export type ManagedSiteContactFormRepository = {
  findProjectByTokenHash(tokenHash: string): Promise<ManagedSiteProject | null>
  findBoundInbox(projectId: number): Promise<ManagedSiteContactInboxBinding | null>
  findRecentDuplicate(dedupeKey: string, since: Date): Promise<ManagedSiteContactSubmission | null>
  insertSubmission(input: Omit<ManagedSiteContactSubmission, 'id' | 'createdAt'>): Promise<ManagedSiteContactSubmission>
  updateSubmission(id: number, patch: Partial<Pick<ManagedSiteContactSubmission, 'status' | 'forwardTargetEmail' | 'forwardedAt' | 'forwardErrorCode'>>): Promise<ManagedSiteContactSubmission | null>
}

function rowId(result: unknown): number {
  const id = Number((result as Array<Record<string, unknown>> | undefined)?.[0]?.insertId)
  if (!Number.isSafeInteger(id) || id < 1) throw createError({ statusCode: 500, statusMessage: '聯絡表單資料無法儲存。' })
  return id
}

export function makeManagedSiteContactFormRepository(database: any): ManagedSiteContactFormRepository {
  return {
    async findProjectByTokenHash(tokenHash) {
      const [row] = await database.select().from(managedSiteProjects).where(eq(managedSiteProjects.contactFormTokenHash, tokenHash)).limit(1)
      return row || null
    },
    async findBoundInbox(projectId) {
      const [row] = await database.select().from(managedSiteContactInboxBindings)
        .where(and(eq(managedSiteContactInboxBindings.projectId, projectId), eq(managedSiteContactInboxBindings.status, 'bound')))
        .orderBy(desc(managedSiteContactInboxBindings.boundAt), desc(managedSiteContactInboxBindings.id)).limit(1)
      return row || null
    },
    async findRecentDuplicate(dedupeKey, since) {
      const [row] = await database.select().from(managedSiteContactSubmissions)
        .where(and(eq(managedSiteContactSubmissions.dedupeKey, dedupeKey), gt(managedSiteContactSubmissions.createdAt, since))).limit(1)
      return row || null
    },
    async insertSubmission(input) {
      const id = rowId(await database.insert(managedSiteContactSubmissions).values(input as any))
      const [row] = await database.select().from(managedSiteContactSubmissions).where(eq(managedSiteContactSubmissions.id, id)).limit(1)
      if (!row) throw createError({ statusCode: 500, statusMessage: '聯絡表單資料無法讀取。' })
      return row
    },
    async updateSubmission(id, patch) {
      await database.update(managedSiteContactSubmissions).set(patch as any).where(eq(managedSiteContactSubmissions.id, id))
      const [row] = await database.select().from(managedSiteContactSubmissions).where(eq(managedSiteContactSubmissions.id, id)).limit(1)
      return row || null
    },
  }
}

export function getManagedSiteContactFormRepository(): ManagedSiteContactFormRepository {
  const database = getDatabase()
  if (!database) throw createError({ statusCode: 503, statusMessage: '聯絡表單服務暫時無法使用。' })
  return makeManagedSiteContactFormRepository(database)
}

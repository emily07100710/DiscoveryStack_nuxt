import { and, desc, eq, ne } from 'drizzle-orm'
import { createError } from 'h3'
import { getDatabase } from '../../database'
import { managedSiteContactInboxBindings, type ManagedSiteContactInboxBinding } from '../../database/schema'

export type ManagedSiteContactInboxBindingRepository = {
  transaction<T>(work: (repository: ManagedSiteContactInboxBindingRepository) => Promise<T>): Promise<T>
  listForSession(sessionId: number): Promise<ManagedSiteContactInboxBinding[]>
  insertBinding(input: Omit<ManagedSiteContactInboxBinding, 'id' | 'createdAt' | 'updatedAt'>): Promise<ManagedSiteContactInboxBinding>
  updateBinding(bindingId: number, expectedStatus: ManagedSiteContactInboxBinding['status'], patch: Partial<Omit<ManagedSiteContactInboxBinding, 'id' | 'funnelSessionId' | 'email' | 'createdAt' | 'updatedAt'>>): Promise<ManagedSiteContactInboxBinding | null>
  supersedeStatus(sessionId: number, status: 'pending' | 'bound', exceptBindingId?: number): Promise<void>
}

function rowId(result: unknown): number {
  const id = Number((result as { [key: string]: unknown }[] | undefined)?.[0]?.insertId)
  if (!Number.isSafeInteger(id) || id < 1) throw createError({ statusCode: 500, statusMessage: '收信信箱綁定資料無法建立。' })
  return id
}

export function makeManagedSiteContactInboxBindingRepository(database: any): ManagedSiteContactInboxBindingRepository {
  const repository: ManagedSiteContactInboxBindingRepository = {
    async transaction(work) {
      return database.transaction((transaction: any) => work(makeManagedSiteContactInboxBindingRepository(transaction))) as Promise<any>
    },
    async listForSession(sessionId) {
      return database.select().from(managedSiteContactInboxBindings).where(eq(managedSiteContactInboxBindings.funnelSessionId, sessionId)).orderBy(desc(managedSiteContactInboxBindings.id)).limit(200)
    },
    async insertBinding(input) {
      const id = rowId(await database.insert(managedSiteContactInboxBindings).values(input as any))
      const [row] = await database.select().from(managedSiteContactInboxBindings).where(eq(managedSiteContactInboxBindings.id, id)).limit(1)
      if (!row) throw createError({ statusCode: 500, statusMessage: '收信信箱綁定資料無法讀取。' })
      return row
    },
    async updateBinding(bindingId, expectedStatus, patch) {
      const result = await database.update(managedSiteContactInboxBindings).set(patch as any).where(and(eq(managedSiteContactInboxBindings.id, bindingId), eq(managedSiteContactInboxBindings.status, expectedStatus)))
      const affectedRows = Number((result as any)?.[0]?.affectedRows ?? (result as any)?.affectedRows ?? 0)
      if (affectedRows !== 1) return null
      const [row] = await database.select().from(managedSiteContactInboxBindings).where(eq(managedSiteContactInboxBindings.id, bindingId)).limit(1)
      return row || null
    },
    async supersedeStatus(sessionId, status, exceptBindingId) {
      const conditions = [eq(managedSiteContactInboxBindings.funnelSessionId, sessionId), eq(managedSiteContactInboxBindings.status, status)]
      if (exceptBindingId !== undefined) conditions.push(ne(managedSiteContactInboxBindings.id, exceptBindingId))
      await database.update(managedSiteContactInboxBindings).set({ status: 'superseded', codeHash: null, codeExpiresAt: null } as any).where(and(...conditions))
    },
  }
  return repository
}

export function getManagedSiteContactInboxBindingRepository(): ManagedSiteContactInboxBindingRepository {
  const database = getDatabase()
  if (!database) throw createError({ statusCode: 503, statusMessage: '收信信箱綁定服務暫時無法使用。' })
  return makeManagedSiteContactInboxBindingRepository(database)
}

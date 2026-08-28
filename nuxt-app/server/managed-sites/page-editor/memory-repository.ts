import { createError } from 'h3'
import type { AppliedPageOperation, PageDocument, PageEditorRepository, PagePublicationReceipt } from './types'

const scope = (ownerUserId: number, projectId: number) => `${ownerUserId}:${projectId}`
const pageKey = (ownerUserId: number, projectId: number, pageId: string) => `${scope(ownerUserId, projectId)}:${pageId}`
function clone<T>(value: T): T { return structuredClone(value) }

export function createMemoryPageEditorRepository(): PageEditorRepository {
  const pages = new Map<string, PageDocument[]>(); const operations = new Map<string, AppliedPageOperation>(); const receipts = new Map<string, PagePublicationReceipt[]>()
  let transactionTail = Promise.resolve()
  const repository: PageEditorRepository = {
    async transaction<T>(work: (repository: PageEditorRepository) => Promise<T>): Promise<T> { let release!: () => void; const preceding = transactionTail; transactionTail = new Promise<void>(resolve => { release = resolve }); await preceding; try { return await work(repository) } finally { release() } },
    async listPages(ownerUserId, projectId) { return [...pages.entries()].filter(([key]) => key.startsWith(`${scope(ownerUserId, projectId)}:`)).map(([, versions]) => clone(versions.at(-1)!)).sort((a, b) => a.route.localeCompare(b.route)) },
    async findCurrent(ownerUserId, projectId, pageId) { const versions = pages.get(pageKey(ownerUserId, projectId, pageId)); return versions?.length ? clone(versions.at(-1)!) : null },
    async findVersion(ownerUserId, projectId, pageId, version) { const value = pages.get(pageKey(ownerUserId, projectId, pageId))?.find(item => item.version === version); return value ? clone(value) : null },
    async listVersions(ownerUserId, projectId, pageId) { return (pages.get(pageKey(ownerUserId, projectId, pageId)) || []).map(clone).sort((a, b) => b.version - a.version) },
    async insertInitial(ownerUserId, projectId, page) { const key = pageKey(ownerUserId, projectId, page.pageId); if (pages.has(key) || page.version !== 1) throw createError({ statusCode: 409, statusMessage: 'Initial page identity or version collided.' }); pages.set(key, [clone(page)]) },
    async compareAndAppend(ownerUserId, projectId, expectedVersion, page, operation) { const key = pageKey(ownerUserId, projectId, page.pageId); const versions = pages.get(key); if (!versions?.length || versions.at(-1)!.version !== expectedVersion || page.version !== expectedVersion + 1) return false; versions.push(clone(page)); operations.set(`${scope(ownerUserId, projectId)}:${operation.command.idempotencyKey}`, clone(operation)); return true },
    async findOperation(ownerUserId, projectId, idempotencyKey) { const value = operations.get(`${scope(ownerUserId, projectId)}:${idempotencyKey}`); return value ? clone(value) : null },
    async appendPublicationReceipt(ownerUserId, projectId, receipt) { const key = pageKey(ownerUserId, projectId, receipt.pageId); const list = receipts.get(key) || []; const existing = list.find(item => item.receiptFingerprint === receipt.receiptFingerprint); if (existing) return clone(existing); list.push(clone(receipt)); receipts.set(key, list); return clone(receipt) },
    async listPublicationReceipts(ownerUserId, projectId, pageId) { return (receipts.get(pageKey(ownerUserId, projectId, pageId)) || []).map(clone) },
  }
  return repository
}

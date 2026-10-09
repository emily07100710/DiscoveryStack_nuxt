import { and, asc, desc, eq, gt, isNull, lte, or, sql } from 'drizzle-orm'
import { createError } from 'h3'
import { getDatabase } from '../database'
import { contentOperationClients, contentOperationAutopilotPolicies, contentOperationPublicationTargets, contentOperationPublicationAttempts, seoGeoContentJobs, weeklyContentConfigs as configs, weeklyContentSchedulerCursors as schedulerCursors, weeklyContentInvitations as invitations, weeklyContentBindings as bindings, weeklyContentReviewRequests as requests, weeklyContentReviewTests as reviewTests, weeklyContentConsents as consents, weeklyContentOutbox as outbox, weeklyContentWebhookInbox as inbox, contentOperationRuns } from '../database/schema'
import { createContentOperationsRepositoryFromDatabase } from '../content-operations/repository'
import type { ContentOperationClientRow } from '../content-operations/types'
import type { WeeklyConfig, LineBindingInvitation, PrivateLineBinding, WeeklyIdentityBinding, WeeklyReviewRequest, WeeklyConsent, WeeklyOutbox, WeeklyDraft, WeeklyWebhookInbox } from './types'
export type InsertRow<T> = Omit<T, 'id' | 'createdAt' | 'updatedAt'>
export interface WeeklyContentRepository {
  transaction<T>(work: (repository: WeeklyContentRepository) => Promise<T>): Promise<T>
  lockJob(ownerUserId: number, jobId: number): Promise<void>
  findClient(ownerUserId: number, clientId: number, lock?: boolean): Promise<ContentOperationClientRow | null>
  requireClientApproval(ownerUserId: number, clientId: number): Promise<void>
  getConfig(ownerUserId: number, clientId: number, lock?: boolean): Promise<WeeklyConfig | null>
  saveConfig(row: InsertRow<WeeklyConfig>): Promise<WeeklyConfig>
  listConfigs(ownerUserId: number, limit?: number): Promise<WeeklyConfig[]>
  claimSchedulerConfigs(ownerUserId: number, limit?: number): Promise<WeeklyConfig[]>
  getTargetPolicy(ownerUserId: number, clientId: number, targetId: number, policyId: string): Promise<{ target: WeeklyDraft['target']; policy: WeeklyDraft['policy'] } | null>
  findInbox(eventHash: string): Promise<WeeklyWebhookInbox | null>
  insertInbox(row: InsertRow<WeeklyWebhookInbox>): Promise<WeeklyWebhookInbox>
  expireInvitations(ownerUserId: number, clientId: number, now: Date): Promise<void>
  queuePublication(ownerUserId: number, entryId: number, now: Date): Promise<void>
  getDraft(ownerUserId: number, clientId: number, entryId: number, now?: Date): Promise<WeeklyDraft | null>
  insertInvitation(row: InsertRow<LineBindingInvitation>): Promise<LineBindingInvitation>
  findInvitation(tokenHash: string, lock?: boolean): Promise<LineBindingInvitation | null>
  consumeInvitation(id: number, bindingFingerprint: string, eventHash: string, now: Date): Promise<boolean>
  getBinding(ownerUserId: number, clientId: number, lock?: boolean): Promise<PrivateLineBinding | null>
  listActiveIdentityBindingsForLineUser(lineUserId: string, limit?: number): Promise<WeeklyIdentityBinding[]>
  saveBinding(row: InsertRow<PrivateLineBinding>): Promise<PrivateLineBinding>
  revokeBinding(ownerUserId: number, clientId: number, expectedFingerprint: string, revokedFingerprint: string, now: Date): Promise<boolean>
  revokeOpenRequestsForBinding(ownerUserId: number, clientId: number, bindingId: number, bindingFingerprint: string, now: Date): Promise<number>
  lockUnsentOutboxForBinding(ownerUserId: number, clientId: number, bindingId: number): Promise<WeeklyOutbox[]>
  hasBlockingReviewTest(ownerUserId: number, clientId: number, bindingId: number, bindingFingerprint: string, now: Date): Promise<boolean>
  revokePendingReviewTestsForBinding(ownerUserId: number, clientId: number, bindingId: number, bindingFingerprint: string, now: Date): Promise<number>
  cancelUnsentOutboxForBinding(ownerUserId: number, clientId: number, bindingId: number, now: Date): Promise<number>
  getRequest(requestId: string, lock?: boolean): Promise<WeeklyReviewRequest | null>
  findLatestRequestForEntry(ownerUserId: number, clientId: number, entryId: number): Promise<WeeklyReviewRequest|null>
  getOutboxForRequest(requestRowId: number): Promise<WeeklyOutbox|null>
  getRequestByRowId(id: number): Promise<WeeklyReviewRequest | null>
  findRequestByFingerprint(fingerprint: string): Promise<WeeklyReviewRequest | null>
  findActiveRequest(ownerUserId: number, clientId: number, now: Date): Promise<WeeklyReviewRequest | null>
  listApprovedRequests(ownerUserId: number, limit?: number): Promise<WeeklyReviewRequest[]>
  insertRequest(row: InsertRow<WeeklyReviewRequest>): Promise<WeeklyReviewRequest>
  updateRequest(id: number, status: WeeklyReviewRequest['status'], now: Date): Promise<void>
  findConsentByEvent(eventHash: string): Promise<WeeklyConsent | null>
  latestConsent(requestRowId: number): Promise<WeeklyConsent | null>
  insertConsent(row: InsertRow<WeeklyConsent>): Promise<WeeklyConsent>
  hasReservedPublication(ownerUserId: number, jobId: number, draftId: number): Promise<boolean>
  enqueueOutbox(row: InsertRow<WeeklyOutbox>): Promise<WeeklyOutbox>
  claimOutbox(ownerUserId: number, max: number, leaseToken: string, now: Date, clientId?: number): Promise<WeeklyOutbox[]>
  reserveOutboxPayload(id: number, leaseToken: string, payloadFingerprint: string, now: Date): Promise<boolean>
  finishOutbox(id: number, leaseToken: string, now: Date, result: { status: 'sent' | 'retry_wait' | 'failed' | 'cancelled'; providerMessageId?: string; retryEligibleAt?: Date; errorCode?: string }): Promise<boolean>
}
// Database/transaction objects use the same Drizzle boundary as Content Operations.
export class WeeklyWebhookInboxRaceError extends Error { constructor(options: { cause: unknown }) { super('Verified LINE event was committed concurrently.', options); this.name='WeeklyWebhookInboxRaceError' } }
function isWeeklyWebhookInboxDuplicate(error: unknown): boolean {
  let current: unknown=error
  const seen=new Set<unknown>()
  for(let depth=0;depth<8 && current && typeof current==='object' && !seen.has(current);depth++) {
    seen.add(current);const row=current as Record<string,unknown>
    if ((row.code==='ER_DUP_ENTRY' || row.errno===1062) && typeof row.message==='string' && /(?:[.'`]|^)weekly_webhook_event_uq(?:['`]|$)/.test(row.message)) return true
    current=row.cause
  }
  return false
}
function makeRepository(database: any, transactional = false): WeeklyContentRepository {
  const one = async (table: any, predicate: any, lock = false) => { const query = database.select().from(table).where(predicate).limit(1); const [row] = await (lock ? query.for('update') : query); return row || null }
  const insert = async (table: any, row: any) => { const ids = await database.insert(table).values(row).$returningId(); return one(table, eq(table.id, ids[0].id)) }
  const repository: WeeklyContentRepository = {
    transaction: work => transactional ? work(repository) : database.transaction((tx: any) => work(makeRepository(tx, true))),
    async lockJob(owner, job) { if (!await one(seoGeoContentJobs, and(eq(seoGeoContentJobs.ownerUserId, owner), eq(seoGeoContentJobs.id, job)), true)) throw createError({ statusCode: 409, statusMessage: 'Weekly review job changed.' }) },
    findClient: (owner, client, lock) => one(contentOperationClients, and(eq(contentOperationClients.ownerUserId, owner), eq(contentOperationClients.id, client)), lock),
    async requireClientApproval(owner, client) { await database.update(contentOperationClients).set({ requireCustomerApproval: true }).where(and(eq(contentOperationClients.ownerUserId, owner), eq(contentOperationClients.id, client))) },
    getConfig: (owner, client, lock) => one(configs, and(eq(configs.ownerUserId, owner), eq(configs.clientId, client)), lock),
    async saveConfig(row) { await database.insert(configs).values(row).onDuplicateKeyUpdate({ set: row }); return (await repository.getConfig(row.ownerUserId, row.clientId))! },
    listConfigs: (owner, limit = 50) => database.select().from(configs).where(eq(configs.ownerUserId, owner)).orderBy(asc(configs.id)).limit(Math.min(50, Math.max(1, limit))),
    async claimSchedulerConfigs(owner, limit = 10) {
      if (!Number.isSafeInteger(owner) || owner < 1 || !Number.isSafeInteger(limit) || limit < 1 || limit > 10) throw createError({ statusCode: 422, statusMessage: 'Weekly scheduler scope is invalid.' })
      const claim = async (tx: any): Promise<WeeklyConfig[]> => {
        // Insert-first creates the per-owner cursor without ever resetting an existing cursor.
        await tx.insert(schedulerCursors).values({ ownerUserId: owner, afterConfigId: 0 }).onDuplicateKeyUpdate({ set: { ownerUserId: owner } })
        const [cursor] = await tx.select().from(schedulerCursors).where(eq(schedulerCursors.ownerUserId, owner)).limit(1).for('update')
        if (!cursor || cursor.ownerUserId !== owner || !Number.isSafeInteger(cursor.afterConfigId) || cursor.afterConfigId < 0) throw createError({ statusCode: 503, statusMessage: 'Weekly scheduler storage is unavailable.' })
        const selected: WeeklyConfig[] = await tx.select().from(configs).where(and(eq(configs.ownerUserId, owner), eq(configs.status, 'active'), gt(configs.id, cursor.afterConfigId))).orderBy(asc(configs.id)).limit(limit)
        const validPage = (rows: WeeklyConfig[], maximum: number, inRange: (id: number) => boolean): boolean => {
          if (!Array.isArray(rows) || rows.length > maximum) return false
          let previous = 0
          for (const row of rows) {
            if (!row || !Number.isSafeInteger(row.id) || row.id < 1 || !inRange(row.id) || row.id <= previous) return false
            previous = row.id
          }
          return true
        }
        if (!validPage(selected, limit, id => id > cursor.afterConfigId)) throw createError({ statusCode: 503, statusMessage: 'Weekly scheduler storage is unavailable.' })
        if (selected.length < limit) {
          const wrapped: WeeklyConfig[] = await tx.select().from(configs).where(and(eq(configs.ownerUserId, owner), eq(configs.status, 'active'), lte(configs.id, cursor.afterConfigId))).orderBy(asc(configs.id)).limit(limit - selected.length)
          if (!validPage(wrapped, limit - selected.length, id => id <= cursor.afterConfigId)) throw createError({ statusCode: 503, statusMessage: 'Weekly scheduler storage is unavailable.' })
          selected.push(...wrapped)
        }
        const ids = new Set<number>(), clientIds = new Set<number>()
        for (const row of selected) {
          if (!row || row.ownerUserId !== owner || row.status !== 'active' || !Number.isSafeInteger(row.id) || row.id < 1 || !Number.isSafeInteger(row.clientId) || row.clientId < 1 || ids.has(row.id) || clientIds.has(row.clientId)) throw createError({ statusCode: 503, statusMessage: 'Weekly scheduler storage is unavailable.' })
          ids.add(row.id); clientIds.add(row.clientId)
        }
        if (selected.length > limit) throw createError({ statusCode: 503, statusMessage: 'Weekly scheduler storage is unavailable.' })
        const afterConfigId = selected.length ? selected[selected.length - 1]!.id : 0
        await tx.update(schedulerCursors).set({ afterConfigId, updatedAt: new Date() }).where(eq(schedulerCursors.ownerUserId, owner))
        return selected
      }
      return transactional ? claim(database) : database.transaction(claim)
    },
    async getTargetPolicy(owner, clientId, targetId, policyId) {
      const target = await one(contentOperationPublicationTargets, and(eq(contentOperationPublicationTargets.ownerUserId,owner),eq(contentOperationPublicationTargets.clientId,clientId),eq(contentOperationPublicationTargets.id,targetId)))
      if (!target) return null
      const policy = await one(contentOperationAutopilotPolicies, and(eq(contentOperationAutopilotPolicies.ownerUserId,owner),eq(contentOperationAutopilotPolicies.clientId,clientId),eq(contentOperationAutopilotPolicies.publicationTargetId,targetId),eq(contentOperationAutopilotPolicies.policyId,policyId)))
      return { target, policy }
    },
    findInbox: hash => one(inbox, eq(inbox.eventHash,hash)),
    async insertInbox(row) { try { return await insert(inbox,row) } catch (cause) { if (isWeeklyWebhookInboxDuplicate(cause)) throw new WeeklyWebhookInboxRaceError({ cause }); throw cause } },
    async expireInvitations(owner,client,now) { await database.update(invitations).set({ expiresAt: now }).where(and(eq(invitations.ownerUserId,owner),eq(invitations.clientId,client),isNull(invitations.consumedAt))) },
    async queuePublication(owner,entry,now) { await database.update(contentOperationRuns).set({ state:'queued', errorCode:null,errorSummary:null,retryEligibleAt:null,updatedAt:now }).where(and(eq(contentOperationRuns.ownerUserId,owner),eq(contentOperationRuns.entryId,entry),eq(contentOperationRuns.stage,'publication'),eq(contentOperationRuns.state,'blocked'),eq(contentOperationRuns.errorCode,'ATTEMPT_RESERVATION_FAILED'))) },
    async getDraft(owner, clientId, entryId, now=new Date()) {
      const operations = createContentOperationsRepositoryFromDatabase(database)
      const lineage = await operations.resolveWorkspaceEntry(owner, entryId)
      const config = await repository.getConfig(owner, clientId)
      if (!lineage?.job || !lineage.draft || lineage.client.id !== clientId || !config) return null
      const newest = await operations.findLatestOptimizedDraft(owner, lineage.job.id)
      if (!newest || newest.id !== lineage.draft.id) return null
      const target = await one(contentOperationPublicationTargets, and(eq(contentOperationPublicationTargets.ownerUserId, owner), eq(contentOperationPublicationTargets.clientId, clientId), eq(contentOperationPublicationTargets.id, config.publicationTargetId)))
      if (!target) return null
      const policy = await one(contentOperationAutopilotPolicies, and(eq(contentOperationAutopilotPolicies.ownerUserId, owner), eq(contentOperationAutopilotPolicies.clientId, clientId), eq(contentOperationAutopilotPolicies.publicationTargetId, target.id), eq(contentOperationAutopilotPolicies.policyId, config.policyId)))
      const authorization = await operations.findMachineAuthorizationForTarget(owner,entryId,target.id)
      const machineAuthorizationValid = Boolean(authorization && authorization.ownerUserId===owner && authorization.clientId===clientId && authorization.entryId===entryId && authorization.publicationTargetId===target.id && authorization.policyVersion==='governed-autopilot-policy-v4' && ['authorized','executing','published'].includes(authorization.status) && authorization.jobId === lineage.job.id && authorization.draftId === lineage.draft.id && authorization.contentHash === lineage.draft.contentHash && authorization.evidenceSnapshotHash === lineage.entry.evidenceSnapshotHash && authorization.policyId === policy?.policyId && authorization.policyFingerprint === policy?.configurationFingerprint && authorization.qualityStatus === 'passed' && authorization.revokedAt === null)
      const exactMachineAuthorizationValid=machineAuthorizationValid && await (await import('../content-operations/orchestrator')).hasExactMachineAuthorizationForReview({ownerUserId:owner,entryId,targetId:target.id,now,repository:operations})
      return { machineAuthorizationValid:exactMachineAuthorizationValid, client: lineage.client, entryId, entryStatus: lineage.entry.status, jobId: lineage.job.id, draftId: lineage.draft.id, draftVersion: lineage.draft.version, contentType:lineage.entry.contentType,language:lineage.entry.language,title: String(lineage.draft.title || ''), body: String(lineage.draft.body || ''), contentHash: lineage.draft.contentHash, evidenceSnapshotHash: lineage.entry.evidenceSnapshotHash, riskGateStatus: lineage.riskGate?.status || 'missing', target, policy }
    },
    insertInvitation: row => insert(invitations, row),
    findInvitation: (hash, lock) => one(invitations, eq(invitations.tokenHash, hash), lock),
    async consumeInvitation(id, fingerprint, eventHash, now) { const r = await database.update(invitations).set({ consumedAt: now, bindingFingerprint: fingerprint, eventHash }).where(and(eq(invitations.id, id), isNull(invitations.consumedAt), gt(invitations.expiresAt, now))); return Number(r?.[0]?.affectedRows || 0) === 1 },
    getBinding: (owner, client, lock) => one(bindings, and(eq(bindings.ownerUserId, owner), eq(bindings.clientId, client)), lock),
    listActiveIdentityBindingsForLineUser: (lineUserId, limit = 20) => database.select({ binding: bindings, client: contentOperationClients }).from(bindings)
      .innerJoin(contentOperationClients, and(eq(contentOperationClients.id, bindings.clientId), eq(contentOperationClients.ownerUserId, bindings.ownerUserId)))
      .where(and(eq(bindings.lineUserId, lineUserId), eq(bindings.status, 'active'), eq(contentOperationClients.status, 'active')))
      .orderBy(asc(bindings.id)).limit(Math.max(1, Math.min(20, limit))),
    async saveBinding(row) {
      // Redeeming a fresh invitation for the SAME person can still rotate the
      // binding fingerprint. Apply the same fence as explicit replacement.
      const existing=await repository.getBinding(row.ownerUserId,row.clientId,true)
      if(existing&&existing.bindingFingerprint!==row.bindingFingerprint){
        const {guardArticleWorkspacesForRebind}=await import('../article-workbench/repository')
        await guardArticleWorkspacesForRebind(database,{ownerUserId:row.ownerUserId,clientId:row.clientId,bindingId:existing.id,now:new Date()})
      }
      await database.insert(bindings).values(row).onDuplicateKeyUpdate({set:row})
      return (await repository.getBinding(row.ownerUserId,row.clientId))!
    },
    async revokeBinding(owner, client, expectedFingerprint, revokedFingerprint, now) {
      const result=await database.update(bindings).set({status:'revoked',bindingFingerprint:revokedFingerprint,updatedAt:now}).where(and(eq(bindings.ownerUserId,owner),eq(bindings.clientId,client),eq(bindings.status,'active'),eq(bindings.bindingFingerprint,expectedFingerprint)))
      return Number(result?.[0]?.affectedRows || 0)===1
    },
    async revokeOpenRequestsForBinding(owner,client,bindingId,bindingFingerprint,now) {
      const result=await database.update(requests).set({status:'revoked',updatedAt:now}).where(and(eq(requests.ownerUserId,owner),eq(requests.clientId,client),eq(requests.bindingId,bindingId),eq(requests.bindingFingerprint,bindingFingerprint),or(eq(requests.status,'pending'),eq(requests.status,'approved'))))
      return Number(result?.[0]?.affectedRows || 0)
    },
    lockUnsentOutboxForBinding: (owner,client,bindingId) => database.select().from(outbox).where(and(eq(outbox.ownerUserId,owner),eq(outbox.clientId,client),eq(outbox.bindingId,bindingId),or(eq(outbox.status,'queued'),eq(outbox.status,'retry_wait'),eq(outbox.status,'processing')))).orderBy(asc(outbox.id)).for('update'),
    async hasBlockingReviewTest(owner,client,bindingId,bindingFingerprint,_now) {
      // Lock every undecided test in this binding lineage. A provider push can
      // outlive the review TTL, so `processing` blocks replacement regardless
      // of expiry; queued/retry rows are fenced by these locks and revoked next.
      const rows=await database.select({notificationStatus:reviewTests.notificationStatus}).from(reviewTests).where(and(eq(reviewTests.ownerUserId,owner),eq(reviewTests.clientId,client),eq(reviewTests.bindingId,bindingId),eq(reviewTests.bindingFingerprint,bindingFingerprint),eq(reviewTests.status,'pending'))).orderBy(asc(reviewTests.id)).for('update')
      return rows.some((row:{notificationStatus:string})=>row.notificationStatus==='processing')
    },
    async revokePendingReviewTestsForBinding(owner,client,bindingId,bindingFingerprint,now) {
      // This transaction already holds the client and current binding locks.
      // Fence formal workspaces before replacing the recipient; an in-flight
      // external preparation, notification or publication must finish first.
      const {guardArticleWorkspacesForRebind}=await import('../article-workbench/repository')
      await guardArticleWorkspacesForRebind(database,{ownerUserId:owner,clientId:client,bindingId,now})
      const lineage=and(eq(reviewTests.ownerUserId,owner),eq(reviewTests.clientId,client),eq(reviewTests.bindingId,bindingId),eq(reviewTests.bindingFingerprint,bindingFingerprint),eq(reviewTests.status,'pending'))
      await database.update(reviewTests).set({notificationStatus:'cancelled',notificationLeaseToken:null,notificationLeaseExpiresAt:null,notificationRetryEligibleAt:null,notificationErrorCode:'line_recipient_replaced',updatedAt:now}).where(and(lineage,or(eq(reviewTests.notificationStatus,'queued'),eq(reviewTests.notificationStatus,'retry_wait'))))
      const result=await database.update(reviewTests).set({status:'revoked',updatedAt:now}).where(lineage)
      return Number(result?.[0]?.affectedRows||0)
    },
    async cancelUnsentOutboxForBinding(owner,client,bindingId,now) {
      const result=await database.update(outbox).set({status:'cancelled',leaseToken:null,leaseExpiresAt:null,retryEligibleAt:null,errorCode:'line_recipient_replaced',updatedAt:now}).where(and(eq(outbox.ownerUserId,owner),eq(outbox.clientId,client),eq(outbox.bindingId,bindingId),or(eq(outbox.status,'queued'),eq(outbox.status,'retry_wait'))))
      return Number(result?.[0]?.affectedRows || 0)
    },
    getRequest: (id, lock) => one(requests, eq(requests.requestId, id), lock),
    async findLatestRequestForEntry(owner,client,entry) { const [row]=await database.select().from(requests).where(and(eq(requests.ownerUserId,owner),eq(requests.clientId,client),eq(requests.entryId,entry))).orderBy(desc(requests.id)).limit(1);return row || null },
    getOutboxForRequest: id=>one(outbox,eq(outbox.requestRowId,id)),
    getRequestByRowId: id => one(requests, eq(requests.id, id)),
    findRequestByFingerprint: hash => one(requests, eq(requests.requestFingerprint, hash)),
    async findActiveRequest(owner,client,now) { const [row]=await database.select().from(requests).where(and(eq(requests.ownerUserId,owner),eq(requests.clientId,client),or(eq(requests.status,'pending'),eq(requests.status,'approved')),gt(requests.expiresAt,now))).orderBy(desc(requests.id)).limit(1); return row || null },
    listApprovedRequests: (owner, limit = 50) => database.select().from(requests).where(and(eq(requests.ownerUserId, owner), eq(requests.status, 'approved'))).orderBy(asc(requests.id)).limit(Math.max(1, Math.min(50, limit))),
    insertRequest: row => insert(requests, row),
    async updateRequest(id, status, now) { await database.update(requests).set({ status, updatedAt: now }).where(eq(requests.id, id)) },
    findConsentByEvent: hash => one(consents, eq(consents.eventHash, hash)),
    async latestConsent(id) { const [row] = await database.select().from(consents).where(eq(consents.requestRowId, id)).orderBy(desc(consents.id)).limit(1); return row || null },
    insertConsent: row => insert(consents, row),
    async hasReservedPublication(owner, job, draft) {
      const lineage = await database.select({ id: contentOperationPublicationAttempts.id }).from(contentOperationPublicationAttempts).innerJoin(requests, and(eq(requests.entryId, contentOperationPublicationAttempts.entryId), eq(requests.ownerUserId, owner), eq(requests.jobId, job), eq(requests.draftId, draft))).where(and(eq(contentOperationPublicationAttempts.ownerUserId, owner), eq(contentOperationPublicationAttempts.mode, 'execute'), or(eq(contentOperationPublicationAttempts.status, 'planned'), eq(contentOperationPublicationAttempts.status, 'delivered'), eq(contentOperationPublicationAttempts.status, 'draft_received')))).limit(1)
      return lineage.length > 0
    },
    enqueueOutbox: row => insert(outbox, row),
    async claimOutbox(owner, maximum, token, now, clientId) {
      if (!token || token.length > 96) throw createError({ statusCode: 422, statusMessage: 'Invalid weekly outbox lease.' })
      if (clientId !== undefined && (!Number.isSafeInteger(clientId) || clientId < 1)) throw createError({ statusCode: 422, statusMessage: 'Invalid weekly outbox client.' })
      const claim = async (txDatabase: any) => {
        const dueState = or(eq(outbox.status, 'queued'), and(eq(outbox.status, 'retry_wait'), lte(outbox.retryEligibleAt, now)), and(eq(outbox.status, 'processing'), lte(outbox.leaseExpiresAt, now)))
        const due = clientId === undefined
          ? and(eq(outbox.ownerUserId, owner), dueState)
          : and(eq(outbox.ownerUserId, owner), eq(outbox.clientId, clientId), dueState)
        const candidates: WeeklyOutbox[] = await txDatabase.select().from(outbox).where(due).orderBy(asc(outbox.id)).limit(Math.max(1, Math.min(10, maximum)))
        const claimed: WeeklyOutbox[] = []
        for (const row of candidates) {
          const changed = await txDatabase.update(outbox).set({ status: 'processing', attemptNumber: row.attemptNumber + 1, leaseToken: token, leaseExpiresAt: new Date(now.getTime() + 120000), updatedAt: now }).where(and(eq(outbox.id, row.id), due, eq(outbox.attemptNumber, row.attemptNumber)))
          if (Number(changed?.[0]?.affectedRows || 0) === 1) { const current = await makeRepository(txDatabase,true).getRequestByRowId(row.requestRowId); if (current) claimed.push({ ...row, status: 'processing', attemptNumber: row.attemptNumber + 1, leaseToken: token, leaseExpiresAt: new Date(now.getTime() + 120000) }) }
        }
        return claimed
      }
      return transactional ? claim(database) : database.transaction(claim)
    },
    async reserveOutboxPayload(id, token, fingerprint, now) {
      if (!/^[a-f0-9]{64}$/.test(fingerprint) || !token || token.length > 96) return false
      const result = await database.update(outbox).set({ payloadFingerprint: fingerprint, firstAttemptAt: sql`COALESCE(${outbox.firstAttemptAt}, ${now})`, updatedAt: now }).where(and(eq(outbox.id,id),eq(outbox.status,'processing'),eq(outbox.leaseToken,token),gt(outbox.leaseExpiresAt,now),or(isNull(outbox.payloadFingerprint),eq(outbox.payloadFingerprint,fingerprint))))
      // MySQL changedRows can be zero for an exact replay; the follow-up read is still fenced by the same lease and hash.
      if (Number(result?.[0]?.affectedRows || 0) === 1) return true
      return Boolean(await one(outbox,and(eq(outbox.id,id),eq(outbox.status,'processing'),eq(outbox.leaseToken,token),gt(outbox.leaseExpiresAt,now),eq(outbox.payloadFingerprint,fingerprint))))
    },
    async finishOutbox(id, token, now, result) {
      const r = await database.update(outbox).set({ status: result.status, leaseToken: null, leaseExpiresAt: null, sentAt: result.status === 'sent' ? now : null, providerMessageId: result.providerMessageId || null, retryEligibleAt: result.retryEligibleAt || null, errorCode: result.errorCode || null, updatedAt: now }).where(and(eq(outbox.id, id), eq(outbox.status, 'processing'), eq(outbox.leaseToken, token),gt(outbox.leaseExpiresAt,now)))
      return Number(r?.[0]?.affectedRows || 0) === 1
    },
  }
  return repository
}
export function createWeeklyContentRepository(): WeeklyContentRepository { const db = getDatabase(); if (!db) throw createError({ statusCode: 503, statusMessage: 'Weekly content storage is not configured.' }); return makeRepository(db) }
export function createWeeklyContentRepositoryFromDatabase(database: unknown): WeeklyContentRepository { return makeRepository(database) }

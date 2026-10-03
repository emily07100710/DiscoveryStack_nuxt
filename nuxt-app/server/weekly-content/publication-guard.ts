import { and, desc, eq, sql } from 'drizzle-orm'
import { createError } from 'h3'
import { contentOperationClients, contentOperationCalendarEntries, contentOperationPublicationTargets, contentOperationAutopilotPolicies, seoGeoContentDrafts, weeklyContentConfigs, weeklyContentBindings, weeklyContentReviewRequests, weeklyContentConsents } from '../database/schema'
import type { WeeklyConfig, PrivateLineBinding, WeeklyReviewRequest, WeeklyConsent, WeeklyDraft } from './types'
export function weeklyRequestMatchesCurrent(request: WeeklyReviewRequest, config: WeeklyConfig, binding: PrivateLineBinding, draft: WeeklyDraft, now: Date): boolean {
  return config.ownerUserId===request.ownerUserId && config.clientId===request.clientId && config.status === 'active' && config.cadenceDays === 7 && draft.client.status === 'active' && draft.client.requireCustomerApproval === true
    && binding.status === 'active' && binding.id === request.bindingId && binding.ownerUserId === request.ownerUserId && binding.clientId === request.clientId && binding.bindingFingerprint === request.bindingFingerprint
    && request.ownerUserId === draft.client.ownerUserId && request.clientId === draft.client.id && request.entryId === draft.entryId && request.jobId === draft.jobId
    && request.contentType===draft.contentType && request.language===draft.language && request.draftId === draft.draftId && request.draftVersion === draft.draftVersion && request.contentHash === draft.contentHash && request.evidenceSnapshotHash === draft.evidenceSnapshotHash
    && request.configurationFingerprint === config.configurationFingerprint && request.publicationTargetId === config.publicationTargetId
    && draft.target.status === 'active' && draft.target.executionEnabled && draft.target.id === request.publicationTargetId && draft.target.ownerUserId === request.ownerUserId && draft.target.clientId === request.clientId && draft.target.configurationFingerprint === request.targetConfigurationFingerprint
    && draft.policy?.status === 'enabled' && draft.policy.policyVersion==='governed-autopilot-policy-v4' && draft.policy.authorizedByOwnerUserId===request.ownerUserId && draft.policy.cadenceDays===7 && draft.policy.ownerUserId === request.ownerUserId && draft.policy.clientId === request.clientId && draft.policy.publicationTargetId === request.publicationTargetId
    && draft.policy.policyId === config.policyId && draft.policy.policyId === request.policyId && draft.policy.configurationFingerprint === config.policyConfigurationFingerprint && draft.policy.configurationFingerprint === request.policyConfigurationFingerprint
    && draft.policy.expiresAt.getTime() > now.getTime() && draft.policy.revokedAt === null && draft.riskGateStatus === 'passed' && request.expiresAt.getTime() > now.getTime()
}
export function weeklyConsentAllowsPublication(request: WeeklyReviewRequest, consent: WeeklyConsent | null, config: WeeklyConfig, binding: PrivateLineBinding, draft: WeeklyDraft, now: Date): boolean {
  return request.status === 'approved' && consent?.decision === 'approved' && consent.requestRowId === request.id && consent.ownerUserId === request.ownerUserId && consent.clientId === request.clientId && weeklyRequestMatchesCurrent(request, config, binding, draft, now)
}
/** Called within the common publication reservation transaction, after the existing job lock. */
export async function assertWeeklyPublicationConsent(transaction: any, input: { ownerUserId: number; clientId: number; entryId: number; jobId: number; draftId: number; targetId: number; contentHash: string; evidenceSnapshotHash: string; startedAt: Date }, currentV4MachineAuthority?: boolean, currentTime: () => Date = () => new Date()): Promise<void> {
  const fail = () => { throw createError({ statusCode: 409, statusMessage: 'WEEKLY_CUSTOMER_APPROVAL_REQUIRED' }) }
  const [client] = await transaction.select().from(contentOperationClients).where(and(eq(contentOperationClients.ownerUserId,input.ownerUserId),eq(contentOperationClients.id,input.clientId))).for('update').limit(1)
  if (!client) return fail()
  // Legacy clients never consult weekly tables; a disabled feature cannot bypass an opted-in client.
  if (client.requireCustomerApproval !== true) return
  if (process.env.NUXT_WEEKLY_CONTENT_APPROVAL_ENABLED !== 'true') return fail()
  if (currentV4MachineAuthority !== undefined && currentV4MachineAuthority !== true) return fail()
  const [config] = await transaction.select().from(weeklyContentConfigs).where(and(eq(weeklyContentConfigs.ownerUserId,input.ownerUserId),eq(weeklyContentConfigs.clientId,input.clientId))).for('update').limit(1)
  if (!config || config.status !== 'active' || config.publicationTargetId !== input.targetId) return fail()
  const [binding] = await transaction.select().from(weeklyContentBindings).where(and(eq(weeklyContentBindings.ownerUserId,input.ownerUserId),eq(weeklyContentBindings.clientId,input.clientId))).for('update').limit(1)
  const [request] = await transaction.select().from(weeklyContentReviewRequests).where(and(eq(weeklyContentReviewRequests.ownerUserId,input.ownerUserId),eq(weeklyContentReviewRequests.clientId,input.clientId),eq(weeklyContentReviewRequests.entryId,input.entryId),eq(weeklyContentReviewRequests.jobId,input.jobId),eq(weeklyContentReviewRequests.draftId,input.draftId),eq(weeklyContentReviewRequests.contentHash,input.contentHash),eq(weeklyContentReviewRequests.evidenceSnapshotHash,input.evidenceSnapshotHash),eq(weeklyContentReviewRequests.publicationTargetId,input.targetId))).orderBy(desc(weeklyContentReviewRequests.id)).for('update').limit(1)
  const [target] = await transaction.select().from(contentOperationPublicationTargets).where(and(eq(contentOperationPublicationTargets.ownerUserId,input.ownerUserId),eq(contentOperationPublicationTargets.clientId,input.clientId),eq(contentOperationPublicationTargets.id,input.targetId))).for('update').limit(1)
  const [policy] = await transaction.select().from(contentOperationAutopilotPolicies).where(and(eq(contentOperationAutopilotPolicies.ownerUserId,input.ownerUserId),eq(contentOperationAutopilotPolicies.clientId,input.clientId),eq(contentOperationAutopilotPolicies.publicationTargetId,input.targetId),eq(contentOperationAutopilotPolicies.policyId,config.policyId))).for('update').limit(1)
  const [entry] = await transaction.select().from(contentOperationCalendarEntries).where(and(eq(contentOperationCalendarEntries.ownerUserId,input.ownerUserId),eq(contentOperationCalendarEntries.id,input.entryId))).limit(1)
  const [draft] = await transaction.select().from(seoGeoContentDrafts).where(and(eq(seoGeoContentDrafts.jobId,input.jobId),sql`JSON_UNQUOTE(JSON_EXTRACT(${seoGeoContentDrafts.provenance}, '$.stage')) = 'optimized'`)).orderBy(desc(seoGeoContentDrafts.version),desc(seoGeoContentDrafts.id)).limit(1)
  if (!request || !binding || !target || !entry || !draft || !policy || entry.draftId !== draft.id || draft.id !== input.draftId || entry.contentHash !== input.contentHash || entry.evidenceSnapshotHash !== input.evidenceSnapshotHash) return fail()
  const [consent] = await transaction.select().from(weeklyContentConsents).where(eq(weeklyContentConsents.requestRowId,request.id)).orderBy(desc(weeklyContentConsents.id)).limit(1)
  const current: WeeklyDraft = { client, entryId: entry.id, entryStatus: entry.status, jobId: input.jobId, draftId: draft.id, draftVersion: draft.version,contentType:entry.contentType,language:entry.language,title: draft.title, body: draft.body, contentHash: draft.contentHash, evidenceSnapshotHash: input.evidenceSnapshotHash, riskGateStatus: 'passed', machineAuthorizationValid: true, target, policy }
  // The original reservation has just checked the exact current risk gate under this same job lock.
  const verifiedAt=currentTime()
  if (!Number.isFinite(verifiedAt.getTime()) || !weeklyConsentAllowsPublication(request,consent || null,config,binding,current,verifiedAt)) return fail()
}

/** Before a provider is reached, required clients must still be explicitly active and privately bound. */
export async function assertWeeklyWorkflowActive(database:any,input:{ownerUserId:number;clientId:number;now:Date}):Promise<void> {
  const fail=()=>{throw createError({statusCode:409,statusMessage:'WEEKLY_CONFIG_NOT_ACTIVE'})}
  if(process.env.NUXT_WEEKLY_CONTENT_APPROVAL_ENABLED!=='true')return fail()
  const [client]=await database.select().from(contentOperationClients).where(and(eq(contentOperationClients.ownerUserId,input.ownerUserId),eq(contentOperationClients.id,input.clientId))).limit(1)
  const [config]=await database.select().from(weeklyContentConfigs).where(and(eq(weeklyContentConfigs.ownerUserId,input.ownerUserId),eq(weeklyContentConfigs.clientId,input.clientId))).limit(1)
  const [binding]=await database.select().from(weeklyContentBindings).where(and(eq(weeklyContentBindings.ownerUserId,input.ownerUserId),eq(weeklyContentBindings.clientId,input.clientId))).limit(1)
  if(!client || client.status!=='active' || !config || config.status!=='active' || config.cadenceDays!==7 || binding?.status!=='active')return fail()
  const [target]=await database.select().from(contentOperationPublicationTargets).where(and(eq(contentOperationPublicationTargets.ownerUserId,input.ownerUserId),eq(contentOperationPublicationTargets.clientId,input.clientId),eq(contentOperationPublicationTargets.id,config.publicationTargetId))).limit(1)
  const [policy]=await database.select().from(contentOperationAutopilotPolicies).where(and(eq(contentOperationAutopilotPolicies.ownerUserId,input.ownerUserId),eq(contentOperationAutopilotPolicies.clientId,input.clientId),eq(contentOperationAutopilotPolicies.publicationTargetId,config.publicationTargetId),eq(contentOperationAutopilotPolicies.policyId,config.policyId))).limit(1)
  if(!target || target.status!=='active' || !target.executionEnabled || !policy || policy.status!=='enabled' || policy.revokedAt!==null || policy.policyVersion!=='governed-autopilot-policy-v4' || policy.configurationFingerprint!==config.policyConfigurationFingerprint || policy.expiresAt.getTime()<=input.now.getTime())return fail()
}

import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { createError } from 'h3'
import { WeeklyWebhookInboxRaceError } from './repository'
import type { WeeklyContentRepository } from './repository'
import type { WeeklyConfig, WeeklyReviewRequest, WeeklyOwnerConfig, WeeklyDecision, WeeklyPublicReview } from './types'
import { weeklyRequestMatchesCurrent, weeklyConsentAllowsPublication } from './publication-guard'
export type WeeklyContentDependencies = { repository: WeeklyContentRepository; featureEnabled: boolean; tokenKey: string; now?: Date }
export const LINE_IDENTITY_BINDING_PURPOSE = 'identity_binding' as const
export const REPLACE_LINE_RECIPIENT_CONFIRMATION = 'REPLACE_LINE_RECIPIENT' as const
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
export const lineBindingFingerprint = (ownerUserId: number, clientId: number, lineUserId: string, invitationHash: string) => hash(JSON.stringify({owner:ownerUserId,client:clientId,recipient:lineUserId,invitation:invitationHash}))
const error = (code: string, statusCode = 409): never => { throw createError({ statusCode, statusMessage: code }) }
const bounded = (value: unknown, max = 128): string => { if (typeof value !== 'string' || !value || value.length > max) return error('WEEKLY_INPUT_INVALID',422); return value }
const opaque = (prefix: string) => prefix + randomBytes(24).toString('base64url')
function enabled(deps: WeeklyContentDependencies) { if (!deps.featureEnabled) error('WEEKLY_APPROVAL_DISABLED',503); if (Buffer.byteLength(deps.tokenKey || '') < 32) error('WEEKLY_REVIEW_TOKEN_KEY_NOT_CONFIGURED',503) }
const clock = (deps: WeeklyContentDependencies) => deps.now || new Date()
const exactHash = (raw: string, expected: string) => /^[a-f0-9]{64}$/.test(expected) && timingSafeEqual(Buffer.from(hash(raw)),Buffer.from(expected))
export function deriveReviewTokens(request: WeeklyReviewRequest, tokenKey: string): { readToken: string; actionToken: string } {
  if (Buffer.byteLength(tokenKey || '') < 32) return error('WEEKLY_REVIEW_TOKEN_KEY_NOT_CONFIGURED',503)
  const token = (purpose: string) => createHmac('sha256',tokenKey).update(`${purpose}:${request.requestId}`).digest('base64url')
  const readToken = token('weekly-read-v1'); const actionToken = token('weekly-action-v1')
  if (!exactHash(readToken,request.readTokenHash) || !exactHash(actionToken,request.actionTokenHash)) return error('WEEKLY_REVIEW_TOKEN_KEY_CHANGED')
  return { readToken, actionToken }
}
export function projectWeeklyOwnerConfig(config: WeeklyConfig, lineBound: boolean): WeeklyOwnerConfig { return { clientId:config.clientId,status:config.status,publicationTargetId:config.publicationTargetId,cadenceDays:config.cadenceDays,reviewTtlHours:config.reviewTtlHours,lineBound,requireCustomerApproval:true,configurationFingerprint:config.configurationFingerprint } }
// One-way owner choice: protect every publishing path before an automatic generation policy can be created.
export async function requireWeeklyClientApproval(input:{ownerUserId:number;clientId:number},deps:WeeklyContentDependencies){
  enabled(deps)
  return deps.repository.transaction(async repo=>{
    const client=await repo.findClient(input.ownerUserId,input.clientId,true)
    if(!client || client.status!=='active')return error('WEEKLY_CLIENT_NOT_AVAILABLE',404)
    await repo.requireClientApproval(input.ownerUserId,input.clientId)
    return {clientId:input.clientId,requireCustomerApproval:true as const}
  })
}
export async function activateWeeklyReviewConfig(input: { ownerUserId: number; clientId: number; publicationTargetId: number; policyId: string; reviewTtlHours?: number; idempotencyKey: string }, deps: WeeklyContentDependencies) {
  enabled(deps); const now=clock(deps); bounded(input.idempotencyKey); bounded(input.policyId,96)
  const ttl=input.reviewTtlHours ?? 72
  if (!Number.isSafeInteger(ttl) || ttl<1 || ttl>168) return error('WEEKLY_REVIEW_TTL_INVALID',422)
  return deps.repository.transaction(async repo => {
    const client=await repo.findClient(input.ownerUserId,input.clientId,true)
    if (!client || client.status !== 'active') return error('WEEKLY_CLIENT_NOT_AVAILABLE',404)
    const scope=await repo.getTargetPolicy(input.ownerUserId,input.clientId,input.publicationTargetId,input.policyId)
    if (!scope || scope.target.status !== 'active' || !scope.target.executionEnabled || !Array.isArray(scope.target.allowedContentTypes) || !scope.target.allowedContentTypes.includes('article') || !scope.policy || scope.policy.status !== 'enabled' || scope.policy.requireApprovedForDelivery===true || scope.policy.policyVersion !== 'governed-autopilot-policy-v4' || scope.policy.authorizedByOwnerUserId !== input.ownerUserId || scope.policy.cadenceDays !== 7 || scope.policy.expiresAt.getTime()<=now.getTime()) return error('WEEKLY_OWNER_POLICY_NOT_READY')
    const existing=await repo.getConfig(input.ownerUserId,input.clientId,true)
    if (existing?.idempotencyKey===input.idempotencyKey) {
      if (existing.publicationTargetId!==input.publicationTargetId || existing.policyId!==input.policyId || existing.reviewTtlHours!==ttl || existing.policyConfigurationFingerprint!==scope.policy.configurationFingerprint || existing.status!=='active') return error('WEEKLY_CONFIG_IDEMPOTENCY_COLLISION')
      const binding=await repo.getBinding(input.ownerUserId,input.clientId)
      return { config:projectWeeklyOwnerConfig(existing,binding?.status==='active'),replayed:true }
    }
    const configurationFingerprint=hash(JSON.stringify({ owner:input.ownerUserId,client:input.clientId,target:input.publicationTargetId,policy:scope.policy.configurationFingerprint,ttl,key:input.idempotencyKey }))
    const row=await repo.saveConfig({ ownerUserId:input.ownerUserId,clientId:input.clientId,publicationTargetId:input.publicationTargetId,policyId:input.policyId,policyConfigurationFingerprint:scope.policy.configurationFingerprint,configurationFingerprint,status:'active',cadenceDays:7,reviewTtlHours:ttl,idempotencyKey:input.idempotencyKey })
    await repo.requireClientApproval(input.ownerUserId,input.clientId)
    const binding=await repo.getBinding(input.ownerUserId,input.clientId)
    return { config:projectWeeklyOwnerConfig(row,binding?.status==='active'),replayed:false }
  })
}
export async function pauseWeeklyReviewConfig(input: { ownerUserId: number; clientId: number; status: 'paused'|'revoked' }, deps: WeeklyContentDependencies) {
  enabled(deps)
  if (!['paused','revoked'].includes(input.status)) return error('WEEKLY_CONFIG_STATUS_INVALID',422)
  return deps.repository.transaction(async repo => {
    if (!await repo.findClient(input.ownerUserId,input.clientId,true)) return error('WEEKLY_CLIENT_NOT_AVAILABLE',404)
    const config=await repo.getConfig(input.ownerUserId,input.clientId,true); if (!config) return error('WEEKLY_CONFIG_NOT_FOUND',404)
    const { id:_id,createdAt:_created,updatedAt:_updated,...row }=config
    const updated=await repo.saveConfig({ ...row,status:input.status })
    return projectWeeklyOwnerConfig(updated,(await repo.getBinding(input.ownerUserId,input.clientId))?.status==='active')
  })
}
/** A wli_ invite establishes company/LINE identity only; it never enables article review or publishing. */
export async function issueLineBindingInvite(input: { ownerUserId: number; clientId: number }, deps: WeeklyContentDependencies) {
  enabled(deps); const invitationToken=opaque('wli_')
  return deps.repository.transaction(async repo => {
    const client=await repo.findClient(input.ownerUserId,input.clientId,true)
    if (!client || client.ownerUserId!==input.ownerUserId || client.id!==input.clientId || client.status!=='active') return error('WEEKLY_CLIENT_NOT_AVAILABLE',404)
    const now=clock(deps), expiresAt=new Date(now.getTime()+10*60*1000)
    await repo.expireInvitations(input.ownerUserId,input.clientId,now)
    await repo.insertInvitation({ ownerUserId:input.ownerUserId,clientId:input.clientId,tokenHash:hash(invitationToken),expiresAt,consumedAt:null,bindingFingerprint:null,eventHash:null })
    return { purpose:LINE_IDENTITY_BINDING_PURPOSE, invitationToken, expiresAt:expiresAt.toISOString() }
  })
}
/** Explicit owner-only recipient replacement. The prior private LINE id is retained only in storage and never projected. */
export async function replaceLineBinding(input: { ownerUserId: number; clientId: number; confirmation: typeof REPLACE_LINE_RECIPIENT_CONFIRMATION }, deps: WeeklyContentDependencies) {
  if(input.confirmation!==REPLACE_LINE_RECIPIENT_CONFIRMATION)return error('WEEKLY_LINE_REPLACEMENT_CONFIRMATION_REQUIRED',422)
  enabled(deps)
  return deps.repository.transaction(async repo=>{
    const client=await repo.findClient(input.ownerUserId,input.clientId,true)
    if(!client || client.ownerUserId!==input.ownerUserId || client.id!==input.clientId || client.status!=='active')return error('WEEKLY_CLIENT_NOT_AVAILABLE',404)
    const now=clock(deps)
    if(!Number.isFinite(now.getTime()))return error('WEEKLY_CLOCK_INVALID',422)
    const invitationToken=opaque('wli_'),tokenHash=hash(invitationToken),expiresAt=new Date(now.getTime()+10*60*1000)
    // Keep the same client -> invitation -> binding lock order used by LIFF confirmation.
    // If no replaceable binding exists, the transaction rolls the invitation expiry back.
    await repo.expireInvitations(input.ownerUserId,input.clientId,now)
    const current=await repo.getBinding(input.ownerUserId,input.clientId,true)
    if(!current || current.ownerUserId!==input.ownerUserId || current.clientId!==input.clientId || current.status!=='active')return error('WEEKLY_ACTIVE_LINE_BINDING_REQUIRED')
    const previousFingerprint=current.bindingFingerprint
    const activeRequest=await repo.findActiveRequest(input.ownerUserId,input.clientId,now)
    if(activeRequest && await repo.hasReservedPublication(input.ownerUserId,activeRequest.jobId,activeRequest.draftId))return error('WEEKLY_PUBLICATION_ALREADY_RESERVED')
    if(await repo.hasBlockingReviewTest(input.ownerUserId,input.clientId,current.id,previousFingerprint,now))return error('WEEKLY_REVIEW_TEST_DELIVERY_IN_PROGRESS')
    // Lock every unsent notification before revoking. A claimed delivery is not safe to
    // replace; queued/retry rows stay fenced until this transaction cancels them.
    const unsent=await repo.lockUnsentOutboxForBinding(input.ownerUserId,input.clientId,current.id)
    if(unsent.some(row=>row.status==='processing'))return error('WEEKLY_LINE_DELIVERY_IN_PROGRESS')
    const revokedFingerprint=hash(JSON.stringify({purpose:'weekly-line-binding-revocation-v1',owner:input.ownerUserId,client:input.clientId,previous:previousFingerprint,invitation:tokenHash,at:now.toISOString()}))
    if(!await repo.revokeBinding(input.ownerUserId,input.clientId,previousFingerprint,revokedFingerprint,now))return error('WEEKLY_LINE_BINDING_CHANGED')
    await repo.revokeOpenRequestsForBinding(input.ownerUserId,input.clientId,current.id,previousFingerprint,now)
    await repo.revokePendingReviewTestsForBinding(input.ownerUserId,input.clientId,current.id,previousFingerprint,now)
    await repo.cancelUnsentOutboxForBinding(input.ownerUserId,input.clientId,current.id,now)
    await repo.insertInvitation({ownerUserId:input.ownerUserId,clientId:input.clientId,tokenHash,expiresAt,consumedAt:null,bindingFingerprint:null,eventHash:null})
    return {purpose:LINE_IDENTITY_BINDING_PURPOSE,invitationToken,expiresAt:expiresAt.toISOString()}
  })
}
async function replayInbox(repo: WeeklyContentRepository, eventHash: string, fingerprint: string) {
  const prior=await repo.findInbox(eventHash)
  if (!prior) return null
  if (prior.payloadFingerprint!==fingerprint || prior.status!=='processed') return error('WEEKLY_LINE_EVENT_COLLISION')
  return { status:'replayed' as const,resultCode:prior.resultCode }
}
// A unique-event collision aborts its transaction. Only the exact committed winner can be replayed in a new read.
async function eventTransaction<T>(deps: WeeklyContentDependencies, eventHash: string, fingerprint: string, work: (repo: WeeklyContentRepository) => Promise<T>): Promise<T | { status: 'replayed'; resultCode: string }> {
  try { return await deps.repository.transaction(work) } catch (cause) {
    if (!(cause instanceof WeeklyWebhookInboxRaceError)) throw cause
    const winner=await replayInbox(deps.repository,eventHash,fingerprint)
    if (!winner) return error('WEEKLY_LINE_EVENT_RACE_UNRESOLVED')
    return winner
  }
}
export type VerifiedLineIdentity = { lineUserId: string; webhookEventId: string; semanticFingerprint: string }
function verifiedInput(input: VerifiedLineIdentity) { bounded(input.lineUserId);bounded(input.webhookEventId,256); if (!/^[a-f0-9]{64}$/.test(input.semanticFingerprint)) error('WEEKLY_LINE_EVENT_FINGERPRINT_INVALID',422); return hash(input.webhookEventId) }
export async function claimWeeklyLineInteraction(input: VerifiedLineIdentity, deps: WeeklyContentDependencies) {
  enabled(deps); const eventHash=verifiedInput(input)
  return eventTransaction(deps,eventHash,input.semanticFingerprint,async repo => {
    const replay=await replayInbox(repo,eventHash,input.semanticFingerprint); if(replay)return replay
    await repo.insertInbox({eventHash,payloadFingerprint:input.semanticFingerprint,status:'processed',resultCode:'LINE_INTERACTION_HANDLED'})
    return {status:'handled' as const,resultCode:'LINE_INTERACTION_HANDLED'}
  })
}
export async function claimLineBindingInvite(input: VerifiedLineIdentity & { invitationToken: string }, deps: WeeklyContentDependencies) {
  enabled(deps);const eventHash=verifiedInput(input);bounded(input.invitationToken,80)
  return eventTransaction(deps,eventHash,input.semanticFingerprint,async repo => {
    const replay=await replayInbox(repo,eventHash,input.semanticFingerprint);if(replay)return replay
    const candidate=await repo.findInvitation(hash(input.invitationToken));if(!candidate)return error('WEEKLY_INVITATION_INVALID',404)
    const client=await repo.findClient(candidate.ownerUserId,candidate.clientId,true)
    if (!client || client.ownerUserId!==candidate.ownerUserId || client.id!==candidate.clientId || client.status!=='active')return error('WEEKLY_CLIENT_NOT_AVAILABLE',404)
    const invite=await repo.findInvitation(hash(input.invitationToken),true)
    if(!invite || invite.ownerUserId!==client.ownerUserId || invite.clientId!==client.id)return error('WEEKLY_INVITATION_EXPIRED')
    // Invitation lineage makes every successful (re)binding distinct, even when the same
    // LINE account is bound again. Old review consent therefore cannot revive after replacement.
    const fingerprint=lineBindingFingerprint(invite.ownerUserId,invite.clientId,input.lineUserId,invite.tokenHash)
    if(invite.consumedAt && invite.bindingFingerprint!==fingerprint)return error('WEEKLY_INVITATION_ALREADY_USED')
    const wasConsumed=Boolean(invite.consumedAt)
    const current=await repo.getBinding(invite.ownerUserId,invite.clientId,true)
    const now=clock(deps)
    if(invite.expiresAt.getTime()<=now.getTime())return error('WEEKLY_INVITATION_EXPIRED')
    if(current?.status==='active' && current.lineUserId!==input.lineUserId)return error('WEEKLY_RECIPIENT_ALREADY_BOUND')
    if(!wasConsumed && !await repo.consumeInvitation(invite.id,fingerprint,eventHash,now))return error('WEEKLY_INVITATION_CLAIM_CONFLICT')
    if(wasConsumed && (!current || current.status!=='active' || current.bindingFingerprint!==fingerprint))return error('WEEKLY_INVITATION_ALREADY_USED')
    if(!wasConsumed)await repo.saveBinding({ ownerUserId:invite.ownerUserId,clientId:invite.clientId,lineUserId:input.lineUserId,bindingFingerprint:fingerprint,status:'active' })
    await repo.insertInbox({ eventHash,payloadFingerprint:input.semanticFingerprint,status:'processed',resultCode:'LINE_BOUND' })
    return { status:wasConsumed?'replayed' as const:'bound' as const,resultCode:'LINE_BOUND' }
  })
}
type RequestInput={ownerUserId:number;clientId:number;entryId:number}
const requestResult=(request:WeeklyReviewRequest,replayed:boolean)=>({request:{requestId:request.requestId,status:request.status,expiresAt:request.expiresAt.toISOString()},replayed})
async function requestReview(input:RequestInput,deps:WeeklyContentDependencies,reopenKey?:string) {
  enabled(deps);const now=clock(deps)
  if(reopenKey!==undefined)bounded(reopenKey)
  const initial=await deps.repository.getDraft(input.ownerUserId,input.clientId,input.entryId,now);if(!initial)return error('WEEKLY_DRAFT_NOT_AVAILABLE')
  return deps.repository.transaction(async repo=>{
    await repo.lockJob(input.ownerUserId,initial.jobId)
    await repo.findClient(input.ownerUserId,input.clientId,true)
    const config=await repo.getConfig(input.ownerUserId,input.clientId,true),binding=await repo.getBinding(input.ownerUserId,input.clientId,true),draft=await repo.getDraft(input.ownerUserId,input.clientId,input.entryId,now)
    if(!config || !binding || !draft || config.status!=='active' || binding.status!=='active' || draft.entryStatus!=='ready_to_publish' || !draft.machineAuthorizationValid || draft.riskGateStatus!=='passed' || draft.contentType!=='article' || draft.client.requireCustomerApproval!==true)return error('WEEKLY_MACHINE_REVIEW_NOT_READY')
    const snapshot={ownerUserId:input.ownerUserId,clientId:input.clientId,entryId:input.entryId,jobId:draft.jobId,draftId:draft.draftId,draftVersion:draft.draftVersion,contentType:draft.contentType,language:draft.language,contentHash:draft.contentHash,evidenceSnapshotHash:draft.evidenceSnapshotHash,publicationTargetId:draft.target.id,targetConfigurationFingerprint:draft.target.configurationFingerprint,policyId:config.policyId,policyConfigurationFingerprint:config.policyConfigurationFingerprint,configurationFingerprint:config.configurationFingerprint,bindingId:binding.id,bindingFingerprint:binding.bindingFingerprint}
    const requestFingerprint=hash(JSON.stringify(reopenKey===undefined?snapshot:{...snapshot,reopenIdempotencyKey:reopenKey}))
    const repeated=await repo.findRequestByFingerprint(requestFingerprint)
    const active=await repo.findActiveRequest(input.ownerUserId,input.clientId,now)
    if(reopenKey===undefined) {
      if(active) {
        if(weeklyRequestMatchesCurrent(active,config,binding,draft,now))return requestResult(active,true)
        return error('WEEKLY_CLIENT_ALREADY_HAS_OPEN_REVIEW')
      }
      if(repeated) {
        if(repeated.expiresAt.getTime()<=now.getTime())return error('WEEKLY_REVIEW_EXPIRED')
        if(repeated.status==='changes_requested')return error('WEEKLY_REVIEW_CHANGES_REQUESTED')
        if(repeated.status==='revoked')return error('WEEKLY_REVIEW_REVOKED')
        return requestResult(repeated,true)
      }
    } else {
      if(repeated)return requestResult(repeated,true)
      const old=await repo.findLatestRequestForEntry(input.ownerUserId,input.clientId,input.entryId)
      if(!old || old.status==='changes_requested' || old.status==='revoked')return error('WEEKLY_REVIEW_CANNOT_REOPEN')
      if(old.jobId!==draft.jobId || old.draftId!==draft.draftId || old.draftVersion!==draft.draftVersion || old.contentHash!==draft.contentHash || old.evidenceSnapshotHash!==draft.evidenceSnapshotHash || old.language!==draft.language || old.contentType!==draft.contentType)return error('WEEKLY_REOPEN_DRAFT_CHANGED')
      if(active && active.id!==old.id)return error('WEEKLY_CLIENT_ALREADY_HAS_OPEN_REVIEW')
      const priorOutbox=await repo.getOutboxForRequest(old.id)
      const expired=old.expiresAt.getTime()<=now.getTime()
      const failedNotification=old.status==='pending' && ['failed','cancelled'].includes(priorOutbox?.status || '')
      if(!expired && !failedNotification)return error('WEEKLY_REVIEW_CANNOT_REOPEN')
      if(await repo.hasReservedPublication(input.ownerUserId,draft.jobId,draft.draftId))return error('WEEKLY_PUBLICATION_ALREADY_RESERVED')
      await repo.updateRequest(old.id,'revoked',now)
    }
    const requestId=opaque('wcr_'),readToken=createHmac('sha256',deps.tokenKey).update(`weekly-read-v1:${requestId}`).digest('base64url'),actionToken=createHmac('sha256',deps.tokenKey).update(`weekly-action-v1:${requestId}`).digest('base64url')
    const request=await repo.insertRequest({...snapshot,requestId,requestFingerprint,readTokenHash:hash(readToken),actionTokenHash:hash(actionToken),status:'pending',expiresAt:new Date(now.getTime()+config.reviewTtlHours*3600000)})
    if(!weeklyRequestMatchesCurrent(request,config,binding,draft,now))return error('WEEKLY_REQUEST_LINEAGE_CHANGED')
    await repo.enqueueOutbox({ownerUserId:input.ownerUserId,clientId:input.clientId,requestRowId:request.id,bindingId:binding.id,status:'queued',attemptNumber:0,leaseToken:null,leaseExpiresAt:null,retryEligibleAt:null,providerMessageId:null,sentAt:null,errorCode:null,payloadFingerprint:null,firstAttemptAt:null})
    return requestResult(request,false)
  })
}
export function createReviewRequest(input:RequestInput,deps:WeeklyContentDependencies) {return requestReview(input,deps)}
/** Explicit owner action only. Old decisions remain append-only and a new opaque review never inherits consent. */
export function reopenReviewRequest(input:RequestInput & {idempotencyKey:string},deps:WeeklyContentDependencies) {return requestReview(input,deps,input.idempotencyKey)}
async function exactRequestContext(repo: WeeklyContentRepository, request: WeeklyReviewRequest, time: Date | (() => Date)) {
  const getNow=()=>typeof time==='function'?time():time
  const config=await repo.getConfig(request.ownerUserId,request.clientId,true);const binding=await repo.getBinding(request.ownerUserId,request.clientId,true);const draft=await repo.getDraft(request.ownerUserId,request.clientId,request.entryId,getNow())
  const now=getNow()
  if(!config || !binding || !draft || !weeklyRequestMatchesCurrent(request,config,binding,draft,now) || !draft.machineAuthorizationValid || !['ready_to_publish','publishing','delivered'].includes(draft.entryStatus))return error('WEEKLY_REQUEST_EXPIRED_OR_CHANGED')
  return { config,binding,draft }
}
export async function getReviewByReadToken(input: { requestId: string; readToken: string }, deps: WeeklyContentDependencies): Promise<WeeklyPublicReview> {
  enabled(deps); bounded(input.requestId,64);bounded(input.readToken,80); const now=clock(deps)
  const request=await deps.repository.getRequest(input.requestId)
  if(!request || !exactHash(input.readToken,request.readTokenHash))return error('WEEKLY_REVIEW_NOT_FOUND',404)
  deriveReviewTokens(request,deps.tokenKey)
  // No transaction/lease/consent/outbox write: opening the preview can never approve a draft.
  const config=await deps.repository.getConfig(request.ownerUserId,request.clientId);const binding=await deps.repository.getBinding(request.ownerUserId,request.clientId);const draft=await deps.repository.getDraft(request.ownerUserId,request.clientId,request.entryId,now)
  if(!config || !binding || !draft || !weeklyRequestMatchesCurrent(request,config,binding,draft,now) || request.status==='revoked')return error('WEEKLY_REQUEST_EXPIRED_OR_CHANGED')
  return { requestId:request.requestId,title:draft.title,body:draft.body,status:request.status,expiresAt:request.expiresAt.toISOString(),contentHash:request.contentHash,canRespond:request.status==='pending' }
}
export const getDraftByReadToken=getReviewByReadToken
export async function reviewFromVerifiedLine(input: VerifiedLineIdentity & { requestId: string; actionToken: string; decision: WeeklyDecision }, deps: WeeklyContentDependencies) {
  enabled(deps);const eventHash=verifiedInput(input);bounded(input.requestId,64);bounded(input.actionToken,80)
  if(!['approved','changes_requested'].includes(input.decision))return error('WEEKLY_DECISION_INVALID',422)
  const initial=await deps.repository.getRequest(input.requestId);if(!initial)return error('WEEKLY_REVIEW_NOT_FOUND',404)
  return eventTransaction(deps,eventHash,input.semanticFingerprint,async repo => {
    await repo.lockJob(initial.ownerUserId,initial.jobId)
    await repo.findClient(initial.ownerUserId,initial.clientId,true)
    const replay=await replayInbox(repo,eventHash,input.semanticFingerprint);if(replay)return replay
    const request=await repo.getRequest(input.requestId,true);if(!request || !exactHash(input.actionToken,request.actionTokenHash))return error('WEEKLY_ACTION_TOKEN_INVALID')
    deriveReviewTokens(request,deps.tokenKey)
    const { config,binding,draft }=await exactRequestContext(repo,request,()=>clock(deps))
    if(binding.lineUserId!==input.lineUserId)return error('WEEKLY_LINE_SENDER_MISMATCH',403)
    if(request.status==='revoked')return error('WEEKLY_REVIEW_REVOKED')
    if(request.status!== 'pending' && request.status===input.decision) {
      await repo.insertInbox({ eventHash,payloadFingerprint:input.semanticFingerprint,status:'processed',resultCode:'DECISION_REPLAYED' })
      return { status:'replayed' as const,resultCode:'DECISION_REPLAYED' }
    }
    // Customers may withdraw approval before the shared job-lock reservation. A requested revision needs a new exact draft/review.
    if(request.status!=='pending' && !(request.status==='approved' && input.decision==='changes_requested'))return error('WEEKLY_DECISION_ALREADY_FINAL')
    if(await repo.hasReservedPublication(request.ownerUserId,request.jobId,request.draftId))return error('WEEKLY_PUBLICATION_ALREADY_RESERVED')
    const now=clock(deps)
    if(!weeklyRequestMatchesCurrent(request,config,binding,draft,now))return error('WEEKLY_REQUEST_EXPIRED_OR_CHANGED')
    const actorFingerprint=hash(input.lineUserId)
    await repo.insertConsent({ ownerUserId:request.ownerUserId,clientId:request.clientId,requestRowId:request.id,decision:input.decision,eventHash,actorFingerprint,consentFingerprint:hash(JSON.stringify({ request:request.requestFingerprint,decision:input.decision,eventHash,actorFingerprint })) })
    await repo.updateRequest(request.id,input.decision,now)
    if(input.decision==='approved')await repo.queuePublication(request.ownerUserId,request.entryId,now)
    await repo.insertInbox({ eventHash,payloadFingerprint:input.semanticFingerprint,status:'processed',resultCode:input.decision==='approved'?'CUSTOMER_APPROVED':'CUSTOMER_CHANGES_REQUESTED' })
    return { status:input.decision,resultCode:input.decision==='approved'?'CUSTOMER_APPROVED':'CUSTOMER_CHANGES_REQUESTED' }
  })
}
export async function getApprovedReviewForPromotion(input: { ownerUserId: number; requestId: string }, deps: WeeklyContentDependencies) {
  enabled(deps);const now=clock(deps);const request=await deps.repository.getRequest(input.requestId)
  if(!request || request.ownerUserId!==input.ownerUserId)return error('WEEKLY_REVIEW_NOT_FOUND',404)
  const { config,binding,draft }=await exactRequestContext(deps.repository,request,now);const consent=await deps.repository.latestConsent(request.id)
  if(!weeklyConsentAllowsPublication(request,consent,config,binding,draft,now))return error('WEEKLY_CUSTOMER_APPROVAL_REQUIRED')
  return { ownerUserId:request.ownerUserId,clientId:request.clientId,entryId:request.entryId,publicationTargetId:request.publicationTargetId,policyId:request.policyId }
}

import {createHash,randomBytes,randomUUID} from 'node:crypto'
import {createError} from 'h3'
import type {ContentOperationClientRow} from '../content-operations/types'
import type {PrivateLineBinding} from '../weekly-content/types'
import {articleCanonicalJson,articleDocumentHash,articleMediaManifestHash,articleMediaIds,validateArticleDocument,validateArticleMedia} from './document'
import type {ArticleWorkbenchRepository,ArticleWorkspaceRow,ArticleWorkspaceInsert,ArticleMediaRow} from './repository'
import {ARTICLE_CUSTOMER_CONFIRMATION,ARTICLE_OWNER_CONFIRMATION,ARTICLE_SOURCE_LABEL,ARTICLE_WORKSPACE_ID,type ArticleActor,type ArticleAuthority,type ArticleDocument,type ArticleIdentity,type ArticleMediaManifest,type ArticleNotifyInput,type ArticleNotifyResult,type ArticlePrepareInput,type ArticlePrepareResult,type ArticlePublishInput,type ArticlePublishResult,type ArticleTarget,type ArticleWorkspaceDto} from './types'

export interface ArticleWorkbenchDependencies {
  repository:ArticleWorkbenchRepository
  enabled:boolean
  /** Trusted server configuration selects one exact authorised customer target. */
  resolveTarget:(input:{ownerUserId:number;client:ContentOperationClientRow})=>Promise<ArticleTarget|null>|ArticleTarget|null
  prepare:(input:ArticlePrepareInput)=>Promise<ArticlePrepareResult>
  notify:(input:ArticleNotifyInput)=>Promise<ArticleNotifyResult>
  publish:(input:ArticlePublishInput)=>Promise<ArticlePublishResult>
  now?:Date
}
const TTL=7*24*60*60*1000,MAX_ATTEMPTS=3,LEASE_MS=120_000
const hash=(value:unknown)=>createHash('sha256').update(typeof value==='string'?value:articleCanonicalJson(value)).digest('hex')
const fail=(code:string,statusCode=409):never=>{throw createError({statusCode,statusMessage:code})}
const now=(deps:ArticleWorkbenchDependencies)=>{const value=deps.now||new Date();if(!Number.isFinite(value.getTime()))return fail('ARTICLE_CLOCK_INVALID',503);return value}
function feature(deps:ArticleWorkbenchDependencies){if(!deps.enabled)return fail('ARTICLE_WORKBENCH_DISABLED',503)}
function positive(value:number){if(!Number.isSafeInteger(value)||value<1)return fail('ARTICLE_INPUT_INVALID',422)}
function workspaceId(value:string){if(!ARTICLE_WORKSPACE_ID.test(value))return fail('ARTICLE_WORKSPACE_NOT_AVAILABLE',404)}
function key(value:string){if(typeof value!=='string'||!/^[A-Za-z0-9._:-]{8,128}$/u.test(value))return fail('ARTICLE_INPUT_INVALID',422);return value}
function note(value:string){if(typeof value!=='string'||!value.trim()||value.length>4000||/[<>\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value))return fail('ARTICLE_FEEDBACK_INVALID',422);return value.replace(/\r\n?/gu,'\n').trim()}
function dateString(value:string){const parsed=new Date(value);if(!Number.isFinite(parsed.getTime())||parsed.toISOString()!==value)return fail('ARTICLE_AUTHORITY_CHANGED');return parsed}
function authority(row:ArticleWorkspaceRow):ArticleAuthority{
  const value=row.authority as ArticleAuthority
  return validateAuthority(value,row)
}
function validateAuthority(value:ArticleAuthority,row:ArticleWorkspaceRow):ArticleAuthority{
  if(!value||value.purpose!=='owner_prepared_article_v1'||value.ownerUserId!==row.ownerUserId||value.clientId!==row.clientId||value.bindingId!==row.bindingId||value.bindingFingerprint!==row.bindingFingerprint||value.authorityFingerprint!==row.authorityFingerprint)return fail('ARTICLE_AUTHORITY_CHANGED')
  const {authorityFingerprint,...snapshot}=value
  if(hash(snapshot)!==authorityFingerprint||dateString(value.expiresAt).getTime()!==row.expiresAt.getTime()||dateString(value.expiresAt).getTime()-dateString(value.authorizedAt).getTime()!==TTL)return fail('ARTICLE_AUTHORITY_CHANGED')
  return value
}
function target(value:ArticleTarget|null,client:ContentOperationClientRow):ArticleTarget{
  if(!value||typeof value.targetId!=='string'||!/^[A-Za-z0-9._:-]{1,160}$/u.test(value.targetId)||typeof value.ownerScopeKey!=='string'||!/^[A-Za-z0-9._:-]{1,160}$/u.test(value.ownerScopeKey)||!/^[a-f0-9]{64}$/u.test(value.configurationFingerprint)||!/^[a-f0-9]{64}$/u.test(value.credentialFingerprint))return fail('ARTICLE_TARGET_NOT_CONFIGURED',503)
  let origin:string;try{const url=new URL(value.targetOrigin);if(url.protocol!=='https:'||url.username||url.password||url.pathname!=='/'||url.search||url.hash)throw new Error();origin=url.origin}catch{return fail('ARTICLE_TARGET_NOT_CONFIGURED',503)}
  if(origin!=='https://doalignment.com'||client.canonicalSiteOrigin!==origin)return fail('ARTICLE_TARGET_NOT_AUTHORIZED',403)
  return {...value,targetOrigin:origin}
}
function manifest(rows:ArticleMediaRow[]):ArticleMediaManifest[]{return rows.map(row=>validateArticleMedia({id:row.mediaId,sha256:row.sha256,version:row.version,mimeType:row.mimeType as ArticleMediaManifest['mimeType'],size:row.size,width:row.width,height:row.height,url:row.url}))}
function actorFingerprint(actor:ArticleActor):string{return hash(actor.kind==='owner'?`owner:${actor.ownerUserId}`:`line:${actor.identity.channelId}:${actor.identity.lineUserId}`)}
function actorValid(actor:ArticleActor,binding:PrivateLineBinding,row:ArticleWorkspaceRow,at:Date){
  if(actor.kind==='owner'){if(actor.ownerUserId!==row.ownerUserId)return fail('ARTICLE_WORKSPACE_NOT_AVAILABLE',404)}
  else if(!/^U[a-f0-9]{32}$/u.test(actor.identity.lineUserId)||!/^[0-9]{8,15}$/u.test(actor.identity.channelId)||!Number.isSafeInteger(actor.identity.expiresAtSeconds)||actor.identity.expiresAtSeconds<=Math.floor(at.getTime()/1000)||binding.lineUserId!==actor.identity.lineUserId)return fail('ARTICLE_CUSTOMER_NOT_AUTHORIZED',403)
}
type LockedContext={row:ArticleWorkspaceRow;client:ContentOperationClientRow;binding:PrivateLineBinding;media:ArticleMediaManifest[];authority:ArticleAuthority;target:ArticleTarget}
/** Every operation locks client -> binding -> workspace in the existing replacement order. */
async function locked(repo:ArticleWorkbenchRepository,initial:ArticleWorkspaceRow,actor:ArticleActor|undefined,deps:ArticleWorkbenchDependencies,requireUnexpired=true):Promise<LockedContext>{
  const client=await repo.findClient(initial.ownerUserId,initial.clientId,true)
  const binding=await repo.getBinding(initial.ownerUserId,initial.clientId,true)
  const row=await repo.getWorkspace(initial.workspaceId,true),at=now(deps)
  if(!row||!client||client.status!=='active'||client.ownerUserId!==row.ownerUserId||client.id!==row.clientId||!binding||binding.status!=='active'||binding.id!==row.bindingId||binding.bindingFingerprint!==row.bindingFingerprint||binding.clientId!==row.clientId||binding.ownerUserId!==row.ownerUserId||row.sourceLabel!==ARTICLE_SOURCE_LABEL||row.status==='revoked')return fail('ARTICLE_WORKSPACE_CHANGED')
  if(actor)actorValid(actor,binding,row,at)
  if(requireUnexpired&&row.expiresAt.getTime()<=at.getTime())return fail('ARTICLE_WORKSPACE_EXPIRED')
  const currentTarget=target(await deps.resolveTarget({ownerUserId:row.ownerUserId,client}),client),snapshot=authority(row)
  if(currentTarget.targetId!==snapshot.targetId||currentTarget.targetOrigin!==snapshot.targetOrigin||currentTarget.ownerScopeKey!==snapshot.ownerScopeKey||currentTarget.configurationFingerprint!==snapshot.configurationFingerprint||currentTarget.credentialFingerprint!==snapshot.credentialFingerprint)return fail('ARTICLE_TARGET_CHANGED')
  const media=manifest(await repo.listMedia(row.id)),document=validateArticleDocument(row.document)
  if(articleDocumentHash(document,media)!==row.documentHash)return fail('ARTICLE_DOCUMENT_CHANGED')
  return {row,client,binding,media,authority:snapshot,target:currentTarget}
}
function editable(row:ArticleWorkspaceRow){if(!['editing','changes_requested'].includes(row.status)||row.approvedAt||row.approvedVersion||row.approvalFingerprint||row.preparationStatus!=='ready'||!row.remotePostId||row.remotePostVersion!==1)return fail('ARTICLE_VERSION_LOCKED')}
async function dto(repo:ArticleWorkbenchRepository,context:LockedContext,deps:ArticleWorkbenchDependencies):Promise<ArticleWorkspaceDto>{
  const row=context.row,isEditable=['editing','changes_requested'].includes(row.status)&&!row.approvedAt&&row.preparationStatus==='ready'&&row.expiresAt.getTime()>now(deps).getTime()
  return {workspaceId:row.workspaceId,version:row.version,documentHash:row.documentHash,document:validateArticleDocument(row.document),status:row.status,sourceLabel:ARTICLE_SOURCE_LABEL,expiresAt:row.expiresAt.toISOString(),createdAt:row.createdAt.toISOString(),approvedAt:row.approvedAt?.toISOString()||null,company:{displayName:context.client.displayName,canonicalSiteOrigin:context.client.canonicalSiteOrigin},media:context.media,feedback:(await repo.listFeedback(row.id)).map(item=>({note:item.note,version:item.version,createdAt:item.createdAt.toISOString()})),publicationUrl:row.publicationUrl,notificationStatus:row.notificationStatus,preparationStatus:row.preparationStatus,publicationErrorCode:row.publicationErrorCode,canEdit:isEditable,canApprove:isEditable}
}
async function initialRow(id:string,deps:ArticleWorkbenchDependencies){feature(deps);workspaceId(id);const row=await deps.repository.getWorkspace(id);if(!row)return fail('ARTICLE_WORKSPACE_NOT_AVAILABLE',404);return row}
function version(value:number,row:ArticleWorkspaceRow){positive(value);if(value!==row.version)return fail('ARTICLE_VERSION_CHANGED')}
function retryDelay(at:Date,attempt:number){return new Date(at.getTime()+Math.min(30_000*2**Math.max(0,attempt-1),5*60_000))}
function due(status:string,retryAt:Date|null,leaseAt:Date|null,at:Date){return status==='queued'||status==='retry_wait'&&!!retryAt&&retryAt.getTime()<=at.getTime()||status==='processing'&&!!leaseAt&&leaseAt.getTime()<=at.getTime()}
function safeError(value:string){return /^[a-zA-Z0-9_:-]{1,80}$/u.test(value)?value:'article_provider_unavailable'}

export async function getArticleWorkspace(input:{workspaceId:string;actor:ArticleActor},deps:ArticleWorkbenchDependencies){
  const initial=await initialRow(input.workspaceId,deps)
  return deps.repository.transaction(async repo=>{const context=await locked(repo,initial,input.actor,deps,false);if(input.actor.kind==='customer'&&context.row.preparationStatus!=='ready')return fail('ARTICLE_PREPARATION_PENDING',503);return {workspace:await dto(repo,context,deps),replayed:false}})
}
export async function listArticleWorkspaces(input:{ownerUserId:number;clientId:number},deps:ArticleWorkbenchDependencies){
  feature(deps);positive(input.ownerUserId);positive(input.clientId)
  const client=await deps.repository.findClient(input.ownerUserId,input.clientId)
  if(!client||client.status!=='active')return fail('ARTICLE_CLIENT_NOT_AVAILABLE',404)
  // This is owner-only; invalid/rebound/expired mandates appear locked instead of hiding history.
  const workspaces:ArticleWorkspaceDto[]=[]
  for(const row of await deps.repository.listWorkspaces(input.ownerUserId,input.clientId)){
    const media=manifest(await deps.repository.listMedia(row.id));let canEdit=false
    try{await deps.repository.transaction(async repo=>{const current=await locked(repo,row,{kind:'owner',ownerUserId:input.ownerUserId},deps);canEdit=['editing','changes_requested'].includes(current.row.status)&&!current.row.approvedAt})}catch{}
    workspaces.push({workspaceId:row.workspaceId,version:row.version,documentHash:row.documentHash,document:validateArticleDocument(row.document),status:row.status,sourceLabel:ARTICLE_SOURCE_LABEL,expiresAt:row.expiresAt.toISOString(),createdAt:row.createdAt.toISOString(),approvedAt:row.approvedAt?.toISOString()||null,company:{displayName:client.displayName,canonicalSiteOrigin:client.canonicalSiteOrigin},media,feedback:(await deps.repository.listFeedback(row.id)).map(item=>({note:item.note,version:item.version,createdAt:item.createdAt.toISOString()})),publicationUrl:row.publicationUrl,notificationStatus:row.notificationStatus,preparationStatus:row.preparationStatus,publicationErrorCode:row.publicationErrorCode,canEdit,canApprove:canEdit})
  }
  return {workspaces}
}

export async function createAndSendArticleWorkspace(input:{ownerUserId:number;clientId:number;document:unknown;confirmation:typeof ARTICLE_OWNER_CONFIRMATION;idempotencyKey:string},deps:ArticleWorkbenchDependencies){
  feature(deps);positive(input.ownerUserId);positive(input.clientId);const idempotencyKey=key(input.idempotencyKey),document=validateArticleDocument(input.document,true)
  if(input.confirmation!==ARTICLE_OWNER_CONFIRMATION)return fail('ARTICLE_OWNER_CONFIRMATION_REQUIRED',422)
  if(articleMediaIds(document).length)return fail('ARTICLE_INITIAL_MEDIA_NOT_ALLOWED',422)
  const contentHash=articleDocumentHash(document,[])
  const prepared=await deps.repository.transaction(async repo=>{
    const client=await repo.findClient(input.ownerUserId,input.clientId,true),binding=await repo.getBinding(input.ownerUserId,input.clientId,true),at=now(deps)
    if(!client||client.status!=='active'||client.ownerUserId!==input.ownerUserId||client.id!==input.clientId||!binding||binding.status!=='active'||binding.ownerUserId!==input.ownerUserId||binding.clientId!==input.clientId)return fail('ARTICLE_BINDING_NOT_AVAILABLE')
    const currentTarget=target(await deps.resolveTarget({ownerUserId:input.ownerUserId,client}),client)
    const requestFingerprint=hash({purpose:'owner-manual-article-create-v1',ownerUserId:input.ownerUserId,clientId:input.clientId,bindingId:binding.id,bindingFingerprint:binding.bindingFingerprint,target:currentTarget,documentHash:contentHash,idempotencyKey})
    const existing=await repo.findOwnerKey(input.ownerUserId,input.clientId,idempotencyKey,true)
    if(existing){if(existing.ownerRequestFingerprint!==requestFingerprint)return fail('ARTICLE_IDEMPOTENCY_COLLISION');await locked(repo,existing,{kind:'owner',ownerUserId:input.ownerUserId},deps);return {row:existing,replayed:true}}
    const snapshot={purpose:'owner_prepared_article_v1' as const,...currentTarget,ownerUserId:input.ownerUserId,clientId:input.clientId,bindingId:binding.id,bindingFingerprint:binding.bindingFingerprint,authorizedAt:at.toISOString(),expiresAt:new Date(at.getTime()+TTL).toISOString()}
    const mandate:ArticleAuthority={...snapshot,authorityFingerprint:hash(snapshot)},id=`aw_${randomBytes(24).toString('base64url')}`
    const row:ArticleWorkspaceInsert={workspaceId:id,ownerUserId:input.ownerUserId,clientId:input.clientId,bindingId:binding.id,bindingFingerprint:binding.bindingFingerprint,sourceLabel:ARTICLE_SOURCE_LABEL,authority:mandate,authorityFingerprint:mandate.authorityFingerprint,document,documentHash:contentHash,version:1,status:'preparing',remotePostId:null,remotePostVersion:null,preparationStatus:'queued',preparationAttemptCount:0,preparationLeaseToken:null,preparationLeaseExpiresAt:null,preparationRetryEligibleAt:null,preparationRetryKey:randomUUID(),preparationPayloadFingerprint:null,preparationErrorCode:null,ownerIdempotencyKey:idempotencyKey,ownerRequestFingerprint:requestFingerprint,approvedVersion:null,approvedDocumentHash:null,approvedMediaManifestHash:null,approvalFingerprint:null,approvedActorFingerprint:null,approvedAt:null,notificationVersion:1,notificationStatus:'queued',notificationAttemptCount:0,notificationLeaseToken:null,notificationLeaseExpiresAt:null,notificationRetryEligibleAt:null,notificationRetryKey:randomUUID(),notificationPayloadFingerprint:null,notificationProviderMessageId:null,notificationErrorCode:null,publicationAttemptCount:0,publicationLeaseToken:null,publicationLeaseExpiresAt:null,publicationRetryEligibleAt:null,publicationRetryKey:randomUUID(),publicationPayloadFingerprint:null,publicationErrorCode:null,publicationUrl:null,publicationProviderPostId:null,publishedAt:null,expiresAt:new Date(at.getTime()+TTL)}
    const saved=await repo.insertWorkspace(row)
    await repo.insertRevision({workspaceRowId:saved.id,version:1,document,documentHash:contentHash,mediaManifest:[],actorKind:'owner',actorFingerprint:hash(`owner:${input.ownerUserId}`)})
    return {row:saved,replayed:false}
  })
  await prepareArticleWorkspace(prepared.row.workspaceId,deps)
  await notifyArticleWorkspace(prepared.row.workspaceId,deps)
  const result=await getArticleWorkspace({workspaceId:prepared.row.workspaceId,actor:{kind:'owner',ownerUserId:input.ownerUserId}},deps)
  return {...result,replayed:prepared.replayed}
}

export async function prepareArticleWorkspace(id:string,deps:ArticleWorkbenchDependencies){
  const initial=await initialRow(id,deps),lease=randomUUID()
  const claimed=await deps.repository.transaction(async repo=>{
    const context=await locked(repo,initial,undefined,deps),row=context.row,at=now(deps)
    if(row.preparationStatus==='ready'||row.preparationStatus==='failed'||row.status!=='preparing'||row.preparationAttemptCount>=MAX_ATTEMPTS||!due(row.preparationStatus,row.preparationRetryEligibleAt,row.preparationLeaseExpiresAt,at))return null
    const payload:ArticlePrepareInput={workspaceId:id,documentHash:row.documentHash,document:validateArticleDocument(row.document,true),media:[],authority:context.authority,retryKey:row.preparationRetryKey},fingerprint=hash(payload)
    if(row.preparationPayloadFingerprint&&row.preparationPayloadFingerprint!==fingerprint)return fail('ARTICLE_PREPARATION_PAYLOAD_CHANGED')
    const attempt=row.preparationAttemptCount+1
    await repo.updateWorkspace(row.id,{preparationStatus:'processing',preparationAttemptCount:attempt,preparationLeaseToken:lease,preparationLeaseExpiresAt:new Date(at.getTime()+LEASE_MS),preparationRetryEligibleAt:null,preparationPayloadFingerprint:fingerprint,updatedAt:at})
    return {payload,fingerprint,attempt}
  })
  if(!claimed)return
  let result:ArticlePrepareResult|null=null
  try{result=await deps.prepare(claimed.payload)}catch{}
  await deps.repository.transaction(async repo=>{
    const context=await locked(repo,initial,undefined,deps),row=context.row,at=now(deps)
    if(row.preparationStatus!=='processing'||row.preparationLeaseToken!==lease||row.preparationPayloadFingerprint!==claimed.fingerprint||!row.preparationLeaseExpiresAt||row.preparationLeaseExpiresAt.getTime()<=at.getTime())return fail('ARTICLE_PREPARATION_OUTCOME_UNKNOWN',503)
    if(result&&typeof result.postId==='string'&&/^[A-Za-z0-9_-]{1,128}$/u.test(result.postId)&&result.postVersion===1)await repo.updateWorkspace(row.id,{status:'editing',preparationStatus:'ready',remotePostId:result.postId,remotePostVersion:1,preparationLeaseToken:null,preparationLeaseExpiresAt:null,preparationErrorCode:null,updatedAt:at})
    else await repo.updateWorkspace(row.id,{preparationStatus:claimed.attempt<MAX_ATTEMPTS?'retry_wait':'failed',preparationLeaseToken:null,preparationLeaseExpiresAt:null,preparationRetryEligibleAt:claimed.attempt<MAX_ATTEMPTS?retryDelay(at,claimed.attempt):null,preparationErrorCode:'article_preparation_outcome_unknown',updatedAt:at})
  })
}
export async function notifyArticleWorkspace(id:string,deps:ArticleWorkbenchDependencies){
  const initial=await initialRow(id,deps),lease=randomUUID()
  const claimed=await deps.repository.transaction(async repo=>{
    const context=await locked(repo,initial,undefined,deps),row=context.row,at=now(deps)
    if(row.preparationStatus!=='ready'||row.notificationStatus==='sent'||row.notificationStatus==='failed'||row.notificationAttemptCount>=MAX_ATTEMPTS||!due(row.notificationStatus,row.notificationRetryEligibleAt,row.notificationLeaseExpiresAt,at))return null
    const revision=await repo.getRevision(row.id,row.notificationVersion);if(!revision)return fail('ARTICLE_REVISION_CHANGED')
    const payload:ArticleNotifyInput={lineUserId:context.binding.lineUserId,workspaceId:id,title:validateArticleDocument(revision.document).title,retryKey:row.notificationRetryKey,expiresAt:row.expiresAt.toISOString()},fingerprint=hash(payload)
    if(row.notificationPayloadFingerprint&&row.notificationPayloadFingerprint!==fingerprint)return fail('ARTICLE_NOTIFICATION_PAYLOAD_CHANGED')
    const attempt=row.notificationAttemptCount+1
    await repo.updateWorkspace(row.id,{notificationStatus:'processing',notificationAttemptCount:attempt,notificationLeaseToken:lease,notificationLeaseExpiresAt:new Date(at.getTime()+LEASE_MS),notificationRetryEligibleAt:null,notificationPayloadFingerprint:fingerprint,updatedAt:at})
    return {payload,fingerprint,attempt}
  })
  if(!claimed)return
  let result:ArticleNotifyResult;try{result=await deps.notify(claimed.payload)}catch{result={accepted:false,retryable:true,errorCode:'article_notification_outcome_unknown'}}
  await deps.repository.transaction(async repo=>{
    const context=await locked(repo,initial,undefined,deps),row=context.row,at=now(deps)
    if(row.notificationStatus!=='processing'||row.notificationLeaseToken!==lease||row.notificationPayloadFingerprint!==claimed.fingerprint||!row.notificationLeaseExpiresAt||row.notificationLeaseExpiresAt.getTime()<=at.getTime())return fail('ARTICLE_NOTIFICATION_OUTCOME_UNKNOWN',503)
    const retry=!result.accepted&&result.retryable&&claimed.attempt<MAX_ATTEMPTS
    await repo.updateWorkspace(row.id,{notificationStatus:result.accepted?'sent':retry?'retry_wait':'failed',notificationProviderMessageId:result.accepted?result.providerMessageId||null:null,notificationErrorCode:result.accepted?null:safeError(result.errorCode),notificationLeaseToken:null,notificationLeaseExpiresAt:null,notificationRetryEligibleAt:retry?retryDelay(at,claimed.attempt):null,updatedAt:at})
  })
}

async function operationReplay(repo:ArticleWorkbenchRepository,row:ArticleWorkspaceRow,operation:'save'|'feedback'|'approve',idempotencyKey:string,fingerprint:string,actor:ArticleActor){
  const prior=await repo.getOperation(row.id,operation,idempotencyKey)
  if(!prior)return false
  if(prior.requestFingerprint!==fingerprint||prior.actorFingerprint!==actorFingerprint(actor))return fail('ARTICLE_IDEMPOTENCY_COLLISION')
  return true
}
async function recordOperation(repo:ArticleWorkbenchRepository,row:ArticleWorkspaceRow,operation:'save'|'feedback'|'approve',idempotencyKey:string,fingerprint:string,actor:ArticleActor){await repo.insertOperation({workspaceRowId:row.id,operation,idempotencyKey,requestFingerprint:fingerprint,actorFingerprint:actorFingerprint(actor),resultVersion:row.version,resultDocumentHash:row.documentHash})}
type MutationInput={workspaceId:string;actor:ArticleActor;expectedVersion:number;idempotencyKey:string}
export async function saveArticleWorkspace(input:MutationInput&{document:unknown},deps:ArticleWorkbenchDependencies){
  const initial=await initialRow(input.workspaceId,deps),idempotencyKey=key(input.idempotencyKey),document=validateArticleDocument(input.document),fingerprint=hash({operation:'save',expectedVersion:input.expectedVersion,document,actor:actorFingerprint(input.actor)})
  return deps.repository.transaction(async repo=>{
    const context=await locked(repo,initial,input.actor,deps),row=context.row
    if(await operationReplay(repo,row,'save',idempotencyKey,fingerprint,input.actor))return {workspace:await dto(repo,context,deps),replayed:true}
    editable(row);version(input.expectedVersion,row);if(row.version>=100)return fail('ARTICLE_REVISION_LIMIT',422)
    const documentHash=articleDocumentHash(document,context.media),updated={...row,document,documentHash,version:row.version+1,status:'editing' as const,updatedAt:now(deps)}
    await repo.updateWorkspace(row.id,{document,documentHash,version:updated.version,status:'editing',updatedAt:updated.updatedAt})
    await repo.insertRevision({workspaceRowId:row.id,version:updated.version,document,documentHash,mediaManifest:context.media.filter(item=>articleMediaIds(document).includes(item.id)),actorKind:input.actor.kind,actorFingerprint:actorFingerprint(input.actor)})
    await recordOperation(repo,updated,'save',idempotencyKey,fingerprint,input.actor)
    return {workspace:await dto(repo,{...context,row:updated},deps),replayed:false}
  })
}
export async function feedbackArticleWorkspace(input:MutationInput&{note:string},deps:ArticleWorkbenchDependencies){
  const initial=await initialRow(input.workspaceId,deps),idempotencyKey=key(input.idempotencyKey),text=note(input.note),fingerprint=hash({operation:'feedback',expectedVersion:input.expectedVersion,note:text,actor:actorFingerprint(input.actor)})
  return deps.repository.transaction(async repo=>{
    const context=await locked(repo,initial,input.actor,deps),row=context.row
    if(await operationReplay(repo,row,'feedback',idempotencyKey,fingerprint,input.actor))return {workspace:await dto(repo,context,deps),replayed:true}
    editable(row);version(input.expectedVersion,row)
    if((await repo.listFeedback(row.id)).length>=100)return fail('ARTICLE_FEEDBACK_LIMIT',422)
    await repo.insertFeedback({workspaceRowId:row.id,version:row.version,note:text,actorFingerprint:actorFingerprint(input.actor)})
    const updated={...row,status:'changes_requested' as const,updatedAt:now(deps)};await repo.updateWorkspace(row.id,{status:'changes_requested',updatedAt:updated.updatedAt})
    await recordOperation(repo,updated,'feedback',idempotencyKey,fingerprint,input.actor)
    return {workspace:await dto(repo,{...context,row:updated},deps),replayed:false}
  })
}
/** Upload adapters must authenticate before external upload and call registration again under lock. */
export async function validateCustomerWorkspace(input:{workspaceId:string;identity:ArticleIdentity;expectedVersion?:number},deps:ArticleWorkbenchDependencies){
  const initial=await initialRow(input.workspaceId,deps)
  return deps.repository.transaction(async repo=>{const context=await locked(repo,initial,{kind:'customer',identity:input.identity},deps);editable(context.row);if(input.expectedVersion!==undefined)version(input.expectedVersion,context.row);return {workspaceId:context.row.workspaceId,version:context.row.version,remotePostId:context.row.remotePostId!,remotePostVersion:context.row.remotePostVersion!,authority:context.authority,media:context.media}})
}
export async function registerArticleMedia(input:{workspaceId:string;actor:ArticleActor;expectedVersion:number;media:ArticleMediaManifest},deps:ArticleWorkbenchDependencies){
  const initial=await initialRow(input.workspaceId,deps),item=validateArticleMedia(input.media)
  return deps.repository.transaction(async repo=>{
    const context=await locked(repo,initial,input.actor,deps);editable(context.row);version(input.expectedVersion,context.row)
    const current=context.media.find(row=>row.id===item.id)
    if(current){if(articleCanonicalJson(current)!==articleCanonicalJson(item))return fail('ARTICLE_MEDIA_COLLISION');return {workspace:await dto(repo,context,deps),replayed:true}}
    const mediaUrl=new URL(item.url);if(mediaUrl.origin!==context.target.targetOrigin)return fail('ARTICLE_MEDIA_ORIGIN_NOT_AUTHORIZED',422)
    if(context.media.length>=30||context.media.reduce((total,row)=>total+row.size,0)+item.size>15*1024*1024)return fail('ARTICLE_MEDIA_LIMIT',422)
    await repo.insertMedia({workspaceRowId:context.row.id,mediaId:item.id,sha256:item.sha256,version:item.version,mimeType:item.mimeType,size:item.size,width:item.width,height:item.height,url:item.url})
    return {workspace:await dto(repo,{...context,media:[...context.media,item]},deps),replayed:false}
  })
}
export async function approveArticleWorkspace(input:MutationInput&{documentHash:string;confirmation:typeof ARTICLE_CUSTOMER_CONFIRMATION},deps:ArticleWorkbenchDependencies){
  const initial=await initialRow(input.workspaceId,deps),idempotencyKey=key(input.idempotencyKey)
  if(input.actor.kind!=='customer')return fail('ARTICLE_CUSTOMER_APPROVAL_REQUIRED',403)
  if(input.confirmation!==ARTICLE_CUSTOMER_CONFIRMATION||!/^[a-f0-9]{64}$/u.test(input.documentHash))return fail('ARTICLE_APPROVAL_INVALID',422)
  const fingerprint=hash({operation:'approve',expectedVersion:input.expectedVersion,documentHash:input.documentHash,confirmation:input.confirmation,actor:actorFingerprint(input.actor)})
  const result=await deps.repository.transaction(async repo=>{
    const context=await locked(repo,initial,input.actor,deps),row=context.row
    if(await operationReplay(repo,row,'approve',idempotencyKey,fingerprint,input.actor))return {workspace:await dto(repo,context,deps),replayed:true}
    editable(row);version(input.expectedVersion,row);validateArticleDocument(row.document,true)
    if(input.documentHash!==row.documentHash)return fail('ARTICLE_APPROVAL_VERSION_CHANGED')
    const at=now(deps),mediaHash=articleMediaManifestHash(validateArticleDocument(row.document),context.media),approvalFingerprint=hash({purpose:'customer-exact-manual-article-approval-v1',workspaceId:row.workspaceId,authorityFingerprint:row.authorityFingerprint,version:row.version,documentHash:row.documentHash,mediaManifestHash:mediaHash,actorFingerprint:actorFingerprint(input.actor),approvedAt:at.toISOString()})
    const updated={...row,status:'approved' as const,approvedVersion:row.version,approvedDocumentHash:row.documentHash,approvedMediaManifestHash:mediaHash,approvalFingerprint,approvedActorFingerprint:actorFingerprint(input.actor),approvedAt:at,updatedAt:at}
    await repo.updateWorkspace(row.id,{status:'approved',approvedVersion:row.version,approvedDocumentHash:row.documentHash,approvedMediaManifestHash:mediaHash,approvalFingerprint,approvedActorFingerprint:actorFingerprint(input.actor),approvedAt:at,updatedAt:at})
    await recordOperation(repo,updated,'approve',idempotencyKey,fingerprint,input.actor)
    return {workspace:await dto(repo,{...context,row:updated},deps),replayed:false}
  })
  // Replays do not initiate additional provider attempts; only the first consent or an owner retry does.
  if(!result.replayed)await publishArticleWorkspace(input.workspaceId,deps)
  const current=await getArticleWorkspace({workspaceId:input.workspaceId,actor:input.actor},deps)
  return {...current,replayed:result.replayed}
}
export async function publishArticleWorkspace(id:string,deps:ArticleWorkbenchDependencies){
  const initial=await initialRow(id,deps),lease=randomUUID()
  const claimed=await deps.repository.transaction(async repo=>{
    const context=await locked(repo,initial,undefined,deps),row=context.row,at=now(deps)
    if(!['approved','retry_wait','processing'].includes(row.status)||row.publicationAttemptCount>=MAX_ATTEMPTS||row.status==='retry_wait'&&(!row.publicationRetryEligibleAt||row.publicationRetryEligibleAt.getTime()>at.getTime())||row.status==='processing'&&(!row.publicationLeaseExpiresAt||row.publicationLeaseExpiresAt.getTime()>at.getTime()))return null
    const document=validateArticleDocument(row.document,true),mediaHash=articleMediaManifestHash(document,context.media)
    if(!row.approvedAt||!row.approvalFingerprint||!row.approvedActorFingerprint||row.approvedVersion!==row.version||row.approvedDocumentHash!==row.documentHash||row.approvedMediaManifestHash!==mediaHash||row.preparationStatus!=='ready'||!row.remotePostId||row.remotePostVersion!==1)return fail('ARTICLE_APPROVAL_CHANGED')
    const expected=hash({purpose:'customer-exact-manual-article-approval-v1',workspaceId:row.workspaceId,authorityFingerprint:row.authorityFingerprint,version:row.version,documentHash:row.documentHash,mediaManifestHash:mediaHash,actorFingerprint:row.approvedActorFingerprint,approvedAt:row.approvedAt.toISOString()})
    if(expected!==row.approvalFingerprint)return fail('ARTICLE_APPROVAL_CHANGED')
    const payload:ArticlePublishInput={workspaceId:id,version:row.version,documentHash:row.documentHash,document,media:context.media.filter(item=>articleMediaIds(document).includes(item.id)),authority:context.authority,retryKey:row.publicationRetryKey,remotePostId:row.remotePostId,remotePostVersion:row.remotePostVersion,approval:{approvedAt:row.approvedAt.toISOString(),reviewFingerprint:row.approvalFingerprint,approvedDocumentVersion:row.version,approvedDocumentHash:row.documentHash,approvedMediaManifestHash:mediaHash}},fingerprint=hash(payload)
    if(row.publicationPayloadFingerprint&&row.publicationPayloadFingerprint!==fingerprint)return fail('ARTICLE_PUBLICATION_PAYLOAD_CHANGED')
    const attempt=row.publicationAttemptCount+1
    await repo.updateWorkspace(row.id,{status:'processing',publicationAttemptCount:attempt,publicationLeaseToken:lease,publicationLeaseExpiresAt:new Date(at.getTime()+LEASE_MS),publicationRetryEligibleAt:null,publicationPayloadFingerprint:fingerprint,updatedAt:at})
    return {payload,fingerprint,attempt}
  })
  if(!claimed)return
  let outcome:ArticlePublishResult;try{outcome=await deps.publish(claimed.payload)}catch{outcome={published:false,retryable:true,errorCode:'article_publication_outcome_unknown'}}
  await deps.repository.transaction(async repo=>{
    const context=await locked(repo,initial,undefined,deps),row=context.row,at=now(deps)
    if(row.status!=='processing'||row.publicationLeaseToken!==lease||row.publicationPayloadFingerprint!==claimed.fingerprint||!row.publicationLeaseExpiresAt||row.publicationLeaseExpiresAt.getTime()<=at.getTime())return fail('ARTICLE_PUBLICATION_OUTCOME_UNKNOWN',503)
    if(outcome.published){let parsed:URL;try{parsed=new URL(outcome.url)}catch{return fail('ARTICLE_PUBLICATION_RECEIPT_INVALID',503)};if(parsed.origin!==context.target.targetOrigin||parsed.pathname!==`/journal/${claimed.payload.document.slug}/`||parsed.username||parsed.password||parsed.search||parsed.hash||typeof outcome.providerPostId!=='string'||outcome.providerPostId!==row.remotePostId)return fail('ARTICLE_PUBLICATION_RECEIPT_INVALID',503)
      await repo.updateWorkspace(row.id,{status:'published',publicationUrl:parsed.href,publicationProviderPostId:outcome.providerPostId,publishedAt:at,publicationLeaseToken:null,publicationLeaseExpiresAt:null,publicationErrorCode:null,updatedAt:at})
    }else{const retry=outcome.retryable&&claimed.attempt<MAX_ATTEMPTS;await repo.updateWorkspace(row.id,{status:retry?'retry_wait':'failed',publicationLeaseToken:null,publicationLeaseExpiresAt:null,publicationRetryEligibleAt:retry?retryDelay(at,claimed.attempt):null,publicationErrorCode:safeError(outcome.errorCode),updatedAt:at})}
  })
}
/** Explicit owner retry only. No scheduler, model training, autonomous generation or test-consent promotion. */
export async function retryArticleWorkspace(input:{workspaceId:string;ownerUserId:number;confirmation:'RETRY_FORMAL_ARTICLE'},deps:ArticleWorkbenchDependencies){
  if(input.confirmation!=='RETRY_FORMAL_ARTICLE')return fail('ARTICLE_RETRY_CONFIRMATION_REQUIRED',422)
  await getArticleWorkspace({workspaceId:input.workspaceId,actor:{kind:'owner',ownerUserId:input.ownerUserId}},deps)
  await prepareArticleWorkspace(input.workspaceId,deps);await notifyArticleWorkspace(input.workspaceId,deps);await publishArticleWorkspace(input.workspaceId,deps)
  return getArticleWorkspace({workspaceId:input.workspaceId,actor:{kind:'owner',ownerUserId:input.ownerUserId}},deps)
}
export async function sendRevisedArticleWorkspace(input:{workspaceId:string;ownerUserId:number;expectedVersion:number;confirmation:'SEND_REVISED_FORMAL_ARTICLE'},deps:ArticleWorkbenchDependencies){
  if(input.confirmation!=='SEND_REVISED_FORMAL_ARTICLE')return fail('ARTICLE_REVISION_CONFIRMATION_REQUIRED',422)
  const initial=await initialRow(input.workspaceId,deps)
  const replayed=await deps.repository.transaction(async repo=>{
    const context=await locked(repo,initial,{kind:'owner',ownerUserId:input.ownerUserId},deps),row=context.row;editable(row);version(input.expectedVersion,row)
    if(row.notificationVersion===row.version)return true
    if(row.notificationStatus==='processing')return fail('ARTICLE_NOTIFICATION_IN_PROGRESS')
    await repo.updateWorkspace(row.id,{notificationVersion:row.version,notificationStatus:'queued',notificationAttemptCount:0,notificationLeaseToken:null,notificationLeaseExpiresAt:null,notificationRetryEligibleAt:null,notificationRetryKey:randomUUID(),notificationPayloadFingerprint:null,notificationProviderMessageId:null,notificationErrorCode:null,updatedAt:now(deps)})
    return false
  })
  await notifyArticleWorkspace(input.workspaceId,deps)
  return {...await getArticleWorkspace({workspaceId:input.workspaceId,actor:{kind:'owner',ownerUserId:input.ownerUserId}},deps),replayed}
}

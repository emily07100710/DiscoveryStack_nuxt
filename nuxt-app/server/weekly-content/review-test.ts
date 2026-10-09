import {createHash,createHmac,randomBytes,randomUUID,timingSafeEqual} from 'node:crypto'
import {createError} from 'h3'
import {createWeeklyContentRepository,WeeklyWebhookInboxRaceError,type WeeklyContentRepository} from './repository'
import {createWeeklyReviewTestRepository,type WeeklyReviewTest,type WeeklyReviewTestRepository} from './review-test-repository'
import {isWeeklyLineToken,normalizeWeeklyLinePublicOrigin,sendWeeklyLinePush,type WeeklyLinePushResult,type WeeklyLineReviewMessage} from './line-transport'
import type {VerifiedLineIdentity} from './service'

export const REVIEW_TEST_CONFIRMATION='SEND_REVIEW_TEST' as const
export const REVIEW_TEST_SOURCE_LABEL='owner_prepared_sample' as const
export const WEEKLY_REVIEW_TEST_REQUEST_ID=/^wct_[A-Za-z0-9_-]{32}$/u
const MAX_NOTIFICATION_ATTEMPTS=3
const REVIEW_TEST_TTL_MS=24*60*60*1000
const hash=(value:string)=>createHash('sha256').update(value).digest('hex')
const fail=(code:string,statusCode=409):never=>{throw createError({statusCode,statusMessage:code})}
const clock=(deps:ReviewTestDependencies)=>{const now=deps.now||new Date();if(!Number.isFinite(now.getTime()))return fail('WEEKLY_REVIEW_TEST_CLOCK_INVALID',422);return now}
const token=(key:string,purpose:string,requestId:string)=>createHmac('sha256',key).update(`${purpose}:${requestId}`).digest('base64url')
const exactHash=(raw:string,expected:string)=>/^[a-f0-9]{64}$/u.test(expected)&&timingSafeEqual(Buffer.from(hash(raw)),Buffer.from(expected))

export type ReviewTestStatus='pending'|'approved'|'changes_requested'|'revoked'
export type ReviewTestNotificationStatus='queued'|'processing'|'sent'|'retry_wait'|'failed'|'cancelled'
export type ReviewTestSafeDto={requestId:string;title:string;status:ReviewTestStatus;notificationStatus:ReviewTestNotificationStatus;expiresAt:string;createdAt:string}
export type ReviewTestPreview={requestId:string;title:string;body:string;status:ReviewTestStatus;expiresAt:string;canRespond:boolean;sourceLabel:typeof REVIEW_TEST_SOURCE_LABEL}
export type ReviewTestSenderInput={lineUserId:string;message:WeeklyLineReviewMessage;retryKey:string}
export type ReviewTestDependencies={
  repository:WeeklyReviewTestRepository
  weeklyRepository:()=>WeeklyContentRepository
  featureEnabled:boolean
  tokenKey:string
  publicOrigin:string
  sender:(input:ReviewTestSenderInput)=>Promise<WeeklyLinePushResult>
  now?:Date
}

function enabled(deps:ReviewTestDependencies){if(!deps.featureEnabled)return fail('WEEKLY_REVIEW_TEST_DISABLED',503);if(Buffer.byteLength(deps.tokenKey||'')<32||Buffer.byteLength(deps.tokenKey||'')>512)return fail('WEEKLY_REVIEW_TOKEN_KEY_NOT_CONFIGURED',503)}
function plain(value:unknown,max:number,field:'title'|'body'){
  if(typeof value!=='string')return fail('WEEKLY_REVIEW_TEST_INPUT_INVALID',422)
  const normalized=value.replace(/\r\n?/gu,'\n').trim()
  const length=Array.from(normalized).length
  if(!normalized||length>max||/\u0000|[\u0001-\u0008\u000B\u000C\u000E-\u001F\u007F]/u.test(normalized)||field==='title'&&/[\n\t]/u.test(normalized))return fail('WEEKLY_REVIEW_TEST_INPUT_INVALID',422)
  return normalized
}
function key(value:unknown){if(typeof value!=='string'||value.length<8||value.length>128||!/^[A-Za-z0-9._:-]+$/u.test(value))return fail('WEEKLY_REVIEW_TEST_INPUT_INVALID',422);return value}
function positive(value:number){if(!Number.isSafeInteger(value)||value<1)return fail('WEEKLY_REVIEW_TEST_INPUT_INVALID',422);return value}
function deriveTokens(row:Pick<WeeklyReviewTest,'requestId'|'readTokenHash'|'actionTokenHash'>,keyValue:string){
  const readToken=token(keyValue,'weekly-review-test-read-v1',row.requestId),actionToken=token(keyValue,'weekly-review-test-action-v1',row.requestId)
  if(!exactHash(readToken,row.readTokenHash)||!exactHash(actionToken,row.actionTokenHash))return fail('WEEKLY_REVIEW_TEST_TOKEN_KEY_CHANGED')
  return {readToken,actionToken}
}
function safe(row:WeeklyReviewTest):ReviewTestSafeDto{return {requestId:row.requestId,title:row.title,status:row.status,notificationStatus:row.notificationStatus,expiresAt:row.expiresAt.toISOString(),createdAt:row.createdAt.toISOString()}}
function fixedRetryKey(input:{ownerUserId:number;clientId:number;bindingId:number;requestId:string}){
  const bytes=createHash('sha1').update('weekly-review-test-line-retry-v1').update(JSON.stringify(input)).digest().subarray(0,16)
  bytes[6]=(bytes[6]!&0x0f)|0x50;bytes[8]=(bytes[8]!&0x3f)|0x80
  const hex=bytes.toString('hex');return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`
}
function encodeReviewTestPostback(requestId:string,actionToken:string,decision:'approved'|'changes_requested'){
  if(!WEEKLY_REVIEW_TEST_REQUEST_ID.test(requestId)||!isWeeklyLineToken(actionToken))return fail('WEEKLY_REVIEW_TEST_MESSAGE_INVALID',422)
  return `wct|${requestId}|${actionToken}|${decision}`
}
export function buildReviewTestMessage(input:{requestId:string;readToken:string;actionToken:string;title:string;expiresAt:Date|string;publicOrigin:string;brand?:string}):WeeklyLineReviewMessage {
  if(!WEEKLY_REVIEW_TEST_REQUEST_ID.test(input.requestId)||!isWeeklyLineToken(input.readToken)||!isWeeklyLineToken(input.actionToken))return fail('WEEKLY_REVIEW_TEST_MESSAGE_INVALID',422)
  const origin=normalizeWeeklyLinePublicOrigin(input.publicOrigin),expiry=new Date(input.expiresAt)
  if(!Number.isFinite(expiry.getTime()))return fail('WEEKLY_REVIEW_TEST_MESSAGE_INVALID',422)
  const title=Array.from(plain(input.title,160,'title')).slice(0,120).join(''),brand=typeof input.brand==='string'&&input.brand.trim()?Array.from(input.brand.trim()).slice(0,60).join(''):'DS搜尋王'
  const preview=new URL(`/weekly-content/test-review/${input.requestId}`,origin);preview.searchParams.set('token',input.readToken)
  return {type:'flex',altText:`${brand}：請確認測試稿；本次不會發布文章。`,contents:{type:'bubble',styles:{body:{backgroundColor:'#EEE9DF'},footer:{backgroundColor:'#101326'}},body:{type:'box',layout:'vertical',spacing:'md',contents:[
    {type:'text',text:brand,weight:'bold',size:'sm',color:'#B9A477'},
    {type:'text',text:'單篇測試稿，請你確認',weight:'bold',size:'lg',color:'#171A32',wrap:true},
    {type:'text',text:title,size:'md',color:'#171A32',wrap:true},
    {type:'text',text:'這是一封流程測試。你的選擇只會記錄這篇測試稿，不會發布文章，也不會開啟排程。',size:'sm',wrap:true,color:'#101326'},
    {type:'text',text:`回覆期限：${expiry.toISOString()}`,size:'xs',wrap:true,color:'#101326'},
  ]},footer:{type:'box',layout:'vertical',spacing:'sm',contents:[
    {type:'button',color:'#B9A477',action:{type:'uri',label:'閱讀測試文章',uri:preview.toString()}},
    {type:'button',style:'primary',color:'#171A32',action:{type:'postback',label:'同意測試稿',data:encodeReviewTestPostback(input.requestId,input.actionToken,'approved'),displayText:'我同意這篇測試稿（不會發布）'}},
    {type:'button',color:'#B9A477',action:{type:'postback',label:'要求修改',data:encodeReviewTestPostback(input.requestId,input.actionToken,'changes_requested'),displayText:'這篇測試稿需要修改（不會發布）'}},
  ]}}}
}

type CreateInput={ownerUserId:number;clientId:number;title:string;body:string;idempotencyKey:string;confirmation:typeof REVIEW_TEST_CONFIRMATION}
export async function createAndSendReviewTest(input:CreateInput,deps:ReviewTestDependencies):Promise<{test:ReviewTestSafeDto;replayed:boolean}>{
  enabled(deps);positive(input.ownerUserId);positive(input.clientId)
  if(input.confirmation!==REVIEW_TEST_CONFIRMATION)return fail('WEEKLY_REVIEW_TEST_CONFIRMATION_REQUIRED',422)
  const title=plain(input.title,160,'title'),body=plain(input.body,12_000,'body'),idempotencyKey=key(input.idempotencyKey),now=clock(deps)
  // Configuration errors fail before a request or attempt is persisted.
  const publicOrigin=normalizeWeeklyLinePublicOrigin(deps.publicOrigin)
  const leaseToken=randomUUID()
  const prepared=await deps.repository.transaction(async repo=>{
    const client=await repo.findClient(input.ownerUserId,input.clientId,true)
    if(!client||client.ownerUserId!==input.ownerUserId||client.id!==input.clientId||client.status!=='active')return fail('WEEKLY_REVIEW_TEST_CLIENT_NOT_AVAILABLE',404)
    const binding=await repo.getBinding(input.ownerUserId,input.clientId,true)
    if(!binding||binding.ownerUserId!==input.ownerUserId||binding.clientId!==input.clientId||binding.status!=='active')return fail('WEEKLY_REVIEW_TEST_BINDING_NOT_AVAILABLE')
    const contentHash=hash(JSON.stringify({sourceLabel:REVIEW_TEST_SOURCE_LABEL,title,body}))
    const requestFingerprint=hash(JSON.stringify({version:'weekly-review-test-v1',ownerUserId:input.ownerUserId,clientId:input.clientId,bindingId:binding.id,bindingFingerprint:binding.bindingFingerprint,contentHash,idempotencyKey}))
    let row=await repo.findByOwnerKey(input.ownerUserId,input.clientId,idempotencyKey,true),replayed=Boolean(row)
    if(row){
      if(row.requestFingerprint!==requestFingerprint||row.contentHash!==contentHash||row.title!==title||row.body!==body)return fail('WEEKLY_REVIEW_TEST_IDEMPOTENCY_COLLISION')
      if(row.bindingId!==binding.id||row.bindingFingerprint!==binding.bindingFingerprint)return fail('WEEKLY_REVIEW_TEST_BINDING_CHANGED')
    }else{
      // A browser reload can lose its client-generated idempotency key. The locked
      // client row serializes this lookup, so identical active content still maps
      // to one durable request and one provider retry key.
      row=await repo.findPendingByContent(input.ownerUserId,input.clientId,binding.id,binding.bindingFingerprint,contentHash,now,true)
      if(row){
        if(row.title!==title||row.body!==body)return fail('WEEKLY_REVIEW_TEST_CONTENT_HASH_COLLISION')
        replayed=true
      }
    }
    if(!row){
      const requestId=`wct_${randomBytes(24).toString('base64url')}`
      const provisional={requestId,readTokenHash:'',actionTokenHash:''},readToken=token(deps.tokenKey,'weekly-review-test-read-v1',requestId),actionToken=token(deps.tokenKey,'weekly-review-test-action-v1',requestId)
      provisional.readTokenHash=hash(readToken);provisional.actionTokenHash=hash(actionToken)
      row=await repo.insert({requestId,ownerUserId:input.ownerUserId,clientId:input.clientId,bindingId:binding.id,bindingFingerprint:binding.bindingFingerprint,sourceLabel:REVIEW_TEST_SOURCE_LABEL,title,body,contentHash,requestFingerprint,idempotencyKey,readTokenHash:provisional.readTokenHash,actionTokenHash:provisional.actionTokenHash,status:'pending',decisionEventHash:null,decisionActorFingerprint:null,decisionFingerprint:null,decidedAt:null,notificationStatus:'queued',notificationAttemptCount:0,notificationLeaseToken:null,notificationLeaseExpiresAt:null,notificationRetryEligibleAt:null,notificationRetryKey:fixedRetryKey({ownerUserId:input.ownerUserId,clientId:input.clientId,bindingId:binding.id,requestId}),notificationPayloadFingerprint:null,notificationProviderMessageId:null,notificationErrorCode:null,notificationSentAt:null,expiresAt:new Date(now.getTime()+REVIEW_TEST_TTL_MS)})
      replayed=false
    }
    if(row.status!=='pending'||row.expiresAt.getTime()<=now.getTime()||row.notificationStatus==='sent'||row.notificationStatus==='cancelled'||row.notificationAttemptCount>=MAX_NOTIFICATION_ATTEMPTS)return {row,claimed:null,lineUserId:binding.lineUserId,replayed}
    const claimed=await repo.claimNotification(row.id,leaseToken,now,MAX_NOTIFICATION_ATTEMPTS)
    return {row:claimed||row,claimed,lineUserId:binding.lineUserId,replayed}
  })
  if(!prepared.claimed)return {test:safe(prepared.row),replayed:prepared.replayed}
  const credentials=deriveTokens(prepared.claimed,deps.tokenKey)
  const message=buildReviewTestMessage({requestId:prepared.claimed.requestId,...credentials,title:prepared.claimed.title,expiresAt:prepared.claimed.expiresAt,publicOrigin})
  const payloadFingerprint=hash(JSON.stringify({to:prepared.lineUserId,messages:[message],retryKey:prepared.claimed.notificationRetryKey}))
  const reserved=await deps.repository.reserveNotificationPayload(prepared.claimed.id,leaseToken,payloadFingerprint,clock(deps))
  if(!reserved)return fail('WEEKLY_REVIEW_TEST_NOTIFICATION_CHANGED')
  let outcome:WeeklyLinePushResult
  try{outcome=await deps.sender({lineUserId:prepared.lineUserId,message,retryKey:prepared.claimed.notificationRetryKey})}catch{outcome={accepted:false,retryable:true,errorCode:'line_delivery_outcome_unknown'}}
  const finishedAt=clock(deps),attempt=prepared.claimed.notificationAttemptCount
  const result=outcome.accepted
    ? {status:'sent' as const,providerMessageId:outcome.providerMessageId}
    : outcome.retryable&&attempt<MAX_NOTIFICATION_ATTEMPTS
      ? {status:'retry_wait' as const,retryEligibleAt:new Date(finishedAt.getTime()+Math.min(30_000*2**Math.max(0,attempt-1),5*60_000)),errorCode:outcome.errorCode}
      : {status:'failed' as const,errorCode:outcome.errorCode}
  if(!await deps.repository.finishNotification(prepared.claimed.id,leaseToken,payloadFingerprint,finishedAt,result))return fail('WEEKLY_REVIEW_TEST_NOTIFICATION_OUTCOME_UNKNOWN',503)
  const current=await deps.repository.getByRequestId(prepared.claimed.requestId)
  if(!current)return fail('WEEKLY_REVIEW_TEST_NOT_FOUND',404)
  return {test:safe(current),replayed:prepared.replayed}
}

export async function listReviewTestsForOwner(input:{ownerUserId:number;clientId:number},deps:ReviewTestDependencies):Promise<{tests:ReviewTestSafeDto[]}>{
  enabled(deps);positive(input.ownerUserId);positive(input.clientId)
  const client=await deps.repository.findClient(input.ownerUserId,input.clientId)
  if(!client||client.ownerUserId!==input.ownerUserId||client.id!==input.clientId||client.status!=='active')return fail('WEEKLY_REVIEW_TEST_CLIENT_NOT_AVAILABLE',404)
  return {tests:(await deps.repository.list(input.ownerUserId,input.clientId,50)).map(safe)}
}

export async function getReviewTestPreview(input:{requestId:string;readToken:string},deps:ReviewTestDependencies):Promise<ReviewTestPreview>{
  enabled(deps)
  if(!WEEKLY_REVIEW_TEST_REQUEST_ID.test(input.requestId)||!isWeeklyLineToken(input.readToken))return fail('WEEKLY_REVIEW_TEST_NOT_FOUND',404)
  const initial=await deps.repository.getByRequestId(input.requestId)
  if(!initial||!exactHash(input.readToken,initial.readTokenHash))return fail('WEEKLY_REVIEW_TEST_NOT_FOUND',404)
  return deps.repository.transaction(async repo=>{
    const client=await repo.findClient(initial.ownerUserId,initial.clientId,true)
    const binding=await repo.getBinding(initial.ownerUserId,initial.clientId,true)
    const row=await repo.getByRequestId(input.requestId,true),now=clock(deps)
    if(!row||row.ownerUserId!==initial.ownerUserId||row.clientId!==initial.clientId||!exactHash(input.readToken,row.readTokenHash)||!client||client.status!=='active'||client.ownerUserId!==row.ownerUserId||client.id!==row.clientId||!binding||binding.status!=='active'||binding.id!==row.bindingId||binding.bindingFingerprint!==row.bindingFingerprint||row.expiresAt.getTime()<=now.getTime())return fail('WEEKLY_REVIEW_TEST_EXPIRED_OR_CHANGED')
    deriveTokens(row,deps.tokenKey)
    return {requestId:row.requestId,title:row.title,body:row.body,status:row.status,expiresAt:row.expiresAt.toISOString(),canRespond:row.status==='pending',sourceLabel:REVIEW_TEST_SOURCE_LABEL}
  })
}

async function replay(weekly:WeeklyContentRepository,eventHash:string,payloadFingerprint:string){
  const prior=await weekly.findInbox(eventHash)
  if(!prior)return null
  if(prior.payloadFingerprint!==payloadFingerprint||prior.status!=='processed'||!['REVIEW_TEST_APPROVED','REVIEW_TEST_CHANGES_REQUESTED'].includes(prior.resultCode))return fail('WEEKLY_LINE_EVENT_COLLISION')
  return {status:'replayed' as const,resultCode:prior.resultCode}
}
export async function reviewTestFromVerifiedLine(input:VerifiedLineIdentity&{requestId:string;actionToken:string;decision:'approved'|'changes_requested'},deps:ReviewTestDependencies){
  enabled(deps)
  if(!WEEKLY_REVIEW_TEST_REQUEST_ID.test(input.requestId)||!isWeeklyLineToken(input.actionToken)||!/^U[a-f0-9]{32}$/u.test(input.lineUserId)||typeof input.webhookEventId!=='string'||!input.webhookEventId||input.webhookEventId.length>256||!/^[a-f0-9]{64}$/u.test(input.semanticFingerprint)||!['approved','changes_requested'].includes(input.decision))return fail('WEEKLY_REVIEW_TEST_ACTION_INVALID',422)
  const eventHash=hash(input.webhookEventId),initial=await deps.repository.getByRequestId(input.requestId)
  if(!initial||!exactHash(input.actionToken,initial.actionTokenHash))return fail('WEEKLY_REVIEW_TEST_ACTION_INVALID',404)
  try{return await deps.repository.transaction(async(repo,weekly)=>{
    const client=await repo.findClient(initial.ownerUserId,initial.clientId,true)
    const binding=await repo.getBinding(initial.ownerUserId,initial.clientId,true)
    const row=await repo.getByRequestId(input.requestId,true),now=clock(deps)
    const repeated=await replay(weekly,eventHash,input.semanticFingerprint);if(repeated)return repeated
    if(!row||!exactHash(input.actionToken,row.actionTokenHash)||!client||client.status!=='active'||client.ownerUserId!==row.ownerUserId||client.id!==row.clientId||!binding||binding.status!=='active'||binding.id!==row.bindingId||binding.bindingFingerprint!==row.bindingFingerprint||binding.lineUserId!==input.lineUserId||row.expiresAt.getTime()<=now.getTime())return fail('WEEKLY_REVIEW_TEST_EXPIRED_OR_CHANGED')
    deriveTokens(row,deps.tokenKey)
    if(row.status!=='pending')return fail('WEEKLY_REVIEW_TEST_ALREADY_DECIDED')
    const actorFingerprint=hash(input.lineUserId),decisionFingerprint=hash(JSON.stringify({requestFingerprint:row.requestFingerprint,decision:input.decision,eventHash,actorFingerprint,bindingFingerprint:row.bindingFingerprint}))
    if(!await repo.decide(row.id,input.decision,eventHash,actorFingerprint,decisionFingerprint,now))return fail('WEEKLY_REVIEW_TEST_ALREADY_DECIDED')
    const resultCode=input.decision==='approved'?'REVIEW_TEST_APPROVED':'REVIEW_TEST_CHANGES_REQUESTED'
    await weekly.insertInbox({eventHash,payloadFingerprint:input.semanticFingerprint,status:'processed',resultCode})
    return {status:input.decision,resultCode}
  })}catch(cause){
    if(!(cause instanceof WeeklyWebhookInboxRaceError))throw cause
    const winner=await replay(deps.weeklyRepository(),eventHash,input.semanticFingerprint)
    if(!winner)return fail('WEEKLY_LINE_EVENT_RACE_UNRESOLVED')
    return winner
  }
}

export function reviewTestRuntimeDependencies():ReviewTestDependencies {
  return {repository:createWeeklyReviewTestRepository(),weeklyRepository:createWeeklyContentRepository,featureEnabled:process.env.NUXT_WEEKLY_CONTENT_APPROVAL_ENABLED==='true',tokenKey:process.env.NUXT_WEEKLY_CONTENT_TOKEN_KEY||'',publicOrigin:process.env.NUXT_WEEKLY_CONTENT_REVIEW_ORIGIN||'',sender:input=>sendWeeklyLinePush(input,{channelAccessToken:process.env.NUXT_WEEKLY_CONTENT_LINE_ACCESS_TOKEN||''})}
}

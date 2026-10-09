import {vi} from 'vitest'
import type {WeeklyReviewTest,WeeklyReviewTestRepository} from '../../../server/weekly-content/review-test-repository'
import {WeeklyFixture,WEEKLY_NOW,sha} from './repository'

export const REVIEW_TEST_LINE_USER=`U${'7'.repeat(32)}`

export class ReviewTestFixture {
  readonly weekly=new WeeklyFixture()
  readonly rows:WeeklyReviewTest[]=[]
  readonly repository:WeeklyReviewTestRepository
  private nextId=100
  private tail:Promise<void>=Promise.resolve()

  constructor(){
    this.weekly.state.binding={id:80,ownerUserId:1,clientId:1,lineUserId:REVIEW_TEST_LINE_USER,bindingFingerprint:sha('review-test-binding'),status:'active',createdAt:WEEKLY_NOW,updatedAt:WEEKLY_NOW}
    this.repository={
      transaction:async work=>{const before=this.tail;let unlock!:()=>void;this.tail=new Promise(resolve=>{unlock=resolve});await before;const rows=structuredClone(this.rows),inbox=structuredClone(this.weekly.state.inbox);try{return await work(this.repository,this.weekly.repository)}catch(error){this.rows.splice(0,this.rows.length,...rows);this.weekly.state.inbox=inbox;throw error}finally{unlock()}},
      findClient:vi.fn(async(owner,client)=>owner===1&&client===1?this.weekly.state.client:null),
      getBinding:vi.fn(async(owner,client)=>owner===1&&client===1?this.weekly.state.binding:null),
      findByOwnerKey:vi.fn(async(owner,client,key)=>this.rows.find(row=>row.ownerUserId===owner&&row.clientId===client&&row.idempotencyKey===key)||null),
      findPendingByContent:vi.fn(async(owner,client,bindingId,bindingFingerprint,contentHash,now)=>this.rows.find(row=>row.ownerUserId===owner&&row.clientId===client&&row.bindingId===bindingId&&row.bindingFingerprint===bindingFingerprint&&row.contentHash===contentHash&&row.status==='pending'&&row.expiresAt>now)||null),
      getByRequestId:vi.fn(async requestId=>this.rows.find(row=>row.requestId===requestId)||null),
      list:vi.fn(async(owner,client,limit=50)=>this.rows.filter(row=>row.ownerUserId===owner&&row.clientId===client).sort((a,b)=>b.id-a.id).slice(0,limit)),
      insert:vi.fn(async value=>{const row={...value,id:++this.nextId,createdAt:WEEKLY_NOW,updatedAt:WEEKLY_NOW};this.rows.push(row);return row}),
      claimNotification:vi.fn(async(id,leaseToken,now,maxAttempts)=>{const row=this.rows.find(value=>value.id===id);if(!row||row.status!=='pending'||row.expiresAt<=now||row.notificationAttemptCount>=maxAttempts)return null;const due=row.notificationStatus==='queued'||row.notificationStatus==='failed'||row.notificationStatus==='retry_wait'&&Boolean(row.notificationRetryEligibleAt&&row.notificationRetryEligibleAt<=now)||row.notificationStatus==='processing'&&Boolean(row.notificationLeaseExpiresAt&&row.notificationLeaseExpiresAt<=now);if(!due)return null;Object.assign(row,{notificationStatus:'processing',notificationAttemptCount:row.notificationAttemptCount+1,notificationLeaseToken:leaseToken,notificationLeaseExpiresAt:new Date(now.getTime()+120_000),notificationRetryEligibleAt:null,updatedAt:now});return row}),
      reserveNotificationPayload:vi.fn(async(id,leaseToken,fingerprint,now)=>{const row=this.rows.find(value=>value.id===id);if(!row||row.status!=='pending'||row.notificationStatus!=='processing'||row.notificationLeaseToken!==leaseToken||!row.notificationLeaseExpiresAt||row.notificationLeaseExpiresAt<=now||row.notificationPayloadFingerprint&&row.notificationPayloadFingerprint!==fingerprint)return false;row.notificationPayloadFingerprint=fingerprint;row.updatedAt=now;return true}),
      finishNotification:vi.fn(async(id,leaseToken,fingerprint,now,result)=>{const row=this.rows.find(value=>value.id===id);if(!row||row.notificationStatus!=='processing'||row.notificationLeaseToken!==leaseToken||row.notificationPayloadFingerprint!==fingerprint||!row.notificationLeaseExpiresAt||row.notificationLeaseExpiresAt<=now)return false;Object.assign(row,{notificationStatus:result.status,notificationLeaseToken:null,notificationLeaseExpiresAt:null,notificationRetryEligibleAt:result.retryEligibleAt||null,notificationProviderMessageId:result.providerMessageId||null,notificationErrorCode:result.errorCode||null,notificationSentAt:result.status==='sent'?now:null,updatedAt:now});return true}),
      decide:vi.fn(async(id,decision,eventHash,actorFingerprint,decisionFingerprint,now)=>{const row=this.rows.find(value=>value.id===id);if(!row||row.status!=='pending'||row.decisionEventHash||row.decisionFingerprint)return false;Object.assign(row,{status:decision,decisionEventHash:eventHash,decisionActorFingerprint:actorFingerprint,decisionFingerprint,decidedAt:now,updatedAt:now});return true}),
    }
  }
}

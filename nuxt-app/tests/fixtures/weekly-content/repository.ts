import { createHash } from 'node:crypto'
import { vi } from 'vitest'
import type { WeeklyContentRepository, InsertRow } from '../../../server/weekly-content/repository'
import { WeeklyWebhookInboxRaceError } from '../../../server/weekly-content/repository'
import type { WeeklyConfig, PrivateLineBinding, WeeklyDraft, WeeklyReviewRequest, WeeklyConsent, WeeklyOutbox, WeeklyWebhookInbox, LineBindingInvitation } from '../../../server/weekly-content/types'
import type { ContentOperationAutopilotPolicyRow, ContentOperationPublicationTargetRow } from '../../../server/content-operations/types'
import { fixtureClient } from '../content-operations/repository'
export const WEEKLY_NOW=new Date('2026-10-04T00:00:00Z')
export const WEEKLY_HASH='a'.repeat(64)
export const WEEKLY_KEY='synthetic-only-weekly-key-32-bytes-minimum'
export const sha=(value:string)=>createHash('sha256').update(value).digest('hex')
export function weeklyTarget():ContentOperationPublicationTargetRow { return {id:3,ownerUserId:1,clientId:1,websiteId:'website-1',targetId:'primary',activeSlot:1,framework:'nextjs',transport:'first_party_signed_api',status:'active',targetOrigin:'https://do.example',contentRoot:'content',defaultBranch:'main',repositoryOwner:null,repositoryName:null,serviceReference:null,endpointPath:'/api/publish',credentialReference:'synthetic-ref',allowedContentTypes:['article'],allowedLanguages:['zh-hant'],maximumPayloadBytes:1000000,executionEnabled:true,configurationFingerprint:WEEKLY_HASH,provenance:{},idempotencyKey:'target-1',createdAt:WEEKLY_NOW,updatedAt:WEEKLY_NOW,revokedAt:null} }
export function weeklyPolicy():ContentOperationAutopilotPolicyRow { return {id:4,ownerUserId:1,clientId:1,publicationTargetId:3,policyId:'policy-1',policyVersion:'governed-autopilot-policy-v4',mode:'balanced',websiteId:'website-1',authorizedByOwnerUserId:1,status:'enabled',authorizedAt:WEEKLY_NOW,expiresAt:new Date('2027-01-01T00:00:00Z'),revokedAt:null,allowedContentTypes:['article'],allowedLanguages:['zh-hant'],requireApprovedForDelivery:false,requirePassedRiskGate:true,cadenceDays:7,evidenceFreshnessHours:720,maximumRiskLevel:'general',requiredQualityGateVersion:'content-risk-gate-v1',allowedTargetIds:['primary'],allowedProviderModels:['qwen-plus'],allowedDestinations:['primary'],allowedCadences:[7],allowedRiskClasses:['general'],riskSemanticsVersion:'risk-severity-and-business-class-v1',maximumRiskSeverity:'moderate',allowedBusinessRiskClasses:['general'],entityStrategyProfileId:'entity-1',maximumRepairAttempts:1,maximumTopicSubstitutions:0,generationBudget:10,publicationBudget:10,generationBudgetUsed:0,publicationBudgetUsed:0,activatedAt:WEEKLY_NOW,configurationFingerprint:WEEKLY_HASH,createdAt:WEEKLY_NOW,updatedAt:WEEKLY_NOW} }
export class WeeklyFixture {
  state={client:{...fixtureClient(1,1),requireCustomerApproval:true,defaultCadenceDays:7},target:weeklyTarget(),policy:weeklyPolicy(),config:null as WeeklyConfig|null,binding:null as PrivateLineBinding|null,draft:{entryId:8,entryStatus:'ready_to_publish',jobId:9,draftId:10,draftVersion:1,contentType:'article',language:'zh-hant',title:'核准來源支持的文章',body:'這是 synthetic article，不是客戶資料。',contentHash:WEEKLY_HASH,evidenceSnapshotHash:WEEKLY_HASH,riskGateStatus:'passed',machineAuthorizationValid:true},requests:[] as WeeklyReviewRequest[],consents:[] as WeeklyConsent[],outbox:[] as WeeklyOutbox[],inbox:[] as WeeklyWebhookInbox[],invites:[] as LineBindingInvitation[],reserved:false,nextId:20,queued:0}
  private tail:Promise<void>=Promise.resolve()
  readonly repository:WeeklyContentRepository
  constructor() {
    const row=<T>(value:T)=>({...value,id:++this.state.nextId,createdAt:WEEKLY_NOW,updatedAt:WEEKLY_NOW})
    this.repository={
      transaction:async<T>(work:(repo:WeeklyContentRepository)=>Promise<T>):Promise<T>=>{const before=this.tail;let unlock!:()=>void;this.tail=new Promise<void>(resolve=>{unlock=resolve});await before;const snapshot=structuredClone(this.state);try{return await work(this.repository)}catch(error){this.state=snapshot;throw error}finally{unlock()}},
      lockJob:vi.fn(async(owner,job)=>{if(owner!==1||job!==this.state.draft.jobId)throw new Error('job scope')}),
      findClient:vi.fn(async(owner,id)=>owner===1&&id===1?this.state.client:null),
      requireClientApproval:vi.fn(async()=>{this.state.client.requireCustomerApproval=true}),
      getConfig:vi.fn(async(owner,client)=>owner===1&&client===1?this.state.config:null),
      saveConfig:vi.fn(async(value)=>this.state.config={...row(value),id:this.state.config?.id||this.state.nextId}),
      listConfigs:vi.fn(async(owner)=>owner===1&&this.state.config?[this.state.config]:[]),
      getTargetPolicy:vi.fn(async(owner,client,target,policy)=>owner===1&&client===1&&target===3&&policy===this.state.policy.policyId?{target:this.state.target,policy:this.state.policy}:null),
      findInbox:vi.fn(async(hash)=>this.state.inbox.find(value=>value.eventHash===hash)||null),
      insertInbox:vi.fn(async(value)=>{if(this.state.inbox.some(item=>item.eventHash===value.eventHash))throw new WeeklyWebhookInboxRaceError({cause:new Error('duplicate')});const saved=row(value);this.state.inbox.push(saved);return saved}),
      expireInvitations:vi.fn(async(owner,client,at)=>{for(const invite of this.state.invites)if(invite.ownerUserId===owner&&invite.clientId===client&&!invite.consumedAt)invite.expiresAt=at}),
      queuePublication:vi.fn(async()=>{this.state.queued++}),
      getDraft:vi.fn(async(owner,client,entry):Promise<WeeklyDraft|null>=>owner===1&&client===1&&entry===this.state.draft.entryId?{...this.state.draft,client:this.state.client,target:this.state.target,policy:this.state.policy}:null),
      insertInvitation:vi.fn(async(value)=>{const saved=row(value);this.state.invites.push(saved);return saved}),
      findInvitation:vi.fn(async(hash)=>this.state.invites.find(value=>value.tokenHash===hash)||null),
      consumeInvitation:vi.fn(async(id,fingerprint,eventHash,at)=>{const invite=this.state.invites.find(value=>value.id===id);if(!invite||invite.consumedAt||invite.expiresAt<=at)return false;Object.assign(invite,{bindingFingerprint:fingerprint,eventHash,consumedAt:at});return true}),
      getBinding:vi.fn(async(owner,client)=>owner===1&&client===1?this.state.binding:null),
      listActiveBindingsForLineUser:vi.fn(async(user:string):ReturnType<WeeklyContentRepository['listActiveBindingsForLineUser']>=>{
        const binding=this.state.binding
        const config=this.state.config
        if(!binding || binding.lineUserId!==user || binding.status!=='active' || !config || config.status!=='active' || this.state.client.status!=='active')return []
        return [{binding,client:this.state.client,config}]
      }),
      saveBinding:vi.fn(async(value)=>this.state.binding={...row(value),id:this.state.binding?.id||this.state.nextId}),
      getRequest:vi.fn(async(id)=>this.state.requests.find(value=>value.requestId===id)||null),
      findLatestRequestForEntry:vi.fn(async(owner,client,entry)=>this.state.requests.filter(value=>value.ownerUserId===owner&&value.clientId===client&&value.entryId===entry).at(-1)||null),
      getOutboxForRequest:vi.fn(async(id)=>this.state.outbox.find(value=>value.requestRowId===id)||null),
      getRequestByRowId:vi.fn(async(id)=>this.state.requests.find(value=>value.id===id)||null),
      findRequestByFingerprint:vi.fn(async(hash)=>this.state.requests.find(value=>value.requestFingerprint===hash)||null),
      findActiveRequest:vi.fn(async(owner,client,at)=>this.state.requests.find(value=>value.ownerUserId===owner&&value.clientId===client&&['pending','approved'].includes(value.status)&&value.expiresAt>at)||null),
      listApprovedRequests:vi.fn(async(owner)=>this.state.requests.filter(value=>value.ownerUserId===owner&&value.status==='approved')),
      insertRequest:vi.fn(async(value)=>{const saved=row(value);this.state.requests.push(saved);return saved}),
      updateRequest:vi.fn(async(id,status,at)=>{const found=this.state.requests.find(value=>value.id===id);if(found)Object.assign(found,{status,updatedAt:at})}),
      findConsentByEvent:vi.fn(async(hash)=>this.state.consents.find(value=>value.eventHash===hash)||null),
      latestConsent:vi.fn(async(id)=>this.state.consents.filter(value=>value.requestRowId===id).at(-1)||null),
      insertConsent:vi.fn(async(value)=>{const saved=row(value);this.state.consents.push(saved);return saved}),
      hasReservedPublication:vi.fn(async()=>this.state.reserved),
      enqueueOutbox:vi.fn(async(value)=>{const saved=row(value);this.state.outbox.push(saved);return saved}),
      claimOutbox:vi.fn(async()=>[]),reserveOutboxPayload:vi.fn(async()=>true),finishOutbox:vi.fn(async()=>true),
    }
  }
  deps(){return {repository:this.repository,featureEnabled:true,tokenKey:WEEKLY_KEY,now:WEEKLY_NOW}}
}

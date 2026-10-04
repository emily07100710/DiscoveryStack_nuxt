import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest'
import {getTableName} from 'drizzle-orm'
import {createContentOperationsRepositoryFromDatabase,type ContentOperationsRepository} from '../server/content-operations/repository'
import {stableFingerprint} from '../server/content-operations/normalization'
import {activateWeeklyReviewConfig,issueLineBindingInvite,claimLineBindingInvite,createReviewRequest,deriveReviewTokens,reviewFromVerifiedLine} from '../server/weekly-content/service'
import {WeeklyFixture,WEEKLY_NOW,WEEKLY_HASH,WEEKLY_KEY} from './fixtures/weekly-content/repository'

type Row=Record<string,unknown>
type Table=Parameters<typeof getTableName>[0]
async function setup(){
 const fixture=new WeeklyFixture(),deps=fixture.deps()
 await activateWeeklyReviewConfig({ownerUserId:1,clientId:1,publicationTargetId:3,policyId:'policy-1',idempotencyKey:'synthetic-config'},deps)
 const invitation=await issueLineBindingInvite({ownerUserId:1,clientId:1},deps)
 await claimLineBindingInvite({lineUserId:'U'+'1'.repeat(32),webhookEventId:'synthetic-bind',semanticFingerprint:WEEKLY_HASH,invitationToken:invitation.invitationToken},deps)
 await createReviewRequest({ownerUserId:1,clientId:1,entryId:8},deps)
 const request=fixture.state.requests[0]
 if(!request)throw new Error('Synthetic review request fixture was not created.')
 const tokens=deriveReviewTokens(request,WEEKLY_KEY)
 await reviewFromVerifiedLine({lineUserId:'U'+'1'.repeat(32),webhookEventId:'synthetic-consent',semanticFingerprint:WEEKLY_HASH,requestId:request.requestId,actionToken:tokens.actionToken,decision:'approved'},deps)
 const consent=fixture.state.consents[0]
 if(!consent)throw new Error('Synthetic approved consent fixture was not created.')
 const policy=fixture.state.policy,target=fixture.state.target
 const base={policy:{policyId:policy.policyId,policyVersion:policy.policyVersion,configurationFingerprint:policy.configurationFingerprint,ownerUserId:1,clientId:1,websiteId:'website-1'},candidate:{contentHash:WEEKLY_HASH},evidence:{snapshotHash:WEEKLY_HASH,status:'approved_fresh'},quality:{status:'passed',fingerprint:WEEKLY_HASH},target:{targetRowId:3,destinationId:'primary',configurationFingerprint:target.configurationFingerprint,identityVerified:true},lineage:{entryId:8,jobId:9,draftId:'10',entityProfileFingerprint:WEEKLY_HASH,queryOwnershipFingerprint:WEEKLY_HASH},decision:{action:'publish'}}
 const fingerprint=stableFingerprint(base)
 const authorization={ownerUserId:1,clientId:1,entryId:8,jobId:9,draftId:10,publicationTargetId:3,status:'executing',revokedAt:null,authorizationExpiresAt:new Date(WEEKLY_NOW.getTime()+900000),authorizationFingerprint:fingerprint,authorizationPayload:{...base,authorizationFingerprint:fingerprint},contentHash:WEEKLY_HASH,evidenceSnapshotHash:WEEKLY_HASH,qualityStatus:'passed',qualityFingerprint:WEEKLY_HASH,policyId:policy.policyId,policyVersion:policy.policyVersion,policyFingerprint:policy.configurationFingerprint,websiteId:'website-1',targetId:'primary',entityProfileFingerprint:WEEKLY_HASH,queryOwnershipFingerprint:WEEKLY_HASH}
 let rows=new Map<string,Row[]>([
  ['seoGeoContentJobs',[{id:9,ownerUserId:1}]],['contentOperationMachineAuthorizations',[authorization]],['contentOperationAutopilotPolicies',[policy]],['contentOperationPublicationTargets',[target]],['seoGeoContentReviews',[]],['seoGeoContentRiskGates',[{id:6,status:'passed'}]],['contentOperationClients',[fixture.state.client]],['weeklyContentConfigs',[fixture.state.config!]],['weeklyContentBindings',[fixture.state.binding!]],['weeklyContentReviewRequests',[request]],['weeklyContentConsents',[consent]],['contentOperationCalendarEntries',[{id:8,ownerUserId:1,status:'ready_to_publish',draftId:10,contentHash:WEEKLY_HASH,evidenceSnapshotHash:WEEKLY_HASH,contentType:'article',language:'zh-hant'}]],['seoGeoContentDrafts',[{id:10,version:1,contentHash:WEEKLY_HASH,title:'合成稿',body:'合成文章'}]],['contentOperationPublicationAttempts',[]],['contentOperationRuns',[{id:5,attemptNumber:1,state:'processing',leaseOwner:'synthetic-lease'}]],
 ])
 const reads=new Map<string,number>(),events:string[]=[]
 let onRead:((name:string,count:number)=>void)|undefined,onInsert:(()=>void)|undefined,insertCalls=0
 const tx={
  select:()=>({from:(table:Table)=>{const name=getTableName(table);const chain={where:(_v:unknown)=>chain,orderBy:(_v:unknown)=>chain,for:(_v:string)=>chain,limit:async()=>{const count=(reads.get(name)||0)+1;reads.set(name,count);onRead?.(name,count);return rows.get(name)||[]}};return chain}}),
  update:(table:Table)=>({set:(patch:Row)=>({where:async(_v:unknown)=>{for(const row of rows.get(getTableName(table))||[])Object.assign(row,patch);return [{affectedRows:1}]}})}),
  insert:(table:Table)=>({values:async(row:Row)=>{insertCalls++;rows.set(getTableName(table),[{...row,id:70}]);onInsert?.();return [{insertId:70}]}}),
 }
 const database={transaction:async<T>(work:(t:typeof tx)=>Promise<T>)=>{const snapshot=structuredClone(rows);events.push('begin');try{const result=await work(tx);events.push('commit');return result}catch(error){rows=snapshot;events.push('rollback');throw error}}}
 const repository=createContentOperationsRepositoryFromDatabase(database)
 const input:Parameters<ContentOperationsRepository['reservePublicationAttempt']>[0]={ownerUserId:1,clientId:1,entryId:8,jobId:9,draftId:10,targetId:3,contentHash:WEEKLY_HASH,evidenceSnapshotHash:WEEKLY_HASH,startedAt:WEEKLY_NOW,authorityReference:fingerprint,runId:5,leaseToken:'synthetic-lease',mode:'execute',attemptNumber:1,idempotencyKey:'synthetic-attempt',inputFingerprint:WEEKLY_HASH,publicationId:'publication-8',publicationSlug:'synthetic-article',publicationPath:'journal/zh-hant/articles/synthetic-article.md',publicationUrl:null,receiptLedger:null,publicationContentHash:WEEKLY_HASH,reviewId:null,riskGateId:6}
 return {repository,input,request,policy,authorization,events,reads,setRead:(fn:typeof onRead)=>{onRead=fn},setInsert:(fn:typeof onInsert)=>{onInsert=fn},rows:()=>rows,insertCalls:()=>insertCalls}
}
beforeEach(()=>{vi.stubEnv('NUXT_WEEKLY_CONTENT_APPROVAL_ENABLED','true');vi.useFakeTimers();vi.setSystemTime(WEEKLY_NOW)})
afterEach(()=>{vi.useRealTimers();vi.unstubAllEnvs()})
const boundary=()=>new Date(WEEKLY_NOW.getTime()+1000)
describe('fresh clock at the real shared publication reservation',()=>{
 it.each(['job','request','ledger'] as const)('rejects consent that expires during the %s read instead of trusting startedAt',async phase=>{
  const f=await setup();f.request.expiresAt=boundary()
  f.setRead((name,count)=>{if((phase==='job'&&name==='seoGeoContentJobs')||(phase==='request'&&name==='weeklyContentReviewRequests')||(phase==='ledger'&&name==='contentOperationPublicationAttempts'&&count===1))vi.setSystemTime(boundary())})
  await expect(f.repository.reservePublicationAttempt(f.input)).rejects.toThrow('WEEKLY_CUSTOMER_APPROVAL_REQUIRED')
  expect(f.insertCalls()).toBe(0);expect(f.rows().get('contentOperationPublicationAttempts')).toEqual([]);expect(f.rows().get('contentOperationCalendarEntries')?.[0]?.status).toBe('ready_to_publish');expect(f.events.at(-1)).toBe('rollback')
 })
 it.each(['machine','policy'] as const)('rechecks %s expiry after all weekly authority locks have completed',async kind=>{
  const f=await setup();if(kind==='machine')f.authorization.authorizationExpiresAt=boundary();else f.policy.expiresAt=boundary()
  f.setRead(name=>{if(name==='weeklyContentReviewRequests')vi.setSystemTime(boundary())})
  await expect(f.repository.reservePublicationAttempt(f.input)).rejects.toThrow(kind==='machine'?'Publication approval changed':'WEEKLY_CUSTOMER_APPROVAL_REQUIRED')
  expect(f.insertCalls()).toBe(0);expect(f.events.at(-1)).toBe('rollback')
 })
 it('rolls back a staged ledger and publishing status if consent expires while INSERT waits',async()=>{
  const f=await setup();f.request.expiresAt=boundary();f.setInsert(()=>vi.setSystemTime(boundary()))
  await expect(f.repository.reservePublicationAttempt(f.input)).rejects.toThrow('WEEKLY_CUSTOMER_APPROVAL_REQUIRED')
  expect(f.insertCalls()).toBe(1);expect(f.rows().get('contentOperationPublicationAttempts')).toEqual([]);expect(f.rows().get('contentOperationCalendarEntries')?.[0]?.status).toBe('ready_to_publish');expect(f.events.at(-1)).toBe('rollback')
 })
 it('keeps stable audit startedAt and one ledger when the fresh authority clock is valid',async()=>{
  const f=await setup();vi.setSystemTime(new Date(WEEKLY_NOW.getTime()+100))
  const first=await f.repository.reservePublicationAttempt(f.input),second=await f.repository.reservePublicationAttempt(f.input)
  expect(first.replayed).toBe(false);expect(second.replayed).toBe(true);expect(second.attempt.id).toBe(first.attempt.id);expect(first.attempt.startedAt).toEqual(WEEKLY_NOW);expect(f.insertCalls()).toBe(1);expect(f.events).toEqual(['begin','commit','begin','commit'])
 })
 it('does not let an existing idempotent reservation bypass an expired consent',async()=>{
  const f=await setup();await f.repository.reservePublicationAttempt(f.input);f.request.expiresAt=boundary()
  f.setRead((name,count)=>{if(name==='contentOperationPublicationAttempts'&&count>=3)vi.setSystemTime(boundary())})
  await expect(f.repository.reservePublicationAttempt(f.input)).rejects.toThrow('WEEKLY_CUSTOMER_APPROVAL_REQUIRED')
  expect(f.insertCalls()).toBe(1);expect(f.rows().get('contentOperationPublicationAttempts')).toHaveLength(1);expect(f.events.at(-1)).toBe('rollback')
 })
})

import {createApp,createError,createRouter,defineEventHandler,getHeader,send,setResponseStatus,toWebHandler,type EventHandler} from 'h3'
import {afterAll,afterEach,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest'
import {WeeklyFixture,WEEKLY_NOW,WEEKLY_KEY} from './fixtures/weekly-content/repository'
const seams=vi.hoisted(()=>({owner:vi.fn(),ownerDatabaseId:vi.fn(),repository:vi.fn(),initialCalendar:vi.fn(),planner:vi.fn(),ops:vi.fn(),database:vi.fn()}))
vi.mock('../server/utils/auth',()=>({requireOwner:seams.owner}))
vi.mock('../server/audit/repository',()=>({getOwnerDatabaseUserId:seams.ownerDatabaseId}))
vi.mock('../server/weekly-content/repository',async original=>({...await original<typeof import('../server/weekly-content/repository')>(),createWeeklyContentRepository:seams.repository}))
vi.mock('../server/weekly-content/planner',()=>({createInitialWeeklyCalendar:seams.initialCalendar,productionWeeklyPlannerDependencies:seams.planner}))
vi.mock('../server/content-operations/repository',()=>({createContentOperationsRepository:seams.ops}))
vi.mock('../server/database',()=>({getDatabase:seams.database}))
const ORIGIN='https://synthetic-weekly-owner.taipei'
let fixture:WeeklyFixture
let activate:EventHandler,calendar:EventHandler,reopen:EventHandler,invite:EventHandler,requireApproval:EventHandler,workspace:EventHandler
beforeAll(async()=>{
 vi.stubGlobal('defineEventHandler',defineEventHandler)
 activate=(await import('../server/api/weekly-content/clients/[id]/activate.post')).default
 calendar=(await import('../server/api/weekly-content/clients/[id]/calendar.post')).default
 reopen=(await import('../server/api/weekly-content/entries/[id]/reopen.post')).default
 invite=(await import('../server/api/weekly-content/clients/[id]/invitation.post')).default
 requireApproval=(await import('../server/api/weekly-content/clients/[id]/require-approval.post')).default
 workspace=(await import('../server/api/weekly-content/workspace.get')).default
})
beforeEach(()=>{
 vi.clearAllMocks();vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(WEEKLY_NOW)
 vi.stubEnv('NUXT_WEEKLY_CONTENT_APPROVAL_ENABLED','true');vi.stubEnv('NUXT_WEEKLY_CONTENT_TOKEN_KEY',WEEKLY_KEY);vi.stubEnv('NUXT_WEEKLY_CONTENT_REVIEW_ORIGIN',ORIGIN)
 fixture=new WeeklyFixture();seams.repository.mockReturnValue(fixture.repository)
 seams.owner.mockImplementation(async event=>{const session=getHeader(event,'x-test-owner-session');if(!session)throw createError({statusCode:401,statusMessage:'synthetic-private-auth'});if(!['synthetic-owner-1','synthetic-owner-2'].includes(session))throw createError({statusCode:403,statusMessage:'synthetic-private-forbidden'});return {openId:session}})
 seams.ownerDatabaseId.mockImplementation(async openId=>openId==='synthetic-owner-1'?1:2)
 seams.planner.mockReturnValue({syntheticOnly:true});seams.initialCalendar.mockResolvedValue({calendar:{id:31},entries:[{id:32}]})
 seams.ops.mockReturnValue({listClients:vi.fn(async(owner:number)=>owner===1?[fixture.state.client]:[]),listPublicationTargets:vi.fn(async()=>[]),listAutopilotPolicies:vi.fn(async()=>[]),listCalendars:vi.fn(async()=>[])})
 const query={from:vi.fn().mockReturnThis(),leftJoin:vi.fn().mockReturnThis(),where:vi.fn().mockReturnThis(),orderBy:vi.fn().mockReturnThis(),limit:vi.fn(async()=>[])}
 seams.database.mockReturnValue({select:vi.fn(()=>query)})
})
afterEach(()=>{vi.useRealTimers();vi.unstubAllEnvs()})
afterAll(()=>{vi.unstubAllGlobals()})
function http(){
 const app=createApp({debug:false,onError:async(error,event)=>{setResponseStatus(event,error.statusCode || 500);await send(event,JSON.stringify({statusCode:error.statusCode,statusMessage:error.statusMessage}),'application/json')}})
 const router=createRouter();router.post('/api/weekly-content/clients/:id/activate',activate);router.post('/api/weekly-content/clients/:id/calendar',calendar);router.post('/api/weekly-content/entries/:id/reopen',reopen);router.post('/api/weekly-content/clients/:id/invitation',invite);router.post('/api/weekly-content/clients/:id/require-approval',requireApproval);router.get('/api/weekly-content/workspace',workspace);app.use(router)
 const web=toWebHandler(app)
 return async(path:string,body?:unknown,options:{origin?:string|null;owner?:string|null;contentType?:string;raw?:string}={})=>{
  const origin=options.origin===undefined?ORIGIN:options.origin,owner=options.owner===undefined?'synthetic-owner-1':options.owner
  const res=await web(new Request(ORIGIN+path,{method:body===undefined?'GET':'POST',headers:{'content-type':options.contentType || 'application/json',...(origin===null?{}:{origin}),...(owner===null?{}:{'x-test-owner-session':owner})},...(body===undefined?{}:{body:options.raw ?? JSON.stringify(body)})}))
  const text=await res.text();return {res,value:text?JSON.parse(text):null}
 }
}
const ACTIVATE={publicationTargetId:3,policyId:'policy-1',reviewTtlHours:72,idempotencyKey:'synthetic-owner-activation'}
const CALENDAR={productionPlanId:5,startDate:'2026-10-05',publishLocalTime:'10:00',monthlyArticleLimit:4}
const path='/api/weekly-content/clients/1/activate'
describe('weekly owner real HTTP boundary with synthetic auth/database',()=>{
 it.each([null,'https://foreign-site.taipei','null','https://synthetic-weekly-owner.taipei.evil.taipei'])('rejects a missing or foreign mutation origin before resolving owner or repositories',async origin=>{
  const result=await http()(path,ACTIVATE,{origin})
  expect(result.res.status).toBe(403);expect(seams.owner).not.toHaveBeenCalled();expect(seams.ownerDatabaseId).not.toHaveBeenCalled();expect(seams.repository).not.toHaveBeenCalled();expect(fixture.state.config).toBeNull()
 })
 it.each(['text/plain','application/x-www-form-urlencoded','multipart/form-data','application/jsonp'])('rejects a non-JSON mutation before auth for %s',async contentType=>{
  expect((await http()(path,ACTIVATE,{contentType})).res.status).toBe(403);expect(seams.owner).not.toHaveBeenCalled();expect(seams.repository).not.toHaveBeenCalled()
 })
 it('rejects unauthenticated and forbidden sessions without constructing business storage',async()=>{
  const call=http();expect((await call(path,ACTIVATE,{owner:null})).res.status).toBe(401);expect((await call(path,ACTIVATE,{owner:'synthetic-invalid-owner'})).res.status).toBe(403)
  expect(seams.ownerDatabaseId).not.toHaveBeenCalled();expect(seams.repository).not.toHaveBeenCalled();expect(fixture.state.config).toBeNull()
 })
 it('derives the owner from the session, returns only redacted configuration and protects owner responses',async()=>{
  const result=await http()(path,ACTIVATE)
  expect(result.res.status).toBe(200);expect(result.value.config).toMatchObject({clientId:1,status:'active',requireCustomerApproval:true})
  expect(fixture.state.config?.ownerUserId).toBe(1);expect(seams.ownerDatabaseId).toHaveBeenCalledWith('synthetic-owner-1')
  expect(result.res.headers.get('cache-control')).toContain('no-store');expect(result.res.headers.get('referrer-policy')).toBe('no-referrer');expect(result.res.headers.get('x-robots-tag')).toContain('noindex')
  for(const field of ['lineUserId','readToken','actionToken','invitationToken','tokenKey'])expect(result.value.config).not.toHaveProperty(field)
 })
 it('does not let a second owner activate the first owner client and does not return raw internal errors',async()=>{
  const result=await http()(path,ACTIVATE,{owner:'synthetic-owner-2'})
  expect(result.res.status).toBe(404);expect(fixture.state.config).toBeNull();expect(JSON.stringify(result.value)).not.toContain('WEEKLY_CLIENT_NOT_AVAILABLE')
 })
 it.each([{ownerUserId:2},{lineUserId:'synthetic-forwarded-user'},{tokenKey:'synthetic-payload-key'},{requireCustomerApproval:false}])('rejects owner/recipient/secret/approval override fields in a strict activation payload',async change=>{
  expect((await http()(path,{...ACTIVATE,...change})).res.status).toBe(422);expect(seams.repository).not.toHaveBeenCalled();expect(fixture.state.config).toBeNull()
 })
 it('rejects oversized raw JSON even when its parsed value would be small',async()=>{
  const result=await http()(path,ACTIVATE,{raw:JSON.stringify(ACTIVATE)+' '.repeat(4096)})
  expect(result.res.status).toBe(413);expect(seams.repository).not.toHaveBeenCalled();expect(fixture.state.config).toBeNull()
 })
 it('treats malformed JSON as a bounded client error without business writes',async()=>{
  const result=await http()(path,null,{raw:'{malformed-json'})
  expect(result.res.status).toBe(422);expect(seams.repository).not.toHaveBeenCalled();expect(fixture.state.config).toBeNull()
 })
 it('derives calendar scope from owner session and path before reaching the canonical locked planner',async()=>{
  expect((await http()('/api/weekly-content/clients/1/calendar',CALENDAR)).res.status).toBe(200)
  expect(seams.initialCalendar).toHaveBeenCalledExactlyOnceWith(1,1,CALENDAR,WEEKLY_NOW,{syntheticOnly:true})
 })
 it('rejects external calendar owner/client authority and invalid path IDs before planner construction',async()=>{
  const call=http()
  expect((await call('/api/weekly-content/clients/1/calendar',{...CALENDAR,ownerUserId:2,clientId:2})).res.status).toBe(422)
  expect((await call('/api/weekly-content/clients/not-an-id/calendar',CALENDAR)).res.status).toBe(422)
  expect(seams.planner).not.toHaveBeenCalled();expect(seams.initialCalendar).not.toHaveBeenCalled()
 })
 it('uses an explicit owner reopen without inheriting the old customer consent',async()=>{
  const actual=await import('../server/weekly-content/service')
  await actual.activateWeeklyReviewConfig({ownerUserId:1,clientId:1,...ACTIVATE},fixture.deps())
  const invitation=await actual.issueLineBindingInvite({ownerUserId:1,clientId:1},fixture.deps())
  await actual.claimLineBindingInvite({invitationToken:invitation.invitationToken,lineUserId:`U${'1'.repeat(32)}`,webhookEventId:'synthetic-bind-event',semanticFingerprint:'a'.repeat(64)},fixture.deps())
  await actual.createReviewRequest({ownerUserId:1,clientId:1,entryId:fixture.state.draft.entryId},fixture.deps())
  fixture.state.outbox[0]!.status='failed'
  const result=await http()(`/api/weekly-content/entries/${fixture.state.draft.entryId}/reopen`,{clientId:1,idempotencyKey:'synthetic-owner-reopen'})
  expect(result.res.status).toBe(200);expect(fixture.state.requests).toHaveLength(2);expect(fixture.state.requests[0]?.status).toBe('revoked');expect(fixture.state.requests[1]?.status).toBe('pending')
  expect(fixture.state.consents).toHaveLength(0);expect(fixture.state.queued).toBe(0)
  expect(result.value.request).not.toHaveProperty('readToken');expect(result.value.request).not.toHaveProperty('actionToken')
  const replay=await http()(`/api/weekly-content/entries/${fixture.state.draft.entryId}/reopen`,{clientId:1,idempotencyKey:'synthetic-owner-reopen'})
  expect(replay.value.replayed).toBe(true);expect(fixture.state.requests).toHaveLength(2)
 })
 it('protects all publishing paths before creating a weekly policy, with explicit one-way owner consent',async()=>{
  fixture.state.client.requireCustomerApproval=false
  const result=await http()('/api/weekly-content/clients/1/require-approval',{consent:true})
  expect(result.res.status).toBe(200);expect(result.value).toEqual({clientId:1,requireCustomerApproval:true});expect(fixture.state.client.requireCustomerApproval).toBe(true);expect(fixture.state.config).toBeNull();expect(fixture.state.binding).toBeNull()
  const replay=await http()('/api/weekly-content/clients/1/require-approval',{consent:true});expect(replay.res.status).toBe(200);expect(fixture.state.client.requireCustomerApproval).toBe(true)
 })
 it.each([{}, {consent:false}, {consent:true,requireCustomerApproval:false}, {consent:true,ownerUserId:2}])('rejects missing consent or flag authority overrides %j',async body=>{
  fixture.state.client.requireCustomerApproval=false
  expect((await http()('/api/weekly-content/clients/1/require-approval',body)).res.status).toBe(422);expect(fixture.state.client.requireCustomerApproval).toBe(false);expect(seams.repository).not.toHaveBeenCalled()
 })
 it('cannot protect another owner customer through a client path override',async()=>{
  fixture.state.client.requireCustomerApproval=false
  expect((await http()('/api/weekly-content/clients/1/require-approval',{consent:true},{owner:'synthetic-owner-2'})).res.status).toBe(404);expect(fixture.state.client.requireCustomerApproval).toBe(false)
 })
 it('maps unexpected storage details to a fixed public error',async()=>{
  seams.repository.mockImplementationOnce(()=>{throw new Error('synthetic-private-database-query-and-token')})
  const result=await http()(path,ACTIVATE)
  expect(result.res.status).toBe(503);expect(JSON.stringify(result.value)).not.toContain('private-database-query');expect(fixture.state.config).toBeNull()
 })
 it('issues an identity-only invitation before weekly activation without approval, policy, budget or publication writes',async()=>{
  fixture.state.client.requireCustomerApproval=false
  const beforeBudget=fixture.state.client.monthlyBudgetUnits
  const result=await http()('/api/weekly-content/clients/1/invitation',{})
  expect(result.res.status).toBe(200);expect(result.value.purpose).toBe('identity_binding');expect(result.value.invitationToken).toMatch(/^wli_[A-Za-z0-9_-]{32}$/)
  expect(Date.parse(result.value.expiresAt)-WEEKLY_NOW.getTime()).toBe(10*60_000)
  expect(result.value.connectUrl).toBe(`${ORIGIN}/weekly-content/connect`)
  expect(fixture.state.client.requireCustomerApproval).toBe(false);expect(fixture.state.client.monthlyBudgetUnits).toBe(beforeBudget);expect(fixture.state.config).toBeNull()
  expect(fixture.repository.getConfig).not.toHaveBeenCalled();expect(fixture.repository.getTargetPolicy).not.toHaveBeenCalled();expect(fixture.repository.saveConfig).not.toHaveBeenCalled();expect(fixture.repository.requireClientApproval).not.toHaveBeenCalled()
  expect(fixture.state.requests).toHaveLength(0);expect(fixture.state.consents).toHaveLength(0);expect(fixture.state.outbox).toHaveLength(0);expect(fixture.state.queued).toBe(0)
 })
 it('keeps invitation issue restricted to the authenticated owner and active customer',async()=>{
  const call=http()
  expect((await call('/api/weekly-content/clients/1/invitation',{}, {owner:'synthetic-owner-2'})).res.status).toBe(404)
  fixture.state.client.status='paused'
  expect((await call('/api/weekly-content/clients/1/invitation',{})).res.status).toBe(404);expect(fixture.state.invites).toHaveLength(0);expect(fixture.state.config).toBeNull()
 })
 it.each([{ownerUserId:2},{clientId:2},{lineUserId:'synthetic-forwarded-user'},{purpose:'article_approval'}])('rejects identity invitation authority overrides %j',async body=>{
  expect((await http()('/api/weekly-content/clients/1/invitation',body)).res.status).toBe(422);expect(fixture.state.invites).toHaveLength(0);expect(seams.repository).not.toHaveBeenCalled()
 })
 it('projects identity binding on the owned client without a weekly configuration or private recipient fields',async()=>{
  fixture.state.client.requireCustomerApproval=false
  const actual=await import('../server/weekly-content/service'),call=http()
  const first=await call('/api/weekly-content/workspace')
  expect(first.res.status).toBe(200);expect(first.value.clients).toEqual([{id:1,displayName:fixture.state.client.displayName,canonicalSiteOrigin:fixture.state.client.canonicalSiteOrigin,status:'active',lineBound:false,requiresCustomerApproval:false}]);expect(first.value.configs).toEqual([])
  const invitation=await actual.issueLineBindingInvite({ownerUserId:1,clientId:1},fixture.deps()),recipient=`U${'1'.repeat(32)}`
  await actual.claimLineBindingInvite({invitationToken:invitation.invitationToken,lineUserId:recipient,webhookEventId:'synthetic-workspace-identity',semanticFingerprint:'a'.repeat(64)},fixture.deps())
  const bound=await call('/api/weekly-content/workspace')
  expect(bound.value.clients[0].lineBound).toBe(true);expect(bound.value.clients[0].requiresCustomerApproval).toBe(false);expect(bound.value.configs).toEqual([])
  expect(JSON.stringify(bound.value)).not.toContain(recipient);expect(JSON.stringify(bound.value)).not.toContain(invitation.invitationToken);expect(bound.res.headers.get('cache-control')).toContain('no-store')
  expect(fixture.state.config).toBeNull();expect(fixture.state.requests).toHaveLength(0);expect(fixture.state.consents).toHaveLength(0);expect(fixture.state.outbox).toHaveLength(0);expect(fixture.state.queued).toBe(0)
  fixture.state.client.status='paused';expect((await call('/api/weekly-content/workspace')).value.clients[0].lineBound).toBe(false)
 })
 it('filters foreign-owner client seams before any binding lookup or DTO projection',async()=>{
  seams.ops.mockReturnValueOnce({listClients:vi.fn(async()=>[{...fixture.state.client,ownerUserId:2}]),listPublicationTargets:vi.fn(async()=>[]),listCalendars:vi.fn(async()=>[])})
  const result=await http()('/api/weekly-content/workspace')
  expect(result.res.status).toBe(200);expect(result.value.clients).toEqual([]);expect(fixture.repository.getBinding).not.toHaveBeenCalled();expect(JSON.stringify(result.value)).not.toContain(fixture.state.client.canonicalSiteOrigin)
 })
})

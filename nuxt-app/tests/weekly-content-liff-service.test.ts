import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { activateWeeklyReviewConfig, issueLineBindingInvite, claimLineBindingInvite, createReviewRequest, deriveReviewTokens, reviewFromVerifiedLine } from '../server/weekly-content/service'
import { confirmWeeklyLiffConnection, getWeeklyLiffConnectContext, weeklyLiffConfiguration, projectWeeklyLiffConfiguration, type WeeklyLiffDependencies } from '../server/weekly-content/liff-service'
import { MySqlDialect } from 'drizzle-orm/mysql-core'
import { sql, type SQL } from 'drizzle-orm'
import { createWeeklyContentRepositoryFromDatabase } from '../server/weekly-content/repository'
import { WeeklyFixture, WEEKLY_NOW, WEEKLY_KEY } from './fixtures/weekly-content/repository'
const USER=`U${'1'.repeat(32)}`,OTHER=`U${'2'.repeat(32)}`,TOKEN='synthetic.header.signature'
const ENV={NUXT_WEEKLY_CONTENT_APPROVAL_ENABLED:'true',NUXT_WEEKLY_CONTENT_LIFF_ENABLED:'true',NUXT_WEEKLY_CONTENT_LIFF_ID:'2001234567-Abcd1234',NUXT_WEEKLY_CONTENT_LINE_LOGIN_CHANNEL_ID:'2001234567',NUXT_WEEKLY_CONTENT_TOKEN_KEY:WEEKLY_KEY,NUXT_WEEKLY_CONTENT_REVIEW_ORIGIN:'https://synthetic-weekly.taipei'}
let f:WeeklyFixture,deps:WeeklyLiffDependencies,raw:string
function official(user=USER){return new Response(JSON.stringify({iss:'https://access.line.me',aud:'2001234567',sub:user,iat:Math.floor(WEEKLY_NOW.getTime()/1000)-100,exp:Math.floor(WEEKLY_NOW.getTime()/1000)+3500}),{headers:{'content-type':'application/json'}})}
beforeEach(async()=>{f=new WeeklyFixture();await activateWeeklyReviewConfig({ownerUserId:1,clientId:1,publicationTargetId:3,policyId:'policy-1',idempotencyKey:'activation'},f.deps());raw=(await issueLineBindingInvite({ownerUserId:1,clientId:1},f.deps())).invitationToken;deps={configuration:weeklyLiffConfiguration(ENV),repository:vi.fn(()=>f.repository),fetchImpl:vi.fn(async()=>official()),now:WEEKLY_NOW}})
afterEach(()=>vi.useRealTimers())
async function input(){const ctx=await getWeeklyLiffConnectContext({idToken:TOKEN,invitationToken:raw},deps);if(ctx.mode!=='invitation')throw new Error('fixture context');return {idToken:TOKEN,invitationToken:raw,confirmationToken:ctx.confirmationToken,consent:true}}
describe('LIFF connects only the verified sender and exact invited company',()=>{
 it('defaults off and exposes only minimal public SDK configuration',()=>{expect(weeklyLiffConfiguration({})).toEqual({enabled:false});const publicConfig=projectWeeklyLiffConfiguration(deps.configuration);expect(publicConfig).toEqual({enabled:true,liffId:ENV.NUXT_WEEKLY_CONTENT_LIFF_ID,origin:ENV.NUXT_WEEKLY_CONTENT_REVIEW_ORIGIN,connectPath:'/weekly-content/connect',scopes:['openid']});expect(publicConfig).not.toHaveProperty('tokenKey');expect(publicConfig).not.toHaveProperty('channelId')})
 it.each([{NUXT_WEEKLY_CONTENT_LIFF_ENABLED:'TRUE'},{NUXT_WEEKLY_CONTENT_APPROVAL_ENABLED:'false'},{NUXT_WEEKLY_CONTENT_LIFF_ID:'bad'},{NUXT_WEEKLY_CONTENT_LINE_LOGIN_CHANNEL_ID:''},{NUXT_WEEKLY_CONTENT_REVIEW_ORIGIN:'http://synthetic-weekly.taipei'},{NUXT_WEEKLY_CONTENT_REVIEW_ORIGIN:'https://synthetic-weekly.taipei/path'},{NUXT_WEEKLY_CONTENT_TOKEN_KEY:'short'}])('fails malformed/missing configuration closed %j',change=>{expect(weeklyLiffConfiguration({...ENV,...change})).toEqual({enabled:false})})
 it('disabled context and confirm perform zero provider/storage I/O',async()=>{deps.configuration={enabled:false};await expect(getWeeklyLiffConnectContext({},deps)).rejects.toMatchObject({statusCode:503});await expect(confirmWeeklyLiffConnection({},deps)).rejects.toMatchObject({statusCode:503});expect(deps.fetchImpl).not.toHaveBeenCalled();expect(deps.repository).not.toHaveBeenCalled()})
 it('verifies identity before invitation or binding lookup; rejected ID token cannot reveal a company',async()=>{deps.fetchImpl=vi.fn(async()=>new Response('private-error',{status:400}));await expect(getWeeklyLiffConnectContext({idToken:TOKEN,invitationToken:raw},deps)).rejects.toMatchObject({statusCode:401});expect(deps.repository).not.toHaveBeenCalled()})
 it('read-only context discloses only exact company and expiry, without consuming invitation',async()=>{const ctx=await getWeeklyLiffConnectContext({idToken:TOKEN,invitationToken:raw},deps);expect(ctx).toMatchObject({mode:'invitation',company:{displayName:f.state.client.displayName,canonicalSiteOrigin:f.state.client.canonicalSiteOrigin},expiresAt:f.state.invites[0]!.expiresAt.toISOString()});expect(f.state.binding).toBeNull();expect(f.state.inbox).toHaveLength(0);expect(f.state.invites[0]!.consumedAt).toBeNull();for(const field of ['ownerUserId','clientId','lineUserId','idToken','invitationToken'])expect(ctx).not.toHaveProperty(field)})
 it('explicit confirmation binds through actual core once and stable token-independent replay creates one inbox',async()=>{const value=await input();const results=await Promise.all([confirmWeeklyLiffConnection(value,deps),confirmWeeklyLiffConnection({...value,idToken:'new.header.signature'},deps)]);expect(results.map(row=>row.status).sort()).toEqual(['bound','replayed']);expect(f.state.binding?.lineUserId).toBe(USER);expect(f.state.inbox).toHaveLength(1);expect(f.state.consents).toHaveLength(0);expect(f.state.outbox).toHaveLength(0);expect(JSON.stringify(f.state.inbox)).not.toContain(TOKEN);expect(JSON.stringify(f.state.inbox)).not.toContain(USER);expect(f.state.inbox[0]!.resultCode).toBe('LINE_BOUND')})
 it.each([{ownerUserId:2},{clientId:2},{lineUserId:OTHER},{webhookEventId:'caller-event'},{company:{displayName:'caller'}}])('rejects all browser authority fields %j',async field=>{await expect(getWeeklyLiffConnectContext({idToken:TOKEN,invitationToken:raw,...field},deps)).rejects.toThrow();await expect(confirmWeeklyLiffConnection({...await input(),...field},deps)).rejects.toThrow();expect(f.state.binding).toBeNull()})
 it('requires exact true consent and server confirmation; preview is never binding',async()=>{const value=await input();for(const change of [{consent:false},{consent:'true'},{confirmationToken:'a'.repeat(43)}])await expect(confirmWeeklyLiffConnection({...value,...change},deps)).rejects.toThrow();expect(f.state.binding).toBeNull()})
 it.each(['name','origin','config','paused','expired','archived'] as const)('transaction rechecks %s before any core claim',async kind=>{const value=await input();if(kind==='name')f.state.client.displayName='Changed company';if(kind==='origin')f.state.client.canonicalSiteOrigin='https://different-company.taipei';if(kind==='config')f.state.config!.configurationFingerprint='b'.repeat(64);if(kind==='paused')f.state.config!.status='paused';if(kind==='expired')f.state.invites[0]!.expiresAt=WEEKLY_NOW;if(kind==='archived')f.state.client.status='archived';await expect(confirmWeeklyLiffConnection(value,deps)).rejects.toMatchObject({statusCode:409});expect(f.state.binding).toBeNull();expect(f.state.inbox).toHaveLength(0)})
 it('another verified sender cannot reuse the displayed company confirmation',async()=>{const value=await input();deps.fetchImpl=vi.fn(async()=>official(OTHER));await expect(confirmWeeklyLiffConnection(value,deps)).rejects.toMatchObject({statusCode:409});expect(f.state.binding).toBeNull()})
 it('no-invite context returns only this verified sender active bindings, never a customer directory',async()=>{expect(await getWeeklyLiffConnectContext({idToken:TOKEN},deps)).toEqual({mode:'bindings',companies:[]});await confirmWeeklyLiffConnection(await input(),deps);expect(await getWeeklyLiffConnectContext({idToken:TOKEN},deps)).toEqual({mode:'bindings',companies:[{displayName:f.state.client.displayName,canonicalSiteOrigin:f.state.client.canonicalSiteOrigin}]});deps.fetchImpl=vi.fn(async()=>official(OTHER));expect(await getWeeklyLiffConnectContext({idToken:TOKEN},deps)).toEqual({mode:'bindings',companies:[]})})
 it('filters stale or cross-owner binding records even at a synthetic repository seam',async()=>{await confirmWeeklyLiffConnection(await input(),deps);const valid={binding:f.state.binding!,client:f.state.client,config:f.state.config!};vi.mocked(f.repository.listActiveBindingsForLineUser).mockResolvedValue([valid,{...valid,binding:{...valid.binding,lineUserId:OTHER}},{...valid,config:{...valid.config,status:'paused'}},{...valid,client:{...valid.client,ownerUserId:2}}]);expect((await getWeeklyLiffConnectContext({idToken:TOKEN},deps))).toEqual({mode:'bindings',companies:[{displayName:f.state.client.displayName,canonicalSiteOrigin:f.state.client.canonicalSiteOrigin}]});expect(f.repository.listActiveBindingsForLineUser).toHaveBeenLastCalledWith(USER,20)})
 it('does not disclose an already consumed invitation to another sender',async()=>{await confirmWeeklyLiffConnection(await input(),deps);deps.fetchImpl=vi.fn(async()=>official(OTHER));await expect(getWeeklyLiffConnectContext({idToken:TOKEN,invitationToken:raw},deps)).rejects.toMatchObject({statusCode:409})})
 it('verified ID token exp is rechecked after SQL lock waits before binding',async()=>{
   vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(WEEKLY_NOW);deps.now=undefined
   deps.fetchImpl=vi.fn(async()=>new Response(JSON.stringify({iss:'https://access.line.me',aud:'2001234567',sub:USER,iat:Math.floor(WEEKLY_NOW.getTime()/1000)-3570,exp:Math.floor(WEEKLY_NOW.getTime()/1000)+30}),{headers:{'content-type':'application/json'}}))
   const value=await input();const original=f.repository.findClient
   f.repository.findClient=async(owner,client,lock)=>{if(lock)vi.setSystemTime(new Date(WEEKLY_NOW.getTime()+30000));return original(owner,client,lock)}
   await expect(confirmWeeklyLiffConnection(value,deps)).rejects.toMatchObject({statusCode:401});expect(f.state.binding).toBeNull();expect(f.state.inbox).toHaveLength(0)
 })
 it('invitation expiry is rechecked after the final LIFF binding lock',async()=>{
   vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(WEEKLY_NOW);deps.now=undefined
   const value=await input(),original=f.repository.getBinding
   f.repository.getBinding=async(owner,client,lock)=>{if(lock)vi.setSystemTime(f.state.invites[0]!.expiresAt);return original(owner,client,lock)}
   await expect(confirmWeeklyLiffConnection(value,deps)).rejects.toMatchObject({statusCode:409});expect(f.state.binding).toBeNull();expect(f.state.inbox).toHaveLength(0)
 })
 it('legacy webhook claim also rejects an invitation that expires during SQL lock waits',async()=>{
   vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(WEEKLY_NOW);const original=f.repository.getBinding
   f.repository.getBinding=async(owner,client,lock)=>{if(lock)vi.setSystemTime(f.state.invites[0]!.expiresAt);return original(owner,client,lock)}
   await expect(claimLineBindingInvite({lineUserId:USER,webhookEventId:'lock-wait-synthetic',semanticFingerprint:'a'.repeat(64),invitationToken:raw},{...f.deps(),now:undefined})).rejects.toThrow('WEEKLY_INVITATION_EXPIRED')
   expect(f.state.binding).toBeNull();expect(f.state.inbox).toHaveLength(0);expect(f.repository.consumeInvitation).not.toHaveBeenCalled()
 })
 it('issued invitation gets its whole ten-minute TTL after client/config locks complete',async()=>{
   vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(WEEKLY_NOW);const later=new Date(WEEKLY_NOW.getTime()+45000),original=f.repository.getConfig
   f.repository.getConfig=async(owner,client,lock)=>{if(lock)vi.setSystemTime(later);return original(owner,client,lock)}
   const invite=await issueLineBindingInvite({ownerUserId:1,clientId:1},{...f.deps(),now:undefined})
   expect(Date.parse(invite.expiresAt)).toBe(later.getTime()+600000)
 })
 it.each(['job','binding','reservation'] as const)('article consent rejects expiry reached during %s wait without writing consent or queue',async wait=>{
   await confirmWeeklyLiffConnection(await input(),deps)
   const created=await createReviewRequest({ownerUserId:1,clientId:1,entryId:8},f.deps()),request=f.state.requests.find(row=>row.requestId===created.request.requestId)!,actionToken=deriveReviewTokens(request,WEEKLY_KEY).actionToken
   vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(new Date(request.expiresAt.getTime()-30000))
   if(wait==='job'){const original=f.repository.lockJob;f.repository.lockJob=async(owner,job)=>{vi.setSystemTime(request.expiresAt);return original(owner,job)}}
   if(wait==='binding'){const original=f.repository.getBinding;f.repository.getBinding=async(owner,client,lock)=>{if(lock)vi.setSystemTime(request.expiresAt);return original(owner,client,lock)}}
   if(wait==='reservation')f.repository.hasReservedPublication=async()=>{vi.setSystemTime(request.expiresAt);return false}
   await expect(reviewFromVerifiedLine({lineUserId:USER,webhookEventId:`consent-lock-wait-${wait}`,semanticFingerprint:'b'.repeat(64),requestId:request.requestId,actionToken,decision:'approved'},{...f.deps(),now:undefined})).rejects.toThrow('WEEKLY_REQUEST_EXPIRED_OR_CHANGED')
   expect(f.state.consents).toHaveLength(0);expect(f.state.queued).toBe(0);expect(f.state.requests[0]!.status).toBe('pending');expect(f.state.inbox).toHaveLength(1)
 })

 it('production own-bindings query durably fences exact verified recipient, owner/client joins and active scopes',async()=>{
   const predicates:SQL[]=[], limits:number[]=[]
   const query={from:(_table:unknown)=>query,innerJoin:(_table:unknown,condition:SQL)=>{predicates.push(condition);return query},where:(condition:SQL)=>{predicates.push(condition);return query},orderBy:(_value:unknown)=>query,limit:async(max:number)=>{limits.push(max);return []}}
   const repository=createWeeklyContentRepositoryFromDatabase({select:()=>query})
   await repository.listActiveBindingsForLineUser(USER,50)
   const compiled=new MySqlDialect().sqlToQuery(sql.join(predicates,sql` AND `))
   expect(limits).toEqual([20]);expect(compiled.params).toContain(USER)
   expect(compiled.sql).toContain('`weeklyContentBindings`.`lineUserId` = ?')
   expect(compiled.sql).toContain('`contentOperationClients`.`ownerUserId` = `weeklyContentBindings`.`ownerUserId`')
   expect(compiled.sql).toContain('`weeklyContentConfigs`.`ownerUserId` = `weeklyContentBindings`.`ownerUserId`')
   expect(compiled.sql).toContain('`contentOperationClients`.`requireCustomerApproval` = ?')
   expect(compiled.params.filter(value=>value==='active')).toHaveLength(3)
 })

})

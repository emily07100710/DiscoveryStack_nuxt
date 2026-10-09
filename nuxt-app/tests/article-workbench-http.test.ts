import {createApp,createError,createRouter,defineEventHandler,getHeader,send,setResponseStatus,toWebHandler,type EventHandler} from 'h3'
import {afterAll,afterEach,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest'
import {ArticleFixture,ARTICLE_DOCUMENT,ARTICLE_IDENTITY,ARTICLE_LINE_ID,ARTICLE_NOW} from './article-workbench-fixture'
import {createAndSendArticleWorkspace} from '../server/article-workbench/service'

const seams=vi.hoisted(()=>({owner:vi.fn(),ownerDatabaseId:vi.fn(),runtime:vi.fn(),identity:vi.fn()}))
vi.mock('../server/utils/auth',()=>({requireOwner:seams.owner}))
vi.mock('../server/audit/repository',()=>({getOwnerDatabaseUserId:seams.ownerDatabaseId}))
vi.mock('../server/article-workbench/runtime',async original=>({...await original<typeof import('../server/article-workbench/runtime')>(),articleWorkbenchRuntimeDependencies:seams.runtime}))
vi.mock('../server/weekly-content/liff-identity',()=>({verifyWeeklyLiffIdentity:seams.identity}))
const ORIGIN='https://synthetic-article-owner.taipei',ID_TOKEN='synthetic.header.token'
let fixture:ArticleFixture,workspaceId:string
const handlers:Record<string,EventHandler>={}
beforeAll(async()=>{
  vi.stubGlobal('defineEventHandler',defineEventHandler)
  const files={config:'../server/api/article-workbench/config.get',context:'../server/api/article-workbench/customer/context.post',save:'../server/api/article-workbench/customer/save.post',feedback:'../server/api/article-workbench/customer/feedback.post',approve:'../server/api/article-workbench/customer/approve.post',ownerCreate:'../server/api/article-workbench/clients/[id].post',ownerList:'../server/api/article-workbench/clients/[id].get',ownerSave:'../server/api/article-workbench/owner/save.post',ownerSend:'../server/api/article-workbench/owner/send-revision.post',ownerRetry:'../server/api/article-workbench/owner/retry.post'}
  for(const [key,path] of Object.entries(files))handlers[key]=(await import(path)).default
})
beforeEach(async()=>{
  vi.clearAllMocks();vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(ARTICLE_NOW)
  vi.stubEnv('NUXT_WEEKLY_CONTENT_APPROVAL_ENABLED','true');vi.stubEnv('NUXT_WEEKLY_CONTENT_LIFF_ENABLED','true');vi.stubEnv('NUXT_WEEKLY_CONTENT_REVIEW_ORIGIN',ORIGIN);vi.stubEnv('NUXT_WEEKLY_CONTENT_LIFF_ID','1234567890-synthetic');vi.stubEnv('NUXT_WEEKLY_CONTENT_LINE_LOGIN_CHANNEL_ID','1234567890');vi.stubEnv('NUXT_WEEKLY_CONTENT_TOKEN_KEY','synthetic-only-key-with-minimum-32-bytes');vi.stubEnv('NUXT_ARTICLE_WORKBENCH_ENABLED','true')
  vi.stubEnv('NUXT_ARTICLE_WORKBENCH_OWNER_USER_ID','1');vi.stubEnv('NUXT_ARTICLE_WORKBENCH_TARGET_ID','synthetic-target');vi.stubEnv('NUXT_ARTICLE_WORKBENCH_OWNER_SCOPE_KEY','synthetic-owner');vi.stubEnv('NUXT_ARTICLE_WORKBENCH_SIGNING_SECRET','synthetic-only-article-signing-key-32-bytes-minimum');vi.stubEnv('NUXT_WEEKLY_CONTENT_LINE_ACCESS_TOKEN','synthetic-line-access-token')
  fixture=new ArticleFixture();seams.runtime.mockReturnValue(fixture.deps);seams.identity.mockResolvedValue(ARTICLE_IDENTITY)
  seams.owner.mockImplementation(async event=>{const session=getHeader(event,'x-synthetic-owner');if(!session)throw createError({statusCode:401});if(!/^synthetic-[12]$/u.test(session))throw createError({statusCode:403});return {openId:session}})
  seams.ownerDatabaseId.mockImplementation(async openId=>openId==='synthetic-1'?1:2)
  workspaceId=(await createAndSendArticleWorkspace(fixture.createInput(),fixture.deps)).workspace.workspaceId
  vi.mocked(fixture.deps.notify).mockClear();vi.mocked(fixture.deps.prepare).mockClear()
})
afterEach(()=>{vi.useRealTimers();vi.unstubAllEnvs()})
afterAll(()=>{vi.unstubAllGlobals()})
function app(){const instance=createApp({debug:false,onError:async(error,event)=>{setResponseStatus(event,error.statusCode||500);await send(event,JSON.stringify({statusCode:error.statusCode,statusMessage:error.statusMessage}),'application/json')}}),router=createRouter();router.get('/api/article-workbench/config',handlers.config!);for(const action of ['context','save','feedback','approve'])router.post(`/api/article-workbench/customer/${action}`,handlers[action]!);router.post('/api/article-workbench/clients/:id',handlers.ownerCreate!);router.get('/api/article-workbench/clients/:id',handlers.ownerList!);router.post('/api/article-workbench/owner/save',handlers.ownerSave!);router.post('/api/article-workbench/owner/send-revision',handlers.ownerSend!);router.post('/api/article-workbench/owner/retry',handlers.ownerRetry!);instance.use(router);return toWebHandler(instance)}
function post(path:string,body:unknown,options:{origin?:string|null;fetchSite?:string|null;contentType?:string;owner?:string|null;raw?:string}={}){const origin=options.origin===undefined?ORIGIN:options.origin,fetchSite=options.fetchSite===undefined?'same-origin':options.fetchSite,owner=options.owner===undefined?'synthetic-1':options.owner;return app()(new Request(`${ORIGIN}/api/article-workbench/${path}`,{method:'POST',headers:{'content-type':options.contentType||'application/json',...(origin===null?{}:{origin}),...(fetchSite===null?{}:{'sec-fetch-site':fetchSite}),...(owner===null?{}:{'x-synthetic-owner':owner})},body:options.raw??JSON.stringify(body)}))}
const contextBody=()=>({idToken:ID_TOKEN,workspaceId})
const saveBody=()=>({...contextBody(),expectedVersion:1,idempotencyKey:'synthetic-http-save-1',document:ARTICLE_DOCUMENT})

describe('formal article HTTP identity and origin boundaries',()=>{
  it('exposes only availability and public LIFF configuration',async()=>{
    const response=await app()(new Request(`${ORIGIN}/api/article-workbench/config`))
    expect(await response.json()).toEqual({enabled:true,liffId:'1234567890-synthetic',origin:ORIGIN});expect(response.headers.get('cache-control')).toContain('no-store');expect(seams.runtime).not.toHaveBeenCalled()
    vi.stubEnv('NUXT_ARTICLE_WORKBENCH_ENABLED','false');expect(await (await app()(new Request(`${ORIGIN}/api/article-workbench/config`))).json()).toEqual({enabled:false})
  })
  it('authenticates each context/save/feedback/approve POST independently without persisting the ID token',async()=>{
    const context=await post('customer/context',contextBody());expect(context.status).toBe(200)
    const saved=await post('customer/save',saveBody()),value=await saved.json();expect(saved.status).toBe(200);expect(value.workspace.version).toBe(2)
    expect((await post('customer/feedback',{...contextBody(),expectedVersion:2,idempotencyKey:'synthetic-http-feedback',note:'希望調整語氣。'})).status).toBe(200)
    const approved=await post('customer/approve',{...contextBody(),expectedVersion:2,documentHash:value.workspace.documentHash,idempotencyKey:'synthetic-http-approve',confirmation:'APPROVE_AND_PUBLISH'});expect(approved.status).toBe(200)
    expect((await approved.json()).workspace.status).toBe('published');expect(seams.identity).toHaveBeenCalledTimes(4)
    for(const call of seams.identity.mock.calls)expect(call[0]).toBe(ID_TOKEN)
    expect(JSON.stringify(fixture.state)).not.toContain(ID_TOKEN);expect(JSON.stringify(await context.json())).not.toContain(ARTICLE_LINE_ID)
    expect(context.headers.get('cache-control')).toContain('no-store');expect(context.headers.get('referrer-policy')).toBe('no-referrer')
  })
  it.each([null,'https://foreign.invalid','null'])('rejects missing/foreign Origin before LINE verification for %s',async origin=>{expect((await post('customer/context',contextBody(),{origin})).status).toBe(403);expect(seams.identity).not.toHaveBeenCalled();expect(seams.runtime).not.toHaveBeenCalled()})
  it.each([null,'same-site','cross-site','none'])('requires same-origin browser Fetch Metadata for %s',async fetchSite=>{expect((await post('customer/save',saveBody(),{fetchSite})).status).toBe(403);expect(seams.identity).not.toHaveBeenCalled()})
  it.each(['text/plain','multipart/form-data','application/x-www-form-urlencoded'])('rejects non-JSON writes for %s',async contentType=>{expect((await post('customer/approve',{}, {contentType})).status).toBe(403);expect(seams.identity).not.toHaveBeenCalled()})
  it.each([{}, {...contextBody(),idToken:'read-token'}, {idToken:ID_TOKEN,workspaceId:'aw_bad'}, {idToken:ID_TOKEN,workspaceId:'aw_'+'a'.repeat(32),lineUserId:ARTICLE_LINE_ID}, {idToken:ID_TOKEN,workspaceId:'aw_'+'a'.repeat(32),ownerUserId:1}])('rejects malformed identity or browser authority fields',async body=>{expect((await post('customer/context',body)).status).toBe(422);expect(seams.identity).not.toHaveBeenCalled()})
  it('fails closed for unverifiable or foreign LINE identities',async()=>{
    seams.identity.mockRejectedValueOnce(createError({statusCode:401,statusMessage:'LINE_IDENTITY_INVALID'}));expect((await post('customer/context',contextBody())).status).toBe(401)
    seams.identity.mockResolvedValueOnce({...ARTICLE_IDENTITY,lineUserId:`U${'b'.repeat(32)}`});expect((await post('customer/context',contextBody())).status).toBe(403)
    expect(fixture.deps.publish).not.toHaveBeenCalled()
  })
  it('rejects oversized and malformed raw bodies before identity verification',async()=>{
    expect((await post('customer/save',{}, {raw:'x'.repeat(160*1024+1)})).status).toBe(413)
    expect((await post('customer/save',{}, {raw:'{'})).status).toBe(422);expect(seams.identity).not.toHaveBeenCalled()
  })
  it('rejects old test request IDs and test approval fields rather than promoting test consent',async()=>{
    expect((await post('customer/approve',{...contextBody(),workspaceId:'wct_'+'a'.repeat(32),expectedVersion:1,idempotencyKey:'synthetic-approve-key',documentHash:'a'.repeat(64),confirmation:'APPROVE_AND_PUBLISH'})).status).toBe(422)
    expect((await post('customer/approve',{...contextBody(),expectedVersion:1,idempotencyKey:'synthetic-approve-key',documentHash:'a'.repeat(64),confirmation:'APPROVE_AND_PUBLISH',actionToken:'test-action'})).status).toBe(422)
    expect(fixture.deps.publish).not.toHaveBeenCalled()
  })
  it('requires owner session and explicit formal confirmation before creating remote drafts',async()=>{
    const body={document:ARTICLE_DOCUMENT,idempotencyKey:'synthetic-new-owner-http',confirmation:'SEND_FORMAL_ARTICLE'}
    expect((await post('clients/1',body,{owner:null})).status).toBe(401)
    expect((await post('clients/1',body,{owner:'synthetic-foreign'})).status).toBe(403)
    expect((await post('clients/1',{...body,confirmation:'SEND_REVIEW_TEST'})).status).toBe(422)
    expect((await post('clients/1',{...body,targetOrigin:'https://foreign.invalid'})).status).toBe(422)
    expect(fixture.deps.prepare).not.toHaveBeenCalled()
    expect((await post('clients/1',body)).status).toBe(200);expect(fixture.deps.prepare).toHaveBeenCalledTimes(1);expect(fixture.deps.publish).not.toHaveBeenCalled()
  })
  it('permits owner same-workspace revisions but requires a separate explicit LINE re-send',async()=>{
    const response=await post('owner/save',{workspaceId,expectedVersion:1,idempotencyKey:'synthetic-owner-http-save',document:{...ARTICLE_DOCUMENT,title:'修訂稿'}}),value=await response.json()
    expect(response.status).toBe(200);expect(value.workspace.version).toBe(2);expect(fixture.deps.notify).not.toHaveBeenCalled()
    expect((await post('owner/send-revision',{workspaceId,expectedVersion:2,confirmation:'SEND_REVISED_FORMAL_ARTICLE'})).status).toBe(200);expect(fixture.deps.notify).toHaveBeenCalledTimes(1)
    expect((await post('owner/save',{workspaceId,expectedVersion:2,idempotencyKey:'synthetic-owner-wrong-1',document:ARTICLE_DOCUMENT},{owner:'synthetic-2'})).status).toBe(404)
  })
  it('does not expose cross-tenant owner lists',async()=>{
    const response=await app()(new Request(`${ORIGIN}/api/article-workbench/clients/1`,{headers:{'x-synthetic-owner':'synthetic-2'}}));expect(response.status).toBe(404)
    expect((await app()(new Request(`${ORIGIN}/api/article-workbench/clients/1`))).status).toBe(401)
  })
})

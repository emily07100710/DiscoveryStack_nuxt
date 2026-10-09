import {createApp,createError,createRouter,defineEventHandler,getHeader,send,setResponseStatus,toWebHandler,type EventHandler} from 'h3'
import {afterAll,afterEach,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest'
import type {ReviewTestDependencies} from '../server/weekly-content/review-test'
import {ReviewTestFixture,REVIEW_TEST_LINE_USER} from './fixtures/weekly-content/review-test-repository'
import {WEEKLY_KEY,WEEKLY_NOW} from './fixtures/weekly-content/repository'

const seams=vi.hoisted(()=>({owner:vi.fn(),ownerDatabaseId:vi.fn(),runtime:vi.fn()}))
vi.mock('../server/utils/auth',()=>({requireOwner:seams.owner}))
vi.mock('../server/audit/repository',()=>({getOwnerDatabaseUserId:seams.ownerDatabaseId}))
vi.mock('../server/weekly-content/review-test',async original=>({...await original<typeof import('../server/weekly-content/review-test')>(),reviewTestRuntimeDependencies:seams.runtime}))

const ORIGIN='https://synthetic-review-owner.taipei'
const BODY={title:'Do Alignment 測試文章',body:'這是一篇不具發布權限的測試稿。',idempotencyKey:'review-http-key-0001',confirmation:'SEND_REVIEW_TEST'}
let fixture:ReviewTestFixture,dependencies:ReviewTestDependencies,postHandler:EventHandler,getHandler:EventHandler

beforeAll(async()=>{
  vi.stubGlobal('defineEventHandler',defineEventHandler)
  ;[postHandler,getHandler]=await Promise.all([
    import('../server/api/weekly-content/clients/[id]/review-test.post').then(module=>module.default),
    import('../server/api/weekly-content/clients/[id]/review-tests.get').then(module=>module.default),
  ])
})
beforeEach(()=>{
  vi.clearAllMocks();vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(WEEKLY_NOW)
  vi.stubEnv('NUXT_WEEKLY_CONTENT_REVIEW_ORIGIN',ORIGIN)
  fixture=new ReviewTestFixture()
  dependencies={repository:fixture.repository,weeklyRepository:()=>fixture.weekly.repository,featureEnabled:true,tokenKey:WEEKLY_KEY,publicOrigin:ORIGIN,sender:vi.fn(async()=>({accepted:true as const,duplicate:false,providerMessageId:'synthetic-line-request'})),now:WEEKLY_NOW}
  seams.runtime.mockReturnValue(dependencies)
  seams.owner.mockImplementation(async event=>{const session=getHeader(event,'x-test-owner-session');if(!session)throw createError({statusCode:401});if(!/^synthetic-owner-[12]$/u.test(session))throw createError({statusCode:403});return {openId:session}})
  seams.ownerDatabaseId.mockImplementation(async openId=>openId==='synthetic-owner-1'?1:2)
})
afterEach(()=>{vi.useRealTimers();vi.unstubAllEnvs()})
afterAll(()=>{vi.unstubAllGlobals()})

function app(){
  const instance=createApp({debug:false,onError:async(error,event)=>{setResponseStatus(event,error.statusCode||500);await send(event,JSON.stringify({statusCode:error.statusCode,statusMessage:error.statusMessage}),'application/json')}})
  const router=createRouter()
  router.post('/api/weekly-content/clients/:id/review-test',postHandler)
  router.get('/api/weekly-content/clients/:id/review-tests',getHandler)
  instance.use(router)
  return toWebHandler(instance)
}
function post(body:unknown=BODY,options:{origin?:string|null;owner?:string|null;contentType?:string;fetchSite?:string|null;raw?:string;clientId?:string}={}){
  const origin=options.origin===undefined?ORIGIN:options.origin,owner=options.owner===undefined?'synthetic-owner-1':options.owner,fetchSite=options.fetchSite===undefined?'same-origin':options.fetchSite
  return app()(new Request(`${ORIGIN}/api/weekly-content/clients/${options.clientId||'1'}/review-test`,{method:'POST',headers:{'content-type':options.contentType||'application/json',...(origin===null?{}:{origin}),...(owner===null?{}:{'x-test-owner-session':owner}),...(fetchSite===null?{}:{'sec-fetch-site':fetchSite})},body:options.raw??JSON.stringify(body)}))
}
function list(options:{owner?:string|null;clientId?:string}={}){
  const owner=options.owner===undefined?'synthetic-owner-1':options.owner
  return app()(new Request(`${ORIGIN}/api/weekly-content/clients/${options.clientId||'1'}/review-tests`,{headers:{...(owner===null?{}:{'x-test-owner-session':owner})}}))
}

describe('isolated review-test owner HTTP boundary',()=>{
  it('returns only the safe test DTO and never projects the article body, recipient, or tokens',async()=>{
    const response=await post(),value=await response.json()
    expect(response.status).toBe(200)
    expect(Object.keys(value).sort()).toEqual(['replayed','test'])
    expect(Object.keys(value.test).sort()).toEqual(['createdAt','expiresAt','notificationStatus','requestId','status','title'])
    expect(value).toMatchObject({replayed:false,test:{title:BODY.title,status:'pending',notificationStatus:'sent'}})
    expect(JSON.stringify(value)).not.toContain(BODY.body)
    expect(JSON.stringify(value)).not.toContain(REVIEW_TEST_LINE_USER)
    expect(JSON.stringify(value)).not.toContain('Token')
    expect(response.headers.get('cache-control')).toContain('no-store')
    expect(response.headers.get('referrer-policy')).toBe('no-referrer')
  })

  it.each([null,'cross-site','same-site','none'])('requires explicit same-origin fetch metadata before owner lookup for %s',async fetchSite=>{
    const response=await post(BODY,{fetchSite})
    expect(response.status).toBe(403)
    expect(seams.owner).not.toHaveBeenCalled()
    expect(seams.runtime).not.toHaveBeenCalled()
    expect(fixture.rows).toHaveLength(0)
  })

  it.each([null,'https://foreign.example','null'])('rejects missing or foreign Origin before storage for %s',async origin=>{
    const response=await post(BODY,{origin})
    expect(response.status).toBe(403)
    expect(seams.owner).not.toHaveBeenCalled()
    expect(seams.runtime).not.toHaveBeenCalled()
  })

  it.each(['text/plain','application/x-www-form-urlencoded','multipart/form-data'])('requires JSON for %s',async contentType=>{
    expect((await post(BODY,{contentType})).status).toBe(403)
    expect(seams.owner).not.toHaveBeenCalled()
    expect(seams.runtime).not.toHaveBeenCalled()
  })

  it('requires the owner session before runtime construction',async()=>{
    expect((await post(BODY,{owner:null})).status).toBe(401)
    expect((await post(BODY,{owner:'synthetic-foreign'})).status).toBe(403)
    expect(seams.runtime).not.toHaveBeenCalled()
  })

  it.each([
    {},
    {...BODY,confirmation:'send_review_test'},
    {...BODY,ownerUserId:1},
    {...BODY,lineUserId:REVIEW_TEST_LINE_USER},
    {...BODY,unknown:true},
  ])('rejects missing, inexact, or authority-overriding fields %j',async body=>{
    expect((await post(body)).status).toBe(422)
    expect(seams.runtime).not.toHaveBeenCalled()
    expect(fixture.rows).toHaveLength(0)
  })

  it('rejects the raw request above 48 KiB before runtime or storage',async()=>{
    const raw=JSON.stringify({...BODY,body:'文'.repeat(17_000)})
    expect(Buffer.byteLength(raw)).toBeGreaterThan(48*1024)
    expect((await post(undefined,{raw})).status).toBe(413)
    expect(seams.runtime).not.toHaveBeenCalled()
    expect(fixture.rows).toHaveLength(0)
  })

  it('lists only safe owner-scoped status and rejects a different owner or invalid client path',async()=>{
    expect((await post()).status).toBe(200)
    const response=await list(),value=await response.json()
    expect(response.status).toBe(200)
    expect(value.tests).toHaveLength(1)
    expect(Object.keys(value.tests[0]).sort()).toEqual(['createdAt','expiresAt','notificationStatus','requestId','status','title'])
    expect(JSON.stringify(value)).not.toContain(BODY.body)
    expect(JSON.stringify(value)).not.toContain(REVIEW_TEST_LINE_USER)
    expect((await list({owner:'synthetic-owner-2'})).status).toBe(404)
    expect((await list({clientId:'0'})).status).toBe(422)
  })
})

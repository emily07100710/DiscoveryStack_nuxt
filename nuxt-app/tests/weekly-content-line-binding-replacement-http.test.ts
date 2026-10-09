import {createApp,createError,createRouter,defineEventHandler,getHeader,send,setResponseStatus,toWebHandler,type EventHandler} from 'h3'
import {afterAll,afterEach,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest'
import {WeeklyFixture,WEEKLY_NOW,WEEKLY_KEY,sha} from './fixtures/weekly-content/repository'

const seams=vi.hoisted(()=>({owner:vi.fn(),ownerDatabaseId:vi.fn(),repository:vi.fn()}))
vi.mock('../server/utils/auth',()=>({requireOwner:seams.owner}))
vi.mock('../server/audit/repository',()=>({getOwnerDatabaseUserId:seams.ownerDatabaseId}))
vi.mock('../server/weekly-content/repository',async original=>({...await original<typeof import('../server/weekly-content/repository')>(),createWeeklyContentRepository:seams.repository}))

const ORIGIN='https://synthetic-weekly-owner.taipei'
const PRIVATE_USER=`U${'7'.repeat(32)}`
let fixture:WeeklyFixture,handler:EventHandler

beforeAll(async()=>{
  vi.stubGlobal('defineEventHandler',defineEventHandler)
  handler=(await import('../server/api/weekly-content/clients/[id]/replace-line-binding.post')).default
})
beforeEach(()=>{
  vi.clearAllMocks();vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(WEEKLY_NOW)
  vi.stubEnv('NUXT_WEEKLY_CONTENT_APPROVAL_ENABLED','true');vi.stubEnv('NUXT_WEEKLY_CONTENT_TOKEN_KEY',WEEKLY_KEY);vi.stubEnv('NUXT_WEEKLY_CONTENT_REVIEW_ORIGIN',ORIGIN)
  fixture=new WeeklyFixture()
  fixture.state.binding={id:30,ownerUserId:1,clientId:1,lineUserId:PRIVATE_USER,bindingFingerprint:sha('existing-binding'),status:'active',createdAt:WEEKLY_NOW,updatedAt:WEEKLY_NOW}
  seams.repository.mockReturnValue(fixture.repository)
  seams.owner.mockImplementation(async event=>{const session=getHeader(event,'x-test-owner-session');if(!session)throw createError({statusCode:401});if(session!=='synthetic-owner-1')throw createError({statusCode:403});return {openId:session}})
  seams.ownerDatabaseId.mockResolvedValue(1)
})
afterEach(()=>{vi.useRealTimers();vi.unstubAllEnvs()})
afterAll(()=>{vi.unstubAllGlobals()})

function request(body:unknown={confirmation:'REPLACE_LINE_RECIPIENT'},options:{origin?:string|null;owner?:string|null;contentType?:string;fetchSite?:string|null;raw?:string}={}){
  const app=createApp({debug:false,onError:async(error,event)=>{setResponseStatus(event,error.statusCode||500);await send(event,JSON.stringify({statusCode:error.statusCode,statusMessage:error.statusMessage}),'application/json')}})
  const router=createRouter();router.post('/api/weekly-content/clients/:id/replace-line-binding',handler);app.use(router)
  const origin=options.origin===undefined?ORIGIN:options.origin,owner=options.owner===undefined?'synthetic-owner-1':options.owner,fetchSite=options.fetchSite===undefined?'same-origin':options.fetchSite
  return toWebHandler(app)(new Request(`${ORIGIN}/api/weekly-content/clients/1/replace-line-binding`,{method:'POST',headers:{'content-type':options.contentType||'application/json',...(origin===null?{}:{origin}),...(owner===null?{}:{'x-test-owner-session':owner}),...(fetchSite===null?{}:{'sec-fetch-site':fetchSite})},body:options.raw??JSON.stringify(body)}))
}

describe('LINE recipient replacement HTTP boundary',()=>{
  it('returns only the invitation DTO and connect URL after exact owner confirmation',async()=>{
    const response=await request(),value=await response.json()
    expect(response.status).toBe(200)
    expect(Object.keys(value).sort()).toEqual(['connectUrl','expiresAt','invitationToken','purpose'])
    expect(value).toMatchObject({purpose:'identity_binding',connectUrl:`${ORIGIN}/weekly-content/connect`})
    expect(value.invitationToken).toMatch(/^wli_[A-Za-z0-9_-]{32}$/)
    expect(JSON.stringify(value)).not.toContain(PRIVATE_USER)
    expect(response.headers.get('cache-control')).toContain('no-store')
    expect(response.headers.get('referrer-policy')).toBe('no-referrer')
  })

  it.each([null,'cross-site','same-site','none'])('requires an explicit same-origin browser fetch before auth for %s',async fetchSite=>{
    const response=await request(undefined,{fetchSite})
    expect(response.status).toBe(403)
    expect(seams.owner).not.toHaveBeenCalled()
    expect(seams.repository).not.toHaveBeenCalled()
    expect(fixture.state.binding?.status).toBe('active')
  })

  it.each([null,'https://foreign.example','null'])('rejects missing or foreign Origin without a storage write for %s',async origin=>{
    const response=await request(undefined,{origin})
    expect(response.status).toBe(403)
    expect(seams.owner).not.toHaveBeenCalled()
    expect(seams.repository).not.toHaveBeenCalled()
  })

  it.each(['text/plain','application/x-www-form-urlencoded','multipart/form-data'])('requires a JSON request for %s',async contentType=>{
    expect((await request(undefined,{contentType})).status).toBe(403)
    expect(seams.owner).not.toHaveBeenCalled()
    expect(seams.repository).not.toHaveBeenCalled()
  })

  it('requires the owner session before repository construction',async()=>{
    expect((await request(undefined,{owner:null})).status).toBe(401)
    expect((await request(undefined,{owner:'synthetic-other'})).status).toBe(403)
    expect(seams.repository).not.toHaveBeenCalled()
  })

  it.each([{}, {confirmation:'replace'}, {confirmation:'REPLACE_LINE_RECIPIENT',ownerUserId:1}, {confirmation:'REPLACE_LINE_RECIPIENT',lineUserId:PRIVATE_USER}])('rejects missing, inexact, or authority-overriding confirmation %j',async body=>{
    expect((await request(body)).status).toBe(422)
    expect(seams.repository).not.toHaveBeenCalled()
    expect(fixture.state.binding?.status).toBe('active')
  })

  it('fails closed when no active binding exists and hides internal status details',async()=>{
    fixture.state.binding!.status='revoked'
    const response=await request(),text=await response.text()
    expect(response.status).toBe(409)
    expect(text).not.toContain('WEEKLY_ACTIVE_LINE_BINDING_REQUIRED')
    expect(text).not.toContain(PRIVATE_USER)
    expect(fixture.state.invites).toHaveLength(0)
  })
})

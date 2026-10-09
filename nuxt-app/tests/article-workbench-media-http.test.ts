import {createApp,createError,createRouter,defineEventHandler,send,setResponseStatus,toWebHandler,type EventHandler} from 'h3'
import {afterAll,afterEach,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest'
import {ArticleFixture,ARTICLE_DOCUMENT,ARTICLE_IDENTITY,ARTICLE_LINE_ID,ARTICLE_NOW} from './article-workbench-fixture'
import {approveArticleWorkspace,createAndSendArticleWorkspace,getArticleWorkspace,registerArticleMedia,saveArticleWorkspace,validateCustomerWorkspace} from '../server/article-workbench/service'
import {sha256} from '../server/article-workbench/protocol'
import type {ArticleReceiverCommand} from '../server/article-workbench/receiver-transport'
import type {ArticleMediaManifest} from '../server/article-workbench/types'

const seams=vi.hoisted(()=>({identity:vi.fn(),runtime:vi.fn(),receiver:vi.fn(),normalize:vi.fn()}))
vi.mock('../server/weekly-content/liff-identity',()=>({verifyWeeklyLiffIdentity:seams.identity}))
vi.mock('../server/article-workbench/runtime',async original=>({...await original<typeof import('../server/article-workbench/runtime')>(),articleWorkbenchRuntimeDependencies:seams.runtime}))
vi.mock('../server/article-workbench/receiver-transport',async original=>({...await original<typeof import('../server/article-workbench/receiver-transport')>(),callArticleReceiver:seams.receiver}))
vi.mock('../server/article-workbench/media-codec',()=>({normalizeArticleImage:seams.normalize}))
vi.mock('../server/article-workbench/service',async original=>{const actual=await original<typeof import('../server/article-workbench/service')>();return {...actual,getArticleWorkspace:vi.fn(actual.getArticleWorkspace),validateCustomerWorkspace:vi.fn(actual.validateCustomerWorkspace),registerArticleMedia:vi.fn(actual.registerArticleMedia)}})

const ORIGIN='https://synthetic-media-owner.taipei',ID_TOKEN='synthetic.media.token',MEDIA_ID='12345678-1234-1234-1234-123456789012'
// Synthetic RIFF/WebP bytes exercise authenticated byte validation; real codec decoding has separate tests.
const BYTES=Buffer.from([82,73,70,70,12,0,0,0,87,69,66,80,86,80,56,76,0,0,0,0]),BASE64=BYTES.toString('base64'),HASH=sha256(BYTES)
const IMAGE={bytes:BYTES,bytesBase64:BASE64,mimeType:'image/webp' as const,sha256:HASH,size:BYTES.length,width:20,height:20}
let fixture:ArticleFixture,workspaceId:string,uploadHandler:EventHandler,previewHandler:EventHandler

beforeAll(async()=>{
  vi.stubGlobal('defineEventHandler',defineEventHandler)
  ;[uploadHandler,previewHandler]=await Promise.all([import('../server/api/article-workbench/customer/media.post').then(module=>module.default),import('../server/api/article-workbench/customer/media-preview.post').then(module=>module.default)])
})
beforeEach(async()=>{
  vi.clearAllMocks();vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(ARTICLE_NOW)
  vi.stubEnv('NUXT_WEEKLY_CONTENT_APPROVAL_ENABLED','true');vi.stubEnv('NUXT_WEEKLY_CONTENT_LIFF_ENABLED','true');vi.stubEnv('NUXT_WEEKLY_CONTENT_REVIEW_ORIGIN',ORIGIN);vi.stubEnv('NUXT_WEEKLY_CONTENT_LIFF_ID','1234567890-synthetic');vi.stubEnv('NUXT_WEEKLY_CONTENT_LINE_LOGIN_CHANNEL_ID','1234567890');vi.stubEnv('NUXT_WEEKLY_CONTENT_TOKEN_KEY','synthetic-only-key-with-minimum-32-bytes');vi.stubEnv('NUXT_ARTICLE_WORKBENCH_ENABLED','true');vi.stubEnv('NUXT_ARTICLE_WORKBENCH_OWNER_USER_ID','1');vi.stubEnv('NUXT_ARTICLE_WORKBENCH_TARGET_ID','synthetic-target');vi.stubEnv('NUXT_ARTICLE_WORKBENCH_OWNER_SCOPE_KEY','synthetic-owner-scope');vi.stubEnv('NUXT_ARTICLE_WORKBENCH_SIGNING_SECRET','synthetic-only-article-signing-key-32-bytes-minimum');vi.stubEnv('NUXT_WEEKLY_CONTENT_LINE_ACCESS_TOKEN','synthetic-line-access-token')
  fixture=new ArticleFixture();seams.runtime.mockReturnValue(fixture.deps);seams.identity.mockResolvedValue(ARTICLE_IDENTITY);seams.normalize.mockResolvedValue(IMAGE)
  workspaceId=(await createAndSendArticleWorkspace(fixture.createInput(),fixture.deps)).workspace.workspaceId
  seams.receiver.mockImplementation(async(action:string,command:ArticleReceiverCommand)=>({ok:true,result:{status:'media_ready',...(action==='media'?{postId:'synthetic-post'}:{}),media:{mediaId:command.payload.mediaId,sha256:HASH,size:BYTES.length,width:20,height:20,...(action==='media-read'?{bytesBase64:BASE64}:{})}}}))
  vi.mocked(getArticleWorkspace).mockClear();vi.mocked(registerArticleMedia).mockClear();vi.mocked(validateCustomerWorkspace).mockClear()
})
afterEach(()=>{vi.useRealTimers();vi.unstubAllEnvs()})
afterAll(()=>{vi.unstubAllGlobals()})
function app(){const instance=createApp({debug:false,onError:async(error,event)=>{setResponseStatus(event,error.statusCode||500);await send(event,JSON.stringify({statusCode:error.statusCode,statusMessage:error.statusMessage}),'application/json')}}),router=createRouter();router.post('/media',uploadHandler);router.post('/preview',previewHandler);instance.use(router);return toWebHandler(instance)}
function post(path:'media'|'preview',body:unknown,options:{origin?:string|null;fetchSite?:string|null;contentType?:string;raw?:string}={}){const origin=options.origin===undefined?ORIGIN:options.origin,fetchSite=options.fetchSite===undefined?'same-origin':options.fetchSite;return app()(new Request(`${ORIGIN}/${path}`,{method:'POST',headers:{'content-type':options.contentType||'application/json',...(origin===null?{}:{origin}),...(fetchSite===null?{}:{'sec-fetch-site':fetchSite})},body:options.raw??JSON.stringify(body)}))}
const uploadBody=()=>({idToken:ID_TOKEN,workspaceId,expectedVersion:1,idempotencyKey:'synthetic-media-upload-1',filename:'synthetic-image.webp',mimeType:'image/webp',bytesBase64:BASE64,rightsConfirmed:true})
const previewBody=()=>({idToken:ID_TOKEN,workspaceId,mediaId:MEDIA_ID})
async function privateMedia(){const item:ArticleMediaManifest={id:MEDIA_ID,sha256:HASH,version:1,mimeType:'image/webp',size:BYTES.length,width:20,height:20,url:`https://doalignment.com/journal/media/${MEDIA_ID}/`};await registerArticleMedia({workspaceId,actor:fixture.actor(),expectedVersion:1,media:item},fixture.deps);vi.mocked(registerArticleMedia).mockClear();return item}
function receipt(command:ArticleReceiverCommand,changes:Record<string,unknown>={}){return {ok:true,result:{status:'media_ready',postId:'synthetic-post',media:{mediaId:command.payload.mediaId,sha256:HASH,size:BYTES.length,width:20,height:20,...changes}}}}

describe('authenticated private media preview HTTP boundary',()=>{
  it('reads the actual nested media response, validates bytes and checks binding before AND after the network',async()=>{
    await privateMedia();const response=await post('preview',previewBody()),value=await response.json()
    expect(response.status).toBe(200);expect(value).toEqual({mimeType:'image/webp',bytesBase64:BASE64})
    expect(getArticleWorkspace).toHaveBeenCalledTimes(2);expect(seams.identity).toHaveBeenCalledTimes(1)
    expect(seams.receiver).toHaveBeenCalledTimes(1);expect(seams.receiver.mock.calls[0]![0]).toBe('media-read')
    expect(seams.receiver.mock.calls[0]![1]).toMatchObject({workspaceId,mandateFingerprint:fixture.state.workspaces[0]!.authorityFingerprint,payload:{mediaId:MEDIA_ID}})
    expect(response.headers.get('cache-control')).toContain('no-store');expect(response.headers.get('referrer-policy')).toBe('no-referrer')
    expect(JSON.stringify(value)).not.toContain(ID_TOKEN);expect(JSON.stringify(value)).not.toContain(ARTICLE_LINE_ID);expect(JSON.stringify(value)).not.toContain('ownerScopeKey')
  })
  it('fails before receiver access for another LINE user or a foreign workspace media ID',async()=>{
    await privateMedia();seams.identity.mockResolvedValueOnce({...ARTICLE_IDENTITY,lineUserId:`U${'f'.repeat(32)}`})
    expect((await post('preview',previewBody())).status).toBe(403)
    expect((await post('preview',{...previewBody(),mediaId:'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'})).status).toBe(404)
    expect(seams.receiver).not.toHaveBeenCalled()
  })
  it('does not return private bytes if recipient binding changes while the receiver is reading',async()=>{
    await privateMedia();seams.receiver.mockImplementationOnce(async()=>{fixture.state.binding.bindingFingerprint='f'.repeat(64);return {ok:true,result:{status:'media_ready',media:{mediaId:MEDIA_ID,sha256:HASH,size:BYTES.length,width:20,height:20,bytesBase64:BASE64}}}})
    const response=await post('preview',previewBody()),body=await response.json()
    expect(response.status).toBe(409);expect(body).not.toHaveProperty('bytesBase64');expect(getArticleWorkspace).toHaveBeenCalledTimes(2)
  })
  it('does not return private bytes if the verified LINE identity expires during the receiver call',async()=>{
    await privateMedia();seams.receiver.mockImplementationOnce(async()=>{fixture.deps.now=new Date(ARTICLE_NOW.getTime()+3600_000);return {ok:true,result:{status:'media_ready',media:{mediaId:MEDIA_ID,sha256:HASH,size:BYTES.length,width:20,height:20,bytesBase64:BASE64}}}})
    const response=await post('preview',previewBody());expect(response.status).toBe(403);expect(await response.json()).not.toHaveProperty('bytesBase64');expect(getArticleWorkspace).toHaveBeenCalledTimes(2)
  })
  it('does not return bytes for a media record removed while the receiver call was pending',async()=>{
    await privateMedia();seams.receiver.mockImplementationOnce(async()=>{fixture.state.media=[];return {ok:true,result:{status:'media_ready',media:{mediaId:MEDIA_ID,sha256:HASH,size:BYTES.length,width:20,height:20,bytesBase64:BASE64}}}})
    const response=await post('preview',previewBody());expect(response.status).toBe(404);expect(await response.json()).not.toHaveProperty('bytesBase64')
  })
  it.each([
    {sha256:'0'.repeat(64)},
    {bytesBase64:'not+base64!!!'},
    {bytesBase64:Buffer.from('not a webp file').toString('base64')},
    {bytesBase64:Buffer.from([...BYTES.subarray(0,-1),1]).toString('base64')},
    {bytesBase64:'A'.repeat(700_004)},
    {size:BYTES.length+1},
    {width:19},
    {mediaId:'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'},
  ])('rejects a malformed or mismatched signed nested media receipt',async changes=>{
    await privateMedia();seams.receiver.mockImplementationOnce(async()=>({ok:true,result:{status:'media_ready',media:{mediaId:MEDIA_ID,sha256:HASH,size:BYTES.length,width:20,height:20,bytesBase64:BASE64,...changes}}}))
    const response=await post('preview',previewBody());expect(response.status).toBe(503);expect(await response.json()).not.toHaveProperty('bytesBase64')
  })
  it('does not accept the legacy flat response instead of the receiver nested media contract',async()=>{
    await privateMedia();seams.receiver.mockResolvedValueOnce({ok:true,result:{status:'media_ready',mediaId:MEDIA_ID,sha256:HASH,size:BYTES.length,width:20,height:20,bytesBase64:BASE64}})
    expect((await post('preview',previewBody())).status).toBe(503)
  })
})

describe('private image upload authority and immutable media registration',()=>{
  it('pins uploaded bytes to exact post/dimensions/hash and stable server media UUID',async()=>{
    const first=await post('media',uploadBody()),firstValue=await first.json(),second=await post('media',uploadBody()),secondValue=await second.json()
    expect(first.status).toBe(200);expect(second.status).toBe(200);expect(secondValue.replayed).toBe(true)
    const mediaId=firstValue.workspace.media[0].id;expect(mediaId).toMatch(/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u)
    expect(secondValue.workspace.media[0].id).toBe(mediaId);expect(fixture.state.media).toHaveLength(1)
    expect(seams.receiver.mock.calls[0]![1]).toEqual(seams.receiver.mock.calls[1]![1])
    expect(registerArticleMedia).toHaveBeenCalledWith(expect.objectContaining({workspaceId,expectedVersion:1,actor:{kind:'customer',identity:ARTICLE_IDENTITY},media:expect.objectContaining({id:mediaId,sha256:HASH,size:BYTES.length,width:20,height:20,mimeType:'image/webp',version:1})}),fixture.deps)
    expect(validateCustomerWorkspace).toHaveBeenCalledTimes(2);expect(fixture.state.workspaces[0]).toMatchObject({version:1,status:'editing',approvedAt:null,document:ARTICLE_DOCUMENT})
    expect(JSON.stringify(fixture.state.media)).not.toContain(ID_TOKEN);expect(JSON.stringify(fixture.state.media)).not.toContain('synthetic-image.webp')
    const third=await post('media',{...uploadBody(),idempotencyKey:'synthetic-media-upload-2'}),thirdValue=await third.json();expect(third.status).toBe(200);expect(thirdValue.workspace.media[1].id).not.toBe(mediaId)
  })
  it('rejects different normalized bytes for the same idempotency key before another receiver upload',async()=>{
    expect((await post('media',uploadBody())).status).toBe(200);seams.normalize.mockResolvedValueOnce({...IMAGE,sha256:'f'.repeat(64)})
    expect((await post('media',uploadBody())).status).toBe(409);expect(seams.receiver).toHaveBeenCalledTimes(1);expect(fixture.state.media).toHaveLength(1)
  })
  it.each([
    {postId:'different-post'},
    {media:{sha256:'0'.repeat(64)}},
    {media:{size:BYTES.length+1}},
    {media:{width:19}},
    {media:{height:19}},
    {media:{mediaId:'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'}},
  ])('never registers media from a mismatched signed upload receipt',async changes=>{
    seams.receiver.mockImplementationOnce(async(_action:string,command:ArticleReceiverCommand)=>{const output=receipt(command,changes.media as Record<string,unknown>|undefined);if(changes.postId)output.result.postId=changes.postId as string;return output})
    expect((await post('media',uploadBody())).status).toBe(503);expect(registerArticleMedia).not.toHaveBeenCalled();expect(fixture.state.media).toHaveLength(0)
  })
  it('rejects a locked/approved workspace before upload and rejects approval races at registration',async()=>{
    const workspace=(await getArticleWorkspace({workspaceId,actor:fixture.actor()},fixture.deps)).workspace
    seams.receiver.mockImplementationOnce(async(_action:string,command:ArticleReceiverCommand)=>{await approveArticleWorkspace({workspaceId,actor:fixture.actor(),expectedVersion:1,documentHash:workspace.documentHash,idempotencyKey:'synthetic-media-race-approve',confirmation:'APPROVE_AND_PUBLISH'},fixture.deps);return receipt(command)})
    expect((await post('media',uploadBody())).status).toBe(409);expect(fixture.state.workspaces[0]).toMatchObject({status:'published',approvedVersion:1,approvedDocumentHash:workspace.documentHash});expect(fixture.state.media).toHaveLength(0)
    const approval=fixture.state.workspaces[0]!.approvalFingerprint
    expect((await post('media',uploadBody())).status).toBe(409);expect(seams.receiver).toHaveBeenCalledTimes(1);expect(fixture.state.workspaces[0]!.approvalFingerprint).toBe(approval)
  })
  it('rejects exact-version and recipient-binding changes after an orphaned private upload',async()=>{
    seams.receiver.mockImplementationOnce(async(_action:string,command:ArticleReceiverCommand)=>{await saveArticleWorkspace({workspaceId,actor:fixture.actor(),expectedVersion:1,document:{...ARTICLE_DOCUMENT,title:'newer revision'},idempotencyKey:'synthetic-upload-race-edit'},fixture.deps);return receipt(command)})
    expect((await post('media',uploadBody())).status).toBe(409);expect(fixture.state.media).toHaveLength(0);expect(fixture.state.workspaces[0]!.version).toBe(2)
    seams.receiver.mockImplementationOnce(async(_action:string,command:ArticleReceiverCommand)=>{fixture.state.binding.bindingFingerprint='f'.repeat(64);return receipt(command)})
    expect((await post('media',{...uploadBody(),expectedVersion:2})).status).toBe(409);expect(fixture.state.media).toHaveLength(0);expect(fixture.state.workspaces[0]!.approvedAt).toBeNull()
  })
  it.each([
    {rightsConfirmed:false},
    {rightsConfirmed:undefined},
    {filename:'../secret.webp'},
    {mimeType:'image/svg+xml'},
    {mediaId:MEDIA_ID},
    {targetOrigin:'https://foreign.invalid'},
    {bytesBase64:'A'.repeat(1_500_004)},
  ])('requires image rights and rejects browser-controlled authority before normalization/provider',async changes=>{
    expect((await post('media',{...uploadBody(),...changes})).status).toBe(422);expect(seams.identity).not.toHaveBeenCalled();expect(seams.normalize).not.toHaveBeenCalled();expect(seams.receiver).not.toHaveBeenCalled()
  })
  it.each([{origin:null},{origin:'https://foreign.invalid'},{fetchSite:null},{fetchSite:'same-site'},{fetchSite:'cross-site'},{contentType:'multipart/form-data'}])('requires same-origin JSON before accessing provider',async options=>{
    expect((await post('media',uploadBody(),options)).status).toBe(403);expect(seams.identity).not.toHaveBeenCalled();expect(seams.normalize).not.toHaveBeenCalled();expect(seams.receiver).not.toHaveBeenCalled()
  })
  it('enforces raw upload bounds and malformed JSON before identity/provider',async()=>{
    expect((await post('media',{}, {raw:'x'.repeat(1_520_001)})).status).toBe(413);expect((await post('media',{}, {raw:'{'})).status).toBe(422);expect(seams.identity).not.toHaveBeenCalled();expect(seams.receiver).not.toHaveBeenCalled()
  })
  it('does not register media after a provider unknown/rejected result',async()=>{
    seams.receiver.mockResolvedValueOnce({ok:false,retryable:true,errorCode:'synthetic_timeout'});expect((await post('media',uploadBody())).status).toBe(503)
    seams.receiver.mockResolvedValueOnce({ok:false,retryable:false,errorCode:'synthetic_authority_rejected'});expect((await post('media',uploadBody())).status).toBe(409)
    expect(registerArticleMedia).not.toHaveBeenCalled();expect(fixture.state.media).toHaveLength(0)
  })
})

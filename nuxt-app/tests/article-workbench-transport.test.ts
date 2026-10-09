import {describe,it,expect,vi} from 'vitest'
import sharp from 'sharp'
import {callArticleReceiver,type ArticleReceiverConfiguration} from '../server/article-workbench/receiver-transport'
import {ARTICLE_PROTOCOL,ARTICLE_SITE_ORIGIN,articleProtocolSignature,canonicalArticleJson,sha256} from '../server/article-workbench/protocol'
import {articleReceiverRuntimeConfiguration,articleWorkbenchRuntimeDependencies,buildArticleWorkbenchNotification} from '../server/article-workbench/runtime'
import {articleDocumentHash,articleMediaManifestHash,validateArticleDocument} from '../server/article-workbench/document'
import {normalizeArticleImage} from '../server/article-workbench/media-codec'
import type {ArticlePublishInput,ArticleAuthority} from '../server/article-workbench/types'
import type {ArticleWorkbenchRepository} from '../server/article-workbench/repository'

const configuration:ArticleReceiverConfiguration={origin:ARTICLE_SITE_ORIGIN,targetId:'do-alignment-articles',ownerScopeKey:'ds-owner-scope',signingSecret:'s'.repeat(48)}
const workspaceId=`aw_${'a'.repeat(32)}`,mandateFingerprint='b'.repeat(64),command={workspaceId,mandateFingerprint,commandId:'c'.repeat(64),payload:{}}
const document=validateArticleDocument({schemaVersion:1,title:'課程前的準備',slug:'prepare-before-class',summary:'閱讀上課前的準備說明。',category:'課程指南',takeaways:[],coverMediaId:null,blocks:[{id:'intro',type:'paragraph',runs:[{text:'依自己的狀態安排練習。',bold:false}]}]},true)
function signedFetch(result:(action:string,input:Record<string,unknown>)=>Record<string,unknown>,options:{signature?:string;bodyTransform?:(body:Record<string,unknown>)=>void}={}):typeof fetch {
  return vi.fn(async(url,init)=>{
    expect(String(url)).toMatch(/^https:\/\/doalignment\.com\/api\/first-party\/article-workbench\/(prepare|publish|status|media|media-read)$/)
    expect(init?.redirect).toBe('error')
    const input=JSON.parse(String(init!.body)),action=String(input.action),rawBody=String(init!.body),requestHash=sha256(rawBody)
    expect(new Headers(init?.headers).get('x-ds-article-signature')).toBe(articleProtocolSignature({direction:'request',action:action as 'prepare',origin:configuration.origin,rawBody,timestamp:input.timestamp,nonce:input.nonce},configuration.signingSecret))
    const body={version:ARTICLE_PROTOCOL,action,targetId:configuration.targetId,workspaceId:input.workspaceId,commandId:input.commandId,requestHash,observedAt:new Date().toISOString(),...result(action,input)}
    options.bodyTransform?.(body)
    const raw=JSON.stringify(body),signature=options.signature??articleProtocolSignature({direction:'response',action:action as 'prepare',origin:configuration.origin,rawBody:raw,timestamp:input.timestamp,nonce:input.nonce,requestHash},configuration.signingSecret)
    return new Response(raw,{headers:{'content-type':'application/json','x-ds-article-signature':signature}})
  }) as typeof fetch
}
const env={NUXT_ARTICLE_WORKBENCH_ENABLED:'true',NUXT_ARTICLE_WORKBENCH_OWNER_USER_ID:'1',NUXT_ARTICLE_WORKBENCH_TARGET_ID:configuration.targetId,NUXT_ARTICLE_WORKBENCH_OWNER_SCOPE_KEY:configuration.ownerScopeKey,NUXT_ARTICLE_WORKBENCH_SIGNING_SECRET:configuration.signingSecret,NUXT_WEEKLY_CONTENT_APPROVAL_ENABLED:'true',NUXT_WEEKLY_CONTENT_LIFF_ENABLED:'true',NUXT_WEEKLY_CONTENT_LIFF_ID:'2011849935-abcDEF',NUXT_WEEKLY_CONTENT_LINE_LOGIN_CHANNEL_ID:'2011849935',NUXT_WEEKLY_CONTENT_TOKEN_KEY:'k'.repeat(48),NUXT_WEEKLY_CONTENT_REVIEW_ORIGIN:'https://discoverystack-api.onrender.com',NUXT_WEEKLY_CONTENT_LINE_ACCESS_TOKEN:'line-token-for-fixture'}
const authority:ArticleAuthority={purpose:'owner_prepared_article_v1',ownerUserId:1,clientId:2,bindingId:3,bindingFingerprint:'d'.repeat(64),authorizedAt:new Date(Date.now()-2000).toISOString(),expiresAt:new Date(Date.now()+3600000).toISOString(),authorityFingerprint:mandateFingerprint,targetId:configuration.targetId,targetOrigin:configuration.origin,ownerScopeKey:configuration.ownerScopeKey,configurationFingerprint:'e'.repeat(64),credentialFingerprint:sha256(configuration.signingSecret)}
const publicationInput:ArticlePublishInput={workspaceId,version:2,documentHash:articleDocumentHash(document,[]),document,media:[],authority,retryKey:'fixture-stable-command',remotePostId:'site-post',remotePostVersion:1,approval:{approvedAt:new Date(Date.now()-1000).toISOString(),reviewFingerprint:'f'.repeat(64),approvedDocumentVersion:2,approvedDocumentHash:articleDocumentHash(document,[]),approvedMediaManifestHash:articleMediaManifestHash(document,[])}}
const receiptCore={workspaceId,documentVersion:2,documentHash:publicationInput.documentHash,mediaManifestHash:publicationInput.approval.approvedMediaManifestHash,reviewFingerprint:publicationInput.approval.reviewFingerprint,postId:'site-post',postVersion:2,publicationUrl:`${ARTICLE_SITE_ORIGIN}/journal/${document.slug}/`,publishedAt:new Date().toISOString(),status:'published'}
const receipt={...receiptCore,receiptHash:sha256(canonicalArticleJson(receiptCore))}
const repo={} as ArticleWorkbenchRepository
describe('fixed-origin authenticated article transport',()=>{
  it('accepts only a signed response bound to this exact request',async()=>{
    expect(await callArticleReceiver('status',command,configuration,{fetchImpl:signedFetch(()=>({status:'prepared'}))})).toMatchObject({ok:true,result:{status:'prepared'}})
    expect(await callArticleReceiver('status',command,configuration,{fetchImpl:signedFetch(()=>({status:'prepared'}),{signature:'0'.repeat(64)})})).toMatchObject({ok:false,errorCode:'article_receiver_receipt_unverified'})
  })
  it('rejects signed responses for another workspace or stale time',async()=>{
    for(const transform of [(row:Record<string,unknown>)=>{row.workspaceId=`aw_${'z'.repeat(32)}`},(row:Record<string,unknown>)=>{row.observedAt='2020-01-01T00:00:00.000Z'}])expect(await callArticleReceiver('status',command,configuration,{fetchImpl:signedFetch(()=>({status:'prepared'}),{bodyTransform:transform})})).toMatchObject({ok:false,errorCode:'article_receiver_receipt_unverified'})
  })
  it('fails closed before network for arbitrary origin or reserved-key shadowing',async()=>{
    const fetchImpl=vi.fn()
    expect(await callArticleReceiver('status',command,{...configuration,origin:'https://other.invalid' as typeof ARTICLE_SITE_ORIGIN},{fetchImpl})).toMatchObject({ok:false,retryable:false})
    expect(await callArticleReceiver('status',{...command,payload:{targetId:'other'}},configuration,{fetchImpl})).toMatchObject({ok:false,retryable:false})
    expect(fetchImpl).not.toHaveBeenCalled()
  })
  it('bounds a stalled provider even when it ignores AbortSignal',async()=>{
    const fetchImpl=vi.fn(()=>new Promise(()=>{})) as typeof fetch
    expect(await callArticleReceiver('status',command,configuration,{fetchImpl,timeoutMs:100})).toMatchObject({ok:false,retryable:true,errorCode:'article_receiver_outcome_unknown'})
  })
  it('bounds response streaming without trusting Content-Length',async()=>{
    const fetchImpl=vi.fn(async()=>new Response('a'.repeat(768*1024+1),{headers:{'content-type':'application/json'}})) as typeof fetch
    expect(await callArticleReceiver('status',command,configuration,{fetchImpl})).toMatchObject({ok:false,errorCode:'article_receiver_outcome_unknown'})
  })
})
describe('formal publication runtime',()=>{
  it('requires explicit configuration and an exact owner plus site',()=>{
    expect(articleReceiverRuntimeConfiguration({...env,NUXT_ARTICLE_WORKBENCH_ENABLED:'false'})).toBeNull()
    const deps=articleWorkbenchRuntimeDependencies({env,repository:repo})
    expect(deps.resolveTarget({ownerUserId:2,client:{ownerUserId:2,status:'active',canonicalSiteOrigin:ARTICLE_SITE_ORIGIN} as never})).toBeNull()
    expect(deps.resolveTarget({ownerUserId:1,client:{ownerUserId:1,status:'active',canonicalSiteOrigin:ARTICLE_SITE_ORIGIN} as never})).toMatchObject({targetOrigin:ARTICLE_SITE_ORIGIN,credentialFingerprint:sha256(configuration.signingSecret)})
  })
  it('reports published only with exact approval receipt AND current public state',async()=>{
    const fetchImpl=signedFetch(action=>action==='publish'?{status:'published',receipt}:{status:'published',postId:receipt.postId,postVersion:receipt.postVersion,publishedDocumentHash:receipt.documentHash,publicationUrl:receipt.publicationUrl,publishedAt:receipt.publishedAt,receipt})
    const deps=articleWorkbenchRuntimeDependencies({env,repository:repo,fetchImpl})
    expect(await deps.publish(publicationInput)).toEqual({published:true,url:receipt.publicationUrl,providerPostId:'site-post'})
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })
  it('does not report a draft acceptance, altered approval receipt or downstream archive as published',async()=>{
    for(const output of [{status:'prepared'}, {status:'published',receipt:{...receipt,reviewFingerprint:'0'.repeat(64)}}])expect(await articleWorkbenchRuntimeDependencies({env,repository:repo,fetchImpl:signedFetch(()=>output)}).publish(publicationInput)).toMatchObject({published:false})
    expect(await articleWorkbenchRuntimeDependencies({env,repository:repo,fetchImpl:signedFetch(action=>action==='publish'?{status:'published',receipt}:{status:'archived',receipt})}).publish(publicationInput)).toEqual({published:false,retryable:false,errorCode:'article_was_removed_on_site'})
  })
  it('puts only an authenticated workbench URI on the new LINE card, never action tokens',()=>{
    const message=buildArticleWorkbenchNotification({lineUserId:'private-not-in-message',workspaceId,title:document.title,retryKey:'fixture',expiresAt:authority.expiresAt},env.NUXT_WEEKLY_CONTENT_LIFF_ID)
    const raw=JSON.stringify(message)
    expect(raw).toContain(`/workbench?workspaceId=${workspaceId}`)
    expect(raw).not.toMatch(/postback|idToken|private-not-in-message|actionToken|停止發布|撤回/)
  })
})
describe('private bounded image normalization',()=>{
  it('re-encodes with metadata stripped and bounds dimensions',async()=>{
    const bytes=await sharp({create:{width:2100,height:20,channels:3,background:'#334455'}}).jpeg().withMetadata({exif:{IFD0:{Copyright:'private camera metadata'}}}).toBuffer()
    const image=await normalizeArticleImage(bytes.toString('base64'),'image/jpeg'),metadata=await sharp(image.bytes).metadata()
    expect(image.mimeType).toBe('image/webp');expect(image.width).toBe(1920);expect(image.size).toBeLessThanOrEqual(512*1024);expect(metadata.exif).toBeUndefined();expect(image.sha256).toBe(sha256(image.bytes))
  })
  it('rejects SVG, mismatched MIME and malformed bytes',async()=>{
    await expect(normalizeArticleImage(Buffer.from('<svg/>').toString('base64'),'image/svg+xml')).rejects.toMatchObject({statusCode:422})
    const bytes=await sharp({create:{width:2,height:2,channels:3,background:'white'}}).png().toBuffer()
    await expect(normalizeArticleImage(bytes.toString('base64'),'image/jpeg')).rejects.toMatchObject({statusCode:422})
    await expect(normalizeArticleImage('AAAA%%%','image/webp')).rejects.toMatchObject({statusCode:422})
  })
})

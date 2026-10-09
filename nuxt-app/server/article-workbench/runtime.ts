import {createError} from 'h3'
import {weeklyLiffConfiguration} from '../weekly-content/liff-service'
import {isWeeklyLineAccessToken,sendWeeklyLinePush,type WeeklyLineReviewMessage} from '../weekly-content/line-transport'
import {articleDocumentHash,articleReferencedMedia,validateArticleDocument} from './document'
import {createArticleWorkbenchRepository} from './repository'
import {ARTICLE_PROTOCOL,ARTICLE_SITE_ORIGIN,canonicalArticleJson,exactArticleDigest,sha256,type ReceiverReceipt} from './protocol'
import {callArticleReceiver,validArticleReceiverConfiguration,type ArticleReceiverConfiguration,type ArticleReceiverCommand} from './receiver-transport'
import type {ArticleWorkbenchDependencies} from './service'
import type {ArticleAuthority,ArticleNotifyInput,ArticlePrepareInput,ArticlePublishInput,ArticleTarget} from './types'

const HEX=/^[a-f0-9]{64}$/u
const configuredOwner=(env:Record<string,string|undefined>)=>Number(env.NUXT_ARTICLE_WORKBENCH_OWNER_USER_ID)
export function articleReceiverRuntimeConfiguration(env:Record<string,string|undefined>=process.env):ArticleReceiverConfiguration|null {
  const configuration:ArticleReceiverConfiguration={origin:ARTICLE_SITE_ORIGIN,targetId:env.NUXT_ARTICLE_WORKBENCH_TARGET_ID||'',ownerScopeKey:env.NUXT_ARTICLE_WORKBENCH_OWNER_SCOPE_KEY||'',signingSecret:env.NUXT_ARTICLE_WORKBENCH_SIGNING_SECRET||''}
  return env.NUXT_ARTICLE_WORKBENCH_ENABLED==='true'&&Number.isSafeInteger(configuredOwner(env))&&configuredOwner(env)>0&&validArticleReceiverConfiguration(configuration)?configuration:null
}
function targetConfiguration(configuration:ArticleReceiverConfiguration,ownerUserId:number):ArticleTarget {
  return {targetId:configuration.targetId,targetOrigin:configuration.origin,ownerScopeKey:configuration.ownerScopeKey,credentialFingerprint:sha256(configuration.signingSecret),configurationFingerprint:sha256(canonicalArticleJson({purpose:'do-alignment-manual-article-target-v1',protocol:ARTICLE_PROTOCOL,targetId:configuration.targetId,targetOrigin:configuration.origin,ownerScopeKey:configuration.ownerScopeKey,ownerUserId}))}
}
export function articleReceiverCommand(authority:ArticleAuthority,workspaceId:string,purpose:string,retryKey:string,payload:Record<string,unknown>):ArticleReceiverCommand {
  return {workspaceId,mandateFingerprint:authority.authorityFingerprint,commandId:sha256(canonicalArticleJson({purpose,workspaceId,mandateFingerprint:authority.authorityFingerprint,retryKey,payload})),payload}
}
function available(config:ArticleReceiverConfiguration|null):ArticleReceiverConfiguration {if(!config)throw createError({statusCode:503,statusMessage:'ARTICLE_TARGET_NOT_CONFIGURED'});return config}
function receiptMatches(raw:unknown,input:ArticlePublishInput):raw is ReceiverReceipt {
  if(!raw||typeof raw!=='object'||Array.isArray(raw))return false
  const receipt=raw as ReceiverReceipt,{receiptHash,...snapshot}=receipt
  const keys=['workspaceId','documentVersion','documentHash','mediaManifestHash','reviewFingerprint','postId','postVersion','publicationUrl','publishedAt','status','receiptHash']
  return Object.keys(receipt).length===keys.length&&keys.every(key=>Object.hasOwn(receipt,key))&&receipt.workspaceId===input.workspaceId&&receipt.documentVersion===input.version&&receipt.documentHash===input.documentHash&&receipt.mediaManifestHash===input.approval.approvedMediaManifestHash&&receipt.reviewFingerprint===input.approval.reviewFingerprint&&receipt.postId===input.remotePostId&&receipt.postVersion===input.remotePostVersion+1&&receipt.publicationUrl===`${ARTICLE_SITE_ORIGIN}/journal/${input.document.slug}/`&&receipt.status==='published'&&typeof receipt.publishedAt==='string'&&Number.isFinite(Date.parse(receipt.publishedAt))&&new Date(receipt.publishedAt).toISOString()===receipt.publishedAt&&Date.parse(receipt.publishedAt)>=Date.parse(input.approval.approvedAt)&&HEX.test(receiptHash)&&exactArticleDigest(receiptHash,sha256(canonicalArticleJson(snapshot)))
}
export function buildArticleWorkbenchNotification(input:ArticleNotifyInput,liffId:string):WeeklyLineReviewMessage {
  if(!/^[0-9]{8,15}-[A-Za-z0-9]{4,32}$/u.test(liffId)||!/^aw_[A-Za-z0-9_-]{32}$/u.test(input.workspaceId)||!input.title.trim()||!Number.isFinite(Date.parse(input.expiresAt)))throw createError({statusCode:503,statusMessage:'ARTICLE_NOTIFICATION_INVALID'})
  const url=new URL(`https://liff.line.me/${liffId}/workbench`);url.searchParams.set('workspaceId',input.workspaceId)
  const expires=new Intl.DateTimeFormat('zh-TW',{timeZone:'Asia/Taipei',month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit',hour12:false}).format(new Date(input.expiresAt))
  return {type:'flex',altText:'搜尋王：正式文章已備妥，請開啟工作台審稿。',contents:{type:'bubble',body:{type:'box',layout:'vertical',spacing:'md',contents:[{type:'text',text:'搜尋王・Do Alignment',weight:'bold',size:'sm',color:'#53635A'},{type:'text',text:'正式文章，請你審稿',weight:'bold',size:'lg',wrap:true},{type:'text',text:Array.from(input.title.trim()).slice(0,120).join(''),size:'md',wrap:true},{type:'text',text:'工作台可修改文字、加入配圖或留下修改意見。最後按下「同意並發布」才會送往公司的公開部落格；同意後這一版就不能再修改。',size:'sm',wrap:true,color:'#666666'},{type:'text',text:`審稿期限：${expires}（台灣時間）`,size:'xs',wrap:true,color:'#777777'}]},footer:{type:'box',layout:'vertical',contents:[{type:'button',style:'primary',action:{type:'uri',label:'開啟審稿工作台',uri:url.toString()}}]}}}
}
export function articleWorkbenchRuntimeDependencies(options:{env?:Record<string,string|undefined>;fetchImpl?:typeof fetch;repository?:ArticleWorkbenchDependencies['repository']}={}):ArticleWorkbenchDependencies {
  const env=options.env||process.env,configuration=articleReceiverRuntimeConfiguration(env),liff=weeklyLiffConfiguration(env),owner=configuredOwner(env)
  const enabled=!!configuration&&liff.enabled&&isWeeklyLineAccessToken(env.NUXT_WEEKLY_CONTENT_LINE_ACCESS_TOKEN)
  const invoke=(action:Parameters<typeof callArticleReceiver>[0],command:ArticleReceiverCommand)=>callArticleReceiver(action,command,available(configuration),{fetchImpl:options.fetchImpl})
  return {
    enabled,repository:options.repository||createArticleWorkbenchRepository(),
    resolveTarget:({ownerUserId,client})=>enabled&&configuration&&ownerUserId===owner&&client.ownerUserId===owner&&client.status==='active'&&client.canonicalSiteOrigin===ARTICLE_SITE_ORIGIN?targetConfiguration(configuration,owner):null,
    async prepare(input:ArticlePrepareInput) {
      const document=validateArticleDocument(input.document,true)
      if(input.media.length||articleDocumentHash(document,[])!==input.documentHash)throw createError({statusCode:409,statusMessage:'ARTICLE_PREPARATION_CHANGED'})
      const result=await invoke('prepare',articleReceiverCommand(input.authority,input.workspaceId,'article-prepare-v1',input.retryKey,{document,documentHash:input.documentHash}))
      if(!result.ok||result.result.status!=='prepared'||result.result.documentHash!==input.documentHash||typeof result.result.postId!=='string'||!/^[A-Za-z0-9_-]{1,128}$/u.test(result.result.postId)||result.result.postVersion!==1)throw createError({statusCode:503,statusMessage:'ARTICLE_PREPARATION_UNVERIFIED'})
      return {postId:result.result.postId,postVersion:1}
    },
    async notify(input) {
      if(!enabled||!liff.enabled)return {accepted:false,retryable:false,errorCode:'article_notification_not_configured'}
      return sendWeeklyLinePush({lineUserId:input.lineUserId,retryKey:input.retryKey,message:buildArticleWorkbenchNotification(input,liff.liffId)},{channelAccessToken:env.NUXT_WEEKLY_CONTENT_LINE_ACCESS_TOKEN||'',fetchImpl:options.fetchImpl})
    },
    async publish(input) {
      if(!enabled)return {published:false,retryable:false,errorCode:'article_publication_not_configured'}
      const document=validateArticleDocument(input.document,true),mediaManifest=articleReferencedMedia(document,input.media)
      if(articleDocumentHash(document,input.media)!==input.documentHash)return {published:false,retryable:false,errorCode:'article_publication_document_changed'}
      const result=await invoke('publish',articleReceiverCommand(input.authority,input.workspaceId,'article-publish-v1',input.retryKey,{documentVersion:input.version,expectedPostVersion:input.remotePostVersion,document,documentHash:input.documentHash,mediaManifest,approval:input.approval}))
      if(!result.ok)return {published:false,retryable:result.retryable,errorCode:result.errorCode}
      if(result.result.status!=='published'||!receiptMatches(result.result.receipt,input))return {published:false,retryable:true,errorCode:'article_publication_receipt_unverified'}
      const receipt=result.result.receipt
      // A draft acceptance or historical receipt is insufficient: check current visibility.
      const state=await invoke('status',articleReceiverCommand(input.authority,input.workspaceId,'article-status-v1',input.retryKey,{}))
      if(!state.ok)return {published:false,retryable:state.retryable,errorCode:'article_publication_visibility_unverified'}
      if(['private','archived'].includes(String(state.result.status)))return {published:false,retryable:false,errorCode:'article_was_removed_on_site'}
      if(state.result.status!=='published'||state.result.postId!==receipt.postId||state.result.postVersion!==receipt.postVersion||state.result.publishedDocumentHash!==receipt.documentHash||state.result.publicationUrl!==receipt.publicationUrl||state.result.publishedAt!==receipt.publishedAt||!receiptMatches(state.result.receipt,input))return {published:false,retryable:false,errorCode:'article_publication_visibility_changed'}
      return {published:true,url:receipt.publicationUrl,providerPostId:receipt.postId}
    },
  }
}

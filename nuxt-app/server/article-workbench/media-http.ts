import {createError,type H3Event} from 'h3'
import {z} from 'zod'
import {readBoundedRequestBody} from '../utils/bounded-request-body'
import {verifyWeeklyLiffIdentity} from '../weekly-content/liff-identity'
import {articleCustomerOrigin,articleCustomerHttpInput,articleIdInput,articleIdTokenInput,articleKeyInput} from './http'
import {ARTICLE_MEDIA_ID,type ArticleAuthority} from './types'
import {getArticleWorkspace,registerArticleMedia,validateCustomerWorkspace} from './service'
import {normalizeArticleImage} from './media-codec'
import {articleReceiverCommand,articleReceiverRuntimeConfiguration,articleWorkbenchRuntimeDependencies} from './runtime'
import {callArticleReceiver} from './receiver-transport'
import {ARTICLE_SITE_ORIGIN,sha256} from './protocol'

const mediaInput=z.object({idToken:articleIdTokenInput,workspaceId:articleIdInput,expectedVersion:z.number().int().min(1).max(100),idempotencyKey:articleKeyInput,filename:z.string().min(1).max(180).refine(value=>!/[\\/\u0000-\u001f\u007f]/u.test(value)),mimeType:z.enum(['image/jpeg','image/png','image/webp']),bytesBase64:z.string().min(4).max(1_500_000),rightsConfirmed:z.literal(true)}).strict()
const previewInput=z.object({idToken:articleIdTokenInput,workspaceId:articleIdInput,mediaId:z.string().regex(ARTICLE_MEDIA_ID).transform(value=>value.toLowerCase())}).strict()
const fail=(code:string,statusCode=503):never=>{throw createError({statusCode,statusMessage:code})}
function uploadId(workspaceId:string,key:string):string {
  const bytes=Buffer.from(sha256(`article-media-id-v1:${workspaceId}:${key}`).slice(0,32),'hex');bytes[6]=(bytes[6]!&15)|64;bytes[8]=(bytes[8]!&63)|128
  const hex=bytes.toString('hex');return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`
}
/** No filename, token, raw upload, EXIF or customer LINE id is persisted. */
export async function articleCustomerUpload(event:H3Event) {
  const configuration=articleCustomerOrigin(event)
  const raw=await readBoundedRequestBody(event,{maxBytes:1_520_000,oversizedMessage:'圖片內容過大。',invalidMessage:'圖片資料格式不正確。',invalidStatusCode:422}),input=mediaInput.parse(raw)
  const identity=await verifyWeeklyLiffIdentity(input.idToken,{channelId:configuration.channelId}),dependencies=articleWorkbenchRuntimeDependencies()
  const context=await validateCustomerWorkspace({workspaceId:input.workspaceId,identity,expectedVersion:input.expectedVersion},dependencies)
  const image=await normalizeArticleImage(input.bytesBase64,input.mimeType),mediaId=uploadId(input.workspaceId,input.idempotencyKey),existing=context.media.find(item=>item.id===mediaId)
  if(existing&&existing.sha256!==image.sha256)return fail('ARTICLE_MEDIA_COLLISION',409)
  if(!existing&&(context.media.length>=30||context.media.reduce((total,item)=>total+item.size,0)+image.size>15*1024*1024))return fail('ARTICLE_MEDIA_LIMIT',422)
  const receiver=articleReceiverRuntimeConfiguration();if(!receiver)return fail('ARTICLE_TARGET_NOT_CONFIGURED')
  const payload={mediaId,bytesBase64:image.bytesBase64,sha256:image.sha256,width:image.width,height:image.height}
  const result=await callArticleReceiver('media',articleReceiverCommand(context.authority,input.workspaceId,'article-media-v1',input.idempotencyKey,payload),receiver)
  if(!result.ok)return fail(result.errorCode,result.retryable?503:409)
  const media=result.result.media as Record<string,unknown>|undefined
  if(result.result.status!=='media_ready'||result.result.postId!==context.remotePostId||!media||media.mediaId!==mediaId||media.sha256!==image.sha256||media.size!==image.size||media.width!==image.width||media.height!==image.height)return fail('ARTICLE_MEDIA_RECEIPT_UNVERIFIED')
  // Re-authentication and an exact-version lock after upload fence approval/rebinding races.
  return registerArticleMedia({workspaceId:input.workspaceId,actor:{kind:'customer',identity},expectedVersion:input.expectedVersion,media:{id:mediaId,sha256:image.sha256,version:1,mimeType:'image/webp',size:image.size,width:image.width,height:image.height,url:`${ARTICLE_SITE_ORIGIN}/journal/media/${mediaId}/`}},dependencies)
}
/** Draft images are delivered only by authenticated POST as no-store bytes, never bearer URLs. */
export async function articleCustomerMediaPreview(event:H3Event) {
  const {input,actor,dependencies}=await articleCustomerHttpInput(event,previewInput)
  const {workspace}=await getArticleWorkspace({workspaceId:input.workspaceId,actor},dependencies)
  const media=workspace.media.find(item=>item.id===input.mediaId);if(!media)return fail('ARTICLE_MEDIA_NOT_AVAILABLE',404)
  const row=await dependencies.repository.getWorkspace(input.workspaceId),receiver=articleReceiverRuntimeConfiguration()
  if(!row||!receiver)return fail('ARTICLE_MEDIA_NOT_AVAILABLE',404)
  const result=await callArticleReceiver('media-read',articleReceiverCommand(row.authority as ArticleAuthority,input.workspaceId,'article-media-preview-v1',input.mediaId,{mediaId:input.mediaId}),receiver)
  if(!result.ok)return fail(result.errorCode,result.retryable?503:404)
  const output=result.result.media as Record<string,unknown>|undefined
  if(result.result.status!=='media_ready'||!output||output.mediaId!==input.mediaId||output.sha256!==media.sha256||output.size!==media.size||output.width!==media.width||output.height!==media.height||typeof output.bytesBase64!=='string'||output.bytesBase64.length>700_000||!/^([A-Za-z0-9+/]{4})*([A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(output.bytesBase64))return fail('ARTICLE_MEDIA_RECEIPT_UNVERIFIED')
  const bytes=Buffer.from(output.bytesBase64,'base64')
  if(bytes.length!==media.size||bytes.toString('base64')!==output.bytesBase64||sha256(bytes)!==media.sha256||bytes.subarray(0,4).toString()!=='RIFF'||bytes.subarray(8,12).toString()!=='WEBP')return fail('ARTICLE_MEDIA_RECEIPT_UNVERIFIED')
  const latest=await getArticleWorkspace({workspaceId:input.workspaceId,actor},dependencies)
  if(!latest.workspace.media.some(item=>item.id===input.mediaId&&item.sha256===media.sha256&&item.version===media.version))return fail('ARTICLE_MEDIA_NOT_AVAILABLE',404)
  return {mimeType:'image/webp' as const,bytesBase64:output.bytesBase64}
}

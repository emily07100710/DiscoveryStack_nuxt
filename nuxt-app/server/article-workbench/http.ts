import {createError,getRequestHeader,setResponseHeaders,type H3Event} from 'h3'
import {z,ZodError,type ZodType} from 'zod'
import {readBoundedRequestBody} from '../utils/bounded-request-body'
import {requireWeeklyOwner} from '../weekly-content/http'
import {verifyWeeklyLiffIdentity} from '../weekly-content/liff-identity'
import {weeklyLiffConfiguration,WEEKLY_LIFF_HEADERS} from '../weekly-content/liff-service'
import {articleWorkbenchRuntimeDependencies} from './runtime'
import {articleDocumentInput} from './document'
import {ARTICLE_CUSTOMER_CONFIRMATION,ARTICLE_OWNER_CONFIRMATION,ARTICLE_WORKSPACE_ID} from './types'

export const articleIdInput=z.string().regex(ARTICLE_WORKSPACE_ID)
export const articleKeyInput=z.string().regex(/^[A-Za-z0-9._:-]{8,128}$/u)
export const articleIdTokenInput=z.string().max(8192).regex(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u)
const mutation={workspaceId:articleIdInput,expectedVersion:z.number().int().min(1).max(100),idempotencyKey:articleKeyInput}
export const articleContextInput=z.object({idToken:articleIdTokenInput,workspaceId:articleIdInput}).strict()
export const articleSaveInput=z.object({idToken:articleIdTokenInput,...mutation,document:articleDocumentInput}).strict()
export const articleFeedbackInput=z.object({idToken:articleIdTokenInput,...mutation,note:z.string().min(1).max(4000)}).strict()
export const articleApproveInput=z.object({idToken:articleIdTokenInput,...mutation,documentHash:z.string().regex(/^[a-f0-9]{64}$/u),confirmation:z.literal(ARTICLE_CUSTOMER_CONFIRMATION)}).strict()
export const articleOwnerCreateInput=z.object({document:articleDocumentInput,idempotencyKey:articleKeyInput,confirmation:z.literal(ARTICLE_OWNER_CONFIRMATION)}).strict()
export const articleOwnerSaveInput=z.object({...mutation,document:articleDocumentInput}).strict()
export const articleOwnerRetryInput=z.object({workspaceId:articleIdInput,confirmation:z.literal('RETRY_FORMAL_ARTICLE')}).strict()
export const articleOwnerSendRevisionInput=z.object({workspaceId:articleIdInput,expectedVersion:z.number().int().min(1).max(100),confirmation:z.literal('SEND_REVISED_FORMAL_ARTICLE')}).strict()

const fail=(code:string,statusCode=403):never=>{throw createError({statusCode,statusMessage:code})}
export function articleCustomerOrigin(event:H3Event){
  setResponseHeaders(event,WEEKLY_LIFF_HEADERS)
  const configuration=weeklyLiffConfiguration()
  if(!configuration.enabled)return fail('ARTICLE_CUSTOMER_LOGIN_DISABLED',503)
  if(getRequestHeader(event,'origin')!==configuration.origin||getRequestHeader(event,'sec-fetch-site')!=='same-origin'||!/^application\/json(?:;|$)/iu.test(getRequestHeader(event,'content-type')||''))return fail('ARTICLE_ORIGIN_REQUIRED')
  return configuration
}
export async function articleCustomerHttpInput<T extends {idToken:string}>(event:H3Event,schema:ZodType<T>){
  const configuration=articleCustomerOrigin(event)
  const raw=await readBoundedRequestBody(event,{maxBytes:160*1024,oversizedMessage:'文章內容過大。',invalidMessage:'文章資料格式不正確。',invalidStatusCode:422})
  const input=schema.parse(raw)
  const identity=await verifyWeeklyLiffIdentity(input.idToken,{channelId:configuration.channelId})
  const dependencies=articleWorkbenchRuntimeDependencies()
  // The raw token is only local to this request. Services receive the verified identity, never the token.
  return {input,identity,actor:{kind:'customer' as const,identity},dependencies}
}
export async function articleOwnerHttpInput<T>(event:H3Event,schema:ZodType<T>){
  if(getRequestHeader(event,'sec-fetch-site')!=='same-origin')return fail('ARTICLE_OWNER_ORIGIN_REQUIRED')
  const ownerUserId=await requireWeeklyOwner(event,true)
  const raw=await readBoundedRequestBody(event,{maxBytes:144*1024,oversizedMessage:'文章內容過大。',invalidMessage:'文章資料格式不正確。',invalidStatusCode:422})
  return {ownerUserId,input:schema.parse(raw),dependencies:articleWorkbenchRuntimeDependencies()}
}
export function articlePublicError(cause:unknown):never{
  const rawStatus=Number((cause as {statusCode?:unknown})?.statusCode),original=cause instanceof ZodError||rawStatus===400?422:rawStatus,statusCode=[401,403,404,409,413,422,503].includes(original)?original:503
  const messages:Record<number,string>={401:'LINE 登入已失效，請重新登入。',403:'你沒有這篇文章的編輯權限，請從搜尋王的連結操作。',404:'找不到有效文章。',409:'文章版本或權限已變動；已同意的文章不能再修改，請重新整理。',413:'文章或圖片內容過大。',422:'請檢查文章欄位、圖片描述與操作內容。',503:'文章工作台尚未準備完成，請稍後重試或聯絡服務人員。'}
  throw createError({statusCode,statusMessage:messages[statusCode]})
}

import {createError,getRequestHeader,setResponseHeaders,type H3Event} from 'h3'
import {ZodError} from 'zod'
import {requireOwner} from '../utils/auth'
import {getOwnerDatabaseUserId} from '../audit/repository'
import {readBoundedRequestBody} from '../utils/bounded-request-body'
import {createWeeklyContentRepository} from './repository'
export const WEEKLY_OWNER_HEADERS={'cache-control':'private, no-store, max-age=0','x-robots-tag':'noindex, nofollow, noarchive','referrer-policy':'no-referrer'}
export function weeklyFeatureEnabled(){return process.env.NUXT_WEEKLY_CONTENT_APPROVAL_ENABLED === 'true'}
export function weeklyRuntimeDependencies(){
  if(!weeklyFeatureEnabled())throw createError({statusCode:503,statusMessage:'每週文章送審尚未啟用。'})
  const tokenKey=process.env.NUXT_WEEKLY_CONTENT_TOKEN_KEY || ''
  if(tokenKey.length<32 || tokenKey.length>512)throw createError({statusCode:503,statusMessage:'文章送審的安全設定尚未完成。'})
  return {featureEnabled:true,tokenKey,repository:createWeeklyContentRepository()}
}
export async function requireWeeklyOwner(event:H3Event,mutating=false){
  setResponseHeaders(event,WEEKLY_OWNER_HEADERS)
  if(mutating){
    const configured=process.env.NUXT_WEEKLY_CONTENT_REVIEW_ORIGIN || process.env.NUXT_DISCOVERYSTACK_PRIVATE_ORIGIN || ''
    let origin:string
    try{const url=new URL(configured);if(url.protocol!=='https:'||url.username||url.password||url.pathname!=='/'||url.search||url.hash)throw new Error();origin=url.origin}catch{throw createError({statusCode:503,statusMessage:'文章送審的網站設定尚未完成。'})}
    if(getRequestHeader(event,'origin')!==origin || !/^application\/json(?:;|$)/i.test(getRequestHeader(event,'content-type')||''))throw createError({statusCode:403,statusMessage:'請從搜尋王後台操作。'})
  }
  const owner=await requireOwner(event)
  return getOwnerDatabaseUserId(owner.openId)
}
export function weeklyPathId(event:H3Event,name='id'){
  const value=event.context.params?.[name]
  if(typeof value!=='string'||!/^\d{1,10}$/.test(value)||Number(value)<1||!Number.isSafeInteger(Number(value)))throw createError({statusCode:422,statusMessage:'客戶或文章編號不正確。'})
  return Number(value)
}
export async function weeklyBody(event:H3Event){
 try{return await readBoundedRequestBody(event,{maxBytes:4096,oversizedMessage:'設定內容過大。',invalidMessage:'設定內容不正確。',invalidStatusCode:422})}
 catch(error){if(Number((error as {statusCode?:unknown})?.statusCode)===400)throw createError({statusCode:422,statusMessage:'設定內容不正確。'});throw error}
}
export function weeklyPublicError(error:unknown):never{
  const code=error instanceof ZodError ? 422 : Number((error as {statusCode?:unknown})?.statusCode)
  if([401,403,404,409,413,422,503].includes(code))throw createError({statusCode:code,statusMessage: code===401?'請先登入後台。':code===403?'操作權限不足。':code===404?'找不到有效的文章或客戶。':code===409?'資料已變動或送審已失效，請重新整理。':code===422?'請檢查選擇的客戶、發文規則與文章。':code===413?'內容過大。':'送審設定尚未完成，請先完成設定。'})
  throw createError({statusCode:503,statusMessage:'文章送審暫時無法使用，請稍後重試。'})
}

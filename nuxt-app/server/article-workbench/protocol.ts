import {createHash,createHmac,timingSafeEqual} from 'node:crypto'

export const ARTICLE_PROTOCOL='ds-article-workbench-v1' as const
export const ARTICLE_SITE_ORIGIN='https://doalignment.com' as const
export const ARTICLE_ACTIONS=['prepare','media','media-read','publish','status'] as const
export type ArticleReceiverAction=typeof ARTICLE_ACTIONS[number]
export type ReceiverMedia={mediaId:string;sha256:string;size:number;width:number;height:number}
export type ReceiverReceipt={workspaceId:string;documentVersion:number;documentHash:string;mediaManifestHash:string;reviewFingerprint:string;postId:string;postVersion:number;publicationUrl:string;publishedAt:string;status:'published';receiptHash:string}
export const sha256=(value:string|Uint8Array)=>createHash('sha256').update(value).digest('hex')
export function canonicalArticleJson(value:unknown):string {
  const normalize=(item:unknown):unknown=>{
    if(item===null||typeof item==='string'||typeof item==='boolean')return item
    if(typeof item==='number'&&Number.isFinite(item))return item
    if(Array.isArray(item))return item.map(normalize)
    if(item&&typeof item==='object'&&Object.getPrototypeOf(item)===Object.prototype)return Object.fromEntries(Object.keys(item).sort().map(key=>[key,normalize((item as Record<string,unknown>)[key])]))
    throw new Error('ARTICLE_CANONICAL_VALUE_INVALID')
  }
  return JSON.stringify(normalize(value))
}
export function articleProtocolSignature(input:{direction:'request'|'response';action:ArticleReceiverAction;origin:string;rawBody:string;timestamp:string;nonce:string;requestHash?:string},secret:string):string {
  const fields=[ARTICLE_PROTOCOL,input.direction,'POST',`/api/first-party/article-workbench/${input.action}`,input.origin]
  if(input.direction==='response')fields.push(input.requestHash||'')
  fields.push(sha256(input.rawBody),input.timestamp,input.nonce)
  return createHmac('sha256',secret).update(fields.join('\n')).digest('hex')
}
export function exactArticleDigest(actual:unknown,expected:string):boolean {
  return typeof actual==='string'&&/^[a-f0-9]{64}$/u.test(actual)&&/^[a-f0-9]{64}$/u.test(expected)&&timingSafeEqual(Buffer.from(actual,'hex'),Buffer.from(expected,'hex'))
}
export function articleManifestHash(media:ReceiverMedia[]):string {return sha256(canonicalArticleJson([...media].sort((a,b)=>a.mediaId.localeCompare(b.mediaId))))}

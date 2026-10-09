import {randomBytes} from 'node:crypto'
import {ARTICLE_PROTOCOL,ARTICLE_SITE_ORIGIN,articleProtocolSignature,exactArticleDigest,sha256,type ArticleReceiverAction} from './protocol'

export type ArticleReceiverConfiguration={targetId:string;ownerScopeKey:string;signingSecret:string;origin:typeof ARTICLE_SITE_ORIGIN}
export type ArticleReceiverCommand={workspaceId:string;mandateFingerprint:string;commandId:string;payload:Record<string,unknown>}
export type ArticleReceiverResult={ok:true;result:Record<string,unknown>}|{ok:false;retryable:boolean;errorCode:string}
const MAX_RESPONSE_BYTES=768*1024
const HEX=/^[a-f0-9]{64}$/u
export function validArticleReceiverConfiguration(config:ArticleReceiverConfiguration):boolean {
  return config.origin===ARTICLE_SITE_ORIGIN&&/^[A-Za-z0-9_-]{3,100}$/u.test(config.targetId)&&/^[A-Za-z0-9_-]{3,100}$/u.test(config.ownerScopeKey)&&Buffer.byteLength(config.signingSecret)>=32&&Buffer.byteLength(config.signingSecret)<=512
}
/** One fixed HTTPS receiver. A signed acceptance is still not proof of public visibility. */
export async function callArticleReceiver(action:ArticleReceiverAction,command:ArticleReceiverCommand,configuration:ArticleReceiverConfiguration,deps:{fetchImpl?:typeof fetch;now?:Date;timeoutMs?:number}={}):Promise<ArticleReceiverResult> {
  if(!validArticleReceiverConfiguration(configuration)||!/^aw_[A-Za-z0-9_-]{32}$/u.test(command.workspaceId)||!HEX.test(command.mandateFingerprint)||!/^[A-Za-z0-9_-]{32,128}$/u.test(command.commandId))return {ok:false,retryable:false,errorCode:'article_receiver_not_configured'}
  const timestamp=(deps.now||new Date()).toISOString(),nonce=randomBytes(24).toString('base64url')
  const base={version:ARTICLE_PROTOCOL,action,targetId:configuration.targetId,ownerScopeKey:configuration.ownerScopeKey,workspaceId:command.workspaceId,mandateFingerprint:command.mandateFingerprint,commandId:command.commandId,timestamp,nonce}
  if(Object.keys(command.payload).some(key=>Object.hasOwn(base,key)))return {ok:false,retryable:false,errorCode:'article_receiver_command_invalid'}
  const rawBody=JSON.stringify({...base,...command.payload}),requestHash=sha256(rawBody)
  if(Buffer.byteLength(rawBody)>MAX_RESPONSE_BYTES)return {ok:false,retryable:false,errorCode:'article_receiver_command_oversized'}
  const signature=articleProtocolSignature({direction:'request',action,origin:configuration.origin,rawBody,timestamp,nonce},configuration.signingSecret)
  const controller=new AbortController(),timeout=Math.min(25_000,Math.max(100,deps.timeoutMs||20_000))
  const aborted=new Promise<never>((_resolve,reject)=>controller.signal.addEventListener('abort',()=>reject(new Error('ARTICLE_RECEIVER_TIMEOUT')),{once:true}))
  const bounded=<T>(work:Promise<T>):Promise<T>=>Promise.race([work,aborted])
  const timer=setTimeout(()=>controller.abort(),timeout);timer.unref?.()
  let reader:ReadableStreamDefaultReader<Uint8Array>|undefined
  try {
    const response=await bounded((deps.fetchImpl||fetch)(`${configuration.origin}/api/first-party/article-workbench/${action}`,{method:'POST',redirect:'error',signal:controller.signal,headers:{'content-type':'application/json','x-ds-article-signature':signature},body:rawBody}))
    if(response.status!==200||response.redirected){void response.body?.cancel().catch(()=>undefined);return {ok:false,retryable:response.status>=500||response.status===429,errorCode:response.status===409?'article_receiver_version_conflict':response.status===403||response.status===401?'article_receiver_authority_rejected':response.status===413?'article_receiver_payload_oversized':'article_receiver_unavailable'}}
    if(!/^application\/json(?:;|$)/iu.test(response.headers.get('content-type')||'')||!response.body)return {ok:false,retryable:true,errorCode:'article_receiver_outcome_unknown'}
    const advertised=response.headers.get('content-length');if(advertised&&(!/^\d+$/u.test(advertised)||Number(advertised)>MAX_RESPONSE_BYTES)){void response.body.cancel().catch(()=>undefined);return {ok:false,retryable:true,errorCode:'article_receiver_outcome_unknown'}}
    reader=response.body.getReader();const chunks:Uint8Array[]=[];let bytes=0
    while(true){const next=await bounded(reader.read());if(next.done)break;bytes+=next.value.byteLength;if(bytes>MAX_RESPONSE_BYTES){void reader.cancel().catch(()=>undefined);return {ok:false,retryable:true,errorCode:'article_receiver_outcome_unknown'}}chunks.push(next.value)}
    const rawResponse=new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks.map(item=>Buffer.from(item)),bytes))
    const expected=articleProtocolSignature({direction:'response',action,origin:configuration.origin,rawBody:rawResponse,timestamp,nonce,requestHash},configuration.signingSecret)
    if(!exactArticleDigest(response.headers.get('x-ds-article-signature'),expected))return {ok:false,retryable:true,errorCode:'article_receiver_receipt_unverified'}
    const result:unknown=JSON.parse(rawResponse)
    if(!result||typeof result!=='object'||Array.isArray(result))return {ok:false,retryable:true,errorCode:'article_receiver_receipt_unverified'}
    const row=result as Record<string,unknown>
    if(row.version!==ARTICLE_PROTOCOL||row.action!==action||row.targetId!==configuration.targetId||row.workspaceId!==command.workspaceId||row.commandId!==command.commandId||row.requestHash!==requestHash||typeof row.observedAt!=='string'||!Number.isFinite(Date.parse(row.observedAt))||new Date(row.observedAt).toISOString()!==row.observedAt||Math.abs(Date.parse(row.observedAt)-Date.parse(timestamp))>300_000)return {ok:false,retryable:true,errorCode:'article_receiver_receipt_unverified'}
    return {ok:true,result:row}
  }catch{return {ok:false,retryable:true,errorCode:'article_receiver_outcome_unknown'}}
  finally{clearTimeout(timer);if(reader){void reader.cancel().catch(()=>undefined);reader.releaseLock()}}
}

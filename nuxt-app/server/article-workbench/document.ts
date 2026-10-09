import {createHash} from 'node:crypto'
import {createError} from 'h3'
import {z} from 'zod'
import {ARTICLE_MEDIA_ID,type ArticleDocument,type ArticleMediaManifest} from './types'
import {canonicalArticleJson} from './protocol'

const text=(max:number,trim=true)=>z.string().max(max).refine(value=>!/[<>\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)).transform(value=>trim?value.trim():value)
const id=z.string().regex(ARTICLE_MEDIA_ID).transform(value=>value.toLowerCase())
const blockId=z.string().regex(/^[A-Za-z0-9_-]{1,64}$/u)
const run=z.object({text:text(24_000,false),bold:z.boolean().optional(),italic:z.boolean().optional(),color:z.string().regex(/^#[0-9a-fA-F]{6}$/u).optional()}).strict()
const block=z.discriminatedUnion('type',[
  z.object({id:blockId,type:z.enum(['paragraph','heading','quote']),runs:z.array(run).min(1).max(500)}).strict(),
  z.object({id:blockId,type:z.literal('image'),mediaId:id,alt:text(240),caption:text(500),layout:z.enum(['auto','wide'])}).strict(),
])
export const articleDocumentInput=z.object({schemaVersion:z.literal(1),title:text(160),slug:text(100).refine(value=>!value||value!=='media'&&value.length>=3&&/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(value)),summary:text(500),category:text(40),takeaways:z.array(text(240)).max(3),coverMediaId:id.nullable(),blocks:z.array(block).min(1).max(100)}).strict()
const invalid=():never=>{throw createError({statusCode:422,statusMessage:'ARTICLE_DOCUMENT_INVALID'})}
export function validateArticleDocument(raw:unknown,publishing=false):ArticleDocument {
  const parsed=articleDocumentInput.parse(raw)
  const ids=new Set<string>()
  let characters=parsed.title.length+parsed.summary.length+parsed.category.length+parsed.takeaways.reduce((total,item)=>total+item.length,0)
  for(const item of parsed.blocks){if(ids.has(item.id))return invalid();ids.add(item.id);characters+=item.type==='image'?item.alt.length+item.caption.length:item.runs.reduce((total,current)=>total+current.text.length,0)}
  if(characters>24_000||Buffer.byteLength(JSON.stringify(parsed))>128*1024||articleMediaIds(parsed).length>10)return invalid()
  if(publishing&&(!parsed.title||!parsed.slug||!parsed.summary||!parsed.category||!parsed.blocks.some(item=>item.type!=='image'&&item.runs.some(current=>current.text.trim()))))return invalid()
  if(publishing&&parsed.blocks.some(item=>item.type==='image'&&!item.alt))return invalid()
  // Reconstruct every level in schema order; browser object ordering is not authority.
  return {schemaVersion:1,title:parsed.title,slug:parsed.slug,summary:parsed.summary,category:parsed.category,takeaways:parsed.takeaways.filter(Boolean),coverMediaId:parsed.coverMediaId,blocks:parsed.blocks.map(item=>item.type==='image'?{id:item.id,type:'image',mediaId:item.mediaId,alt:item.alt,caption:item.caption,layout:item.layout}:{id:item.id,type:item.type,runs:item.runs.map(current=>({text:current.text,...(current.bold?{bold:true}:{}),...(current.italic?{italic:true}:{}),...(current.color?{color:current.color.toLowerCase()}: {})}))})}
}
export function articleMediaIds(document:ArticleDocument):string[]{return [...new Set([...(document.coverMediaId?[document.coverMediaId]:[]),...document.blocks.flatMap(item=>item.type==='image'?[item.mediaId]:[])])].sort()}
export function articleDocumentHash(document:ArticleDocument,media:ArticleMediaManifest[]):string{
  return createHash('sha256').update(articleCanonicalJson({document,mediaManifest:articleReferencedMedia(document,media)})).digest('hex')
}
export const articleCanonicalJson=canonicalArticleJson
export function articleReferencedMedia(document:ArticleDocument,media:ArticleMediaManifest[]){return articleMediaIds(document).map(mediaId=>{const item=media.find(row=>row.id===mediaId);if(!item)return invalid();return {mediaId:item.id,sha256:item.sha256,size:item.size,width:item.width,height:item.height}})}
export function articleMediaManifestHash(document:ArticleDocument,media:ArticleMediaManifest[]):string{return createHash('sha256').update(articleCanonicalJson(articleReferencedMedia(document,media))).digest('hex')}
export function validateArticleMedia(raw:ArticleMediaManifest):ArticleMediaManifest{
  if(!ARTICLE_MEDIA_ID.test(raw.id)||!/^[a-f0-9]{64}$/u.test(raw.sha256)||!Number.isSafeInteger(raw.version)||raw.version!==1||!['image/jpeg','image/png','image/webp'].includes(raw.mimeType)||!Number.isSafeInteger(raw.size)||raw.size<1||raw.size>512*1024||!Number.isSafeInteger(raw.width)||!Number.isSafeInteger(raw.height)||raw.width<1||raw.height<1||raw.width>1920||raw.height>1920||raw.width*raw.height>1920*1920)return invalid()
  let url:URL;try{url=new URL(raw.url)}catch{return invalid()}
  if(url.protocol!=='https:'||url.username||url.password||url.hash||url.search||url.href.length>2048)return invalid()
  return {id:raw.id.toLowerCase(),sha256:raw.sha256,version:raw.version,mimeType:raw.mimeType,size:raw.size,width:raw.width,height:raw.height,url:url.href}
}

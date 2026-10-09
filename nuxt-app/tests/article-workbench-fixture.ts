import {vi} from 'vitest'
import {fixtureClient} from './fixtures/content-operations/repository'
import type {ArticleWorkbenchRepository,ArticleWorkspaceRow,ArticleWorkspaceInsert,ArticleRevisionRow,ArticleMediaRow,ArticleFeedbackRow,ArticleOperationRow} from '../server/article-workbench/repository'
import type {ArticleWorkbenchDependencies} from '../server/article-workbench/service'
import type {ArticleDocument,ArticleIdentity,ArticleMediaManifest,ArticleTarget} from '../server/article-workbench/types'

export const ARTICLE_NOW=new Date('2026-10-10T00:00:00.000Z')
export const ARTICLE_LINE_ID=`U${'a'.repeat(32)}`
export const ARTICLE_IDENTITY:ArticleIdentity={lineUserId:ARTICLE_LINE_ID,channelId:'1234567890',expiresAtSeconds:Math.floor(ARTICLE_NOW.getTime()/1000)+3600}
export const ARTICLE_DOCUMENT:ArticleDocument={schemaVersion:1,title:'合成練習文章',slug:'synthetic-practice-note',summary:'這是只用於測試的摘要。',category:'合成文章',takeaways:['先準備問題'],coverMediaId:null,blocks:[{id:'synthetic-p1',type:'paragraph',runs:[{text:'這是合成文章內文，沒有真實客戶資料。'}]}]}
export const ARTICLE_MEDIA:ArticleMediaManifest={id:'12345678-1234-1234-1234-123456789012',sha256:'b'.repeat(64),version:1,mimeType:'image/webp',size:80,width:20,height:20,url:'https://doalignment.com/api/blog/media/12345678-1234-1234-1234-123456789012'}
export class ArticleFixture {
  state={client:{...fixtureClient(1,1),canonicalSiteOrigin:'https://doalignment.com',displayName:'Synthetic Do Alignment'},binding:{id:11,ownerUserId:1,clientId:1,lineUserId:ARTICLE_LINE_ID,bindingFingerprint:'c'.repeat(64),status:'active' as 'active'|'revoked',createdAt:ARTICLE_NOW,updatedAt:ARTICLE_NOW},target:{targetId:'synthetic-target',targetOrigin:'https://doalignment.com',ownerScopeKey:'synthetic-owner-scope',configurationFingerprint:'d'.repeat(64),credentialFingerprint:'e'.repeat(64)} as ArticleTarget|null,workspaces:[] as ArticleWorkspaceRow[],revisions:[] as ArticleRevisionRow[],media:[] as ArticleMediaRow[],feedback:[] as ArticleFeedbackRow[],operations:[] as ArticleOperationRow[],nextId:0}
  private tail:Promise<void>=Promise.resolve()
  readonly repository:ArticleWorkbenchRepository
  readonly deps:ArticleWorkbenchDependencies
  constructor(){
    const saved=<T>(value:T)=>({...structuredClone(value),id:++this.state.nextId,createdAt:ARTICLE_NOW,updatedAt:ARTICLE_NOW})
    const find=(id:string)=>this.state.workspaces.find(row=>row.workspaceId===id)||null
    this.repository={
      transaction:async<T>(work:(repo:ArticleWorkbenchRepository)=>Promise<T>):Promise<T>=>{const before=this.tail;let release!:()=>void;this.tail=new Promise(resolve=>{release=resolve});await before;const snapshot=structuredClone(this.state);try{return await work(this.repository)}catch(cause){this.state=snapshot;throw cause}finally{release()}},
      findClient:vi.fn(async(owner,id)=>owner===1&&id===1?this.state.client:null),
      getBinding:vi.fn(async(owner,id)=>owner===1&&id===1?this.state.binding:null),
      getWorkspace:vi.fn(async id=>find(id)),
      findOwnerKey:vi.fn(async(owner,client,key)=>this.state.workspaces.find(row=>row.ownerUserId===owner&&row.clientId===client&&row.ownerIdempotencyKey===key)||null),
      listWorkspaces:vi.fn(async(owner,client)=>this.state.workspaces.filter(row=>row.ownerUserId===owner&&row.clientId===client).toReversed()),
      insertWorkspace:vi.fn(async(value:ArticleWorkspaceInsert)=>{const row=saved(value);this.state.workspaces.push(row);return row}),
      updateWorkspace:vi.fn(async(id,patch)=>{const row=this.state.workspaces.find(value=>value.id===id);if(!row)throw new Error('fixture row missing');Object.assign(row,structuredClone(patch))}),
      listMedia:vi.fn(async id=>this.state.media.filter(row=>row.workspaceRowId===id)),
      insertMedia:vi.fn(async value=>{this.state.media.push(saved(value))}),
      listFeedback:vi.fn(async id=>this.state.feedback.filter(row=>row.workspaceRowId===id)),
      insertFeedback:vi.fn(async value=>{this.state.feedback.push(saved(value))}),
      getRevision:vi.fn(async(id,version)=>this.state.revisions.find(row=>row.workspaceRowId===id&&row.version===version)||null),
      insertRevision:vi.fn(async value=>{this.state.revisions.push(saved(value))}),
      getOperation:vi.fn(async(id,operation,key)=>this.state.operations.find(row=>row.workspaceRowId===id&&row.operation===operation&&row.idempotencyKey===key)||null),
      insertOperation:vi.fn(async value=>{this.state.operations.push(saved(value))}),
    }
    this.deps={repository:this.repository,enabled:true,resolveTarget:vi.fn(async()=>this.state.target),prepare:vi.fn(async()=>({postId:'synthetic-post',postVersion:1 as const})),notify:vi.fn(async()=>({accepted:true as const,providerMessageId:'synthetic-line-receipt'})),publish:vi.fn(async input=>({published:true as const,url:`https://doalignment.com/journal/${input.document.slug}/`,providerPostId:'synthetic-post'})),now:ARTICLE_NOW}
  }
  actor(){return {kind:'customer' as const,identity:{...ARTICLE_IDENTITY}}}
  createInput(){return {ownerUserId:1,clientId:1,document:structuredClone(ARTICLE_DOCUMENT),confirmation:'SEND_FORMAL_ARTICLE' as const,idempotencyKey:'synthetic-owner-create-1'}}
}

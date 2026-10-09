import {and,desc,eq} from 'drizzle-orm'
import {createError} from 'h3'
import {getDatabase} from '../database'
import {articleWorkbenchWorkspaces,articleWorkbenchMedia,articleWorkbenchRevisions,articleWorkbenchFeedback,articleWorkbenchOperations,contentOperationClients,weeklyContentBindings} from '../database/schema'
import type {ContentOperationClientRow} from '../content-operations/types'
import type {PrivateLineBinding} from '../weekly-content/types'

export type ArticleWorkspaceRow=typeof articleWorkbenchWorkspaces.$inferSelect
export type ArticleWorkspaceInsert=Omit<ArticleWorkspaceRow,'id'|'createdAt'|'updatedAt'>
export type ArticleRevisionRow=typeof articleWorkbenchRevisions.$inferSelect
export type ArticleMediaRow=typeof articleWorkbenchMedia.$inferSelect
export type ArticleFeedbackRow=typeof articleWorkbenchFeedback.$inferSelect
export type ArticleOperationRow=typeof articleWorkbenchOperations.$inferSelect
export interface ArticleWorkbenchRepository {
  transaction<T>(work:(repository:ArticleWorkbenchRepository)=>Promise<T>):Promise<T>
  findClient(ownerUserId:number,clientId:number,lock?:boolean):Promise<ContentOperationClientRow|null>
  getBinding(ownerUserId:number,clientId:number,lock?:boolean):Promise<PrivateLineBinding|null>
  getWorkspace(workspaceId:string,lock?:boolean):Promise<ArticleWorkspaceRow|null>
  findOwnerKey(ownerUserId:number,clientId:number,key:string,lock?:boolean):Promise<ArticleWorkspaceRow|null>
  listWorkspaces(ownerUserId:number,clientId:number):Promise<ArticleWorkspaceRow[]>
  insertWorkspace(row:ArticleWorkspaceInsert):Promise<ArticleWorkspaceRow>
  updateWorkspace(id:number,patch:Partial<ArticleWorkspaceRow>):Promise<void>
  listMedia(workspaceRowId:number):Promise<ArticleMediaRow[]>
  insertMedia(row:Omit<ArticleMediaRow,'id'|'createdAt'>):Promise<void>
  listFeedback(workspaceRowId:number):Promise<ArticleFeedbackRow[]>
  insertFeedback(row:Omit<ArticleFeedbackRow,'id'|'createdAt'>):Promise<void>
  getRevision(workspaceRowId:number,version:number):Promise<ArticleRevisionRow|null>
  insertRevision(row:Omit<ArticleRevisionRow,'id'|'createdAt'>):Promise<void>
  getOperation(workspaceRowId:number,operation:'save'|'feedback'|'approve',key:string):Promise<ArticleOperationRow|null>
  insertOperation(row:Omit<ArticleOperationRow,'id'|'createdAt'>):Promise<void>
}
function repository(database:any,transactional=false):ArticleWorkbenchRepository{
  const one=async(table:any,predicate:any,lock=false)=>{const query=database.select().from(table).where(predicate).limit(1);const [row]=await(lock?query.for('update'):query);return row||null}
  const repo:ArticleWorkbenchRepository={
    transaction:work=>transactional?work(repo):database.transaction((tx:any)=>work(repository(tx,true))),
    findClient:(owner,client,lock)=>one(contentOperationClients,and(eq(contentOperationClients.ownerUserId,owner),eq(contentOperationClients.id,client)),lock),
    getBinding:(owner,client,lock)=>one(weeklyContentBindings,and(eq(weeklyContentBindings.ownerUserId,owner),eq(weeklyContentBindings.clientId,client)),lock),
    getWorkspace:(workspaceId,lock)=>one(articleWorkbenchWorkspaces,eq(articleWorkbenchWorkspaces.workspaceId,workspaceId),lock),
    findOwnerKey:(owner,client,key,lock)=>one(articleWorkbenchWorkspaces,and(eq(articleWorkbenchWorkspaces.ownerUserId,owner),eq(articleWorkbenchWorkspaces.clientId,client),eq(articleWorkbenchWorkspaces.ownerIdempotencyKey,key)),lock),
    listWorkspaces:(owner,client)=>database.select().from(articleWorkbenchWorkspaces).where(and(eq(articleWorkbenchWorkspaces.ownerUserId,owner),eq(articleWorkbenchWorkspaces.clientId,client))).orderBy(desc(articleWorkbenchWorkspaces.id)).limit(50),
    async insertWorkspace(row){await database.insert(articleWorkbenchWorkspaces).values(row);const saved=await repo.getWorkspace(row.workspaceId);if(!saved)throw createError({statusCode:503,statusMessage:'ARTICLE_STORAGE_UNAVAILABLE'});return saved},
    async updateWorkspace(id,patch){await database.update(articleWorkbenchWorkspaces).set(patch).where(eq(articleWorkbenchWorkspaces.id,id))},
    listMedia:id=>database.select().from(articleWorkbenchMedia).where(eq(articleWorkbenchMedia.workspaceRowId,id)).orderBy(articleWorkbenchMedia.id).limit(31),
    async insertMedia(row){await database.insert(articleWorkbenchMedia).values(row)},
    listFeedback:id=>database.select().from(articleWorkbenchFeedback).where(eq(articleWorkbenchFeedback.workspaceRowId,id)).orderBy(articleWorkbenchFeedback.id).limit(100),
    async insertFeedback(row){await database.insert(articleWorkbenchFeedback).values(row)},
    getRevision:(id,version)=>one(articleWorkbenchRevisions,and(eq(articleWorkbenchRevisions.workspaceRowId,id),eq(articleWorkbenchRevisions.version,version))),
    async insertRevision(row){await database.insert(articleWorkbenchRevisions).values(row)},
    getOperation:(id,operation,key)=>one(articleWorkbenchOperations,and(eq(articleWorkbenchOperations.workspaceRowId,id),eq(articleWorkbenchOperations.operation,operation),eq(articleWorkbenchOperations.idempotencyKey,key))),
    async insertOperation(row){await database.insert(articleWorkbenchOperations).values(row)},
  }
  return repo
}
export function createArticleWorkbenchRepository():ArticleWorkbenchRepository{const db=getDatabase();if(!db)throw createError({statusCode:503,statusMessage:'ARTICLE_STORAGE_UNAVAILABLE'});return repository(db)}
export function createArticleWorkbenchRepositoryFromDatabase(database:unknown){return repository(database)}

/** Call only while the existing client/binding replacement transaction holds both locks. */
export async function guardArticleWorkspacesForRebind(database:any,input:{ownerUserId:number;clientId:number;bindingId:number;now:Date}){
  const rows:ArticleWorkspaceRow[]=await database.select().from(articleWorkbenchWorkspaces).where(and(eq(articleWorkbenchWorkspaces.ownerUserId,input.ownerUserId),eq(articleWorkbenchWorkspaces.clientId,input.clientId),eq(articleWorkbenchWorkspaces.bindingId,input.bindingId))).for('update')
  if(rows.some(row=>row.status==='processing'||row.preparationStatus==='processing'||row.notificationStatus==='processing'))throw createError({statusCode:409,statusMessage:'ARTICLE_BINDING_DELIVERY_IN_PROGRESS'})
  for(const row of rows){if(row.status==='published'||row.status==='revoked')continue;await database.update(articleWorkbenchWorkspaces).set({status:'revoked',notificationStatus:row.notificationStatus==='sent'?'sent':'failed',notificationErrorCode:'article_binding_changed',updatedAt:input.now}).where(and(eq(articleWorkbenchWorkspaces.id,row.id),eq(articleWorkbenchWorkspaces.bindingFingerprint,row.bindingFingerprint)))}
}

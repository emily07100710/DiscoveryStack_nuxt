import {and,desc,eq,gt,isNull,lt,lte,or,sql} from 'drizzle-orm'
import {createError} from 'h3'
import {getDatabase} from '../database'
import {contentOperationClients,weeklyContentBindings,weeklyContentReviewTests} from '../database/schema'
import type {ContentOperationClientRow} from '../content-operations/types'
import {createWeeklyContentRepositoryFromDatabase,type WeeklyContentRepository} from './repository'
import type {PrivateLineBinding} from './types'

export type WeeklyReviewTest=typeof weeklyContentReviewTests.$inferSelect
export type WeeklyReviewTestInsert=Omit<WeeklyReviewTest,'id'|'createdAt'|'updatedAt'>
export type WeeklyReviewTestNotificationResult={
  status:'sent'|'retry_wait'|'failed'|'cancelled'
  providerMessageId?:string
  retryEligibleAt?:Date
  errorCode?:string
}

export interface WeeklyReviewTestRepository {
  transaction<T>(work:(repository:WeeklyReviewTestRepository,weeklyRepository:WeeklyContentRepository)=>Promise<T>):Promise<T>
  findClient(ownerUserId:number,clientId:number,lock?:boolean):Promise<ContentOperationClientRow|null>
  getBinding(ownerUserId:number,clientId:number,lock?:boolean):Promise<PrivateLineBinding|null>
  findByOwnerKey(ownerUserId:number,clientId:number,idempotencyKey:string,lock?:boolean):Promise<WeeklyReviewTest|null>
  findPendingByContent(ownerUserId:number,clientId:number,bindingId:number,bindingFingerprint:string,contentHash:string,now:Date,lock?:boolean):Promise<WeeklyReviewTest|null>
  getByRequestId(requestId:string,lock?:boolean):Promise<WeeklyReviewTest|null>
  list(ownerUserId:number,clientId:number,limit?:number):Promise<WeeklyReviewTest[]>
  insert(row:WeeklyReviewTestInsert):Promise<WeeklyReviewTest>
  claimNotification(id:number,leaseToken:string,now:Date,maxAttempts:number):Promise<WeeklyReviewTest|null>
  reserveNotificationPayload(id:number,leaseToken:string,payloadFingerprint:string,now:Date):Promise<boolean>
  finishNotification(id:number,leaseToken:string,payloadFingerprint:string,now:Date,result:WeeklyReviewTestNotificationResult):Promise<boolean>
  decide(id:number,decision:'approved'|'changes_requested',eventHash:string,actorFingerprint:string,decisionFingerprint:string,now:Date):Promise<boolean>
}

function makeRepository(database:any,transactional=false):WeeklyReviewTestRepository {
  const one=async(table:any,predicate:any,lock=false)=>{const query=database.select().from(table).where(predicate).limit(1);const [row]=await(lock?query.for('update'):query);return row||null}
  const repository:WeeklyReviewTestRepository={
    transaction:work=>transactional?work(repository,createWeeklyContentRepositoryFromDatabase(database)):database.transaction((tx:any)=>work(makeRepository(tx,true),createWeeklyContentRepositoryFromDatabase(tx))),
    findClient:(owner,client,lock)=>one(contentOperationClients,and(eq(contentOperationClients.ownerUserId,owner),eq(contentOperationClients.id,client)),lock),
    getBinding:(owner,client,lock)=>one(weeklyContentBindings,and(eq(weeklyContentBindings.ownerUserId,owner),eq(weeklyContentBindings.clientId,client)),lock),
    findByOwnerKey:(owner,client,key,lock)=>one(weeklyContentReviewTests,and(eq(weeklyContentReviewTests.ownerUserId,owner),eq(weeklyContentReviewTests.clientId,client),eq(weeklyContentReviewTests.idempotencyKey,key)),lock),
    findPendingByContent:(owner,client,bindingId,bindingFingerprint,contentHash,now,lock)=>one(weeklyContentReviewTests,and(eq(weeklyContentReviewTests.ownerUserId,owner),eq(weeklyContentReviewTests.clientId,client),eq(weeklyContentReviewTests.bindingId,bindingId),eq(weeklyContentReviewTests.bindingFingerprint,bindingFingerprint),eq(weeklyContentReviewTests.contentHash,contentHash),eq(weeklyContentReviewTests.status,'pending'),gt(weeklyContentReviewTests.expiresAt,now)),lock),
    getByRequestId:(requestId,lock)=>one(weeklyContentReviewTests,eq(weeklyContentReviewTests.requestId,requestId),lock),
    list:(owner,client,limit=50)=>database.select().from(weeklyContentReviewTests).where(and(eq(weeklyContentReviewTests.ownerUserId,owner),eq(weeklyContentReviewTests.clientId,client))).orderBy(desc(weeklyContentReviewTests.id)).limit(Math.max(1,Math.min(50,limit))),
    async insert(row){const ids=await database.insert(weeklyContentReviewTests).values(row).$returningId();const saved=await repository.getByRequestId(row.requestId);if(!saved||saved.id!==ids[0]?.id)throw createError({statusCode:503,statusMessage:'Review test storage is unavailable.'});return saved},
    async claimNotification(id,leaseToken,now,maxAttempts){
      const due=or(eq(weeklyContentReviewTests.notificationStatus,'queued'),eq(weeklyContentReviewTests.notificationStatus,'failed'),and(eq(weeklyContentReviewTests.notificationStatus,'retry_wait'),lte(weeklyContentReviewTests.notificationRetryEligibleAt,now)),and(eq(weeklyContentReviewTests.notificationStatus,'processing'),lte(weeklyContentReviewTests.notificationLeaseExpiresAt,now)))
      const result=await database.update(weeklyContentReviewTests).set({notificationStatus:'processing',notificationAttemptCount:sql`${weeklyContentReviewTests.notificationAttemptCount} + 1`,notificationLeaseToken:leaseToken,notificationLeaseExpiresAt:new Date(now.getTime()+120_000),notificationRetryEligibleAt:null,updatedAt:now}).where(and(eq(weeklyContentReviewTests.id,id),eq(weeklyContentReviewTests.status,'pending'),gt(weeklyContentReviewTests.expiresAt,now),lt(weeklyContentReviewTests.notificationAttemptCount,maxAttempts),due))
      if(Number(result?.[0]?.affectedRows||0)!==1)return null
      return one(weeklyContentReviewTests,and(eq(weeklyContentReviewTests.id,id),eq(weeklyContentReviewTests.notificationStatus,'processing'),eq(weeklyContentReviewTests.notificationLeaseToken,leaseToken)))
    },
    async reserveNotificationPayload(id,leaseToken,fingerprint,now){
      const result=await database.update(weeklyContentReviewTests).set({notificationPayloadFingerprint:fingerprint,updatedAt:now}).where(and(eq(weeklyContentReviewTests.id,id),eq(weeklyContentReviewTests.status,'pending'),eq(weeklyContentReviewTests.notificationStatus,'processing'),eq(weeklyContentReviewTests.notificationLeaseToken,leaseToken),gt(weeklyContentReviewTests.notificationLeaseExpiresAt,now),or(isNull(weeklyContentReviewTests.notificationPayloadFingerprint),eq(weeklyContentReviewTests.notificationPayloadFingerprint,fingerprint))))
      if(Number(result?.[0]?.affectedRows||0)===1)return true
      return Boolean(await one(weeklyContentReviewTests,and(eq(weeklyContentReviewTests.id,id),eq(weeklyContentReviewTests.status,'pending'),eq(weeklyContentReviewTests.notificationStatus,'processing'),eq(weeklyContentReviewTests.notificationLeaseToken,leaseToken),gt(weeklyContentReviewTests.notificationLeaseExpiresAt,now),eq(weeklyContentReviewTests.notificationPayloadFingerprint,fingerprint))))
    },
    async finishNotification(id,leaseToken,fingerprint,now,result){
      const changed=await database.update(weeklyContentReviewTests).set({notificationStatus:result.status,notificationLeaseToken:null,notificationLeaseExpiresAt:null,notificationRetryEligibleAt:result.retryEligibleAt||null,notificationProviderMessageId:result.providerMessageId||null,notificationErrorCode:result.errorCode||null,notificationSentAt:result.status==='sent'?now:null,updatedAt:now}).where(and(eq(weeklyContentReviewTests.id,id),eq(weeklyContentReviewTests.notificationStatus,'processing'),eq(weeklyContentReviewTests.notificationLeaseToken,leaseToken),eq(weeklyContentReviewTests.notificationPayloadFingerprint,fingerprint),gt(weeklyContentReviewTests.notificationLeaseExpiresAt,now)))
      return Number(changed?.[0]?.affectedRows||0)===1
    },
    async decide(id,decision,eventHash,actorFingerprint,decisionFingerprint,now){
      const changed=await database.update(weeklyContentReviewTests).set({status:decision,decisionEventHash:eventHash,decisionActorFingerprint:actorFingerprint,decisionFingerprint,decidedAt:now,updatedAt:now}).where(and(eq(weeklyContentReviewTests.id,id),eq(weeklyContentReviewTests.status,'pending'),isNull(weeklyContentReviewTests.decisionEventHash),isNull(weeklyContentReviewTests.decisionFingerprint)))
      return Number(changed?.[0]?.affectedRows||0)===1
    },
  }
  return repository
}

export function createWeeklyReviewTestRepository():WeeklyReviewTestRepository {const database=getDatabase();if(!database)throw createError({statusCode:503,statusMessage:'Review test storage is not configured.'});return makeRepository(database)}
export function createWeeklyReviewTestRepositoryFromDatabase(database:unknown):WeeklyReviewTestRepository {return makeRepository(database)}

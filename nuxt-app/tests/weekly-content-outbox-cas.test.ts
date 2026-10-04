import { describe, expect, it } from 'vitest'
import { MySqlDialect } from 'drizzle-orm/mysql-core'
import type { SQL } from 'drizzle-orm'
import { createWeeklyContentRepositoryFromDatabase } from '../server/weekly-content/repository'
import { weeklyContentOutbox } from '../server/database/schema'
import type { WeeklyOutbox } from '../server/weekly-content/types'
import { WEEKLY_NOW, sha } from './fixtures/weekly-content/repository'
function boundary() {
  const row:WeeklyOutbox={id:1,ownerUserId:1,clientId:1,requestRowId:2,bindingId:3,status:'processing',attemptNumber:1,leaseToken:'lease-1',leaseExpiresAt:new Date(WEEKLY_NOW.getTime()+120000),retryEligibleAt:null,providerMessageId:null,sentAt:null,errorCode:null,payloadFingerprint:null,firstAttemptAt:null,createdAt:WEEKLY_NOW,updatedAt:WEEKLY_NOW}
  const dialect=new MySqlDialect()
  const sqls:string[]=[]
  const matches=(predicate:SQL,hasPayload:boolean)=>{
    const query=dialect.sqlToQuery(predicate);sqls.push(query.sql)
    expect(query.sql).toContain('`weeklyContentOutbox`.`id` = ?')
    expect(query.sql).toContain('`weeklyContentOutbox`.`status` = ?')
    expect(query.sql).toContain('`weeklyContentOutbox`.`leaseToken` = ?')
    expect(query.sql).toContain('`weeklyContentOutbox`.`leaseExpiresAt` > ?')
    const [id,status,token]=query.params
    if(row.id!==id || row.status!==status || row.leaseToken!==token || !row.leaseExpiresAt || row.leaseExpiresAt<=WEEKLY_NOW)return false
    if(hasPayload){const fp=query.params[4];return row.payloadFingerprint===null || row.payloadFingerprint===fp}
    return true
  }
  const database={
    update:(table:unknown)=>{expect(table).toBe(weeklyContentOutbox);return {set:(patch:Partial<WeeklyOutbox>)=>({where:async(predicate:SQL)=>{const payload=patch.payloadFingerprint!==undefined;if(!matches(predicate,payload))return [{affectedRows:0}];Object.assign(row,patch);if(payload)row.firstAttemptAt=WEEKLY_NOW;return [{affectedRows:1}]}})}},
    select:()=>({from:(table:unknown)=>{expect(table).toBe(weeklyContentOutbox);return {where:(predicate:SQL)=>({limit:async()=>{if(!matches(predicate,true))return [];const query=dialect.sqlToQuery(predicate);return row.payloadFingerprint===query.params[4]?[{...row}]:[]}})}}}),
  }
  return {row,sqls,repo:createWeeklyContentRepositoryFromDatabase(database)}
}
describe('actual weekly outbox immutable payload database boundary',()=>{
  it('same lease concurrent same payload is replayable and a changed message/recipient cannot reuse it',async()=>{const {repo,row}=boundary(),fp=sha('synthetic to/messages/bot');expect(await Promise.all([repo.reserveOutboxPayload(1,'lease-1',fp,WEEKLY_NOW),repo.reserveOutboxPayload(1,'lease-1',fp,WEEKLY_NOW)])).toEqual([true,true]);expect(row.payloadFingerprint).toBe(fp);expect(row.firstAttemptAt).toEqual(WEEKLY_NOW);expect(await repo.reserveOutboxPayload(1,'lease-1',sha('changed recipient'),WEEKLY_NOW)).toBe(false);expect(row.payloadFingerprint).toBe(fp)})
  it.each(['id','lease','expired','status'] as const)('payload reservation and completion fail for changed %s',async(kind)=>{const {repo,row}=boundary();if(kind==='id')row.id=2;if(kind==='lease')row.leaseToken='other';if(kind==='expired')row.leaseExpiresAt=WEEKLY_NOW;if(kind==='status')row.status='cancelled';expect(await repo.reserveOutboxPayload(1,'lease-1',sha('payload'),WEEKLY_NOW)).toBe(false);expect(await repo.finishOutbox(1,'lease-1',WEEKLY_NOW,{status:'sent'})).toBe(false);expect(row.firstAttemptAt).toBeNull()})
  it('only processing exact unexpired lease can append a safe sent result',async()=>{const {repo,row}=boundary();expect(await repo.finishOutbox(1,'lease-1',WEEKLY_NOW,{status:'sent',providerMessageId:'synthetic-safe-accepted-id'})).toBe(true);expect(row.status).toBe('sent');expect(row.leaseToken).toBeNull();expect(await repo.finishOutbox(1,'lease-1',WEEKLY_NOW,{status:'sent'})).toBe(false)})
})

import {and,eq} from 'drizzle-orm'
import {createError} from 'h3'
import {getDatabase} from '../database'
import {weeklyContentConfigs} from '../database/schema'
import {createContentOperationsRepositoryFromDatabase,type ContentOperationsRepository} from '../content-operations/repository'
import {createCalendarFromProductionPlan,getDefaultContentOperationsClock} from '../content-operations/service'
import type {ContentOperationCalendarRow,ContentOperationCalendarEntryRow,PlanBundle} from '../content-operations/types'
import type {WeeklyConfig} from './types'
import {assertDateOnly} from '../content-operations/normalization'

type Result={status:'scheduled'|'waiting_for_current_article'|'not_configured'|'topics_exhausted'|'monthly_limit'|'policy_expired'|'paused'|'blocked';entryId?:number;date?:string}
const TERMINAL=new Set(['delivered','completed','skipped','cancelled'])
const addDays=(date:string,days:number)=>{const d=new Date(`${date}T00:00:00Z`);d.setUTCDate(d.getUTCDate()+days);return d.toISOString().slice(0,10)}
export function nextWeeklyDate(lastDate:string,today:string):string{
  let next=addDays(lastDate,7)
  if(next<today){const gap=Math.ceil((Date.parse(`${today}T00:00:00Z`)-Date.parse(`${next}T00:00:00Z`))/86400000/7);next=addDays(next,gap*7)}
  return next
}
export function unusedApprovedDeliverables(bundle:PlanBundle,entries:ContentOperationCalendarEntryRow[]):PlanBundle{
  const used=new Set(entries.map(entry=>entry.productionDeliverableId))
  return {...bundle,deliverables:bundle.deliverables.filter(d=>!used.has(d.id)&&d.contentType==='article'&&d.language==='zh-hant')}
}
export function weeklySlotDecision(input:{today:string;template:ContentOperationCalendarRow;entries:Array<ContentOperationCalendarEntryRow & {estimatedCostUnits?:number}>;monthlyBudget:number;hasTopics:boolean}):Result{
  if(input.entries.some(e=>!TERMINAL.has(e.status)))return {status:'waiting_for_current_article'}
  if(!input.hasTopics)return {status:'topics_exhausted'}
  const last=input.entries.map(e=>e.plannedLocalDate).sort().at(-1) || input.template.planStartDate
  const date=nextWeeklyDate(last,input.today)
  const spent=input.entries.filter(e=>e.plannedLocalDate.slice(0,7)===date.slice(0,7)&&e.status!=='cancelled').reduce((sum,e)=>sum+(e.estimatedCostUnits ?? input.template.defaultCostUnits),0)
  if(spent+input.template.defaultCostUnits>input.monthlyBudget)return {status:'monthly_limit',date}
  return {status:'scheduled',date}
}
export type WeeklyPlannerDependencies={withClientLock<T>(owner:number,client:number,work:(config:WeeklyConfig|null,ops:ContentOperationsRepository)=>Promise<T>):Promise<T>}
export function productionWeeklyPlannerDependencies():WeeklyPlannerDependencies{
  return {async withClientLock(owner,client,work){
    const database=getDatabase();if(!database)throw createError({statusCode:503,statusMessage:'Weekly content storage is unavailable.'})
    return database.transaction(async tx=>{
      const [config]=await tx.select().from(weeklyContentConfigs).where(and(eq(weeklyContentConfigs.ownerUserId,owner),eq(weeklyContentConfigs.clientId,client))).limit(1).for('update')
      const base=createContentOperationsRepositoryFromDatabase(tx)
      // All canonical calendar inserts and slot checks share the already-open client lock transaction.
      const ops:ContentOperationsRepository={...base,transaction:work=>work(ops)}
      return work(config||null,ops)
    })
  }}
}
export async function rollApprovedWeeklyCalendar(owner:number,clientId:number,now:Date,deps:WeeklyPlannerDependencies):Promise<Result>{
  return deps.withClientLock(owner,clientId,async(config,ops)=>{
    if(!config)return {status:'not_configured'}
    if(config.status!=='active')return {status:'paused'}
    const client=await ops.findClient(owner,clientId)
    if(!client || client.status!=='active' || !client.requireCustomerApproval)return {status:'paused'}
    const target=await ops.findPublicationTarget(owner,config.publicationTargetId)
    const policies=await ops.listAutopilotPolicies(owner,clientId)
    const policy=policies.find(p=>p.policyId===config.policyId&&p.configurationFingerprint===config.policyConfigurationFingerprint&&p.publicationTargetId===target?.id)
    if(!target || target.status!=='active' || !target.executionEnabled || !policy || policy.status!=='enabled' || policy.expiresAt.getTime()<=now.getTime())return {status:'policy_expired'}
    const calendars=(await ops.listCalendars(owner)).filter(c=>c.clientId===clientId).sort((a,b)=>b.id-a.id)
    const template=calendars.find(c=>c.status!=='archived')
    if(!template)return {status:'not_configured'}
    if(template.status==='paused' || template.cadenceDays!==7)return {status:'paused'}
    const entries=await weeklyCalendarHistory(calendars,id=>ops.listEntries(owner,id))
    const bundle=unusedApprovedDeliverables(await ops.getPlanBundle(owner,template.productionPlanId),entries)
    const today=getDefaultContentOperationsClock().localDate(now,client.timeZone)
    const decision=weeklySlotDecision({today,template,entries,monthlyBudget:Math.min(template.monthlyBudgetUnits,client.monthlyBudgetUnits),hasTopics:bundle.deliverables.length>0})
    if(decision.status!=='scheduled' || !decision.date)return decision
    const scoped:ContentOperationsRepository={...ops,getPlanBundle:async(o,p)=>{if(o!==owner||p!==template.productionPlanId)throw new Error('Weekly plan scope mismatch');return bundle}}
    const result=await createCalendarFromProductionPlan(owner,{clientId,productionPlanId:template.productionPlanId,planStartDate:decision.date,planEndDate:decision.date,publishLocalTime:template.publishLocalTime,cadenceDays:7,monthlyBudgetUnits:Math.min(template.monthlyBudgetUnits,client.monthlyBudgetUnits),defaultCostUnits:template.defaultCostUnits,maxItemsPerCalendarMonth:1,maximumTotalItems:1,catchUpPolicy:'skip_missed',idempotencyKey:`weekly:${clientId}:${template.productionPlanId}:${decision.date}`},scoped)
    return {...decision,entryId:result.entries[0]?.id}
  })
}

/** Archived calendars still consume their topics and their original monthly cost. */
export async function weeklyCalendarHistory(calendars:ContentOperationCalendarRow[],readEntries:(calendarId:number)=>Promise<ContentOperationCalendarEntryRow[]>){
 return (await Promise.all(calendars.map(async c=>(await readEntries(c.id)).map(e=>({...e,estimatedCostUnits:c.defaultCostUnits}))))).flat()
}
export async function createInitialWeeklyCalendar(owner:number,clientId:number,input:{productionPlanId:number;startDate:string;publishLocalTime:string;monthlyArticleLimit:number},now:Date,deps:WeeklyPlannerDependencies){
 return deps.withClientLock(owner,clientId,async(config,ops)=>{
  const client=await ops.findClient(owner,clientId)
  if(!config || config.status!=='active' || !client || client.status!=='active' || !client.requireCustomerApproval)throw createError({statusCode:409,statusMessage:'Activate customer approval before scheduling.'})
  const target=await ops.findPublicationTarget(owner,config.publicationTargetId)
  const policy=(await ops.listAutopilotPolicies(owner,clientId)).find(p=>p.policyId===config.policyId&&p.configurationFingerprint===config.policyConfigurationFingerprint&&p.publicationTargetId===target?.id)
  if(!target || target.status!=='active' || !target.executionEnabled || !policy || policy.status!=='enabled' || policy.expiresAt.getTime()<=now.getTime())throw createError({statusCode:409,statusMessage:'The exact weekly publication policy must be enabled and current.'})
  assertDateOnly(input.startDate)
  const values={clientId,productionPlanId:input.productionPlanId,planStartDate:input.startDate,planEndDate:input.startDate,publishLocalTime:input.publishLocalTime,cadenceDays:7 as const,monthlyBudgetUnits:Math.min(input.monthlyArticleLimit,client.monthlyBudgetUnits),defaultCostUnits:1,maxItemsPerCalendarMonth:1,maximumTotalItems:1,catchUpPolicy:'skip_missed' as const,idempotencyKey:`weekly-start:${clientId}:${input.productionPlanId}:${input.startDate}`}
  // A retry must use the original payload; canonical service verifies the entire calendar identity.
  if(await ops.findCalendarByIdempotency(owner,values.idempotencyKey))return createCalendarFromProductionPlan(owner,values,ops)
  if(input.startDate<getDefaultContentOperationsClock().localDate(now,client.timeZone))throw createError({statusCode:422,statusMessage:'Choose today or a future weekly start date.'})
  const calendars=(await ops.listCalendars(owner)).filter(c=>c.clientId===clientId)
  const entries=await weeklyCalendarHistory(calendars,id=>ops.listEntries(owner,id))
  if(entries.some(e=>!TERMINAL.has(e.status)))throw createError({statusCode:409,statusMessage:'Resolve the current article before scheduling another.'})
  const bundle=unusedApprovedDeliverables(await ops.getPlanBundle(owner,input.productionPlanId),entries)
  if(!bundle.deliverables.length)throw createError({statusCode:409,statusMessage:'Choose a plan with unused approved article topics.'})
  const spent=entries.filter(e=>e.plannedLocalDate.slice(0,7)===input.startDate.slice(0,7)&&e.status!=='cancelled').reduce((sum,e)=>sum+e.estimatedCostUnits,0)
  if(spent+1>values.monthlyBudgetUnits)throw createError({statusCode:409,statusMessage:'The monthly article budget has been reached.'})
  const scoped:ContentOperationsRepository={...ops,getPlanBundle:async(o,p)=>{if(o!==owner||p!==input.productionPlanId)throw new Error('Weekly plan scope mismatch');return bundle}}
  return createCalendarFromProductionPlan(owner,values,scoped)
 })
}

import {describe,expect,it,vi} from 'vitest'
import type {WeeklyConfig} from '../server/weekly-content/types'
import type {ContentOperationsRepository} from '../server/content-operations/repository'
import {nextWeeklyDate,unusedApprovedDeliverables,weeklySlotDecision,weeklyCalendarHistory,createInitialWeeklyCalendar} from '../server/weekly-content/planner'
import type {ContentOperationCalendarRow,ContentOperationCalendarEntryRow,PlanBundle} from '../server/content-operations/types'
const template={planStartDate:'2026-10-05',defaultCostUnits:1} as ContentOperationCalendarRow
const row=(date:string,status='delivered',id=1)=>({productionDeliverableId:id,plannedLocalDate:date,status,estimatedCostUnits:1} as unknown as ContentOperationCalendarEntryRow)
describe('weekly approved-topic planner',()=>{
 it('keeps a seven day schedule and skips missed weeks without producing a backlog',()=>{expect(nextWeeklyDate('2026-10-05','2026-10-06')).toBe('2026-10-12');expect(nextWeeklyDate('2026-10-05','2026-10-28')).toBe('2026-11-02')})
 it.each(['planned','awaiting_generation','awaiting_review','ready_to_publish','publishing','blocked'])('creates no second article while a %s article exists',status=>{expect(weeklySlotDecision({today:'2026-10-12',template,entries:[row('2026-10-05',status)],monthlyBudget:5,hasTopics:true}).status).toBe('waiting_for_current_article')})
 it('cannot spend past the monthly cap and allows the next calendar month',()=>{const entries=[row('2026-10-05'),row('2026-10-12'),row('2026-10-19')];expect(weeklySlotDecision({today:'2026-10-20',template,entries,monthlyBudget:3,hasTopics:true}).status).toBe('monthly_limit');expect(weeklySlotDecision({today:'2026-11-01',template,entries,monthlyBudget:3,hasTopics:true})).toEqual({status:'scheduled',date:'2026-11-02'})})
 it('requires new owner-approved topics rather than recycling or inventing a topic',()=>{const bundle={deliverables:[{id:1,contentType:'article',language:'zh-hant'},{id:2,contentType:'article',language:'zh-hant'},{id:3,contentType:'faq',language:'zh-hant'}]} as PlanBundle;expect(unusedApprovedDeliverables(bundle,[row('2026-10-05')]).deliverables.map(d=>d.id)).toEqual([2]);expect(weeklySlotDecision({today:'2026-10-12',template,entries:[],monthlyBudget:5,hasTopics:false}).status).toBe('topics_exhausted')})
})

describe('weekly schedule creation authority and historical usage',()=>{
 it('keeps archived calendar cost and used topics in current monthly limits',async()=>{
  const calendars=[{id:1,status:'archived',defaultCostUnits:2},{id:2,status:'active',defaultCostUnits:1}] as ContentOperationCalendarRow[]
  const read=vi.fn(async(id:number)=>[row(id===1?'2026-10-05':'2026-10-12','delivered',id)])
  const entries=await weeklyCalendarHistory(calendars,read)
  expect(read).toHaveBeenCalledWith(1)
  expect(entries.map(e=>e.estimatedCostUnits)).toEqual([2,1])
  expect(weeklySlotDecision({today:'2026-10-19',template,entries,monthlyBudget:3,hasTopics:true}).status).toBe('monthly_limit')
  const bundle={deliverables:[{id:1,contentType:'article',language:'zh-hant'},{id:2,contentType:'article',language:'zh-hant'}]} as PlanBundle
  expect(unusedApprovedDeliverables(bundle,entries).deliverables).toEqual([])
 })
 const setup=(configStatus='active',requires=true)=>{
  const config={status:configStatus,publicationTargetId:3,policyId:'p',policyConfigurationFingerprint:'f'} as WeeklyConfig
  const ops={findClient:vi.fn(async()=>({id:2,status:'active',requireCustomerApproval:requires,timeZone:'Asia/Taipei',monthlyBudgetUnits:4})),findPublicationTarget:vi.fn(async()=>({id:3,status:'active',executionEnabled:true})),listAutopilotPolicies:vi.fn(async()=>[{policyId:'p',publicationTargetId:3,configurationFingerprint:'f',status:'enabled',expiresAt:new Date('2027-01-01')}]),findCalendarByIdempotency:vi.fn(async()=>null),listCalendars:vi.fn(async()=>[]),listEntries:vi.fn(async()=>[]),getPlanBundle:vi.fn(async()=>({deliverables:[]})),insertCalendar:vi.fn()}
  return {ops,deps:{withClientLock:async<T>(_o:number,_c:number,work:(config:WeeklyConfig,ops:ContentOperationsRepository)=>Promise<T>)=>work(config,ops as unknown as ContentOperationsRepository)}}
 }
 const input={productionPlanId:8,startDate:'2026-10-05',publishLocalTime:'10:00',monthlyArticleLimit:4}
 it.each([['paused',true],['active',false]] as const)('cannot create a legacy calendar before active customer approval (%s)',async(status,required)=>{
  const {ops,deps}=setup(status,required)
  await expect(createInitialWeeklyCalendar(1,2,input,new Date('2026-10-04'),deps)).rejects.toMatchObject({statusCode:409})
  expect(ops.insertCalendar).not.toHaveBeenCalled();expect(ops.getPlanBundle).not.toHaveBeenCalled()
 })
 it('rejects a new date while an archived calendar still has an unresolved article',async()=>{
  const {ops,deps}=setup();ops.listCalendars.mockResolvedValue([{id:7,clientId:2,status:'archived',defaultCostUnits:1}] as never);ops.listEntries.mockResolvedValue([row('2026-10-04','ready_to_publish')] as never)
  await expect(createInitialWeeklyCalendar(1,2,input,new Date('2026-10-04'),deps)).rejects.toMatchObject({statusCode:409})
  expect(ops.listCalendars).toHaveBeenCalledWith(1,2)
  expect(ops.getPlanBundle).not.toHaveBeenCalled();expect(ops.insertCalendar).not.toHaveBeenCalled()
 })
 it('stops before plan/topic reads or insertion when client history exceeds the safe 100-calendar window',async()=>{
  const {ops,deps}=setup()
  ops.listCalendars.mockRejectedValue(Object.assign(new Error('Client calendar history exceeds the safe weekly processing limit.'),{statusCode:409,statusMessage:'Client calendar history exceeds the safe weekly processing limit.'}))
  await expect(createInitialWeeklyCalendar(1,2,input,new Date('2026-10-04'),deps)).rejects.toMatchObject({statusCode:409,statusMessage:'Client calendar history exceeds the safe weekly processing limit.'})
  expect(ops.listCalendars).toHaveBeenCalledWith(1,2)
  expect(ops.listEntries).not.toHaveBeenCalled();expect(ops.getPlanBundle).not.toHaveBeenCalled();expect(ops.insertCalendar).not.toHaveBeenCalled()
 })
 it('requires a current exact stored policy before reading approved plan topics',async()=>{
  const {ops,deps}=setup();ops.listAutopilotPolicies.mockResolvedValue([{policyId:'p',publicationTargetId:3,configurationFingerprint:'changed',status:'enabled',expiresAt:new Date('2027-01-01')}] as never)
  await expect(createInitialWeeklyCalendar(1,2,input,new Date('2026-10-04'),deps)).rejects.toMatchObject({statusCode:409})
  expect(ops.getPlanBundle).not.toHaveBeenCalled();expect(ops.insertCalendar).not.toHaveBeenCalled()
 })
})

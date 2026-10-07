import {beforeEach,afterEach,describe,expect,it,vi} from 'vitest'
import type {WeeklyRuntimeDependencies} from '../server/weekly-content/runtime'
import type {WeeklyContentRepository} from '../server/weekly-content/repository'
import type {ContentOperationsRepository} from '../server/content-operations/repository'
import type {WeeklyConfig} from '../server/weekly-content/types'
const seams=vi.hoisted(()=>({createReview:vi.fn(),approved:vi.fn(),bind:vi.fn(),materialize:vi.fn(),production:vi.fn(),configuration:vi.fn()}))
vi.mock('../server/weekly-content/service',()=>({createReviewRequest:seams.createReview,getApprovedReviewForPromotion:seams.approved}))
vi.mock('../server/weekly-content/http',()=>({weeklyFeatureEnabled:()=>false,weeklyRuntimeDependencies:seams.production}))
vi.mock('../server/weekly-content/runtime-line',()=>({isWeeklyLineConfigurationReady:seams.configuration,runWeeklyLineOutbox:vi.fn()}))
vi.mock('../server/weekly-content/planner',()=>({rollApprovedWeeklyCalendar:vi.fn(),productionWeeklyPlannerDependencies:seams.production}))
vi.mock('../server/content-operations/repository',()=>({createContentOperationsRepository:seams.production}))
vi.mock('../server/content-operations/runtime-dependencies',()=>({getContentOperationsRuntimeDependencies:seams.production}))
vi.mock('../server/content-operations/autopilot-service',()=>({projectAutopilotPolicy:(row:unknown)=>row}))
vi.mock('../server/content-operations/orchestrator',()=>({bindOwnerEntryPublicationTargets:seams.bind,runOwnerContentEntryWorkflow:vi.fn(),executeContentOperationEntry:vi.fn()}))
vi.mock('../server/content-operations/service',()=>({materializeOwnerDueContent:seams.materialize,getDefaultContentOperationsClock:()=>({now:()=>new Date(),localDate:(date:Date)=>date.toISOString().slice(0,10)})}))
import {runWeeklyContentTick,selectWeeklyClientBatch} from '../server/weekly-content/runtime'
const NOW=new Date('2026-10-04T00:00:00Z')
const REQUEST_ID=`wcr_${'x'.repeat(32)}`
function fixture(status='ready_to_publish'){
 const config={id:22,ownerUserId:1,clientId:2,status:'active',publicationTargetId:3,policyId:'policy-1',policyConfigurationFingerprint:'a'.repeat(64)} as WeeklyConfig
 const policy={ownerUserId:1,clientId:2,publicationTargetId:3,policyId:'policy-1',policyVersion:'governed-autopilot-policy-v4',authorizedByOwnerUserId:1,cadenceDays:7,configurationFingerprint:'a'.repeat(64),status:'enabled',expiresAt:new Date('2027-01-01T00:00:00Z'),revokedAt:null}
 const target={id:3,ownerUserId:1,clientId:2,targetId:'primary',status:'active',executionEnabled:true}
 const binding={id:4,ownerUserId:1,clientId:2,status:'active'}
 const calendar={id:5,ownerUserId:1,clientId:2,status:'active',planFingerprint:'b'.repeat(64),timeZone:'UTC'}
 const entry={id:6,ownerUserId:1,calendarId:5,plannedLocalDate:'2026-10-04',status}
 const weeklyRepository={listConfigs:vi.fn(async()=>[config]),claimSchedulerConfigs:vi.fn(async()=>[config]),getConfig:vi.fn(async()=>config),getBinding:vi.fn(async()=>binding),getTargetPolicy:vi.fn(async()=>({target,policy}))}
 const operations={listCalendars:vi.fn(async()=>[calendar]),listEntries:vi.fn(async()=>[entry]),findEntry:vi.fn(async()=>entry)}
 const roll=vi.fn(async()=>({status:'waiting_for_current_article'}))
 const workflow=vi.fn(async()=>{entry.status='ready_to_publish';return {outcome:'ready_to_publish'}})
 const publish=vi.fn(async()=>({outcome:'delivered'}))
 const send=vi.fn(async()=>({status:'completed',claimed:0,sent:0}))
 const dependencies={weekly:{repository:weeklyRepository as unknown as WeeklyContentRepository,featureEnabled:true,tokenKey:'synthetic-only-key-minimum-32-bytes'},operations:operations as unknown as ContentOperationsRepository,roll,workflow,publish,send,runtime:{}} as unknown as WeeklyRuntimeDependencies
 const getDependencies=vi.fn(()=>dependencies)
 const options={featureEnabled:true,schedulerEnabled:true,configurationReady:true,getDependencies}
 return {config,policy,target,binding,calendar,entry,weeklyRepository,operations,roll,workflow,publish,send,dependencies,getDependencies,options}
}
beforeEach(()=>{vi.clearAllMocks();vi.useFakeTimers();vi.setSystemTime(NOW);seams.production.mockImplementation(()=>{throw new Error('Real runtime construction is forbidden in these mock tests')});seams.createReview.mockResolvedValue({request:{requestId:REQUEST_ID,status:'pending',expiresAt:'2026-10-07T00:00:00Z'},replayed:false});seams.approved.mockResolvedValue({ownerUserId:1,clientId:2,entryId:6,publicationTargetId:3,policyId:'policy-1'})})
afterEach(()=>vi.useRealTimers())
describe('weekly content mock runtime authority and pipeline ordering',()=>{
 it.each([{featureEnabled:false},{schedulerEnabled:false},{configurationReady:false}])('constructs no storage/providers before configuration and flags pass',async patch=>{
  const f=fixture();const result=await runWeeklyContentTick({ownerUserId:1}, {...f.options,...patch})
  expect(result.status).toBe(patch.configurationReady===false?'not_configured':'disabled');expect(f.getDependencies).not.toHaveBeenCalled();expect(seams.production).not.toHaveBeenCalled();expect(f.send).not.toHaveBeenCalled()
 })
 it.each([
  [{ownerUserId:0},'owner'],
  [{ownerUserId:1,maxClients:0},'limit'],
  [{ownerUserId:1,maxClients:1.5},'limit'],
  [{ownerUserId:1,maxClients:Number.NaN},'limit'],
  [{ownerUserId:1,now:new Date(Number.NaN)},'clock'],
 ] as const)('rejects invalid %s after static gates but before constructing runtime dependencies',async(input,_kind)=>{
  const f=fixture()
  await expect(runWeeklyContentTick(input as {ownerUserId:number;maxClients?:number;now?:Date},f.options)).rejects.toMatchObject({statusCode:422})
  expect(f.getDependencies).not.toHaveBeenCalled()
 })
 it('keeps pending customer consent separate from publication and sends only after review creation',async()=>{
  const f=fixture();const result=await runWeeklyContentTick({ownerUserId:1,now:NOW},f.options)
  expect(result).toMatchObject({reviewQueued:1,publicationAttempted:0,clients:[{clientId:2,status:'awaiting_customer'}]})
  expect(seams.createReview).toHaveBeenCalledWith({ownerUserId:1,clientId:2,entryId:6},expect.any(Object));expect(f.workflow).not.toHaveBeenCalled();expect(f.publish).not.toHaveBeenCalled()
  expect(seams.createReview.mock.invocationCallOrder[0]).toBeLessThan(f.send.mock.invocationCallOrder[0]!)
  expect(f.operations.listCalendars).toHaveBeenCalledWith(1,2)
 })
 it('uses queueOnly for generation quality preparation before creating a review',async()=>{
  const f=fixture('awaiting_generation');await runWeeklyContentTick({ownerUserId:1,now:NOW},f.options)
  expect(f.workflow).toHaveBeenCalledWith(expect.objectContaining({ownerUserId:1,entryId:6,queueOnly:true,now:NOW,dependencies:expect.objectContaining({repository:f.dependencies.operations})}))
  expect(f.workflow.mock.invocationCallOrder[0]).toBeLessThan(seams.createReview.mock.invocationCallOrder[0]!);expect(f.publish).not.toHaveBeenCalled()
 })
 it('does not create a review or publish a draft that did not pass the canonical workflow',async()=>{
  const f=fixture('awaiting_review');f.workflow.mockResolvedValueOnce({outcome:'blocked'})
  expect(await runWeeklyContentTick({ownerUserId:1,now:NOW},f.options)).toMatchObject({reviewQueued:0,publicationAttempted:0,clients:[{clientId:2,status:'quality_or_generation_pending'}]})
  expect(seams.createReview).not.toHaveBeenCalled();expect(f.publish).not.toHaveBeenCalled()
 })
 it('requires approved exact-draft revalidation with queueOnly before execute publication',async()=>{
  const f=fixture();seams.createReview.mockResolvedValueOnce({request:{requestId:REQUEST_ID,status:'approved',expiresAt:'2026-10-07T00:00:00Z'},replayed:true})
  expect(await runWeeklyContentTick({ownerUserId:1,now:NOW},f.options)).toMatchObject({reviewQueued:0,publicationAttempted:1})
  expect(seams.approved).toHaveBeenCalledWith({ownerUserId:1,requestId:REQUEST_ID},expect.any(Object))
  expect(f.workflow).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({queueOnly:true,exactDraftOnly:true}))
  expect(f.publish).toHaveBeenCalledWith(expect.objectContaining({ownerUserId:1,entryId:6,trigger:'scheduler',value:expect.objectContaining({mode:'execute'})}))
  expect(f.workflow.mock.invocationCallOrder[0]).toBeLessThan(f.publish.mock.invocationCallOrder[0]!)
 })
 it('blocks publication if approved exact-draft quality revalidation fails',async()=>{
  const f=fixture();seams.createReview.mockResolvedValueOnce({request:{requestId:REQUEST_ID,status:'approved'},replayed:true});f.workflow.mockResolvedValueOnce({outcome:'blocked'})
  expect(await runWeeklyContentTick({ownerUserId:1,now:NOW},f.options)).toMatchObject({publicationAttempted:0});expect(f.publish).not.toHaveBeenCalled()
 })
 it.each(['binding','expired_policy','paused_target','changed_policy','foreign_config'] as const)('does no generation, calendar roll or publication for %s',async kind=>{
  const f=fixture('awaiting_generation')
  if(kind==='binding')f.binding.status='revoked'
  if(kind==='expired_policy')f.policy.expiresAt=NOW
  if(kind==='paused_target')f.target.status='paused'
  if(kind==='changed_policy')f.policy.configurationFingerprint='c'.repeat(64)
  if(kind==='foreign_config')f.weeklyRepository.getConfig.mockResolvedValueOnce({...f.config,ownerUserId:99} as never)
  await runWeeklyContentTick({ownerUserId:1,now:NOW},f.options)
  expect(f.roll).not.toHaveBeenCalled();expect(f.workflow).not.toHaveBeenCalled();expect(f.publish).not.toHaveBeenCalled();expect(seams.createReview).not.toHaveBeenCalled()
 })
 it('continues other clients and notification retries after a client storage failure without leaking error detail',async()=>{
  const f=fixture();f.operations.listEntries.mockRejectedValueOnce(new Error('synthetic private storage detail'))
  const result=await runWeeklyContentTick({ownerUserId:1,now:NOW},f.options)
  expect(result).toMatchObject({failed:1,publicationAttempted:0});expect(JSON.stringify(result)).not.toContain('private storage detail');expect(f.send).toHaveBeenCalledTimes(1)
 })
 it.each(['missing','paused','identity','fingerprint'] as const)('does not plan or generate when the selected config has %s drifted',async kind=>{
  const f=fixture('awaiting_generation')
  const changed={...f.config}
  if(kind==='missing')f.weeklyRepository.getConfig.mockResolvedValueOnce(null as never)
  else if(kind==='paused')changed.status='paused'
  else if(kind==='identity')changed.id++
  else changed.policyConfigurationFingerprint='b'.repeat(64)
  if(kind!=='missing')f.weeklyRepository.getConfig.mockResolvedValueOnce(changed)
  await runWeeklyContentTick({ownerUserId:1,now:NOW},f.options)
  expect(f.roll).not.toHaveBeenCalled();expect(f.workflow).not.toHaveBeenCalled();expect(f.publish).not.toHaveBeenCalled();expect(seams.createReview).not.toHaveBeenCalled()
 })
 it.each([
  ['foreign owner',[{ownerUserId:99}]],
  ['paused',[{status:'paused'}]],
  ['invalid id',[{id:0}]],
  ['duplicate id',[{id:22},{id:22,clientId:3}]],
  ['duplicate client',[{id:22},{id:23,clientId:2}]],
 ] as const)('fails closed before client work for a malformed scheduler candidate (%s)',async(_label,patches)=>{
  const f=fixture('awaiting_generation')
  const malformed=patches.map(patch=>({...f.config,...patch}))
  f.weeklyRepository.claimSchedulerConfigs.mockResolvedValueOnce(malformed as never)
  await expect(runWeeklyContentTick({ownerUserId:1,now:NOW},f.options)).rejects.toMatchObject({statusCode:503})
  expect(f.roll).not.toHaveBeenCalled();expect(f.workflow).not.toHaveBeenCalled();expect(f.publish).not.toHaveBeenCalled();expect(f.send).not.toHaveBeenCalled()
 })
 it('rejects an oversized candidate batch without sorting or doing any client work',async()=>{
  const f=fixture('awaiting_generation')
  f.weeklyRepository.claimSchedulerConfigs.mockResolvedValueOnce(Array.from({length:11},(_,index)=>({...f.config,id:22+index,clientId:2+index})) as never)
  await expect(runWeeklyContentTick({ownerUserId:1,now:NOW},f.options)).rejects.toMatchObject({statusCode:503})
  expect(f.roll).not.toHaveBeenCalled();expect(f.workflow).not.toHaveBeenCalled();expect(f.publish).not.toHaveBeenCalled()
 })
 it('rechecks actual current consent time after a slow exact draft revalidation',async()=>{
  const f=fixture();const expiresAt=new Date(NOW.getTime()+60_000)
  seams.createReview.mockResolvedValueOnce({request:{requestId:REQUEST_ID,status:'approved',expiresAt:expiresAt.toISOString()},replayed:true})
  seams.approved.mockImplementation(async (_input,weekly)=>{if((weekly.now || new Date()).getTime()>=expiresAt.getTime())throw Object.assign(new Error('synthetic expiry'),{statusCode:409});return {ownerUserId:1,clientId:2,entryId:6,publicationTargetId:3,policyId:'policy-1'}})
  f.workflow.mockImplementationOnce(async()=>{vi.setSystemTime(new Date(NOW.getTime()+120_000));return {outcome:'ready_to_publish'}})
  const result=await runWeeklyContentTick({ownerUserId:1},f.options)
  expect(result.publicationAttempted).toBe(0);expect(f.publish).not.toHaveBeenCalled()
 })
})

describe('legacy weekly customer batch selector',()=>{
 it('serves customers beyond the first ten within successive bounded ticks',()=>{
  const configs=Array.from({length:25},(_,i)=>({clientId:i+1,ownerUserId:1,status:'active'})) as WeeklyConfig[]
  const visited=new Set<number>()
  for(let tick=0;tick<3;tick++){
   const batch=selectWeeklyClientBatch(configs,1,10,new Date(tick*300000))
   expect(batch).toHaveLength(10)
   batch.forEach(c=>visited.add(c.clientId))
  }
  expect([...visited].sort((a,b)=>a-b)).toEqual(configs.map(c=>c.clientId))
 })
 it('does not let paused or foreign clients consume the active batch',()=>{
  const configs=[{clientId:1,ownerUserId:1,status:'paused'},{clientId:2,ownerUserId:9,status:'active'},{clientId:3,ownerUserId:1,status:'active'}] as WeeklyConfig[]
  expect(selectWeeklyClientBatch(configs,1,10,new Date(0)).map(c=>c.clientId)).toEqual([3])
 })
})

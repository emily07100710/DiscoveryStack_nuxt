import {createContentOperationsRepository} from '../content-operations/repository'
import {projectAutopilotPolicy} from '../content-operations/autopilot-service'
import {bindOwnerEntryPublicationTargets,runOwnerContentEntryWorkflow,executeContentOperationEntry} from '../content-operations/orchestrator'
import {getContentOperationsRuntimeDependencies} from '../content-operations/runtime-dependencies'
import {materializeOwnerDueContent,getDefaultContentOperationsClock} from '../content-operations/service'
import {createReviewRequest,getApprovedReviewForPromotion,type WeeklyContentDependencies} from './service'
import {weeklyFeatureEnabled,weeklyRuntimeDependencies} from './http'
import {runWeeklyLineOutbox,isWeeklyLineConfigurationReady} from './runtime-line'
import {rollApprovedWeeklyCalendar,productionWeeklyPlannerDependencies} from './planner'
import type {ContentOperationsRepository} from '../content-operations/repository'
import type {WeeklyConfig} from './types'
import {createError} from 'h3'

export type WeeklyRuntimeDependencies={weekly:WeeklyContentDependencies;operations:ContentOperationsRepository;roll:(owner:number,client:number,now:Date)=>Promise<unknown>;workflow:typeof runOwnerContentEntryWorkflow;publish:typeof executeContentOperationEntry;send:typeof runWeeklyLineOutbox;runtime:ReturnType<typeof getContentOperationsRuntimeDependencies>}
export type WeeklyTickResult={status:'disabled'|'not_configured'|'completed';processed:number;reviewQueued:number;publicationAttempted:number;failed:number;clients:Array<{clientId:number;status:string}>;notifications?:Awaited<ReturnType<typeof runWeeklyLineOutbox>>}
function productionDependencies():WeeklyRuntimeDependencies{
  return {weekly:weeklyRuntimeDependencies(),operations:createContentOperationsRepository(),roll:(owner,client,now)=>rollApprovedWeeklyCalendar(owner,client,now,productionWeeklyPlannerDependencies()),workflow:runOwnerContentEntryWorkflow,publish:executeContentOperationEntry,send:runWeeklyLineOutbox,runtime:getContentOperationsRuntimeDependencies()}
}
export async function runWeeklyContentTick(input:{ownerUserId:number;clientId?:number;now?:Date;maxClients?:number},options:{featureEnabled?:boolean;schedulerEnabled?:boolean;configurationReady?:boolean;getDependencies?:()=>WeeklyRuntimeDependencies}={}):Promise<WeeklyTickResult>{
  const result:WeeklyTickResult={status:'disabled',processed:0,reviewQueued:0,publicationAttempted:0,failed:0,clients:[]}
  // Flags and static credential readiness precede all owner-scoped storage/provider construction.
  if(!(options.featureEnabled ?? weeklyFeatureEnabled()) || !(options.schedulerEnabled ?? process.env.NUXT_CONTENT_OPERATIONS_SCHEDULER_ENABLED==='true'))return result
  if(!(options.configurationReady ?? isWeeklyLineConfigurationReady()))return {...result,status:'not_configured'}
  if(!Number.isSafeInteger(input.ownerUserId) || input.ownerUserId<1)throw createError({statusCode:422,statusMessage:'Weekly owner is invalid.'})
  if(input.clientId!==undefined && (!Number.isSafeInteger(input.clientId) || input.clientId<1))throw createError({statusCode:422,statusMessage:'Weekly client is invalid.'})
  if(input.maxClients!==undefined && (!Number.isSafeInteger(input.maxClients) || input.maxClients<1))throw createError({statusCode:422,statusMessage:'Weekly client limit is invalid.'})
  if(input.now!==undefined && (!(input.now instanceof Date) || !Number.isFinite(input.now.getTime())))throw createError({statusCode:422,statusMessage:'Weekly clock is invalid.'})
  const deps=(options.getDependencies || productionDependencies)()
  const phaseNow=()=>input.now || new Date()
  const weekly={...deps.weekly,now:input.now}
  const maximum=Math.min(10,input.maxClients ?? 10)
  let configs:WeeklyConfig[]
  if(input.clientId!==undefined){
    const config=await weekly.repository.getConfig(input.ownerUserId,input.clientId)
    if(!config || config.ownerUserId!==input.ownerUserId || config.clientId!==input.clientId){result.status='completed';result.clients.push({clientId:input.clientId,status:'not_configured'});return result}
    if(config.status!=='active'){result.status='completed';result.clients.push({clientId:input.clientId,status:'paused'});return result}
    configs=[config]
  }else configs=await weekly.repository.claimSchedulerConfigs(input.ownerUserId,maximum)
  if(!Array.isArray(configs) || configs.length>maximum)throw createError({statusCode:503,statusMessage:'Weekly scheduler selection is unavailable.'})
  const configIds=new Set<number>(), clientIds=new Set<number>()
  for(const config of configs){
    if(!config || !Number.isSafeInteger(config.id) || config.id<1 || !Number.isSafeInteger(config.clientId) || config.clientId<1 || config.ownerUserId!==input.ownerUserId || config.status!=='active' || configIds.has(config.id) || clientIds.has(config.clientId))throw createError({statusCode:503,statusMessage:'Weekly scheduler selection is unavailable.'})
    configIds.add(config.id);clientIds.add(config.clientId)
  }
  result.status='completed'
  for(const config of configs){
    if(config.ownerUserId!==input.ownerUserId || config.status!=='active'){result.clients.push({clientId:config.clientId,status:'paused'});continue}
    try{
      // A scheduler cursor selects candidates only. Re-read before any planning or generation
      // so a pause, owner/client drift, or changed governed binding fails closed.
      const current=await weekly.repository.getConfig(input.ownerUserId,config.clientId)
      if(!current || current.ownerUserId!==input.ownerUserId || current.clientId!==config.clientId || current.id!==config.id || current.status!=='active' || current.publicationTargetId!==config.publicationTargetId || current.policyId!==config.policyId || current.policyConfigurationFingerprint!==config.policyConfigurationFingerprint || current.configurationFingerprint!==config.configurationFingerprint){
        result.clients.push({clientId:config.clientId,status:'configuration_changed'});continue
      }
      const scope=await weekly.repository.getTargetPolicy(input.ownerUserId,config.clientId,config.publicationTargetId,config.policyId)
      const binding=await weekly.repository.getBinding(input.ownerUserId,config.clientId)
      if(!binding || binding.status!=='active'){result.clients.push({clientId:config.clientId,status:'line_not_bound'});continue}
      if(!scope?.policy || scope.policy.configurationFingerprint!==config.policyConfigurationFingerprint || scope.policy.status!=='enabled' || scope.policy.expiresAt.getTime()<=phaseNow().getTime() || scope.target.status!=='active' || !scope.target.executionEnabled){result.clients.push({clientId:config.clientId,status:'policy_not_ready'});continue}
      const policy=projectAutopilotPolicy(scope.policy,scope.target.targetId)
      const workflowDependencies={repository:deps.operations,...deps.runtime,autopilotPolicy:policy,autopilotPoliciesByTarget:{[scope.target.id]:policy}}
      const planning=await deps.roll(input.ownerUserId,config.clientId,phaseNow()) as {status?:string}
      const calendars=(await deps.operations.listCalendars(input.ownerUserId,config.clientId)).filter(c=>c.clientId===config.clientId&&!['paused','archived'].includes(c.status))
      const entries=(await Promise.all(calendars.map(c=>deps.operations.listEntries(input.ownerUserId,c.id)))).flat().sort((a,b)=>a.plannedLocalDate.localeCompare(b.plannedLocalDate)||a.id-b.id)
      let entry=entries.find(e=>!['delivered','completed','cancelled','skipped'].includes(e.status))
      if(!entry){result.clients.push({clientId:config.clientId,status:planning.status || 'needs_approved_topics'});continue}
      result.processed++
      if(entry.status==='blocked'){result.clients.push({clientId:config.clientId,status:'needs_operator_review'});continue}
      const calendar=calendars.find(c=>c.id===entry!.calendarId)!
      const clock={...getDefaultContentOperationsClock(),now:phaseNow}
      if(entry.status==='planned'){
        if(entry.plannedLocalDate>clock.localDate(phaseNow(),calendar.timeZone)){result.clients.push({clientId:config.clientId,status:'scheduled'});continue}
        await bindOwnerEntryPublicationTargets(input.ownerUserId,entry.id,{targetRowIds:[config.publicationTargetId]},deps.operations)
        await materializeOwnerDueContent(input.ownerUserId,{calendarId:calendar.id,expectedPlanFingerprint:calendar.planFingerprint,idempotencyKey:`weekly-materialize:${entry.id}`},deps.operations,{clock,maxEntries:1,eligibleEntryIds:[entry.id]})
        entry=await deps.operations.findEntry(input.ownerUserId,entry.id) || entry
      }
      if(['materialized','awaiting_generation','awaiting_review'].includes(entry.status)){
        if(['materialized','awaiting_generation'].includes(entry.status))await bindOwnerEntryPublicationTargets(input.ownerUserId,entry.id,{targetRowIds:[config.publicationTargetId]},deps.operations)
        const prepared=await deps.workflow({ownerUserId:input.ownerUserId,entryId:entry.id,queueOnly:true,now:phaseNow(),idempotencyKey:`weekly-prepare:${entry.id}`,dependencies:workflowDependencies})
        if(prepared.outcome!=='ready_to_publish'){result.clients.push({clientId:config.clientId,status:'quality_or_generation_pending'});continue}
        entry=await deps.operations.findEntry(input.ownerUserId,entry.id) || entry
      }
      if(entry.status==='ready_to_publish'){
        const review=await createReviewRequest({ownerUserId:input.ownerUserId,clientId:config.clientId,entryId:entry.id},weekly)
        if(!review.replayed)result.reviewQueued++
        if(Date.parse(review.request.expiresAt)<=phaseNow().getTime()){result.clients.push({clientId:config.clientId,status:'review_expired'});continue}
        if(review.request.status==='approved'){
          await getApprovedReviewForPromotion({ownerUserId:input.ownerUserId,requestId:review.request.requestId},weekly)
          const revalidated=await deps.workflow({ownerUserId:input.ownerUserId,entryId:entry.id,queueOnly:true,exactDraftOnly:true,now:phaseNow(),idempotencyKey:`weekly-revalidate:${entry.id}`,dependencies:workflowDependencies})
          if(revalidated.outcome==='ready_to_publish'){
            // Policy, consent and TTL may change while local quality checks run.
            await getApprovedReviewForPromotion({ownerUserId:input.ownerUserId,requestId:review.request.requestId},weekly)
            result.publicationAttempted++
            const published=await deps.publish({ownerUserId:input.ownerUserId,entryId:entry.id,trigger:'scheduler',now:phaseNow(),value:{mode:'execute',idempotencyKey:`weekly-publish:${entry.id}`},dependencies:workflowDependencies})
            result.clients.push({clientId:config.clientId,status:published.outcome})
          }else result.clients.push({clientId:config.clientId,status:'current_quality_or_policy_blocked'})
        }else result.clients.push({clientId:config.clientId,status:review.request.status==='changes_requested'?'changes_requested':'awaiting_customer'})
      }else result.clients.push({clientId:config.clientId,status:entry.status})
    }catch{result.failed++;result.clients.push({clientId:config.clientId,status:'needs_operator_review'})}
  }
  result.notifications=await deps.send(input.clientId===undefined?{ownerUserId:input.ownerUserId,maxMessages:maximum}:{ownerUserId:input.ownerUserId,clientId:input.clientId,maxMessages:maximum},weekly)
  return result
}

/** Rotate the bounded client batch so the first ten customers cannot monopolize every tick. */
export function selectWeeklyClientBatch(configs:WeeklyConfig[],owner:number,maximum:number,now:Date):WeeklyConfig[]{
 const active=configs.filter(c=>c.ownerUserId===owner && c.status==='active').sort((a,b)=>a.clientId-b.clientId)
 if(!active.length)return []
 const size=Math.max(1,Math.min(10,maximum))
 const offset=(Math.floor(now.getTime()/300000)*size)%active.length
 return [...active.slice(offset),...active.slice(0,offset)].slice(0,size)
}

import {and,desc,eq,inArray} from 'drizzle-orm'
import {getDatabase} from '../../database'
import {weeklyContentReviewRequests,weeklyContentOutbox,seoGeoProductionPlans,contentOperationCalendarEntries,seoGeoContentDrafts} from '../../database/schema'
import {createContentOperationsRepository} from '../../content-operations/repository'
import {projectWeeklyOwnerConfig} from '../../weekly-content/service'
import {requireWeeklyOwner,weeklyFeatureEnabled,weeklyRuntimeDependencies,weeklyPublicError} from '../../weekly-content/http'
import {isWeeklyLineConfigurationReady} from '../../weekly-content/runtime-line'
export default defineEventHandler(async event=>{try{
 const owner=await requireWeeklyOwner(event)
 const readiness={enabled:weeklyFeatureEnabled(),lineConfigured:isWeeklyLineConfigurationReady(),schedulerEnabled:process.env.NUXT_CONTENT_OPERATIONS_SCHEDULER_ENABLED==='true'}
 if(!readiness.enabled)return {readiness,configs:[],clients:[],requests:[],plans:[],targets:[],policies:[],calendars:[]}
 const weekly=weeklyRuntimeDependencies();const ops=createContentOperationsRepository();const database=getDatabase()!
 const rows=await weekly.repository.listConfigs(owner)
 const configs=await Promise.all(rows.map(async row=>projectWeeklyOwnerConfig(row,(await weekly.repository.getBinding(owner,row.clientId))?.status==='active')))
 const clients=(await ops.listClients(owner)).map(c=>({id:c.id,displayName:c.displayName,canonicalSiteOrigin:c.canonicalSiteOrigin,status:c.status,requiresCustomerApproval:c.requireCustomerApproval===true}))
 const targetRows=await ops.listPublicationTargets(owner)
 const targets=targetRows.map(t=>({id:t.id,clientId:t.clientId,targetId:t.targetId,status:t.status,executionEnabled:t.executionEnabled,framework:t.framework}))
 const policies=(await Promise.all(clients.map(c=>ops.listAutopilotPolicies(owner,c.id)))).flat().map(p=>({policyId:p.policyId,clientId:p.clientId,publicationTargetId:p.publicationTargetId,status:p.status,expiresAt:p.expiresAt.toISOString(),policyVersion:p.policyVersion}))
 const requests=await database.select({requestId:weeklyContentReviewRequests.requestId,clientId:weeklyContentReviewRequests.clientId,entryId:weeklyContentReviewRequests.entryId,status:weeklyContentReviewRequests.status,expiresAt:weeklyContentReviewRequests.expiresAt,publicationStatus:contentOperationCalendarEntries.status,title:seoGeoContentDrafts.title,notificationStatus:weeklyContentOutbox.status,notificationError:weeklyContentOutbox.errorCode}).from(weeklyContentReviewRequests).leftJoin(contentOperationCalendarEntries,eq(contentOperationCalendarEntries.id,weeklyContentReviewRequests.entryId)).leftJoin(seoGeoContentDrafts,eq(seoGeoContentDrafts.id,weeklyContentReviewRequests.draftId)).leftJoin(weeklyContentOutbox,eq(weeklyContentOutbox.requestRowId,weeklyContentReviewRequests.id)).where(eq(weeklyContentReviewRequests.ownerUserId,owner)).orderBy(desc(weeklyContentReviewRequests.id)).limit(100)
 const plans=await database.select({id:seoGeoProductionPlans.id,title:seoGeoProductionPlans.title,status:seoGeoProductionPlans.status}).from(seoGeoProductionPlans).where(and(eq(seoGeoProductionPlans.ownerUserId,owner),eq(seoGeoProductionPlans.language,'zh-hant'),inArray(seoGeoProductionPlans.status,['ready','generating','in_progress','completed']))).orderBy(desc(seoGeoProductionPlans.id)).limit(50)
 const calendars=await Promise.all((await ops.listCalendars(owner)).map(async c=>({id:c.id,clientId:c.clientId,planStartDate:c.planStartDate,cadenceDays:c.cadenceDays,status:c.status,hasPendingArticle:(await ops.listEntries(owner,c.id)).some(e=>!['delivered','completed','cancelled','skipped'].includes(e.status))})))
 return {readiness,configs,clients,requests,plans,targets,policies,calendars}
}catch(error){weeklyPublicError(error)}})

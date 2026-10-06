import {z} from 'zod'
import {and,eq} from 'drizzle-orm'
import {getDatabase} from '../../database'
import {contentOperationClients} from '../../database/schema'
import {createOwnerContentClient} from '../../content-operations/service'
import {createContentOperationsRepositoryFromDatabase,type ContentOperationsRepository} from '../../content-operations/repository'
import {requireWeeklyOwner,weeklyBody,weeklyRuntimeDependencies,weeklyPublicError} from '../../weekly-content/http'
export default defineEventHandler(async event=>{try{
 const owner=await requireWeeklyOwner(event,true);z.object({}).strict().parse(await weeklyBody(event));weeklyRuntimeDependencies()
 return await getDatabase()!.transaction(async tx=>{
  const base=createContentOperationsRepositoryFromDatabase(tx)
  // The server requires customer approval in the initial INSERT. No legacy-publication window exists.
  const ops:ContentOperationsRepository={...base,transaction:work=>work(ops),insertClient:input=>base.insertClient({...input,requireCustomerApproval:true})}
  const client=await createOwnerContentClient(owner,{displayName:'Do Alignment',canonicalSiteOrigin:'https://doalignment.com',framework:'nextjs',publicationTransport:'first_party_signed_api',timeZone:'Asia/Taipei',defaultCadenceDays:7,defaultPublishLocalTime:'10:00',monthlyBudgetUnits:4,idempotencyKey:'weekly-do-alignment-v1'},ops)
  await tx.update(contentOperationClients).set({requireCustomerApproval:true}).where(and(eq(contentOperationClients.ownerUserId,owner),eq(contentOperationClients.id,client.id)))
  return {...client,requireCustomerApproval:true}
 })
}catch(error){weeklyPublicError(error)}})

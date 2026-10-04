import {z} from 'zod'
import {reopenReviewRequest} from '../../../../weekly-content/service'
import {requireWeeklyOwner,weeklyBody,weeklyPathId,weeklyRuntimeDependencies,weeklyPublicError} from '../../../../weekly-content/http'
export default defineEventHandler(async event=>{try{
 const ownerUserId=await requireWeeklyOwner(event,true)
 const parsed=z.object({clientId:z.number().int().positive(),idempotencyKey:z.string().min(1).max(128)}).strict().parse(await weeklyBody(event))
 return await reopenReviewRequest({ownerUserId,clientId:parsed.clientId,entryId:weeklyPathId(event),idempotencyKey:parsed.idempotencyKey},weeklyRuntimeDependencies())
}catch(error){weeklyPublicError(error)}})

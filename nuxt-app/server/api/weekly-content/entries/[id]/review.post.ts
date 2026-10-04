import {z} from 'zod'
import {createReviewRequest} from '../../../../weekly-content/service'
import {requireWeeklyOwner,weeklyBody,weeklyPathId,weeklyRuntimeDependencies,weeklyPublicError} from '../../../../weekly-content/http'
export default defineEventHandler(async event=>{try{const ownerUserId=await requireWeeklyOwner(event,true);const parsed=z.object({clientId:z.number().int().positive()}).strict().parse(await weeklyBody(event));return await createReviewRequest({ownerUserId,clientId:parsed.clientId,entryId:weeklyPathId(event)},weeklyRuntimeDependencies())}catch(error){weeklyPublicError(error)}})

import {z} from 'zod'
import {requireWeeklyClientApproval} from '../../../../weekly-content/service'
import {requireWeeklyOwner,weeklyBody,weeklyPathId,weeklyRuntimeDependencies,weeklyPublicError} from '../../../../weekly-content/http'
export default defineEventHandler(async event=>{try{const ownerUserId=await requireWeeklyOwner(event,true);z.object({consent:z.literal(true)}).strict().parse(await weeklyBody(event));return await requireWeeklyClientApproval({ownerUserId,clientId:weeklyPathId(event)},weeklyRuntimeDependencies())}catch(error){weeklyPublicError(error)}})

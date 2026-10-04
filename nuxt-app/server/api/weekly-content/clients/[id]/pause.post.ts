import {z} from 'zod'
import {pauseWeeklyReviewConfig} from '../../../../weekly-content/service'
import {requireWeeklyOwner,weeklyBody,weeklyPathId,weeklyRuntimeDependencies,weeklyPublicError} from '../../../../weekly-content/http'
const input=z.object({status:z.enum(['paused','revoked'])}).strict()
export default defineEventHandler(async event=>{try{const ownerUserId=await requireWeeklyOwner(event,true);const parsed=input.parse(await weeklyBody(event));return await pauseWeeklyReviewConfig({ownerUserId,clientId:weeklyPathId(event),...parsed},weeklyRuntimeDependencies())}catch(error){weeklyPublicError(error)}})

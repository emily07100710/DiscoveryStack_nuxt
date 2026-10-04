import {z} from 'zod'
import {activateWeeklyReviewConfig} from '../../../../weekly-content/service'
import {requireWeeklyOwner,weeklyBody,weeklyPathId,weeklyRuntimeDependencies,weeklyPublicError} from '../../../../weekly-content/http'
const input=z.object({publicationTargetId:z.number().int().positive(),policyId:z.string().min(1).max(96),reviewTtlHours:z.number().int().min(1).max(168).optional(),idempotencyKey:z.string().min(1).max(128)}).strict()
export default defineEventHandler(async event=>{try{const ownerUserId=await requireWeeklyOwner(event,true);const parsed=input.parse(await weeklyBody(event));return await activateWeeklyReviewConfig({ownerUserId,clientId:weeklyPathId(event),...parsed},weeklyRuntimeDependencies())}catch(error){weeklyPublicError(error)}})

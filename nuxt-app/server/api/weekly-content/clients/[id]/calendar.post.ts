import {z} from 'zod'
import {createInitialWeeklyCalendar,productionWeeklyPlannerDependencies} from '../../../../weekly-content/planner'
import {requireWeeklyOwner,weeklyBody,weeklyPathId,weeklyRuntimeDependencies,weeklyPublicError} from '../../../../weekly-content/http'
const input=z.object({productionPlanId:z.number().int().positive(),startDate:z.string().regex(/^\d{4}-\d{2}-\d{2}$/),publishLocalTime:z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),monthlyArticleLimit:z.number().int().min(1).max(5)}).strict()
export default defineEventHandler(async event=>{try{const owner=await requireWeeklyOwner(event,true);const body=input.parse(await weeklyBody(event));const clientId=weeklyPathId(event);weeklyRuntimeDependencies();return await createInitialWeeklyCalendar(owner,clientId,body,new Date(),productionWeeklyPlannerDependencies())}catch(error){weeklyPublicError(error)}})

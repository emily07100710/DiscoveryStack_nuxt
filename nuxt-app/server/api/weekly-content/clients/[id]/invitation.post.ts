import {z} from 'zod'
import {weeklyLineConnectUrl} from '../../../../weekly-content/line-onboarding'
import {issueLineBindingInvite} from '../../../../weekly-content/service'
import {requireWeeklyOwner,weeklyBody,weeklyPathId,weeklyRuntimeDependencies,weeklyPublicError} from '../../../../weekly-content/http'
export default defineEventHandler(async event=>{try{const ownerUserId=await requireWeeklyOwner(event,true);z.object({}).strict().parse(await weeklyBody(event));const connectUrl=weeklyLineConnectUrl({publicOrigin:process.env.NUXT_WEEKLY_CONTENT_REVIEW_ORIGIN || '',liffId:process.env.NUXT_WEEKLY_CONTENT_LIFF_ID || '',liffEnabled:process.env.NUXT_WEEKLY_CONTENT_LIFF_ENABLED==='true'});return {...await issueLineBindingInvite({ownerUserId,clientId:weeklyPathId(event)},weeklyRuntimeDependencies()),connectUrl}}catch(error){weeklyPublicError(error)}})

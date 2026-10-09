import {createError,getRequestHeader} from 'h3'
import {z} from 'zod'
import {weeklyLineConnectUrl} from '../../../../weekly-content/line-onboarding'
import {REPLACE_LINE_RECIPIENT_CONFIRMATION,replaceLineBinding} from '../../../../weekly-content/service'
import {requireWeeklyOwner,weeklyBody,weeklyPathId,weeklyRuntimeDependencies,weeklyPublicError} from '../../../../weekly-content/http'

const input=z.object({confirmation:z.literal(REPLACE_LINE_RECIPIENT_CONFIRMATION)}).strict()

export default defineEventHandler(async event=>{try{
  if(getRequestHeader(event,'sec-fetch-site')!=='same-origin')throw createError({statusCode:403,statusMessage:'請從搜尋王後台操作。'})
  const ownerUserId=await requireWeeklyOwner(event,true)
  const parsed=input.parse(await weeklyBody(event))
  const connectUrl=weeklyLineConnectUrl({publicOrigin:process.env.NUXT_WEEKLY_CONTENT_REVIEW_ORIGIN || '',liffId:process.env.NUXT_WEEKLY_CONTENT_LIFF_ID || '',liffEnabled:process.env.NUXT_WEEKLY_CONTENT_LIFF_ENABLED==='true'})
  return {...await replaceLineBinding({ownerUserId,clientId:weeklyPathId(event),confirmation:parsed.confirmation},weeklyRuntimeDependencies()),connectUrl}
}catch(error){weeklyPublicError(error)}})

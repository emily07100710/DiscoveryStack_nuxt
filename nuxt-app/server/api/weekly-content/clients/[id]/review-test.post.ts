import {createError,getRequestHeader} from 'h3'
import {z} from 'zod'
import {readBoundedRequestBody} from '../../../../utils/bounded-request-body'
import {createAndSendReviewTest,REVIEW_TEST_CONFIRMATION,reviewTestRuntimeDependencies} from '../../../../weekly-content/review-test'
import {requireWeeklyOwner,weeklyPathId,weeklyPublicError} from '../../../../weekly-content/http'

const input=z.object({title:z.string().min(1).max(160),body:z.string().min(1).max(12_000),idempotencyKey:z.string().min(8).max(128),confirmation:z.literal(REVIEW_TEST_CONFIRMATION)}).strict()

export default defineEventHandler(async event=>{try{
  if(getRequestHeader(event,'sec-fetch-site')!=='same-origin')throw createError({statusCode:403,statusMessage:'請從搜尋王後台操作。'})
  const ownerUserId=await requireWeeklyOwner(event,true)
  const raw=await readBoundedRequestBody(event,{maxBytes:48*1024,oversizedMessage:'測試稿內容過大。',invalidMessage:'測試稿內容不正確。',invalidStatusCode:422})
  const parsed=input.parse(raw)
  return await createAndSendReviewTest({ownerUserId,clientId:weeklyPathId(event),...parsed},reviewTestRuntimeDependencies())
}catch(error){weeklyPublicError(error)}})

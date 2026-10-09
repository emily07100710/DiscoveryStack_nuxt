import {listReviewTestsForOwner,reviewTestRuntimeDependencies} from '../../../../weekly-content/review-test'
import {requireWeeklyOwner,weeklyPathId,weeklyPublicError} from '../../../../weekly-content/http'

export default defineEventHandler(async event=>{try{
  const ownerUserId=await requireWeeklyOwner(event)
  return await listReviewTestsForOwner({ownerUserId,clientId:weeklyPathId(event)},reviewTestRuntimeDependencies())
}catch(error){weeklyPublicError(error)}})

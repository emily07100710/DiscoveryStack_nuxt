import {getReviewByReadToken} from '../../../weekly-content/service'
import {weeklyRuntimeDependencies,weeklyPublicError} from '../../../weekly-content/http'
import {renderWeeklyReviewPage,WEEKLY_REVIEW_HEADERS} from '../../../weekly-content/review-page'
export default defineEventHandler(async event=>{setResponseHeaders(event,WEEKLY_REVIEW_HEADERS);try{const requestId=getRouterParam(event,'requestId') || '';const token=getQuery(event).token;if(typeof token!=='string'||token.length>128)throw createError({statusCode:404});const review=await getReviewByReadToken({requestId,readToken:token},weeklyRuntimeDependencies());return renderWeeklyReviewPage(review)}catch(error){weeklyPublicError(error)}})

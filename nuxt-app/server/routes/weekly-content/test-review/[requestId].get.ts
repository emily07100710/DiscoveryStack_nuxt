import { createError, getQuery, getRouterParam, setResponseHeaders } from 'h3'
import { getReviewTestPreview, reviewTestRuntimeDependencies } from '../../../weekly-content/review-test'
import { renderReviewTestPage, WEEKLY_REVIEW_HEADERS } from '../../../weekly-content/review-test-page'
import { weeklyPublicError } from '../../../weekly-content/http'
export default defineEventHandler(async event => {
  setResponseHeaders(event, WEEKLY_REVIEW_HEADERS)
  try {
    const token = getQuery(event).token
    if (typeof token !== 'string' || token.length > 128) throw createError({ statusCode: 404 })
    const review = await getReviewTestPreview({ requestId: getRouterParam(event, 'requestId') || '', readToken: token }, reviewTestRuntimeDependencies())
    return renderReviewTestPage(review)
  } catch (error) { weeklyPublicError(error) }
})

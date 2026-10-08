import { createError, defineEventHandler, getRequestHeader, getRequestURL, getRouterParam, setResponseHeaders } from 'h3'
import { getOwnerDatabaseUserId } from '../../../../audit/repository'
import { confirmOwnerSiteMeasurement, parseSiteMeasurementConfirmInput } from '../../../../content-operations/site-measurement'
import { createBoundedFetch } from '../../../../content-operations/bounded-fetch'
import { getContentOperationsRuntimeDependencies } from '../../../../content-operations/runtime-dependencies'
import { readBoundedRequestBody } from '../../../../utils/bounded-request-body'
import { requireOwner } from '../../../../utils/auth'
import { createContentOperationsRepository } from '../../../../content-operations/repository'
import { createWeeklyContentRepository } from '../../../../weekly-content/repository'

export default defineEventHandler(async event => {
  setResponseHeaders(event, { 'cache-control': 'private, no-store, max-age=0', 'x-robots-tag': 'noindex, nofollow, noarchive', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' })
  const owner = await requireOwner(event)
  try {
    const configuredOrigin = process.env.NUXT_DISCOVERYSTACK_PRIVATE_ORIGIN
    const expected = configuredOrigin ? new URL(configuredOrigin) : getRequestURL(event)
    if (configuredOrigin && (configuredOrigin !== expected.origin || expected.username || expected.password || !['https:', 'http:'].includes(expected.protocol))) throw createError({ statusCode: 503 })
    const origin = getRequestHeader(event, 'origin'), site = getRequestHeader(event, 'sec-fetch-site')
    if (!origin || origin !== expected.origin || site && site !== 'same-origin') throw createError({ statusCode: 403 })
    const rawId = getRouterParam(event, 'id'), entryId = rawId && /^[1-9]\d{0,11}$/u.test(rawId) ? Number(rawId) : 0
    if (!Number.isSafeInteger(entryId) || entryId < 1) throw createError({ statusCode: 422 })
    const value = parseSiteMeasurementConfirmInput(await readBoundedRequestBody(event, { maxBytes: 1024, oversizedMessage: '成效觀察確認請求過大。', invalidMessage: '成效觀察確認請求格式不正確。', invalidStatusCode: 422 }))
    const ownerUserId = await getOwnerDatabaseUserId(owner.openId)
    return await confirmOwnerSiteMeasurement({ ownerUserId, entryId, value, repository: createContentOperationsRepository(), weeklyRepositoryFactory: createWeeklyContentRepository,
      dependencies: { ...getContentOperationsRuntimeDependencies(), fetchImpl: createBoundedFetch({ maxResponseBodyBytes: 4096 }), now: new Date() } })
  } catch (error) {
    const statusCode = error && typeof error === 'object' && 'statusCode' in error && [403, 404, 409, 413, 422, 503].includes(Number(error.statusCode)) ? Number(error.statusCode) : 503
    throw createError({ statusCode, statusMessage: '目前無法確認接入成效觀察；沒有發布文章或授予訓練權限。' })
  }
})

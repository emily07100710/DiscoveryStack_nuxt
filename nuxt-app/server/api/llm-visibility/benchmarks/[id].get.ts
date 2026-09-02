import { getOwnerDatabaseUserId } from '../../../audit/repository'
import { rethrowVisibilityError, setPrivateApiHeaders } from '../../../llm-visibility/api'
import { getBenchmarkDetail } from '../../../llm-visibility/benchmark-runtime'
import { requireOwner } from '../../../utils/auth'

export default defineEventHandler(async event => {
  setPrivateApiHeaders(event)
  const owner = await requireOwner(event)
  const benchmarkId = Number(getRouterParam(event, 'id'))
  if (!Number.isSafeInteger(benchmarkId) || benchmarkId <= 0) throw createError({ statusCode: 400, statusMessage: 'Benchmark ID 無效。' })
  try { return await getBenchmarkDetail(await getOwnerDatabaseUserId(owner.openId), benchmarkId) } catch (error) { rethrowVisibilityError(error) }
})

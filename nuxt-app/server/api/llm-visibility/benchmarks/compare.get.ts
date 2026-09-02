import { getOwnerDatabaseUserId } from '../../../audit/repository'
import { rethrowVisibilityError, setPrivateApiHeaders } from '../../../llm-visibility/api'
import { compareBenchmarks } from '../../../llm-visibility/benchmark-runtime'
import { requireOwner } from '../../../utils/auth'

export default defineEventHandler(async event => {
  setPrivateApiHeaders(event)
  const owner = await requireOwner(event)
  const query = getQuery(event)
  const left = Number(query.left); const right = Number(query.right)
  if (!Number.isSafeInteger(left) || left <= 0 || !Number.isSafeInteger(right) || right <= 0) throw createError({ statusCode: 400, statusMessage: 'Benchmark compare ID 無效。' })
  try { return await compareBenchmarks(await getOwnerDatabaseUserId(owner.openId), left, right) } catch (error) { rethrowVisibilityError(error) }
})

import { getOwnerDatabaseUserId } from '../../audit/repository'
import { rethrowVisibilityError, setPrivateApiHeaders } from '../../llm-visibility/api'
import { listBenchmarks } from '../../llm-visibility/benchmark-runtime'
import { requireOwner } from '../../utils/auth'

export default defineEventHandler(async event => {
  setPrivateApiHeaders(event)
  const owner = await requireOwner(event)
  const projectId = Number(getQuery(event).projectId)
  if (!Number.isSafeInteger(projectId) || projectId <= 0) throw createError({ statusCode: 400, statusMessage: 'Project ID 無效。' })
  try { return await listBenchmarks(await getOwnerDatabaseUserId(owner.openId), projectId) } catch (error) { rethrowVisibilityError(error) }
})

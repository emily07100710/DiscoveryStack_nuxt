import { getOwnerDatabaseUserId } from '../../../../audit/repository'
import { executeContentOperationEntry, toPublicContentOperationsError } from '../../../../content-operations'
import { getContentOperationsRuntimeDependencies } from '../../../../content-operations/runtime-dependencies'
import { requireOwner } from '../../../../utils/auth'

export default defineEventHandler(async (event) => {
  setResponseHeaders(event, { 'cache-control': 'no-store', 'x-robots-tag': 'noindex, nofollow' })
  try {
    const owner = await requireOwner(event)
    const ownerUserId = await getOwnerDatabaseUserId(owner.openId)
    const rawId = getRouterParam(event, 'id')
    const entryId = rawId && /^\d{1,12}$/.test(rawId) ? Number(rawId) : 0
    if (!Number.isSafeInteger(entryId) || entryId < 1) throw createError({ statusCode: 422, statusMessage: 'Entry id is invalid.' })
    return await executeContentOperationEntry({ ownerUserId, entryId, trigger: 'owner_manual', value: await readBody(event), dependencies: getContentOperationsRuntimeDependencies() })
  } catch (error) {
    throw toPublicContentOperationsError(error, 'Content operation execution is temporarily unavailable.')
  }
})

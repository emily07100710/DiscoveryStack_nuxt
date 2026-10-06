import { getOwnerDatabaseUserId } from '../../../../audit/repository'
import { bindOwnerEntryPublicationTargets } from '../../../../content-operations/orchestrator'
import { toPublicContentOperationsError } from '../../../../content-operations/normalization'
import { requireOwner } from '../../../../utils/auth'

export default defineEventHandler(async (event) => {
  setResponseHeaders(event, { 'cache-control': 'no-store', 'x-robots-tag': 'noindex, nofollow' })
  try {
    const owner = await requireOwner(event)
    const ownerUserId = await getOwnerDatabaseUserId(owner.openId)
    const rawId = getRouterParam(event, 'id')
    const entryId = rawId && /^\d{1,12}$/.test(rawId) ? Number(rawId) : 0
    if (!Number.isSafeInteger(entryId) || entryId < 1) throw createError({ statusCode: 422, statusMessage: 'Entry id is invalid.' })
    return await bindOwnerEntryPublicationTargets(ownerUserId, entryId, await readBody(event))
  } catch (error) {
    throw toPublicContentOperationsError(error, 'Entry publication target binding is temporarily unavailable.')
  }
})

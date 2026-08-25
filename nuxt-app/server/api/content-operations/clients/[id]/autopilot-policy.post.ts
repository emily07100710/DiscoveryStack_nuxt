import { enableOwnerAutopilot, toPublicContentOperationsError } from '../../../../content-operations'
import { requireOwner } from '../../../../utils/auth'
import { getOwnerDatabaseUserId } from '../../../../audit/repository'

export default defineEventHandler(async (event) => {
  setResponseHeaders(event, { 'cache-control': 'no-store', 'x-robots-tag': 'noindex, nofollow, noarchive' })
  try {
    const owner = await requireOwner(event)
    const ownerUserId = await getOwnerDatabaseUserId(owner.openId)
    const rawId = getRouterParam(event, 'id')
    const clientId = rawId && /^\d{1,12}$/.test(rawId) ? Number(rawId) : 0
    if (!Number.isSafeInteger(clientId) || clientId < 1) throw createError({ statusCode: 422, statusMessage: 'Client id is invalid.' })
    return await enableOwnerAutopilot(ownerUserId, clientId, await readBody(event))
  } catch (error) {
    throw toPublicContentOperationsError(error, 'Governed autopilot is temporarily unavailable.')
  }
})

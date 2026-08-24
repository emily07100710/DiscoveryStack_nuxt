import { getOwnerDatabaseUserId } from '../../audit/repository'
import { createOwnerContentClient, parseClientInput, toPublicContentOperationsError } from '../../content-operations'
import { requireOwner } from '../../utils/auth'

export default defineEventHandler(async (event) => {
  setResponseHeaders(event, { 'cache-control': 'no-store', 'x-robots-tag': 'noindex, nofollow, noarchive' })
  try {
    const owner = await requireOwner(event)
    const ownerUserId = await getOwnerDatabaseUserId(owner.openId)
    const parsed = parseClientInput(await readBody(event))
    return await createOwnerContentClient(ownerUserId, parsed)
  } catch (error) {
    throw toPublicContentOperationsError(error, 'Content operation client is temporarily unavailable.')
  }
})

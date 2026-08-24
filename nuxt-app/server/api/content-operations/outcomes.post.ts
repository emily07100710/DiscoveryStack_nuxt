import { getOwnerDatabaseUserId } from '../../audit/repository'
import { parseOutcomeInput, recordOwnerOutcomeAssessment, toPublicContentOperationsError } from '../../content-operations'
import { requireOwner } from '../../utils/auth'

export default defineEventHandler(async (event) => {
  setResponseHeaders(event, { 'cache-control': 'no-store', 'x-robots-tag': 'noindex, nofollow, noarchive' })
  try {
    const owner = await requireOwner(event)
    const ownerUserId = await getOwnerDatabaseUserId(owner.openId)
    const parsed = parseOutcomeInput(await readBody(event))
    return await recordOwnerOutcomeAssessment(ownerUserId, parsed)
  } catch (error) {
    throw toPublicContentOperationsError(error, 'Outcome assessment is temporarily unavailable.')
  }
})

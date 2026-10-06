import { getOwnerDatabaseUserId } from '../../audit/repository'
import { recordOwnerOutcomeAssessment } from '../../content-operations/service'
import { parseOutcomeInput, toPublicContentOperationsError } from '../../content-operations/normalization'
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

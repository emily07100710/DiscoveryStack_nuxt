import { buildDataset } from '../../../geo-outcome-model'
import { readGeoBody, requiredIdempotency, routeError, strictKeys, requireGeoOutcomeOwner, setGeoOutcomePrivateApiHeaders, withMutationIdempotency } from '../_helpers'

export default defineEventHandler(async (event) => {
  setGeoOutcomePrivateApiHeaders(event)
  try {
    const { ownerUserId } = await requireGeoOutcomeOwner(event)
    const body = await readGeoBody(event)
    strictKeys(body, ['idempotencyKey', 'taskType'])
    const idempotencyKey = requiredIdempotency(body)
    if (body.taskType !== undefined && body.taskType !== 'citation_selection') throw new Error('Only citation_selection may be built from observations.')
    const result = await withMutationIdempotency(ownerUserId, 'datasets.build', idempotencyKey, { taskType: body.taskType || 'citation_selection' }, transaction => buildDataset(ownerUserId, (body.taskType || 'citation_selection') as 'citation_selection', transaction))
    return { status: 'success', manifest: result.manifest, memberCount: result.memberCount, automaticallyApproved: false }
  } catch (error) { return routeError(error) }
})

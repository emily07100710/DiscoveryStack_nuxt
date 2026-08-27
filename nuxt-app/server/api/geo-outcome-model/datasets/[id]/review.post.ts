import { getRouterParam } from 'h3'
import { reviewDataset } from '../../../../geo-outcome-model'
import { readGeoBody, requiredIdempotency, routeError, strictKeys, requireGeoOutcomeOwner, setGeoOutcomePrivateApiHeaders, withMutationIdempotency } from '../../_helpers'

export default defineEventHandler(async (event) => {
  setGeoOutcomePrivateApiHeaders(event)
  try {
    const { ownerUserId } = await requireGeoOutcomeOwner(event)
    const manifestId = getRouterParam(event, 'id')
    if (!manifestId) throw new Error('Dataset manifest id is required.')
    const body = await readGeoBody(event)
    strictKeys(body, ['idempotencyKey', 'decision', 'reason'])
    const idempotencyKey = requiredIdempotency(body)
    if (body.decision !== 'approve' && body.decision !== 'revoke') throw new Error('Dataset decision is invalid.')
    if (typeof body.reason !== 'string') throw new Error('Review reason is required.')
    const manifest = await withMutationIdempotency(ownerUserId, `datasets/${manifestId}/review`, idempotencyKey, { decision: body.decision, reason: body.reason }, transaction => reviewDataset(ownerUserId, manifestId, body.decision as 'approve' | 'revoke', body.reason as string, transaction))
    return { status: 'success', manifest, automaticallyApproved: false }
  } catch (error) { return routeError(error) }
})

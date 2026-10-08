import { getRouterParam } from 'h3'
import { reviewDataset, summarizeDatasetDecision } from '../../../../geo-outcome-model'
import { readGeoBody, requiredIdempotency, routeError, strictKeys, requireGeoOutcomeOwner, setGeoOutcomePrivateApiHeaders, withMutationIdempotency } from '../../_helpers'

export default defineEventHandler(async (event) => {
  setGeoOutcomePrivateApiHeaders(event)
  try {
    const { ownerUserId } = await requireGeoOutcomeOwner(event)
    const manifestId = getRouterParam(event, 'id')
    if (!manifestId) throw new Error('Dataset manifest id is required.')
    const body = await readGeoBody(event)
    strictKeys(body, ['idempotencyKey', 'decision', 'reason', 'knowledgeMode', 'knowledgeConfirmed'])
    const idempotencyKey = requiredIdempotency(body)
    if (body.decision !== 'approve' && body.decision !== 'revoke') throw new Error('Dataset decision is invalid.')
    if (typeof body.reason !== 'string') throw new Error('Review reason is required.')
    const isApproval = body.decision === 'approve'
    if (!isApproval && (Object.hasOwn(body, 'knowledgeMode') || Object.hasOwn(body, 'knowledgeConfirmed'))) throw new Error('Knowledge declaration fields are only valid for dataset approval.')
    if (isApproval && body.knowledgeMode !== 'declared_none_v1' && body.knowledgeMode !== 'pinned_v1') throw new Error('An explicit Knowledge dependency declaration is required.')
    if (isApproval && body.knowledgeConfirmed !== true) throw new Error('Confirm the displayed Knowledge dependency declaration before approval.')
    const knowledgeMode = isApproval ? body.knowledgeMode as 'declared_none_v1' | 'pinned_v1' : undefined
    const input = isApproval
      ? { decision: body.decision, reason: body.reason, knowledgeMode, knowledgeConfirmed: true }
      : { decision: body.decision, reason: body.reason }
    const result = await withMutationIdempotency(ownerUserId, `datasets/${manifestId}/review`, idempotencyKey, input, transaction => reviewDataset(ownerUserId, manifestId, body.decision as 'approve' | 'revoke', ownerUserId, body.reason as string, transaction, isApproval ? { knowledgeMode } : undefined))
    return { status: 'success', manifest: result.manifest, datasetDecision: summarizeDatasetDecision(result.decision), receiptIsCurrentAuthority: false, automaticallyApproved: false }
  } catch (error) { return routeError(error) }
})

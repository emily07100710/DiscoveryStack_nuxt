import { getRouterParam } from 'h3'
import { readGeoBody, requiredIdempotency, routeError, strictKeys, requireGeoOutcomeOwner, setGeoOutcomePrivateApiHeaders, withMutationIdempotency } from '../../_helpers'
import { executeObservationGovernanceMutation } from '../../observation-governance-mutation'

export default defineEventHandler(async (event) => {
  setGeoOutcomePrivateApiHeaders(event)
  try {
    const { ownerUserId } = await requireGeoOutcomeOwner(event); const id = getRouterParam(event, 'id'); if (!id) throw new Error('Observation fingerprint is required.')
    const body = await readGeoBody(event); strictKeys(body, ['idempotencyKey', 'action', 'reason', 'sourceRecordId']); const idempotencyKey = requiredIdempotency(body)
    if (body.action !== 'verify_evidence' && body.action !== 'approve_consent' && body.action !== 'approve_pii' && body.action !== 'revoke') throw new Error('Governance action is invalid.')
    if (typeof body.reason !== 'string') throw new Error('Governance reason is required.')
    if (body.action === 'verify_evidence' && (!Number.isSafeInteger(body.sourceRecordId) || Number(body.sourceRecordId) <= 0)) throw new Error('verify_evidence requires an authoritative sourceRecordId.')
    if (body.action !== 'verify_evidence' && body.sourceRecordId !== undefined) throw new Error('Only verify_evidence accepts sourceRecordId.')
    const input = { action: body.action, reason: body.reason, sourceRecordId: body.action === 'verify_evidence' ? body.sourceRecordId : null }
    const result = await withMutationIdempotency(ownerUserId, `observations/${id}/governance`, idempotencyKey, input, transaction => executeObservationGovernanceMutation({ ownerUserId, observationFingerprint: id, action: body.action as 'verify_evidence' | 'approve_consent' | 'approve_pii' | 'revoke', reason: body.reason as string, sourceRecordId: body.action === 'verify_evidence' ? Number(body.sourceRecordId) : null, repository: transaction }))
    return { status: 'success', observation: { observationFingerprint: result.observation.observationFingerprint, verificationStatus: result.observation.verificationStatus, consentStatus: result.observation.consentStatus, piiStatus: result.observation.piiStatus }, verificationDecision: result.verificationDecision, evidenceBinding: 'evidenceBinding' in result ? result.evidenceBinding : null }
  } catch (error) { return routeError(error) }
})

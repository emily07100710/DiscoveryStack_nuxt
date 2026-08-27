import { getRouterParam } from 'h3'
import { verifyObservation } from '../../../../geo-outcome-model'
import { readGeoBody, requiredIdempotency, routeError, strictKeys, requireGeoOutcomeOwner, setGeoOutcomePrivateApiHeaders, withMutationIdempotency } from '../../_helpers'

export default defineEventHandler(async (event) => {
  setGeoOutcomePrivateApiHeaders(event)
  try {
    const { ownerUserId } = await requireGeoOutcomeOwner(event); const id = getRouterParam(event, 'id'); if (!id) throw new Error('Observation fingerprint is required.')
    const body = await readGeoBody(event); strictKeys(body, ['idempotencyKey', 'action', 'reason', 'evidenceLocatorHash']); const idempotencyKey = requiredIdempotency(body)
    if (body.action !== 'verify_evidence' && body.action !== 'approve_consent' && body.action !== 'approve_pii' && body.action !== 'revoke') throw new Error('Governance action is invalid.')
    if (typeof body.reason !== 'string') throw new Error('Governance reason is required.')
    const evidenceLocatorHash = body.evidenceLocatorHash === undefined || body.evidenceLocatorHash === null ? null : body.evidenceLocatorHash
    if (evidenceLocatorHash !== null && typeof evidenceLocatorHash !== 'string') throw new Error('evidenceLocatorHash must be a string when supplied.')
    const result = await withMutationIdempotency(ownerUserId, `observations/${id}/governance`, idempotencyKey, { action: body.action, reason: body.reason, evidenceLocatorHash }, transaction => verifyObservation(ownerUserId, id, ownerUserId, body.action as 'verify_evidence' | 'approve_consent' | 'approve_pii' | 'revoke', body.reason as string, evidenceLocatorHash, transaction))
    return { status: 'success', observation: { observationFingerprint: result.observation.observationFingerprint, verificationStatus: result.observation.verificationStatus, consentStatus: result.observation.consentStatus, piiStatus: result.observation.piiStatus }, verificationDecision: result.verificationDecision }
  } catch (error) { return routeError(error) }
})

import { bindAndVerifyObservationEvidence, verifyObservation } from '../../geo-outcome-model'
import type { GeoOutcomeRepositoryPort } from '../../geo-outcome-model/types'

export async function executeObservationGovernanceMutation(input: {
  ownerUserId: number
  observationFingerprint: string
  action: 'verify_evidence' | 'approve_consent' | 'approve_pii' | 'revoke'
  reason: string
  sourceRecordId: number | null
  repository: GeoOutcomeRepositoryPort
}) {
  if (input.action === 'verify_evidence') {
    if (!Number.isSafeInteger(input.sourceRecordId) || Number(input.sourceRecordId) <= 0) throw new Error('verify_evidence requires an authoritative sourceRecordId.')
    return bindAndVerifyObservationEvidence(input.ownerUserId, input.observationFingerprint, input.ownerUserId, Number(input.sourceRecordId), input.reason, input.repository)
  }
  if (input.sourceRecordId !== null) throw new Error('Only verify_evidence accepts sourceRecordId.')
  return verifyObservation(input.ownerUserId, input.observationFingerprint, input.ownerUserId, input.action, input.reason, input.repository)
}

import { fingerprint, isSha256 } from './canonical'
import { GEO_OUTCOME_LABEL_CONTRACT_VERSION } from './constants'
import { canBePrimaryCitationTruth, isHardNegativeCandidate, isVerifiedCitationObservation, normalizeManualObservation, normalizeTrustedObservation, observationFingerprintPayload } from './normalization'
import type { OutcomeObservation } from './types'

export { canBePrimaryCitationTruth, isHardNegativeCandidate, isVerifiedCitationObservation, normalizeManualObservation, normalizeTrustedObservation }
export const labelContractVersion = GEO_OUTCOME_LABEL_CONTRACT_VERSION

export function observationIdentity(observation: Pick<OutcomeObservation, 'ownerUserId' | 'runIdentity' | 'candidatePageIdentityHash' | 'normalizedQueryHash' | 'engine' | 'model' | 'modelVersion' | 'interface' | 'locale' | 'observationWindow'>): string {
  return fingerprint({ ownerUserId: observation.ownerUserId, runIdentity: observation.runIdentity, candidatePageIdentityHash: observation.candidatePageIdentityHash, normalizedQueryHash: observation.normalizedQueryHash, engine: observation.engine, model: observation.model, modelVersion: observation.modelVersion, interface: observation.interface, locale: observation.locale, observationWindow: observation.observationWindow })
}

export function assertObservationIsUsable(observation: OutcomeObservation): void {
  if (observation.schemaVersion !== 'geo-outcome-observation-v1') throw new Error('Unsupported observation schema version.')
  if (!isSha256(observation.observationFingerprint)) throw new Error('Observation fingerprint is invalid.')
  const { observationFingerprint: actual, ...payload } = observation
  if (actual !== fingerprint(observationFingerprintPayload(payload))) throw new Error('Observation fingerprint does not match canonical immutable payload.')
  if (observation.labelBasis === 'provider_api_secondary_only' && canBePrimaryCitationTruth(observation)) throw new Error('Provider API observations cannot become primary citation truth.')
  if ((observation.labelBasis === 'search_console_aggregate_only' || observation.labelBasis === 'first_party_analytics_aggregate_only') && canBePrimaryCitationTruth(observation)) throw new Error('Aggregate analytics observations cannot become citation truth.')
  if (observation.labelBasis === 'heuristic_auxiliary_only' && canBePrimaryCitationTruth(observation)) throw new Error('Heuristic labels cannot become citation truth.')
  if (observation.verificationStatus === 'verified' && observation.verificationAuthority === 'intake') throw new Error('Intake cannot be a verification authority.')
  if (observation.verificationStatus === 'verified' && (!observation.reviewFingerprint || observation.consentStatus !== 'approved' || observation.piiStatus !== 'clean')) throw new Error('Verified observations require review, consent and clean PII provenance.')
}

export function isCitationSelectionLabel(observation: OutcomeObservation): boolean { return isVerifiedCitationObservation(observation) && (observation.citationStatus === 'cited' || observation.citationStatus === 'not_cited') }

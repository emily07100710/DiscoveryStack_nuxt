import { fingerprint, isSha256 } from './canonical'
import { buildStructuralAuxiliaryManifest } from './dataset-builder'
import { normalizeManualObservation } from './normalization'
import type { DatasetManifest, OutcomeObservation } from './types'

export interface ApprovedStructuralTrainingExample {
  exampleFingerprint: string
  ownerUserId: number
  featureContractVersion: string
  consentStatus: 'approved' | 'revoked' | 'unknown'
  piiStatus: 'clean' | 'contains_pii' | 'unknown'
  labelBasis: 'heuristic_auxiliary_only'
}

export interface OutcomeLearningCandidateContract {
  ownerUserId: number
  observation: unknown
}

export interface ExistingDataInventory {
  structuralExamples: number
  verifiedPrimaryObservations: number
  providerSecondaryObservations: number
  gscAggregateObservations: number
  ga4AggregateObservations: number
  externalDatasetStatus: 'unverified_external_dataset'
  citationOutcomeEligible: number
  structuralAuxiliaryEligible: number
  limitations: string[]
}

export function adaptOutcomeLearningCandidate(input: OutcomeLearningCandidateContract): OutcomeObservation {
  return normalizeManualObservation(input.observation, input.ownerUserId)
}

export function adaptApprovedStructuralExamples(ownerUserId: number, examples: readonly ApprovedStructuralTrainingExample[]): DatasetManifest {
  const clean = examples.filter(example => example.ownerUserId === ownerUserId && example.consentStatus === 'approved' && example.piiStatus === 'clean' && example.labelBasis === 'heuristic_auxiliary_only' && isSha256(example.exampleFingerprint))
  return buildStructuralAuxiliaryManifest({ ownerUserId, exampleFingerprints: clean.map(example => example.exampleFingerprint), approvedCount: clean.length })
}

export function inventoryExistingData(input: { structuralExamples?: readonly ApprovedStructuralTrainingExample[], observations?: readonly OutcomeObservation[], reportedExternalCount?: number | null }): ExistingDataInventory {
  const structural = input.structuralExamples || []
  const observations = input.observations || []
  const verifiedPrimaryObservations = observations.filter(observation => observation.verificationStatus === 'verified' && (observation.labelBasis === 'manual_verified_primary' || observation.labelBasis === 'consumer_surface_observed')).length
  const providerSecondaryObservations = observations.filter(observation => observation.labelBasis === 'provider_api_secondary_only').length
  const gscAggregateObservations = observations.filter(observation => observation.labelBasis === 'search_console_aggregate_only').length
  const ga4AggregateObservations = observations.filter(observation => observation.labelBasis === 'first_party_analytics_aggregate_only').length
  const structuralAuxiliaryEligible = structural.filter(example => example.consentStatus === 'approved' && example.piiStatus === 'clean' && example.labelBasis === 'heuristic_auxiliary_only').length
  return { structuralExamples: structural.length, verifiedPrimaryObservations, providerSecondaryObservations, gscAggregateObservations, ga4AggregateObservations, externalDatasetStatus: 'unverified_external_dataset', citationOutcomeEligible: verifiedPrimaryObservations, structuralAuxiliaryEligible, limitations: ['Reported external dataset counts are not evidence of an authoritative dataset.', 'GSC and GA4 are aggregate features only.', 'Provider API observations remain secondary-only.', `inventoryFingerprint=${fingerprint({ structuralExamples: structural.length, observations: observations.map(observation => observation.observationFingerprint).sort(), reportedExternalCount: input.reportedExternalCount ?? null })}`] }
}

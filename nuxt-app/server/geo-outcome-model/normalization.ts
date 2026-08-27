import { ALLOWED_CITATION, ALLOWED_ENGINES, ALLOWED_INTERFACES, ALLOWED_LABEL_BASES, ALLOWED_OBSERVABLE, ALLOWED_RETRIEVAL, ALLOWED_VERIFICATION, GEO_OUTCOME_SCHEMA_VERSION } from './constants'
import { boundedArray, boundedText, fingerprint, isSha256 } from './canonical'
import type { ContentFeatureInput, OutcomeObservation } from './types'

const OBSERVATION_INPUT_KEYS = [
  'schemaVersion', 'projectId', 'clientId', 'websiteIdentityHash', 'queryIdentityHash', 'normalizedQueryHash', 'candidatePageIdentityHash', 'canonicalPageHash', 'contentHash', 'evidenceSnapshotHash', 'publicationReceiptFingerprint', 'engine', 'model', 'modelVersion', 'interface', 'locale', 'region', 'runIdentity', 'runTimestamp', 'observationWindow', 'observableStatus', 'retrievalStatus', 'citationStatus', 'citationPosition', 'mentionStatus', 'recommendationStatus', 'labelBasis', 'verificationStatus', 'evidenceLocatorHashes', 'appliedRuleHashes', 'contentFeatureVector',
] as const
const FEATURE_KEYS = [
  'contentType', 'locale', 'pageAgeBucket', 'contentLengthBucket', 'headingHierarchy', 'directAnswerPresence', 'faqStructure', 'structuredDataPresence', 'citationMarkerCount', 'approvedAuthoritySourceCount', 'evidenceUtilizationRatio', 'entityCoverage', 'selectedAutoGeoRuleHashes', 'appliedAutoGeoRuleHashes', 'canonicalFlag', 'indexabilityFlag', 'internalLinkDepthBucket', 'contentFreshnessBucket', 'queryPageLexicalOverlap', 'topicClusterEqual', 'verifiedPublicationAgeDays', 'priorObservationCount',
] as const
const SENSITIVE_KEY = /(email|phone|telephone|cookie|session|token|credential|password|secret|authorization|private.?key|raw.?response|customer.?name|full.?name|form)/iu
const arrays = {
  contentType: ['article', 'faq', 'product', 'landing_page', 'documentation', 'other'], pageAgeBucket: ['unknown', '0_7d', '8_30d', '31_90d', '91_365d', '365d_plus'], contentLengthBucket: ['unknown', 'xs', 's', 'm', 'l', 'xl'], headingHierarchy: ['unknown', 'none', 'flat', 'structured'], directAnswerPresence: ['unknown', 'absent', 'present'], faqStructure: ['unknown', 'absent', 'present'], structuredDataPresence: ['unknown', 'absent', 'present'], canonicalFlag: ['unknown', 'valid', 'invalid'], indexabilityFlag: ['unknown', 'indexable', 'not_indexable'], internalLinkDepthBucket: ['unknown', '0', '1', '2', '3_plus'], contentFreshnessBucket: ['unknown', 'stale', 'recent', 'fresh'], topicClusterEqual: ['unknown', 'no', 'yes'],
} as const

function assertExactKeys(value: Record<string, unknown>, allowed: readonly string[], label: string) {
  for (const key of Object.keys(value)) {
    if (SENSITIVE_KEY.test(key)) throw new Error(`${label} contains a sensitive key.`)
    if (!allowed.includes(key)) throw new Error(`${label} contains unknown field: ${key}.`)
  }
}
function enumValue<T extends string>(value: unknown, allowed: readonly T[], field: string): T { if (typeof value !== 'string' || !allowed.includes(value as T)) throw new Error(`${field} is invalid.`); return value as T }
function nullableString(value: unknown, field: string, maxLength: number): string | null { if (value === null || value === undefined) return null; return boundedText(value, maxLength, field) }
function boundedRatio(value: unknown, field: string): number | null { if (value === null || value === undefined) return null; if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) throw new Error(`${field} must be a finite ratio between 0 and 1.`); return value }
function boundedNonNegative(value: unknown, field: string, max = 1_000_000): number | null { if (value === null || value === undefined) return null; if (typeof value !== 'number' || !Number.isInteger(value) || !Number.isFinite(value) || value < 0 || value > max) throw new Error(`${field} must be a bounded non-negative integer.`); return value }
function validateTimestamp(value: unknown, field: string): string { if (typeof value !== 'string') throw new Error(`${field} is required.`); const date = new Date(value); if (!Number.isFinite(date.getTime())) throw new Error(`${field} is invalid.`); return date.toISOString() }

function normalizeFeatures(input: unknown): ContentFeatureInput {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('contentFeatureVector is required.')
  const value = input as Record<string, unknown>; assertExactKeys(value, FEATURE_KEYS, 'contentFeatureVector'); const result = {} as ContentFeatureInput
  for (const key of ['contentType', 'pageAgeBucket', 'contentLengthBucket', 'headingHierarchy', 'directAnswerPresence', 'faqStructure', 'structuredDataPresence', 'canonicalFlag', 'indexabilityFlag', 'internalLinkDepthBucket', 'contentFreshnessBucket', 'topicClusterEqual'] as const) (result as unknown as Record<string, unknown>)[key] = enumValue(value[key], arrays[key], `contentFeatureVector.${key}`)
  result.locale = boundedText(value.locale, 32, 'contentFeatureVector.locale')
  result.citationMarkerCount = boundedNonNegative(value.citationMarkerCount, 'contentFeatureVector.citationMarkerCount', 1000)
  result.approvedAuthoritySourceCount = boundedNonNegative(value.approvedAuthoritySourceCount, 'contentFeatureVector.approvedAuthoritySourceCount', 1000)
  result.evidenceUtilizationRatio = boundedRatio(value.evidenceUtilizationRatio, 'contentFeatureVector.evidenceUtilizationRatio')
  result.entityCoverage = boundedRatio(value.entityCoverage, 'contentFeatureVector.entityCoverage')
  result.queryPageLexicalOverlap = boundedRatio(value.queryPageLexicalOverlap, 'contentFeatureVector.queryPageLexicalOverlap')
  result.verifiedPublicationAgeDays = boundedNonNegative(value.verifiedPublicationAgeDays, 'contentFeatureVector.verifiedPublicationAgeDays', 100_000)
  result.priorObservationCount = boundedNonNegative(value.priorObservationCount, 'contentFeatureVector.priorObservationCount', 1_000_000)
  result.selectedAutoGeoRuleHashes = boundedArray<string>(value.selectedAutoGeoRuleHashes, 128, 'contentFeatureVector.selectedAutoGeoRuleHashes').map((hash, index) => { if (!isSha256(hash)) throw new Error(`selectedAutoGeoRuleHashes[${index}] is invalid.`); return hash })
  result.appliedAutoGeoRuleHashes = boundedArray<string>(value.appliedAutoGeoRuleHashes, 128, 'contentFeatureVector.appliedAutoGeoRuleHashes').map((hash, index) => { if (!isSha256(hash)) throw new Error(`appliedAutoGeoRuleHashes[${index}] is invalid.`); return hash })
  return result
}

export interface NormalizeOptions { mode?: 'intake' | 'trusted_test'; consentStatus?: 'approved' | 'revoked' | 'unknown'; piiStatus?: 'clean' | 'contains_pii' | 'unknown'; verificationAuthority?: OutcomeObservation['verificationAuthority']; reviewFingerprint?: string | null; candidateAuthorityFingerprint?: string | null; candidateSetFingerprint?: string | null }

/** Governance is append-only and may change after intake, so it cannot be part of the immutable observation identity. */
export function observationFingerprintPayload(observation: Omit<OutcomeObservation, 'observationFingerprint'>): unknown {
  const { verificationStatus, consentStatus, piiStatus, verificationAuthority, reviewFingerprint, candidateAuthorityFingerprint, candidateSetFingerprint, ...immutable } = observation
  void verificationStatus; void consentStatus; void piiStatus; void verificationAuthority; void reviewFingerprint; void candidateAuthorityFingerprint; void candidateSetFingerprint
  return immutable
}

export function normalizeManualObservation(input: unknown, ownerUserId: number, options: NormalizeOptions = {}): OutcomeObservation {
  if (!Number.isSafeInteger(ownerUserId) || ownerUserId <= 0) throw new Error('ownerUserId must be server-derived.')
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Observation body must be an object.')
  const value = input as Record<string, unknown>; assertExactKeys(value, OBSERVATION_INPUT_KEYS, 'observation')
  const schemaVersion = enumValue(value.schemaVersion, [GEO_OUTCOME_SCHEMA_VERSION], 'schemaVersion'); const runTimestamp = validateTimestamp(value.runTimestamp, 'runTimestamp')
  const window = value.observationWindow
  if (!window || typeof window !== 'object' || Array.isArray(window)) throw new Error('observationWindow is required.')
  assertExactKeys(window as Record<string, unknown>, ['start', 'end'], 'observationWindow')
  const start = validateTimestamp((window as Record<string, unknown>).start, 'observationWindow.start'); const end = validateTimestamp((window as Record<string, unknown>).end, 'observationWindow.end')
  if (new Date(start).getTime() > new Date(end).getTime()) throw new Error('observationWindow is reversed.')
  for (const key of ['websiteIdentityHash', 'queryIdentityHash', 'normalizedQueryHash', 'candidatePageIdentityHash', 'canonicalPageHash', 'contentHash', 'evidenceSnapshotHash'] as const) if (!isSha256(value[key])) throw new Error(`${key} must be a SHA-256 hash.`)
  const publicationReceiptFingerprint = value.publicationReceiptFingerprint === null || value.publicationReceiptFingerprint === undefined ? null : value.publicationReceiptFingerprint
  if (publicationReceiptFingerprint !== null && !isSha256(publicationReceiptFingerprint)) throw new Error('publicationReceiptFingerprint must be a SHA-256 hash.')
  const evidenceLocatorHashes = boundedArray<string>(value.evidenceLocatorHashes, 64, 'evidenceLocatorHashes').map((hash, index) => { if (!isSha256(hash)) throw new Error(`evidenceLocatorHashes[${index}] is invalid.`); return hash })
  if (new Set(evidenceLocatorHashes).size !== evidenceLocatorHashes.length) throw new Error('evidenceLocatorHashes contains duplicates.')
  const appliedRuleHashes = boundedArray<string>(value.appliedRuleHashes, 128, 'appliedRuleHashes').map((hash, index) => { if (!isSha256(hash)) throw new Error(`appliedRuleHashes[${index}] is invalid.`); return hash })
  const citationPosition = value.citationPosition === null || value.citationPosition === undefined ? null : boundedNonNegative(value.citationPosition, 'citationPosition', 1000)
  if (citationPosition !== null && citationPosition < 1) throw new Error('citationPosition must be positive.')
  const requestedBasis = enumValue(value.labelBasis, ALLOWED_LABEL_BASES, 'labelBasis'); const requestedVerification = enumValue(value.verificationStatus, ALLOWED_VERIFICATION, 'verificationStatus')
  const mode = options.mode || 'intake'
  if (mode === 'intake' && ((requestedBasis === 'manual_verified_primary' || requestedBasis === 'consumer_surface_observed') && requestedVerification === 'verified')) throw new Error('Manual intake cannot self-assert verified primary truth; owner review is required.')
  const intakeFingerprint = fingerprint({ ownerUserId, input: value })
  const observation: Omit<OutcomeObservation, 'ownerUserId' | 'observationFingerprint'> = {
    schemaVersion, intakeFingerprint, projectId: value.projectId === null || value.projectId === undefined ? null : boundedNonNegative(value.projectId, 'projectId', Number.MAX_SAFE_INTEGER), clientId: nullableString(value.clientId, 'clientId', 128), websiteIdentityHash: value.websiteIdentityHash as string, queryIdentityHash: value.queryIdentityHash as string, normalizedQueryHash: value.normalizedQueryHash as string, candidatePageIdentityHash: value.candidatePageIdentityHash as string, canonicalPageHash: value.canonicalPageHash as string, contentHash: value.contentHash as string, evidenceSnapshotHash: value.evidenceSnapshotHash as string, publicationReceiptFingerprint, engine: enumValue(value.engine, ALLOWED_ENGINES, 'engine'), model: boundedText(value.model, 160, 'model'), modelVersion: nullableString(value.modelVersion, 'modelVersion', 160), interface: enumValue(value.interface, ALLOWED_INTERFACES, 'interface'), locale: boundedText(value.locale, 32, 'locale'), region: nullableString(value.region, 'region', 64), runIdentity: boundedText(value.runIdentity, 160, 'runIdentity'), runTimestamp, observationWindow: { start, end }, observableStatus: enumValue(value.observableStatus, ALLOWED_OBSERVABLE, 'observableStatus'), retrievalStatus: enumValue(value.retrievalStatus, ALLOWED_RETRIEVAL, 'retrievalStatus'), citationStatus: enumValue(value.citationStatus, ALLOWED_CITATION, 'citationStatus'), citationPosition, mentionStatus: enumValue(value.mentionStatus, ['mentioned', 'not_mentioned', 'unknown'], 'mentionStatus'), recommendationStatus: enumValue(value.recommendationStatus, ['recommended', 'not_recommended', 'unknown'], 'recommendationStatus'), labelBasis: mode === 'intake' ? requestedBasis : requestedBasis, verificationStatus: mode === 'intake' ? 'unverified' : requestedVerification, consentStatus: options.consentStatus || 'unknown', piiStatus: options.piiStatus || 'unknown', verificationAuthority: mode === 'intake' ? 'intake' : options.verificationAuthority || 'none', reviewFingerprint: mode === 'intake' ? null : options.reviewFingerprint || null, candidateAuthorityFingerprint: mode === 'intake' ? null : options.candidateAuthorityFingerprint || null, candidateSetFingerprint: mode === 'intake' ? null : options.candidateSetFingerprint || null, evidenceLocatorHashes, appliedRuleHashes, contentFeatureVector: normalizeFeatures(value.contentFeatureVector),
  }
  if (observation.citationStatus === 'cited' && observation.citationPosition === null) throw new Error('Cited observations require citationPosition.')
  if (observation.citationStatus !== 'cited' && observation.citationPosition !== null) throw new Error('Only cited observations may have citationPosition.')
  const observationFingerprint = fingerprint(observationFingerprintPayload({ ...observation, ownerUserId }))
  return { ...observation, ownerUserId, observationFingerprint }
}

export function normalizeTrustedObservation(input: unknown, ownerUserId: number, governance: { consentStatus?: 'approved' | 'revoked' | 'unknown', piiStatus?: 'clean' | 'contains_pii' | 'unknown', reviewFingerprint?: string | null } = {}): OutcomeObservation { const candidateSetFingerprint = fingerprint({ input: input && typeof input === 'object' ? { runIdentity: (input as Record<string, unknown>).runIdentity, normalizedQueryHash: (input as Record<string, unknown>).normalizedQueryHash } : input, ownerUserId, trustedCandidateSet: true }); return normalizeManualObservation(input, ownerUserId, { mode: 'trusted_test', consentStatus: governance.consentStatus || 'approved', piiStatus: governance.piiStatus || 'clean', verificationAuthority: 'consumer_surface_server', reviewFingerprint: governance.reviewFingerprint || fingerprint({ input, ownerUserId, trusted: true }), candidateAuthorityFingerprint: fingerprint({ input, ownerUserId, trustedCandidate: true }), candidateSetFingerprint }) }

export function canBePrimaryCitationTruth(observation: OutcomeObservation): boolean {
  return (observation.labelBasis === 'manual_verified_primary' || observation.labelBasis === 'consumer_surface_observed') && observation.verificationStatus === 'verified' && observation.consentStatus === 'approved' && observation.piiStatus === 'clean' && (observation.verificationAuthority === 'owner_review' || observation.verificationAuthority === 'consumer_surface_server') && Boolean(observation.reviewFingerprint) && Boolean(observation.candidateAuthorityFingerprint) && Boolean(observation.candidateSetFingerprint) && observation.interface === 'consumer_surface' && observation.observableStatus === 'observable' && observation.retrievalStatus === 'retrieved' && observation.citationStatus !== 'unknown' && observation.evidenceLocatorHashes.length > 0
}
export function isVerifiedCitationObservation(observation: OutcomeObservation): boolean { return canBePrimaryCitationTruth(observation) }
export function isHardNegativeCandidate(candidate: OutcomeObservation, positive: OutcomeObservation): boolean {
  if (candidate.ownerUserId !== positive.ownerUserId || candidate.runIdentity !== positive.runIdentity || candidate.normalizedQueryHash !== positive.normalizedQueryHash || candidate.engine !== positive.engine || candidate.model !== positive.model || candidate.modelVersion !== positive.modelVersion || candidate.interface !== positive.interface || candidate.locale !== positive.locale || candidate.region !== positive.region || candidate.observationWindow.start !== positive.observationWindow.start || candidate.observationWindow.end !== positive.observationWindow.end) return false
  if (!canBePrimaryCitationTruth(candidate) || candidate.citationStatus !== 'not_cited' || candidate.observationFingerprint === positive.observationFingerprint || candidate.candidateSetFingerprint !== positive.candidateSetFingerprint) return false
  return true
}

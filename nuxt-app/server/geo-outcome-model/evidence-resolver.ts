import { resolveCandidateAuthority } from './candidate-authority'
import { fingerprint, isSha256 } from './canonical'
import type { GeoOutcomeDrizzleDatabase } from './repository-drizzle'
import type { AuthoritativeEvidenceSource, EvidenceBinding, OutcomeObservation } from './types'

export function authoritativeLocatorFingerprint(input: {
  sourceRecordId: number
  sourceProjectId: number
  sourceQueryId: number
  sourceRunId: number
  sourceResponseHash: string
  evidenceLocator: string
  sourceObservedAt: string
}): string {
  return fingerprint({ sourceKind: 'llm_visibility_observation', ...input })
}

function canonicalTimestamp(value: Date | string): string {
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) throw new Error('Authoritative evidence has an invalid observedAt timestamp.')
  return date.toISOString()
}

/**
 * Resolve a hash-only primary-evidence projection from existing owner-scoped
 * LLM Visibility facts. Caller bodies never provide authority flags, hashes,
 * locators, project/query/run provenance, or observed timestamps.
 */
export async function resolveAuthoritativeLlmVisibilityEvidence(
  database: GeoOutcomeDrizzleDatabase,
  ownerUserId: number,
  observation: OutcomeObservation,
  sourceRecordId: number,
): Promise<EvidenceBinding> {
  if (!Number.isSafeInteger(sourceRecordId) || sourceRecordId <= 0) throw new Error('Authoritative sourceRecordId must be a positive integer.')
  const { authority, source: resolved } = await resolveCandidateAuthority(database, ownerUserId, sourceRecordId, observation.candidatePageIdentityHash)
  const { source, project, query, run, citations, sourceCitationSetFingerprint } = resolved
  if (project.locale !== query.locale) throw new Error('Authoritative evidence project/query locale provenance mismatch.')
  const citationIndex = citations.findIndex(item => item.canonicalCandidateUrlHash === authority.canonicalCandidateUrlHash)
  const serverDerivedCitationStatus = citationIndex >= 0 ? 'cited' : 'not_cited'
  const serverDerivedCitationPosition = citationIndex >= 0 ? citationIndex + 1 : null
  return projectAuthoritativeEvidenceBinding(ownerUserId, observation, {
    sourceRecordId: source.id,
    ownerUserId: source.ownerUserId,
    projectId: project.id,
    queryId: query.id,
    runId: run.id,
    projectStatus: project.status,
    queryActive: query.active,
    observationMode: run.observationMode,
    runStatus: run.status,
    verifiedByOwner: true,
    provider: run.provider,
    modelLabel: run.modelLabel,
    locale: query.locale,
    requestFingerprint: run.requestFingerprint,
    promptHash: query.promptHash,
    responseHash: source.responseHash,
    sourceCitationSetFingerprint,
    evidenceLocator: source.evidenceLocator,
    observedAt: canonicalTimestamp(run.observedAt),
    canonicalCandidateUrlHash: authority.canonicalCandidateUrlHash,
    canonicalPageHash: authority.canonicalPageHash,
    candidatePageIdentityHash: authority.candidatePageIdentityHash,
    websiteIdentityHash: authority.websiteIdentityHash,
    contentHash: authority.contentHash,
    publicationReceiptFingerprint: authority.publicationReceiptFingerprint,
    candidateAuthorityId: authority.id,
    candidateAuthorityFingerprint: authority.decisionFingerprint,
    candidateSetFingerprint: authority.candidateSetFingerprint,
    serverDerivedCitationStatus,
    serverDerivedCitationPosition,
  })
}

export function projectAuthoritativeEvidenceBinding(ownerUserId: number, observation: OutcomeObservation, source: AuthoritativeEvidenceSource): EvidenceBinding {
  if (source.ownerUserId !== ownerUserId) throw new Error('Authoritative LLM visibility evidence was not found for this owner.')
  if (source.projectStatus !== 'active' || !source.queryActive) throw new Error('Authoritative evidence project or query is stale.')
  if (source.observationMode !== 'manual_verified' || source.runStatus !== 'completed' || source.verifiedByOwner !== true) throw new Error('Only completed, durably reviewed manual consumer-surface evidence may bind primary outcomes.')
  if (!isSha256(source.responseHash) || !isSha256(source.requestFingerprint) || !isSha256(source.promptHash) || typeof source.evidenceLocator !== 'string' || source.evidenceLocator.length < 1 || source.evidenceLocator.length > 1000) throw new Error('Authoritative evidence hash or locator is incomplete.')
  const observedAt = canonicalTimestamp(source.observedAt)
  const locatorHash = authoritativeLocatorFingerprint({ sourceRecordId: source.sourceRecordId, sourceProjectId: source.projectId, sourceQueryId: source.queryId, sourceRunId: source.runId, sourceResponseHash: source.responseHash, evidenceLocator: source.evidenceLocator, sourceObservedAt: observedAt })
  const exactIdentity = observation.ownerUserId === ownerUserId
    && observation.projectId === source.projectId
    && observation.queryIdentityHash === source.promptHash
    && observation.normalizedQueryHash === source.promptHash
    && observation.runIdentity === source.requestFingerprint
    && observation.evidenceSnapshotHash === source.responseHash
    && observation.evidenceLocatorHashes.includes(locatorHash)
    && observation.runTimestamp === observedAt
    && observation.engine === source.provider
    && observation.model === source.modelLabel
    && observation.locale === source.locale
    && observation.interface === 'consumer_surface'
    && (observation.labelBasis === 'manual_verified_primary' || observation.labelBasis === 'consumer_surface_observed')
    && source.candidatePageIdentityHash === observation.candidatePageIdentityHash
    && source.canonicalPageHash === observation.canonicalPageHash
    && source.websiteIdentityHash === observation.websiteIdentityHash
    && source.contentHash === observation.contentHash
    && (source.publicationReceiptFingerprint || null) === observation.publicationReceiptFingerprint
    && source.serverDerivedCitationStatus === observation.citationStatus
    && source.serverDerivedCitationPosition === observation.citationPosition
    && observation.observableStatus === 'observable'
    && observation.retrievalStatus === 'retrieved'
  if (!exactIdentity) throw new Error('Authoritative evidence does not match the GEO observation owner/project/query/run/hash/locator identity.')
  const observedTime = Date.parse(observedAt)
  if (observedTime < Date.parse(observation.observationWindow.start) || observedTime > Date.parse(observation.observationWindow.end)) throw new Error('Authoritative evidence observedAt is outside the GEO observation window.')
  const binding = {
    ownerUserId,
    observationFingerprint: observation.observationFingerprint,
    evidenceLocatorHash: locatorHash,
    purpose: 'geo_outcome_verification' as const,
    sourceKind: 'llm_visibility_observation' as const,
    sourceRecordId: source.sourceRecordId,
    sourceProjectId: source.projectId,
    sourceQueryId: source.queryId,
    sourceRunId: source.runId,
    sourceResponseHash: source.responseHash,
    sourceCitationSetFingerprint: source.sourceCitationSetFingerprint!,
    candidateAuthorityId: source.candidateAuthorityId!,
    candidateAuthorityFingerprint: source.candidateAuthorityFingerprint!,
    candidateSetFingerprint: source.candidateSetFingerprint!,
    canonicalCandidateUrlHash: source.canonicalCandidateUrlHash!,
    serverDerivedCitationStatus: source.serverDerivedCitationStatus!,
    serverDerivedCitationPosition: source.serverDerivedCitationPosition ?? null,
    sourceObservedAt: observedAt,
    createdAt: new Date().toISOString(),
  }
  return { ...binding, evidenceBindingFingerprint: fingerprint({ ...binding, createdAt: undefined }) }
}

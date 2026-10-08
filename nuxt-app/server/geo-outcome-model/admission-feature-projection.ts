import { and, eq } from 'drizzle-orm'
import { contentOperationPublicationAttempts } from '../database/schema'
import { createContentOperationsRepositoryFromDatabase, type WorkspaceEntryLineage } from '../content-operations/repository'
import { assertPublicHttpsUrl } from '../content-operations/normalization'
import { contentFingerprint } from '../seo-geo-core/riskGate'
import { scanOutcomeLearningPii } from '../outcome-learning/content-learning-runtime'
import { sha256Hex } from './canonical'
import type { resolveCandidateAuthority } from './candidate-authority'
import type { GeoOutcomeDrizzleDatabase } from './repository-drizzle'
import type { ContentFeatureInput } from './types'
import type { AdmissionFeatureOrigin } from './admission-types'

type ResolvedCandidate = Awaited<ReturnType<typeof resolveCandidateAuthority>>
type Publication = Pick<typeof contentOperationPublicationAttempts.$inferSelect, 'ownerUserId' | 'clientId' | 'entryId' | 'receiptFingerprint' | 'mode' | 'status' | 'contentHash' | 'publicationContentHash' | 'publicationUrl' | 'evidenceSnapshotHash' | 'completedAt'>
export type AdmissionFeatureProjection = { features: ContentFeatureInput; featureOrigin: AdmissionFeatureOrigin }

export function unknownAdmissionFeatures(locale: string): ContentFeatureInput {
  return { contentType: 'other', locale, pageAgeBucket: 'unknown', contentLengthBucket: 'unknown', headingHierarchy: 'unknown', directAnswerPresence: 'unknown', faqStructure: 'unknown', structuredDataPresence: 'unknown', citationMarkerCount: null, approvedAuthoritySourceCount: null, evidenceUtilizationRatio: null, entityCoverage: null, selectedAutoGeoRuleHashes: [], appliedAutoGeoRuleHashes: [], canonicalFlag: 'unknown', indexabilityFlag: 'unknown', internalLinkDepthBucket: 'unknown', contentFreshnessBucket: 'unknown', queryPageLexicalOverlap: null, topicClusterEqual: 'unknown', verifiedPublicationAgeDays: null, priorObservationCount: null }
}

/** Only a currently server-readable, hash-exact published draft can supply structural features. */
export function projectExactAdmissionFeatures(ownerUserId: number, resolved: ResolvedCandidate, publication: Publication | null, lineage: WorkspaceEntryLineage | null): AdmissionFeatureProjection {
  const fallback = { features: unknownAdmissionFeatures(resolved.source.query.locale), featureOrigin: 'unknown_external' as const }
  const authority = resolved.authority
  if (!Number.isSafeInteger(ownerUserId) || ownerUserId <= 0 || !publication || !lineage || !authority.publicationReceiptFingerprint) return fallback
  const draft = lineage.draft
  const observedAt = new Date(resolved.source.run.observedAt).getTime()
  const completedAt = publication.completedAt ? new Date(publication.completedAt).getTime() : NaN
  if (publication.ownerUserId !== ownerUserId || publication.mode !== 'execute' || publication.status !== 'delivered'
    || publication.receiptFingerprint !== authority.publicationReceiptFingerprint || publication.contentHash !== authority.contentHash
    || publication.publicationContentHash !== authority.contentHash || publication.evidenceSnapshotHash !== authority.publicationEvidenceSnapshotHash
    || !Number.isFinite(completedAt) || !Number.isFinite(observedAt) || completedAt > observedAt
    || lineage.entry.ownerUserId !== ownerUserId || lineage.entry.id !== publication.entryId
    || lineage.client.ownerUserId !== ownerUserId || lineage.client.id !== publication.clientId
    || lineage.entry.contentHash !== authority.contentHash || lineage.entry.evidenceSnapshotHash !== publication.evidenceSnapshotHash
    || !lineage.job || lineage.job.ownerUserId !== ownerUserId || !draft || draft.jobId !== lineage.job.id
    || lineage.entry.draftId !== draft.id || draft.contentHash !== authority.contentHash || draft.safetyStatus !== 'passed'
    || typeof draft.title !== 'string' || typeof draft.body !== 'string' || !draft.title || !draft.body
    || draft.title.length > 500 || draft.body.length > 256 * 1024 || Buffer.byteLength(draft.body, 'utf8') > 256 * 1024
    || contentFingerprint(draft.title, draft.body) !== authority.contentHash
    || scanOutcomeLearningPii({ title: draft.title, body: draft.body }).status !== 'none_detected') return fallback
  try {
    if (!publication.publicationUrl || sha256Hex(assertPublicHttpsUrl(publication.publicationUrl)) !== authority.canonicalCandidateUrlHash) return fallback
  } catch { return fallback }
  const headings = [...draft.body.matchAll(/^#{1,6}\s+/gm)].map(match => match[0].trim().length)
  return {
    featureOrigin: 'exact_publication_draft',
    features: {
      ...fallback.features,
      contentType: lineage.entry.contentType === 'article' || lineage.entry.contentType === 'faq' ? lineage.entry.contentType : 'other',
      contentLengthBucket: draft.body.length < 500 ? 'xs' : draft.body.length < 2000 ? 's' : draft.body.length < 6000 ? 'm' : draft.body.length < 12000 ? 'l' : 'xl',
      headingHierarchy: !headings.length ? 'none' : new Set(headings).size > 1 ? 'structured' : 'flat',
      citationMarkerCount: Math.min(1000, [...draft.body.matchAll(/\[cite:[^\]]+\]/g)].length),
    },
  }
}

export async function getAdmissionFeatureProjection(database: GeoOutcomeDrizzleDatabase, ownerUserId: number, resolved: ResolvedCandidate): Promise<AdmissionFeatureProjection> {
  const fallback = { features: unknownAdmissionFeatures(resolved.source.query.locale), featureOrigin: 'unknown_external' as const }
  const receipt = resolved.authority.publicationReceiptFingerprint
  if (!receipt) return fallback
  const attempts = await database.select({ ownerUserId: contentOperationPublicationAttempts.ownerUserId, clientId: contentOperationPublicationAttempts.clientId, entryId: contentOperationPublicationAttempts.entryId, receiptFingerprint: contentOperationPublicationAttempts.receiptFingerprint, mode: contentOperationPublicationAttempts.mode, status: contentOperationPublicationAttempts.status, contentHash: contentOperationPublicationAttempts.contentHash, publicationContentHash: contentOperationPublicationAttempts.publicationContentHash, publicationUrl: contentOperationPublicationAttempts.publicationUrl, evidenceSnapshotHash: contentOperationPublicationAttempts.evidenceSnapshotHash, completedAt: contentOperationPublicationAttempts.completedAt })
    .from(contentOperationPublicationAttempts).where(and(eq(contentOperationPublicationAttempts.ownerUserId, ownerUserId), eq(contentOperationPublicationAttempts.receiptFingerprint, receipt))).limit(2)
  if (attempts.length !== 1) return fallback
  const publication = attempts[0]!
  const lineage = await createContentOperationsRepositoryFromDatabase(database).resolveWorkspaceEntry(ownerUserId, publication.entryId)
  return projectExactAdmissionFeatures(ownerUserId, resolved, publication, lineage)
}

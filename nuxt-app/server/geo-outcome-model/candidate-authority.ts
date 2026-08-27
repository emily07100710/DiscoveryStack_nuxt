import { and, eq } from 'drizzle-orm'
import { z } from 'zod'
import { assertPublicHttpsUrl } from '../content-operations/normalization'
import {
  contentOperationPublicationAttempts,
  geoOutcomeCandidateAuthorities,
  geoOutcomeCandidateSetDecisions,
  llmVisibilityObservationReviews,
  llmVisibilityObservations,
  llmVisibilityProjects,
  llmVisibilityQueries,
  llmVisibilityRuns,
} from '../database/schema'
import { fingerprint, isSha256, sha256Hex } from './canonical'
import type { GeoOutcomeDrizzleDatabase } from './repository-drizzle'

const hash = z.string().trim().regex(/^[a-f0-9]{64}$/iu).transform(value => value.toLowerCase())
const candidate = z.object({ candidateUrl: z.string().trim().min(1).max(2048), contentHash: hash, publicationReceiptFingerprint: hash.nullish() }).strict()
export const candidateSetReviewSchema = z.discriminatedUnion('decision', [
  z.object({ idempotencyKey: z.string().trim().min(1).max(128), sourceRecordId: z.number().int().positive(), decision: z.literal('approve'), reason: z.string().trim().min(1).max(500), candidates: z.array(candidate).min(1).max(100) }).strict(),
  z.object({ idempotencyKey: z.string().trim().min(1).max(128), sourceRecordId: z.number().int().positive(), decision: z.literal('revoke'), reason: z.string().trim().min(1).max(500), candidateSetFingerprint: hash }).strict(),
])
export type CandidateSetReviewInput = z.infer<typeof candidateSetReviewSchema>

export interface CanonicalCandidateIdentity {
  canonicalUrl: string
  canonicalCandidateUrlHash: string
  canonicalPageHash: string
  candidatePageIdentityHash: string
  websiteIdentityHash: string
}

export function canonicalCandidateIdentity(candidateUrl: string): CanonicalCandidateIdentity {
  const canonicalUrl = assertPublicHttpsUrl(candidateUrl, 'Candidate URL')
  const hostname = new URL(canonicalUrl).hostname
  return {
    canonicalUrl,
    canonicalCandidateUrlHash: sha256Hex(canonicalUrl),
    canonicalPageHash: sha256Hex(canonicalUrl),
    candidatePageIdentityHash: fingerprint({ canonicalCandidateUrl: canonicalUrl }),
    websiteIdentityHash: sha256Hex(hostname),
  }
}

export function canonicalCitationUrlSet(value: unknown): CanonicalCandidateIdentity[] {
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) throw new Error('Authoritative citationUrls are malformed.')
  const canonical = value.map(item => canonicalCandidateIdentity(item))
  if (new Set(canonical.map(item => item.canonicalCandidateUrlHash)).size !== canonical.length) throw new Error('Authoritative citationUrls contain duplicate canonical URLs.')
  return canonical
}

async function approvedManualReview(database: GeoOutcomeDrizzleDatabase, ownerUserId: number, sourceRecordId: number, sourceResponseHash: string) {
  const reviews = await database.select().from(llmVisibilityObservationReviews).where(and(eq(llmVisibilityObservationReviews.ownerUserId, ownerUserId), eq(llmVisibilityObservationReviews.observationId, sourceRecordId)))
  for (const row of reviews) {
    const expected = fingerprint({ ownerUserId: row.ownerUserId, reviewerUserId: row.reviewerUserId, observationId: row.observationId, previousStatus: row.previousStatus, newStatus: row.newStatus, reason: row.reason, sourceResponseHash: row.sourceResponseHash })
    if (row.sourceResponseHash !== sourceResponseHash || row.decisionFingerprint !== expected) throw new Error('Manual snapshot review lineage is stale or corrupt.')
  }
  if (!reviews.some(row => row.newStatus === 'approved') || reviews.some(row => row.newStatus === 'revoked')) throw new Error('Manual snapshot lacks a current durable owner approval.')
}

async function sourceProjection(database: GeoOutcomeDrizzleDatabase, ownerUserId: number, sourceRecordId: number) {
  const [source] = await database.select().from(llmVisibilityObservations).where(and(eq(llmVisibilityObservations.id, sourceRecordId), eq(llmVisibilityObservations.ownerUserId, ownerUserId))).limit(1)
  if (!source) throw new Error('Authoritative LLM visibility source was not found for this owner.')
  const [[project], [query], [run]] = await Promise.all([
    database.select().from(llmVisibilityProjects).where(and(eq(llmVisibilityProjects.id, source.projectId), eq(llmVisibilityProjects.ownerUserId, ownerUserId))).limit(1),
    database.select().from(llmVisibilityQueries).where(and(eq(llmVisibilityQueries.id, source.queryId), eq(llmVisibilityQueries.ownerUserId, ownerUserId))).limit(1),
    database.select().from(llmVisibilityRuns).where(and(eq(llmVisibilityRuns.id, source.runId), eq(llmVisibilityRuns.ownerUserId, ownerUserId))).limit(1),
  ])
  if (!project || !query || !run || project.status !== 'active' || !query.active || source.projectId !== query.projectId || source.projectId !== run.projectId || source.queryId !== query.id || source.runId !== run.id) throw new Error('Authoritative source owner/project/query/run provenance is stale or mismatched.')
  if (run.observationMode !== 'manual_verified' || run.status !== 'completed') throw new Error('Provider or incomplete source is secondary-only and cannot authorize candidates.')
  if (!isSha256(source.responseHash) || !isSha256(run.requestFingerprint) || !isSha256(query.promptHash)) throw new Error('Authoritative source hashes are incomplete.')
  const citations = canonicalCitationUrlSet(source.citationUrls)
  const sourceCitationSetFingerprint = fingerprint(citations.map(item => item.canonicalCandidateUrlHash))
  await approvedManualReview(database, ownerUserId, sourceRecordId, source.responseHash)
  return { source, project, query, run, citations, sourceCitationSetFingerprint, observedAt: new Date(run.observedAt) }
}

async function publicationAuthority(database: GeoOutcomeDrizzleDatabase, ownerUserId: number, candidateUrl: string, contentHash: string, receiptFingerprint: string | null | undefined, sourceObservedAt: Date) {
  if (!receiptFingerprint) return { authorityBasis: 'manual_owner_attested_v1' as const, publicationEvidenceSnapshotHash: null }
  const [attempt] = await database.select().from(contentOperationPublicationAttempts).where(and(eq(contentOperationPublicationAttempts.ownerUserId, ownerUserId), eq(contentOperationPublicationAttempts.receiptFingerprint, receiptFingerprint))).limit(1)
  if (!attempt || attempt.mode !== 'execute' || attempt.status !== 'delivered' || !attempt.publicationUrl || !attempt.publicationContentHash || !attempt.completedAt) throw new Error('Publication receipt is not a delivered owner-scoped execute attempt.')
  if (assertPublicHttpsUrl(attempt.publicationUrl, 'Publication URL') !== candidateUrl) throw new Error('Publication receipt URL does not exactly match the canonical candidate URL.')
  if (attempt.publicationContentHash !== contentHash || attempt.contentHash !== contentHash || !isSha256(attempt.evidenceSnapshotHash)) throw new Error('Publication receipt content/evidence lineage mismatch.')
  if (new Date(attempt.completedAt).getTime() > sourceObservedAt.getTime()) throw new Error('Publication occurred after the authoritative LLM observation.')
  return { authorityBasis: 'discovery_stack_publication_receipt_v1' as const, publicationEvidenceSnapshotHash: attempt.evidenceSnapshotHash }
}

export interface CandidateSetReviewResult {
  decisionId: string
  decision: 'approve' | 'revoke'
  candidateSetFingerprint: string
  memberCount: number
  decisionFingerprint: string
  createdAt: string
}

/** Owner-only service boundary. URLs are canonicalized and every authority hash is server-derived. */
export async function reviewCandidateSet(database: GeoOutcomeDrizzleDatabase, ownerUserId: number, reviewerUserId: number, input: CandidateSetReviewInput): Promise<CandidateSetReviewResult> {
  if (ownerUserId !== reviewerUserId) throw new Error('Candidate review owner/reviewer scope mismatch.')
  return database.transaction(async transaction => {
    const source = await sourceProjection(transaction, ownerUserId, input.sourceRecordId)
    const inputFingerprint = fingerprint({ ownerUserId, reviewerUserId, input })
    const [replay] = await transaction.select().from(geoOutcomeCandidateSetDecisions).where(and(eq(geoOutcomeCandidateSetDecisions.ownerUserId, ownerUserId), eq(geoOutcomeCandidateSetDecisions.idempotencyKey, input.idempotencyKey))).limit(1)
    if (replay) {
      if (replay.inputFingerprint !== inputFingerprint) throw new Error('Candidate review idempotency collision.')
      const members = await transaction.select().from(geoOutcomeCandidateAuthorities).where(eq(geoOutcomeCandidateAuthorities.candidateSetDecisionId, replay.id))
      return { decisionId: replay.decisionId, decision: replay.decisionType, candidateSetFingerprint: replay.candidateSetFingerprint, memberCount: members.length, decisionFingerprint: replay.decisionFingerprint, createdAt: new Date(replay.createdAt).toISOString() }
    }

    if (input.decision === 'revoke') {
      const approvals = await transaction.select().from(geoOutcomeCandidateSetDecisions).where(and(eq(geoOutcomeCandidateSetDecisions.ownerUserId, ownerUserId), eq(geoOutcomeCandidateSetDecisions.sourceObservationId, input.sourceRecordId), eq(geoOutcomeCandidateSetDecisions.candidateSetFingerprint, input.candidateSetFingerprint)))
      if (!approvals.some(row => row.decisionType === 'approve') || approvals.some(row => row.decisionType === 'revoke')) throw new Error('Candidate set is missing, already revoked, or terminal.')
      const createdAt = new Date()
      const decisionFingerprint = fingerprint({ ownerUserId, reviewerUserId, sourceRecordId: input.sourceRecordId, decision: 'revoke', candidateSetFingerprint: input.candidateSetFingerprint, reason: input.reason, sourceResponseHash: source.source.responseHash })
      const decisionId = `geo-candidate-review-${decisionFingerprint.slice(0, 20)}`
      await transaction.insert(geoOutcomeCandidateSetDecisions).values({ decisionId, ownerUserId, sourceObservationId: input.sourceRecordId, sourceProjectId: source.project.id, sourceQueryId: source.query.id, sourceRunId: source.run.id, sourceCitationSetFingerprint: source.sourceCitationSetFingerprint, reviewerUserId, idempotencyKey: input.idempotencyKey, inputFingerprint, decisionType: 'revoke', candidateSetFingerprint: input.candidateSetFingerprint, targetCandidateSetFingerprint: input.candidateSetFingerprint, reviewReason: input.reason, decisionFingerprint, createdAt })
      return { decisionId, decision: 'revoke', candidateSetFingerprint: input.candidateSetFingerprint, memberCount: 0, decisionFingerprint, createdAt: createdAt.toISOString() }
    }

    const members = await Promise.all(input.candidates.map(async item => {
      const identity = canonicalCandidateIdentity(item.candidateUrl)
      const publication = await publicationAuthority(transaction, ownerUserId, identity.canonicalUrl, item.contentHash, item.publicationReceiptFingerprint, source.observedAt)
      return { ...identity, contentHash: item.contentHash, publicationReceiptFingerprint: item.publicationReceiptFingerprint || null, ...publication }
    }))
    if (new Set(members.map(item => item.canonicalCandidateUrlHash)).size !== members.length || new Set(members.map(item => item.candidatePageIdentityHash)).size !== members.length) throw new Error('Candidate set contains duplicate canonical URL or candidate identity.')
    const ordered = [...members].sort((a, b) => a.canonicalCandidateUrlHash < b.canonicalCandidateUrlHash ? -1 : a.canonicalCandidateUrlHash > b.canonicalCandidateUrlHash ? 1 : 0)
    const candidateSetFingerprint = fingerprint({ ownerUserId, sourceObservationId: input.sourceRecordId, projectId: source.project.id, queryId: source.query.id, runId: source.run.id, sourceResponseHash: source.source.responseHash, sourceCitationSetFingerprint: source.sourceCitationSetFingerprint, candidates: ordered.map(({ canonicalUrl: _canonicalUrl, ...member }) => member) })
    const existing = await transaction.select().from(geoOutcomeCandidateSetDecisions).where(and(eq(geoOutcomeCandidateSetDecisions.ownerUserId, ownerUserId), eq(geoOutcomeCandidateSetDecisions.sourceObservationId, input.sourceRecordId), eq(geoOutcomeCandidateSetDecisions.candidateSetFingerprint, candidateSetFingerprint)))
    if (existing.length) throw new Error('Candidate set already has a decision under a different mutation identity.')
    const createdAt = new Date()
    const decisionFingerprint = fingerprint({ ownerUserId, reviewerUserId, sourceRecordId: input.sourceRecordId, decision: 'approve', candidateSetFingerprint, reason: input.reason, sourceResponseHash: source.source.responseHash })
    const decisionId = `geo-candidate-review-${decisionFingerprint.slice(0, 20)}`
    const inserted = await transaction.insert(geoOutcomeCandidateSetDecisions).values({ decisionId, ownerUserId, sourceObservationId: input.sourceRecordId, sourceProjectId: source.project.id, sourceQueryId: source.query.id, sourceRunId: source.run.id, sourceCitationSetFingerprint: source.sourceCitationSetFingerprint, reviewerUserId, idempotencyKey: input.idempotencyKey, inputFingerprint, decisionType: 'approve', candidateSetFingerprint, targetCandidateSetFingerprint: null, reviewReason: input.reason, decisionFingerprint, createdAt })
    const setDecisionId = Number(inserted[0].insertId)
    for (const member of ordered) {
      const memberDecisionFingerprint = fingerprint({ decisionFingerprint, candidateSetFingerprint, canonicalCandidateUrlHash: member.canonicalCandidateUrlHash, candidatePageIdentityHash: member.candidatePageIdentityHash, contentHash: member.contentHash, publicationReceiptFingerprint: member.publicationReceiptFingerprint })
      await transaction.insert(geoOutcomeCandidateAuthorities).values({ ownerUserId, candidateSetDecisionId: setDecisionId, sourceObservationId: input.sourceRecordId, projectId: source.project.id, queryId: source.query.id, runId: source.run.id, canonicalCandidateUrlHash: member.canonicalCandidateUrlHash, canonicalPageHash: member.canonicalPageHash, candidatePageIdentityHash: member.candidatePageIdentityHash, websiteIdentityHash: member.websiteIdentityHash, contentHash: member.contentHash, publicationReceiptFingerprint: member.publicationReceiptFingerprint, publicationEvidenceSnapshotHash: member.publicationEvidenceSnapshotHash, authorityBasis: member.authorityBasis, observabilityReviewStatus: 'approved_observable', retrievalReviewStatus: 'approved_retrieved', reviewerUserId, reviewReason: input.reason, reviewedAt: createdAt, decisionFingerprint: memberDecisionFingerprint, candidateSetFingerprint, createdAt })
    }
    return { decisionId, decision: 'approve', candidateSetFingerprint, memberCount: ordered.length, decisionFingerprint, createdAt: createdAt.toISOString() }
  })
}

export async function resolveCandidateAuthority(database: GeoOutcomeDrizzleDatabase, ownerUserId: number, sourceRecordId: number, candidatePageIdentityHash: string) {
  const source = await sourceProjection(database, ownerUserId, sourceRecordId)
  const authorities = await database.select().from(geoOutcomeCandidateAuthorities).where(and(eq(geoOutcomeCandidateAuthorities.ownerUserId, ownerUserId), eq(geoOutcomeCandidateAuthorities.sourceObservationId, sourceRecordId), eq(geoOutcomeCandidateAuthorities.candidatePageIdentityHash, candidatePageIdentityHash)))
  if (authorities.length !== 1) throw new Error('Candidate is absent from one unambiguous approved observable candidate set.')
  const authority = authorities[0]!
  const decisions = await database.select().from(geoOutcomeCandidateSetDecisions).where(and(eq(geoOutcomeCandidateSetDecisions.ownerUserId, ownerUserId), eq(geoOutcomeCandidateSetDecisions.sourceObservationId, sourceRecordId), eq(geoOutcomeCandidateSetDecisions.candidateSetFingerprint, authority.candidateSetFingerprint)))
  if (!decisions.some(row => row.decisionType === 'approve') || decisions.some(row => row.decisionType === 'revoke') || decisions.some(row => row.sourceProjectId !== source.project.id || row.sourceQueryId !== source.query.id || row.sourceRunId !== source.run.id || row.sourceCitationSetFingerprint !== source.sourceCitationSetFingerprint)) throw new Error('Candidate authority is stale or terminally revoked.')
  if (authority.projectId !== source.project.id || authority.queryId !== source.query.id || authority.runId !== source.run.id || authority.observabilityReviewStatus !== 'approved_observable' || authority.retrievalReviewStatus !== 'approved_retrieved') throw new Error('Candidate authority provenance is stale or mismatched.')
  if (authority.publicationReceiptFingerprint) {
    const [attempt] = await database.select().from(contentOperationPublicationAttempts).where(and(eq(contentOperationPublicationAttempts.ownerUserId, ownerUserId), eq(contentOperationPublicationAttempts.receiptFingerprint, authority.publicationReceiptFingerprint))).limit(1)
    if (!attempt || attempt.mode !== 'execute' || attempt.status !== 'delivered' || attempt.publicationContentHash !== authority.contentHash || attempt.contentHash !== authority.contentHash || attempt.evidenceSnapshotHash !== authority.publicationEvidenceSnapshotHash || !attempt.publicationUrl || sha256Hex(assertPublicHttpsUrl(attempt.publicationUrl, 'Publication URL')) !== authority.canonicalCandidateUrlHash || !attempt.completedAt || new Date(attempt.completedAt).getTime() > source.observedAt.getTime()) throw new Error('Publication authority lineage is stale or invalid.')
  }
  return { authority, source }
}

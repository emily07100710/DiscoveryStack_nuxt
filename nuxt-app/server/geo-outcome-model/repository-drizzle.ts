import { and, asc, eq, sql } from 'drizzle-orm'
import { getDatabase } from '../database'
import {
  geoOutcomeDatasetManifests,
  geoOutcomeDatasetMembers,
  geoOutcomeDatasetDecisions,
  geoOutcomeEvidenceLocators,
  geoOutcomeIdempotencyClaims,
  geoOutcomeModelArtifacts,
  geoOutcomeModelDecisions,
  geoOutcomeObservationCandidates,
  geoOutcomeObservationRuns,
  geoOutcomeObservationVerifications,
  geoOutcomeTrainingRuns,
  type GeoOutcomeDatasetManifest,
  type GeoOutcomeDatasetMember,
  type GeoOutcomeDatasetDecision,
  type GeoOutcomeModelArtifact,
  type GeoOutcomeModelDecision,
  type GeoOutcomeObservationCandidate,
  type GeoOutcomeObservationRun,
  type GeoOutcomeObservationVerification,
  type GeoOutcomeTrainingRun,
} from '../database/schema'
import { canonicalJson, fingerprint, isSha256, sha256Hex } from './canonical'
import { assertObservationIsUsable } from './observation-contract'
import { deriveFeatureVector } from './feature-catalog'
import { getDatasetReadiness } from './dataset-builder'
import { normalizeManualObservation } from './normalization'
import { parseTrainingConfig } from './trainer'
import { splitFingerprint } from './split-policy'
import { resolveAuthoritativeLlmVisibilityEvidence } from './evidence-resolver'
import type {
  DatasetDecision,
  DatasetManifest,
  DatasetMember,
  DatasetReadiness,
  EvidenceBinding,
  EvaluationBundle,
  FeatureVector,
  GeoOutcomeRepositoryPort,
  ModelArtifact,
  ModelDecision,
  MutationClaim,
  MutationClaimResult,
  ObservationGovernanceAction,
  ObservationVerificationDecision,
  OutcomeObservation,
  TrainingRun,
  TrainingRunClaimResult,
} from './types'

type AppDatabase = NonNullable<ReturnType<typeof getDatabase>>
type AppTransaction = Parameters<Parameters<AppDatabase['transaction']>[0]>[0]
export type GeoOutcomeDrizzleDatabase = AppDatabase | AppTransaction

const SPLITS = ['train', 'validation', 'test', 'siteHoldout', 'queryHoldout', 'temporalHoldout'] as const
type DomainSplit = typeof SPLITS[number]

function toIso(value: Date | string | null | undefined): string | null {
  if (value === null || value === undefined) return null
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) throw new Error('Corrupt durable timestamp.')
  return date.toISOString()
}
function affectedRows(result: unknown): number {
  const first = Array.isArray(result) ? result[0] : result
  if (!first || typeof first !== 'object' || !('affectedRows' in first) || typeof first.affectedRows !== 'number') throw new Error('Database did not return an affected-row count.')
  return first.affectedRows
}
function stringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) throw new Error(`Corrupt durable ${label}.`)
  const result = [...value] as string[]
  if (new Set(result).size !== result.length) throw new Error(`Corrupt durable ${label}: duplicates are forbidden.`)
  return result
}
function numberArray(value: unknown, label: string): number[] {
  if (!Array.isArray(value) || value.some(item => typeof item !== 'number' || !Number.isFinite(item))) throw new Error(`Corrupt durable ${label}.`)
  return [...value] as number[]
}
function numberRecord(value: unknown, label: string): Record<string, number> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Corrupt durable ${label}.`)
  const record = value as Record<string, unknown>
  for (const [key, item] of Object.entries(record)) if (!key || typeof item !== 'number' || !Number.isSafeInteger(item) || item < 0) throw new Error(`Corrupt durable ${label}.`)
  return record as Record<string, number>
}
function readiness(value: unknown): DatasetReadiness {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Corrupt durable dataset readiness.')
  const row = value as Record<string, unknown>
  if (typeof row.ready !== 'boolean' || !['ready', 'insufficient_data', 'gate_blocked'].includes(String(row.status))) throw new Error('Corrupt durable dataset readiness.')
  return { ready: row.ready, status: row.status as DatasetReadiness['status'], missing: stringArray(row.missing, 'dataset readiness missing reasons') }
}
function featureVector(value: unknown): FeatureVector {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Corrupt durable feature vector.')
  const row = value as Record<string, unknown>
  if (typeof row.catalogVersion !== 'string' || !Array.isArray(row.values)) throw new Error('Corrupt durable feature vector.')
  for (const item of row.values) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('Corrupt durable feature vector.')
    const feature = item as Record<string, unknown>
    if (typeof feature.key !== 'string' || typeof feature.value !== 'number' || !Number.isFinite(feature.value) || typeof feature.missing !== 'boolean') throw new Error('Corrupt durable feature vector.')
  }
  return row as unknown as FeatureVector
}
function evaluationBundle(value: unknown): EvaluationBundle {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Corrupt durable evaluation metrics.')
  const required = ['validation', 'test', 'siteHoldout', 'queryHoldout', 'temporalHoldout', 'rankingValidation', 'rankingTest', 'rankingTemporalHoldout', 'evaluationScope']
  const row = value as Record<string, unknown>
  if (required.some(key => !(key in row))) throw new Error('Corrupt durable evaluation metrics.')
  return row as unknown as EvaluationBundle
}
function splitKeyToDb(key: DomainSplit): 'train' | 'validation' | 'test' | 'site_holdout' | 'query_holdout' | 'temporal_holdout' {
  return key === 'siteHoldout' ? 'site_holdout' : key === 'queryHoldout' ? 'query_holdout' : key === 'temporalHoldout' ? 'temporal_holdout' : key
}
function splitKeyToDomain(key: string): DomainSplit {
  const value = key === 'site_holdout' ? 'siteHoldout' : key === 'query_holdout' ? 'queryHoldout' : key === 'temporal_holdout' ? 'temporalHoldout' : key
  if (!SPLITS.includes(value as DomainSplit)) throw new Error('Corrupt durable split assignment.')
  return value as DomainSplit
}

export class DrizzleGeoOutcomeRepository implements GeoOutcomeRepositoryPort {
  private readonly db: GeoOutcomeDrizzleDatabase

  constructor(database: GeoOutcomeDrizzleDatabase | null = getDatabase()) {
    if (!database) throw new Error('GEO outcome database is not configured.')
    this.db = database
  }

  private governanceProjection(observation: OutcomeObservation, facts: readonly GeoOutcomeObservationVerification[]): OutcomeObservation {
    const revoked = facts.some(item => item.factType === 'revocation' && item.factStatus === 'revoked')
    const evidence = facts.some(item => item.factType === 'evidence_verification' && item.factStatus === 'approved')
    const consent = facts.some(item => item.factType === 'consent_review' && item.factStatus === 'approved')
    const pii = facts.some(item => item.factType === 'pii_review' && item.factStatus === 'approved')
    const eligible = evidence && consent && pii && !revoked
    const reviewFingerprint = facts.length ? fingerprint(facts.map(item => item.decisionFingerprint).sort()) : null
    const projected: OutcomeObservation = {
      ...observation,
      verificationStatus: revoked ? 'revoked' : eligible ? 'verified' : 'unverified',
      consentStatus: revoked ? 'revoked' : consent ? 'approved' : 'unknown',
      piiStatus: revoked ? 'unknown' : pii ? 'clean' : 'unknown',
      verificationAuthority: eligible ? 'owner_review' : 'intake',
      reviewFingerprint,
      candidateAuthorityFingerprint: null,
      candidateSetFingerprint: null,
    }
    assertObservationIsUsable(projected)
    return projected
  }

  private mapObservation(run: GeoOutcomeObservationRun, candidate: GeoOutcomeObservationCandidate, facts: readonly GeoOutcomeObservationVerification[]): OutcomeObservation {
    if (!candidate.observationPayload || typeof candidate.observationPayload !== 'object' || Array.isArray(candidate.observationPayload)) throw new Error('Corrupt durable observation payload.')
    const payload = candidate.observationPayload as Record<string, unknown>
    const publicInput = {
      schemaVersion: payload.schemaVersion,
      projectId: run.projectId,
      clientId: run.clientId,
      websiteIdentityHash: candidate.websiteIdentityHash,
      queryIdentityHash: candidate.queryIdentityHash,
      normalizedQueryHash: candidate.normalizedQueryHash,
      candidatePageIdentityHash: candidate.candidatePageIdentityHash,
      canonicalPageHash: candidate.canonicalPageHash,
      contentHash: candidate.contentHash,
      evidenceSnapshotHash: candidate.evidenceSnapshotHash,
      publicationReceiptFingerprint: candidate.publicationReceiptFingerprint,
      engine: run.engine,
      model: run.model,
      modelVersion: run.modelVersion,
      interface: run.interface,
      locale: run.locale,
      region: run.region,
      runIdentity: run.runIdentity,
      runTimestamp: toIso(run.runTimestamp),
      observationWindow: { start: toIso(run.observationWindowStart), end: toIso(run.observationWindowEnd) },
      observableStatus: candidate.observableStatus,
      retrievalStatus: candidate.retrievalStatus,
      citationStatus: candidate.citationStatus,
      citationPosition: candidate.citationPosition,
      mentionStatus: candidate.mentionStatus,
      recommendationStatus: candidate.recommendationStatus,
      labelBasis: candidate.labelBasis,
      verificationStatus: 'unverified',
      evidenceLocatorHashes: stringArray(candidate.evidenceLocatorHashes, 'evidence locator hashes'),
      appliedRuleHashes: stringArray(candidate.appliedRuleHashes, 'applied rule hashes'),
      contentFeatureVector: candidate.contentFeatureVector,
    }
    const validated = normalizeManualObservation(publicInput, run.ownerUserId)
    const immutable: OutcomeObservation = { ...validated, intakeFingerprint: candidate.intakeFingerprint, observationFingerprint: candidate.observationFingerprint }
    assertObservationIsUsable(immutable)
    if (run.evidenceSnapshotHash !== candidate.evidenceSnapshotHash) throw new Error('Corrupt durable observation evidence lineage.')
    return this.governanceProjection(immutable, facts)
  }

  private async revalidateAuthoritativeEvidence(observation: OutcomeObservation, facts: readonly GeoOutcomeObservationVerification[]): Promise<OutcomeObservation> {
    if (facts.some(item => item.factType === 'revocation' && item.factStatus === 'revoked')) return observation
    if (!facts.some(item => item.factType === 'evidence_verification' && item.factStatus === 'approved')) return observation
    const bindings = await this.db.select().from(geoOutcomeEvidenceLocators).where(and(eq(geoOutcomeEvidenceLocators.ownerUserId, observation.ownerUserId), eq(geoOutcomeEvidenceLocators.observationFingerprint, observation.observationFingerprint), eq(geoOutcomeEvidenceLocators.purpose, 'geo_outcome_verification'), eq(geoOutcomeEvidenceLocators.sourceKind, 'llm_visibility_observation')))
    if (bindings.length !== 1) throw new Error('Durable evidence governance must have exactly one authoritative binding.')
    const stored = bindings[0]!
    const resolved = await resolveAuthoritativeLlmVisibilityEvidence(this.db, observation.ownerUserId, observation, stored.sourceRecordId)
    if (stored.evidenceLocatorHash !== resolved.evidenceLocatorHash || stored.sourceResponseHash !== resolved.sourceResponseHash || stored.sourceCitationSetFingerprint !== resolved.sourceCitationSetFingerprint || stored.sourceProjectId !== resolved.sourceProjectId || stored.sourceQueryId !== resolved.sourceQueryId || stored.sourceRunId !== resolved.sourceRunId || stored.candidateAuthorityId !== resolved.candidateAuthorityId || stored.candidateAuthorityFingerprint !== resolved.candidateAuthorityFingerprint || stored.candidateSetFingerprint !== resolved.candidateSetFingerprint || stored.canonicalCandidateUrlHash !== resolved.canonicalCandidateUrlHash || stored.serverDerivedCitationStatus !== resolved.serverDerivedCitationStatus || stored.serverDerivedCitationPosition !== resolved.serverDerivedCitationPosition || stored.evidenceBindingFingerprint !== resolved.evidenceBindingFingerprint || toIso(stored.sourceObservedAt) !== resolved.sourceObservedAt) throw new Error('Durable authoritative evidence binding no longer matches source/candidate lineage.')
    return { ...observation, candidateAuthorityFingerprint: resolved.candidateAuthorityFingerprint, candidateSetFingerprint: resolved.candidateSetFingerprint, reviewFingerprint: fingerprint({ governanceReviewFingerprint: observation.reviewFingerprint, evidenceBindingFingerprint: resolved.evidenceBindingFingerprint }) }
  }

  async listObservations(ownerUserId: number): Promise<OutcomeObservation[]> {
    const runs = await this.db.select().from(geoOutcomeObservationRuns).where(eq(geoOutcomeObservationRuns.ownerUserId, ownerUserId))
    const candidates = await this.db.select().from(geoOutcomeObservationCandidates).where(eq(geoOutcomeObservationCandidates.ownerUserId, ownerUserId))
    const facts = await this.db.select().from(geoOutcomeObservationVerifications).where(eq(geoOutcomeObservationVerifications.ownerUserId, ownerUserId))
    const runById = new Map(runs.map(run => [run.id, run]))
    return Promise.all(candidates.map(async candidate => {
      const run = runById.get(candidate.observationRunId)
      if (!run) throw new Error('Dangling observation run.')
      const observationFacts = facts.filter(item => item.observationFingerprint === candidate.observationFingerprint)
      return this.revalidateAuthoritativeEvidence(this.mapObservation(run, candidate, observationFacts), observationFacts)
    }))
  }

  private async readObservation(ownerUserId: number, observationFingerprint: string, revalidateEvidence: boolean): Promise<OutcomeObservation | null> {
    const [candidate] = await this.db.select().from(geoOutcomeObservationCandidates).where(and(eq(geoOutcomeObservationCandidates.ownerUserId, ownerUserId), eq(geoOutcomeObservationCandidates.observationFingerprint, observationFingerprint))).limit(1)
    if (!candidate) return null
    const [run] = await this.db.select().from(geoOutcomeObservationRuns).where(and(eq(geoOutcomeObservationRuns.ownerUserId, ownerUserId), eq(geoOutcomeObservationRuns.id, candidate.observationRunId))).limit(1)
    if (!run) throw new Error('Dangling observation run.')
    const facts = await this.db.select().from(geoOutcomeObservationVerifications).where(and(eq(geoOutcomeObservationVerifications.ownerUserId, ownerUserId), eq(geoOutcomeObservationVerifications.observationFingerprint, observationFingerprint)))
    const observation = this.mapObservation(run, candidate, facts)
    return revalidateEvidence ? this.revalidateAuthoritativeEvidence(observation, facts) : observation
  }
  async getObservation(ownerUserId: number, observationFingerprint: string): Promise<OutcomeObservation | null> { return this.readObservation(ownerUserId, observationFingerprint, true) }

  async saveObservationTransactional(ownerUserId: number, observation: OutcomeObservation): Promise<OutcomeObservation> {
    if (observation.ownerUserId !== ownerUserId) throw new Error('Owner scope mismatch.')
    assertObservationIsUsable(observation)
    return this.db.transaction(async tx => {
      const repo = new DrizzleGeoOutcomeRepository(tx)
      const existing = await repo.getObservation(ownerUserId, observation.observationFingerprint)
      if (existing) return existing
      const runFingerprint = fingerprint({ ownerUserId, projectId: observation.projectId, clientId: observation.clientId, runIdentity: observation.runIdentity, engine: observation.engine, model: observation.model, modelVersion: observation.modelVersion, interface: observation.interface, locale: observation.locale, region: observation.region, observationWindow: observation.observationWindow, runTimestamp: observation.runTimestamp, evidenceSnapshotHash: observation.evidenceSnapshotHash })
      let [run] = await tx.select().from(geoOutcomeObservationRuns).where(and(eq(geoOutcomeObservationRuns.ownerUserId, ownerUserId), eq(geoOutcomeObservationRuns.runIdentity, observation.runIdentity))).limit(1)
      if (!run) {
        try {
          await tx.insert(geoOutcomeObservationRuns).values({ ownerUserId, projectId: observation.projectId, clientId: observation.clientId, runIdentity: observation.runIdentity, engine: observation.engine, model: observation.model, modelVersion: observation.modelVersion, interface: observation.interface, locale: observation.locale, region: observation.region, observationWindowStart: new Date(observation.observationWindow.start), observationWindowEnd: new Date(observation.observationWindow.end), runTimestamp: new Date(observation.runTimestamp), evidenceSnapshotHash: observation.evidenceSnapshotHash, status: 'received', runFingerprint, createdAt: new Date() })
        } catch {
          // Concurrent first writers converge through the unique run identity.
        }
        ;[run] = await tx.select().from(geoOutcomeObservationRuns).where(and(eq(geoOutcomeObservationRuns.ownerUserId, ownerUserId), eq(geoOutcomeObservationRuns.runIdentity, observation.runIdentity))).limit(1)
      }
      if (!run) throw new Error('Observation run was not persisted.')
      if (run.runFingerprint !== runFingerprint) throw new Error('Observation run identity collision.')
      try {
        await tx.insert(geoOutcomeObservationCandidates).values({ ownerUserId, observationRunId: run.id, websiteIdentityHash: observation.websiteIdentityHash, queryIdentityHash: observation.queryIdentityHash, normalizedQueryHash: observation.normalizedQueryHash, candidatePageIdentityHash: observation.candidatePageIdentityHash, canonicalPageHash: observation.canonicalPageHash, contentHash: observation.contentHash, evidenceSnapshotHash: observation.evidenceSnapshotHash, publicationReceiptFingerprint: observation.publicationReceiptFingerprint, observableStatus: observation.observableStatus, retrievalStatus: observation.retrievalStatus, citationStatus: observation.citationStatus, citationPosition: observation.citationPosition, mentionStatus: observation.mentionStatus, recommendationStatus: observation.recommendationStatus, labelBasis: observation.labelBasis, verificationStatus: 'unverified', consentStatus: 'unknown', piiStatus: 'unknown', verificationAuthority: 'intake', intakeFingerprint: observation.intakeFingerprint, reviewFingerprint: null, observationPayload: { schemaVersion: observation.schemaVersion }, evidenceLocatorHashes: observation.evidenceLocatorHashes, appliedRuleHashes: observation.appliedRuleHashes, contentFeatureVector: observation.contentFeatureVector, observationFingerprint: observation.observationFingerprint, createdAt: new Date() })
      } catch {
        const replay = await repo.getObservation(ownerUserId, observation.observationFingerprint)
        if (replay) return replay
        throw new Error('Observation candidate identity collision.')
      }
      const saved = await repo.getObservation(ownerUserId, observation.observationFingerprint)
      if (!saved) throw new Error('Observation was not persisted.')
      return saved
    })
  }

  async bindAuthoritativeEvidenceTransactional(ownerUserId: number, observationFingerprint: string, sourceRecordId: number): Promise<EvidenceBinding> {
    return this.db.transaction(async tx => {
      const repo = new DrizzleGeoOutcomeRepository(tx)
      const observation = await repo.readObservation(ownerUserId, observationFingerprint, false)
      if (!observation) throw new Error('Observation not found.')
      const binding = await resolveAuthoritativeLlmVisibilityEvidence(tx, ownerUserId, observation, sourceRecordId)
      try {
        await tx.insert(geoOutcomeEvidenceLocators).values({ ...binding, sourceObservedAt: new Date(binding.sourceObservedAt), createdAt: new Date(binding.createdAt) })
      } catch {
        const [existing] = await tx.select().from(geoOutcomeEvidenceLocators).where(and(eq(geoOutcomeEvidenceLocators.ownerUserId, ownerUserId), eq(geoOutcomeEvidenceLocators.observationFingerprint, observationFingerprint), eq(geoOutcomeEvidenceLocators.sourceKind, 'llm_visibility_observation'), eq(geoOutcomeEvidenceLocators.sourceRecordId, sourceRecordId))).limit(1)
        if (!existing || existing.evidenceLocatorHash !== binding.evidenceLocatorHash || existing.sourceResponseHash !== binding.sourceResponseHash || existing.sourceCitationSetFingerprint !== binding.sourceCitationSetFingerprint || existing.sourceProjectId !== binding.sourceProjectId || existing.sourceQueryId !== binding.sourceQueryId || existing.sourceRunId !== binding.sourceRunId || existing.candidateAuthorityId !== binding.candidateAuthorityId || existing.candidateAuthorityFingerprint !== binding.candidateAuthorityFingerprint || existing.candidateSetFingerprint !== binding.candidateSetFingerprint || existing.serverDerivedCitationStatus !== binding.serverDerivedCitationStatus || existing.serverDerivedCitationPosition !== binding.serverDerivedCitationPosition || existing.evidenceBindingFingerprint !== binding.evidenceBindingFingerprint || toIso(existing.sourceObservedAt) !== binding.sourceObservedAt) throw new Error('Authoritative evidence binding collision.')
        return { ...binding, createdAt: toIso(existing.createdAt)! }
      }
      return binding
    })
  }

  async verifyObservationTransactional(ownerUserId: number, observationFingerprint: string, reviewerUserId: number, action: ObservationGovernanceAction, reason: string, evidenceLocatorHash: string | null = null) {
    return this.db.transaction(async tx => {
      const repo = new DrizzleGeoOutcomeRepository(tx)
      const observation = await repo.readObservation(ownerUserId, observationFingerprint, false)
      if (!observation) throw new Error('Observation not found.')
      const existingFacts = await tx.select().from(geoOutcomeObservationVerifications).where(and(eq(geoOutcomeObservationVerifications.ownerUserId, ownerUserId), eq(geoOutcomeObservationVerifications.observationFingerprint, observationFingerprint)))
      if (existingFacts.some(item => item.factType === 'revocation')) throw new Error('Observation version is terminally revoked.')
      const factType = action === 'verify_evidence' ? 'evidence_verification' : action === 'approve_consent' ? 'consent_review' : action === 'approve_pii' ? 'pii_review' : 'revocation'
      if (existingFacts.some(item => item.factType === factType)) throw new Error('Duplicate governance fact.')
      if (action === 'verify_evidence') {
        if (!evidenceLocatorHash || !observation.evidenceLocatorHashes.includes(evidenceLocatorHash)) throw new Error('Evidence locator is not approved for this observation.')
        if (observation.citationStatus === 'unknown') throw new Error('Unknown citation status cannot be verified as primary evidence.')
        const [evidence] = await tx.select().from(geoOutcomeEvidenceLocators).where(and(eq(geoOutcomeEvidenceLocators.ownerUserId, ownerUserId), eq(geoOutcomeEvidenceLocators.observationFingerprint, observationFingerprint), eq(geoOutcomeEvidenceLocators.evidenceLocatorHash, evidenceLocatorHash), eq(geoOutcomeEvidenceLocators.purpose, 'geo_outcome_verification'), eq(geoOutcomeEvidenceLocators.sourceKind, 'llm_visibility_observation'), eq(geoOutcomeEvidenceLocators.sourceResponseHash, observation.evidenceSnapshotHash), eq(geoOutcomeEvidenceLocators.serverDerivedCitationStatus, observation.citationStatus))).limit(1)
        if (!evidence) throw new Error('Evidence locator has not been bound from authoritative owner-scoped consumer-surface evidence.')
      } else if (evidenceLocatorHash !== null) throw new Error('Only evidence verification may include an evidence locator.')
      const factStatus = action === 'revoke' ? 'revoked' : 'approved'
      const decisionFingerprint = fingerprint({ ownerUserId, observationFingerprint, reviewerUserId, factType, factStatus, reason, evidenceLocatorHash })
      const evidenceApproved = action === 'verify_evidence' || existingFacts.some(item => item.factType === 'evidence_verification' && item.factStatus === 'approved')
      const consentApproved = action === 'approve_consent' || existingFacts.some(item => item.factType === 'consent_review' && item.factStatus === 'approved')
      const piiApproved = action === 'approve_pii' || existingFacts.some(item => item.factType === 'pii_review' && item.factStatus === 'approved')
      const newVerificationStatus = action === 'revoke' ? 'revoked' : evidenceApproved && consentApproved && piiApproved ? 'verified' : 'unverified'
      const ledger: ObservationVerificationDecision = { decisionId: `geo-governance-${decisionFingerprint.slice(0, 20)}`, ownerUserId, observationFingerprint, reviewerUserId, previousVerificationStatus: observation.verificationStatus, newVerificationStatus, evidenceLocatorHash, factType, factStatus, reason, decisionFingerprint, consentStatus: action === 'revoke' ? 'revoked' : consentApproved ? 'approved' : 'unknown', piiStatus: action === 'revoke' ? 'unknown' : piiApproved ? 'clean' : 'unknown', createdAt: new Date().toISOString() }
      await tx.insert(geoOutcomeObservationVerifications).values({ ...ledger, createdAt: new Date(ledger.createdAt) })
      await tx.update(geoOutcomeObservationCandidates).set({ verificationStatus: ledger.newVerificationStatus, consentStatus: ledger.consentStatus, piiStatus: ledger.piiStatus, verificationAuthority: newVerificationStatus === 'verified' ? 'owner_review' : 'intake', reviewFingerprint: decisionFingerprint, revokedAt: action === 'revoke' ? new Date() : null }).where(and(eq(geoOutcomeObservationCandidates.ownerUserId, ownerUserId), eq(geoOutcomeObservationCandidates.observationFingerprint, observationFingerprint)))
      const updated = await repo.getObservation(ownerUserId, observationFingerprint)
      if (!updated) throw new Error('Observation governance projection failed.')
      return { observation: updated, verificationDecision: ledger }
    })
  }

  private mapDataset(row: GeoOutcomeDatasetManifest): DatasetManifest {
    if (!row.splitFingerprints || typeof row.splitFingerprints !== 'object' || Array.isArray(row.splitFingerprints)) throw new Error('Corrupt durable dataset split manifest.')
    const split = row.splitFingerprints as Record<string, unknown>
    const trainFingerprints = stringArray(split.train, 'train split')
    const validationFingerprints = stringArray(split.validation, 'validation split')
    const testFingerprints = stringArray(split.test, 'test split')
    const siteHoldoutFingerprints = stringArray(split.siteHoldout, 'site holdout split')
    const queryHoldoutFingerprints = stringArray(split.queryHoldout, 'query holdout split')
    const temporalHoldoutFingerprints = stringArray(split.temporalHoldout, 'temporal holdout split')
    const sourcePayload = {
      schemaVersion: row.schemaVersion,
      taskType: row.taskType,
      featureCatalogVersion: row.featureCatalogVersion,
      labelContractVersion: row.labelContractVersion,
      hardNegativePolicyVersion: row.hardNegativePolicyVersion,
      sourceObservationFingerprints: stringArray(row.sourceObservationFingerprints, 'source observation fingerprints'),
      sourceBasisCounts: numberRecord(row.sourceBasisCounts, 'source basis counts'),
      engineCounts: numberRecord(row.engineCounts, 'engine counts'),
      localeCounts: numberRecord(row.localeCounts, 'locale counts'),
      websiteCount: row.websiteCount,
      queryGroupCount: row.queryGroupCount,
      positiveCount: row.positiveCount,
      hardNegativeCount: row.hardNegativeCount,
      observationStart: toIso(row.observationStart),
      observationEnd: toIso(row.observationEnd),
      splitPolicyVersion: row.splitPolicyVersion,
      trainFingerprints,
      validationFingerprints,
      testFingerprints,
      siteHoldoutFingerprints,
      queryHoldoutFingerprints,
      temporalHoldoutFingerprints,
      trainRowCount: trainFingerprints.length,
      validationRowCount: validationFingerprints.length,
      testRowCount: testFingerprints.length,
      siteHoldoutRowCount: siteHoldoutFingerprints.length,
      queryHoldoutRowCount: queryHoldoutFingerprints.length,
      temporalHoldoutRowCount: temporalHoldoutFingerprints.length,
      limitations: stringArray(row.limitations, 'dataset limitations'),
    }
    if (fingerprint(sourcePayload) !== row.manifestFingerprint) throw new Error('Corrupt durable dataset manifest fingerprint.')
    const expectedManifestId = row.taskType === 'citation_selection' ? `geo-dataset-${row.manifestFingerprint.slice(0, 20)}` : `geo-structural-${row.manifestFingerprint.slice(0, 20)}`
    if (row.manifestId !== expectedManifestId) throw new Error('Corrupt durable dataset business id.')
    const storedReadiness = readiness(row.readiness)
    const observationSpanDays = sourcePayload.observationStart && sourcePayload.observationEnd ? Math.floor((new Date(sourcePayload.observationEnd).getTime() - new Date(sourcePayload.observationStart).getTime()) / 86_400_000) : null
    const computedReadiness = getDatasetReadiness({ candidates: sourcePayload.sourceObservationFingerprints.length, queryGroups: sourcePayload.queryGroupCount, websites: sourcePayload.websiteCount, engines: Object.keys(sourcePayload.engineCounts).length, positives: sourcePayload.positiveCount, hardNegatives: sourcePayload.hardNegativeCount, observationSpanDays })
    if (computedReadiness.missing.some(reason => !storedReadiness.missing.includes(reason)) || storedReadiness.ready && !computedReadiness.ready) throw new Error('Corrupt durable dataset readiness projection.')
    if ((row.status === 'gate_blocked' && storedReadiness.ready) || ((row.status === 'ready_for_review' || row.status === 'approved') && !storedReadiness.ready)) throw new Error('Corrupt durable dataset readiness status.')
    const manifest: DatasetManifest = { manifestId: row.manifestId, ...sourcePayload, manifestFingerprint: row.manifestFingerprint, readiness: storedReadiness, status: row.status, ownerUserId: row.ownerUserId, createdAt: toIso(row.createdAt)! }
    const union = [...trainFingerprints, ...validationFingerprints, ...testFingerprints, ...siteHoldoutFingerprints, ...queryHoldoutFingerprints, ...temporalHoldoutFingerprints]
    if (new Set(union).size !== union.length || union.length !== manifest.sourceObservationFingerprints.length || !manifest.sourceObservationFingerprints.every(item => union.includes(item))) throw new Error('Corrupt durable dataset split membership.')
    return manifest
  }

  async listDatasets(ownerUserId: number) { const rows = await this.db.select().from(geoOutcomeDatasetManifests).where(eq(geoOutcomeDatasetManifests.ownerUserId, ownerUserId)); return rows.map(row => this.mapDataset(row)) }
  async getDataset(ownerUserId: number, manifestId: string) { const [row] = await this.db.select().from(geoOutcomeDatasetManifests).where(and(eq(geoOutcomeDatasetManifests.ownerUserId, ownerUserId), eq(geoOutcomeDatasetManifests.manifestId, manifestId))).limit(1); return row ? this.mapDataset(row) : null }
  async getDatasetMembers(ownerUserId: number, manifestId: string) {
    const [dataset] = await this.db.select().from(geoOutcomeDatasetManifests).where(and(eq(geoOutcomeDatasetManifests.ownerUserId, ownerUserId), eq(geoOutcomeDatasetManifests.manifestId, manifestId))).limit(1)
    if (!dataset) return []
    const rows = await this.db.select().from(geoOutcomeDatasetMembers).where(and(eq(geoOutcomeDatasetMembers.ownerUserId, ownerUserId), eq(geoOutcomeDatasetMembers.datasetManifestId, dataset.id)))
    const observations = await this.listObservations(ownerUserId)
    return rows.map((row: GeoOutcomeDatasetMember): DatasetMember => {
      const observation = observations.find(item => item.observationFingerprint === row.observationFingerprint)
      if (!observation) throw new Error('Dangling dataset member.')
      const vector = featureVector(row.featureVector)
      if (fingerprint(vector) !== fingerprint(deriveFeatureVector(observation))) throw new Error('Corrupt durable member feature provenance.')
      if (row.websiteIdentityHash !== observation.websiteIdentityHash || row.normalizedQueryHash !== observation.normalizedQueryHash || row.runIdentity !== observation.runIdentity) throw new Error('Corrupt durable member identity provenance.')
      const expectedQueryGroupKey = fingerprint({ runIdentity: observation.runIdentity, normalizedQueryHash: observation.normalizedQueryHash, engine: observation.engine, model: observation.model, modelVersion: observation.modelVersion, interface: observation.interface, locale: observation.locale, region: observation.region, observationWindow: observation.observationWindow })
      if (row.queryGroupKey !== expectedQueryGroupKey) throw new Error('Corrupt durable member query-group provenance.')
      return { observationFingerprint: row.observationFingerprint, websiteIdentityHash: row.websiteIdentityHash, normalizedQueryHash: row.normalizedQueryHash, runIdentity: row.runIdentity, queryGroupKey: row.queryGroupKey, label: row.label === 'positive' ? 1 : 0, hardNegative: row.label === 'hard_negative', splitAssignment: splitKeyToDomain(row.splitAssignment), consentStatus: observation.consentStatus, piiStatus: observation.piiStatus, reviewFingerprint: observation.reviewFingerprint, featureVector: vector, observation }
    })
  }
  async saveDatasetTransactional(ownerUserId: number, manifest: DatasetManifest, members: DatasetMember[]) {
    if (manifest.ownerUserId !== ownerUserId) throw new Error('Owner scope mismatch.')
    return this.db.transaction(async tx => {
      const repo = new DrizzleGeoOutcomeRepository(tx)
      const [existing] = await tx.select().from(geoOutcomeDatasetManifests).where(and(eq(geoOutcomeDatasetManifests.ownerUserId, ownerUserId), eq(geoOutcomeDatasetManifests.manifestFingerprint, manifest.manifestFingerprint))).limit(1)
      if (existing) return repo.mapDataset(existing)
      await tx.insert(geoOutcomeDatasetManifests).values({ ownerUserId, manifestId: manifest.manifestId, schemaVersion: manifest.schemaVersion, taskType: manifest.taskType, featureCatalogVersion: manifest.featureCatalogVersion, labelContractVersion: manifest.labelContractVersion, hardNegativePolicyVersion: manifest.hardNegativePolicyVersion, sourceObservationFingerprints: manifest.sourceObservationFingerprints, sourceBasisCounts: manifest.sourceBasisCounts, engineCounts: manifest.engineCounts, localeCounts: manifest.localeCounts, websiteCount: manifest.websiteCount, queryGroupCount: manifest.queryGroupCount, positiveCount: manifest.positiveCount, hardNegativeCount: manifest.hardNegativeCount, observationStart: manifest.observationStart ? new Date(manifest.observationStart) : null, observationEnd: manifest.observationEnd ? new Date(manifest.observationEnd) : null, splitPolicyVersion: manifest.splitPolicyVersion, splitFingerprints: { train: manifest.trainFingerprints, validation: manifest.validationFingerprints, test: manifest.testFingerprints, siteHoldout: manifest.siteHoldoutFingerprints, queryHoldout: manifest.queryHoldoutFingerprints, temporalHoldout: manifest.temporalHoldoutFingerprints }, manifestFingerprint: manifest.manifestFingerprint, limitations: manifest.limitations, readiness: manifest.readiness, status: manifest.status, createdAt: new Date(manifest.createdAt) })
      const [row] = await tx.select().from(geoOutcomeDatasetManifests).where(and(eq(geoOutcomeDatasetManifests.ownerUserId, ownerUserId), eq(geoOutcomeDatasetManifests.manifestId, manifest.manifestId))).limit(1)
      if (!row) throw new Error('Dataset manifest id was not returned.')
      for (const member of members) await tx.insert(geoOutcomeDatasetMembers).values({ ownerUserId, datasetManifestId: row.id, observationFingerprint: member.observationFingerprint, websiteIdentityHash: member.websiteIdentityHash, normalizedQueryHash: member.normalizedQueryHash, runIdentity: member.runIdentity, queryGroupKey: member.queryGroupKey, label: member.label === 1 ? 'positive' : 'hard_negative', splitAssignment: splitKeyToDb(member.splitAssignment || 'train'), consentStatus: member.consentStatus || 'unknown', piiStatus: member.piiStatus || 'unknown', reviewFingerprint: member.reviewFingerprint || null, featureVector: member.featureVector })
      return repo.mapDataset(row)
    })
  }
  async transitionDatasetWithDecision(ownerUserId: number, manifestId: string, status: DatasetManifest['status'], reviewerUserId: number, reason: string) {
    return this.db.transaction(async tx => {
      const repo = new DrizzleGeoOutcomeRepository(tx)
      const current = await repo.getDataset(ownerUserId, manifestId)
      if (!current) throw new Error('Dataset manifest not found.')
      if (current.status === 'revoked' || current.status === 'archived') throw new Error('Dataset is terminal and cannot be modified.')
      if (status === 'approved' && current.status !== 'ready_for_review') throw new Error('Only ready_for_review datasets may be approved.')
      if (status !== 'approved' && status !== 'revoked') throw new Error('Dataset review may only approve or revoke.')
      const [row] = await tx.select({ id: geoOutcomeDatasetManifests.id }).from(geoOutcomeDatasetManifests).where(and(eq(geoOutcomeDatasetManifests.ownerUserId, ownerUserId), eq(geoOutcomeDatasetManifests.manifestId, manifestId))).limit(1)
      if (!row) throw new Error('Dataset manifest row not found.')
      const decisionFingerprint = fingerprint({ ownerUserId, manifestId, previousStatus: current.status, newStatus: status, reviewerUserId, reason, manifestFingerprint: current.manifestFingerprint })
      const decision: DatasetDecision = { decisionId: `geo-dataset-decision-${decisionFingerprint.slice(0, 20)}`, ownerUserId, manifestId, previousStatus: current.status, newStatus: status, reviewerUserId, reason, manifestFingerprint: current.manifestFingerprint, createdAt: new Date().toISOString() }
      await tx.insert(geoOutcomeDatasetDecisions).values({ ...decision, datasetManifestId: row.id, createdAt: new Date(decision.createdAt) })
      const result = await tx.update(geoOutcomeDatasetManifests).set({ status }).where(and(eq(geoOutcomeDatasetManifests.ownerUserId, ownerUserId), eq(geoOutcomeDatasetManifests.manifestId, manifestId), eq(geoOutcomeDatasetManifests.status, current.status)))
      if (affectedRows(result) !== 1) throw new Error('Dataset decision lost its compare-and-swap.')
      return { manifest: (await repo.getDataset(ownerUserId, manifestId))!, decision }
    })
  }
  async listDatasetDecisions(ownerUserId: number): Promise<DatasetDecision[]> {
    const rows = await this.db.select().from(geoOutcomeDatasetDecisions).where(eq(geoOutcomeDatasetDecisions.ownerUserId, ownerUserId)).orderBy(asc(geoOutcomeDatasetDecisions.id))
    const manifests = await this.db.select({ id: geoOutcomeDatasetManifests.id, manifestId: geoOutcomeDatasetManifests.manifestId, manifestFingerprint: geoOutcomeDatasetManifests.manifestFingerprint }).from(geoOutcomeDatasetManifests).where(eq(geoOutcomeDatasetManifests.ownerUserId, ownerUserId))
    const manifestsByPrimaryKey = new Map(manifests.map(item => [item.id, item]))
    return rows.map((row: GeoOutcomeDatasetDecision): DatasetDecision => {
      const manifest = manifestsByPrimaryKey.get(row.datasetManifestId)
      if (!manifest || manifest.manifestFingerprint !== row.manifestFingerprint) throw new Error('Dangling or corrupt dataset decision manifest lineage.')
      const decisionFingerprint = fingerprint({ ownerUserId: row.ownerUserId, manifestId: manifest.manifestId, previousStatus: row.previousStatus, newStatus: row.newStatus, reviewerUserId: row.reviewerUserId, reason: row.reason, manifestFingerprint: row.manifestFingerprint })
      if (row.decisionId !== `geo-dataset-decision-${decisionFingerprint.slice(0, 20)}`) throw new Error('Corrupt durable dataset decision business id.')
      return { decisionId: row.decisionId, ownerUserId: row.ownerUserId, manifestId: manifest.manifestId, previousStatus: row.previousStatus as DatasetManifest['status'], newStatus: row.newStatus as DatasetManifest['status'], reviewerUserId: row.reviewerUserId, reason: row.reason, manifestFingerprint: row.manifestFingerprint, createdAt: toIso(row.createdAt)! }
    })
  }

  private async mapTraining(row: GeoOutcomeTrainingRun): Promise<TrainingRun> {
    const [dataset] = await this.db.select({ manifestId: geoOutcomeDatasetManifests.manifestId }).from(geoOutcomeDatasetManifests).where(and(eq(geoOutcomeDatasetManifests.ownerUserId, row.ownerUserId), eq(geoOutcomeDatasetManifests.id, row.datasetManifestId))).limit(1)
    if (!dataset) throw new Error('Dangling training dataset foreign key.')
    const config = parseTrainingConfig(row.configuration)
    const expectedTrainingRunId = `geo-training-${fingerprint({ ownerUserId: row.ownerUserId, datasetManifestId: dataset.manifestId, modelFamily: row.modelFamily, config }).slice(0, 20)}`
    if (row.trainingRunId !== expectedTrainingRunId) throw new Error('Corrupt durable training business id.')
    const mapped = { trainingRunId: row.trainingRunId, ownerUserId: row.ownerUserId, datasetManifestId: dataset.manifestId, modelFamily: row.modelFamily, status: row.status, config, artifactId: row.artifactId, artifactHash: row.artifactHash, metrics: row.metrics === null ? null : evaluationBundle(row.metrics), reason: row.reason, createdAt: toIso(row.createdAt)!, startedAt: toIso(row.startedAt), completedAt: toIso(row.completedAt), leaseOwner: row.leaseOwner, leaseExpiresAt: toIso(row.leaseExpiresAt), version: row.version } satisfies TrainingRun
    if (mapped.status === 'running' && (!mapped.leaseOwner || !mapped.leaseExpiresAt || !mapped.startedAt)) throw new Error('Corrupt durable training lease state.')
    if (mapped.status === 'completed' && (!mapped.artifactId || !mapped.artifactHash || !mapped.metrics || !mapped.completedAt)) throw new Error('Corrupt durable completed training state.')
    if (mapped.status === 'queued' && (mapped.artifactId || mapped.artifactHash || mapped.metrics || mapped.completedAt)) throw new Error('Corrupt durable queued training state.')
    return mapped
  }
  async createTrainingRun(ownerUserId: number, run: TrainingRun) {
    const [dataset] = await this.db.select({ id: geoOutcomeDatasetManifests.id }).from(geoOutcomeDatasetManifests).where(and(eq(geoOutcomeDatasetManifests.ownerUserId, ownerUserId), eq(geoOutcomeDatasetManifests.manifestId, run.datasetManifestId))).limit(1)
    if (!dataset) throw new Error('Dataset manifest not found.')
    try { await this.db.insert(geoOutcomeTrainingRuns).values({ ownerUserId, trainingRunId: run.trainingRunId, datasetManifestId: dataset.id, modelFamily: run.modelFamily, status: run.status, startedAt: null, completedAt: null, leaseOwner: null, leaseExpiresAt: null, version: 0, configuration: run.config, artifactId: null, artifactHash: null, metrics: null, reason: null, createdAt: new Date(run.createdAt) }) } catch { const replay = await this.getTrainingRun(ownerUserId, run.trainingRunId); if (replay && replay.datasetManifestId === run.datasetManifestId && replay.modelFamily === run.modelFamily && fingerprint(replay.config) === fingerprint(run.config)) return replay; throw new Error('Training run collision.') }
    return (await this.getTrainingRun(ownerUserId, run.trainingRunId))!
  }
  async getTrainingRun(ownerUserId: number, trainingRunId: string) { const [row] = await this.db.select().from(geoOutcomeTrainingRuns).where(and(eq(geoOutcomeTrainingRuns.ownerUserId, ownerUserId), eq(geoOutcomeTrainingRuns.trainingRunId, trainingRunId))).limit(1); return row ? this.mapTraining(row) : null }
  async claimTrainingRun(ownerUserId: number, trainingRunId: string, leaseOwner: string, leaseExpiresAt: string): Promise<TrainingRunClaimResult> {
    const current = await this.getTrainingRun(ownerUserId, trainingRunId)
    if (!current) throw new Error('Training run not found.')
    if (current.status === 'completed') return { outcome: 'replay', run: current }
    const expired = current.status === 'running' && current.leaseExpiresAt !== null && new Date(current.leaseExpiresAt).getTime() <= Date.now()
    if (current.status === 'running' && !expired) return { outcome: 'in_progress', run: current }
    if (current.status !== 'queued' && !expired) return { outcome: 'collision', run: current }
    const result = await this.db.update(geoOutcomeTrainingRuns).set({ status: 'running', startedAt: current.startedAt ? new Date(current.startedAt) : new Date(), leaseOwner, leaseExpiresAt: new Date(leaseExpiresAt), version: current.version + 1 }).where(and(eq(geoOutcomeTrainingRuns.ownerUserId, ownerUserId), eq(geoOutcomeTrainingRuns.trainingRunId, trainingRunId), eq(geoOutcomeTrainingRuns.status, current.status), eq(geoOutcomeTrainingRuns.version, current.version)))
    if (affectedRows(result) !== 1) {
      const winner = await this.getTrainingRun(ownerUserId, trainingRunId)
      if (!winner) throw new Error('Training run disappeared during claim.')
      return { outcome: winner.status === 'completed' ? 'replay' : 'in_progress', run: winner }
    }
    return { outcome: expired ? 'stale_recovered' : 'claimed', run: (await this.getTrainingRun(ownerUserId, trainingRunId))! }
  }
  async transitionTrainingRun(ownerUserId: number, trainingRunId: string, patch: Partial<TrainingRun>) {
    const current = await this.getTrainingRun(ownerUserId, trainingRunId)
    if (!current) throw new Error('Training run not found.')
    const expectedVersion = patch.version ?? current.version
    const update: Partial<typeof geoOutcomeTrainingRuns.$inferInsert> = { version: expectedVersion + 1 }
    if (patch.status !== undefined) update.status = patch.status
    if (patch.startedAt !== undefined) update.startedAt = patch.startedAt ? new Date(patch.startedAt) : null
    if (patch.completedAt !== undefined) update.completedAt = patch.completedAt ? new Date(patch.completedAt) : null
    if (patch.leaseOwner !== undefined) update.leaseOwner = patch.leaseOwner
    if (patch.leaseExpiresAt !== undefined) update.leaseExpiresAt = patch.leaseExpiresAt ? new Date(patch.leaseExpiresAt) : null
    if (patch.artifactId !== undefined) update.artifactId = patch.artifactId
    if (patch.artifactHash !== undefined) update.artifactHash = patch.artifactHash
    if (patch.metrics !== undefined) update.metrics = patch.metrics
    if (patch.reason !== undefined) update.reason = patch.reason
    if (patch.config !== undefined) update.configuration = parseTrainingConfig(patch.config)
    const result = await this.db.update(geoOutcomeTrainingRuns).set(update).where(and(eq(geoOutcomeTrainingRuns.ownerUserId, ownerUserId), eq(geoOutcomeTrainingRuns.trainingRunId, trainingRunId), eq(geoOutcomeTrainingRuns.version, expectedVersion)))
    if (affectedRows(result) !== 1) throw new Error('Training run transition lost its compare-and-swap.')
    return (await this.getTrainingRun(ownerUserId, trainingRunId))!
  }
  async listTrainingRuns(ownerUserId: number) { const rows = await this.db.select().from(geoOutcomeTrainingRuns).where(eq(geoOutcomeTrainingRuns.ownerUserId, ownerUserId)); return Promise.all(rows.map(row => this.mapTraining(row))) }

  private mapArtifact(row: GeoOutcomeModelArtifact): ModelArtifact {
    const normalization = row.normalizationStatistics as Record<string, unknown>
    if (!normalization || typeof normalization !== 'object' || Array.isArray(normalization)) throw new Error('Corrupt durable normalization statistics.')
    const normalizationStatistics = { mean: numberArray(normalization.mean, 'normalization mean'), standardDeviation: numberArray(normalization.standardDeviation, 'normalization standard deviation') }
    if (normalizationStatistics.mean.length !== normalizationStatistics.standardDeviation.length || normalizationStatistics.standardDeviation.some(value => value <= 0)) throw new Error('Corrupt durable normalization statistics.')
    const base = { artifactSchemaVersion: row.artifactSchemaVersion, taskType: row.taskType, modelFamily: row.modelFamily, modelVersion: row.modelVersion, featureCatalogVersion: row.featureCatalogVersion, labelContractVersion: row.labelContractVersion, datasetManifestFingerprint: row.datasetManifestFingerprint, splitManifestFingerprint: row.splitManifestFingerprint, coefficients: numberArray(row.coefficients, 'artifact coefficients'), intercept: Number(row.intercept), normalizationStatistics, trainingConfiguration: parseTrainingConfig(row.trainingConfiguration), trainingRowCount: row.trainingRowCount, evaluationMetrics: evaluationBundle(row.evaluationMetrics), limitations: stringArray(row.limitations, 'artifact limitations'), rollbackArtifactHash: row.rollbackArtifactHash }
    if (base.coefficients.some(value => !Number.isFinite(value)) || !Number.isFinite(base.intercept)) throw new Error('Corrupt durable artifact parameters.')
    const artifactFingerprint = fingerprint(base)
    const artifactHash = sha256Hex(canonicalJson({ ...base, artifactFingerprint }))
    if (artifactFingerprint !== row.artifactFingerprint || artifactHash !== row.artifactHash || row.artifactId !== `geo-model-${artifactFingerprint.slice(0, 20)}`) throw new Error('Corrupt durable artifact hash lineage.')
    return { ...base, artifactFingerprint, artifactHash, artifactId: row.artifactId, ownerUserId: row.ownerUserId, status: row.status, revokedAt: toIso(row.revokedAt) }
  }
  private async validateArtifactLineage(artifact: ModelArtifact): Promise<ModelArtifact> {
    const [row] = await this.db.select().from(geoOutcomeDatasetManifests).where(and(eq(geoOutcomeDatasetManifests.ownerUserId, artifact.ownerUserId), eq(geoOutcomeDatasetManifests.manifestFingerprint, artifact.datasetManifestFingerprint))).limit(1)
    if (!row) throw new Error('Dangling artifact dataset lineage.')
    const dataset = this.mapDataset(row)
    const expectedSplitFingerprint = splitFingerprint({ train: dataset.trainFingerprints, validation: dataset.validationFingerprints, test: dataset.testFingerprints, siteHoldout: dataset.siteHoldoutFingerprints, queryHoldout: dataset.queryHoldoutFingerprints, temporalHoldout: dataset.temporalHoldoutFingerprints })
    if (artifact.splitManifestFingerprint !== expectedSplitFingerprint || artifact.trainingRowCount !== dataset.trainRowCount) throw new Error('Corrupt durable artifact dataset provenance.')
    return artifact
  }
  async saveArtifactTransactional(ownerUserId: number, artifact: ModelArtifact) {
    if (artifact.ownerUserId !== ownerUserId) throw new Error('Owner scope mismatch.')
    await this.db.insert(geoOutcomeModelArtifacts).values({ ownerUserId, artifactId: artifact.artifactId, artifactSchemaVersion: artifact.artifactSchemaVersion, taskType: artifact.taskType, modelFamily: artifact.modelFamily, modelVersion: artifact.modelVersion, featureCatalogVersion: artifact.featureCatalogVersion, labelContractVersion: artifact.labelContractVersion, datasetManifestFingerprint: artifact.datasetManifestFingerprint, splitManifestFingerprint: artifact.splitManifestFingerprint, coefficients: artifact.coefficients, intercept: String(artifact.intercept), normalizationStatistics: artifact.normalizationStatistics, trainingConfiguration: artifact.trainingConfiguration, trainingRowCount: artifact.trainingRowCount, evaluationMetrics: artifact.evaluationMetrics, limitations: artifact.limitations, artifactFingerprint: artifact.artifactFingerprint, artifactHash: artifact.artifactHash, rollbackArtifactHash: artifact.rollbackArtifactHash, status: artifact.status, revokedAt: artifact.revokedAt ? new Date(artifact.revokedAt) : null, createdAt: new Date() })
    return (await this.getArtifact(ownerUserId, artifact.artifactId))!
  }
  async getArtifact(ownerUserId: number, artifactId: string) { const [row] = await this.db.select().from(geoOutcomeModelArtifacts).where(and(eq(geoOutcomeModelArtifacts.ownerUserId, ownerUserId), eq(geoOutcomeModelArtifacts.artifactId, artifactId))).limit(1); return row ? this.validateArtifactLineage(this.mapArtifact(row)) : null }
  async listArtifacts(ownerUserId: number) { const rows = await this.db.select().from(geoOutcomeModelArtifacts).where(eq(geoOutcomeModelArtifacts.ownerUserId, ownerUserId)); return Promise.all(rows.map(row => this.validateArtifactLineage(this.mapArtifact(row)))) }
  async markArtifactShadowFailed(ownerUserId: number, artifactId: string) {
    const artifact = await this.getArtifact(ownerUserId, artifactId)
    if (!artifact) throw new Error('Model artifact not found.')
    if (artifact.status === 'revoked' || artifact.status === 'shadow_failed') return artifact
    if (artifact.status !== 'approved_for_shadow') throw new Error('Only an approved shadow artifact may be marked shadow_failed.')
    const result = await this.db.update(geoOutcomeModelArtifacts).set({ status: 'shadow_failed' }).where(and(eq(geoOutcomeModelArtifacts.ownerUserId, ownerUserId), eq(geoOutcomeModelArtifacts.artifactId, artifactId), eq(geoOutcomeModelArtifacts.status, 'approved_for_shadow')))
    if (affectedRows(result) !== 1) throw new Error('Shadow failure status lost its compare-and-swap.')
    const updated = await this.getArtifact(ownerUserId, artifactId)
    if (!updated) throw new Error('Shadow failure status was not persisted.')
    return updated
  }
  async transitionArtifactWithDecision(ownerUserId: number, artifactId: string, nextStatus: ModelArtifact['status'], reviewerUserId: number, reason: string, datasetManifestHash: string, rollbackArtifactHash: string | null = null) {
    return this.db.transaction(async tx => {
      const repo = new DrizzleGeoOutcomeRepository(tx)
      const artifact = await repo.getArtifact(ownerUserId, artifactId)
      if (!artifact) throw new Error('Artifact not found.')
      if (artifact.status === 'revoked') throw new Error('Revoked models cannot be restored.')
      const [artifactRow] = await tx.select({ id: geoOutcomeModelArtifacts.id }).from(geoOutcomeModelArtifacts).where(and(eq(geoOutcomeModelArtifacts.ownerUserId, ownerUserId), eq(geoOutcomeModelArtifacts.artifactId, artifactId))).limit(1)
      if (!artifactRow) throw new Error('Artifact row not found.')
      const decision: ModelDecision = { decisionId: `geo-decision-${fingerprint({ ownerUserId, artifactId, previousStatus: artifact.status, newStatus: nextStatus, reason, artifactHash: artifact.artifactHash }).slice(0, 20)}`, ownerUserId, modelArtifactId: artifactId, previousStatus: artifact.status, newStatus: nextStatus, reviewerUserId, reason, artifactHash: artifact.artifactHash, datasetManifestHash, createdAt: new Date().toISOString() }
      await tx.insert(geoOutcomeModelDecisions).values({ ...decision, modelArtifactId: artifactRow.id, createdAt: new Date(decision.createdAt) })
      const result = await tx.update(geoOutcomeModelArtifacts).set({ status: nextStatus, revokedAt: nextStatus === 'revoked' ? new Date() : null }).where(and(eq(geoOutcomeModelArtifacts.ownerUserId, ownerUserId), eq(geoOutcomeModelArtifacts.artifactId, artifactId), eq(geoOutcomeModelArtifacts.status, artifact.status)))
      if (affectedRows(result) !== 1) throw new Error('Artifact decision lost its compare-and-swap.')
      return { artifact: (await repo.getArtifact(ownerUserId, artifactId))!, decision }
    })
  }
  async listDecisions(ownerUserId: number) {
    const rows = await this.db.select().from(geoOutcomeModelDecisions).where(eq(geoOutcomeModelDecisions.ownerUserId, ownerUserId))
    const artifacts = await this.db.select({ id: geoOutcomeModelArtifacts.id, artifactId: geoOutcomeModelArtifacts.artifactId }).from(geoOutcomeModelArtifacts).where(eq(geoOutcomeModelArtifacts.ownerUserId, ownerUserId))
    const businessIdByPrimaryKey = new Map(artifacts.map(item => [item.id, item.artifactId]))
    return rows.map((row: GeoOutcomeModelDecision): ModelDecision => {
      const artifactId = businessIdByPrimaryKey.get(row.modelArtifactId)
      if (!artifactId) throw new Error('Dangling decision artifact foreign key.')
      const expectedDecisionId = `geo-decision-${fingerprint({ ownerUserId: row.ownerUserId, artifactId, previousStatus: row.previousStatus, newStatus: row.newStatus, reason: row.reason, artifactHash: row.artifactHash }).slice(0, 20)}`
      if (row.decisionId !== expectedDecisionId) throw new Error('Corrupt durable decision business id.')
      return { decisionId: row.decisionId, ownerUserId: row.ownerUserId, modelArtifactId: artifactId, previousStatus: row.previousStatus as ModelArtifact['status'], newStatus: row.newStatus as ModelArtifact['status'], reviewerUserId: row.reviewerUserId, reason: row.reason, artifactHash: row.artifactHash, datasetManifestHash: row.datasetManifestHash, createdAt: toIso(row.createdAt)! }
    })
  }

  private async readClaim(ownerUserId: number, routeIdentity: string, idempotencyKey: string): Promise<MutationClaim> {
    const [row] = await this.db.select().from(geoOutcomeIdempotencyClaims).where(and(eq(geoOutcomeIdempotencyClaims.ownerUserId, ownerUserId), eq(geoOutcomeIdempotencyClaims.routeIdentity, routeIdentity), eq(geoOutcomeIdempotencyClaims.idempotencyKey, idempotencyKey))).limit(1)
    if (!row) throw new Error('Mutation claim not found.')
    if (!isSha256(row.inputFingerprint) || row.responseFingerprint !== null && !isSha256(row.responseFingerprint)) throw new Error('Corrupt durable idempotency claim.')
    if (row.state === 'completed' && fingerprint(row.responseProjection) !== row.responseFingerprint) throw new Error('Corrupt durable idempotency response fingerprint.')
    return { ownerUserId: row.ownerUserId, routeIdentity: row.routeIdentity, idempotencyKey: row.idempotencyKey, inputFingerprint: row.inputFingerprint, state: row.state, responseProjection: row.responseProjection, responseFingerprint: row.responseFingerprint, version: row.version }
  }
  async claimMutation(ownerUserId: number, routeIdentity: string, idempotencyKey: string, inputFingerprint: string): Promise<MutationClaimResult> {
    try { await this.db.insert(geoOutcomeIdempotencyClaims).values({ ownerUserId, routeIdentity, idempotencyKey, inputFingerprint, state: 'claimed', responseProjection: null, responseFingerprint: null, leaseOwner: null, leaseExpiresAt: null, version: 0, createdAt: new Date() }); return { outcome: 'claimed', claim: await this.readClaim(ownerUserId, routeIdentity, idempotencyKey) } } catch {
      const claim = await this.readClaim(ownerUserId, routeIdentity, idempotencyKey)
      if (claim.inputFingerprint !== inputFingerprint) return { outcome: 'collision', claim }
      if (claim.state === 'completed') return { outcome: 'replay', claim }
      if (claim.state === 'failed') {
        const recovered = await this.db.update(geoOutcomeIdempotencyClaims).set({ state: 'claimed', responseProjection: null, responseFingerprint: null, completedAt: null, version: claim.version + 1 }).where(and(eq(geoOutcomeIdempotencyClaims.ownerUserId, ownerUserId), eq(geoOutcomeIdempotencyClaims.routeIdentity, routeIdentity), eq(geoOutcomeIdempotencyClaims.idempotencyKey, idempotencyKey), eq(geoOutcomeIdempotencyClaims.state, 'failed'), eq(geoOutcomeIdempotencyClaims.version, claim.version)))
        if (affectedRows(recovered) === 1) return { outcome: 'claimed', claim: await this.readClaim(ownerUserId, routeIdentity, idempotencyKey) }
      }
      return { outcome: 'in_progress', claim }
    }
  }
  async completeMutation(ownerUserId: number, routeIdentity: string, idempotencyKey: string, inputFingerprint: string, responseProjection: unknown) {
    const responseFingerprint = fingerprint(responseProjection)
    const result = await this.db.update(geoOutcomeIdempotencyClaims).set({ state: 'completed', responseProjection, responseFingerprint, completedAt: new Date(), version: sql`${geoOutcomeIdempotencyClaims.version} + 1` }).where(and(eq(geoOutcomeIdempotencyClaims.ownerUserId, ownerUserId), eq(geoOutcomeIdempotencyClaims.routeIdentity, routeIdentity), eq(geoOutcomeIdempotencyClaims.idempotencyKey, idempotencyKey), eq(geoOutcomeIdempotencyClaims.inputFingerprint, inputFingerprint), eq(geoOutcomeIdempotencyClaims.state, 'claimed')))
    if (affectedRows(result) !== 1) throw new Error('Idempotency completion lost its compare-and-swap.')
    return this.readClaim(ownerUserId, routeIdentity, idempotencyKey)
  }
  async failMutation(ownerUserId: number, routeIdentity: string, idempotencyKey: string, inputFingerprint: string, responseProjection: unknown) {
    const result = await this.db.update(geoOutcomeIdempotencyClaims).set({ state: 'failed', responseProjection, completedAt: new Date(), version: sql`${geoOutcomeIdempotencyClaims.version} + 1` }).where(and(eq(geoOutcomeIdempotencyClaims.ownerUserId, ownerUserId), eq(geoOutcomeIdempotencyClaims.routeIdentity, routeIdentity), eq(geoOutcomeIdempotencyClaims.idempotencyKey, idempotencyKey), eq(geoOutcomeIdempotencyClaims.inputFingerprint, inputFingerprint), eq(geoOutcomeIdempotencyClaims.state, 'claimed')))
    if (affectedRows(result) !== 1) throw new Error('Idempotency failure transition lost its compare-and-swap.')
    return this.readClaim(ownerUserId, routeIdentity, idempotencyKey)
  }
  async transaction<T>(work: (repository: GeoOutcomeRepositoryPort) => Promise<T>): Promise<T> { return this.db.transaction(async (tx): Promise<T> => work(new DrizzleGeoOutcomeRepository(tx))) }
}

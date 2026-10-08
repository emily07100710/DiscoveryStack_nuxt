import { and, asc, eq, inArray, sql } from 'drizzle-orm'
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
import { decodeDurableJson, encodeDurableJson } from './durable-json'
import { isFallbackOnlyArtifact } from './artifact'
import { isExactTrainOnlyPriorArtifact } from './bootstrap-baseline'
import { canBePrimaryCitationTruth } from './observation-contract'
import { evaluatePromotionGate } from './release-gate'
import { getShadowReadiness } from './dataset-builder'
import { assertObservationIsUsable } from './observation-contract'
import { deriveFeatureVector } from './feature-catalog'
import { getDatasetReadiness } from './dataset-builder'
import { normalizeManualObservation } from './normalization'
import { parseTrainingConfig } from './trainer'
import { splitFingerprint } from './split-policy'
import { resolveAuthoritativeLlmVisibilityEvidence } from './evidence-resolver'
import { DrizzleKnowledgeConsumerBindingRepository } from '../knowledge/consumer-bindings-drizzle'
import { buildKnowledgeRevisionSnapshot } from '../knowledge/revision-snapshot'
import { assertValidKnowledgeConsumerBinding } from '../knowledge/consumer-bindings'
import { assertValidKnowledgeMutationEvent, assertValidKnowledgeRevision } from '../knowledge/revision-records'
import { assertDatasetKnowledgeAuthorityCurrent, buildDatasetKnowledgeAuthority, assertValidApprovalReference, assertValidDatasetKnowledgeAuthority } from './knowledge-authority'
import type { DatasetKnowledgeApprovalReference, DatasetKnowledgeAuthority, DatasetKnowledgeState } from './knowledge-authority-types'
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

// Repository operations need Drizzle's query/transaction API, not a particular
// callback-vs-promise mysql2 client's shape on the optional $client property.
type AppDatabase = Omit<NonNullable<ReturnType<typeof getDatabase>>, '$client'>
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
  const fail = (): never => { throw new Error('Corrupt durable evaluation metrics.') }
  const record = (input: unknown, keys: readonly string[]): Record<string, unknown> => {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return fail()
    const result = input as Record<string, unknown>
    if (Object.keys(result).sort().join(',') !== [...keys].sort().join(',')) return fail()
    return result
  }
  const count = (input: unknown): number => {
    if (typeof input !== 'number' || !Number.isSafeInteger(input) || input < 0) return fail()
    return input
  }
  const metric = (input: unknown, probability = false): void => {
    if (input !== null && (typeof input !== 'number' || !Number.isFinite(input) || input < 0 || probability && input > 1)) fail()
  }
  const binaryNames = ['rocAuc', 'prAuc', 'logLoss', 'brierScore', 'expectedCalibrationError', 'precision', 'recall', 'f1'] as const
  const rankingNames = ['mrr', 'ndcgAt5', 'ndcgAt10', 'precisionAt1', 'precisionAt3', 'recallAt5'] as const
  const metadata = (input: unknown, names: readonly string[], denominator: boolean): void => {
    const entries = record(input, names)
    for (const name of names) { metric(entries[name]); if (denominator && entries[name] !== null) count(entries[name]) }
  }
  const row = record(value, ['validation', 'test', 'siteHoldout', 'queryHoldout', 'temporalHoldout', 'rankingValidation', 'rankingTest', 'rankingTemporalHoldout', 'evaluationScope'])
  if (row.evaluationScope !== 'citation_selection' && row.evaluationScope !== 'structural_auxiliary') fail()
  for (const name of ['validation', 'test', 'siteHoldout', 'queryHoldout', 'temporalHoldout']) {
    const split = record(row[name], ['status', 'positiveCount', 'negativeCount', ...binaryNames, 'confusionMatrix', 'numerators', 'denominators'])
    const positive = count(split.positiveCount), negative = count(split.negativeCount)
    if (split.status !== (positive && negative ? 'ok' : 'insufficient_data')) fail()
    const confusion = record(split.confusionMatrix, ['truePositive', 'falsePositive', 'trueNegative', 'falseNegative'])
    if (count(confusion.truePositive) + count(confusion.falseNegative) !== positive || count(confusion.trueNegative) + count(confusion.falsePositive) !== negative) fail()
    for (const field of binaryNames) {
      metric(split[field], field !== 'logLoss')
      if (['rocAuc', 'prAuc', 'logLoss', 'brierScore', 'expectedCalibrationError'].includes(field) && (split.status === 'ok' ? split[field] === null : split[field] !== null)) fail()
    }
    metadata(split.numerators, binaryNames, false); metadata(split.denominators, binaryNames, true)
  }
  for (const name of ['rankingValidation', 'rankingTest', 'rankingTemporalHoldout']) {
    const split = record(row[name], ['status', 'queryGroupCount', ...rankingNames, 'numerators', 'denominators'])
    const groups = count(split.queryGroupCount)
    if (split.status !== (groups ? 'ok' : 'insufficient_data')) fail()
    for (const field of rankingNames) { metric(split[field], true); if (groups ? split[field] === null : split[field] !== null) fail() }
    metadata(split.numerators, rankingNames, false); metadata(split.denominators, rankingNames, true)
  }
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
  private readonly inTransaction: boolean

  constructor(database: GeoOutcomeDrizzleDatabase | null = getDatabase(), inTransaction = false) {
    if (!database) throw new Error('GEO outcome database is not configured.')
    this.db = database
    this.inTransaction = inTransaction
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
      contentFeatureVector: decodeDurableJson(candidate.contentFeatureVector),
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

  private async readObservation(ownerUserId: number, observationFingerprint: string, revalidateEvidence: boolean, currentRead = false): Promise<OutcomeObservation | null> {
    const candidateQuery = this.db.select().from(geoOutcomeObservationCandidates).where(and(eq(geoOutcomeObservationCandidates.ownerUserId, ownerUserId), eq(geoOutcomeObservationCandidates.observationFingerprint, observationFingerprint))).limit(1)
    const [candidate] = await (currentRead ? candidateQuery.for('update') : candidateQuery)
    if (!candidate) return null
    const runQuery = this.db.select().from(geoOutcomeObservationRuns).where(and(eq(geoOutcomeObservationRuns.ownerUserId, ownerUserId), eq(geoOutcomeObservationRuns.id, candidate.observationRunId))).limit(1)
    const [run] = await (currentRead ? runQuery.for('update') : runQuery)
    if (!run) throw new Error('Dangling observation run.')
    const factsQuery = this.db.select().from(geoOutcomeObservationVerifications).where(and(eq(geoOutcomeObservationVerifications.ownerUserId, ownerUserId), eq(geoOutcomeObservationVerifications.observationFingerprint, observationFingerprint)))
    const facts = await (currentRead ? factsQuery.for('update') : factsQuery)
    const observation = this.mapObservation(run, candidate, facts)
    return revalidateEvidence ? this.revalidateAuthoritativeEvidence(observation, facts) : observation
  }
  async getObservation(ownerUserId: number, observationFingerprint: string): Promise<OutcomeObservation | null> { return this.readObservation(ownerUserId, observationFingerprint, true) }

  async saveObservationTransactional(ownerUserId: number, observation: OutcomeObservation): Promise<OutcomeObservation> {
    if (observation.ownerUserId !== ownerUserId) throw new Error('Owner scope mismatch.')
    assertObservationIsUsable(observation)
    return this.db.transaction(async tx => {
      const repo = new DrizzleGeoOutcomeRepository(tx)
      const runFingerprint = fingerprint({ ownerUserId, projectId: observation.projectId, clientId: observation.clientId, runIdentity: observation.runIdentity, engine: observation.engine, model: observation.model, modelVersion: observation.modelVersion, interface: observation.interface, locale: observation.locale, region: observation.region, observationWindow: observation.observationWindow, runTimestamp: observation.runTimestamp, evidenceSnapshotHash: observation.evidenceSnapshotHash })
      // Serialize first writers on the existing owner/run unique key. A no-op
      // upsert never rewrites evidence, status or immutable run metadata. Do not
      // establish a REPEATABLE READ snapshot before waiting for that row: a
      // duplicate INSERT followed by a plain SELECT can retain the old snapshot.
      try {
        await tx.insert(geoOutcomeObservationRuns).values({ ownerUserId, projectId: observation.projectId, clientId: observation.clientId, runIdentity: observation.runIdentity, engine: observation.engine, model: observation.model, modelVersion: observation.modelVersion, interface: observation.interface, locale: observation.locale, region: observation.region, observationWindowStart: new Date(observation.observationWindow.start), observationWindowEnd: new Date(observation.observationWindow.end), runTimestamp: new Date(observation.runTimestamp), evidenceSnapshotHash: observation.evidenceSnapshotHash, status: 'received', runFingerprint, createdAt: new Date() }).onDuplicateKeyUpdate({ set: { id: sql`${geoOutcomeObservationRuns.id}` } })
      } catch {
        // In particular, never swallow a deadlock/transport failure and continue
        // writing after the server may have rolled back the transaction.
        throw new Error('Observation run persistence failed.')
      }
      const [run] = await tx.select().from(geoOutcomeObservationRuns).where(and(eq(geoOutcomeObservationRuns.ownerUserId, ownerUserId), eq(geoOutcomeObservationRuns.runIdentity, observation.runIdentity))).limit(1).for('update')
      if (!run) throw new Error('Observation run was not persisted.')
      if (run.runFingerprint !== runFingerprint) throw new Error('Observation run identity collision.')
      try {
        await tx.insert(geoOutcomeObservationCandidates).values({ ownerUserId, observationRunId: run.id, websiteIdentityHash: observation.websiteIdentityHash, queryIdentityHash: observation.queryIdentityHash, normalizedQueryHash: observation.normalizedQueryHash, candidatePageIdentityHash: observation.candidatePageIdentityHash, canonicalPageHash: observation.canonicalPageHash, contentHash: observation.contentHash, evidenceSnapshotHash: observation.evidenceSnapshotHash, publicationReceiptFingerprint: observation.publicationReceiptFingerprint, observableStatus: observation.observableStatus, retrievalStatus: observation.retrievalStatus, citationStatus: observation.citationStatus, citationPosition: observation.citationPosition, mentionStatus: observation.mentionStatus, recommendationStatus: observation.recommendationStatus, labelBasis: observation.labelBasis, verificationStatus: 'unverified', consentStatus: 'unknown', piiStatus: 'unknown', verificationAuthority: 'intake', intakeFingerprint: observation.intakeFingerprint, reviewFingerprint: null, observationPayload: { schemaVersion: observation.schemaVersion }, evidenceLocatorHashes: observation.evidenceLocatorHashes, appliedRuleHashes: observation.appliedRuleHashes, contentFeatureVector: encodeDurableJson(observation.contentFeatureVector), observationFingerprint: observation.observationFingerprint, createdAt: new Date() }).onDuplicateKeyUpdate({ set: { id: sql`${geoOutcomeObservationCandidates.id}` } })
      } catch {
        throw new Error('Observation candidate persistence failed.')
      }
      // Also use current reads when an outer idempotency transaction already
      // established a snapshot before another writer committed this candidate.
      // No-op upserts preserve the stored governance and immutable payload.
      const saved = await repo.readObservation(ownerUserId, observation.observationFingerprint, true, true)
      if (!saved) throw new Error('Observation candidate identity collision.')
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
  /** Exact bounded native anchors for private Knowledge bindings; does not approve members or training. */
  async getDatasetsByDatabaseIds(ownerUserId: number, ids: readonly number[]) {
    if (!Number.isSafeInteger(ownerUserId) || ownerUserId < 1 || !Array.isArray(ids) || !ids.length || ids.length > 500 || new Set(ids).size !== ids.length || ids.some(id => !Number.isSafeInteger(id) || id < 1 || id > 2_147_483_647)) throw new Error('Invalid bounded dataset anchor query.')
    const rows = await this.db.select().from(geoOutcomeDatasetManifests).where(and(eq(geoOutcomeDatasetManifests.ownerUserId, ownerUserId), inArray(geoOutcomeDatasetManifests.id, [...ids])))
    return rows.map(row => ({ id: row.id, manifest: this.mapDataset(row) }))
  }
  async getDataset(ownerUserId: number, manifestId: string) { const [row] = await this.db.select().from(geoOutcomeDatasetManifests).where(and(eq(geoOutcomeDatasetManifests.ownerUserId, ownerUserId), eq(geoOutcomeDatasetManifests.manifestId, manifestId))).limit(1); return row ? this.mapDataset(row) : null }
  async readDatasetKnowledgeState(ownerUserId: number, manifestId: string, lock = false): Promise<DatasetKnowledgeState> {
    if (!Number.isSafeInteger(ownerUserId) || ownerUserId <= 0 || typeof manifestId !== 'string' || !manifestId) throw new Error('Invalid dataset knowledge scope.')
    if (lock && !this.inTransaction) throw new Error('Dataset knowledge locks require an active write transaction.')
    if (!this.inTransaction) {
      return this.db.transaction(async tx => new DrizzleGeoOutcomeRepository(tx, true).readDatasetKnowledgeState(ownerUserId, manifestId, lock), lock
        ? { isolationLevel: 'serializable', accessMode: 'read write' }
        : { isolationLevel: 'repeatable read', accessMode: 'read only' })
    }
    const nativeQuery = this.db.select({ id: geoOutcomeDatasetManifests.id }).from(geoOutcomeDatasetManifests)
      .where(and(eq(geoOutcomeDatasetManifests.ownerUserId, ownerUserId), eq(geoOutcomeDatasetManifests.manifestId, manifestId))).limit(1)
    const [nativeRow] = await (lock ? nativeQuery.for('update') : nativeQuery)
    if (!nativeRow) throw new Error('Dataset manifest not found.')
    const dataset = await this.getDataset(ownerUserId, manifestId)
    if (!dataset) throw new Error('Dataset manifest not found.')
    const bindingRepository = new DrizzleKnowledgeConsumerBindingRepository(this.db, lock)
    const readHeads = async () => {
      const rows = await bindingRepository.listBindingHeads(ownerUserId, 2_001)
      if (rows.length > 2_000) throw new Error('Dataset knowledge binding limit exceeded.')
      return rows.filter(row => row.consumerKind === 'geo_dataset' && row.consumerId === nativeRow.id)
    }
    let heads = await readHeads()
    if (lock) {
      const subjects = [...new Map(heads.map(row => [`${row.subjectKind}:${row.subjectId}`, { kind: row.subjectKind, id: row.subjectId }])).values()]
        .sort((a, b) => a.kind.localeCompare(b.kind) || a.id - b.id)
      for (const subject of subjects) await bindingRepository.knowledge.lockRevisionSubject(ownerUserId, subject)
      const after = await readHeads()
      if (fingerprint(heads.map(row => row.bindingFingerprint)) !== fingerprint(after.map(row => row.bindingFingerprint))) throw new Error('Dataset knowledge binding heads changed while locking.')
      heads = after
    }
    const authorities = await bindingRepository.loadAuthorities(ownerUserId, heads)
    const predecessorByFingerprint = authorities.predecessors
    for (const row of heads) {
      assertValidKnowledgeConsumerBinding(row)
      if (row.ownerUserId !== ownerUserId || row.consumerKind !== 'geo_dataset' || row.consumerId !== nativeRow.id) throw new Error('Dataset knowledge binding scope is corrupt.')
      if (row.previousBindingFingerprint !== null) {
        const previous = predecessorByFingerprint.get(row.previousBindingFingerprint)
        if (!previous) throw new Error('Dataset knowledge binding predecessor is missing.')
        assertValidKnowledgeConsumerBinding(previous)
        if (previous.ownerUserId !== ownerUserId || previous.consumerKind !== row.consumerKind || previous.consumerId !== row.consumerId || previous.subjectKind !== row.subjectKind || previous.subjectId !== row.subjectId || previous.sequenceNumber !== row.sequenceNumber - 1 || previous.bindingFingerprint !== row.previousBindingFingerprint) throw new Error('Dataset knowledge binding predecessor is corrupt.')
      } else if (row.sequenceNumber !== 1) throw new Error('Dataset knowledge binding chain is corrupt.')
    }
    const orderedHeads = [...heads].sort((a, b) => a.subjectKind.localeCompare(b.subjectKind) || a.subjectId - b.subjectId)
    const resultHeads: DatasetKnowledgeState['heads'] = []
    for (const row of orderedHeads) {
      const anchor = authorities.anchors.get(`geo_dataset:${nativeRow.id}`)
      if (!anchor || anchor.ownerUserId !== ownerUserId || anchor.consumerKind !== 'geo_dataset' || anchor.consumerId !== nativeRow.id || anchor.consumerVersion !== dataset.manifestFingerprint || anchor.consumerContentHash !== dataset.manifestFingerprint || row.consumerVersion !== dataset.manifestFingerprint || row.consumerContentHash !== dataset.manifestFingerprint) throw new Error('Dataset knowledge native manifest authority is corrupt.')
      const revision = authorities.revisions.get(row.revisionId)
      const event = revision ? authorities.events.get(revision.id) : null
      if (!revision || !event) throw new Error('Dataset knowledge revision lineage is incomplete.')
      assertValidKnowledgeRevision(revision)
      assertValidKnowledgeMutationEvent(event)
      if (revision.ownerUserId !== ownerUserId || revision.subjectKind !== row.subjectKind || revision.subjectId !== row.subjectId || revision.id !== row.revisionId || revision.revisionNumber !== row.revisionNumber || revision.contentHash !== row.revisionContentHash || revision.revisionFingerprint !== row.revisionFingerprint || event.ownerUserId !== ownerUserId || event.subjectKind !== row.subjectKind || event.subjectId !== row.subjectId || event.revisionId !== revision.id || event.revisionNumber !== revision.revisionNumber || event.newRevisionFingerprint !== revision.revisionFingerprint || event.previousRevisionFingerprint !== revision.previousRevisionFingerprint || event.operations.join(',') !== revision.operations.join(',')) throw new Error('Dataset knowledge revision/event lineage is corrupt.')
      let currentRevisionFingerprint: string | null = null
      if (row.operation === 'bind') {
        const current = await bindingRepository.knowledge.getRevisionHead(ownerUserId, { kind: row.subjectKind, id: row.subjectId })
        if (current) {
          assertValidKnowledgeRevision(current)
          const snapshot = await buildKnowledgeRevisionSnapshot(bindingRepository.knowledge, ownerUserId, { kind: row.subjectKind, id: row.subjectId })
          const currentEvent = await bindingRepository.knowledge.getMutationEventForRevision(ownerUserId, current.revisionFingerprint)
          if (!currentEvent) throw new Error('Current Knowledge revision event is missing.')
          assertValidKnowledgeMutationEvent(currentEvent)
          if (currentEvent.ownerUserId !== ownerUserId || currentEvent.subjectKind !== row.subjectKind || currentEvent.subjectId !== row.subjectId || currentEvent.revisionId !== current.id || currentEvent.revisionNumber !== current.revisionNumber || currentEvent.newRevisionFingerprint !== current.revisionFingerprint || currentEvent.previousRevisionFingerprint !== current.previousRevisionFingerprint || currentEvent.operations.join(',') !== current.operations.join(',')) throw new Error('Current Knowledge revision event is corrupt.')
          if (current.id === revision.id && current.revisionFingerprint === revision.revisionFingerprint && snapshot.contentHash === current.contentHash && snapshot.canonicalSnapshot === current.canonicalSnapshot) currentRevisionFingerprint = current.revisionFingerprint
        }
      }
      resultHeads.push({ subjectKind: row.subjectKind, subjectId: row.subjectId, operation: row.operation, sequenceNumber: row.sequenceNumber, bindingFingerprint: row.bindingFingerprint, revisionNumber: row.revisionNumber, revisionContentHash: row.revisionContentHash, revisionFingerprint: row.revisionFingerprint, currentRevisionFingerprint })
    }
    return { ownerUserId, manifestId, manifestFingerprint: dataset.manifestFingerprint, nativeDatasetId: nativeRow.id, heads: resultHeads }
  }
  async getDatasetMembers(ownerUserId: number, manifestId: string) {
    const [dataset] = await this.db.select().from(geoOutcomeDatasetManifests).where(and(eq(geoOutcomeDatasetManifests.ownerUserId, ownerUserId), eq(geoOutcomeDatasetManifests.manifestId, manifestId))).limit(1)
    if (!dataset) return []
    const rows = await this.db.select().from(geoOutcomeDatasetMembers).where(and(eq(geoOutcomeDatasetMembers.ownerUserId, ownerUserId), eq(geoOutcomeDatasetMembers.datasetManifestId, dataset.id)))
    const observations = await this.listObservations(ownerUserId)
    return rows.map((row: GeoOutcomeDatasetMember): DatasetMember => {
      const observation = observations.find(item => item.observationFingerprint === row.observationFingerprint)
      if (!observation) throw new Error('Dangling dataset member.')
      const vector = featureVector(decodeDurableJson(row.featureVector))
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
      // The pure builder uses an epoch placeholder for determinism; creation time is not part of the manifest fingerprint.
      // Persist the server-owned creation time instead of the placeholder, which strict MySQL TIMESTAMP rejects.
      await tx.insert(geoOutcomeDatasetManifests).values({ ownerUserId, manifestId: manifest.manifestId, schemaVersion: manifest.schemaVersion, taskType: manifest.taskType, featureCatalogVersion: manifest.featureCatalogVersion, labelContractVersion: manifest.labelContractVersion, hardNegativePolicyVersion: manifest.hardNegativePolicyVersion, sourceObservationFingerprints: manifest.sourceObservationFingerprints, sourceBasisCounts: manifest.sourceBasisCounts, engineCounts: manifest.engineCounts, localeCounts: manifest.localeCounts, websiteCount: manifest.websiteCount, queryGroupCount: manifest.queryGroupCount, positiveCount: manifest.positiveCount, hardNegativeCount: manifest.hardNegativeCount, observationStart: manifest.observationStart ? new Date(manifest.observationStart) : null, observationEnd: manifest.observationEnd ? new Date(manifest.observationEnd) : null, splitPolicyVersion: manifest.splitPolicyVersion, splitFingerprints: { train: manifest.trainFingerprints, validation: manifest.validationFingerprints, test: manifest.testFingerprints, siteHoldout: manifest.siteHoldoutFingerprints, queryHoldout: manifest.queryHoldoutFingerprints, temporalHoldout: manifest.temporalHoldoutFingerprints }, manifestFingerprint: manifest.manifestFingerprint, limitations: manifest.limitations, readiness: manifest.readiness, status: manifest.status, createdAt: new Date() })
      const [row] = await tx.select().from(geoOutcomeDatasetManifests).where(and(eq(geoOutcomeDatasetManifests.ownerUserId, ownerUserId), eq(geoOutcomeDatasetManifests.manifestId, manifest.manifestId))).limit(1)
      if (!row) throw new Error('Dataset manifest id was not returned.')
      for (const member of members) await tx.insert(geoOutcomeDatasetMembers).values({ ownerUserId, datasetManifestId: row.id, observationFingerprint: member.observationFingerprint, websiteIdentityHash: member.websiteIdentityHash, normalizedQueryHash: member.normalizedQueryHash, runIdentity: member.runIdentity, queryGroupKey: member.queryGroupKey, label: member.label === 1 ? 'positive' : 'hard_negative', splitAssignment: splitKeyToDb(member.splitAssignment || 'train'), consentStatus: member.consentStatus || 'unknown', piiStatus: member.piiStatus || 'unknown', reviewFingerprint: member.reviewFingerprint || null, featureVector: encodeDurableJson(member.featureVector) })
      return repo.mapDataset(row)
    })
  }
  async transitionDatasetWithDecision(ownerUserId: number, manifestId: string, status: DatasetManifest['status'], reviewerUserId: number | null, reason: string, knowledgeAuthority?: DatasetKnowledgeAuthority | null) {
    const work = async (tx: GeoOutcomeDrizzleDatabase) => {
      const repo = new DrizzleGeoOutcomeRepository(tx, true)
      let authority: DatasetKnowledgeAuthority | null = null
      if (status === 'approved') {
        if (!knowledgeAuthority || reviewerUserId !== ownerUserId) throw new Error('Dataset approval requires an explicit owner-reviewed Knowledge authority.')
        assertValidDatasetKnowledgeAuthority(knowledgeAuthority)
        const state = await repo.readDatasetKnowledgeState(ownerUserId, manifestId, true)
        const currentAuthority = buildDatasetKnowledgeAuthority(state, knowledgeAuthority.mode)
        if (fingerprint(currentAuthority) !== fingerprint(knowledgeAuthority)) throw new Error('Dataset Knowledge authority changed before owner approval.')
        authority = knowledgeAuthority
      } else if (knowledgeAuthority != null) throw new Error('Dataset revocation cannot carry Knowledge approval authority.')
      const current = await repo.getDataset(ownerUserId, manifestId)
      if (!current) throw new Error('Dataset manifest not found.')
      if (current.status === 'revoked' || current.status === 'archived') throw new Error('Dataset is terminal and cannot be modified.')
      if (status === 'approved' && current.status !== 'ready_for_review' && current.status !== 'approved') throw new Error('Only ready_for_review or approved datasets may be approved.')
      if (status !== 'approved' && status !== 'revoked') throw new Error('Dataset review may only approve or revoke.')
      const [row] = await tx.select({ id: geoOutcomeDatasetManifests.id }).from(geoOutcomeDatasetManifests).where(and(eq(geoOutcomeDatasetManifests.ownerUserId, ownerUserId), eq(geoOutcomeDatasetManifests.manifestId, manifestId))).limit(1)
      if (!row) throw new Error('Dataset manifest row not found.')
      const decisionData = { ownerUserId, manifestId, previousStatus: current.status, newStatus: status, reviewerUserId, reason, manifestFingerprint: current.manifestFingerprint, ...(authority ? { knowledgeAuthority: authority } : {}) }
      const decisionFingerprint = fingerprint(decisionData)
      const decision: DatasetDecision = { decisionId: `geo-dataset-decision-${decisionFingerprint.slice(0, 20)}`, ...decisionData, createdAt: new Date().toISOString() }
      await tx.insert(geoOutcomeDatasetDecisions).values({ ...decision, knowledgeAuthority: authority, datasetManifestId: row.id, createdAt: new Date(decision.createdAt) })
      const result = await tx.update(geoOutcomeDatasetManifests).set({ status }).where(and(eq(geoOutcomeDatasetManifests.ownerUserId, ownerUserId), eq(geoOutcomeDatasetManifests.manifestId, manifestId), eq(geoOutcomeDatasetManifests.status, current.status)))
      const updatedRows = affectedRows(result)
      if (updatedRows !== 1 && !(updatedRows === 0 && current.status === status)) throw new Error('Dataset decision lost its compare-and-swap.')
      return { manifest: (await repo.getDataset(ownerUserId, manifestId))!, decision }
    }
    return this.inTransaction ? work(this.db) : this.db.transaction(work, { isolationLevel: 'serializable', accessMode: 'read write' })
  }
  async listDatasetDecisions(ownerUserId: number): Promise<DatasetDecision[]> {
    const rows = await this.db.select().from(geoOutcomeDatasetDecisions).where(eq(geoOutcomeDatasetDecisions.ownerUserId, ownerUserId)).orderBy(asc(geoOutcomeDatasetDecisions.id))
    const manifests = await this.db.select({ id: geoOutcomeDatasetManifests.id, manifestId: geoOutcomeDatasetManifests.manifestId, manifestFingerprint: geoOutcomeDatasetManifests.manifestFingerprint }).from(geoOutcomeDatasetManifests).where(eq(geoOutcomeDatasetManifests.ownerUserId, ownerUserId))
    const manifestsByPrimaryKey = new Map(manifests.map(item => [item.id, item]))
    return rows.map((row: GeoOutcomeDatasetDecision): DatasetDecision => {
      const manifest = manifestsByPrimaryKey.get(row.datasetManifestId)
      if (!manifest || manifest.manifestFingerprint !== row.manifestFingerprint) throw new Error('Dangling or corrupt dataset decision manifest lineage.')
      let authority: DatasetKnowledgeAuthority | null = null
      if (row.knowledgeAuthority !== null) {
        assertValidDatasetKnowledgeAuthority(row.knowledgeAuthority)
        authority = row.knowledgeAuthority as DatasetKnowledgeAuthority
        if (authority.ownerUserId !== row.ownerUserId || authority.manifestId !== manifest.manifestId || authority.manifestFingerprint !== row.manifestFingerprint || authority.nativeDatasetId !== manifest.id || row.newStatus !== 'approved' || row.reviewerUserId !== row.ownerUserId) throw new Error('Corrupt durable dataset Knowledge authority lineage.')
      }
      const decisionData = { ownerUserId: row.ownerUserId, manifestId: manifest.manifestId, previousStatus: row.previousStatus, newStatus: row.newStatus, reviewerUserId: row.reviewerUserId, reason: row.reason, manifestFingerprint: row.manifestFingerprint, ...(authority ? { knowledgeAuthority: authority } : {}) }
      const decisionFingerprint = fingerprint(decisionData)
      if (row.decisionId !== `geo-dataset-decision-${decisionFingerprint.slice(0, 20)}`) throw new Error('Corrupt durable dataset decision business id.')
      return { decisionId: row.decisionId, ownerUserId: row.ownerUserId, manifestId: manifest.manifestId, previousStatus: row.previousStatus as DatasetManifest['status'], newStatus: row.newStatus as DatasetManifest['status'], reviewerUserId: row.reviewerUserId, reason: row.reason, manifestFingerprint: row.manifestFingerprint, ...(authority ? { knowledgeAuthority: authority } : {}), createdAt: toIso(row.createdAt)! }
    })
  }

  private async mapTraining(row: GeoOutcomeTrainingRun): Promise<TrainingRun> {
    const [dataset] = await this.db.select({ manifestId: geoOutcomeDatasetManifests.manifestId, manifestFingerprint: geoOutcomeDatasetManifests.manifestFingerprint }).from(geoOutcomeDatasetManifests).where(and(eq(geoOutcomeDatasetManifests.ownerUserId, row.ownerUserId), eq(geoOutcomeDatasetManifests.id, row.datasetManifestId))).limit(1)
    if (!dataset) throw new Error('Dangling training dataset foreign key.')
    const rawConfiguration = row.configuration as unknown
    const isVersioned = Boolean(rawConfiguration && typeof rawConfiguration === 'object' && !Array.isArray(rawConfiguration) && 'schemaVersion' in rawConfiguration)
    const configuration = isVersioned ? rawConfiguration as Record<string, unknown> : null
    const configurationVersion = isVersioned ? String(configuration!.schemaVersion) : null
    const hasApprovalReference = configurationVersion === 'geo-outcome-training-configuration-v4'
    const expectedKeys = hasApprovalReference ? 'config,datasetDecisionId,knowledgeAuthorityFingerprint,rollbackArtifactHash,schemaVersion' : 'config,rollbackArtifactHash,schemaVersion'
    if (isVersioned && (!['geo-outcome-training-configuration-v2', 'geo-outcome-training-configuration-v3', 'geo-outcome-training-configuration-v4'].includes(configurationVersion!) || Object.keys(configuration!).sort().join(',') !== expectedKeys || (configuration!.rollbackArtifactHash !== null && (typeof configuration!.rollbackArtifactHash !== 'string' || !isSha256(configuration!.rollbackArtifactHash))))) throw new Error('Corrupt durable training configuration snapshot.')
    const config = parseTrainingConfig(isVersioned ? decodeDurableJson(configuration!.config, configurationVersion === 'geo-outcome-training-configuration-v3' || hasApprovalReference) : rawConfiguration)
    const rollbackArtifactHash = isVersioned ? configuration!.rollbackArtifactHash as string | null : undefined
    let approvalReference: DatasetKnowledgeApprovalReference | undefined
    if (hasApprovalReference) {
      approvalReference = { datasetDecisionId: configuration!.datasetDecisionId as string, knowledgeAuthorityFingerprint: configuration!.knowledgeAuthorityFingerprint as string }
      assertValidApprovalReference(approvalReference)
    }
    const expectedFingerprint = isVersioned
      ? fingerprint({ ownerUserId: row.ownerUserId, datasetManifestId: dataset.manifestId, modelFamily: row.modelFamily, config, rollbackArtifactHash, ...(approvalReference || {}) })
      : fingerprint({ ownerUserId: row.ownerUserId, datasetManifestId: dataset.manifestId, modelFamily: row.modelFamily, config })
    const expectedTrainingRunId = `geo-training-${expectedFingerprint.slice(0, 20)}`
    if (row.trainingRunId !== expectedTrainingRunId) throw new Error('Corrupt durable training business id.')
    const mapped = { trainingRunId: row.trainingRunId, ownerUserId: row.ownerUserId, datasetManifestId: dataset.manifestId, modelFamily: row.modelFamily, status: row.status, config, ...(isVersioned ? { rollbackArtifactHash } : {}), ...(approvalReference || {}), artifactId: row.artifactId, artifactHash: row.artifactHash, metrics: row.metrics === null ? null : evaluationBundle(decodeDurableJson(row.metrics)), reason: row.reason, createdAt: toIso(row.createdAt)!, startedAt: toIso(row.startedAt), completedAt: toIso(row.completedAt), leaseOwner: row.leaseOwner, leaseExpiresAt: toIso(row.leaseExpiresAt), version: row.version } satisfies TrainingRun
    if (mapped.status === 'running' && (!mapped.leaseOwner || !mapped.leaseExpiresAt || !mapped.startedAt)) throw new Error('Corrupt durable training lease state.')
    if (mapped.status === 'completed' && (!mapped.artifactId || !mapped.artifactHash || !mapped.metrics || !mapped.completedAt)) throw new Error('Corrupt durable completed training state.')
    if (mapped.status === 'queued' && (mapped.artifactId || mapped.artifactHash || mapped.metrics || mapped.completedAt)) throw new Error('Corrupt durable queued training state.')
    if (mapped.status === 'completed') {
      const artifact = await this.getArtifact(row.ownerUserId, mapped.artifactId!)
      if (!artifact || artifact.artifactHash !== mapped.artifactHash || artifact.datasetManifestFingerprint !== dataset.manifestFingerprint || artifact.modelFamily !== mapped.modelFamily || fingerprint(artifact.trainingConfiguration) !== fingerprint(mapped.config) || fingerprint(artifact.evaluationMetrics) !== fingerprint(mapped.metrics) || mapped.rollbackArtifactHash !== undefined && artifact.rollbackArtifactHash !== mapped.rollbackArtifactHash || artifact.datasetDecisionId !== mapped.datasetDecisionId || artifact.knowledgeAuthorityFingerprint !== mapped.knowledgeAuthorityFingerprint) throw new Error('Corrupt durable training artifact or metrics lineage.')
    }
    return mapped
  }
  async createTrainingRun(ownerUserId: number, run: TrainingRun) {
    const [dataset] = await this.db.select({ id: geoOutcomeDatasetManifests.id }).from(geoOutcomeDatasetManifests).where(and(eq(geoOutcomeDatasetManifests.ownerUserId, ownerUserId), eq(geoOutcomeDatasetManifests.manifestId, run.datasetManifestId))).limit(1)
    if (!dataset) throw new Error('Dataset manifest not found.')
    const reference = run.datasetDecisionId !== undefined || run.knowledgeAuthorityFingerprint !== undefined ? { datasetDecisionId: run.datasetDecisionId, knowledgeAuthorityFingerprint: run.knowledgeAuthorityFingerprint } : null
    if (reference) {
      assertValidApprovalReference(reference)
      if (run.rollbackArtifactHash === undefined) throw new Error('New training reservations require an exact rollback snapshot envelope.')
    }
    const configuration = reference
      ? { schemaVersion: 'geo-outcome-training-configuration-v4', config: encodeDurableJson(run.config), rollbackArtifactHash: run.rollbackArtifactHash!, ...reference }
      : run.rollbackArtifactHash === undefined ? run.config : { schemaVersion: 'geo-outcome-training-configuration-v3', config: encodeDurableJson(run.config), rollbackArtifactHash: run.rollbackArtifactHash }
    try { await this.db.insert(geoOutcomeTrainingRuns).values({ ownerUserId, trainingRunId: run.trainingRunId, datasetManifestId: dataset.id, modelFamily: run.modelFamily, status: run.status, startedAt: null, completedAt: null, leaseOwner: null, leaseExpiresAt: null, version: 0, configuration, artifactId: null, artifactHash: null, metrics: null, reason: null, createdAt: new Date(run.createdAt) }) } catch { const replay = await this.getTrainingRun(ownerUserId, run.trainingRunId); if (replay && replay.datasetManifestId === run.datasetManifestId && replay.modelFamily === run.modelFamily && fingerprint(replay.config) === fingerprint(run.config) && replay.rollbackArtifactHash === run.rollbackArtifactHash) return replay; throw new Error('Training run collision.') }
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
    if (patch.metrics !== undefined) update.metrics = patch.metrics === null ? null : encodeDurableJson(patch.metrics)
    if (patch.reason !== undefined) update.reason = patch.reason
    if (patch.config !== undefined) {
      const config = parseTrainingConfig(patch.config)
      update.configuration = current.datasetDecisionId !== undefined && current.knowledgeAuthorityFingerprint !== undefined
        ? { schemaVersion: 'geo-outcome-training-configuration-v4', config: encodeDurableJson(config), rollbackArtifactHash: current.rollbackArtifactHash ?? null, datasetDecisionId: current.datasetDecisionId, knowledgeAuthorityFingerprint: current.knowledgeAuthorityFingerprint }
        : current.rollbackArtifactHash === undefined ? config : { schemaVersion: 'geo-outcome-training-configuration-v3', config: encodeDurableJson(config), rollbackArtifactHash: current.rollbackArtifactHash }
    }
    const result = await this.db.update(geoOutcomeTrainingRuns).set(update).where(and(eq(geoOutcomeTrainingRuns.ownerUserId, ownerUserId), eq(geoOutcomeTrainingRuns.trainingRunId, trainingRunId), eq(geoOutcomeTrainingRuns.version, expectedVersion)))
    if (affectedRows(result) !== 1) throw new Error('Training run transition lost its compare-and-swap.')
    return (await this.getTrainingRun(ownerUserId, trainingRunId))!
  }
  async listTrainingRuns(ownerUserId: number) { const rows = await this.db.select().from(geoOutcomeTrainingRuns).where(eq(geoOutcomeTrainingRuns.ownerUserId, ownerUserId)); return Promise.all(rows.map(row => this.mapTraining(row))) }

  private mapArtifact(row: GeoOutcomeModelArtifact): ModelArtifact {
    const rawTrainingConfiguration = row.trainingConfiguration as unknown
    const storageVersion = rawTrainingConfiguration && typeof rawTrainingConfiguration === 'object' && !Array.isArray(rawTrainingConfiguration) ? (rawTrainingConfiguration as Record<string, unknown>).schemaVersion : null
    const exactStorage = storageVersion === 'geo-outcome-artifact-training-configuration-v3' || storageVersion === 'geo-outcome-artifact-training-configuration-v4'
    const normalization = decodeDurableJson(row.normalizationStatistics, exactStorage) as Record<string, unknown>
    if (!normalization || typeof normalization !== 'object' || Array.isArray(normalization)) throw new Error('Corrupt durable normalization statistics.')
    const normalizationStatistics = { mean: numberArray(normalization.mean, 'normalization mean'), standardDeviation: numberArray(normalization.standardDeviation, 'normalization standard deviation') }
    if (normalizationStatistics.mean.length !== normalizationStatistics.standardDeviation.length || normalizationStatistics.standardDeviation.some(value => value <= 0)) throw new Error('Corrupt durable normalization statistics.')
    const versionedConfiguration = Boolean(rawTrainingConfiguration && typeof rawTrainingConfiguration === 'object' && !Array.isArray(rawTrainingConfiguration) && 'schemaVersion' in rawTrainingConfiguration)
    let trainingConfiguration: TrainingRun['config']
    let intercept: number
    let approvalReference: DatasetKnowledgeApprovalReference | undefined
    if (versionedConfiguration) {
      const envelope = rawTrainingConfiguration as Record<string, unknown>
      const hasApprovalReference = envelope.schemaVersion === 'geo-outcome-artifact-training-configuration-v4'
      const expectedKeys = hasApprovalReference ? 'config,datasetDecisionId,exactIntercept,knowledgeAuthorityFingerprint,schemaVersion' : 'config,exactIntercept,schemaVersion'
      if (!['geo-outcome-artifact-training-configuration-v2', 'geo-outcome-artifact-training-configuration-v3', 'geo-outcome-artifact-training-configuration-v4'].includes(String(envelope.schemaVersion)) || Object.keys(envelope).sort().join(',') !== expectedKeys) throw new Error('Corrupt durable artifact training configuration envelope.')
      if (hasApprovalReference) {
        approvalReference = { datasetDecisionId: envelope.datasetDecisionId as string, knowledgeAuthorityFingerprint: envelope.knowledgeAuthorityFingerprint as string }
        assertValidApprovalReference(approvalReference)
      }
      const exactIntercept = exactStorage ? Number(envelope.exactIntercept) : envelope.exactIntercept
      if (exactStorage && (typeof envelope.exactIntercept !== 'string' || envelope.exactIntercept.length > 64 || String(exactIntercept) !== envelope.exactIntercept)) throw new Error('Corrupt durable exact artifact intercept encoding.')
      if (typeof exactIntercept !== 'number' || !Number.isFinite(exactIntercept) || Math.abs(exactIntercept) > 1_000_000 || Object.is(exactIntercept, -0)) throw new Error('Corrupt durable exact artifact intercept.')
      const expectedMirror = exactIntercept.toFixed(12)
      const storedMirror = String(row.intercept)
      const negativeZeroMirror = Number(expectedMirror) === 0 && storedMirror === '0.000000000000'
      if (storedMirror !== expectedMirror && !negativeZeroMirror) throw new Error('Corrupt durable artifact DECIMAL intercept mirror.')
      intercept = exactIntercept
      trainingConfiguration = parseTrainingConfig(exactStorage ? decodeDurableJson(envelope.config, true) : envelope.config)
    } else {
      if (rawTrainingConfiguration && typeof rawTrainingConfiguration === 'object' && !Array.isArray(rawTrainingConfiguration) && 'schemaVersion' in rawTrainingConfiguration) throw new Error('Unknown durable artifact training configuration marker.')
      intercept = Number(row.intercept)
      trainingConfiguration = parseTrainingConfig(rawTrainingConfiguration)
    }
    const base = { artifactSchemaVersion: row.artifactSchemaVersion, taskType: row.taskType, modelFamily: row.modelFamily, modelVersion: row.modelVersion, featureCatalogVersion: row.featureCatalogVersion, labelContractVersion: row.labelContractVersion, datasetManifestFingerprint: row.datasetManifestFingerprint, splitManifestFingerprint: row.splitManifestFingerprint, coefficients: numberArray(decodeDurableJson(row.coefficients, exactStorage), 'artifact coefficients'), intercept, normalizationStatistics, trainingConfiguration, trainingRowCount: row.trainingRowCount, evaluationMetrics: evaluationBundle(decodeDurableJson(row.evaluationMetrics, exactStorage)), limitations: stringArray(row.limitations, 'artifact limitations'), rollbackArtifactHash: row.rollbackArtifactHash, ...(approvalReference || {}) }
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
    if (!Number.isFinite(artifact.intercept) || Math.abs(artifact.intercept) > 1_000_000 || Object.is(artifact.intercept, -0)) throw new Error('Artifact intercept is outside the durable exact-value bounds.')
    const reference = artifact.datasetDecisionId !== undefined || artifact.knowledgeAuthorityFingerprint !== undefined ? { datasetDecisionId: artifact.datasetDecisionId, knowledgeAuthorityFingerprint: artifact.knowledgeAuthorityFingerprint } : null
    if (reference) assertValidApprovalReference(reference)
    const persist = async (tx: GeoOutcomeDrizzleDatabase) => {
      const repo = new DrizzleGeoOutcomeRepository(tx, true)
      if (reference) {
        const [datasetRow] = await tx.select().from(geoOutcomeDatasetManifests).where(and(eq(geoOutcomeDatasetManifests.ownerUserId, ownerUserId), eq(geoOutcomeDatasetManifests.manifestFingerprint, artifact.datasetManifestFingerprint))).limit(1).for('update')
        if (!datasetRow) throw new Error('Artifact dataset approval lineage is missing.')
        const dataset = repo.mapDataset(datasetRow)
        await assertDatasetKnowledgeAuthorityCurrent(ownerUserId, dataset, repo, reference, true)
      }
      const trainingConfiguration = reference
        ? { schemaVersion: 'geo-outcome-artifact-training-configuration-v4', config: encodeDurableJson(artifact.trainingConfiguration), exactIntercept: String(artifact.intercept), ...reference }
        : { schemaVersion: 'geo-outcome-artifact-training-configuration-v3', config: encodeDurableJson(artifact.trainingConfiguration), exactIntercept: String(artifact.intercept) }
      await tx.insert(geoOutcomeModelArtifacts).values({ ownerUserId, artifactId: artifact.artifactId, artifactSchemaVersion: artifact.artifactSchemaVersion, taskType: artifact.taskType, modelFamily: artifact.modelFamily, modelVersion: artifact.modelVersion, featureCatalogVersion: artifact.featureCatalogVersion, labelContractVersion: artifact.labelContractVersion, datasetManifestFingerprint: artifact.datasetManifestFingerprint, splitManifestFingerprint: artifact.splitManifestFingerprint, coefficients: encodeDurableJson(artifact.coefficients), intercept: artifact.intercept.toFixed(12), normalizationStatistics: encodeDurableJson(artifact.normalizationStatistics), trainingConfiguration, trainingRowCount: artifact.trainingRowCount, evaluationMetrics: encodeDurableJson(artifact.evaluationMetrics), limitations: artifact.limitations, artifactFingerprint: artifact.artifactFingerprint, artifactHash: artifact.artifactHash, rollbackArtifactHash: artifact.rollbackArtifactHash, status: artifact.status, revokedAt: artifact.revokedAt ? new Date(artifact.revokedAt) : null, createdAt: new Date() })
      return (await repo.getArtifact(ownerUserId, artifact.artifactId))!
    }
    return reference && !this.inTransaction ? this.db.transaction(persist, { isolationLevel: 'serializable', accessMode: 'read write' }) : persist(this.db)
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
  async transitionArtifactWithDecision(ownerUserId: number, artifactId: string, nextStatus: ModelArtifact['status'], reviewerUserId: number | null, reason: string, datasetManifestHash: string, rollbackArtifactHash: string | null = null) {
    const transition = async (tx: GeoOutcomeDrizzleDatabase) => {
      const repo = new DrizzleGeoOutcomeRepository(tx, true)
      const artifact = await repo.getArtifact(ownerUserId, artifactId)
      if (!artifact) throw new Error('Artifact not found.')
      if (artifact.status === 'revoked') throw new Error('Revoked models cannot be restored.')
      if (artifact.datasetManifestFingerprint !== datasetManifestHash) throw new Error('Artifact dataset lineage changed before owner decision.')
      if (nextStatus === 'approved_for_shadow') {
        if (reviewerUserId !== null && reviewerUserId !== ownerUserId) throw new Error('Model shadow approval reviewer must be null policy authority or the exact owner.')
        const [datasetRow] = await tx.select().from(geoOutcomeDatasetManifests).where(and(eq(geoOutcomeDatasetManifests.ownerUserId, ownerUserId), eq(geoOutcomeDatasetManifests.manifestFingerprint, artifact.datasetManifestFingerprint))).limit(1).for('update')
        const dataset = datasetRow ? await repo.getDataset(ownerUserId, datasetRow.manifestId) : null
        if (!dataset) throw new Error('Artifact dataset approval lineage is missing.')
        await assertDatasetKnowledgeAuthorityCurrent(ownerUserId, dataset, repo, { datasetDecisionId: artifact.datasetDecisionId!, knowledgeAuthorityFingerprint: artifact.knowledgeAuthorityFingerprint! }, true)
      }
      if (isFallbackOnlyArtifact(artifact)) {
        if (nextStatus !== 'approved_for_shadow' && nextStatus !== 'revoked') throw new Error('Bootstrap fallback status transition is invalid.')
        if (nextStatus === 'approved_for_shadow' && rollbackArtifactHash !== null) throw new Error('Bootstrap fallback cannot point to itself or another rollback artifact.')
        if (nextStatus === 'approved_for_shadow') {
          if (reviewerUserId !== ownerUserId) throw new Error('Bootstrap fallback approval must be recorded as an owner decision.')
          const [datasetRow] = await tx.select().from(geoOutcomeDatasetManifests).where(and(eq(geoOutcomeDatasetManifests.ownerUserId, ownerUserId), eq(geoOutcomeDatasetManifests.manifestFingerprint, artifact.datasetManifestFingerprint))).limit(1).for('update')
          const dataset = datasetRow ? await repo.getDataset(ownerUserId, datasetRow.manifestId) : null
          if (!dataset || dataset.status !== 'approved' || dataset.manifestFingerprint !== datasetManifestHash) throw new Error('Bootstrap fallback dataset is no longer approved.')
          await assertDatasetKnowledgeAuthorityCurrent(ownerUserId, dataset, repo, { datasetDecisionId: artifact.datasetDecisionId!, knowledgeAuthorityFingerprint: artifact.knowledgeAuthorityFingerprint! }, true)
          const approvals = await tx.select().from(geoOutcomeDatasetDecisions).where(and(eq(geoOutcomeDatasetDecisions.ownerUserId, ownerUserId), eq(geoOutcomeDatasetDecisions.datasetManifestId, datasetRow!.id))).orderBy(asc(geoOutcomeDatasetDecisions.id))
          const latestApproval = approvals.at(-1)
          if (!latestApproval || latestApproval.newStatus !== 'approved' || (latestApproval.reviewerUserId !== null && latestApproval.reviewerUserId !== ownerUserId) || latestApproval.manifestFingerprint !== dataset.manifestFingerprint) throw new Error('Bootstrap fallback dataset lacks current durable approval.')
          const members = await repo.getDatasetMembers(ownerUserId, dataset.manifestId)
          if (members.some(member => !canBePrimaryCitationTruth(member.observation)) || !isExactTrainOnlyPriorArtifact(artifact, dataset, members)) throw new Error('Bootstrap fallback no longer matches current approved train-only provenance.')
        }
      } else if (nextStatus === 'approved_for_shadow' && (!artifact.rollbackArtifactHash || rollbackArtifactHash !== artifact.rollbackArtifactHash)) {
        throw new Error('Candidate artifact must retain its immutable approved fallback hash.')
      }
      if (nextStatus === 'approved_for_shadow' && !isFallbackOnlyArtifact(artifact)) {
        const visited = new Set<string>()
        const validateFallbackChain = async (fallback: ModelArtifact): Promise<boolean> => {
          if (visited.size >= 128 || visited.has(fallback.artifactHash) || fallback.ownerUserId !== ownerUserId || fallback.status !== 'approved_for_shadow' || fallback.taskType !== artifact.taskType || fallback.modelFamily !== artifact.modelFamily || fallback.featureCatalogVersion !== artifact.featureCatalogVersion || fallback.labelContractVersion !== artifact.labelContractVersion) return false
          visited.add(fallback.artifactHash)
          const [fallbackRow] = await tx.select().from(geoOutcomeModelArtifacts).where(and(eq(geoOutcomeModelArtifacts.ownerUserId, ownerUserId), eq(geoOutcomeModelArtifacts.artifactId, fallback.artifactId))).limit(1)
          if (!fallbackRow || fallbackRow.artifactHash !== fallback.artifactHash) return false
          const decisions = await tx.select().from(geoOutcomeModelDecisions).where(and(eq(geoOutcomeModelDecisions.ownerUserId, ownerUserId), eq(geoOutcomeModelDecisions.modelArtifactId, fallbackRow.id))).orderBy(asc(geoOutcomeModelDecisions.id))
          const latestDecision = decisions.at(-1)
          if (!latestDecision || latestDecision.newStatus !== 'approved_for_shadow' || (isFallbackOnlyArtifact(fallback) ? latestDecision.reviewerUserId !== ownerUserId : latestDecision.reviewerUserId !== null && latestDecision.reviewerUserId !== ownerUserId) || latestDecision.artifactHash !== fallback.artifactHash || latestDecision.datasetManifestHash !== fallback.datasetManifestFingerprint) return false
          const [fallbackDatasetRow] = await tx.select().from(geoOutcomeDatasetManifests).where(and(eq(geoOutcomeDatasetManifests.ownerUserId, ownerUserId), eq(geoOutcomeDatasetManifests.manifestFingerprint, fallback.datasetManifestFingerprint))).limit(1).for('update')
          const fallbackDataset = fallbackDatasetRow ? await repo.getDataset(ownerUserId, fallbackDatasetRow.manifestId) : null
          if (!fallbackDataset || fallbackDataset.status !== 'approved') return false
          try { await assertDatasetKnowledgeAuthorityCurrent(ownerUserId, fallbackDataset, repo, { datasetDecisionId: fallback.datasetDecisionId!, knowledgeAuthorityFingerprint: fallback.knowledgeAuthorityFingerprint! }, true) } catch { return false }
          const datasetDecisions = await tx.select().from(geoOutcomeDatasetDecisions).where(and(eq(geoOutcomeDatasetDecisions.ownerUserId, ownerUserId), eq(geoOutcomeDatasetDecisions.datasetManifestId, fallbackDatasetRow!.id))).orderBy(asc(geoOutcomeDatasetDecisions.id))
          const latestDatasetDecision = datasetDecisions.at(-1)
          if (!latestDatasetDecision || latestDatasetDecision.newStatus !== 'approved' || latestDatasetDecision.reviewerUserId !== null && latestDatasetDecision.reviewerUserId !== ownerUserId || latestDatasetDecision.manifestFingerprint !== fallbackDataset.manifestFingerprint) return false
          const fallbackMembers = await repo.getDatasetMembers(ownerUserId, fallbackDataset.manifestId)
          if (fallbackMembers.some(member => !canBePrimaryCitationTruth(member.observation))) return false
          if (isFallbackOnlyArtifact(fallback)) {
            if (latestDecision.reviewerUserId !== ownerUserId || !isExactTrainOnlyPriorArtifact(fallback, fallbackDataset, fallbackMembers)) return false
            return evaluatePromotionGate({ dataset: fallbackDataset, members: fallbackMembers, artifact: fallback, ownerApproved: true, rollbackArtifact: null, target: 'shadow', shadowReadiness: getShadowReadiness({ candidates: fallbackDataset.sourceObservationFingerprints.length, queryGroups: fallbackDataset.queryGroupCount, websites: fallbackDataset.websiteCount, engines: Object.keys(fallbackDataset.engineCounts).length, positives: fallbackDataset.positiveCount, hardNegatives: fallbackDataset.hardNegativeCount, observationSpanDays: fallbackDataset.observationStart && fallbackDataset.observationEnd ? Math.floor((Date.parse(fallbackDataset.observationEnd) - Date.parse(fallbackDataset.observationStart)) / 86_400_000) : null, temporalHoldoutCount: fallbackDataset.temporalHoldoutRowCount, hasPrimaryEvidence: Boolean(fallbackDataset.sourceBasisCounts.manual_verified_primary || fallbackDataset.sourceBasisCounts.consumer_surface_observed) }) }).status === 'pass'
          }
          if (!fallback.rollbackArtifactHash || fallback.rollbackArtifactHash === fallback.artifactHash) return false
          const [parentRow] = await tx.select().from(geoOutcomeModelArtifacts).where(and(eq(geoOutcomeModelArtifacts.ownerUserId, ownerUserId), eq(geoOutcomeModelArtifacts.artifactHash, fallback.rollbackArtifactHash))).limit(1)
          const parent = parentRow ? await repo.getArtifact(ownerUserId, parentRow.artifactId) : null
          if (!parent || !await validateFallbackChain(parent)) return false
          return evaluatePromotionGate({ dataset: fallbackDataset, members: fallbackMembers, artifact: fallback, ownerApproved: true, rollbackArtifact: parent, target: 'shadow', shadowReadiness: getShadowReadiness({ candidates: fallbackDataset.sourceObservationFingerprints.length, queryGroups: fallbackDataset.queryGroupCount, websites: fallbackDataset.websiteCount, engines: Object.keys(fallbackDataset.engineCounts).length, positives: fallbackDataset.positiveCount, hardNegatives: fallbackDataset.hardNegativeCount, observationSpanDays: fallbackDataset.observationStart && fallbackDataset.observationEnd ? Math.floor((Date.parse(fallbackDataset.observationEnd) - Date.parse(fallbackDataset.observationStart)) / 86_400_000) : null, temporalHoldoutCount: fallbackDataset.temporalHoldoutRowCount, hasPrimaryEvidence: Boolean(fallbackDataset.sourceBasisCounts.manual_verified_primary || fallbackDataset.sourceBasisCounts.consumer_surface_observed) }) }).status === 'pass'
        }
        const [fallbackRow] = await tx.select().from(geoOutcomeModelArtifacts).where(and(eq(geoOutcomeModelArtifacts.ownerUserId, ownerUserId), eq(geoOutcomeModelArtifacts.artifactHash, rollbackArtifactHash || ''))).limit(1)
        const fallback = fallbackRow ? await repo.getArtifact(ownerUserId, fallbackRow.artifactId) : null
        if (!fallback || fallback.artifactHash === artifact.artifactHash || !await validateFallbackChain(fallback)) throw new Error('Bound fallback chain is no longer durably approved, compatible, and gate-valid.')
      }
      const [artifactRow] = await tx.select({ id: geoOutcomeModelArtifacts.id }).from(geoOutcomeModelArtifacts).where(and(eq(geoOutcomeModelArtifacts.ownerUserId, ownerUserId), eq(geoOutcomeModelArtifacts.artifactId, artifactId))).limit(1)
      if (!artifactRow) throw new Error('Artifact row not found.')
      const decision: ModelDecision = { decisionId: `geo-decision-${fingerprint({ ownerUserId, artifactId, previousStatus: artifact.status, newStatus: nextStatus, reason, artifactHash: artifact.artifactHash }).slice(0, 20)}`, ownerUserId, modelArtifactId: artifactId, previousStatus: artifact.status, newStatus: nextStatus, reviewerUserId, reason, artifactHash: artifact.artifactHash, datasetManifestHash, createdAt: new Date().toISOString() }
      await tx.insert(geoOutcomeModelDecisions).values({ ...decision, modelArtifactId: artifactRow.id, createdAt: new Date(decision.createdAt) })
      const result = await tx.update(geoOutcomeModelArtifacts).set({ status: nextStatus, revokedAt: nextStatus === 'revoked' ? new Date() : null }).where(and(eq(geoOutcomeModelArtifacts.ownerUserId, ownerUserId), eq(geoOutcomeModelArtifacts.artifactId, artifactId), eq(geoOutcomeModelArtifacts.status, artifact.status)))
      if (affectedRows(result) !== 1) throw new Error('Artifact decision lost its compare-and-swap.')
      return { artifact: (await repo.getArtifact(ownerUserId, artifactId))!, decision }
    }
    return this.inTransaction ? transition(this.db) : this.db.transaction(async tx => transition(tx), { isolationLevel: 'serializable', accessMode: 'read write' })
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
  async transaction<T>(work: (repository: GeoOutcomeRepositoryPort) => Promise<T>): Promise<T> { return this.inTransaction ? work(this) : this.db.transaction(async (tx): Promise<T> => work(new DrizzleGeoOutcomeRepository(tx, true)), { isolationLevel: 'serializable', accessMode: 'read write' }) }
}

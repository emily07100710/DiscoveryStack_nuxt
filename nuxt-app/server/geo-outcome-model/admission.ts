import { and, desc, eq, lt } from 'drizzle-orm'
import {
  geoOutcomeCandidateAuthorities,
  geoOutcomeCandidateSetDecisions,
  geoOutcomeObservationCandidates,
  geoOutcomeObservationRuns,
  llmVisibilityObservations,
  llmVisibilityQueries,
  llmVisibilityRuns,
} from '../database/schema'
import { assertPublicHttpsUrl } from '../content-operations/normalization'
import { canonicalCitationUrlSet, canonicalCandidateIdentity, GeoCandidateAuthorityError, resolveCandidateAuthority, resolveReviewedManualSnapshot } from './candidate-authority'
import { authoritativeGeoRunIdentity, authoritativeLocatorFingerprint } from './evidence-resolver'
import { GEO_OUTCOME_SCHEMA_VERSION } from './constants'
import { fingerprint, isSha256 } from './canonical'
import { getAdmissionFeatureProjection, type AdmissionFeatureProjection } from './admission-feature-projection'
import { assertObservationIsUsable } from './observation-contract'
import { normalizeManualObservation } from './normalization'
import { getDatabase } from '../database'
import { DrizzleGeoOutcomeRepository, type GeoOutcomeDrizzleDatabase } from './repository-drizzle'
import {
  admissionIntakeSchema,
  admissionWorkspaceQuerySchema,
  GEO_ADMISSION_MAX_CANDIDATES,
  GEO_ADMISSION_PAGE_SIZE,
  type AdmissionCandidateAuthoritySummary,
  type AdmissionFeatureOrigin,
  type AdmissionIntakeInput,
  type AdmissionIntakeResponse,
  type AdmissionObservationSummary,
  type AdmissionSelectedSource,
  type AdmissionSourceSummary,
  type AdmissionWorkspace,
} from './admission-types'
import type { OutcomeObservation } from './types'

const ADMISSION_ROUTE = 'geo-outcome-model.admission.intake'
const GEO_BODY_KEYS = new Set(['idempotencyKey', 'sourceRecordId', 'candidateUrl'])

export class GeoAdmissionError extends Error {
  constructor(readonly statusCode: 400 | 404 | 409 | 422 | 503, readonly statusMessage: string, readonly code: string) {
    super(statusMessage)
    this.name = 'GeoAdmissionError'
  }
}

function storageUnavailable(): GeoAdmissionError {
  return new GeoAdmissionError(503, 'GEO admission storage is unavailable.', 'storage_unavailable')
}

function safeIso(value: Date | string): string {
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) throw new GeoAdmissionError(409, 'Selected evidence is unavailable for admission.', 'source_unavailable')
  return date.toISOString()
}

function cursorFor(id: number): string { return `s_${Buffer.from(String(id), 'utf8').toString('base64url')}` }
function idFromCursor(cursor: string): number {
  if (!/^s_[A-Za-z0-9_-]{1,24}$/u.test(cursor)) throw new GeoAdmissionError(422, 'Admission cursor is invalid.', 'invalid_cursor')
  const decoded = Buffer.from(cursor.slice(2), 'base64url').toString('utf8')
  const id = Number(decoded)
  if (!/^[1-9]\d*$/u.test(decoded) || !Number.isSafeInteger(id) || id <= 0 || cursorFor(id) !== cursor) throw new GeoAdmissionError(422, 'Admission cursor is invalid.', 'invalid_cursor')
  return id
}

export function parseAdmissionWorkspaceQuery(input: unknown): { cursor?: string, sourceRecordId?: number } {
  const parsed = admissionWorkspaceQuerySchema.safeParse(input)
  if (!parsed.success) throw new GeoAdmissionError(422, 'Admission query is invalid.', 'invalid_query')
  if (parsed.data.cursor) idFromCursor(parsed.data.cursor)
  if (parsed.data.cursor && parsed.data.sourceRecordId) throw new GeoAdmissionError(422, 'Admission query is invalid.', 'invalid_query')
  return { ...(parsed.data.cursor ? { cursor: parsed.data.cursor } : {}), ...(parsed.data.sourceRecordId ? { sourceRecordId: Number(parsed.data.sourceRecordId) } : {}) }
}

export function parseAdmissionIntake(input: unknown): AdmissionIntakeInput {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new GeoAdmissionError(400, 'Request body must be an object.', 'invalid_body')
  for (const key of Object.keys(input)) if (!GEO_BODY_KEYS.has(key)) throw new GeoAdmissionError(422, 'Admission request contains an unsupported field.', 'unknown_field')
  const parsed = admissionIntakeSchema.safeParse(input)
  if (!parsed.success) throw new GeoAdmissionError(422, 'Admission request is invalid.', 'invalid_input')
  try { assertPublicHttpsUrl(parsed.data.candidateUrl, 'Candidate URL') } catch { throw new GeoAdmissionError(422, 'Candidate URL must be a public HTTPS URL.', 'invalid_candidate_url') }
  return { ...parsed.data, candidateUrl: assertPublicHttpsUrl(parsed.data.candidateUrl, 'Candidate URL') }
}

function blockCode(error: unknown): string {
  const message = error instanceof Error ? error.message : ''
  if (message.includes('current durable owner approval')) return 'source_review_required'
  if (message.includes('Provider or incomplete source')) return 'consumer_surface_review_required'
  if (message.includes('not found for this owner')) return 'source_unavailable'
  if (message.includes('candidate') || message.includes('Candidate')) return 'candidate_set_required'
  return 'source_provenance_unavailable'
}

async function checkedSource(database: GeoOutcomeDrizzleDatabase, ownerUserId: number, sourceRecordId: number) {
  try {
    const snapshot = await resolveReviewedManualSnapshot(database, ownerUserId, sourceRecordId)
    return { snapshot, reasonCodes: [] as string[] }
  } catch (error) {
    if (!(error instanceof GeoCandidateAuthorityError)) throw storageUnavailable()
    return { snapshot: null, reasonCodes: [blockCode(error)] }
  }
}

function missingFeatureCount(observation: OutcomeObservation): number {
  const feature = observation.contentFeatureVector
  return [
    feature.contentType === 'other', feature.locale === 'unknown', feature.pageAgeBucket === 'unknown', feature.contentLengthBucket === 'unknown', feature.headingHierarchy === 'unknown',
    feature.directAnswerPresence === 'unknown', feature.faqStructure === 'unknown', feature.structuredDataPresence === 'unknown', feature.citationMarkerCount === null,
    feature.approvedAuthoritySourceCount === null, feature.evidenceUtilizationRatio === null, feature.entityCoverage === null, feature.selectedAutoGeoRuleHashes.length === 0,
    feature.appliedAutoGeoRuleHashes.length === 0, feature.canonicalFlag === 'unknown', feature.indexabilityFlag === 'unknown', feature.internalLinkDepthBucket === 'unknown',
    feature.contentFreshnessBucket === 'unknown', feature.queryPageLexicalOverlap === null, feature.topicClusterEqual === 'unknown', feature.verifiedPublicationAgeDays === null,
    feature.priorObservationCount === null,
  ].filter(Boolean).length
}

function observationSummary(observation: OutcomeObservation, featureOrigin: AdmissionFeatureOrigin = 'unknown_external'): AdmissionObservationSummary {
  return {
    observationFingerprint: observation.observationFingerprint,
    candidatePageIdentityHash: observation.candidatePageIdentityHash,
    contentHash: observation.contentHash,
    citationStatus: observation.citationStatus === 'cited' || observation.citationStatus === 'not_cited' ? observation.citationStatus : 'unknown',
    citationPosition: observation.citationPosition,
    verificationStatus: observation.verificationStatus,
    consentStatus: observation.consentStatus,
    piiStatus: observation.piiStatus,
    featureOrigin,
    missingFeatureCount: missingFeatureCount(observation),
  }
}

export function persistedFeatureOrigin(observation: Pick<OutcomeObservation, 'contentFeatureVector'>, projection: AdmissionFeatureProjection): AdmissionFeatureOrigin {
  return fingerprint(projection.features) === fingerprint(observation.contentFeatureVector) ? projection.featureOrigin : 'unknown_external'
}

async function readFeatureProjection(database: GeoOutcomeDrizzleDatabase, ownerUserId: number, resolved: Awaited<ReturnType<typeof resolveCandidateAuthority>>): Promise<AdmissionFeatureProjection> {
  try { return await getAdmissionFeatureProjection(database, ownerUserId, resolved) } catch {
    throw new GeoAdmissionError(503, 'GEO admission storage is unavailable.', 'storage_unavailable')
  }
}

type ReviewedManualSnapshot = Awaited<ReturnType<typeof resolveReviewedManualSnapshot>>

function ambiguousObservation(candidate: { observationFingerprint: string, candidatePageIdentityHash: string, contentHash: string, citationStatus: string }): AdmissionObservationSummary {
  return {
    observationFingerprint: candidate.observationFingerprint,
    candidatePageIdentityHash: candidate.candidatePageIdentityHash,
    contentHash: candidate.contentHash,
    citationStatus: candidate.citationStatus === 'cited' || candidate.citationStatus === 'not_cited' ? candidate.citationStatus : 'unknown',
    citationPosition: null,
    verificationStatus: 'ambiguous',
    consentStatus: 'unknown',
    piiStatus: 'unknown',
    featureOrigin: 'unknown_external',
    missingFeatureCount: 22,
  }
}

async function readExistingObservations(database: GeoOutcomeDrizzleDatabase, ownerUserId: number, source: ReviewedManualSnapshot): Promise<Map<string, AdmissionObservationSummary>> {
  const { run: sourceRun, source: sourceRow, project, query, citations } = source
  const runProjection = { id: geoOutcomeObservationRuns.id, projectId: geoOutcomeObservationRuns.projectId, clientId: geoOutcomeObservationRuns.clientId, runIdentity: geoOutcomeObservationRuns.runIdentity, engine: geoOutcomeObservationRuns.engine, model: geoOutcomeObservationRuns.model, modelVersion: geoOutcomeObservationRuns.modelVersion, interface: geoOutcomeObservationRuns.interface, locale: geoOutcomeObservationRuns.locale, region: geoOutcomeObservationRuns.region, observationWindowStart: geoOutcomeObservationRuns.observationWindowStart, observationWindowEnd: geoOutcomeObservationRuns.observationWindowEnd, runTimestamp: geoOutcomeObservationRuns.runTimestamp, evidenceSnapshotHash: geoOutcomeObservationRuns.evidenceSnapshotHash }
  const [legacyRuns, sourceScopedRuns] = await Promise.all([
    database.select(runProjection).from(geoOutcomeObservationRuns)
      .where(and(eq(geoOutcomeObservationRuns.ownerUserId, ownerUserId), eq(geoOutcomeObservationRuns.runIdentity, sourceRun.requestFingerprint), eq(geoOutcomeObservationRuns.evidenceSnapshotHash, sourceRow.responseHash))).limit(1),
    database.select(runProjection).from(geoOutcomeObservationRuns)
      .where(and(eq(geoOutcomeObservationRuns.ownerUserId, ownerUserId), eq(geoOutcomeObservationRuns.runIdentity, authoritativeGeoRunIdentity(sourceRow.id, sourceRun.requestFingerprint)), eq(geoOutcomeObservationRuns.evidenceSnapshotHash, sourceRow.responseHash))).limit(1),
  ])
  const runs = [...legacyRuns, ...sourceScopedRuns].filter((row, index, rows) => rows.findIndex(item => item.id === row.id) === index)
  if (runs.length > GEO_ADMISSION_MAX_CANDIDATES) throw new GeoAdmissionError(409, 'Admission history exceeds the safe source limit.', 'source_history_too_large')
  if (!runs.length) return new Map()
  let expectedAt: string
  try { expectedAt = safeIso(sourceRun.observedAt) } catch { return new Map() }
  const locatorHash = authoritativeLocatorFingerprint({ sourceRecordId: sourceRow.id, sourceProjectId: project.id, sourceQueryId: query.id, sourceRunId: sourceRun.id, sourceResponseHash: sourceRow.responseHash, evidenceLocator: sourceRow.evidenceLocator, sourceObservedAt: expectedAt })
  const candidateProjection = {
    observationRunId: geoOutcomeObservationCandidates.observationRunId,
    observationFingerprint: geoOutcomeObservationCandidates.observationFingerprint,
    candidatePageIdentityHash: geoOutcomeObservationCandidates.candidatePageIdentityHash,
    contentHash: geoOutcomeObservationCandidates.contentHash,
    citationStatus: geoOutcomeObservationCandidates.citationStatus,
    queryIdentityHash: geoOutcomeObservationCandidates.queryIdentityHash,
    normalizedQueryHash: geoOutcomeObservationCandidates.normalizedQueryHash,
    evidenceSnapshotHash: geoOutcomeObservationCandidates.evidenceSnapshotHash,
    evidenceLocatorHashes: geoOutcomeObservationCandidates.evidenceLocatorHashes,
    publicationReceiptFingerprint: geoOutcomeObservationCandidates.publicationReceiptFingerprint,
    websiteIdentityHash: geoOutcomeObservationCandidates.websiteIdentityHash,
    canonicalPageHash: geoOutcomeObservationCandidates.canonicalPageHash,
  }
  const candidates = (await Promise.all(runs.map(run => database.select(candidateProjection).from(geoOutcomeObservationCandidates)
    .where(and(eq(geoOutcomeObservationCandidates.ownerUserId, ownerUserId), eq(geoOutcomeObservationCandidates.observationRunId, run.id)))
    .limit(GEO_ADMISSION_MAX_CANDIDATES + 1)))).flat()
  if (candidates.length > GEO_ADMISSION_MAX_CANDIDATES) throw new GeoAdmissionError(409, 'Admission history exceeds the safe source limit.', 'source_history_too_large')
  const result = new Map<string, AdmissionObservationSummary>()
  const repository = new DrizzleGeoOutcomeRepository(database)
  const citationPositions = new Map(citations.map((item, index) => [item.candidatePageIdentityHash, index + 1]))
  for (const candidate of candidates) {
    const candidateLocatorHashes = Array.isArray(candidate.evidenceLocatorHashes) ? candidate.evidenceLocatorHashes : []
    // Rows from another source observation in the same provider run are not
    // ambiguous for this source and must not shadow its candidate identity.
    if (!candidateLocatorHashes.includes(locatorHash)) continue
    const prior = result.get(candidate.candidatePageIdentityHash)
    if (prior) {
      result.set(candidate.candidatePageIdentityHash, ambiguousObservation(candidate))
      continue
    }
    const run = runs.find(item => item.id === candidate.observationRunId)
    let exactRun = false
    try {
      exactRun = Boolean(run && run.projectId === project.id && run.clientId === null
        && run.engine === (sourceRun.provider === 'manual_other' ? 'other' : sourceRun.provider)
        && run.model === sourceRun.modelLabel && run.modelVersion === null && run.interface === 'consumer_surface'
        && run.locale === query.locale && run.region === null
        && safeIso(run.observationWindowStart) === expectedAt && safeIso(run.observationWindowEnd) === expectedAt && safeIso(run.runTimestamp) === expectedAt)
    } catch { /* Corrupt run timestamps are a same-source ambiguity. */ }
    if (!exactRun || candidate.queryIdentityHash !== query.promptHash || candidate.normalizedQueryHash !== query.promptHash || candidate.evidenceSnapshotHash !== sourceRow.responseHash) {
      result.set(candidate.candidatePageIdentityHash, ambiguousObservation(candidate))
      continue
    }
    let current: OutcomeObservation | null = null
    let resolved: Awaited<ReturnType<typeof resolveCandidateAuthority>> | null = null
    try {
      current = await repository.getObservation(ownerUserId, candidate.observationFingerprint)
      const mismatch = !current || current.projectId !== project.id || current.queryIdentityHash !== query.promptHash || current.normalizedQueryHash !== query.promptHash
        || (current.runIdentity !== sourceRun.requestFingerprint && current.runIdentity !== authoritativeGeoRunIdentity(sourceRow.id, sourceRun.requestFingerprint))
        || current.evidenceSnapshotHash !== sourceRow.responseHash || current.runTimestamp !== expectedAt
        || current.engine !== (sourceRun.provider === 'manual_other' ? 'other' : sourceRun.provider) || current.model !== sourceRun.modelLabel || current.locale !== query.locale
        || !current.evidenceLocatorHashes.includes(locatorHash) || current.candidatePageIdentityHash !== candidate.candidatePageIdentityHash
        || current.canonicalPageHash !== candidate.canonicalPageHash || current.contentHash !== candidate.contentHash
        || current.publicationReceiptFingerprint !== candidate.publicationReceiptFingerprint
        || current.websiteIdentityHash !== candidate.websiteIdentityHash
        || current.citationPosition !== (citationPositions.get(candidate.candidatePageIdentityHash) || null)
        || current.citationStatus !== (citationPositions.has(candidate.candidatePageIdentityHash) ? 'cited' : 'not_cited')
      if (mismatch) {
        result.set(candidate.candidatePageIdentityHash, ambiguousObservation(candidate))
        continue
      }
      resolved = await resolveCandidateAuthority(database, ownerUserId, sourceRow.id, candidate.candidatePageIdentityHash)
      if (resolved.authority.contentHash !== candidate.contentHash || resolved.authority.canonicalPageHash !== candidate.canonicalPageHash
        || resolved.authority.websiteIdentityHash !== candidate.websiteIdentityHash || resolved.authority.publicationReceiptFingerprint !== candidate.publicationReceiptFingerprint) {
        result.set(candidate.candidatePageIdentityHash, ambiguousObservation(candidate))
        continue
      }
    } catch (error) {
      if (!(error instanceof GeoCandidateAuthorityError)) throw storageUnavailable()
      result.set(candidate.candidatePageIdentityHash, ambiguousObservation(candidate))
      continue
    }
    if (!current || !resolved) {
      result.set(candidate.candidatePageIdentityHash, ambiguousObservation(candidate))
      continue
    }
    const projection = await readFeatureProjection(database, ownerUserId, resolved)
    const origin = persistedFeatureOrigin(current, projection)
    result.set(candidate.candidatePageIdentityHash, observationSummary(current, origin))
  }
  return result
}

async function currentSourceDecisions(database: GeoOutcomeDrizzleDatabase, ownerUserId: number, sourceRecordId: number) {
  const decisions = await database.select().from(geoOutcomeCandidateSetDecisions)
    .where(and(eq(geoOutcomeCandidateSetDecisions.ownerUserId, ownerUserId), eq(geoOutcomeCandidateSetDecisions.sourceObservationId, sourceRecordId)))
    .orderBy(desc(geoOutcomeCandidateSetDecisions.createdAt), desc(geoOutcomeCandidateSetDecisions.id))
    .limit(GEO_ADMISSION_MAX_CANDIDATES + 1)
  if (decisions.length > GEO_ADMISSION_MAX_CANDIDATES) throw new GeoAdmissionError(409, 'Candidate-set history exceeds the safe source limit.', 'candidate_history_too_large')
  return decisions
}

function sourceSummary(input: { sourceRecordId: number, provider: string, model: string, locale: string, observedAt: Date | string, responseHash: string, citationCount: number, reasonCodes: string[] }): AdmissionSourceSummary {
  let observedAt = ''
  try { observedAt = safeIso(input.observedAt) } catch { /* corrupt source timestamps stay blocked and redacted */ }
  const reasonCodes = [...input.reasonCodes]
  if (!observedAt) reasonCodes.push('source_provenance_unavailable')
  return { ...input, observedAt, eligible: reasonCodes.length === 0, reasonCodes: [...new Set(reasonCodes)] }
}

async function buildSourceSummary(database: GeoOutcomeDrizzleDatabase, ownerUserId: number, row: typeof llmVisibilityObservations.$inferSelect): Promise<AdmissionSourceSummary> {
  const [run] = await database.select().from(llmVisibilityRuns).where(and(eq(llmVisibilityRuns.id, row.runId), eq(llmVisibilityRuns.ownerUserId, ownerUserId))).limit(1)
  if (!run) return sourceSummary({ sourceRecordId: row.id, provider: 'other', model: 'unavailable', locale: 'unknown', observedAt: row.createdAt, responseHash: row.responseHash, citationCount: 0, reasonCodes: ['source_unavailable'] })
  const [query] = await database.select({ locale: llmVisibilityQueries.locale }).from(llmVisibilityQueries).where(and(eq(llmVisibilityQueries.id, row.queryId), eq(llmVisibilityQueries.ownerUserId, ownerUserId))).limit(1)
  let citationCount = 0
  try { citationCount = canonicalCitationUrlSet(row.citationUrls).length } catch { /* malformed source is shown blocked without exposing its payload */ }
  const checked = await checkedSource(database, ownerUserId, row.id)
  const reasonCodes = [...checked.reasonCodes]
  if (run.observationMode !== 'manual_verified' || run.status !== 'completed') reasonCodes.push('consumer_surface_review_required')
  return sourceSummary({ sourceRecordId: row.id, provider: run.provider, model: run.modelLabel, locale: query?.locale || 'unknown', observedAt: run.observedAt, responseHash: row.responseHash, citationCount, reasonCodes })
}

async function collectGeoObservationAdmissionWorkspace(ownerUserId: number, input: unknown, database: GeoOutcomeDrizzleDatabase): Promise<AdmissionWorkspace> {
  if (!Number.isSafeInteger(ownerUserId) || ownerUserId <= 0) throw new GeoAdmissionError(422, 'Owner scope is invalid.', 'invalid_owner')
  const query = parseAdmissionWorkspaceQuery(input)
  let rows: Array<typeof llmVisibilityObservations.$inferSelect>
  if (query.sourceRecordId) {
    rows = await database.select().from(llmVisibilityObservations)
      .where(and(eq(llmVisibilityObservations.ownerUserId, ownerUserId), eq(llmVisibilityObservations.id, query.sourceRecordId))).limit(1)
  } else {
    const conditions = [eq(llmVisibilityObservations.ownerUserId, ownerUserId)]
    if (query.cursor) conditions.push(lt(llmVisibilityObservations.id, idFromCursor(query.cursor)))
    rows = await database.select().from(llmVisibilityObservations).where(and(...conditions))
      .orderBy(desc(llmVisibilityObservations.id)).limit(GEO_ADMISSION_PAGE_SIZE + 1)
  }
  const hasMore = !query.sourceRecordId && rows.length > GEO_ADMISSION_PAGE_SIZE
  const page = hasMore ? rows.slice(0, GEO_ADMISSION_PAGE_SIZE) : rows
  const sources = await Promise.all(page.map(row => buildSourceSummary(database, ownerUserId, row)))
  const nextCursor = hasMore && page.length ? cursorFor(page.at(-1)!.id) : null
  if (!query.sourceRecordId) return { sources, nextCursor, selectedSource: null }

  const selectedRow = rows[0]
  if (!selectedRow) return { sources: [], nextCursor: null, selectedSource: null }
  const [run] = await database.select().from(llmVisibilityRuns)
    .where(and(eq(llmVisibilityRuns.id, selectedRow.runId), eq(llmVisibilityRuns.ownerUserId, ownerUserId))).limit(1)
  if (!run) return { sources, nextCursor, selectedSource: null }
  const summary = sources[0] || await buildSourceSummary(database, ownerUserId, selectedRow)
  const checked = await checkedSource(database, ownerUserId, selectedRow.id)
  const observations = checked.snapshot ? await readExistingObservations(database, ownerUserId, checked.snapshot) : new Map<string, AdmissionObservationSummary>()
  let citations: AdmissionSelectedSource['citations'] = []
  if (checked.snapshot) {
    citations = checked.snapshot.citations.map((item, index) => ({
      candidateUrl: item.canonicalUrl,
      candidatePageIdentityHash: item.candidatePageIdentityHash,
      citationPosition: index + 1,
      observation: observations.get(item.candidatePageIdentityHash) || null,
    }))
  }
  const decisions = await currentSourceDecisions(database, ownerUserId, selectedRow.id)
  const authorities = await database.select().from(geoOutcomeCandidateAuthorities)
    .where(and(eq(geoOutcomeCandidateAuthorities.ownerUserId, ownerUserId), eq(geoOutcomeCandidateAuthorities.sourceObservationId, selectedRow.id)))
    .orderBy(desc(geoOutcomeCandidateAuthorities.createdAt), desc(geoOutcomeCandidateAuthorities.id))
    .limit(GEO_ADMISSION_MAX_CANDIDATES + 1)
  if (authorities.length > GEO_ADMISSION_MAX_CANDIDATES) throw new GeoAdmissionError(409, 'Candidate authorities exceed the safe source limit.', 'candidate_history_too_large')
  const activeApprovals = decisions.filter(item => item.decisionType === 'approve' && !decisions.some(revoke => revoke.decisionType === 'revoke' && revoke.candidateSetFingerprint === item.candidateSetFingerprint))
  const activeSetFingerprints = new Set(activeApprovals.map(item => item.candidateSetFingerprint))
  const citationPosition = new Map((checked.snapshot?.citations || []).map((citation, index) => [citation.canonicalCandidateUrlHash, index + 1]))
  const candidateAuthorities: AdmissionCandidateAuthoritySummary[] = []
  let staleCandidateAuthority = false
  if (checked.snapshot) {
    for (const row of authorities.filter(item => activeSetFingerprints.has(item.candidateSetFingerprint))) {
      try {
        const resolved = await resolveCandidateAuthority(database, ownerUserId, selectedRow.id, row.candidatePageIdentityHash)
        if (resolved.authority.id !== row.id || resolved.authority.contentHash !== row.contentHash || resolved.authority.canonicalPageHash !== row.canonicalPageHash
          || resolved.authority.websiteIdentityHash !== row.websiteIdentityHash || resolved.authority.publicationReceiptFingerprint !== row.publicationReceiptFingerprint) {
          staleCandidateAuthority = true
          continue
        }
        candidateAuthorities.push({
          candidatePageIdentityHash: row.candidatePageIdentityHash,
          canonicalPageHash: row.canonicalPageHash,
          websiteIdentityHash: row.websiteIdentityHash,
          candidateSetFingerprint: row.candidateSetFingerprint,
          authorityBasis: row.authorityBasis,
          citationStatus: citationPosition.has(row.canonicalCandidateUrlHash) ? 'cited' : 'not_cited',
          observation: observations.get(row.candidatePageIdentityHash) || null,
        })
      } catch (error) {
        if (!(error instanceof GeoCandidateAuthorityError)) throw storageUnavailable()
        staleCandidateAuthority = true
      }
    }
  }
  const candidateSets = decisions.map(row => ({
    decisionId: row.decisionId,
    candidateSetFingerprint: row.candidateSetFingerprint,
    decision: row.decisionType,
    memberCount: authorities.filter(authority => authority.candidateSetFingerprint === row.candidateSetFingerprint).length,
    createdAt: safeIso(row.createdAt),
  }))
  const ambiguousCandidateObservation = candidateAuthorities.some(item => item.observation?.verificationStatus === 'ambiguous')
  const reasonCodes = [...checked.reasonCodes]
  if (!summary.eligible) reasonCodes.push(...summary.reasonCodes)
  if (staleCandidateAuthority) reasonCodes.push('candidate_authority_stale')
  if (ambiguousCandidateObservation) reasonCodes.push('observation_identity_ambiguous')
  if (run.observationMode !== 'manual_verified' || run.status !== 'completed') reasonCodes.push('consumer_surface_review_required')
  const selectedSource: AdmissionSelectedSource = {
    ...sourceSummary({ sourceRecordId: selectedRow.id, provider: run.provider, model: run.modelLabel, locale: summary.locale, observedAt: run.observedAt, responseHash: selectedRow.responseHash, citationCount: citations.length, reasonCodes }),
    citations,
    candidateSets,
    candidateAuthorities,
    intakeEnabled: summary.eligible && reasonCodes.length === 0 && activeApprovals.length > 0 && candidateAuthorities.length > 0,
  }
  return { sources, nextCursor, selectedSource }
}

export async function getGeoObservationAdmissionWorkspace(ownerUserId: number, input: unknown, database: GeoOutcomeDrizzleDatabase): Promise<AdmissionWorkspace> {
  if (!Number.isSafeInteger(ownerUserId) || ownerUserId <= 0) throw new GeoAdmissionError(422, 'Owner scope is invalid.', 'invalid_owner')
  parseAdmissionWorkspaceQuery(input)
  const appDatabase = database as NonNullable<ReturnType<typeof getDatabase>>
  try {
    return await appDatabase.transaction(transaction => collectGeoObservationAdmissionWorkspace(ownerUserId, input, transaction), {
      isolationLevel: 'repeatable read',
      withConsistentSnapshot: true,
      accessMode: 'read only',
    })
  } catch (error) {
    if (error instanceof GeoAdmissionError) throw error
    throw storageUnavailable()
  }
}

function observationInput(resolved: Awaited<ReturnType<typeof resolveCandidateAuthority>>, canonicalCandidateUrlHash: string, candidatePageIdentityHash: string, features: AdmissionFeatureProjection['features']) {
  const source = resolved.source
  const citedIndex = source.citations.findIndex(item => item.canonicalCandidateUrlHash === canonicalCandidateUrlHash)
  const cited = citedIndex >= 0
  const observedAt = safeIso(source.run.observedAt)
  const locatorHash = authoritativeLocatorFingerprint({
    sourceRecordId: source.source.id,
    sourceProjectId: source.project.id,
    sourceQueryId: source.query.id,
    sourceRunId: source.run.id,
    sourceResponseHash: source.source.responseHash,
    evidenceLocator: source.source.evidenceLocator,
    sourceObservedAt: observedAt,
  })
  return {
    schemaVersion: GEO_OUTCOME_SCHEMA_VERSION,
    projectId: source.project.id,
    clientId: null,
    websiteIdentityHash: resolved.authority.websiteIdentityHash,
    queryIdentityHash: source.query.promptHash,
    normalizedQueryHash: source.query.promptHash,
    candidatePageIdentityHash,
    canonicalPageHash: resolved.authority.canonicalPageHash,
    contentHash: resolved.authority.contentHash,
    evidenceSnapshotHash: source.source.responseHash,
    publicationReceiptFingerprint: resolved.authority.publicationReceiptFingerprint,
    engine: source.run.provider === 'manual_other' ? 'other' : source.run.provider,
    model: source.run.modelLabel,
    modelVersion: null,
    interface: 'consumer_surface',
    locale: source.query.locale,
    region: null,
    runIdentity: authoritativeGeoRunIdentity(source.source.id, source.run.requestFingerprint),
    runTimestamp: observedAt,
    observationWindow: { start: observedAt, end: observedAt },
    observableStatus: 'observable',
    retrievalStatus: 'retrieved',
    citationStatus: cited ? 'cited' : 'not_cited',
    citationPosition: cited ? citedIndex + 1 : null,
    mentionStatus: 'unknown',
    recommendationStatus: 'unknown',
    labelBasis: 'manual_verified_primary',
    verificationStatus: 'unverified',
    evidenceLocatorHashes: [locatorHash],
    appliedRuleHashes: [],
    contentFeatureVector: features,
  }
}

function validReplay(value: unknown, sourceRecordId: number, candidatePageIdentityHash: string): value is AdmissionIntakeResponse['observation'] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const row = value as Record<string, unknown>
  const expectedKeys = ['observationFingerprint', 'candidatePageIdentityHash', 'contentHash', 'citationStatus', 'citationPosition', 'verificationStatus', 'consentStatus', 'piiStatus', 'featureOrigin', 'missingFeatureCount', 'sourceRecordId', 'governanceIndependent', 'trainingAdmission', 'productionActivation', 'replayed']
  if (Object.keys(row).length !== expectedKeys.length || expectedKeys.some(key => !Object.hasOwn(row, key))) return false
  return isSha256(row.observationFingerprint) && row.candidatePageIdentityHash === candidatePageIdentityHash && isSha256(row.contentHash)
    && row.sourceRecordId === sourceRecordId
    && (row.citationStatus === 'cited' || row.citationStatus === 'not_cited' || row.citationStatus === 'unknown')
    && (row.citationPosition === null || (Number.isSafeInteger(row.citationPosition) && Number(row.citationPosition) > 0))
    && row.verificationStatus === 'unverified' && row.consentStatus === 'unknown' && row.piiStatus === 'unknown'
    && (row.featureOrigin === 'exact_publication_draft' || row.featureOrigin === 'unknown_external')
    && Number.isSafeInteger(row.missingFeatureCount) && Number(row.missingFeatureCount) >= 0 && Number(row.missingFeatureCount) <= 22
    && row.governanceIndependent === true && row.trainingAdmission === false && row.productionActivation === false && row.replayed === false
}

export async function admitGeoObservation(ownerUserId: number, input: unknown, database: GeoOutcomeDrizzleDatabase): Promise<AdmissionIntakeResponse> {
  if (!Number.isSafeInteger(ownerUserId) || ownerUserId <= 0) throw new GeoAdmissionError(422, 'Owner scope is invalid.', 'invalid_owner')
  const command = parseAdmissionIntake(input)
  const canonicalUrl = command.candidateUrl
  const identity = canonicalCandidateIdentity(canonicalUrl)
  const inputFingerprint = fingerprint({ sourceRecordId: command.sourceRecordId, candidateUrl: canonicalUrl })
  try {
    return await database.transaction(async transaction => {
      const repository = new DrizzleGeoOutcomeRepository(transaction, true)
      const claim = await repository.claimMutation(ownerUserId, ADMISSION_ROUTE, command.idempotencyKey, inputFingerprint)
      if (claim.outcome === 'collision') throw new GeoAdmissionError(409, 'Idempotency key conflicts with a different admission request.', 'idempotency_collision')
      if (claim.outcome === 'in_progress') throw new GeoAdmissionError(409, 'Admission request is already in progress.', 'idempotency_in_progress')
      if (claim.outcome === 'replay') {
        if (!validReplay(claim.claim.responseProjection, command.sourceRecordId, identity.candidatePageIdentityHash)) throw new GeoAdmissionError(409, 'Stored admission replay is unavailable.', 'invalid_replay')
        return { status: 'success', observation: { ...claim.claim.responseProjection, replayed: true } }
      }
      let resolved: Awaited<ReturnType<typeof resolveCandidateAuthority>>
      try { resolved = await resolveCandidateAuthority(transaction, ownerUserId, command.sourceRecordId, identity.candidatePageIdentityHash) } catch (error) {
        if (!(error instanceof GeoCandidateAuthorityError)) throw storageUnavailable()
        throw new GeoAdmissionError(409, 'Source or candidate authority is not currently eligible for admission.', 'authority_not_eligible')
      }
      if (resolved.authority.canonicalCandidateUrlHash !== identity.canonicalCandidateUrlHash || resolved.authority.candidatePageIdentityHash !== identity.candidatePageIdentityHash) throw new GeoAdmissionError(409, 'Candidate URL does not match the approved source candidate.', 'authority_mismatch')
      const existingSourceObservations = await readExistingObservations(transaction, ownerUserId, resolved.source)
      if (existingSourceObservations.has(identity.candidatePageIdentityHash)) {
        throw new GeoAdmissionError(409, 'An observation already exists for this exact source and candidate.', 'observation_already_exists')
      }
      const featureProjection = await readFeatureProjection(transaction, ownerUserId, resolved)
      const normalized = normalizeManualObservation(observationInput(resolved, identity.canonicalCandidateUrlHash, identity.candidatePageIdentityHash, featureProjection.features), ownerUserId)
      assertObservationIsUsable(normalized)
      const stored = await repository.saveObservationTransactional(ownerUserId, normalized)
      if (stored.verificationStatus !== 'unverified' || stored.consentStatus !== 'unknown' || stored.piiStatus !== 'unknown') throw new GeoAdmissionError(409, 'An observation with this exact identity already has separate governance decisions.', 'observation_already_governed')
      const matchingProjectionOrigin = persistedFeatureOrigin(stored, featureProjection)
      const summary = observationSummary(stored, matchingProjectionOrigin)
      const response: AdmissionIntakeResponse['observation'] = {
        ...summary,
        sourceRecordId: command.sourceRecordId,
        governanceIndependent: true,
        trainingAdmission: false,
        productionActivation: false,
        replayed: false,
      }
      await repository.completeMutation(ownerUserId, ADMISSION_ROUTE, command.idempotencyKey, inputFingerprint, response)
      return { status: 'success', observation: response }
    })
  } catch (error) {
    if (error instanceof GeoAdmissionError) throw error
    throw storageUnavailable()
  }
}

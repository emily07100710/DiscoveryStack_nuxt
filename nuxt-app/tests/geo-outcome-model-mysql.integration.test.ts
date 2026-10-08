import { createHash, randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { and, eq } from 'drizzle-orm'
import { drizzle, type MySql2Database } from 'drizzle-orm/mysql2'
import { createPool, type Pool } from 'mysql2/promise'
import {
  geoOutcomeObservationCandidates,
  llmVisibilityObservations,
  llmVisibilityProjects,
  llmVisibilityQueries,
  llmVisibilityRuns,
  users,
} from '../server/database/schema'
import { reviewCandidateSet, canonicalCandidateIdentity } from '../server/geo-outcome-model/candidate-authority'
import { authoritativeLocatorFingerprint } from '../server/geo-outcome-model/evidence-resolver'
import { decodeDurableJson, encodeDurableJson } from '../server/geo-outcome-model/durable-json'
import { normalizeManualObservation } from '../server/geo-outcome-model/normalization'
import { buildCitationSelectionDataset } from '../server/geo-outcome-model/dataset-builder'
import { DrizzleGeoOutcomeRepository, type GeoOutcomeDrizzleDatabase } from '../server/geo-outcome-model/repository-drizzle'
import {
  approveBootstrapFallback,
  bindAndVerifyObservationEvidence,
  buildDataset,
  createBootstrapFallback,
  createTrainingRun,
  executeTrainingRun,
  predict,
  reviewDataset,
  reviewModel,
  resolveApprovedFallbackForArtifact,
  verifyObservation,
} from '../server/geo-outcome-model/service'
import { canBePrimaryCitationTruth } from '../server/geo-outcome-model/observation-contract'
import { reviewVisibilityObservation } from '../server/llm-visibility/repository'

const optedIn = process.env.DS_RUN_GEO_OUTCOME_MYSQL_INTEGRATION === '1'
const explicitUrl = process.env.DS_GEO_OUTCOME_MYSQL_URL
const mysqlDescribe = optedIn ? describe : describe.skip
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const FIXTURE_GROUP_COUNT = 500
const DEVELOPMENT_GROUP_COUNT = 100

function dedicatedUrl(raw: string | undefined): URL {
  if (!raw) throw new Error('Opt-in GEO outcome SQL test requires DS_GEO_OUTCOME_MYSQL_URL.')
  let url: URL
  try { url = new URL(raw) } catch { throw new Error('GEO outcome SQL test URL is invalid.') }
  const port = Number(url.port || 3306)
  if (url.protocol !== 'mysql:' || url.hostname !== '127.0.0.1' || !Number.isSafeInteger(port) || port < 20000 || port > 65535 || !/^\/ds_geo_outcome_[a-z0-9_]+$/u.test(url.pathname) || url.search || url.hash) {
    throw new Error('GEO outcome SQL test is restricted to mysql://127.0.0.1:<random-port>/ds_geo_outcome_<suffix>.')
  }
  return url
}

function rawObservation(input: {
  status: 'cited' | 'not_cited'
  projectId: number
  provider: 'chatgpt' | 'gemini' | 'perplexity'
  modelLabel: string
  runIdentity: string
  promptHash: string
  responseHash: string
  locatorHash: string
  observedAt: string
  candidateUrl: string
  contentHash: string
}) {
  const cited = input.status === 'cited'
  const identity = canonicalCandidateIdentity(input.candidateUrl)
  return {
    schemaVersion: 'geo-outcome-observation-v1',
    projectId: input.projectId,
    clientId: null,
    websiteIdentityHash: identity.websiteIdentityHash,
    queryIdentityHash: input.promptHash,
    normalizedQueryHash: input.promptHash,
    candidatePageIdentityHash: identity.candidatePageIdentityHash,
    canonicalPageHash: identity.canonicalPageHash,
    contentHash: input.contentHash,
    evidenceSnapshotHash: input.responseHash,
    publicationReceiptFingerprint: null,
    engine: input.provider,
    model: input.modelLabel,
    modelVersion: 'synthetic-consumer-model-v1',
    interface: 'consumer_surface',
    locale: 'en',
    region: 'US',
    runIdentity: input.runIdentity,
    runTimestamp: input.observedAt,
    observationWindow: {
      start: input.observedAt,
      end: new Date(Date.parse(input.observedAt) + 60 * 60_000).toISOString(),
    },
    observableStatus: 'observable',
    retrievalStatus: 'retrieved',
    citationStatus: input.status,
    citationPosition: cited ? 1 : null,
    mentionStatus: cited ? 'mentioned' : 'not_mentioned',
    recommendationStatus: 'unknown',
    labelBasis: 'manual_verified_primary',
    verificationStatus: 'unverified',
    evidenceLocatorHashes: [input.locatorHash],
    appliedRuleHashes: [],
    contentFeatureVector: {
      contentType: 'article',
      locale: 'en',
      pageAgeBucket: '8_30d',
      contentLengthBucket: cited ? 'l' : 's',
      headingHierarchy: cited ? 'structured' : 'flat',
      directAnswerPresence: cited ? 'present' : 'absent',
      faqStructure: 'absent',
      structuredDataPresence: cited ? 'present' : 'absent',
      citationMarkerCount: cited ? 3 : 0,
      approvedAuthoritySourceCount: cited ? 2 : 0,
      evidenceUtilizationRatio: cited ? 0.8 : 0.1,
      entityCoverage: cited ? 0.8 : 0.1,
      selectedAutoGeoRuleHashes: [],
      appliedAutoGeoRuleHashes: [],
      canonicalFlag: 'valid',
      indexabilityFlag: 'indexable',
      internalLinkDepthBucket: '1',
      contentFreshnessBucket: 'fresh',
      queryPageLexicalOverlap: cited ? 0.8 : 0.1,
      topicClusterEqual: 'yes',
      verifiedPublicationAgeDays: 10,
      priorObservationCount: 1,
    },
  }
}

type SourceIds = { queryId: number; runId: number; sourceObservationId: number; observedAt: string; promptHash: string; runIdentity: string; responseHash: string; modelLabel: string; provider: 'chatgpt' | 'gemini' | 'perplexity'; citedUrl: string; uncitedUrl: string; citedContentHash: string; uncitedContentHash: string }

let pool: Pool | undefined
let secondPool: Pool | undefined
let restartPool: Pool | undefined
let database: MySql2Database | undefined
let repository: DrizzleGeoOutcomeRepository | undefined
let secondRepository: DrizzleGeoOutcomeRepository | undefined
let restartRepository: DrizzleGeoOutcomeRepository | undefined
let ownerUserId: number
let otherOwnerUserId: number
let projectId: number
let sourceGroups: SourceIds[] = []
let developmentManifestId: string
let developmentFallbackArtifactId: string
let developmentCandidateFingerprints: string[] = []
let trainedManifestId: string
let trainedFallbackArtifactId: string
let trainedArtifactId: string
let trainedRunId: string
let trainedArtifactHash: string
let trainedArtifactIntercept: number
let trainedArtifactCoefficients: number[] = []
let citedObservationFingerprints: string[] = []
let predictionInput: unknown
let fixtureReady = false
const fixtureOwners = new Set<number>()

const guardedTables = [
  'users', 'llmVisibilityProjects', 'llmVisibilityQueries', 'llmVisibilityRuns', 'llmVisibilityObservations', 'llmVisibilityObservationReviews',
  'geoOutcomeObservationRuns', 'geoOutcomeObservationCandidates', 'geoOutcomeObservationVerifications', 'geoOutcomeEvidenceLocators',
  'geoOutcomeCandidateSetDecisions', 'geoOutcomeCandidateAuthorities', 'geoOutcomeDatasetManifests', 'geoOutcomeDatasetMembers', 'geoOutcomeDatasetDecisions',
  'geoOutcomeTrainingRuns', 'geoOutcomeModelArtifacts', 'geoOutcomeModelDecisions', 'geoOutcomeIdempotencyClaims',
] as const

async function assertSyntheticSchemaIsEmpty() {
  for (const tableName of guardedTables) {
    const [rows] = await pool!.query(`SELECT COUNT(*) AS rowCount FROM \`${tableName}\``) as [Array<{ rowCount: number | string }>, unknown]
    if (Number(rows[0]?.rowCount) !== 0) throw new Error(`Disposable GEO outcome database must have no rows in ${tableName}.`)
  }
}

async function insertUser(label: string): Promise<number> {
  const inserted = await database!.insert(users).values({ openId: `geo-it-${label}-${randomUUID()}` })
  const id = Number(inserted[0].insertId)
  fixtureOwners.add(id)
  return id
}

async function createProject(ownerId: number): Promise<number> {
  const inserted = await database!.insert(llmVisibilityProjects).values({
    ownerUserId: ownerId,
    name: 'Synthetic GEO SQL fixture',
    canonicalWebsiteUrl: 'https://brand-fixture.acme.com/',
    canonicalDomain: 'acme.com',
    locale: 'en',
    brandName: 'Fixture Brand',
    brandAliases: [],
    competitorBrands: [],
    status: 'active',
  })
  return Number(inserted[0].insertId)
}

async function seedSourceGroup(index: number): Promise<SourceIds> {
  const provider = (['chatgpt', 'gemini', 'perplexity'] as const)[index % 3]!
  const modelLabel = `synthetic-${provider}-manual-v1`
  const observedAt = new Date(Date.UTC(2025, 0, 1 + index)).toISOString()
  const promptHash = hash(`synthetic-query-${index}`)
  const runIdentity = hash(`synthetic-consumer-run-${index}`)
  const responseHash = hash(`synthetic-consumer-response-${index}`)
  const citedUrl = `https://brand-${index}.acme.com/geo/cited`
  const uncitedUrl = `https://candidate-${index}.acme.net/geo/uncited`
  const citedContentHash = hash(`synthetic-content-${index}-cited`)
  const uncitedContentHash = hash(`synthetic-content-${index}-uncited`)

  const queryInsert = await database!.insert(llmVisibilityQueries).values({
    ownerUserId,
    projectId,
    promptText: `Synthetic query group ${index}`,
    promptHash,
    intent: 'synthetic evidence fixture',
    locale: 'en',
    active: true,
  })
  const queryId = Number(queryInsert[0].insertId)
  const runInsert = await database!.insert(llmVisibilityRuns).values({
    ownerUserId,
    projectId,
    provider,
    modelLabel,
    observationMode: 'manual_verified',
    status: 'completed',
    observedAt: new Date(observedAt),
    requestFingerprint: runIdentity,
    limitationCode: 'synthetic_sql_integration_fixture',
  })
  const runId = Number(runInsert[0].insertId)
  const sourceInsert = await database!.insert(llmVisibilityObservations).values({
    ownerUserId,
    projectId,
    runId,
    queryId,
    brandMentioned: true,
    exactMentionCount: 1,
    firstMentionPosition: 1,
    citedDomain: new URL(citedUrl).hostname,
    citationUrls: [citedUrl],
    competitorMentions: {},
    boundedExcerpt: 'Synthetic bounded evidence excerpt; not a real provider response.',
    responseHash,
    evidenceLocator: `synthetic-evidence://geo-sql/${index}`,
    reviewerNote: 'Synthetic fixture owner review only.',
    verifiedByOwner: true,
  })
  const sourceObservationId = Number(sourceInsert[0].insertId)
  const source: SourceIds = { queryId, runId, sourceObservationId, observedAt, promptHash, runIdentity, responseHash, modelLabel, provider, citedUrl, uncitedUrl, citedContentHash, uncitedContentHash }

  await reviewVisibilityObservation(ownerUserId, ownerUserId, sourceObservationId, {
    idempotencyKey: `geo-it-source-review-${index}`,
    decision: 'approve',
    reason: 'Synthetic source evidence reviewed for SQL integration only.',
  }, database as unknown as GeoOutcomeDrizzleDatabase)
  await reviewCandidateSet(database as unknown as GeoOutcomeDrizzleDatabase, ownerUserId, ownerUserId, {
    idempotencyKey: `geo-it-candidate-set-${index}`,
    sourceRecordId: sourceObservationId,
    decision: 'approve',
    reason: 'Synthetic complete observable candidate set for SQL integration only.',
    candidates: [
      { candidateUrl: citedUrl, contentHash: citedContentHash },
      { candidateUrl: uncitedUrl, contentHash: uncitedContentHash },
    ],
  })
  return source
}

async function seedOutcomePair(index: number, source: SourceIds) {
  const locatorHash = authoritativeLocatorFingerprint({
    sourceRecordId: source.sourceObservationId,
    sourceProjectId: projectId,
    sourceQueryId: source.queryId,
    sourceRunId: source.runId,
    sourceResponseHash: source.responseHash,
    evidenceLocator: `synthetic-evidence://geo-sql/${index}`,
    sourceObservedAt: source.observedAt,
  })
  const pair = await Promise.all([
    ['cited', source.citedUrl, source.citedContentHash] as const,
    ['not_cited', source.uncitedUrl, source.uncitedContentHash] as const,
  ].map(async ([status, candidateUrl, contentHash]) => {
    const observation = normalizeManualObservation(rawObservation({
      status,
      projectId,
      provider: source.provider,
      modelLabel: source.modelLabel,
      runIdentity: source.runIdentity,
      promptHash: source.promptHash,
      responseHash: source.responseHash,
      locatorHash,
      observedAt: source.observedAt,
      candidateUrl,
      contentHash,
    }), ownerUserId)
    const stored = await repository!.saveObservationTransactional(ownerUserId, observation)
    await bindAndVerifyObservationEvidence(ownerUserId, stored.observationFingerprint, ownerUserId, source.sourceObservationId, 'Synthetic authoritative evidence binding.', repository)
    await verifyObservation(ownerUserId, stored.observationFingerprint, ownerUserId, 'approve_consent', 'Synthetic independent consent fixture.', repository)
    await verifyObservation(ownerUserId, stored.observationFingerprint, ownerUserId, 'approve_pii', 'Synthetic independent PII review fixture.', repository)
    return stored
  }))
  citedObservationFingerprints.push(pair[0]!.observationFingerprint)
  return pair
}

async function seedThrough(groupCount: number) {
  for (let index = sourceGroups.length + 1; index <= groupCount; index += 1) {
    const source = await seedSourceGroup(index)
    sourceGroups.push(source)
    await seedOutcomePair(index, source)
  }
}

async function cleanupSyntheticRows() {
  if (!pool || !fixtureOwners.size) return
  const ownerIds = [...fixtureOwners]
  const marks = ownerIds.map(() => '?').join(',')
  const rows = [
    ['geoOutcomeEvidenceLocators', 'ownerUserId'],
    ['geoOutcomeCandidateAuthorities', 'ownerUserId'],
    ['geoOutcomeCandidateSetDecisions', 'ownerUserId'],
    ['geoOutcomeModelDecisions', 'ownerUserId'],
    ['geoOutcomeTrainingRuns', 'ownerUserId'],
    ['geoOutcomeModelArtifacts', 'ownerUserId'],
    ['geoOutcomeDatasetDecisions', 'ownerUserId'],
    ['geoOutcomeDatasetMembers', 'ownerUserId'],
    ['geoOutcomeDatasetManifests', 'ownerUserId'],
    ['geoOutcomeObservationVerifications', 'ownerUserId'],
    ['geoOutcomeIdempotencyClaims', 'ownerUserId'],
    ['geoOutcomeObservationCandidates', 'ownerUserId'],
    ['geoOutcomeObservationRuns', 'ownerUserId'],
    ['llmVisibilityObservationReviews', 'ownerUserId'],
    ['llmVisibilityObservations', 'ownerUserId'],
    ['llmVisibilityRuns', 'ownerUserId'],
    ['llmVisibilityQueries', 'ownerUserId'],
    ['llmVisibilityProjects', 'ownerUserId'],
  ] as const
  for (const [tableName, ownerColumn] of rows) await pool.execute(`DELETE FROM \`${tableName}\` WHERE \`${ownerColumn}\` IN (${marks})`, ownerIds)
  await pool.execute(`DELETE FROM users WHERE id IN (${marks})`, ownerIds)
}

mysqlDescribe('GEO outcome model real MySQL integration (explicit disposable localhost only)', () => {
  beforeAll(async () => {
    if (!optedIn) return
    const url = dedicatedUrl(explicitUrl)
    pool = createPool({ host: url.hostname, port: Number(url.port || 3306), user: decodeURIComponent(url.username), password: decodeURIComponent(url.password), database: url.pathname.slice(1), connectionLimit: 8, timezone: 'Z' })
    secondPool = createPool({ host: url.hostname, port: Number(url.port || 3306), user: decodeURIComponent(url.username), password: decodeURIComponent(url.password), database: url.pathname.slice(1), connectionLimit: 4, timezone: 'Z' })
    const [isolationRows] = await pool.query('SELECT @@GLOBAL.transaction_isolation AS globalIsolation, @@SESSION.transaction_isolation AS sessionIsolation') as [Array<{ globalIsolation: string; sessionIsolation: string }>, unknown]
    expect(isolationRows).toEqual([{ globalIsolation: 'REPEATABLE-READ', sessionIsolation: 'REPEATABLE-READ' }])
    await assertSyntheticSchemaIsEmpty()
    database = drizzle(pool, { mode: 'default' })
    const secondDatabase = drizzle(secondPool, { mode: 'default' })
    repository = new DrizzleGeoOutcomeRepository(database as unknown as GeoOutcomeDrizzleDatabase)
    secondRepository = new DrizzleGeoOutcomeRepository(secondDatabase as unknown as GeoOutcomeDrizzleDatabase)
    fixtureReady = true
    ownerUserId = await insertUser('owner')
    otherOwnerUserId = await insertUser('other-owner')
    projectId = await createProject(ownerUserId)
  }, 30_000)

  afterAll(async () => {
    try {
      if (fixtureReady) await cleanupSyntheticRows()
    } finally {
      await Promise.all([pool?.end(), secondPool?.end(), restartPool?.end()])
      pool = undefined
      secondPool = undefined
      restartPool = undefined
      repository = undefined
      secondRepository = undefined
      restartRepository = undefined
    }
  })

  it('rolls back actual observation-run and candidate INSERTs when the surrounding MySQL transaction fails', async () => {
    const observedAt = new Date(Date.UTC(2025, 0, 1)).toISOString()
    const runIdentity = hash('rollback-run')
    const promptHash = hash('rollback-query')
    const responseHash = hash('rollback-response')
    const candidateUrl = 'https://rollback-fixture.acme.com/path'
    const locatorHash = hash('rollback-locator')
    const candidate = normalizeManualObservation(rawObservation({ status: 'cited', projectId, provider: 'chatgpt', modelLabel: 'synthetic-rollback-model', runIdentity, promptHash, responseHash, locatorHash, observedAt, candidateUrl, contentHash: hash('rollback-content') }), ownerUserId)
    let observedInsertedRowInsideTransaction = false
    const rollbackDatabase = {
      transaction<T>(work: (transaction: GeoOutcomeDrizzleDatabase) => Promise<T>) {
        return database!.transaction(async transaction => {
          await work(transaction as unknown as GeoOutcomeDrizzleDatabase)
          const rows = await transaction.select().from(geoOutcomeObservationCandidates).where(and(eq(geoOutcomeObservationCandidates.ownerUserId, ownerUserId), eq(geoOutcomeObservationCandidates.observationFingerprint, candidate.observationFingerprint)))
          observedInsertedRowInsideTransaction = rows.length === 1
          throw new Error('synthetic failure after real observation INSERT')
        })
      },
    }
    const failingRepository = new DrizzleGeoOutcomeRepository(rollbackDatabase as unknown as GeoOutcomeDrizzleDatabase)
    await expect(failingRepository.saveObservationTransactional(ownerUserId, candidate)).rejects.toThrow('synthetic failure after real observation INSERT')
    expect(observedInsertedRowInsideTransaction).toBe(true)
    expect(await repository!.getObservation(ownerUserId, candidate.observationFingerprint)).toBeNull()
    const [runRows] = await pool!.execute('SELECT id FROM geoOutcomeObservationRuns WHERE ownerUserId = ? AND runIdentity = ?', [ownerUserId, runIdentity])
    expect(runRows).toEqual([])
  })

  it('proves the 200-row development gate, preserves the shadow stop, then grows through canonical approvals to a durable 1,000-candidate shadow model', async () => {
    await seedThrough(DEVELOPMENT_GROUP_COUNT)
    const firstBuilt = await buildDataset(ownerUserId, 'citation_selection', repository)
    expect(firstBuilt.memberCount).toBe(200)
    expect(firstBuilt.manifest.readiness).toMatchObject({ ready: true, status: 'ready' })
    expect(firstBuilt.manifest.queryGroupCount).toBeGreaterThanOrEqual(30)
    expect(Object.keys(firstBuilt.manifest.engineCounts)).toHaveLength(3)
    expect(firstBuilt.manifest.positiveCount).toBeGreaterThanOrEqual(20)
    expect(firstBuilt.manifest.hardNegativeCount).toBeGreaterThanOrEqual(40)
    const durableDevelopment = await repository!.getDataset(ownerUserId, firstBuilt.manifest.manifestId)
    expect(durableDevelopment).not.toBeNull()
    const durableCreatedAtMs = Date.parse(durableDevelopment!.createdAt)
    const checkedAtMs = Date.now()
    expect(Number.isFinite(durableCreatedAtMs)).toBe(true)
    expect(durableCreatedAtMs).toBeGreaterThan(Date.UTC(2020, 0, 1))
    expect(durableCreatedAtMs).toBeGreaterThanOrEqual(checkedAtMs - 10 * 60_000)
    expect(durableCreatedAtMs).toBeLessThanOrEqual(checkedAtMs + 60_000)
    const replayedDevelopment = await buildDataset(ownerUserId, 'citation_selection', repository)
    expect(replayedDevelopment.memberCount).toBe(200)
    expect(replayedDevelopment.manifest.manifestFingerprint).toBe(durableDevelopment!.manifestFingerprint)
    expect(replayedDevelopment.manifest.createdAt).toBe(durableDevelopment!.createdAt)
    const durableReplay = await repository!.getDataset(ownerUserId, firstBuilt.manifest.manifestId)
    expect(durableReplay?.manifestFingerprint).toBe(durableDevelopment!.manifestFingerprint)
    expect(durableReplay?.createdAt).toBe(durableDevelopment!.createdAt)
    developmentCandidateFingerprints = firstBuilt.manifest.sourceObservationFingerprints
    const approvedDevelopment = await reviewDataset(ownerUserId, firstBuilt.manifest.manifestId, 'approve', ownerUserId, 'Synthetic 200-candidate development manifest approval.', repository, { knowledgeMode: 'declared_none_v1' })
    expect(approvedDevelopment.manifest.status).toBe('approved')
    developmentManifestId = approvedDevelopment.manifest.manifestId

    const developmentFallback = await createBootstrapFallback(ownerUserId, developmentManifestId, 'regularized_logistic_baseline_v1', repository)
    developmentFallbackArtifactId = developmentFallback.artifactId
    expect(developmentFallback.fallbackOnly).toBe(true)
    await expect(approveBootstrapFallback(ownerUserId, developmentFallback.artifactId, ownerUserId, 'Synthetic review blocked because shadow data is intentionally insufficient.', repository)).rejects.toThrow(/gate_blocked|Shadow/i)
    expect((await repository!.getArtifact(ownerUserId, developmentFallback.artifactId))?.status).toBe('ready_for_owner_review')
    expect((await repository!.listDecisions(ownerUserId)).some(decision => decision.modelArtifactId === developmentFallback.artifactId)).toBe(false)

    await seedThrough(FIXTURE_GROUP_COUNT)
    const finalBuilt = await buildDataset(ownerUserId, 'citation_selection', repository)
    expect(finalBuilt.memberCount).toBe(1000)
    expect(finalBuilt.manifest.sourceObservationFingerprints).toHaveLength(1000)
    expect(finalBuilt.manifest.queryGroupCount).toBe(500)
    expect(finalBuilt.manifest.websiteCount).toBeGreaterThanOrEqual(20)
    expect(Object.keys(finalBuilt.manifest.engineCounts)).toHaveLength(3)
    expect(finalBuilt.manifest.positiveCount).toBe(500)
    expect(finalBuilt.manifest.hardNegativeCount).toBe(500)
    expect(finalBuilt.manifest.observationEnd && finalBuilt.manifest.observationStart ? Date.parse(finalBuilt.manifest.observationEnd) - Date.parse(finalBuilt.manifest.observationStart) : 0).toBeGreaterThanOrEqual(60 * 86_400_000)
    expect(finalBuilt.manifest.temporalHoldoutRowCount).toBeGreaterThan(0)
    expect(finalBuilt.manifest.readiness).toMatchObject({ ready: true, status: 'ready' })
    trainedManifestId = (await reviewDataset(ownerUserId, finalBuilt.manifest.manifestId, 'approve', ownerUserId, 'Synthetic complete shadow-size manifest review.', repository, { knowledgeMode: 'declared_none_v1' })).manifest.manifestId

    const fallback = await createBootstrapFallback(ownerUserId, trainedManifestId, 'regularized_logistic_baseline_v1', repository)
    const approvedFallback = await approveBootstrapFallback(ownerUserId, fallback.artifactId, ownerUserId, 'Synthetic owner approved the exact train-only fallback artifact.', repository)
    expect(approvedFallback.artifact.status).toBe('approved_for_shadow')
    expect(approvedFallback.artifact.fallbackOnly).toBe(true)
    expect(approvedFallback.artifact.productionActivation).toBe(false)
    trainedFallbackArtifactId = approvedFallback.artifact.artifactId

    const run = await createTrainingRun(ownerUserId, { datasetManifestId: trainedManifestId, modelFamily: 'regularized_logistic_baseline_v1' }, repository)
    trainedRunId = run.trainingRunId
    expect(run.rollbackArtifactHash).toBe(fallback.artifactHash)
    const claims = await Promise.all([
      repository!.claimTrainingRun(ownerUserId, run.trainingRunId, 'synthetic-mysql-worker-a', new Date(Date.now() + 300_000).toISOString()),
      secondRepository!.claimTrainingRun(ownerUserId, run.trainingRunId, 'synthetic-mysql-worker-b', new Date(Date.now() + 300_000).toISOString()),
    ])
    expect(claims.filter(result => result.outcome === 'claimed')).toHaveLength(1)
    expect(claims.filter(result => result.outcome === 'in_progress')).toHaveLength(1)
    const winner = claims.find(result => result.outcome === 'claimed')!
    await repository!.transitionTrainingRun(ownerUserId, run.trainingRunId, { leaseExpiresAt: new Date(Date.now() - 2_000).toISOString(), version: winner.run.version })
    const completed = await executeTrainingRun(ownerUserId, run.trainingRunId, secondRepository)
    expect(completed.status).toBe('completed')
    expect(completed.rollbackArtifactHash).toBe(fallback.artifactHash)
    expect(completed.artifactId).toMatch(/^geo-model-/u)
    trainedArtifactId = completed.artifactId!
    trainedArtifactHash = completed.artifactHash!

    const artifact = await secondRepository!.getArtifact(ownerUserId, trainedArtifactId)
    expect(artifact).toMatchObject({ artifactId: trainedArtifactId, artifactHash: trainedArtifactHash, rollbackArtifactHash: fallback.artifactHash, status: 'ready_for_owner_review', trainingRowCount: (await secondRepository!.getDataset(ownerUserId, trainedManifestId))!.trainRowCount })
    expect(artifact!.coefficients).toEqual(expect.arrayContaining([expect.any(Number)]))
    expect(artifact!.coefficients.every(Number.isFinite)).toBe(true)
    trainedArtifactIntercept = artifact!.intercept
    trainedArtifactCoefficients = artifact!.coefficients
    const [persistedRows] = await pool!.execute('SELECT intercept, coefficients, normalizationStatistics, evaluationMetrics, trainingConfiguration, artifactHash FROM geoOutcomeModelArtifacts WHERE ownerUserId = ? AND artifactId = ?', [ownerUserId, trainedArtifactId]) as [Array<{ intercept: string; coefficients: unknown; normalizationStatistics: unknown; evaluationMetrics: unknown; trainingConfiguration: unknown; artifactHash: string }>, unknown]
    expect(persistedRows).toHaveLength(1)
    expect(persistedRows[0]!.artifactHash).toBe(trainedArtifactHash)
    expect(persistedRows[0]!.intercept).toBe(trainedArtifactIntercept.toFixed(12))
    const configuration = typeof persistedRows[0]!.trainingConfiguration === 'string' ? JSON.parse(persistedRows[0]!.trainingConfiguration as string) as Record<string, unknown> : persistedRows[0]!.trainingConfiguration as Record<string, unknown>
    expect(configuration).toMatchObject({ schemaVersion: 'geo-outcome-artifact-training-configuration-v3', exactIntercept: String(trainedArtifactIntercept) })
    expect(typeof configuration.exactIntercept).toBe('string')
    expect(Number(configuration.exactIntercept)).toBe(trainedArtifactIntercept)
    expect(String(Number(configuration.exactIntercept))).toBe(configuration.exactIntercept)
    expect(decodeDurableJson(configuration.config, true)).toEqual(artifact!.trainingConfiguration)
    expect(decodeDurableJson(persistedRows[0]!.coefficients, true)).toEqual(trainedArtifactCoefficients)
    expect(decodeDurableJson(persistedRows[0]!.normalizationStatistics, true)).toEqual(artifact!.normalizationStatistics)
    expect(decodeDurableJson(persistedRows[0]!.evaluationMetrics, true)).toEqual(artifact!.evaluationMetrics)

    // Recreate the repository only after the trained artifact is durably committed.
    const restartUrl = dedicatedUrl(explicitUrl)
    restartPool = createPool({ host: restartUrl.hostname, port: Number(restartUrl.port || 3306), user: decodeURIComponent(restartUrl.username), password: decodeURIComponent(restartUrl.password), database: restartUrl.pathname.slice(1), connectionLimit: 2, timezone: 'Z' })
    const restartDatabase = drizzle(restartPool, { mode: 'default' })
    restartRepository = new DrizzleGeoOutcomeRepository(restartDatabase as unknown as GeoOutcomeDrizzleDatabase)

    expect(await secondRepository!.getArtifact(otherOwnerUserId, trainedArtifactId)).toBeNull()
    expect(await secondRepository!.getDataset(otherOwnerUserId, trainedManifestId)).toBeNull()
    expect(await secondRepository!.getObservation(otherOwnerUserId, citedObservationFingerprints[0]!)).toBeNull()

    const source = sourceGroups.at(-1)!
    const locatorHash = authoritativeLocatorFingerprint({ sourceRecordId: source.sourceObservationId, sourceProjectId: projectId, sourceQueryId: source.queryId, sourceRunId: source.runId, sourceResponseHash: source.responseHash, evidenceLocator: `synthetic-evidence://geo-sql/${FIXTURE_GROUP_COUNT}`, sourceObservedAt: source.observedAt })
    predictionInput = rawObservation({ status: 'not_cited', projectId, provider: source.provider, modelLabel: source.modelLabel, runIdentity: source.runIdentity, promptHash: source.promptHash, responseHash: source.responseHash, locatorHash, observedAt: source.observedAt, candidateUrl: source.uncitedUrl, contentHash: source.uncitedContentHash })
    await expect(predict(ownerUserId, trainedArtifactId, predictionInput, secondRepository, { allowTrustedFixture: true })).rejects.toThrow(/not approved for shadow/i)
  }, 300_000)

  it('re-reads persisted artifacts in a fresh repository and prevents model/data use after durable source revocation', async () => {
    expect(trainedArtifactId).toBeTruthy()
    expect(restartPool).toBeDefined()
    expect(restartRepository).toBeDefined()
    const reloaded = await restartRepository!.getArtifact(ownerUserId, trainedArtifactId)
    expect(reloaded).toMatchObject({ artifactId: trainedArtifactId, artifactHash: trainedArtifactHash, intercept: trainedArtifactIntercept, coefficients: trainedArtifactCoefficients })
    expect(await restartRepository!.getArtifact(otherOwnerUserId, trainedArtifactId)).toBeNull()

    const modelReview = await reviewModel(ownerUserId, trainedArtifactId, 'approve_for_shadow', ownerUserId, 'Synthetic complete shadow gate owner review.', restartRepository)
    expect(modelReview.artifact.status).toBe('approved_for_shadow')
    expect(modelReview.artifact.productionActivation).toBe(false)
    await expect(predict(ownerUserId, trainedArtifactId, predictionInput, restartRepository, { allowTrustedFixture: true })).resolves.toMatchObject({ predictionIsVerifiedOutcome: false, modelArtifactHash: trainedArtifactHash })

    const revokedFingerprint = citedObservationFingerprints[0]!
    const revoked = await verifyObservation(ownerUserId, revokedFingerprint, ownerUserId, 'revoke', 'Synthetic source authority revocation regression.', restartRepository)
    expect(revoked.observation.verificationStatus).toBe('revoked')
    expect(canBePrimaryCitationTruth((await restartRepository!.getObservation(ownerUserId, revokedFingerprint))!)).toBe(false)
    const members = await restartRepository!.getDatasetMembers(ownerUserId, trainedManifestId)
    expect(members.find(member => member.observationFingerprint === revokedFingerprint)?.observation.verificationStatus).toBe('revoked')
    const artifact = (await restartRepository!.getArtifact(ownerUserId, trainedArtifactId))!
    expect(await resolveApprovedFallbackForArtifact(ownerUserId, artifact, restartRepository!)).toBeNull()
    await expect(predict(ownerUserId, trainedArtifactId, predictionInput, restartRepository, { allowTrustedFixture: true })).rejects.toThrow(/governance|fallback|authority/i)

    const revokedModel = await reviewModel(ownerUserId, trainedArtifactId, 'revoke', ownerUserId, 'Synthetic terminal model revocation after source withdrawal.', restartRepository)
    expect(revokedModel.artifact.status).toBe('revoked')
    expect(await restartRepository!.getArtifact(ownerUserId, trainedArtifactId)).toMatchObject({ status: 'revoked' })
    await expect(predict(ownerUserId, trainedArtifactId, predictionInput, restartRepository, { allowTrustedFixture: true })).rejects.toThrow(/not approved|revoked/i)
    expect((await restartRepository!.getArtifact(ownerUserId, trainedFallbackArtifactId))?.status).toBe('approved_for_shadow')
    expect((await restartRepository!.getArtifact(ownerUserId, developmentFallbackArtifactId))?.status).toBe('ready_for_owner_review')
    expect((await restartRepository!.getDataset(ownerUserId, developmentManifestId))?.sourceObservationFingerprints).toEqual(developmentCandidateFingerprints)
  }, 180_000)

  it('converges concurrent run creation, snapshot-safe replay, and immutable run-evidence collision rejection', async () => {
    const index = 10_001
    const observedAt = new Date(Date.UTC(2025, 6, 1)).toISOString()
    const runIdentity = hash('synthetic-concurrent-observation-run')
    const promptHash = hash('synthetic-concurrent-observation-query')
    const responseHash = hash('synthetic-concurrent-observation-response')
    const shared = { projectId, provider: 'chatgpt' as const, modelLabel: 'synthetic-concurrent-manual-v1', runIdentity, promptHash, responseHash, locatorHash: hash('synthetic-no-authority-locator'), observedAt }
    const cited = normalizeManualObservation(rawObservation({ ...shared, status: 'cited', candidateUrl: `https://brand-${index}.acme.com/geo/concurrent-cited`, contentHash: hash('synthetic-concurrent-cited-content') }), ownerUserId)
    const notCited = normalizeManualObservation(rawObservation({ ...shared, status: 'not_cited', candidateUrl: `https://candidate-${index}.acme.net/geo/concurrent-not-cited`, contentHash: hash('synthetic-concurrent-not-cited-content') }), ownerUserId)

    const pair = await Promise.all([
      repository!.saveObservationTransactional(ownerUserId, cited),
      secondRepository!.saveObservationTransactional(ownerUserId, notCited),
    ])
    expect(pair.map(item => item.observationFingerprint).sort()).toEqual([cited.observationFingerprint, notCited.observationFingerprint].sort())

    const [runsAfterPair] = await pool!.execute('SELECT id, runIdentity, evidenceSnapshotHash, runFingerprint, status, createdAt FROM geoOutcomeObservationRuns WHERE ownerUserId = ? AND runIdentity = ?', [ownerUserId, runIdentity]) as [Array<Record<string, unknown>>, unknown]
    expect(runsAfterPair).toHaveLength(1)
    const runId = Number(runsAfterPair[0]!.id)
    const [candidatesAfterPair] = await pool!.execute('SELECT * FROM geoOutcomeObservationCandidates WHERE ownerUserId = ? AND observationRunId = ? ORDER BY id', [ownerUserId, runId]) as [Array<Record<string, unknown>>, unknown]
    expect(candidatesAfterPair).toHaveLength(2)
    expect(candidatesAfterPair.map(row => row.observationFingerprint).sort()).toEqual([cited.observationFingerprint, notCited.observationFingerprint].sort())

    const replays = await Promise.all([
      repository!.saveObservationTransactional(ownerUserId, cited),
      secondRepository!.saveObservationTransactional(ownerUserId, cited),
    ])
    expect(replays.map(item => item.observationFingerprint)).toEqual([cited.observationFingerprint, cited.observationFingerprint])

    const snapshotRace = normalizeManualObservation(rawObservation({
      ...shared,
      status: 'not_cited',
      candidateUrl: `https://candidate-${index}.acme.net/geo/snapshot-race`,
      contentHash: hash('synthetic-concurrent-snapshot-race-content'),
    }), ownerUserId)
    let signalOuterRead!: () => void
    let releaseOuterSave!: () => void
    const outerReadReached = new Promise<void>(resolve => { signalOuterRead = resolve })
    const continueOuterSave = new Promise<void>(resolve => { releaseOuterSave = resolve })
    const outerTransaction = repository!.transaction(async transaction => {
      expect(await transaction.getObservation(ownerUserId, snapshotRace.observationFingerprint)).toBeNull()
      signalOuterRead()
      await continueOuterSave
      return transaction.saveObservationTransactional(ownerUserId, snapshotRace)
    })
    await outerReadReached
    let externalSaveError: unknown
    let externalSaved: Awaited<ReturnType<DrizzleGeoOutcomeRepository['saveObservationTransactional']>> | undefined
    try {
      externalSaved = await secondRepository!.saveObservationTransactional(ownerUserId, snapshotRace)
    } catch (error) {
      externalSaveError = error
    } finally {
      releaseOuterSave()
    }
    const outerReplay = await outerTransaction
    if (externalSaveError) throw externalSaveError
    expect(externalSaved?.observationFingerprint).toBe(snapshotRace.observationFingerprint)
    expect(outerReplay.observationFingerprint).toBe(snapshotRace.observationFingerprint)

    const [createdRuns] = await pool!.execute('SELECT id, runIdentity, evidenceSnapshotHash, runFingerprint, status, createdAt FROM geoOutcomeObservationRuns WHERE ownerUserId = ? AND runIdentity = ?', [ownerUserId, runIdentity]) as [Array<Record<string, unknown>>, unknown]
    const [createdCandidates] = await pool!.execute('SELECT * FROM geoOutcomeObservationCandidates WHERE ownerUserId = ? AND observationRunId = ? ORDER BY id', [ownerUserId, runId]) as [Array<Record<string, unknown>>, unknown]
    expect(createdRuns).toHaveLength(1)
    expect(createdCandidates).toHaveLength(3)
    expect(createdCandidates.map(row => row.observationFingerprint).sort()).toEqual([cited.observationFingerprint, notCited.observationFingerprint, snapshotRace.observationFingerprint].sort())

    const collision = normalizeManualObservation(rawObservation({
      ...shared,
      status: 'not_cited',
      responseHash: hash('synthetic-concurrent-observation-different-evidence'),
      candidateUrl: `https://candidate-${index}.acme.net/geo/collision`,
      contentHash: hash('synthetic-concurrent-collision-content'),
    }), ownerUserId)
    await expect(repository!.saveObservationTransactional(ownerUserId, collision)).rejects.toThrow(/run identity collision/i)

    const [runsAfterCollision] = await pool!.execute('SELECT id, runIdentity, evidenceSnapshotHash, runFingerprint, status, createdAt FROM geoOutcomeObservationRuns WHERE ownerUserId = ? AND runIdentity = ?', [ownerUserId, runIdentity]) as [Array<Record<string, unknown>>, unknown]
    const [candidatesAfterCollision] = await pool!.execute('SELECT * FROM geoOutcomeObservationCandidates WHERE ownerUserId = ? AND observationRunId = ? ORDER BY id', [ownerUserId, runId]) as [Array<Record<string, unknown>>, unknown]
    expect(runsAfterCollision).toEqual(createdRuns)
    expect(candidatesAfterCollision).toEqual(createdCandidates)

    const standaloneFingerprints = [cited.observationFingerprint, notCited.observationFingerprint, snapshotRace.observationFingerprint]
    for (const fingerprint of standaloneFingerprints) {
      const stored = await repository!.getObservation(ownerUserId, fingerprint)
      expect(stored).toMatchObject({ verificationStatus: 'unverified', consentStatus: 'unknown', piiStatus: 'unknown' })
    }
    const [verificationRows] = await pool!.execute('SELECT id FROM geoOutcomeObservationVerifications WHERE ownerUserId = ? AND observationFingerprint IN (?, ?, ?)', [ownerUserId, ...standaloneFingerprints])
    const [evidenceRows] = await pool!.execute('SELECT id FROM geoOutcomeEvidenceLocators WHERE ownerUserId = ? AND observationFingerprint IN (?, ?, ?)', [ownerUserId, ...standaloneFingerprints])
    expect(verificationRows).toEqual([])
    expect(evidenceRows).toEqual([])

    const standaloneDataset = buildCitationSelectionDataset([...pair, outerReplay], ownerUserId)
    expect(standaloneDataset.members).toEqual([])
    expect(standaloneDataset.manifest.sourceObservationFingerprints).toEqual([])
    expect(standaloneDataset.manifest.readiness.ready).toBe(false)
  }, 60_000)

  it('round-trips exact-json numeric text through a real MySQL JSON CAST without assuming native JSON loss', async () => {
    const exact = {
      normalizationStatistics: {
        mean: [0.027397260273972678, -0.43434838152895533],
        standardDeviation: [1.0000000000000002, 0.0000000000000001],
      },
      trainingConfiguration: { epochs: 17, learningRate: 0.43434838152895533, l2: 0.010203040506070809, seed: 0 },
      nested: [{ intercept: -0.12345678901234566, coefficients: [Math.PI, Number.MIN_VALUE] }],
    }
    const encoded = encodeDurableJson(exact)
    const [rows] = await pool!.execute('SELECT CAST(? AS JSON) AS exactJson', [JSON.stringify(encoded)]) as [Array<{ exactJson: unknown }>, unknown]
    expect(rows).toHaveLength(1)
    const mysqlJson = typeof rows[0]!.exactJson === 'string' ? JSON.parse(rows[0]!.exactJson as string) as unknown : rows[0]!.exactJson
    const decoded = decodeDurableJson(mysqlJson, true)
    expect(decoded).toEqual(exact)
    expect((decoded as typeof exact).normalizationStatistics.mean[0]).toBe(0.027397260273972678)
    expect((decoded as typeof exact).trainingConfiguration.learningRate).toBe(0.43434838152895533)
    expect((decoded as typeof exact).nested[0]!.coefficients[0]).toBe(Math.PI)
  }, 30_000)
})

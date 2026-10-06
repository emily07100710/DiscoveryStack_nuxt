import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { fingerprint } from '../geo-outcome-model/canonical'
import { collectLearningEvidence, type LearningCrawlerDependencies, type LearningCrawlerResult } from '../site-evidence/learning-crawler'
import type { LearningEvidenceCollection, LearningSourceAuthorization } from '../database/schema'
import { authorizationFingerprint, learningError, resolveLearningAuthority, sourcePolicyReady } from './authority'
import { DrizzleLearningLoopRepository } from './repository'
import type { LearningLoopRepository } from './types'

export type LearningLoopDependencies = {
  repository?: LearningLoopRepository
  now?: () => Date
  crawlEnabled?: boolean
  collect?: typeof collectLearningEvidence
  crawler?: Omit<LearningCrawlerDependencies, 'resolveCurrentAuthority' | 'now'>
}
const id = z.number().int().positive()
const sha = z.string().regex(/^[a-f0-9]{64}$/)
const key = z.string().regex(/^[A-Za-z0-9_.:-]{1,128}$/)
const authorizationSchema = z.object({
  clientId: id, sourceId: id, rightsBasis: z.enum(['owner_authorized', 'licensed', 'open_license_verified']),
  rightsEvidenceHash: sha, consentReceiptHash: sha, consentVersion: z.string().regex(/^[A-Za-z0-9_.:-]{1,80}$/),
  expiresAt: z.string().datetime(), retentionDays: z.number().int().min(1).max(30), idempotencyKey: key,
  modelImprovementConsentConfirmed: z.literal(true), sourceRightsConfirmed: z.literal(true),
}).strict()
const collectSchema = z.object({ authorizationId: id, idempotencyKey: key }).strict()
const reviewSchema = z.object({ decision: z.enum(['approved', 'rejected']), piiReviewConfirmed: z.boolean(), structuralOnlyAcknowledged: z.literal(true) }).strict().refine(input => input.decision === 'rejected' || input.piiReviewConfirmed, { message: 'Approval requires a confirmed PII review.' })
const structuralSchema = z.object({
  titlePresent: z.boolean(), h1Present: z.boolean(), canonicalPresent: z.boolean(), metaRobotsPresent: z.boolean(),
  textLengthBucket: z.enum(['0', '1-499', '500-1999', '2000-9999', '10000+']),
  anchorCountBucket: z.enum(['0', '1-4', '5-19', '20+']), internalAnchorCountBucket: z.enum(['0', '1-4', '5-19', '20+']),
}).strict()
// Runtime validation is a privacy boundary, not just a TypeScript promise from a collector.
const projectionSchema = z.object({
  contractVersion: z.literal('learning-crawl-projection-v1'), ownerUserId: id, clientId: id, sourceId: id,
  consentReceiptHash: sha, sourceFingerprint: sha, status: z.enum(['completed', 'completed_partial', 'blocked_authorization', 'blocked_robots', 'blocked_source']),
  reasonCode: z.string().regex(/^[A-Z0-9_]{1,80}$/).nullable(), pagesAttempted: z.number().int().min(0).max(20),
  pagesCaptured: z.number().int().min(0).max(20), duplicatePagesSkipped: z.number().int().min(0).max(100000),
  pageCap: z.literal(20), maxDepth: z.literal(2),
  labels: z.object({ aiCitation: z.literal('unknown'), searchVisibility: z.literal('unknown'), businessOutcome: z.literal('unknown') }).strict(),
  requiresHumanReview: z.literal(true),
  pages: z.array(z.object({ urlHash: sha, contentHash: sha.nullable(), depth: z.number().int().min(0).max(2), httpStatus: z.number().int().min(100).max(599).nullable(), bytesFetched: z.number().int().min(0).max(262144).nullable(), structural: structuralSchema.nullable(), evidenceLabel: z.literal('unknown') }).strict()).max(20),
}).strict()
const nowFor = (deps: LearningLoopDependencies) => (deps.now || (() => new Date()))()
const repoFor = (deps: LearningLoopDependencies) => deps.repository || new DrizzleLearningLoopRepository()
function parse<T>(schema: z.ZodType<T>, value: unknown): T { const result = schema.safeParse(value); if (!result.success) learningError('INVALID_LEARNING_INPUT', '請填寫完整的授權與證據資料。', 422); return result.data }
function duplicate(error: unknown): boolean { const e = error as { code?: string; errno?: number; cause?: unknown }; return e?.code === 'ER_DUP_ENTRY' || e?.errno === 1062 || Boolean(e?.cause && duplicate(e.cause)) }
function selector(row: LearningSourceAuthorization) { return { ownerUserId: row.ownerUserId, clientId: row.clientId, sourceId: row.sourceId } }
function authDto(row: LearningSourceAuthorization, active: boolean) {
  return { id: row.id, clientId: row.clientId, sourceId: row.sourceId, authorizedOrigin: row.authorizedOrigin, rightsBasis: row.rightsBasis, consentVersion: row.consentVersion, consentReceiptHash: row.consentReceiptHash, rightsEvidenceHash: row.rightsEvidenceHash, authorizationFingerprint: row.authorizationFingerprint, status: row.status, approvedAt: row.approvedAt.toISOString(), expiresAt: row.expiresAt.toISOString(), retentionDays: row.retentionDays, usable: active }
}
function collectionDto(row: LearningEvidenceCollection, usable: boolean, now: Date) {
  const projection = projectionSchema.safeParse(row.projection)
  return { id: row.id, authorizationId: row.authorizationId, clientId: row.clientId, sourceId: row.sourceId, status: row.status, reviewStatus: row.reviewStatus, errorCode: row.errorCode, usable, retentionUntil: row.retentionUntil.toISOString(), createdAt: row.createdAt.toISOString(), projectionFingerprint: row.projectionFingerprint, projection: projection.success && row.retentionUntil > now ? projection.data : null, limitations: ['structural_auxiliary_only', 'not_ai_citation_truth', 'human_review_required'] }
}

export async function createLearningAuthorization(ownerUserId: number, value: unknown, deps: LearningLoopDependencies = {}) {
  const input = parse(authorizationSchema, value), repo = repoFor(deps), now = nowFor(deps)
  const [client, source, existing] = await Promise.all([repo.getClient(ownerUserId, input.clientId), repo.getSource(ownerUserId, input.sourceId), repo.findAuthorization(ownerUserId, input.idempotencyKey)])
  if (!client || !source || !sourcePolicyReady({ client, source }, now)) learningError('SOURCE_POLICY_NOT_READY', '來源必須先通過用途、權利及個資審核，且屬於這位客戶的網站。')
  // MySQL TIMESTAMP uses second precision. Hash the values that the database will actually retain.
  const expiresAt = new Date(Math.floor(new Date(input.expiresAt).getTime() / 1000) * 1000)
  if (expiresAt <= now || expiresAt.getTime() > now.getTime() + 90 * 86400000) learningError('INVALID_AUTHORIZATION_TTL', '授權效期必須介於現在到 90 天內。', 422)
  if (input.rightsBasis !== 'owner_authorized' && !source.licenceReference) learningError('LICENSE_EVIDENCE_REQUIRED')
  const row = { ownerUserId, clientId: client.id, sourceId: source.id, authorizedOrigin: new URL(client.canonicalSiteOrigin).origin, rightsBasis: input.rightsBasis, rightsEvidenceHash: input.rightsEvidenceHash, consentVersion: input.consentVersion, consentReceiptHash: input.consentReceiptHash, authorizationFingerprint: '', idempotencyKey: input.idempotencyKey, status: 'active' as const, retentionDays: input.retentionDays, approvedAt: existing?.approvedAt || new Date(Math.floor(now.getTime() / 1000) * 1000), expiresAt, revokedAt: null }
  row.authorizationFingerprint = authorizationFingerprint({ ...row, id: 0, createdAt: now })
  if (existing) {
    if (existing.authorizationFingerprint !== row.authorizationFingerprint) learningError('IDEMPOTENCY_COLLISION')
    const scope = await repo.getScope(ownerUserId, existing.id)
    return { replayed: true, authorization: authDto(existing, Boolean(resolveLearningAuthority(scope, selector(existing), now))) }
  }
  let stored: LearningSourceAuthorization, replayed = false
  try { stored = await repo.insertAuthorization(row) } catch (error) {
    if (!duplicate(error)) throw error
    const winner = await repo.findAuthorization(ownerUserId, input.idempotencyKey)
    // The winning writer's timestamp is authoritative, but every requested field must still match.
    if (!winner || winner.authorizationFingerprint !== authorizationFingerprint({ ...row, id: winner.id, createdAt: winner.createdAt, approvedAt: winner.approvedAt })) learningError('IDEMPOTENCY_COLLISION')
    stored = winner
    replayed = true
  }
  const scope = await repo.getScope(ownerUserId, stored.id)
  return { replayed, authorization: authDto(stored, Boolean(resolveLearningAuthority(scope, selector(stored), now))) }
}

export async function revokeLearningAuthorization(ownerUserId: number, authorizationId: number, deps: LearningLoopDependencies = {}) {
  const repo = repoFor(deps), scope = await repo.getScope(ownerUserId, authorizationId)
  if (!scope) learningError('AUTHORIZATION_NOT_FOUND', '找不到這筆授權。', 404)
  await repo.revokeAuthorization(ownerUserId, authorizationId, nowFor(deps))
  return { revoked: true, authorizationId, limitations: ['historical_evidence_retained_until_retention_deadline', 'new_collection_and_admission_blocked_immediately'] }
}

export async function expireLearningEvidenceCollections(ownerUserId: number, deps: LearningLoopDependencies = {}) {
  const purged = await repoFor(deps).purgeExpiredCollectionProjections(ownerUserId, nowFor(deps), 100)
  return { status: 'retention_checked' as const, purgedProjections: purged, retainedHistory: 'minimal_authorization_and_review_ledger', maximumPerTick: 100 }
}

export async function collectAuthorizedLearningEvidence(ownerUserId: number, value: unknown, deps: LearningLoopDependencies = {}) {
  // Default-off gate precedes DB, DNS and network; the browser cannot enable it.
  if (!(deps.crawlEnabled ?? process.env.NUXT_LEARNING_CRAWL_ENABLED === 'true')) learningError('LEARNING_CRAWL_DISABLED', '資料蒐集尚未由管理員開通。', 503)
  const input = parse(collectSchema, value), repo = repoFor(deps), now = nowFor(deps)
  const scope = await repo.getScope(ownerUserId, input.authorizationId)
  if (!scope || !resolveLearningAuthority(scope, selector(scope.authorization), now)) learningError('CURRENT_AUTHORIZATION_REQUIRED')
  const auth = scope.authorization
  const inputFingerprint = fingerprint({ version: 'authorized-learning-collection-v1', authorizationId: auth.id, authorizationFingerprint: auth.authorizationFingerprint, sourceUrlHash: fingerprint(scope.source.canonicalUrl || scope.source.sourceUrl), pageCap: 20, maxDepth: 2 })
  let row = await repo.findCollection(ownerUserId, input.idempotencyKey)
  let replayed = Boolean(row)
  if (row && row.inputFingerprint !== inputFingerprint) learningError('IDEMPOTENCY_COLLISION')
  if (row?.status !== 'collecting' && row) return { replayed: true, collection: collectionDto(row, await isCollectionUsable(ownerUserId, row, repo, now), now) }
  const leaseToken = randomUUID(), leaseExpiresAt = new Date(now.getTime() + 90000)
  if (!row) {
    try {
      row = await repo.insertCollection({ ownerUserId, authorizationId: auth.id, clientId: auth.clientId, sourceId: auth.sourceId, idempotencyKey: input.idempotencyKey, inputFingerprint, authorizationFingerprint: auth.authorizationFingerprint, status: 'collecting', projection: null, projectionFingerprint: null, reviewStatus: 'pending', reviewFingerprint: null, reviewedAt: null, retentionUntil: new Date(Math.min(now.getTime() + auth.retentionDays * 86400000, auth.expiresAt.getTime(), scope.source.retentionUntil?.getTime() ?? Infinity)), leaseToken, leaseVersion: 1, leaseExpiresAt, errorCode: null, completedAt: null })
    } catch (error) {
      if (!duplicate(error)) throw error
      row = await repo.findCollection(ownerUserId, input.idempotencyKey); replayed = true
      if (!row || row.inputFingerprint !== inputFingerprint) learningError('IDEMPOTENCY_COLLISION')
    }
  }
  if (!row) learningError('COLLECTION_RESERVATION_FAILED')
  if (row.status !== 'collecting') return { replayed: true, collection: collectionDto(row, await isCollectionUsable(ownerUserId, row, repo, now), now) }
  if (row.leaseToken !== leaseToken) {
    if (row.leaseExpiresAt && row.leaseExpiresAt > now) return { replayed: true, collection: collectionDto(row, false, now) }
    const recovered = await repo.recoverCollection({ id: row.id, ownerUserId, leaseToken, leaseVersion: row.leaseVersion }, now, leaseExpiresAt)
    if (!recovered) learningError('COLLECTION_LEASE_LOST')
    row = recovered
  }
  const lease = { id: row.id, ownerUserId, leaseToken, leaseVersion: row.leaseVersion }
  let result: LearningCrawlerResult | null = null, errorCode: string | null = null
  try {
    result = parse(projectionSchema, await (deps.collect || collectLearningEvidence)(selector(auth), {
      ...deps.crawler, now: () => nowFor(deps),
      resolveCurrentAuthority: async (selected, at) => {
        if (selected.ownerUserId !== ownerUserId || selected.clientId !== auth.clientId || selected.sourceId !== auth.sourceId) return null
        const current = await repo.getScope(ownerUserId, auth.id)
        if (current?.authorization.authorizationFingerprint !== auth.authorizationFingerprint) return null
        return resolveLearningAuthority(current, selected, at)
      },
    }))
    if (result.ownerUserId !== ownerUserId || result.clientId !== auth.clientId || result.sourceId !== auth.sourceId || result.consentReceiptHash !== auth.consentReceiptHash || result.pagesCaptured !== result.pages.filter(page => page.structural !== null).length) learningError('INVALID_COLLECTION_PROJECTION')
    if (!['completed', 'completed_partial'].includes(result.status) || !result.pagesCaptured) errorCode = result.reasonCode || 'NO_ELIGIBLE_STRUCTURAL_EVIDENCE'
  } catch { result = null; errorCode = 'LEARNING_COLLECTION_FAILED' }
  const completedAt = nowFor(deps), current = await repo.getScope(ownerUserId, auth.id)
  const currentAuthority = resolveLearningAuthority(current, selector(auth), completedAt)
  if (current?.authorization.authorizationFingerprint !== auth.authorizationFingerprint || !currentAuthority || (result && result.sourceFingerprint !== currentAuthority.sourceFingerprint) || row.retentionUntil <= completedAt) { result = null; errorCode = 'AUTHORIZATION_CHANGED_DURING_COLLECTION' }
  const finalized = await repo.finalizeCollection(lease, completedAt, { status: errorCode ? 'failed' : 'completed', projection: result, projectionFingerprint: result ? fingerprint(result) : null, errorCode })
  if (!finalized) learningError('COLLECTION_LEASE_LOST')
  return { replayed, collection: collectionDto(finalized, false, nowFor(deps)) }
}

export async function isCollectionUsable(ownerUserId: number, row: LearningEvidenceCollection, repo: LearningLoopRepository, now: Date): Promise<boolean> {
  if (row.ownerUserId !== ownerUserId || row.status !== 'completed' || row.reviewStatus !== 'approved' || !row.reviewFingerprint || row.retentionUntil <= now || !row.projectionFingerprint) return false
  const parsed = projectionSchema.safeParse(row.projection)
  if (!parsed.success || fingerprint(parsed.data) !== row.projectionFingerprint || parsed.data.ownerUserId !== ownerUserId || parsed.data.clientId !== row.clientId || parsed.data.sourceId !== row.sourceId) return false
  const scope = await repo.getScope(ownerUserId, row.authorizationId)
  const authority = scope ? resolveLearningAuthority(scope, selector(scope.authorization), now) : null
  const review = fingerprint({ contractVersion: 'learning-collection-review-v1', ownerUserId, collectionId: row.id, projectionFingerprint: row.projectionFingerprint, authorizationFingerprint: row.authorizationFingerprint, decision: 'approved', piiReviewConfirmed: true, structuralOnlyAcknowledged: true })
  return Boolean(scope && scope.authorization.clientId === row.clientId && scope.authorization.sourceId === row.sourceId && scope.authorization.authorizationFingerprint === row.authorizationFingerprint && scope.authorization.consentReceiptHash === parsed.data.consentReceiptHash && authority?.sourceFingerprint === parsed.data.sourceFingerprint && row.reviewFingerprint === review)
}

export async function reviewLearningCollection(ownerUserId: number, collectionId: number, value: unknown, deps: LearningLoopDependencies = {}) {
  const input = parse(reviewSchema, value), repo = repoFor(deps), now = nowFor(deps), row = await repo.getCollection(ownerUserId, collectionId)
  if (!row) learningError('COLLECTION_NOT_FOUND', '找不到這筆蒐集紀錄。', 404)
  const scope = await repo.getScope(ownerUserId, row.authorizationId), projected = projectionSchema.safeParse(row.projection)
  if (!scope || !resolveLearningAuthority(scope, selector(scope.authorization), now) || scope.authorization.clientId !== row.clientId || scope.authorization.sourceId !== row.sourceId || scope.authorization.authorizationFingerprint !== row.authorizationFingerprint || row.retentionUntil <= now || row.status !== 'completed' || !projected.success || projected.data.ownerUserId !== ownerUserId || projected.data.clientId !== row.clientId || projected.data.sourceId !== row.sourceId || projected.data.consentReceiptHash !== scope.authorization.consentReceiptHash || row.projectionFingerprint !== fingerprint(projected.data) || projected.data.sourceFingerprint !== resolveLearningAuthority(scope, selector(scope.authorization), now)?.sourceFingerprint) learningError('COLLECTION_NOT_REVIEWABLE')
  const reviewFingerprint = fingerprint({ contractVersion: 'learning-collection-review-v1', ownerUserId, collectionId, projectionFingerprint: row.projectionFingerprint, authorizationFingerprint: row.authorizationFingerprint, decision: input.decision, piiReviewConfirmed: input.piiReviewConfirmed, structuralOnlyAcknowledged: true })
  if (row.reviewStatus !== 'pending') {
    if (row.reviewFingerprint !== reviewFingerprint) learningError('COLLECTION_REVIEW_CONFLICT')
    return { replayed: true, collection: collectionDto(row, await isCollectionUsable(ownerUserId, row, repo, now), now) }
  }
  const reviewed = await repo.reviewCollection(ownerUserId, collectionId, input.decision, reviewFingerprint, now)
  if (!reviewed) learningError('COLLECTION_REVIEW_CONFLICT')
  return { replayed: false, collection: collectionDto(reviewed, await isCollectionUsable(ownerUserId, reviewed, repo, now), now) }
}

export async function getLearningLoopWorkspace(ownerUserId: number, deps: LearningLoopDependencies = {}) {
  const repo = repoFor(deps), now = nowFor(deps)
  const [clients, sources, authorizations, collections] = await Promise.all([repo.listClients(ownerUserId), repo.listSources(ownerUserId), repo.listAuthorizations(ownerUserId), repo.listCollections(ownerUserId)])
  return {
    contractVersion: 'learning-loop-workspace-v1',
    configuration: { loopEnabled: process.env.NUXT_LEARNING_LOOP_ENABLED === 'true', retentionEnabled: process.env.NUXT_LEARNING_LOOP_ENABLED === 'true' || process.env.NUXT_LEARNING_RETENTION_ENABLED === 'true', crawlEnabled: deps.crawlEnabled ?? process.env.NUXT_LEARNING_CRAWL_ENABLED === 'true', weeklyContentEnabled: process.env.NUXT_WEEKLY_CONTENT_APPROVAL_ENABLED === 'true', schedulerEnabled: process.env.NUXT_CONTENT_OPERATIONS_SCHEDULER_ENABLED === 'true' },
    clients: clients.map(client => ({ id: client.id, name: client.displayName, origin: client.canonicalSiteOrigin, active: client.status === 'active' })),
    sources: sources.map(source => ({ id: source.id, origin: (() => { try { return new URL(source.canonicalUrl || source.sourceUrl).origin } catch { return '來源網址尚未有效' } })(), trainingPolicyApproved: clients.some(client => sourcePolicyReady({ client, source }, now)) })),
    authorizations: await Promise.all(authorizations.map(async row => authDto(row, Boolean(resolveLearningAuthority(await repo.getScope(ownerUserId, row.id), selector(row), now))))),
    collections: await Promise.all(collections.map(async row => collectionDto(row, await isCollectionUsable(ownerUserId, row, repo, now), now))),
    limitations: ['learning_consent_separate_from_line_publication_consent', 'structural_collection_is_not_citation_label', 'production_model_activation_is_owner_governed', 'provider_and_database_setup_required'],
  }
}

export async function exportStructuralLearningEvidence(ownerUserId: number, deps: LearningLoopDependencies = {}) {
  const repo = repoFor(deps), now = nowFor(deps), eligible = [], staged = []
  for (const row of await repo.listCollections(ownerUserId)) {
    if (await isCollectionUsable(ownerUserId, row, repo, now)) staged.push(row)
  }
  const finalNow = nowFor(deps)
  for (const row of staged) {
    const current = await repo.getCollection(ownerUserId, row.id)
    if (current && current.projectionFingerprint === row.projectionFingerprint && current.reviewFingerprint === row.reviewFingerprint && await isCollectionUsable(ownerUserId, current, repo, finalNow)) eligible.push({ projection: projectionSchema.parse(current.projection), projectionFingerprint: current.projectionFingerprint, authorizationFingerprint: current.authorizationFingerprint, reviewFingerprint: current.reviewFingerprint, retentionUntil: current.retentionUntil.toISOString() })
  }
  // This is an auxiliary, unlabelled dataset. It cannot be admitted to citation training.
  const release = { contractVersion: 'structural-learning-release-v1', taskType: 'structural_auxiliary' as const, generatedAt: finalNow.toISOString(), rowCount: eligible.reduce((sum, row) => sum + row.projection.pagesCaptured, 0), collections: eligible, labels: 'unknown' as const, citationTrainingEligible: false as const }
  return { ...release, releaseFingerprint: fingerprint(release) }
}

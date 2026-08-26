import { createHash } from 'node:crypto'
import { createError } from 'h3'
import { z } from 'zod'
import { recordOwnerOutcomeAssessment, createContentOperationsRepository, normalizePublicHttpsOrigin, normalizeTimeZone } from '../content-operations'
import type { ContentOperationsRepository } from '../content-operations'
import { OUTCOME_DATA_CONTRACT_VERSION } from '../outcome-learning'
import { runOwnerProviderObservation } from '../llm-visibility/repository'
import type { ProviderObservationRunInput } from '../llm-visibility/contracts'
import { createMeasurementCollectionRepository } from './repository'
import { resolveCredentialDependencies, type MeasurementCredentialDependencies } from './credentials'
import { ga4DataApiAdapter, googleSearchConsoleAdapter } from './adapters'
import { buildMeasurementWindow, canonicalConnectionFingerprint, deidentifiedSubjectKey, isMeasurementCheckpoint, measurementIdempotencyKey, measurementInputFingerprint, measurementScopeFingerprint, normalizeCanonicalPage, normalizeCredentialReference, normalizeGa4PropertyId, normalizePageScope, normalizeSearchConsoleProperty, publicationLocalDate, sanitizeError } from './normalization'
import { MEASUREMENT_CHECKPOINTS, MEASUREMENT_LEASE_MS, MEASUREMENT_MAX_RETRY_ATTEMPTS, MEASUREMENT_MAX_RUNS_PER_TICK, MEASUREMENT_RETRY_BASE_MS, MEASUREMENT_SOURCES, type AdapterSuccess, type MeasurementAdapterContext, type MeasurementAdapterResult, type MeasurementConnectionInput, type MeasurementConnectionRow, type MeasurementPhase, type MeasurementRepository, type MeasurementRunRow, type MeasurementSnapshotRow, type MeasurementSource, type MeasurementState, type MeasurementWorkspace, type MeasurementSourceSnapshot } from './types'

const providerTargetSchema = z.object({
  provider: z.enum(['chatgpt', 'gemini', 'perplexity']),
  modelLabel: z.string().trim().min(1).max(160),
  adapterKey: z.string().trim().min(1).max(160),
  allowedLocales: z.array(z.enum(['en', 'zh-hant'])).min(1).max(2),
  maximumResponseBytes: z.number().int().min(1).max(2_000_000).default(120_000),
  timeoutMs: z.number().int().min(1_000).max(120_000).default(30_000),
}).strict()

const connectionSchema = z.object({
  clientId: z.number().int().positive(),
  publicationTargetId: z.number().int().positive().nullable().optional(),
  source: z.enum(MEASUREMENT_SOURCES),
  credentialReference: z.string().trim().min(1).max(128).nullable().optional(),
  googleSearchConsoleProperty: z.string().trim().min(1).max(2048).nullable().optional(),
  ga4PropertyId: z.string().trim().min(1).max(12).nullable().optional(),
  llmVisibilityProjectId: z.number().int().positive().nullable().optional(),
  canonicalOrigin: z.string().trim().min(1).max(2048),
  timeZone: z.string().trim().min(1).max(80),
  allowedPageScope: z.array(z.string().trim().min(1).max(2048)).min(1).max(100),
  sourceAvailabilityLagDays: z.number().int().min(0).max(90).optional(),
  providerTargets: z.array(providerTargetSchema).min(1).max(12).nullable().optional(),
  idempotencyKey: z.string().trim().min(1).max(128),
}).strict()

const BASE_LIMITATIONS = ['observational_not_causal', 'attribution_not_established', 'external_factors_not_controlled', 'platform_measurement_may_change']
const NO_CONSENT_LINEAGE = { consentStatus: 'unknown' as const, consentVersion: 'not-configured', consentedAt: '1970-01-01T00:00:00.000Z', consentAllowedUses: ['evaluation'], consentRevokedAt: null, rightsConfirmed: false }

type ContentOpsWithEntries = ContentOperationsRepository

type ServiceDependencies = MeasurementCredentialDependencies & {
  repository?: MeasurementRepository
  contentOperations?: ContentOpsWithEntries
  fetcher?: MeasurementAdapterContext['fetcher']
  runProviderObservation?: typeof runOwnerProviderObservation
  now?: Date
}

function invalid(message: string): never { throw createError({ statusCode: 422, statusMessage: message }) }
function notFound(message: string): never { throw createError({ statusCode: 404, statusMessage: message }) }
function conflict(message: string): never { throw createError({ statusCode: 409, statusMessage: message }) }

function duplicate(error: unknown): boolean {
  const candidate = error as { code?: string; errno?: number; message?: string }
  return candidate.code === 'ER_DUP_ENTRY' || candidate.errno === 1062 || /duplicate entry|unique constraint/i.test(candidate.message || '')
}

function getMeasurementRepository(dependencies?: ServiceDependencies): MeasurementRepository {
  return dependencies?.repository || createMeasurementCollectionRepository()
}

function getContentRepository(dependencies?: ServiceDependencies): ContentOperationsRepository {
  return dependencies?.contentOperations || createContentOperationsRepository()
}

function connectionPageScope(connection: MeasurementConnectionRow): string[] {
  return Array.isArray(connection.allowedPageScope) ? connection.allowedPageScope.filter((value): value is string => typeof value === 'string') : []
}

function connectionMatchesLineage(connection: MeasurementConnectionRow, lineage: DeliveredMeasurementLineage): boolean {
  if (connection.clientId !== lineage.clientId || connection.status !== 'configured') return false
  if (connection.publicationTargetId && connection.publicationTargetId !== lineage.targetId) return false
  try {
    if (!connection.publicationTargetId && new URL(lineage.canonicalPage).origin !== connection.canonicalOrigin) return false
  } catch { return false }
  return connectionPageScope(connection).includes(lineage.canonicalPage)
}

function normalizeProviderTargets(value: unknown): unknown[] | null {
  if (value === null || value === undefined) return null
  if (!Array.isArray(value) || value.length === 0 || value.length > 12) return null
  return value
}

export function parseMeasurementConnectionInput(value: unknown): MeasurementConnectionInput {
  const parsed = connectionSchema.safeParse(value)
  if (!parsed.success) invalid('Invalid measurement connection input.')
  const canonicalOrigin = (() => { try { return normalizePublicHttpsOrigin(parsed.data.canonicalOrigin) } catch { invalid('Measurement canonical origin is invalid.') } })()
  const timeZone = (() => { try { return normalizeTimeZone(parsed.data.timeZone) } catch { invalid('Measurement timezone is invalid.') } })()
  const allowedPageScope = normalizePageScope(parsed.data.allowedPageScope, canonicalOrigin)
  if (!allowedPageScope) invalid('Measurement page scope must contain unique public HTTPS pages on the canonical origin.')
  const credentialReference = normalizeCredentialReference(parsed.data.credentialReference)
  if (parsed.data.credentialReference && !credentialReference) invalid('Credential reference must be an opaque server reference, not a token or header.')
  const providerTargets = normalizeProviderTargets(parsed.data.providerTargets)
  if (parsed.data.providerTargets !== undefined && providerTargets === null) invalid('Provider targets are malformed or exceed the bounded limit.')
  if (parsed.data.source !== 'llm_visibility' && providerTargets !== null) invalid('Provider targets are only valid for LLM visibility connections.')
  const googleSearchConsoleProperty = parsed.data.source === 'google_search_console' ? normalizeSearchConsoleProperty(parsed.data.googleSearchConsoleProperty, canonicalOrigin) : null
  const ga4PropertyId = parsed.data.source === 'first_party_analytics' ? normalizeGa4PropertyId(parsed.data.ga4PropertyId) : null
  const llmVisibilityProjectId = parsed.data.source === 'llm_visibility' ? parsed.data.llmVisibilityProjectId || null : null
  if (parsed.data.source === 'google_search_console' && !googleSearchConsoleProperty) invalid('Google Search Console connection requires a canonical URL-prefix or sc-domain property.')
  if (parsed.data.source === 'first_party_analytics' && !ga4PropertyId) invalid('GA4 connection requires a bounded numeric property ID.')
  if (parsed.data.source === 'llm_visibility' && (!llmVisibilityProjectId || !providerTargets)) invalid('LLM visibility connection requires a project and at least one bounded provider target.')
  const lag = parsed.data.source === 'llm_visibility' ? (parsed.data.sourceAvailabilityLagDays ?? 0) : (parsed.data.sourceAvailabilityLagDays ?? 2)
  return { clientId: parsed.data.clientId, publicationTargetId: parsed.data.publicationTargetId || null, source: parsed.data.source, credentialReference, googleSearchConsoleProperty, ga4PropertyId, llmVisibilityProjectId, canonicalOrigin, timeZone, allowedPageScope, sourceAvailabilityLagDays: lag, providerTargets, idempotencyKey: parsed.data.idempotencyKey }
}

function connectionInsert(ownerUserId: number, input: MeasurementConnectionInput, websiteIdentity: string, fingerprint: string): Omit<MeasurementConnectionRow, 'id' | 'createdAt' | 'updatedAt'> {
  return { ownerUserId, clientId: input.clientId, publicationTargetId: input.publicationTargetId || null, websiteIdentity, source: input.source, activeSource: input.source, status: 'configured', credentialReference: input.credentialReference || null, googleSearchConsoleProperty: input.googleSearchConsoleProperty || null, ga4PropertyId: input.ga4PropertyId || null, llmVisibilityProjectId: input.llmVisibilityProjectId || null, canonicalOrigin: input.canonicalOrigin, timeZone: input.timeZone, allowedPageScope: input.allowedPageScope, sourceAvailabilityLagDays: input.sourceAvailabilityLagDays || 0, providerTargets: input.providerTargets || null, idempotencyKey: input.idempotencyKey, configurationFingerprint: fingerprint, connectedAt: null, revokedAt: null }
}

export async function createMeasurementConnection(ownerUserId: number, value: unknown, dependencies?: ServiceDependencies) {
  const repository = getMeasurementRepository(dependencies)
  const contentRepository = getContentRepository(dependencies)
  const input = parseMeasurementConnectionInput(value)
  const client = await repository.findClient(ownerUserId, input.clientId)
  const target = input.publicationTargetId ? await contentRepository.findPublicationTarget(ownerUserId, input.publicationTargetId) : null
  const expectedOrigin = target?.targetOrigin || client?.canonicalSiteOrigin
  if (!client || (Boolean(input.publicationTargetId) && !target) || (target && (target.clientId !== client.id || target.status === 'revoked')) || expectedOrigin !== input.canonicalOrigin) notFound('Measurement client or publication target was not found for this owner and origin.')
  const websiteIdentity = target ? `target:${target.id}` : `client-origin:${createHash('sha256').update(input.canonicalOrigin).digest('hex')}`
  const fingerprint = canonicalConnectionFingerprint(input as MeasurementConnectionInput & { canonicalOrigin: string; timeZone: string; allowedPageScope: string[]; sourceAvailabilityLagDays: number; credentialReference: string | null; googleSearchConsoleProperty: string | null; ga4PropertyId: string | null; llmVisibilityProjectId: number | null; providerTargets: unknown[] | null })
  const replay = await repository.findConnectionByIdempotency(ownerUserId, input.idempotencyKey)
  if (replay) {
    if (replay.configurationFingerprint !== fingerprint) conflict('Measurement connection idempotency key is associated with a different configuration.')
    return { connection: replay, replayed: true }
  }
  const existing = (await repository.listConnections(ownerUserId)).filter(connection => connection.websiteIdentity === websiteIdentity && connection.source === input.source)
  const current = existing.find(connection => connection.status !== 'revoked')
  if (current) {
    if (current.configurationFingerprint === fingerprint) return { connection: current, replayed: true }
    conflict('An owner/client/source measurement connection is still active; revoke it before creating a replacement configuration.')
  }
  try {
    const connection = await repository.insertConnection(connectionInsert(ownerUserId, input, websiteIdentity, fingerprint))
    return { connection, replayed: false }
  } catch (error) {
    if (duplicate(error)) {
      const row = await repository.findConnectionByIdempotency(ownerUserId, input.idempotencyKey)
      if (row && row.configurationFingerprint === fingerprint) return { connection: row, replayed: true }
    }
    throw error
  }
}

export async function pauseMeasurementConnection(ownerUserId: number, connectionId: number, dependencies?: ServiceDependencies) {
  const repository = getMeasurementRepository(dependencies)
  const connection = await repository.findConnection(ownerUserId, connectionId)
  if (!connection) notFound('Measurement connection was not found.')
  if (connection.status === 'revoked') return connection
  return repository.updateConnection(ownerUserId, connectionId, { status: 'paused' })
}

export async function revokeMeasurementConnection(ownerUserId: number, connectionId: number, dependencies?: ServiceDependencies) {
  const repository = getMeasurementRepository(dependencies)
  const connection = await repository.findConnection(ownerUserId, connectionId)
  if (!connection) notFound('Measurement connection was not found.')
  if (connection.status === 'revoked') return connection
  return repository.updateConnection(ownerUserId, connectionId, { status: 'revoked', activeSource: null, revokedAt: dependencies?.now || new Date() })
}

function projectDeliveredMeasurementLineage(delivered: Awaited<ReturnType<ContentOperationsRepository['resolveDeliveredPublication']>>, target = delivered?.publicationTarget, attempt = delivered?.publicationAttempt, publicationRun = delivered?.publicationRun) {
  if (!delivered || !target || !attempt || !publicationRun || attempt.status !== 'delivered' || publicationRun.stage !== 'publication' || publicationRun.state !== 'succeeded' || attempt.runId !== publicationRun.id || attempt.targetId !== target.id || attempt.contentHash !== delivered.entry.contentHash || attempt.evidenceSnapshotHash !== delivered.entry.evidenceSnapshotHash || typeof attempt.receiptFingerprint !== 'string' || !/^[a-f0-9]{64}$/u.test(attempt.receiptFingerprint)) return null
  const targetOrigin = target.targetOrigin
  const publicationUrl = attempt.publicationUrl || (targetOrigin && delivered.entry.publicationPath ? `${targetOrigin}${delivered.entry.publicationPath.startsWith('/') ? '' : '/'}${delivered.entry.publicationPath}` : null)
  if (!publicationUrl || !delivered.entry.contentHash || !delivered.entry.evidenceSnapshotHash) return null
  const canonicalPage = normalizeCanonicalPage(publicationUrl, targetOrigin)
  if (!canonicalPage) return null
  const publishedAt = attempt.completedAt || publicationRun.completedAt || delivered.entry.updatedAt
  if (!(publishedAt instanceof Date) || !Number.isFinite(publishedAt.getTime())) return null
  return { entryId: delivered.entry.id, targetId: target.id, clientId: delivered.calendar.clientId, canonicalPage, publicationReceiptFingerprint: attempt.receiptFingerprint, contentHash: delivered.entry.contentHash, evidenceSnapshotHash: delivered.entry.evidenceSnapshotHash, timeZone: delivered.calendar.timeZone, publicationLocalDate: publicationLocalDate(publishedAt, delivered.calendar.timeZone), publishedAt }
}

async function resolveDeliveredMeasurementLineages(ownerUserId: number, entryId: number, contentRepository: ContentOperationsRepository) {
  const delivered = await contentRepository.resolveDeliveredPublication(ownerUserId, entryId)
  const autopilotAuthority = typeof delivered?.authorityReference === 'string' && /^ref-autopilot-[A-Za-z0-9._:-]+$/u.test(delivered.authorityReference)
  const manualReviewValid = delivered?.review?.decision === 'approved_for_delivery'
  if (!delivered || (delivered.entry.status !== 'delivered' && delivered.entry.status !== 'completed') || !delivered.job || !delivered.draft || !delivered.riskGate || delivered.riskGate.status !== 'passed' || (!autopilotAuthority && !manualReviewValid)) return []
  const primary = projectDeliveredMeasurementLineage(delivered)
  if (typeof contentRepository.listEntryTargetBindings !== 'function' || typeof contentRepository.listPublicationTargets !== 'function' || typeof contentRepository.listPublicationAttempts !== 'function' || typeof contentRepository.listRuns !== 'function') return primary ? [primary] : []
  const [bindings, targets, attempts, runs] = await Promise.all([
    contentRepository.listEntryTargetBindings(ownerUserId, entryId),
    contentRepository.listPublicationTargets(ownerUserId),
    contentRepository.listPublicationAttempts(ownerUserId, entryId),
    contentRepository.listRuns(ownerUserId, entryId),
  ])
  if (!bindings.length) return primary ? [primary] : []
  const targetById = new Map(targets.filter(target => target.ownerUserId === ownerUserId && target.clientId === delivered.calendar.clientId).map(target => [target.id, target]))
  const lineages = bindings
    .filter(binding => binding.ownerUserId === ownerUserId && binding.clientId === delivered.calendar.clientId && binding.entryId === entryId)
    .sort((left, right) => left.slot - right.slot)
    .flatMap(binding => {
      const target = targetById.get(binding.targetId)
      const attempt = attempts.find(candidate => candidate.ownerUserId === ownerUserId && candidate.entryId === entryId && candidate.targetId === binding.targetId && candidate.status === 'delivered' && candidate.contentHash === delivered.entry.contentHash && candidate.evidenceSnapshotHash === delivered.entry.evidenceSnapshotHash && typeof candidate.receiptFingerprint === 'string' && /^[a-f0-9]{64}$/u.test(candidate.receiptFingerprint))
      const run = attempt ? runs.find(candidate => candidate.id === attempt.runId && candidate.ownerUserId === ownerUserId && candidate.entryId === entryId && candidate.stage === 'publication' && candidate.state === 'succeeded') : undefined
      const lineage = target && attempt && run ? projectDeliveredMeasurementLineage(delivered, target, attempt, run) : null
      return lineage ? [lineage] : []
    })
  return lineages
}

type DeliveredMeasurementLineage = Awaited<ReturnType<typeof resolveDeliveredMeasurementLineages>>[number]

function runInsert(ownerUserId: number, connection: MeasurementConnectionRow, lineage: DeliveredMeasurementLineage, checkpointDays: typeof MEASUREMENT_CHECKPOINTS[number], now: Date): Omit<MeasurementRunRow, 'id' | 'createdAt' | 'updatedAt'> {
  const window = buildMeasurementWindow(lineage.publicationLocalDate, lineage.timeZone, checkpointDays, connection.sourceAvailabilityLagDays, now, lineage.publishedAt)
  const scopeFingerprint = measurementScopeFingerprint({ ownerUserId, clientId: lineage.clientId, websiteOrigin: connection.canonicalOrigin, entryId: lineage.entryId, targetId: lineage.targetId, canonicalPage: lineage.canonicalPage, source: connection.source, checkpointDays })
  const idempotencyKey = measurementIdempotencyKey({ ownerUserId, entryId: lineage.entryId, targetId: lineage.targetId, source: connection.source, checkpointDays, baselineStart: window.baselineStart, followUpStart: window.followUpStart })
  const inputFingerprint = measurementInputFingerprint({ ownerUserId, connectionId: connection.id, entryId: lineage.entryId, targetId: lineage.targetId, source: connection.source, checkpointDays, publicationReceiptFingerprint: lineage.publicationReceiptFingerprint, canonicalPage: lineage.canonicalPage, contentHash: lineage.contentHash, evidenceSnapshotHash: lineage.evidenceSnapshotHash, scopeFingerprint, baselineStart: window.baselineStart.toISOString(), baselineEnd: window.baselineEnd.toISOString(), followUpStart: window.followUpStart.toISOString(), followUpEnd: window.followUpEnd.toISOString(), dueAt: window.dueAt.toISOString() })
  return { ownerUserId, clientId: lineage.clientId, connectionId: connection.id, entryId: lineage.entryId, targetId: lineage.targetId, source: connection.source, checkpointDays, publicationReceiptFingerprint: lineage.publicationReceiptFingerprint, canonicalPage: lineage.canonicalPage, contentHash: lineage.contentHash, evidenceSnapshotHash: lineage.evidenceSnapshotHash, publicationLocalDate: lineage.publicationLocalDate, timeZone: lineage.timeZone, baselineWindowStart: window.baselineStart, baselineWindowEnd: lineage.publishedAt, followUpWindowStart: lineage.publishedAt, followUpWindowEnd: window.followUpEnd, dueAt: window.dueAt, state: 'queued', attemptNumber: 0, leaseOwner: null, leaseExpiresAt: null, retryEligibleAt: null, idempotencyKey, inputFingerprint, outputFingerprint: null, errorCode: null, errorSummary: null, startedAt: null, completedAt: null }
}

async function blockStaleRuns(ownerUserId: number, lineage: DeliveredMeasurementLineage, repository: MeasurementRepository) {
  const existing = await repository.listRuns(ownerUserId, { entryId: lineage.entryId })
  for (const run of existing) {
    if (run.targetId !== lineage.targetId || (run.state === 'succeeded' || run.state === 'cancelled')) continue
    const stale = run.publicationReceiptFingerprint !== lineage.publicationReceiptFingerprint || run.contentHash !== lineage.contentHash || run.evidenceSnapshotHash !== lineage.evidenceSnapshotHash || run.canonicalPage !== lineage.canonicalPage
    if (stale) await repository.updateRun(ownerUserId, run.id, { state: 'blocked', errorCode: 'STALE_PUBLICATION_LINEAGE', errorSummary: 'stale publication lineage', leaseOwner: null, leaseExpiresAt: null, completedAt: new Date() })
  }
}

export async function scheduleMeasurementForEntry(ownerUserId: number, entryId: number, dependencies?: ServiceDependencies) {
  const repository = getMeasurementRepository(dependencies)
  const contentRepository = getContentRepository(dependencies)
  const lineages = await resolveDeliveredMeasurementLineages(ownerUserId, entryId, contentRepository)
  if (!lineages.length) invalid('Measurement scheduling requires at least one validated delivered publication receipt.')
  const connections = await repository.listConnections(ownerUserId)
  const runs: MeasurementRunRow[] = []
  for (const lineage of lineages) {
    await blockStaleRuns(ownerUserId, lineage, repository)
    for (const connection of connections) {
      if (!connectionMatchesLineage(connection, lineage)) continue
      for (const checkpointDays of MEASUREMENT_CHECKPOINTS) {
        const insert = runInsert(ownerUserId, connection, lineage, checkpointDays, dependencies?.now || new Date())
        const existing = await repository.findRunByIdempotency(ownerUserId, insert.idempotencyKey)
        if (existing) {
          if (existing.inputFingerprint !== insert.inputFingerprint && existing.state !== 'succeeded') await repository.updateRun(ownerUserId, existing.id, { state: 'blocked', errorCode: 'STALE_PUBLICATION_LINEAGE', errorSummary: 'stale publication lineage' })
          runs.push(await repository.findRun(ownerUserId, existing.id) as MeasurementRunRow)
        } else runs.push(await repository.insertRun(insert))
      }
    }
  }
  return { entryId, targetIds: lineages.map(lineage => lineage.targetId), scheduled: runs.length, runs }
}

function adapterFor(source: MeasurementSource) {
  if (source === 'google_search_console') return googleSearchConsoleAdapter
  if (source === 'first_party_analytics') return ga4DataApiAdapter
  return null
}

function retryDate(now: Date, attemptNumber: number): Date {
  return new Date(now.getTime() + MEASUREMENT_RETRY_BASE_MS * Math.pow(2, Math.max(0, Math.min(4, attemptNumber - 1))))
}

function snapshotInput(row: MeasurementSnapshotRow) {
  return { source: row.source, deidentifiedSubjectKey: row.deidentifiedSubjectKey, scopeFingerprint: row.scopeFingerprint, phase: row.phase, windowStart: row.windowStart instanceof Date ? row.windowStart.toISOString() : new Date(row.windowStart).toISOString(), windowEnd: row.windowEnd instanceof Date ? row.windowEnd.toISOString() : new Date(row.windowEnd).toISOString(), capturedAt: row.capturedAt instanceof Date ? row.capturedAt.toISOString() : new Date(row.capturedAt).toISOString(), sourceHash: row.sourceHash, metrics: row.normalizedMetrics }
}

async function assessMeasurementOutcome(ownerUserId: number, run: MeasurementRunRow, repository: MeasurementRepository, contentRepository: ContentOperationsRepository, now: Date) {
  const runs = (await repository.listRuns(ownerUserId, { entryId: run.entryId })).filter(candidate => candidate.targetId === run.targetId && candidate.checkpointDays === run.checkpointDays && candidate.publicationReceiptFingerprint === run.publicationReceiptFingerprint && candidate.contentHash === run.contentHash && candidate.evidenceSnapshotHash === run.evidenceSnapshotHash)
  const snapshots = (await Promise.all(runs.map(candidate => repository.listSnapshots(ownerUserId, candidate.id)))).flat()
  const outcomeSnapshots = snapshots.filter(snapshot => snapshot.source !== 'llm_visibility')
  const baselineMeasurements = outcomeSnapshots.filter(snapshot => snapshot.phase === 'baseline').map(snapshotInput)
  const followUpMeasurements = outcomeSnapshots.filter(snapshot => snapshot.phase === 'follow_up').map(snapshotInput)
  const sourceHashes = outcomeSnapshots.map(snapshot => snapshot.sourceHash).sort()
  const idempotencyKey = `measurement-outcome:${createHash('sha256').update(JSON.stringify({ ownerUserId, entryId: run.entryId, targetId: run.targetId, checkpointDays: run.checkpointDays, sourceHashes })).digest('hex')}`.slice(0, 128)
  return recordOwnerOutcomeAssessment(ownerUserId, { entryId: run.entryId, targetId: run.targetId, idempotencyKey, baselineMeasurements, followUpMeasurements, consent: NO_CONSENT_LINEAGE, dataContractVersion: OUTCOME_DATA_CONTRACT_VERSION, measuredAt: now.toISOString(), learningCandidate: false }, contentRepository)
}

async function collectLlmSnapshot(ownerUserId: number, run: MeasurementRunRow, connection: MeasurementConnectionRow, phase: MeasurementPhase, windowStart: Date, windowEnd: Date, canonicalPage: string, scopeFingerprint: string, dependencies: ServiceDependencies): Promise<MeasurementAdapterResult> {
  if (!connection.llmVisibilityProjectId || !Array.isArray(connection.providerTargets) || connection.providerTargets.length === 0) return { status: 'blocked', code: 'LLM_VISIBILITY_NOT_CONFIGURED', summary: 'llm visibility is not configured', retryable: false, limitations: ['llm_visibility_project_or_provider_not_configured'] }
  const scope = await getMeasurementRepository(dependencies).listLlmScope(ownerUserId, connection.llmVisibilityProjectId)
  if (!scope.project || scope.project.status !== 'active' || scope.project.canonicalDomain !== new URL(canonicalPage).hostname) return { status: 'blocked', code: 'LLM_SCOPE_INVALID', summary: 'llm visibility scope is invalid', retryable: false, limitations: ['llm_visibility_scope_mismatch'] }
  if (!scope.queries.length) return { status: 'insufficient_data', reasonCode: 'NO_ACTIVE_QUERIES', limitations: ['llm_visibility_no_active_queries'] }
  const providerRunner = dependencies.runProviderObservation || runOwnerProviderObservation
  const observationWindowKey = `measurement:${run.id}:${phase}:${windowStart.toISOString()}:${windowEnd.toISOString()}`
  try {
    const result = await providerRunner(ownerUserId, { projectId: scope.project.id, queryIds: scope.queries.map(query => query.id), observationWindowKey, maximumProbes: Math.min(50, scope.queries.length * connection.providerTargets.length), providerTargets: connection.providerTargets as ProviderObservationRunInput['providerTargets'] })
    const batch = result.runtime.batch
    if (batch.status === 'blocked') return { status: 'blocked', code: 'LLM_PROVIDER_PLAN_BLOCKED', summary: 'llm visibility provider plan blocked', retryable: false, limitations: ['provider_api_observation_secondary_only', 'consumer_surface_equivalent_false'] }
    const candidates = batch.results.flatMap(item => item.status === 'completed' && item.candidate ? [item.candidate] : [])
    const retryable = batch.counts.retryable > 0
    if (!candidates.length) return retryable ? { status: 'retry_wait', code: 'LLM_PROVIDER_RETRYABLE', summary: 'llm visibility provider retryable failure', retryable: true, limitations: ['provider_api_observation_secondary_only'] } : { status: 'insufficient_data', reasonCode: 'NO_PROVIDER_OBSERVATIONS', limitations: ['provider_api_observation_secondary_only'] }
    const mentionCount = candidates.filter(candidate => candidate.brandMentioned).length
    const citationCount = candidates.filter(candidate => candidate.citationUrls.length > 0).length
    const metrics = { queryCount: candidates.length, mentionCount, citationCount }
    const capturedAt = dependencies.now || new Date()
    const snapshot = (await import('./normalization')).buildSnapshot({ source: 'llm_visibility', phase, deidentifiedSubjectKey: deidentifiedSubjectKey(ownerUserId), scopeFingerprint, windowStart, windowEnd, capturedAt, metrics, providerProvenance: { adapterVersion: 'llm-visibility-existing-runtime', observationMode: 'provider_api_observation', verifiedByOwner: false, metricEligibility: 'secondary_only', consumerSurfaceEquivalent: false, providerCount: new Set(candidates.map(candidate => candidate.provider)).size, observationCount: candidates.length }, limitations: ['provider_api_observation_secondary_only', 'consumer_surface_equivalent_false', 'manual_verified_observation_required_for_primary_metrics'] })
    if (!snapshot) return { status: 'failed', code: 'NORMALIZATION_FAILED', summary: 'normalized llm visibility result was rejected', retryable: false, limitations: ['normalized_metrics_rejected'] }
    return { status: 'succeeded', snapshot }
  } catch {
    return { status: 'retry_wait', code: 'LLM_PROVIDER_RUNTIME_ERROR', summary: 'llm visibility provider runtime error', retryable: true, limitations: ['provider_api_observation_secondary_only'] }
  }
}

async function collectPhase(ownerUserId: number, run: MeasurementRunRow, connection: MeasurementConnectionRow, phase: MeasurementPhase, dependencies: ServiceDependencies, scopeFingerprint: string): Promise<MeasurementAdapterResult> {
  const windowStart = phase === 'baseline' ? run.baselineWindowStart : run.followUpWindowStart
  const windowEnd = phase === 'baseline' ? run.baselineWindowEnd : run.followUpWindowEnd
  if (run.source === 'llm_visibility') return collectLlmSnapshot(ownerUserId, run, connection, phase, windowStart, windowEnd, run.canonicalPage, scopeFingerprint, dependencies)
  const adapter = adapterFor(run.source)
  if (!adapter) return { status: 'blocked', code: 'SOURCE_UNSUPPORTED', summary: 'measurement source is unsupported', retryable: false, limitations: ['source_not_supported'] }
  const context: MeasurementAdapterContext = { ownerUserId, connection, run, phase, windowStart, windowEnd, canonicalPage: run.canonicalPage, deidentifiedSubjectKey: deidentifiedSubjectKey(ownerUserId), scopeFingerprint, resolver: resolveCredentialDependencies(dependencies).googleCredentialResolver, fetcher: dependencies.fetcher, now: dependencies.now || new Date() }
  return adapter.collect(context)
}

async function executeClaimedRun(ownerUserId: number, run: MeasurementRunRow, dependencies: ServiceDependencies = {}): Promise<{ state: MeasurementState; assessment: unknown | null; errorCode?: string }> {
  const repository = getMeasurementRepository(dependencies)
  const contentRepository = getContentRepository(dependencies)
  const connection = await repository.findConnection(ownerUserId, run.connectionId)
  if (!connection) return { state: 'blocked', assessment: null, errorCode: 'CONNECTION_NOT_FOUND' }
  if (connection.status === 'revoked') return { state: 'blocked', assessment: null, errorCode: 'CONNECTION_REVOKED' }
  if (connection.status === 'paused') return { state: 'blocked', assessment: null, errorCode: 'CONNECTION_PAUSED' }
  const lineages = await resolveDeliveredMeasurementLineages(ownerUserId, run.entryId, contentRepository)
  const lineage = lineages.find(candidate => candidate.targetId === run.targetId)
  if (!lineage || lineage.publicationReceiptFingerprint !== run.publicationReceiptFingerprint || lineage.contentHash !== run.contentHash || lineage.evidenceSnapshotHash !== run.evidenceSnapshotHash || lineage.canonicalPage !== run.canonicalPage) return { state: 'blocked', assessment: null, errorCode: 'STALE_PUBLICATION_LINEAGE' }
  const scopeFingerprint = measurementScopeFingerprint({ ownerUserId, clientId: run.clientId, websiteOrigin: connection.canonicalOrigin, entryId: run.entryId, targetId: run.targetId, canonicalPage: run.canonicalPage, source: run.source, checkpointDays: run.checkpointDays })
  const results: MeasurementAdapterResult[] = []
  for (const phase of ['baseline', 'follow_up'] as const) {
    const existing = await repository.findSnapshot(ownerUserId, run.id, phase)
    if (existing) continue
    const result = await collectPhase(ownerUserId, run, connection, phase, dependencies, scopeFingerprint)
    if (result.status !== 'succeeded') {
      if ('code' in result && ['NEEDS_REAUTHORIZATION', 'TOKEN_EXPIRED', 'REQUIRED_SCOPE_MISSING'].includes(result.code)) await repository.updateConnection(ownerUserId, connection.id, { status: 'needs_reauthorization' })
      if (result.status === 'insufficient_data') return { state: 'insufficient_data', assessment: await assessMeasurementOutcome(ownerUserId, run, repository, contentRepository, dependencies.now || new Date()), errorCode: result.reasonCode }
      return { state: result.status === 'retry_wait' && run.attemptNumber < MEASUREMENT_MAX_RETRY_ATTEMPTS ? 'retry_wait' : result.status === 'retry_wait' ? 'failed' : result.status, assessment: null, errorCode: result.code }
    }
    results.push(result)
    const snapshot = result.snapshot
    await repository.insertSnapshot({ ownerUserId, runId: run.id, entryId: run.entryId, targetId: run.targetId, source: snapshot.source, phase: snapshot.phase, deidentifiedSubjectKey: snapshot.deidentifiedSubjectKey, scopeFingerprint: snapshot.scopeFingerprint, windowStart: new Date(snapshot.windowStart), windowEnd: new Date(snapshot.windowEnd), capturedAt: new Date(snapshot.capturedAt), sourceHash: snapshot.sourceHash, normalizedMetrics: snapshot.normalizedMetrics, providerProvenance: snapshot.providerProvenance, limitations: snapshot.limitations })
  }
  if (connection.source !== 'llm_visibility' && (connection.status === 'needs_reauthorization' || !connection.connectedAt)) await repository.updateConnection(ownerUserId, connection.id, { status: 'configured', connectedAt: dependencies.now || new Date() })
  const assessment = await assessMeasurementOutcome(ownerUserId, run, repository, contentRepository, dependencies.now || new Date())
  return { state: 'succeeded', assessment, errorCode: undefined }
}

export async function processMeasurementRun(ownerUserId: number, runId: number, dependencies?: ServiceDependencies) {
  const repository = getMeasurementRepository(dependencies)
  const now = dependencies?.now || new Date()
  const leaseOwner = `measurement-worker:${createHash('sha256').update(`${ownerUserId}:${runId}:${now.toISOString()}`).digest('hex').slice(0, 24)}`
  const candidate = await repository.findRun(ownerUserId, runId)
  if (!candidate) notFound('Measurement run was not found.')
  if (candidate.state === 'succeeded') return { run: candidate, replayed: true, assessment: null }
  const claimed = await repository.acquireRunLease(ownerUserId, runId, leaseOwner, now, MEASUREMENT_LEASE_MS)
  if (!claimed) {
    const current = await repository.findRun(ownerUserId, runId)
    return { run: current || candidate, replayed: true, assessment: null }
  }
  try {
    const result = await executeClaimedRun(ownerUserId, claimed, dependencies)
    const patch = result.state === 'retry_wait' ? { retryEligibleAt: retryDate(now, claimed.attemptNumber), errorCode: result.errorCode || 'RETRYABLE_FAILURE', errorSummary: sanitizeError({ code: result.errorCode || 'RETRYABLE_FAILURE' }).summary } : { retryEligibleAt: null, errorCode: result.errorCode || null, errorSummary: result.errorCode ? sanitizeError({ code: result.errorCode }).summary : null, outputFingerprint: result.assessment ? measurementInputFingerprint(result.assessment) : null }
    const released = await repository.releaseRunLease(ownerUserId, runId, leaseOwner, result.state, now, patch)
    if (!released) conflict('Measurement run lease was lost before completion.')
    return { run: released, replayed: false, assessment: result.assessment }
  } catch (error) {
    const safe = sanitizeError(error, 'MEASUREMENT_RUNTIME_ERROR')
    const terminal = claimed.attemptNumber >= MEASUREMENT_MAX_RETRY_ATTEMPTS
    const state: MeasurementState = terminal ? 'failed' : 'retry_wait'
    const released = await repository.releaseRunLease(ownerUserId, runId, leaseOwner, state, now, { retryEligibleAt: terminal ? null : retryDate(now, claimed.attemptNumber), errorCode: safe.code, errorSummary: safe.summary })
    if (!released) throw error
    return { run: released, replayed: false, assessment: null }
  }
}

export async function runMeasurementCollectionTick(ownerUserId: number, dependencies?: ServiceDependencies & { maxRuns?: number }) {
  const repository = getMeasurementRepository(dependencies)
  const contentRepository = getContentRepository(dependencies)
  const now = dependencies?.now || new Date()
  const entries = await contentRepository.listEntries(ownerUserId)
  let scheduled = 0
  for (const entry of entries.filter(item => item.status === 'delivered' || item.status === 'completed').slice(0, 500)) {
    try { scheduled += (await scheduleMeasurementForEntry(ownerUserId, entry.id, dependencies)).scheduled } catch { /* stale or invalid delivery is intentionally fail-closed */ }
  }
  const maxRuns = Math.max(1, Math.min(MEASUREMENT_MAX_RUNS_PER_TICK, Math.trunc(dependencies?.maxRuns || MEASUREMENT_MAX_RUNS_PER_TICK)))
  const eligible = await repository.listEligibleRuns(now, maxRuns, ownerUserId)
  let succeeded = 0
  let insufficientData = 0
  let blocked = 0
  let failed = 0
  let retryWait = 0
  const processed: MeasurementRunRow[] = []
  for (const run of eligible.slice(0, maxRuns)) {
    const result = await processMeasurementRun(ownerUserId, run.id, dependencies)
    processed.push(result.run)
    if (result.run.state === 'succeeded') succeeded += 1
    else if (result.run.state === 'insufficient_data') insufficientData += 1
    else if (result.run.state === 'blocked') blocked += 1
    else if (result.run.state === 'retry_wait') retryWait += 1
    else if (result.run.state === 'failed') failed += 1
  }
  return { ownerUserId, scheduled, selected: eligible.length, processed, counts: { succeeded, insufficientData, blocked, failed, retryWait }, limitations: [...BASE_LIMITATIONS, 'scheduler processes at most 50 runs per tick', 'mocked provider tests do not validate production credentials or customer-site connectivity'] }
}

export async function retryMeasurementRun(ownerUserId: number, runId: number, dependencies?: ServiceDependencies) {
  const repository = getMeasurementRepository(dependencies)
  const run = await repository.findRun(ownerUserId, runId)
  if (!run) notFound('Measurement run was not found.')
  if (run.state === 'succeeded') conflict('A succeeded measurement run is terminal and cannot be retried.')
  if (run.state === 'processing') conflict('A processing measurement run cannot be manually retried.')
  if (run.attemptNumber >= MEASUREMENT_MAX_RETRY_ATTEMPTS) conflict('Measurement retry budget is exhausted.')
  return repository.updateRun(ownerUserId, runId, { state: 'retry_wait', retryEligibleAt: dependencies?.now || new Date(), errorCode: null, errorSummary: null, completedAt: null })
}

export async function dryRunMeasurementForEntry(ownerUserId: number, entryId: number, dependencies?: ServiceDependencies) {
  const repository = getMeasurementRepository(dependencies)
  const contentRepository = getContentRepository(dependencies)
  const lineages = await resolveDeliveredMeasurementLineages(ownerUserId, entryId, contentRepository)
  if (!lineages.length) invalid('Measurement dry-run requires at least one validated delivered publication receipt.')
  const connections = await repository.listConnections(ownerUserId)
  return { entryId, targets: lineages.map(lineage => ({ targetId: lineage.targetId, canonicalPage: lineage.canonicalPage })), planned: lineages.flatMap(lineage => connections.filter(connection => connectionMatchesLineage(connection, lineage)).flatMap(connection => MEASUREMENT_CHECKPOINTS.map(checkpointDays => { const window = buildMeasurementWindow(lineage.publicationLocalDate, lineage.timeZone, checkpointDays, connection.sourceAvailabilityLagDays, dependencies?.now || new Date(), lineage.publishedAt); return { targetId: lineage.targetId, canonicalPage: lineage.canonicalPage, connectionId: connection.id, source: connection.source, checkpointDays, baselineWindow: { start: window.baselineStart.toISOString(), end: window.baselineEnd.toISOString() }, followUpWindow: { start: window.followUpStart.toISOString(), end: window.followUpEnd.toISOString() }, dueAt: window.dueAt.toISOString(), exactPageScope: lineage.canonicalPage, providerRequestPlanned: connection.source !== 'llm_visibility' } }))), limitations: [...BASE_LIMITATIONS, 'dry-run does not call external providers or resolve credentials'] }
}

export async function dryRunMeasurementRun(ownerUserId: number, runId: number, dependencies?: ServiceDependencies) {
  const repository = getMeasurementRepository(dependencies)
  const run = await repository.findRun(ownerUserId, runId)
  if (!run) notFound('Measurement run was not found.')
  const preview = await dryRunMeasurementForEntry(ownerUserId, run.entryId, dependencies)
  return { ...preview, planned: preview.planned.filter(item => item.targetId === run.targetId && item.connectionId === run.connectionId && item.checkpointDays === run.checkpointDays), runId }
}

function readiness(connection: MeasurementConnectionRow): 'ready' | 'not_ready' | 'paused' | 'revoked' | 'needs_reauthorization' {
  if (connection.status === 'paused') return 'paused'
  if (connection.status === 'revoked') return 'revoked'
  if (connection.status === 'needs_reauthorization') return 'needs_reauthorization'
  return connection.source === 'llm_visibility' ? 'ready' : 'not_ready'
}

export async function getMeasurementCollectionWorkspace(ownerUserId: number, dependencies?: ServiceDependencies): Promise<MeasurementWorkspace> {
  const repository = getMeasurementRepository(dependencies)
  const contentRepository = getContentRepository(dependencies)
  const [connections, runs, snapshots, outcomes, clients] = await Promise.all([repository.listConnections(ownerUserId), repository.listRuns(ownerUserId), repository.listSnapshots(ownerUserId), contentRepository.listOutcomes(ownerUserId), contentRepository.listClients(ownerUserId)])
  const checkpoints: MeasurementWorkspace['checkpoints'] = {}
  for (const run of runs) {
    const runSnapshots = snapshots.filter(snapshot => snapshot.runId === run.id)
    const key = `${run.entryId}:${run.targetId}:${run.source}:${run.checkpointDays}`
    const baselineReady = runSnapshots.some(snapshot => snapshot.phase === 'baseline')
    const followUpReady = runSnapshots.some(snapshot => snapshot.phase === 'follow_up')
    const outcome = outcomes.find(candidate => candidate.entryId === run.entryId && candidate.contentHash === run.contentHash && candidate.evidenceSnapshotHash === run.evidenceSnapshotHash)
    const status = outcome && typeof outcome.assessmentStatus === 'string' && ['ready', 'partial', 'insufficient_data', 'blocked'].includes(outcome.assessmentStatus) ? outcome.assessmentStatus as 'ready' | 'partial' | 'insufficient_data' | 'blocked' : 'not_ready'
    checkpoints[key] = { state: run.state, baselineReady, followUpReady, outcomeStatus: status, limitations: [...BASE_LIMITATIONS, ...runSnapshots.flatMap(snapshot => Array.isArray(snapshot.limitations) ? snapshot.limitations as string[] : [])].filter((value, index, array) => array.indexOf(value) === index).slice(0, 20) }
  }
  const safeConnections = connections.map(connection => ({ ...connection, credentialReference: null, credentialConfigured: Boolean(connection.credentialReference), readiness: readiness(connection) })) as MeasurementWorkspace['connections']
  return { clients: clients.map(client => ({ id: client.id, displayName: client.displayName, canonicalSiteOrigin: client.canonicalSiteOrigin, timeZone: client.timeZone })), connections: safeConnections, runs, snapshots, checkpoints, capabilities: { schedulerAvailable: true, realGoogleOAuth: false, realProviderCalls: false, outcomeCollectionConfigured: true }, limitations: [...BASE_LIMITATIONS, 'credential references are opaque and are never returned', 'provider API LLM observations remain secondary-only and are not primary learning labels', 'no production provider validation is performed by this V1'] }
}

export type { ServiceDependencies as MeasurementCollectionDependencies }

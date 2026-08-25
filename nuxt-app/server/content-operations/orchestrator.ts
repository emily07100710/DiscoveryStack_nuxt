import { createHash, randomUUID } from 'node:crypto'
import { createError } from 'h3'
import { executeFirstPartyPublication } from '../first-party-publishing/executor'
import { validateFirstPartyPublishTarget } from '../first-party-publishing/target-guard'
import type { ApprovedFirstPartyPublication, FirstPartyExecutionResult, FirstPartyFetch, NonceProvider, ServerCredentialResolver } from '../first-party-publishing/types'
import { runOwnerProductionDeliverable, type ProductionRuntimeDependencies } from '../seo-geo-core/service'
import type { ContentOperationsRepository, EventInsert, PublicationAttemptFinalization, PublicationAttemptInsert, PublicationAttemptReservation, PublicationTargetInsert, RunInsert } from './repository'
import { createContentOperationsRepository } from './repository'
import { buildPublicationIdentity, validatePersistedPublicationIdentity, type PublicationIdentity } from './publication-identity'
import { materializeOwnerDueContent, getDefaultContentOperationsClock } from './service'
import { getContentOperationsRuntimeDependencies } from './runtime-dependencies'
import { parseExecuteInput, parsePublicationTargetInput, parsePublicationTargetPatchInput, sanitizeErrorSummary, stableFingerprint, stableStringify } from './normalization'
import type { Clock, ContentOperationCalendarEntryRow, ContentOperationPublicationTargetRow, ContentOperationRunRow, ExecuteContentOperationInput, ExecuteContentOperationResult, PublicationTargetInput, PublicationTargetPatchInput } from './types'

const MAX_ATTEMPTS = 3
const DEFAULT_LEASE_MS = 5 * 60 * 1000
const FIVE_MINUTES = 5 * 60 * 1000
const THIRTY_MINUTES = 30 * 60 * 1000

type ContentDraftResult = {
  job?: { id: number; status?: string }
  draft?: { id: number; version?: number }
  riskGate?: { status: string }
  replayed?: boolean
}

type OrchestratorClock = Clock

type FirstPartyPublicationExecutor = (input: {
  target: Record<string, unknown>
  publication: ApprovedFirstPartyPublication
  now: string
  serverNow: string
  mode: 'dry_run' | 'execute'
  fetchImpl?: FirstPartyFetch
  serverCredentialResolver?: ServerCredentialResolver
  nonceProvider?: NonceProvider
}) => Promise<FirstPartyExecutionResult>

export type ContentOperationOrchestratorDependencies = {
  repository?: ContentOperationsRepository
  productionRuntime?: ProductionRuntimeDependencies
  productionDeliverableRunner?: (input: { ownerUserId: number; planId: number; deliverableId: number; dependencies?: ProductionRuntimeDependencies }) => Promise<ContentDraftResult>
  publicationExecutor?: FirstPartyPublicationExecutor
  fetchImpl?: FirstPartyFetch
  serverCredentialResolver?: ServerCredentialResolver
  nonceProvider?: NonceProvider
  clock?: OrchestratorClock
  leaseMs?: number
}

function badRequest(message: string): never { throw createError({ statusCode: 422, statusMessage: message }) }
function notFound(message: string): never { throw createError({ statusCode: 404, statusMessage: message }) }
function collision(message: string): never { throw createError({ statusCode: 409, statusMessage: message }) }

function ownerScopeKey(ownerUserId: number): string {
  return `owner-${createHash('sha256').update(String(ownerUserId), 'utf8').digest('hex').slice(0, 32)}`
}

function targetId(ownerUserId: number, clientId: number, idempotencyKey: string): string {
  return `target-${stableFingerprint({ ownerUserId, clientId, idempotencyKey }).slice(0, 32)}`
}

function codeUnitCompare(left: string, right: string): number {
  const length = Math.min(left.length, right.length)
  for (let index = 0; index < length; index += 1) {
    const difference = left.charCodeAt(index) - right.charCodeAt(index)
    if (difference !== 0) return difference
  }
  return left.length - right.length
}

function canonicalList(values: string[]): string[] {
  return [...values].map(value => value.normalize('NFKC').toLowerCase()).sort(codeUnitCompare)
}

function targetConfigFingerprint(input: PublicationTargetInput): string {
  const credentialReferenceHash = createHash('sha256').update(input.credentialReference.normalize('NFKC'), 'utf8').digest('hex')
  return stableFingerprint({
    framework: input.framework,
    transport: input.transport,
    targetOrigin: input.targetOrigin,
    contentRoot: input.contentRoot,
    defaultBranch: input.defaultBranch,
    repositoryOwner: input.repositoryOwner ?? null,
    repositoryName: input.repositoryName ?? null,
    endpointPath: input.endpointPath ?? null,
    allowedContentTypes: canonicalList(input.allowedContentTypes),
    allowedLanguages: canonicalList(input.allowedLanguages),
    maximumPayloadBytes: input.maximumPayloadBytes,
    executionEnabled: input.executionEnabled === true,
    credentialReferenceHash,
  })
}

function redactedTarget(target: ContentOperationPublicationTargetRow) {
  return {
    id: target.id,
    clientId: target.clientId,
    targetId: target.targetId,
    framework: target.framework,
    transport: target.transport,
    targetOrigin: target.targetOrigin,
    contentRoot: target.contentRoot,
    defaultBranch: target.defaultBranch,
    repositoryOwner: target.repositoryOwner,
    repositoryName: target.repositoryName,
    endpointPath: target.endpointPath,
    allowedContentTypes: target.allowedContentTypes,
    allowedLanguages: target.allowedLanguages,
    maximumPayloadBytes: target.maximumPayloadBytes,
    status: target.status,
    activeSlot: target.activeSlot,
    executionEnabled: target.executionEnabled,
    credentialConfigured: Boolean(target.credentialReference),
    configurationFingerprint: target.configurationFingerprint,
    idempotencyKey: target.idempotencyKey,
    createdAt: target.createdAt,
    updatedAt: target.updatedAt,
    revokedAt: target.revokedAt,
  }
}

function targetForPublisher(target: ContentOperationPublicationTargetRow, ownerUserId: number): Record<string, unknown> {
  const value = {
    targetId: target.targetId,
    ownerScopeKey: ownerScopeKey(ownerUserId),
    framework: target.framework,
    transport: target.transport,
    targetOrigin: target.targetOrigin,
    contentRoot: target.contentRoot,
    defaultBranch: target.transport === 'first_party_signed_api' ? target.defaultBranch ?? 'main' : target.defaultBranch,
    repositoryOwner: target.repositoryOwner,
    repositoryName: target.repositoryName,
    endpointPath: target.endpointPath,
    credentialReference: target.credentialReference,
    status: target.status,
    allowedContentTypes: target.allowedContentTypes,
    allowedLanguages: target.allowedLanguages,
    maximumPayloadBytes: target.maximumPayloadBytes,
    executionEnabled: target.executionEnabled,
  }
  return value
}

function assertTargetShape(target: ContentOperationPublicationTargetRow, ownerUserId: number, client: { id: number; framework: string; publicationTransport: string }) {
  if (target.status !== 'active' || target.activeSlot !== 1) badRequest('Publication target is not active or does not hold the active slot.')
  if (target.ownerUserId !== ownerUserId || target.clientId !== client.id) notFound('Publication target was not found for this owner and client.')
  if (target.framework !== client.framework || target.transport !== client.publicationTransport) collision('Publication target framework or transport does not match the client.')
  const validated = validateFirstPartyPublishTarget(targetForPublisher(target, ownerUserId))
  if (validated.status === 'blocked') badRequest(`Publication target is invalid: ${validated.reasons.join('; ')}`)
  return validated.target
}

function runKey(entryId: number, stage: RunInsert['stage'], fingerprint: string): string {
  return `orchestrator:${stage}:${entryId}:${fingerprint.slice(0, 32)}`.slice(0, 128)
}

function runPayload(ownerUserId: number, entry: ContentOperationCalendarEntryRow, stage: RunInsert['stage'], inputFingerprint: string, idempotencyKey: string): RunInsert {
  return {
    ownerUserId,
    entryId: entry.id,
    stage,
    state: 'queued',
    attemptNumber: 0,
    idempotencyKey,
    inputFingerprint,
    outputFingerprint: null,
    leaseOwner: null,
    leaseExpiresAt: null,
    retryEligibleAt: null,
    errorCode: null,
    errorSummary: null,
    startedAt: null,
    completedAt: null,
  }
}

async function ensureRun(repository: ContentOperationsRepository, ownerUserId: number, entry: ContentOperationCalendarEntryRow, stage: RunInsert['stage'], input: unknown): Promise<ContentOperationRunRow> {
  const fingerprint = stableFingerprint(input)
  const key = runKey(entry.id, stage, fingerprint)
  const payload = runPayload(ownerUserId, entry, stage, fingerprint, key)
  const existing = await repository.findRunByIdempotency(ownerUserId, key)
  if (existing) {
    if (existing.ownerUserId !== ownerUserId || existing.entryId !== entry.id || existing.stage !== stage || existing.inputFingerprint !== fingerprint) collision('Content operation run idempotency collision.')
    return existing
  }
  return repository.insertRun(payload)
}

function event(ownerUserId: number, entry: ContentOperationCalendarEntryRow, runId: number | null, eventType: string, fromStatus: string | null, toStatus: string | null, metadata: Record<string, unknown>, key: unknown): EventInsert {
  return {
    ownerUserId,
    clientId: null,
    calendarId: entry.calendarId,
    entryId: entry.id,
    runId,
    eventType,
    fromStatus,
    toStatus,
    eventFingerprint: stableFingerprint(key),
    metadata,
  }
}

function retryDate(now: Date, attemptNumber: number): Date | null {
  if (attemptNumber === 1) return new Date(now.getTime() + FIVE_MINUTES)
  if (attemptNumber === 2) return new Date(now.getTime() + THIRTY_MINUTES)
  return null
}

function readRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function safeString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

async function defaultFetch(url: string, init: Parameters<typeof fetch>[1]): Promise<Awaited<ReturnType<typeof fetch>>> {
  return fetch(url, init)
}

function defaultPublisher(dependencies: ContentOperationOrchestratorDependencies): FirstPartyPublicationExecutor {
  return async input => {
    const runtime = input.mode === 'execute' ? getContentOperationsRuntimeDependencies() : undefined
    return executeFirstPartyPublication({
      target: input.target,
      publication: input.publication,
      now: input.now,
      serverNow: input.serverNow,
      mode: input.mode,
      fetchImpl: input.fetchImpl || runtime?.fetchImpl || (input.mode === 'execute' ? (defaultFetch as unknown as FirstPartyFetch) : undefined),
      serverCredentialResolver: input.serverCredentialResolver || runtime?.serverCredentialResolver,
      nonceProvider: input.nonceProvider || runtime?.nonceProvider,
    })
  }
}

function publicationFromLineage(ownerUserId: number, entry: ContentOperationCalendarEntryRow, calendar: { productionPlanId: number }, target: ContentOperationPublicationTargetRow, job: { id: number; productionPlanId: number | null; productionDeliverableId: number | null; strategyRecommendationId: number | null; evidenceSnapshotHash: string }, draft: { id: number; version: number; title: string; body: string; contentHash: string; provenance: unknown; safetyStatus: string }, review: { id: number; jobId: number; draftId: number; reviewerUserId: number; decision: string; evidenceSnapshotHash: string }, rules: string[], authoritySourceIds: string[], identity: PublicationIdentity, now: Date): ApprovedFirstPartyPublication {
  if (job.productionPlanId !== calendar.productionPlanId || job.productionDeliverableId !== entry.productionDeliverableId || job.strategyRecommendationId !== entry.strategyRecommendationId || job.evidenceSnapshotHash !== entry.evidenceSnapshotHash) badRequest('Publication lineage does not match the calendar entry.')
  if (review.reviewerUserId !== ownerUserId || review.jobId !== job.id || review.draftId !== draft.id || review.decision !== 'approved_for_delivery' || review.evidenceSnapshotHash !== entry.evidenceSnapshotHash) badRequest('A current owner approved_for_delivery review is required.')
  if (draft.safetyStatus !== 'passed' || readRecord(draft.provenance).stage !== 'optimized') badRequest('Only a passed optimized draft can be published.')
  return {
    ownerScopeKey: ownerScopeKey(ownerUserId),
    scheduleEntryId: `entry-${entry.id}`,
    productionPlanId: `plan-${calendar.productionPlanId}`,
    productionDeliverableId: `deliverable-${entry.productionDeliverableId}`,
    jobId: `job-${job.id}`,
    draftId: `draft-${draft.id}`,
    draftVersion: draft.version,
    draftStage: 'optimized',
    reviewId: `review-${review.id}`,
    reviewDecision: 'approved_for_delivery',
    riskGateStatus: 'passed',
    evidenceSnapshotHash: entry.evidenceSnapshotHash,
    contentHash: draft.contentHash,
    title: draft.title,
    body: draft.body,
    slug: identity.slug,
    contentType: entry.contentType,
    language: entry.language,
    scheduledAt: now.toISOString(),
    scheduleKey: entry.scheduleKey,
    authoritySourceIds,
    ruleIds: rules,
  }
}

async function synchronizeReview(ownerUserId: number, entry: ContentOperationCalendarEntryRow, repository: ContentOperationsRepository, now: Date, leaseMs: number, expectedRunId?: number): Promise<{ entry: ContentOperationCalendarEntryRow; run: ContentOperationRunRow; outcome: ExecuteContentOperationResult['outcome'] }> {
  if (!entry.jobId || !entry.draftId) badRequest('Review synchronization requires a bound job and optimized draft.')
  const run = await ensureRun(repository, ownerUserId, entry, 'review_wait', { jobId: entry.jobId, draftId: entry.draftId, evidenceSnapshotHash: entry.evidenceSnapshotHash })
  if (expectedRunId !== undefined && run.id !== expectedRunId) badRequest('The expected review run is stale or does not match the current review run.')
  const token = randomUUID()
  const leased = await repository.acquireRunLease(ownerUserId, run.id, token, now, leaseMs)
  if (!leased) {
    const current = await repository.findRunByIdempotency(ownerUserId, run.idempotencyKey)
    if (!current) badRequest('Review synchronization run disappeared.')
    return { entry, run: current, outcome: 'awaiting_review' }
  }
  const latestDraft = await repository.findLatestOptimizedDraft(ownerUserId, entry.jobId)
  if (latestDraft && latestDraft.id !== entry.draftId) {
    const rebound = await repository.transaction(async transaction => {
      const updatedEntry = await transaction.updateEntry(ownerUserId, entry.id, { draftId: latestDraft.id, contentHash: latestDraft.contentHash, reviewId: null, status: 'awaiting_review' })
      const released = await transaction.releaseRunLease(ownerUserId, leased.id, 'succeeded', token, now)
      if (!released) badRequest('Review rebinding lease could not be completed.')
      const nextRun = await ensureRun(transaction, ownerUserId, updatedEntry, 'review_wait', { jobId: updatedEntry.jobId, draftId: latestDraft.id, evidenceSnapshotHash: updatedEntry.evidenceSnapshotHash })
      await transaction.appendEvent(event(ownerUserId, entry, released.id, 'review_rebound_to_new_optimized_draft', entry.status, updatedEntry.status, { previousDraftId: entry.draftId, draftId: latestDraft.id, contentHash: latestDraft.contentHash, reviewId: null }, { entryId: entry.id, draftId: latestDraft.id, event: 'review_rebound_to_new_optimized_draft' }))
      return { updatedEntry, nextRun }
    })
    return { entry: rebound.updatedEntry, run: rebound.nextRun, outcome: 'awaiting_review' }
  }
  const review = await repository.findLatestReview(ownerUserId, entry.jobId, entry.draftId, entry.evidenceSnapshotHash)
  if (!review) {
    const released = await repository.releaseRunLease(ownerUserId, leased.id, 'queued', token, now)
    if (!released) badRequest('Review wait lease could not be released.')
    return { entry, run: released, outcome: 'awaiting_review' }
  }
  if (review.decision === 'changes_requested' || review.decision === 'approved_for_preview') {
    const released = await repository.releaseRunLease(ownerUserId, leased.id, 'queued', token, now)
    if (!released) badRequest('Review wait lease could not be released.')
    return { entry, run: released, outcome: 'awaiting_review' }
  }
  if (review.decision === 'rejected') {
    const updated = await repository.transaction(async transaction => {
      const blocked = await transaction.updateEntry(ownerUserId, entry.id, { status: 'blocked', reviewId: review.id })
      const completed = await transaction.releaseRunLease(ownerUserId, leased.id, 'blocked', token, now, { code: 'review_rejected', summary: 'Owner review rejected this entry.' })
      if (!completed) badRequest('Review synchronization lease could not be completed.')
      await transaction.appendEvent(event(ownerUserId, entry, completed.id, 'review_rejected', entry.status, blocked.status, { reviewId: review.id, decision: review.decision }, { entryId: entry.id, reviewId: review.id, event: 'review_rejected' }))
      return { blocked, completed }
    })
    return { entry: updated.blocked, run: updated.completed, outcome: 'blocked' }
  }
  if (review.decision !== 'approved_for_delivery') {
    const released = await repository.releaseRunLease(ownerUserId, leased.id, 'queued', token, now)
    if (!released) badRequest('Unknown review decision could not be safely handled.')
    return { entry, run: released, outcome: 'awaiting_review' }
  }
  const updated = await repository.transaction(async transaction => {
    const ready = await transaction.updateEntry(ownerUserId, entry.id, { status: 'ready_to_publish', reviewId: review.id })
    const completed = await transaction.releaseRunLease(ownerUserId, leased.id, 'succeeded', token, now, { code: undefined, summary: undefined })
    if (!completed) badRequest('Review synchronization lease could not be completed.')
    await ensureRun(transaction, ownerUserId, ready, 'publication', { jobId: entry.jobId, draftId: entry.draftId, evidenceSnapshotHash: entry.evidenceSnapshotHash })
    await transaction.appendEvent(event(ownerUserId, entry, completed.id, 'review_approved_for_delivery', entry.status, ready.status, { reviewId: review.id, decision: review.decision }, { entryId: entry.id, reviewId: review.id, event: 'review_approved_for_delivery' }))
    return { ready, completed }
  })
  return { entry: updated.ready, run: updated.completed, outcome: 'ready_to_publish' }
}

async function executePublication(ownerUserId: number, entry: ContentOperationCalendarEntryRow, input: ExecuteContentOperationInput, repository: ContentOperationsRepository, dependencies: ContentOperationOrchestratorDependencies, now: Date, expectedRunId?: number): Promise<ExecuteContentOperationResult> {
  const lineage = await repository.resolveWorkspaceEntry(ownerUserId, entry.id)
  if (!lineage || !lineage.calendar || !lineage.client || !lineage.job || !lineage.draft || !lineage.deliverable) badRequest('Publication lineage is incomplete.')
  const hasPersistedIdentity = Boolean(entry.publicationSlug || entry.publicationPath || entry.publicationIdentityFingerprint)
  if (hasPersistedIdentity && (!entry.publicationSlug || !entry.publicationPath || !entry.publicationIdentityFingerprint || entry.publicationTargetId === null)) badRequest('Persisted publication identity is incomplete or missing its target binding.')
  if (!hasPersistedIdentity && entry.publicationTargetId !== null && !lineage.target) badRequest('The persisted publication target binding is missing.')
  const target = entry.publicationTargetId !== null ? lineage.target : lineage.target || await repository.findActivePublicationTarget(ownerUserId, lineage.client.id)
  if (!target) badRequest(hasPersistedIdentity ? 'The persisted publication target is missing.' : 'An active first-party publication target is required before publication.')
  const validatedTarget = assertTargetShape(target, ownerUserId, lineage.client)
  const draft = lineage.draft as typeof lineage.draft & { title: string; body: string; provenance: unknown }
  const job = lineage.job as typeof lineage.job & { status?: string }
  const deliverable = lineage.deliverable as typeof lineage.deliverable & { status?: string }
  if (validatedTarget.allowedContentTypes.includes(entry.contentType) === false || !validatedTarget.allowedLanguages.includes(entry.language)) badRequest('Publication target does not allow this content type or language.')
  const latestReview = await repository.findLatestReview(ownerUserId, job.id, draft.id, entry.evidenceSnapshotHash)
  if (!latestReview || latestReview.reviewerUserId !== ownerUserId || latestReview.jobId !== job.id || latestReview.draftId !== draft.id || latestReview.evidenceSnapshotHash !== entry.evidenceSnapshotHash) badRequest('A current owner review is required before publication.')
  if (latestReview.decision !== 'approved_for_delivery') {
    const publicationRuns = await repository.listRuns(ownerUserId, entry.id)
    const publicationRun = publicationRuns.find(run => run.stage === 'publication' && run.id === expectedRunId) || publicationRuns.find(run => run.stage === 'publication')
    if (latestReview.decision === 'changes_requested') {
      const updated = await repository.transaction(async transaction => {
        if (publicationRun && ['queued', 'processing', 'retry_wait'].includes(publicationRun.state)) await transaction.updateRun(ownerUserId, publicationRun.id, { state: 'cancelled', errorCode: 'REVIEW_SUPERSEDED', errorSummary: 'A newer owner changes_requested review invalidated publication.' })
        const nextEntry = await transaction.updateEntry(ownerUserId, entry.id, { status: 'awaiting_review', reviewId: null })
        const reviewRun = await ensureRun(transaction, ownerUserId, nextEntry, 'review_wait', { jobId: job.id, draftId: draft.id, evidenceSnapshotHash: entry.evidenceSnapshotHash })
        return { nextEntry, reviewRun }
      })
      return { entryId: entry.id, entry: updated.nextEntry, previousStatus: entry.status, resultingStatus: updated.nextEntry.status, runId: updated.reviewRun.id, stage: 'review_wait', outcome: 'awaiting_review', retryAt: null, limitations: ['latest changes_requested review invalidated the older delivery approval; no automatic approval was created'] }
    }
    if (latestReview.decision === 'rejected') {
      const nextEntry = await repository.updateEntry(ownerUserId, entry.id, { status: 'blocked', reviewId: latestReview.id })
      return { entryId: entry.id, entry: nextEntry, previousStatus: entry.status, resultingStatus: nextEntry.status, runId: publicationRun?.id || 0, stage: 'publication', outcome: 'blocked', retryAt: null, limitations: ['latest owner rejection blocks publication'] }
    }
    if (latestReview.decision === 'approved_for_preview') {
      const nextEntry = await repository.updateEntry(ownerUserId, entry.id, { status: 'awaiting_review', reviewId: latestReview.id })
      return { entryId: entry.id, entry: nextEntry, previousStatus: entry.status, resultingStatus: nextEntry.status, runId: publicationRun?.id || 0, stage: 'review_wait', outcome: 'awaiting_review', retryAt: null, limitations: ['approved_for_preview is insufficient for publication'] }
    }
    badRequest('The latest owner review decision is malformed or does not authorize publication.')
  }
  if (typeof job.status === 'string' && job.status !== 'approved') badRequest('Publication requires the content job to remain approved.')
  if (typeof deliverable.status === 'string' && !['approved', 'exported'].includes(deliverable.status)) badRequest('Publication requires the deliverable to remain approved.')
  const gate = await repository.findRiskGate(ownerUserId, draft.id, entry.evidenceSnapshotHash)
  if (!gate || gate.draftId !== draft.id || gate.evidenceSnapshotHash !== entry.evidenceSnapshotHash || gate.status !== 'passed') badRequest('Publication requires the latest exact passed risk gate.')
  const context = await repository.resolveCanonicalContext(ownerUserId, lineage.calendar.productionPlanId, entry.productionDeliverableId)
  if (context.plan.id !== lineage.calendar.productionPlanId || context.deliverable.id !== entry.productionDeliverableId || context.strategy.id !== entry.strategyRecommendationId || context.evidenceSnapshot.hash !== entry.evidenceSnapshotHash) badRequest('Publication canonical context is stale or mismatched.')
  const rules = context.rules.map(rule => rule.id)
  const authoritySourceIds = context.evidenceSnapshot.refs.map(ref => ref.artifactId ? `artifact:${ref.artifactId}` : `source:${ref.sourceId}`).filter(Boolean)
  const identityInput = { clientId: lineage.client.id, entryId: entry.id, targetId: target.targetId, targetOrigin: target.targetOrigin, contentRoot: target.contentRoot, contentType: entry.contentType, language: entry.language, title: draft.title, ownerScopeKey: validatedTarget.ownerScopeKey }
  const persistedIdentity = hasPersistedIdentity ? { publicationId: `publication-${entry.id}`, slug: entry.publicationSlug!, path: entry.publicationPath!, identityFingerprint: entry.publicationIdentityFingerprint! } : null
  const identityResult = persistedIdentity ? validatePersistedPublicationIdentity({ ...identityInput, existingIdentity: persistedIdentity }) : buildPublicationIdentity(identityInput)
  if (!identityResult.ok) badRequest(`Publication identity is invalid: ${identityResult.reason}`)
  const identity = identityResult.identity
  if (hasPersistedIdentity && entry.publicationTargetId !== target.id) badRequest('Persisted publication identity is bound to a different target row.')
  const persistedEntry = hasPersistedIdentity ? entry : await repository.transaction(async transaction => transaction.updateEntry(ownerUserId, entry.id, { publicationTargetId: target.id, publicationSlug: identity.slug, publicationPath: identity.path, publicationIdentityFingerprint: identity.identityFingerprint }))
  if (input.mode === 'execute' && !target.executionEnabled) badRequest('Execute mode is disabled for this publication target; use dry_run explicitly.')
  const stageRun = await ensureRun(repository, ownerUserId, persistedEntry, 'publication', { jobId: job.id, draftId: draft.id, evidenceSnapshotHash: entry.evidenceSnapshotHash })
  if (expectedRunId !== undefined && stageRun.id !== expectedRunId) badRequest('The expected publication run is stale or does not match the current publication run.')
  if (stageRun.state === 'succeeded' && entry.status === 'delivered') return { entryId: entry.id, entry: persistedEntry, previousStatus: entry.status, resultingStatus: 'delivered', runId: stageRun.id, stage: 'publication', outcome: 'replayed', retryAt: null, limitations: ['replayed from durable publication identity'] }
  const requestedMode = input.mode || 'dry_run'
  const requestFingerprint = stableFingerprint({ entryId: entry.id, mode: requestedMode, identityFingerprint: identity.identityFingerprint, contentHash: draft.contentHash, evidenceSnapshotHash: entry.evidenceSnapshotHash })
  const attempts = await repository.listPublicationAttempts(ownerUserId, entry.id)
  const recovered = attempts.find(attempt => attempt.runId === stageRun.id && attempt.status === 'planned' && attempt.inputFingerprint === requestFingerprint)
  const attemptKey = recovered?.idempotencyKey || input.idempotencyKey
  const existingAttempt = await repository.findPublicationAttemptByIdempotency(ownerUserId, attemptKey)
  if (existingAttempt && (existingAttempt.inputFingerprint !== requestFingerprint || existingAttempt.entryId !== entry.id || existingAttempt.mode !== requestedMode)) collision('Publication idempotency key is associated with a different entry or input.')
  if (existingAttempt && existingAttempt.status !== 'planned') return { entryId: entry.id, entry: persistedEntry, previousStatus: entry.status, resultingStatus: entry.status, runId: stageRun.id, stage: 'publication', outcome: existingAttempt.status === 'delivered' ? 'delivered' : existingAttempt.status === 'dry_run_succeeded' ? 'dry_run_succeeded' : existingAttempt.status === 'retryable_failure' ? 'retry_wait' : 'replayed', retryAt: existingAttempt.status === 'retryable_failure' ? stageRun.retryEligibleAt : null, limitations: ['replayed from append-only publication attempt ledger'] }
  const token = randomUUID()
  const leased = await repository.acquireRunLease(ownerUserId, stageRun.id, token, now, leaseMsFor(dependencies.leaseMs))
  if (!leased) {
    const current = await repository.findRunByIdempotency(ownerUserId, stageRun.idempotencyKey)
    if (!current) badRequest('Publication run disappeared before lease acquisition.')
    const retryAttempt = attempts.find(attempt => attempt.runId === current.id && attempt.status === 'retryable_failure')
    return { entryId: entry.id, entry: persistedEntry, previousStatus: entry.status, resultingStatus: entry.status, runId: current.id, stage: 'publication', outcome: 'replayed', retryAt: retryAttempt ? current.retryEligibleAt : current.retryEligibleAt, limitations: ['another worker currently owns the publication lease'] }
  }
  const publication = publicationFromLineage(ownerUserId, persistedEntry, lineage.calendar, target, job, draft, latestReview, rules, authoritySourceIds, identity, now)
  const mode = requestedMode
  let reservation: PublicationAttemptReservation | null = null
  let attemptNumber = 0
  if (mode === 'dry_run') {
    attemptNumber = Math.max(1, attempts.filter(attempt => attempt.mode === 'dry_run').reduce((max, attempt) => Math.max(max, attempt.attemptNumber), 0) + 1)
  } else {
    try {
      reservation = await repository.reservePublicationAttempt({ ownerUserId, clientId: lineage.client.id, entryId: entry.id, runId: leased.id, targetId: target.id, mode, idempotencyKey: attemptKey, inputFingerprint: requestFingerprint, publicationId: identity.publicationId, publicationSlug: identity.slug, publicationPath: identity.path, contentHash: draft.contentHash, evidenceSnapshotHash: entry.evidenceSnapshotHash, startedAt: now, leaseToken: token, jobId: job.id, draftId: draft.id, reviewId: latestReview.id, riskGateId: gate.id })
      attemptNumber = reservation.attempt.attemptNumber
    } catch (error) {
      const released = await repository.releaseRunLease(ownerUserId, leased.id, 'blocked', token, now, { code: 'ATTEMPT_RESERVATION_FAILED', summary: sanitizeErrorSummary(error) })
      if (!released) badRequest('Publication reservation failure lease could not be completed.')
      return { entryId: entry.id, entry: persistedEntry, previousStatus: entry.status, resultingStatus: entry.status, runId: released.id, stage: 'publication', outcome: 'blocked', retryAt: null, limitations: ['publication attempt was not reserved; no external request was made'] }
    }
  }
  const attemptBase = { ownerUserId, clientId: lineage.client.id, entryId: entry.id, runId: leased.id, targetId: target.id, attemptNumber, mode, idempotencyKey: attemptKey, inputFingerprint: requestFingerprint, publicationId: identity.publicationId, publicationSlug: identity.slug, publicationPath: identity.path, contentHash: draft.contentHash, evidenceSnapshotHash: entry.evidenceSnapshotHash }
  let result: FirstPartyExecutionResult
  try {
    const executor = dependencies.publicationExecutor || defaultPublisher(dependencies)
    result = await executor({ target: targetForPublisher(target, ownerUserId), publication, now: now.toISOString(), serverNow: now.toISOString(), mode, fetchImpl: dependencies.fetchImpl, serverCredentialResolver: dependencies.serverCredentialResolver, nonceProvider: dependencies.nonceProvider })
  } catch (error) {
    result = { status: 'blocked', code: 'INVALID_INPUT', reasons: [sanitizeErrorSummary(error)] }
  }
  if (result.status === 'delivered' && (result.publicationId !== publication.productionDeliverableId || result.contentHash !== publication.contentHash)) result = { status: 'blocked', code: 'REMOTE_IDENTITY_COLLISION', reasons: ['publisher result identity did not match the approved publication'] }
  if (mode === 'dry_run') {
    const dryRunSucceeded = result.status === 'dry_run'
    const dryStatus = dryRunSucceeded ? 'dry_run_succeeded' as const : 'blocked' as const
    const dryErrorCode = dryRunSucceeded ? null : 'code' in result ? result.code : 'REQUEST_BLOCKED'
    const dryErrorSummary = dryRunSucceeded ? null : sanitizeErrorSummary('reasons' in result ? result.reasons.join('; ') : 'Dry-run validation was blocked.')
    const dryRun = await repository.transaction(async transaction => {
      const stored = await transaction.insertPublicationAttempt({ ...attemptBase, artifactFingerprint: null, status: dryStatus, remoteState: null, remoteRevision: null, errorCode: dryErrorCode, errorSummary: dryErrorSummary, startedAt: now, completedAt: now })
      const completed = await transaction.releaseRunLease(ownerUserId, leased.id, 'queued', token, now, { code: dryErrorCode || undefined, summary: dryErrorSummary || undefined, retryEligibleAt: null })
      if (!completed) badRequest('Dry-run publication lease could not be completed.')
      const eventType = dryRunSucceeded ? 'publication_dry_run_succeeded' : 'publication_dry_run_blocked'
      await transaction.appendEvent(event(ownerUserId, entry, completed.id, eventType, entry.status, entry.status, { attemptId: stored.id, attemptNumber, publicationId: identity.publicationId, publicationPath: identity.path, errorCode: dryErrorCode }, { entryId: entry.id, attemptKey, event: eventType }))
      return { stored, completed }
    })
    return { entryId: entry.id, entry: persistedEntry, previousStatus: entry.status, resultingStatus: entry.status, runId: dryRun.completed.id, stage: 'publication', outcome: dryRunSucceeded ? 'dry_run_succeeded' : 'blocked', retryAt: null, limitations: [dryRunSucceeded ? `dry_run attempt ${dryRun.stored.id} did not resolve credentials or call a client site` : `dry_run attempt ${dryRun.stored.id} was blocked without retry`] }
  }
  const finalizePatch = (status: PublicationAttemptFinalization['status'], values: Partial<PublicationAttemptFinalization> = {}): PublicationAttemptFinalization => ({ status, artifactFingerprint: values.artifactFingerprint ?? null, remoteState: values.remoteState ?? null, remoteRevision: values.remoteRevision ?? null, errorCode: values.errorCode ?? null, errorSummary: values.errorSummary ?? null, completedAt: now })
  if (result.status === 'delivered') {
    const delivered = await repository.transaction(async transaction => {
      const stored = await transaction.finalizePublicationAttempt(ownerUserId, reservation?.attempt.id || existingAttempt?.id || 0, finalizePatch('delivered', { artifactFingerprint: result.artifactFingerprint, remoteState: result.remoteState, remoteRevision: result.remoteRevision }))
      if (!stored) {
        const replay = await transaction.findPublicationAttemptByIdempotency(ownerUserId, attemptKey)
        if (replay?.status === 'delivered') {
          const completed = await transaction.releaseRunLease(ownerUserId, leased.id, 'succeeded', token, now)
          if (!completed) badRequest('Publication replay success lease could not be completed.')
          return { stored: replay, updated: persistedEntry, completed }
        }
        badRequest('Publication delivered result could not be finalized from planned state.')
      }
      const updated = await transaction.updateEntry(ownerUserId, entry.id, { status: 'delivered', contentHash: result.contentHash, publicationTargetId: target.id, publicationSlug: identity.slug, publicationPath: identity.path, publicationIdentityFingerprint: identity.identityFingerprint })
      const completed = await transaction.releaseRunLease(ownerUserId, leased.id, 'succeeded', token, now)
      if (!completed) badRequest('Publication success lease could not be completed.')
      await transaction.appendEvent(event(ownerUserId, entry, completed.id, 'publication_delivered', entry.status, updated.status, { attemptId: stored.id, attemptNumber, publicationId: result.publicationId, remoteState: result.remoteState, remoteRevision: result.remoteRevision }, { entryId: entry.id, attemptKey, event: 'publication_delivered' }))
      return { stored, updated, completed }
    })
    return { entryId: entry.id, entry: delivered.updated, previousStatus: entry.status, resultingStatus: 'delivered', runId: delivered.completed.id, stage: 'publication', outcome: 'delivered', retryAt: null, limitations: ['delivery result was accepted only after formal publisher identity validation'] }
  }
  const status = result.status === 'retryable_failure' && attemptNumber < MAX_ATTEMPTS ? 'retryable_failure' : result.status === 'retryable_failure' ? 'permanent_failure' : result.status === 'permanent_failure' ? 'permanent_failure' : 'blocked'
  const nextRunState: RunInsert['state'] = status === 'retryable_failure' ? 'retry_wait' : status === 'blocked' ? 'blocked' : 'failed'
  const retryAt = status === 'retryable_failure' ? retryDate(now, attemptNumber) : null
  const failureSummary = sanitizeErrorSummary('reasons' in result ? result.reasons.join('; ') : 'Publication was blocked.')
  const failed = await repository.transaction(async transaction => {
    const stored = await transaction.finalizePublicationAttempt(ownerUserId, reservation?.attempt.id || existingAttempt?.id || 0, finalizePatch(status, { errorCode: 'code' in result ? result.code : 'REQUEST_BLOCKED', errorSummary: failureSummary }))
    if (!stored) {
      const replay = await transaction.findPublicationAttemptByIdempotency(ownerUserId, attemptKey)
      if (!replay || replay.status === 'planned') badRequest('Publication failure result could not be finalized from planned state.')
      const completed = await transaction.releaseRunLease(ownerUserId, leased.id, nextRunState, token, now, { code: 'code' in result ? result.code : 'REQUEST_BLOCKED', summary: failureSummary, retryEligibleAt: retryAt })
      if (!completed) badRequest('Publication replay lease could not be completed.')
      return { stored: replay, updated: persistedEntry, completed }
    }
    const updated = status === 'blocked' || status === 'permanent_failure' ? await transaction.updateEntry(ownerUserId, entry.id, { status: 'blocked' }) : await transaction.updateEntry(ownerUserId, entry.id, { status: 'ready_to_publish' })
    const completed = await transaction.releaseRunLease(ownerUserId, leased.id, nextRunState, token, now, { code: 'code' in result ? result.code : 'REQUEST_BLOCKED', summary: failureSummary, retryEligibleAt: retryAt })
    if (!completed) badRequest('Publication failure lease could not be completed.')
    await transaction.appendEvent(event(ownerUserId, entry, completed.id, `publication_${status}`, entry.status, updated.status, { attemptId: stored.id, attemptNumber, errorCode: stored.errorCode, retryAt }, { entryId: entry.id, attemptKey, event: `publication_${status}` }))
    return { stored, updated, completed }
  })
  return { entryId: entry.id, entry: failed.updated, previousStatus: entry.status, resultingStatus: failed.updated.status, runId: failed.completed.id, stage: 'publication', outcome: status === 'retryable_failure' ? 'retry_wait' : 'blocked', retryAt, limitations: status === 'retryable_failure' ? ['retry is scheduled without sleeping; scheduler must wait until retryAt'] : ['publication was not delivered'] }
}
function leaseMsFor(value: number | undefined): number {
  return Number.isFinite(value) ? Math.max(1, Math.min(Math.trunc(value as number), 15 * 60 * 1000)) : DEFAULT_LEASE_MS
}

async function executeGeneration(ownerUserId: number, entry: ContentOperationCalendarEntryRow, repository: ContentOperationsRepository, dependencies: ContentOperationOrchestratorDependencies, now: Date, expectedRunId?: number): Promise<ExecuteContentOperationResult> {
  const run = await ensureRun(repository, ownerUserId, entry, 'generation', { planId: entry.calendarId, deliverableId: entry.productionDeliverableId, evidenceSnapshotHash: entry.evidenceSnapshotHash })
  if (expectedRunId !== undefined && run.id !== expectedRunId) badRequest('The expected generation run is stale or does not match the current generation run.')
  if (entry.jobId && entry.draftId && entry.status === 'awaiting_review') return { entryId: entry.id, entry, previousStatus: entry.status, resultingStatus: entry.status, runId: run.id, stage: 'generation', outcome: 'replayed', retryAt: null, limitations: ['generation lineage already persisted'] }
  const token = randomUUID()
  const leased = await repository.acquireRunLease(ownerUserId, run.id, token, now, leaseMsFor(dependencies.leaseMs))
  if (!leased) return { entryId: entry.id, entry, previousStatus: entry.status, resultingStatus: entry.status, runId: run.id, stage: 'generation', outcome: 'replayed', retryAt: run.retryEligibleAt, limitations: ['another worker currently owns the generation lease'] }
  const productionRuntime = dependencies.productionRuntime || {}
  const runner = dependencies.productionDeliverableRunner || (async input => runOwnerProductionDeliverable(input))
  try {
    const result = await runner({ ownerUserId, planId: (await repository.findCalendar(ownerUserId, entry.calendarId))?.productionPlanId || 0, deliverableId: entry.productionDeliverableId, dependencies: productionRuntime })
    const jobId = result.job?.id || entry.jobId
    if (!jobId) badRequest('Generation did not return a persisted job.')
    const draft = await repository.findLatestOptimizedDraft(ownerUserId, jobId)
    const gate = draft ? await repository.findRiskGate(ownerUserId, draft.id, entry.evidenceSnapshotHash) : null
    const passed = Boolean(draft && draft.safetyStatus === 'passed' && gate?.status === 'passed' && readRecord(draft.provenance).stage === 'optimized')
    if (!draft || !gate || !passed) {
      const blocked = await repository.transaction(async transaction => {
        const updated = await transaction.updateEntry(ownerUserId, entry.id, { status: 'blocked', jobId, draftId: draft?.id || null, contentHash: draft?.contentHash || null })
        const completed = await transaction.releaseRunLease(ownerUserId, leased.id, 'blocked', token, now, { code: 'RISK_GATE_BLOCKED', summary: 'Generation did not produce a passed optimized draft and risk gate.' })
        if (!completed) badRequest('Generation block lease could not be completed.')
        await transaction.appendEvent(event(ownerUserId, entry, completed.id, 'generation_blocked', entry.status, updated.status, { jobId, draftId: draft?.id || null, riskGateStatus: gate?.status || 'missing' }, { entryId: entry.id, event: 'generation_blocked' }))
        return { updated, completed }
      })
      return { entryId: entry.id, entry: blocked.updated, previousStatus: entry.status, resultingStatus: blocked.updated.status, runId: blocked.completed.id, stage: 'generation', outcome: 'blocked', retryAt: null, limitations: ['risk gate blocked generation; no human review was created'] }
    }
    const ready = await repository.transaction(async transaction => {
      const updated = await transaction.updateEntry(ownerUserId, entry.id, { status: 'awaiting_review', jobId, draftId: draft.id, contentHash: draft.contentHash })
      const completed = await transaction.releaseRunLease(ownerUserId, leased.id, 'succeeded', token, now, { code: undefined, summary: undefined })
      if (!completed) badRequest('Generation success lease could not be completed.')
      await ensureRun(transaction, ownerUserId, updated, 'review_wait', { jobId, draftId: draft.id, evidenceSnapshotHash: entry.evidenceSnapshotHash })
      await transaction.appendEvent(event(ownerUserId, entry, completed.id, 'generation_succeeded_awaiting_review', entry.status, updated.status, { jobId, draftId: draft.id, contentHash: draft.contentHash }, { entryId: entry.id, jobId, draftId: draft.id, event: 'generation_succeeded_awaiting_review' }))
      return { updated, completed }
    })
    return { entryId: entry.id, entry: ready.updated, previousStatus: entry.status, resultingStatus: ready.updated.status, runId: ready.completed.id, stage: 'generation', outcome: 'awaiting_review', retryAt: null, limitations: ['generation completed; a real owner approved_for_delivery review is still required'] }
  } catch (error) {
    const failed = await repository.transaction(async transaction => {
      const updated = await transaction.updateEntry(ownerUserId, entry.id, { status: 'blocked' })
      const completed = await transaction.releaseRunLease(ownerUserId, leased.id, 'failed', token, now, { code: 'GENERATION_FAILED', summary: sanitizeErrorSummary(error) })
      if (!completed) badRequest('Generation failure lease could not be completed.')
      await transaction.appendEvent(event(ownerUserId, entry, completed.id, 'generation_failed', entry.status, updated.status, { errorCode: 'GENERATION_FAILED', errorSummary: sanitizeErrorSummary(error) }, { entryId: entry.id, event: 'generation_failed' }))
      return { updated, completed }
    })
    return { entryId: entry.id, entry: failed.updated, previousStatus: entry.status, resultingStatus: failed.updated.status, runId: failed.completed.id, stage: 'generation', outcome: 'blocked', retryAt: null, limitations: ['generation exception was converted to a bounded blocked result'] }
  }
}

export async function createOwnerPublicationTarget(ownerUserId: number, clientId: number, value: unknown, repository?: ContentOperationsRepository) {
  const db = repository || createContentOperationsRepository()
  const input = parsePublicationTargetInput(value)
  const client = await db.findClient(ownerUserId, clientId)
  if (!client || client.status !== 'active') notFound('Content operation client was not found for this owner.')
  if (input.framework !== client.framework || input.transport !== client.publicationTransport) collision('Publication target framework or transport must match the client.')
  const target = {
    targetId: targetId(ownerUserId, client.id, input.idempotencyKey),
    ownerScopeKey: ownerScopeKey(ownerUserId),
    framework: input.framework,
    transport: input.transport,
    targetOrigin: input.targetOrigin,
    contentRoot: input.contentRoot,
    defaultBranch: input.defaultBranch ?? null,
    repositoryOwner: input.repositoryOwner,
    repositoryName: input.repositoryName,
    endpointPath: input.endpointPath,
    credentialReference: input.credentialReference,
    status: 'active' as const,
    allowedContentTypes: input.allowedContentTypes,
    allowedLanguages: input.allowedLanguages,
    maximumPayloadBytes: input.maximumPayloadBytes,
    executionEnabled: input.executionEnabled === true,
  }
  const validated = validateFirstPartyPublishTarget({ ...target, defaultBranch: target.transport === 'first_party_signed_api' ? 'main' : target.defaultBranch })
  if (validated.status === 'blocked') badRequest(`Publication target is invalid: ${validated.reasons.join('; ')}`)
  const canonicalTargetInput: PublicationTargetInput = { ...input, targetOrigin: validated.target.targetOrigin, allowedContentTypes: canonicalList([...validated.target.allowedContentTypes]), allowedLanguages: canonicalList([...validated.target.allowedLanguages]) }
  const fingerprint = targetConfigFingerprint(canonicalTargetInput)
  const existing = await db.findPublicationTargetByIdempotency(ownerUserId, input.idempotencyKey)
  if (existing) {
    if (existing.configurationFingerprint !== fingerprint || existing.clientId !== client.id) collision('Publication target idempotency key is associated with a different configuration.')
    return { target: redactedTarget(existing), replayed: true }
  }
  const active = await db.findActivePublicationTarget(ownerUserId, client.id)
  if (active) collision('Owner and client may have only one active publication target.')
  const row: PublicationTargetInsert = { ownerUserId, clientId: client.id, targetId: target.targetId, framework: target.framework, transport: target.transport, targetOrigin: validated.target.targetOrigin, contentRoot: target.contentRoot, defaultBranch: target.defaultBranch, repositoryOwner: target.repositoryOwner ?? null, repositoryName: target.repositoryName ?? null, endpointPath: target.endpointPath ?? null, credentialReference: target.credentialReference, allowedContentTypes: canonicalList([...validated.target.allowedContentTypes]), allowedLanguages: canonicalList([...validated.target.allowedLanguages]), maximumPayloadBytes: target.maximumPayloadBytes, status: 'active', activeSlot: 1, executionEnabled: target.executionEnabled, configurationFingerprint: fingerprint, idempotencyKey: input.idempotencyKey, revokedAt: null }
  try {
    const stored = await db.transaction(async transaction => transaction.insertPublicationTarget(row))
    return { target: redactedTarget(stored), replayed: false }
  } catch (error) {
    const statusCode = typeof error === 'object' && error !== null && 'statusCode' in error ? Number((error as { statusCode?: unknown }).statusCode) : 0
    const code = typeof error === 'object' && error !== null && 'code' in error ? String((error as { code?: unknown }).code) : ''
    if (statusCode === 409 || code === 'ER_DUP_ENTRY' || /duplicate|unique|active slot/i.test(error instanceof Error ? error.message : '')) collision('Owner and client may have only one active publication target.')
    throw error
  }
}

export async function updateOwnerPublicationTarget(ownerUserId: number, targetRowId: number, value: unknown, repository?: ContentOperationsRepository) {
  const db = repository || createContentOperationsRepository()
  const patch = parsePublicationTargetPatchInput(value)
  const existing = await db.findPublicationTarget(ownerUserId, targetRowId)
  if (!existing) notFound('Publication target was not found for this owner.')
  const client = await db.findClient(ownerUserId, existing.clientId)
  if (!client || client.status !== 'active') notFound('Publication target client is not active.')
  if (existing.status === 'revoked' && patch.status === 'active') badRequest('A revoked publication target is terminal and cannot be reactivated.')
  const next = {
    ...existing,
    targetOrigin: patch.targetOrigin ?? existing.targetOrigin,
    contentRoot: patch.contentRoot ?? existing.contentRoot,
    defaultBranch: patch.defaultBranch ?? existing.defaultBranch,
    repositoryOwner: patch.repositoryOwner === undefined ? existing.repositoryOwner : patch.repositoryOwner,
    repositoryName: patch.repositoryName === undefined ? existing.repositoryName : patch.repositoryName,
    endpointPath: patch.endpointPath === undefined ? existing.endpointPath : patch.endpointPath,
    credentialReference: patch.credentialReference ?? existing.credentialReference,
    allowedContentTypes: patch.allowedContentTypes ?? existing.allowedContentTypes,
    allowedLanguages: patch.allowedLanguages ?? existing.allowedLanguages,
    maximumPayloadBytes: patch.maximumPayloadBytes ?? existing.maximumPayloadBytes,
    executionEnabled: patch.executionEnabled ?? existing.executionEnabled,
    status: patch.status ?? existing.status,
    activeSlot: (patch.status ?? existing.status) === 'active' ? 1 : null,
    revokedAt: (patch.status ?? existing.status) === 'revoked' ? existing.revokedAt || new Date() : null,
  }
  if (next.status === 'active') {
    const active = await db.findActivePublicationTarget(ownerUserId, existing.clientId)
    if (active && active.id !== existing.id) collision('Owner and client may have only one active publication target.')
  }
  const validated = validateFirstPartyPublishTarget(targetForPublisher({ ...next, status: 'active' }, ownerUserId))
  if (validated.status === 'blocked') badRequest(`Publication target is invalid: ${validated.reasons.join('; ')}`)
  if (next.executionEnabled && !next.credentialReference) badRequest('Execution requires a server-side credential reference.')
  const configurationFingerprint = targetConfigFingerprint({ idempotencyKey: existing.idempotencyKey, framework: next.framework, transport: next.transport, targetOrigin: validated.target.targetOrigin, contentRoot: next.contentRoot, defaultBranch: next.defaultBranch, repositoryOwner: next.repositoryOwner, repositoryName: next.repositoryName, endpointPath: next.endpointPath, credentialReference: next.credentialReference, allowedContentTypes: canonicalList([...validated.target.allowedContentTypes]), allowedLanguages: canonicalList([...validated.target.allowedLanguages]), maximumPayloadBytes: next.maximumPayloadBytes, executionEnabled: next.executionEnabled })
  const stored = await db.transaction(async transaction => transaction.updatePublicationTarget(ownerUserId, existing.id, { targetOrigin: validated.target.targetOrigin, contentRoot: next.contentRoot, defaultBranch: next.defaultBranch, repositoryOwner: next.repositoryOwner, repositoryName: next.repositoryName, endpointPath: next.endpointPath, credentialReference: next.credentialReference, allowedContentTypes: canonicalList([...validated.target.allowedContentTypes]), allowedLanguages: canonicalList([...validated.target.allowedLanguages]), maximumPayloadBytes: next.maximumPayloadBytes, status: next.status, activeSlot: next.activeSlot, executionEnabled: next.executionEnabled, configurationFingerprint, revokedAt: next.revokedAt }))
  return { target: redactedTarget(stored), replayed: false }
}

export async function executeContentOperationEntry(input: { ownerUserId: number; entryId: number; trigger: 'owner_manual' | 'scheduler'; expectedRunId?: number; now?: Date; value: unknown; dependencies?: ContentOperationOrchestratorDependencies }): Promise<ExecuteContentOperationResult> {
  const dependencies = input.dependencies || {}
  const repository = dependencies.repository || createContentOperationsRepository()
  const parsed = parseExecuteInput(input.value)
  const clock = dependencies.clock || getDefaultContentOperationsClock()
  const now = input.now || clock.now()
  let entry = await repository.findEntry(input.ownerUserId, input.entryId)
  if (!entry) notFound('Content operation calendar entry was not found.')
  if (entry.status === 'delivered') return { entryId: entry.id, previousStatus: entry.status, resultingStatus: entry.status, runId: (await repository.listRuns(input.ownerUserId, entry.id)).find(run => run.stage === 'publication')?.id || 0, stage: 'publication', outcome: 'replayed', retryAt: null, limitations: ['delivered entries are immutable and replay-safe'] }
  if (entry.status === 'planned') {
    const calendar = await repository.findCalendar(input.ownerUserId, entry.calendarId)
    if (!calendar) notFound('Content operation calendar was not found.')
    await materializeOwnerDueContent(input.ownerUserId, { calendarId: calendar.id, expectedPlanFingerprint: calendar.planFingerprint, idempotencyKey: `orchestrator:materialize:${entry.id}` }, repository, { clock, eligibleEntryIds: [entry.id], leaseMs: dependencies.leaseMs })
    entry = await repository.findEntry(input.ownerUserId, input.entryId)
    if (!entry) notFound('Content operation calendar entry disappeared after materialization.')
  }
  if (entry.status === 'materialized' || entry.status === 'awaiting_generation') return executeGeneration(input.ownerUserId, entry, repository, dependencies, now, input.expectedRunId)
  if (entry.status === 'awaiting_review') {
    const synchronized = await synchronizeReview(input.ownerUserId, entry, repository, now, leaseMsFor(dependencies.leaseMs), input.expectedRunId)
    if (synchronized.outcome === 'awaiting_review' || synchronized.outcome === 'blocked') return { entryId: entry.id, previousStatus: entry.status, resultingStatus: synchronized.entry.status, runId: synchronized.run.id, stage: 'review_wait', outcome: synchronized.outcome, retryAt: synchronized.run.retryEligibleAt, limitations: synchronized.outcome === 'awaiting_review' ? ['no automatic human approval was created; waiting for the owner review'] : ['review decision blocked publication'] }
    if (synchronized.outcome === 'ready_to_publish') return { entryId: entry.id, previousStatus: entry.status, resultingStatus: synchronized.entry.status, runId: synchronized.run.id, stage: 'review_wait', outcome: 'ready_to_publish', retryAt: null, limitations: ['owner approval is synchronized; publication requires a separate explicit execute request'] }
    entry = synchronized.entry
  }
  if (entry.status === 'ready_to_publish' || entry.status === 'publishing') return executePublication(input.ownerUserId, entry, parsed, repository, dependencies, now, input.expectedRunId)
  return { entryId: entry.id, previousStatus: entry.status, resultingStatus: entry.status, runId: 0, stage: 'publication', outcome: 'blocked', retryAt: null, limitations: ['entry is not executable from its current durable status'] }
}

function stageCompatible(stage: ContentOperationRunRow['stage'], status: ContentOperationCalendarEntryRow['status']): boolean {
  if (stage === 'generation') return status === 'materialized' || status === 'awaiting_generation'
  if (stage === 'review_wait') return status === 'awaiting_review'
  if (stage === 'publication') return status === 'ready_to_publish' || status === 'publishing'
  return false
}

async function blockStaleRun(ownerUserId: number, run: ContentOperationRunRow, repository: ContentOperationsRepository, now: Date): Promise<ContentOperationRunRow | null> {
  if (!['queued', 'retry_wait', 'processing'].includes(run.state)) return run
  if (run.state === 'processing' && run.leaseOwner) return repository.updateRun(ownerUserId, run.id, { state: 'blocked', leaseOwner: null, leaseExpiresAt: null, errorCode: 'STALE_STAGE_RUN', errorSummary: 'Run stage is incompatible with the current entry status.' })
  return repository.updateRun(ownerUserId, run.id, { state: 'blocked', errorCode: 'STALE_STAGE_RUN', errorSummary: 'Run stage is incompatible with the current entry status.', completedAt: now })
}

export async function runContentOperationsExecutionTick(input: { ownerUserId?: number; now?: Date; repository?: ContentOperationsRepository; maxRuns?: number; dependencies?: Omit<ContentOperationOrchestratorDependencies, 'repository'> }) {
  const repository = input.repository || createContentOperationsRepository()
  const now = input.now || (input.dependencies?.clock || getDefaultContentOperationsClock()).now()
  const runs = await repository.listEligibleRuns(now, Math.min(50, input.maxRuns || 50), input.ownerUserId)
  const results: Array<{ runId: number; ownerUserId: number; status: string; outcome?: string; errorSummary?: string }> = []
  for (const run of runs) {
    try {
      const entry = await repository.findEntry(run.ownerUserId, run.entryId)
      if (!entry) {
        await blockStaleRun(run.ownerUserId, run, repository, now)
        results.push({ runId: run.id, ownerUserId: run.ownerUserId, status: 'blocked', errorSummary: 'orphan run' })
        continue
      }
      if (!stageCompatible(run.stage, entry.status)) {
        const blocked = await blockStaleRun(run.ownerUserId, run, repository, now)
        results.push({ runId: run.id, ownerUserId: run.ownerUserId, status: blocked?.state || 'blocked', errorSummary: 'stale run stage is incompatible with entry status' })
        continue
      }
      const mode = run.stage === 'publication' ? 'execute' : 'dry_run'
      const result = await executeContentOperationEntry({ ownerUserId: run.ownerUserId, entryId: entry.id, trigger: 'scheduler', expectedRunId: run.id, now, value: { idempotencyKey: `scheduler:publication:${run.id}:attempt:${run.attemptNumber + 1}`, mode }, dependencies: { ...input.dependencies, repository, productionRuntime: input.dependencies?.productionRuntime || {} } })
      results.push({ runId: run.id, ownerUserId: run.ownerUserId, status: result.resultingStatus, outcome: result.outcome })
    } catch (error) {
      results.push({ runId: run.id, ownerUserId: run.ownerUserId, status: 'blocked', errorSummary: sanitizeErrorSummary(error) })
    }
  }
  return { processed: runs.length, results, limitations: ['bounded batch of 50; each run is independently isolated', 'stage and entry status are checked before dispatch', 'no measurement or learning execution occurs in this tick'] }
}
export async function listOwnerPublicationTargets(ownerUserId: number, repository?: ContentOperationsRepository) {
  const db = repository || createContentOperationsRepository()
  return (await db.listPublicationTargets(ownerUserId)).map(redactedTarget)
}

import { createHash, randomUUID } from 'node:crypto'
import { createError } from 'h3'
import { executeFirstPartyPublication } from '../first-party-publishing/executor'
import { validateFirstPartyPublishTarget } from '../first-party-publishing/target-guard'
import type { ApprovedFirstPartyPublication, FirstPartyExecutionResult, FirstPartyFetch, NonceProvider, ServerCredentialResolver } from '../first-party-publishing/types'
import { runOwnerProductionDeliverable, runOwnerProductionRepair, type ProductionRuntimeDependencies } from '../seo-geo-core/service'
import type { CanonicalContext, ContentOperationsRepository, EventInsert, PublicationAttemptFinalization, PublicationAttemptInsert, PublicationAttemptReservation, PublicationTargetInsert, RunInsert } from './repository'
import { createContentOperationsRepository } from './repository'
import { buildPublicationIdentity, validatePersistedPublicationIdentity, type PublicationIdentity } from './publication-identity'
import { materializeOwnerDueContent, getDefaultContentOperationsClock } from './service'
import { evaluateOwnerAutopilotPolicy, GOVERNED_AUTOPILOT_POLICY_V4_VERSION, type OwnerAutopilotPolicy } from './autopilot-policy'
import { buildMachineAuthorization, buildRepairContract, decideBalancedAutopilot, type AutopilotPolicySnapshot, type EntityStrategyProfile, type QueryOwnership } from './balanced-autopilot'
import { projectAutopilotPolicy } from './autopilot-service'
import { getContentOperationsRuntimeDependencies } from './runtime-dependencies'
import { normalizePublicHttpsOrigin, parseEntryPublicationTargetsInput, parseExecuteInput, parsePublicationTargetInput, parsePublicationTargetPatchInput, sanitizeErrorSummary, stableFingerprint, stableStringify } from './normalization'
import type { Clock, ContentOperationCalendarEntryRow, ContentOperationPublicationTargetRow, ContentOperationRunRow, ExecuteContentOperationInput, ExecuteContentOperationResult, PublicationTargetInput, PublicationTargetPatchInput } from './types'
import { capabilityFor } from '../publication-routing/capability-matrix'
import { guardTarget } from '../publication-routing/target-guard'
import { normalizeOpaqueReference } from '../publication-routing/normalization'
import { GEOFlow_PINNED_SOURCE_SHA } from '../publication-routing'
import type { MultiChannelDispatchResult, MultiChannelExecutorRegistry, MultiChannelHttpTransport, MultiChannelLocalTransport, PublicationTargetInput as RoutingTargetInput, RoutingPlan } from '../publication-routing'
import { createMultiChannelExecutorRegistry, createRoutingPlan, executeMultiChannelPublication } from '../publication-routing'
import type { MultiChannelAdapterInput, MultiChannelAdapterResult } from '../publication-routing/multi-channel-executors'
import { canonicalContentOperationRunIdentity } from './run-identity'
import { evaluateCanonicalGeoContentQuality } from './quality-evaluation'

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
  autopilotPolicy?: OwnerAutopilotPolicy
  autopilotPoliciesByTarget?: Readonly<Record<number, OwnerAutopilotPolicy | undefined>>
  productionDeliverableRunner?: (input: { ownerUserId: number; clientId?: number; calendarEntryId?: number; planId: number; deliverableId: number; now?: Date; dependencies?: ProductionRuntimeDependencies }) => Promise<ContentDraftResult>
  repairRunner?: (input: { ownerUserId: number; planId: number; deliverableId: number; jobId: number; originalDraft: { id: number; title: string; body: string; contentHash: string; provenance?: unknown }; repairInstructions: readonly { code: string; instruction: string; locations?: string[] }[]; repairAttempt: number; repairContractFingerprint: string; now?: Date; dependencies?: ProductionRuntimeDependencies }) => Promise<ContentDraftResult>
  publicationExecutor?: FirstPartyPublicationExecutor
  multiChannelRegistry?: MultiChannelExecutorRegistry
  multiChannelHttpTransport?: MultiChannelHttpTransport
  multiChannelLocalTransport?: MultiChannelLocalTransport
  resolveMultiChannelCredential?: (credentialReference: string) => string | undefined | Promise<string | undefined>
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
    serviceReference: input.serviceReference ?? null,
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
    websiteId: target.websiteId,
    targetId: target.targetId,
    destinationPublicationIdentity: target.destinationPublicationIdentity,
    framework: target.framework,
    transport: target.transport,
    targetOrigin: target.targetOrigin,
    contentRoot: target.contentRoot,
    defaultBranch: target.defaultBranch,
    repositoryOwner: target.repositoryOwner,
    repositoryName: target.repositoryName,
    endpointPath: target.endpointPath,
    serviceReferenceConfigured: Boolean(target.serviceReference),
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
  if (target.status !== 'active' || target.activeSlot === null || target.activeSlot === undefined) badRequest('Publication target is not active.')
  if (target.ownerUserId !== ownerUserId || target.clientId !== client.id) notFound('Publication target was not found for this owner and client.')
  if (target.framework !== client.framework || target.transport !== client.publicationTransport) collision('Publication target framework or transport does not match the client.')
  const validated = validateFirstPartyPublishTarget(targetForPublisher(target, ownerUserId))
  if (validated.status === 'blocked') badRequest(`Publication target is invalid: ${validated.reasons.join('; ')}`)
  return validated.target
}

function targetWebsiteId(ownerUserId: number, clientId: number, canonicalOrigin: string): string {
  return `website-${stableFingerprint({ ownerUserId, clientId, canonicalOrigin }).slice(0, 32)}`
}

function destinationIdentityFor(targetIdValue: string, targetOrigin: string, contentRoot: string): string {
  return `destination-${stableFingerprint({ targetId: targetIdValue, targetOrigin, contentRoot }).slice(0, 32)}`
}

function routeTargetForExecution(target: ContentOperationPublicationTargetRow, ownerUserId: number) {
  const capability = capabilityFor(target.framework as never, target.transport as never)
  if (!capability) badRequest('Publication target capability is not supported by the server matrix.')
  let credentialReference: string
  try { credentialReference = normalizeOpaqueReference(target.credentialReference, 'credentialReference') } catch { badRequest('Publication target credential reference is malformed or contains secret material.') }
  const normalizedTarget = {
    targetId: target.targetId,
    siteIdentity: target.websiteId || targetWebsiteId(ownerUserId, target.clientId, target.targetOrigin),
    framework: target.framework,
    transport: target.transport,
    targetUrl: target.transport === 'geoflow_local' ? null : target.targetOrigin,
    serviceReference: target.transport === 'geoflow_local' ? target.serviceReference || null : null,
    credentialReference,
    destinationPublicationIdentity: target.destinationPublicationIdentity || destinationIdentityFor(target.targetId, target.targetOrigin, target.contentRoot),
    enabled: true,
  }
  const guard = guardTarget(normalizedTarget as never)
  if (!guard.valid) badRequest(`Publication target is blocked: ${guard.reasonCodes.join('; ')}`)
  return { target: normalizedTarget, capability, normalizedUrl: guard.normalizedUrl, normalizedServiceReference: guard.normalizedServiceReference }
}

function isFirstPartyTarget(target: { transport: string }): boolean {
  return target.transport === 'first_party_git' || target.transport === 'first_party_signed_api'
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

function activeSlotFor(targets: readonly ContentOperationPublicationTargetRow[]): number {
  const used = new Set(targets.filter(target => target.status === 'active' && target.activeSlot !== null && target.activeSlot !== undefined).map(target => target.activeSlot))
  for (let slot = 1; slot <= 20; slot += 1) if (!used.has(slot)) return slot
  collision('An owner client may have at most 20 active publication targets.')
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

async function ensureRun(repository: ContentOperationsRepository, ownerUserId: number, entry: ContentOperationCalendarEntryRow, stage: RunInsert['stage'], _input?: unknown): Promise<ContentOperationRunRow> {
  const identity = canonicalContentOperationRunIdentity(entry, stage)
  const payload = runPayload(ownerUserId, entry, stage, identity.inputFingerprint, identity.idempotencyKey)
  const existing = await repository.findRunByIdempotency(ownerUserId, identity.idempotencyKey)
  if (existing) {
    if (existing.ownerUserId !== ownerUserId || existing.entryId !== entry.id || existing.stage !== stage || existing.inputFingerprint !== identity.inputFingerprint) collision('Content operation run idempotency collision.')
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

function canonicalEvidenceForAutopilot(context: CanonicalContext, expectedHash: string, now: Date) {
  const snapshot = context.evidenceSnapshot
  if (snapshot.hash !== expectedHash || !snapshot.refs.length || snapshot.approvalTimestamps.length !== snapshot.refs.length || snapshot.materials.length !== snapshot.refs.filter(ref => Boolean(ref.artifactId)).length) badRequest('Governed autopilot requires an exact canonical approved evidence snapshot with complete artifact material.')
  const timestamps = snapshot.approvalTimestamps.map(value => Date.parse(value))
  if (timestamps.some(value => !Number.isFinite(value) || value > now.getTime())) badRequest('Governed autopilot requires valid non-future evidence approval timestamps.')
  const freshnessBasis = snapshot.freshnessBasis
  const minimum = Math.min(...timestamps)
  if (!freshnessBasis || Date.parse(freshnessBasis) !== minimum) badRequest('Governed autopilot evidence freshness basis is not derived from all approved references.')
  if (snapshot.refs.some(ref => !ref.approvedAt || Date.parse(ref.approvedAt) > now.getTime())) badRequest('Governed autopilot evidence reference approval metadata is incomplete or stale.')
  return { evidenceApproved: true as const, evidenceCapturedAt: freshnessBasis }
}

function balancedPolicySnapshot(policy: OwnerAutopilotPolicy): AutopilotPolicySnapshot {
  return {
    policyId: policy.policyId,
    policyVersion: policy.policyVersion,
    ownerUserId: policy.ownerUserId,
    clientId: policy.clientId,
    websiteId: policy.websiteId,
    mode: policy.mode,
    status: policy.status,
    allowedContentTypes: [...policy.allowedContentTypes],
    allowedLocales: [...policy.allowedLanguages],
    allowedDestinations: [...policy.allowedDestinations],
    allowedCadences: [...policy.allowedCadences],
    allowedRiskClasses: [...policy.allowedRiskClasses],
    riskSemanticsVersion: policy.riskSemanticsVersion || undefined,
    maximumRiskSeverity: policy.maximumRiskSeverity || undefined,
    allowedBusinessRiskClasses: [...policy.allowedBusinessRiskClasses],
    entityStrategyProfileId: policy.entityStrategyProfileId,
    maximumRepairAttempts: policy.maximumRepairAttempts,
    maximumTopicSubstitutions: policy.maximumTopicSubstitutions,
    generationBudget: policy.generationBudget,
    publicationBudget: policy.publicationBudget,
    configurationFingerprint: policy.configurationFingerprint,
    activatedAt: policy.activatedAt,
    expiresAt: policy.expiresAt,
    revokedAt: policy.revokedAt,
  }
}

function listStrings(value: unknown): string[] { return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [] }
function recordOf(value: unknown): Record<string, unknown> { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {} }

function balancedEntityProfile(value: unknown): EntityStrategyProfile | null {
  const row = recordOf(value)
  if (typeof row.profileId !== 'string' || typeof row.canonicalBrandName !== 'string' || typeof row.canonicalWebsiteOrigin !== 'string' || typeof row.evidenceSnapshotHash !== 'string' || typeof row.profileFingerprint !== 'string' || typeof row.effectiveAt !== 'object' && typeof row.effectiveAt !== 'string') return null
  const timestamp = row.effectiveAt instanceof Date ? row.effectiveAt.toISOString() : String(row.effectiveAt)
  return { canonicalBrandName: row.canonicalBrandName, brandAliases: listStrings(row.brandAliases), canonicalWebsiteOrigin: row.canonicalWebsiteOrigin, businessType: typeof row.businessType === 'string' ? row.businessType : '', primaryLocale: typeof row.primaryLocale === 'string' ? row.primaryLocale : 'en', secondaryLocales: listStrings(row.secondaryLocales), primaryLocations: listStrings(row.primaryLocations), serviceAreas: listStrings(row.serviceAreas), primaryServices: listStrings(row.primaryServices), secondaryServices: listStrings(row.secondaryServices), targetAudience: listStrings(row.targetAudience), primaryQueryClusters: listStrings(row.primaryQueryClusters), supportingQueryClusters: listStrings(row.supportingQueryClusters), canonicalPillarPages: listStrings(row.canonicalPillarPages), servicePageBindings: recordOf(row.servicePageBindings) as Record<string, string>, approvedBrandFacts: listStrings(row.approvedBrandFacts), approvedDifferentiators: listStrings(row.approvedDifferentiators), prohibitedClaims: listStrings(row.prohibitedClaims), preferredTone: typeof row.preferredTone === 'string' ? row.preferredTone : 'clear', requiredDisclosures: listStrings(row.requiredDisclosures), internalLinkPolicy: typeof row.internalLinkPolicy === 'string' ? row.internalLinkPolicy : 'canonical pages only', structuredDataIdentity: recordOf(row.structuredDataIdentity) as Record<string, string>, evidenceSnapshotHash: row.evidenceSnapshotHash, profileFingerprint: row.profileFingerprint, version: typeof row.version === 'number' ? row.version : 1, status: row.status === 'revoked' ? 'revoked' : 'active', effectiveAt: timestamp, revokedAt: row.revokedAt instanceof Date ? row.revokedAt.toISOString() : typeof row.revokedAt === 'string' ? row.revokedAt : null }
}

function balancedQueryOwnership(value: unknown): QueryOwnership | null {
  const row = recordOf(value)
  if (typeof row.ownerPageId !== 'string' || typeof row.normalizedQuery !== 'string' || typeof row.queryCluster !== 'string' || typeof row.evidenceSnapshotHash !== 'string' || typeof row.fingerprint !== 'string') return null
  return { ownerPageId: row.ownerPageId, normalizedQuery: row.normalizedQuery, queryCluster: row.queryCluster, supportingArticleIds: listStrings(row.supportingArticleIds), evidenceSnapshotHash: row.evidenceSnapshotHash, fingerprint: row.fingerprint, status: row.status === 'revoked' ? 'revoked' : 'active' }
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

function publicationFromLineage(ownerUserId: number, entry: ContentOperationCalendarEntryRow, calendar: { productionPlanId: number }, target: ContentOperationPublicationTargetRow, job: { id: number; productionPlanId: number | null; productionDeliverableId: number | null; strategyRecommendationId: number | null; evidenceSnapshotHash: string }, draft: { id: number; version: number; title: string; body: string; contentHash: string; provenance: unknown; safetyStatus: string }, review: { id: number; jobId: number; draftId: number; reviewerUserId: number; decision: string; evidenceSnapshotHash: string } | null, rules: string[], authoritySourceIds: string[], identity: PublicationIdentity, now: Date, authorityReference?: string): ApprovedFirstPartyPublication {
  if (job.productionPlanId !== calendar.productionPlanId || job.productionDeliverableId !== entry.productionDeliverableId || job.strategyRecommendationId !== entry.strategyRecommendationId || job.evidenceSnapshotHash !== entry.evidenceSnapshotHash) badRequest('Publication lineage does not match the calendar entry.')
  const governed = typeof authorityReference === 'string' && (/^ref-autopilot-[A-Za-z0-9._:-]+$/u.test(authorityReference) || /^[a-f0-9]{64}$/u.test(authorityReference))
  if (!governed && (!review || review.reviewerUserId !== ownerUserId || review.jobId !== job.id || review.draftId !== draft.id || review.decision !== 'approved_for_delivery' || review.evidenceSnapshotHash !== entry.evidenceSnapshotHash)) badRequest('A current owner approved_for_delivery review is required.')
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
    reviewId: governed ? authorityReference! : `review-${review!.id}`,
    reviewDecision: governed ? 'governed_autopilot' : 'approved_for_delivery',
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

async function executeMultiChannelPublicationPath(ownerUserId: number, entry: ContentOperationCalendarEntryRow, input: ExecuteContentOperationInput & { trigger: 'owner_manual' | 'scheduler' }, repository: ContentOperationsRepository, dependencies: ContentOperationOrchestratorDependencies, now: Date, targets: ContentOperationPublicationTargetRow[], expectedRunId?: number): Promise<ExecuteContentOperationResult> {
  const lineage = await repository.resolveWorkspaceEntry(ownerUserId, entry.id)
  if (!lineage || !lineage.calendar || !lineage.client || !lineage.job || !lineage.draft || !lineage.deliverable) badRequest('Publication lineage is incomplete.')
  const draft = lineage.draft as typeof lineage.draft & { title: string; body: string; provenance: unknown; version: number }
  const job = lineage.job as typeof lineage.job & { status?: string }
  const deliverable = lineage.deliverable as typeof lineage.deliverable & { status?: string }
  const schedulerMayUseGovernedAutopilot = input.trigger === 'scheduler' && Boolean(dependencies.autopilotPolicy || Object.values(dependencies.autopilotPoliciesByTarget || {}).some(Boolean))
  if (typeof job.status === 'string' && job.status !== 'approved' && !schedulerMayUseGovernedAutopilot) badRequest('Publication requires the content job to remain approved.')
  if (typeof deliverable.status === 'string' && !['approved', 'exported'].includes(deliverable.status) && !schedulerMayUseGovernedAutopilot) badRequest('Publication requires the deliverable to remain approved.')
  const context = await repository.resolveCanonicalContext(ownerUserId, lineage.calendar.productionPlanId, entry.productionDeliverableId)
  if (context.plan.id !== lineage.calendar.productionPlanId || context.deliverable.id !== entry.productionDeliverableId || context.strategy.id !== entry.strategyRecommendationId || context.evidenceSnapshot.hash !== entry.evidenceSnapshotHash) badRequest('Publication canonical context is stale or mismatched.')
  const gate = await repository.findRiskGate(ownerUserId, draft.id, entry.evidenceSnapshotHash)
  const riskGate = gate as typeof gate & { gateVersion?: string; findings?: unknown; riskLevel?: string }
  if (!gate || gate.draftId !== draft.id || gate.evidenceSnapshotHash !== entry.evidenceSnapshotHash || gate.status !== 'passed' || !safeString(riskGate.gateVersion) || !safeString(riskGate.riskLevel)) badRequest('Publication requires the latest exact passed risk gate.')
  const latestReview = await repository.findLatestReview(ownerUserId, job.id, draft.id, entry.evidenceSnapshotHash)
  const provenance = readRecord(draft.provenance)
  const providerProvenance = readRecord(provenance.providerProvenance)
  const providerModel = safeString(provenance.providerModel) || safeString(provenance.model) || safeString(providerProvenance.model) || (safeString(provenance.provider) ? `${safeString(provenance.provider)}:${safeString(provenance.providerVersion) || 'unknown'}` : null)
  const providerExecution = provenance.providerExecution === true && providerProvenance.providerExecution === true
  const qualityGateVersion = safeString(riskGate.gateVersion)
  const findings = Array.isArray(riskGate.findings) ? riskGate.findings : []
  const unsupportedFactualClaim = findings.some(item => { const record = readRecord(item); const id = safeString(record.id) || ''; return /unsupported|source_bound_claim|fabricated|performance|guarantee/iu.test(id) })
  const riskLevel = safeString(riskGate.riskLevel)
  const rules = Array.isArray(provenance.appliedRuleIds) ? provenance.appliedRuleIds.filter((value): value is string => typeof value === 'string') : []
  const deliverableProvenance = readRecord((lineage.deliverable as { provenance?: unknown }).provenance)
  const authoritySourceIds = Array.isArray(deliverableProvenance.authoritySourceIds) ? deliverableProvenance.authoritySourceIds.filter((value: unknown): value is string => typeof value === 'string') : []
  const evidenceAuthority = schedulerMayUseGovernedAutopilot ? canonicalEvidenceForAutopilot(context, entry.evidenceSnapshotHash, now) : null
  const evidenceApproved = evidenceAuthority?.evidenceApproved ?? false
  const evidenceCapturedAt = evidenceAuthority?.evidenceCapturedAt ?? null
  const targetRoutes: RoutingTargetInput[] = targets.map(target => routeTargetForExecution(target, ownerUserId).target as unknown as RoutingTargetInput)
  const bodyHash = createHash('sha256').update(draft.body, 'utf8').digest('hex')
  const priorAttempts = await repository.listPublicationAttempts(ownerUserId, entry.id)
  const plannedAt = priorAttempts.length ? Math.min(...priorAttempts.map(attempt => (attempt.startedAt || attempt.createdAt).getTime())) : now.getTime()
  let authorityReference: string | null = null
  const targetMachineAuthorizations = new Map<number, NonNullable<Awaited<ReturnType<typeof repository.findMachineAuthorizationForTarget>>>>()
  if (input.trigger === 'scheduler' && schedulerMayUseGovernedAutopilot) {
    for (const target of targets) {
      const targetPolicy = dependencies.autopilotPoliciesByTarget?.[target.id] || dependencies.autopilotPolicy
      if (targetPolicy?.policyVersion === GOVERNED_AUTOPILOT_POLICY_V4_VERSION) {
        const [policyRow, profile, query, authorization] = await Promise.all([
          repository.findAutopilotPolicy(ownerUserId, lineage.client.id, target.id),
          repository.findEntityStrategyProfile(ownerUserId, lineage.client.id, targetPolicy.websiteId, targetPolicy.entityStrategyProfileId),
          repository.findQueryOwnership(ownerUserId, lineage.client.id, targetPolicy.websiteId, entry.topicCluster),
          repository.findMachineAuthorizationForTarget(ownerUserId, entry.id, target.id),
        ])
        const payload = readRecord(authorization?.authorizationPayload)
        const { authorizationFingerprint: _embedded, ...payloadBase } = payload
        const qualityFingerprint = evaluateCanonicalGeoContentQuality({ content: draft.body, contentHash: draft.contentHash, evidenceSnapshotHash: entry.evidenceSnapshotHash, riskGateStatus: riskGate.status, riskGateVersion: riskGate.gateVersion || null, riskFindings: findings, entityProfileFingerprint: profile?.profileFingerprint || null, queryOwnershipFingerprint: query?.fingerprint || null }).evaluationFingerprint
        const deliveredTargetReplay = priorAttempts.some(attempt => attempt.targetId === target.id && attempt.status === 'delivered' && Boolean(attempt.receiptFingerprint))
        if (!policyRow || policyRow.status !== 'enabled' || policyRow.configurationFingerprint !== targetPolicy.configurationFingerprint || Date.parse(targetPolicy.expiresAt) <= now.getTime() || !profile || profile.status !== 'active' || profile.evidenceSnapshotHash !== entry.evidenceSnapshotHash || !query || query.status !== 'active' || query.evidenceSnapshotHash !== entry.evidenceSnapshotHash || !authorization || !authorization.authorizationExpiresAt || (authorization.status !== 'authorized' && !(authorization.status === 'published' && deliveredTargetReplay)) || (authorization.authorizationExpiresAt.getTime() <= now.getTime() && !deliveredTargetReplay) || authorization.policyFingerprint !== targetPolicy.configurationFingerprint || authorization.entityProfileFingerprint !== profile.profileFingerprint || authorization.queryOwnershipFingerprint !== query.fingerprint || authorization.jobId !== job.id || authorization.draftId !== draft.id || authorization.contentHash !== draft.contentHash || authorization.evidenceSnapshotHash !== entry.evidenceSnapshotHash || authorization.publicationTargetId !== target.id || authorization.targetId !== target.targetId || authorization.qualityFingerprint !== qualityFingerprint || stableFingerprint(payloadBase) !== authorization.authorizationFingerprint) return { entryId: entry.id, entry, previousStatus: entry.status, resultingStatus: entry.status, runId: 0, stage: 'publication', outcome: 'blocked', retryAt: null, limitations: ['exact per-target V4 authorization reload failed; no executor was called'] }
        targetMachineAuthorizations.set(target.id, authorization)
        continue
      }
      const evaluation = evaluateOwnerAutopilotPolicy({ policy: targetPolicy, ownerUserId, clientId: lineage.client.id, targetRowId: target.id, targetId: target.targetId, targetStatus: target.status, targetExecutionEnabled: target.executionEnabled, entry, entryCadenceDays: lineage.calendar.cadenceDays, reviewDecision: latestReview?.decision || null, riskGateStatus: gate.status, riskLevel, qualityGateVersion, evidenceApproved, evidenceCapturedAt, providerExecution, providerModel, providerProvenanceComplete: Boolean(providerModel && provenance.stage === 'optimized' && provenance.evidenceSnapshotHash === entry.evidenceSnapshotHash && providerProvenance.providerExecution === true), unsupportedFactualClaim, contentHashMatchesDraft: draft.contentHash === entry.contentHash, now })
      if (!evaluation.allowed) return { entryId: entry.id, entry, previousStatus: entry.status, resultingStatus: entry.status, runId: 0, stage: 'publication', outcome: 'blocked', retryAt: null, limitations: [...evaluation.reasons, `decisionCode=${evaluation.code}`] }
    }
    const policyIds = targets.map(target => dependencies.autopilotPoliciesByTarget?.[target.id] || dependencies.autopilotPolicy).filter((policy): policy is OwnerAutopilotPolicy => Boolean(policy)).map(policy => policy.policyId).sort()
    authorityReference = targetMachineAuthorizations.size ? `ref-autopilot-v4-${stableFingerprint([...targetMachineAuthorizations.values()].map(row => row.authorizationFingerprint).sort()).slice(0, 64)}` : `ref-autopilot-${(policyIds.length ? policyIds.join('.') : 'missing').slice(0, 140)}`
  } else if (input.trigger === 'scheduler' || !latestReview || latestReview.reviewerUserId !== ownerUserId || latestReview.jobId !== job.id || latestReview.draftId !== draft.id || latestReview.decision !== 'approved_for_delivery' || latestReview.evidenceSnapshotHash !== entry.evidenceSnapshotHash) {
    if (!latestReview || latestReview.reviewerUserId !== ownerUserId || latestReview.jobId !== job.id || latestReview.draftId !== draft.id || latestReview.decision !== 'approved_for_delivery' || latestReview.evidenceSnapshotHash !== entry.evidenceSnapshotHash) badRequest('A current owner approved_for_delivery review is required before multi-channel publication.')
  }
  const identityResult = buildPublicationIdentity({ clientId: lineage.client.id, entryId: entry.id, targetId: targets[0]!.targetId, targetOrigin: targets[0]!.targetOrigin, contentRoot: targets[0]!.contentRoot, contentType: entry.contentType, language: entry.language, title: draft.title, ownerScopeKey: ownerScopeKey(ownerUserId) })
  if (!identityResult.ok) badRequest(`Publication identity is invalid: ${identityResult.reason}`)
  const identity = identityResult.identity
  const plan = createRoutingPlan({
    draft: { ownerIdentity: { id: `owner-${ownerUserId}` }, clientIdentity: { id: `client-${lineage.client.id}` }, productionPlanId: `plan-${lineage.calendar.productionPlanId}`, deliverableId: `deliverable-${entry.productionDeliverableId}`, draftId: `draft-${draft.id}`, reviewId: authorityReference || `review-${latestReview!.id}`, draftStage: 'optimized', reviewDecision: authorityReference ? 'governed_autopilot' : 'approved_for_delivery', riskGateStatus: 'passed', evidenceSnapshotHash: entry.evidenceSnapshotHash, contentHash: bodyHash, content: draft.body, contentType: entry.contentType, language: entry.language, sourcePublicationIdentity: `source-${entry.id}-${draft.contentHash.slice(0, 32)}`, geoflowSourceSha: GEOFlow_PINNED_SOURCE_SHA },
    targets: targetRoutes,
    plannedAt,
    idempotencyKey: `content-operation-routing:${entry.id}:${draft.contentHash}`.slice(0, 200),
  })
  const routeTarget = new Map(targets.map(target => [target.targetId, target]))
  const routeIdentity = new Map(plan.routes.map(route => {
    const target = routeTarget.get(route.targetId)
    if (!target) badRequest('Routing plan contains a target outside the owner-scoped set.')
    const result = buildPublicationIdentity({ clientId: lineage.client.id, entryId: entry.id, targetId: route.targetId, targetOrigin: target.targetOrigin, contentRoot: target.contentRoot, contentType: entry.contentType, language: entry.language, title: draft.title, ownerScopeKey: ownerScopeKey(ownerUserId) })
    if (!result.ok) badRequest(`Route publication identity is invalid: ${result.reason}`)
    return [route.routeId, result.identity] as const
  }))
  const persistedEntry = await repository.transaction(async transaction => transaction.updateEntry(ownerUserId, entry.id, { publicationTargetId: targets[0]!.id, publicationSlug: identity.slug, publicationPath: identity.path, publicationIdentityFingerprint: identity.identityFingerprint, publicationContentHash: bodyHash, publicationRoutingPlanId: plan.planFingerprint, publicationAuthorityReference: authorityReference, publicationTargetCount: targets.length }))
  if (input.mode === 'execute' && targets.some(target => !target.executionEnabled)) badRequest('Execute mode is disabled for one or more publication targets; use dry_run explicitly.')
  const basePublicationFingerprint = stableFingerprint({ jobId: job.id, draftId: draft.id, evidenceSnapshotHash: entry.evidenceSnapshotHash })
  const compatiblePublicationRun = (await repository.listRuns(ownerUserId, entry.id)).find(run => run.stage === 'publication' && run.inputFingerprint === basePublicationFingerprint)
  const stageRun = compatiblePublicationRun || await ensureRun(repository, ownerUserId, persistedEntry, 'publication', { jobId: job.id, draftId: draft.id, evidenceSnapshotHash: entry.evidenceSnapshotHash, routingPlanId: plan.planFingerprint })
  if (expectedRunId !== undefined && stageRun.id !== expectedRunId) badRequest('The expected publication run is stale or does not match the current publication run.')
  if (stageRun.state === 'succeeded' && entry.status === 'delivered') return { entryId: entry.id, entry: persistedEntry, previousStatus: entry.status, resultingStatus: 'delivered', runId: stageRun.id, stage: 'publication', outcome: 'replayed', retryAt: null, limitations: ['replayed from durable multi-channel publication identity'] }
  const requestedMode = input.mode || 'dry_run'
  const requestFingerprint = stableFingerprint({ entryId: entry.id, mode: requestedMode, routingPlanFingerprint: plan.planFingerprint, contentHash: draft.contentHash, publicationContentHash: bodyHash, evidenceSnapshotHash: entry.evidenceSnapshotHash })
  const previousLedger = priorAttempts.flatMap(attempt => { const value = readRecord(attempt.remoteState); return [...(Array.isArray(attempt.receiptLedger) ? attempt.receiptLedger : []), ...(Array.isArray(value.receipts) ? value.receipts : [])] })
  const batchAttempt = Math.max(1, stageRun.attemptNumber + 1)
  if (batchAttempt > MAX_ATTEMPTS) badRequest('Publication retry limit has been reached.')
  const token = randomUUID()
  const leased = await repository.acquireRunLease(ownerUserId, stageRun.id, token, now, leaseMsFor(dependencies.leaseMs))
  if (!leased) return { entryId: entry.id, entry: persistedEntry, previousStatus: entry.status, resultingStatus: entry.status, runId: stageRun.id, stage: 'publication', outcome: 'replayed', retryAt: stageRun.retryEligibleAt, limitations: ['another worker currently owns the multi-channel publication lease'] }
  const configuredRegistry = dependencies.multiChannelRegistry || createMultiChannelExecutorRegistry({ httpTransport: dependencies.multiChannelHttpTransport, localTransport: dependencies.multiChannelLocalTransport })
  const registry: MultiChannelExecutorRegistry = { ...configuredRegistry }
  const firstPartyPublisher = dependencies.publicationExecutor || defaultPublisher(dependencies)
  for (const firstPartyExecutor of ['first_party_git', 'first_party_signed_api'] as const) {
    if (registry[firstPartyExecutor]) continue
    registry[firstPartyExecutor] = async (adapterInput: MultiChannelAdapterInput): Promise<MultiChannelAdapterResult> => {
      const target = routeTarget.get(adapterInput.route.targetId)
      const identityForRoute = routeIdentity.get(adapterInput.route.routeId)
      if (!target || !identityForRoute) return { status: 'blocked', reason: 'first-party route target or identity was not found in the owner-scoped route set' }
      const publication: ApprovedFirstPartyPublication = {
        ownerScopeKey: ownerScopeKey(ownerUserId), scheduleEntryId: `entry-${entry.id}`, productionPlanId: `plan-${lineage.calendar.productionPlanId}`, productionDeliverableId: `deliverable-${entry.productionDeliverableId}`, jobId: `job-${job.id}`, draftId: adapterInput.route.draftId, draftVersion: draft.version, draftStage: 'optimized', reviewId: adapterInput.route.reviewId, reviewDecision: authorityReference ? 'governed_autopilot' : 'approved_for_delivery', riskGateStatus: 'passed', evidenceSnapshotHash: adapterInput.route.evidenceSnapshotHash, contentHash: adapterInput.route.contentHash, title: draft.title, body: adapterInput.content, slug: identityForRoute.slug, contentType: adapterInput.route.contentType, language: adapterInput.route.language, scheduledAt: now.toISOString(), scheduleKey: entry.scheduleKey, authoritySourceIds, ruleIds: rules,
      }
      let result: FirstPartyExecutionResult
      try {
        result = await firstPartyPublisher({ target: targetForPublisher(target, ownerUserId), publication, now: now.toISOString(), serverNow: now.toISOString(), mode: 'execute', fetchImpl: dependencies.fetchImpl, serverCredentialResolver: dependencies.serverCredentialResolver, nonceProvider: dependencies.nonceProvider })
      } catch (error) {
        return { status: 'failed', retryable: true, reason: sanitizeErrorSummary(error) }
      }
      if (result.status === 'delivered') return { status: 'delivered', remote: { publicationId: result.publicationId, contentHash: result.contentHash, remoteRevision: result.remoteRevision } }
      if (result.status === 'retryable_failure') return { status: 'retry_wait', reason: result.reasons.join('; ') }
      if (result.status === 'permanent_failure') return { status: 'failed', retryable: false, reason: result.reasons.join('; ') }
      if (result.status === 'blocked') return { status: 'blocked', reason: result.reasons.join('; ') }
      return { status: 'blocked', reason: 'first-party executor returned a dry-run result during execute mode' }
    }
  }
  const reservations = new Map<string, PublicationAttemptReservation>()
  const claimedMachineAuthorizations = new Map<string, NonNullable<Awaited<ReturnType<typeof repository.findMachineAuthorizationForTarget>>>>()
  const dispatchInputs = new Map<string, { idempotencyKey: string; executorRunId: string; attempt: number }>()
  const results: MultiChannelDispatchResult[] = []
  const routeAttempts = new Map<string, typeof priorAttempts[number]>()
  for (const attempt of priorAttempts) {
    if (attempt.routeId && attempt.targetId && (!routeAttempts.has(attempt.routeId) || (routeAttempts.get(attempt.routeId)?.attemptNumber || 0) < attempt.attemptNumber)) routeAttempts.set(attempt.routeId, attempt)
  }
  const routeAttemptKey = (routeId: string, attempt: number) => `ref-content-attempt-${stableFingerprint({ input: input.idempotencyKey, routeId, attempt }).slice(0, 64)}`
  const routeExecutorRunId = (routeId: string, attempt: number) => `ref-content-run-${stableFingerprint({ entryId: entry.id, routeId, attempt }).slice(0, 64)}`
  const storedResult = (route: RoutingPlan['routes'][number], stored: typeof priorAttempts[number], status: MultiChannelDispatchResult['status'], reasonText: string): MultiChannelDispatchResult => ({ status, routeId: route.routeId, executor: route.executor, attempt: stored.attemptNumber, receipt: Array.isArray(stored.receiptLedger) && stored.receiptLedger[0] ? stored.receiptLedger[0] as MultiChannelDispatchResult['receipt'] : null, receiptFingerprint: stored.receiptFingerprint || null, replay: true, collision: false, reasons: [reasonText] })
  try {
    for (const route of plan.routes) {
      const stored = routeAttempts.get(route.routeId)
      if (stored?.status === 'delivered') {
        if (!stored.receiptLedger || !Array.isArray(stored.receiptLedger) || !stored.receiptLedger.length || !stored.receiptFingerprint) {
          results.push(storedResult(route, stored, 'blocked', 'stored delivered target has no verified receipt; executor was not called'))
          continue
        }
        results.push(storedResult(route, stored, 'delivered', 'replayed from the verified delivered target receipt; executor was not called'))
        continue
      }
      if (stored && (stored.status === 'permanent_failure' || stored.status === 'blocked')) {
        results.push(storedResult(route, stored, 'failed', 'previous target attempt was permanently blocked; executor was not called'))
        continue
      }
      const attempt = batchAttempt
      const idempotencyKey = routeAttemptKey(route.routeId, attempt)
      const executorRunId = routeExecutorRunId(route.routeId, attempt)
      dispatchInputs.set(route.routeId, { idempotencyKey, executorRunId, attempt })
      const existing = await repository.findPublicationAttemptByIdempotency(ownerUserId, idempotencyKey)
      if (existing && (existing.inputFingerprint !== requestFingerprint || existing.entryId !== entry.id || existing.targetId !== routeTarget.get(route.targetId)?.id || existing.routeId !== route.routeId || existing.mode !== requestedMode)) collision('Publication idempotency key is associated with a different multi-channel input.')
      if (existing && existing.status !== 'planned') {
        const status: MultiChannelDispatchResult['status'] = existing.status === 'delivered' ? 'delivered' : existing.status === 'dry_run_succeeded' ? 'planned' : existing.status === 'retryable_failure' ? 'retry_wait' : 'failed'
        results.push(storedResult(route, existing, status, 'replayed from the per-target attempt ledger; executor was not called'))
        continue
      }
      if (requestedMode === 'execute') {
        const target = routeTarget.get(route.targetId)
        const identityForRoute = routeIdentity.get(route.routeId)
        if (!target || !identityForRoute) badRequest('Publication route target identity could not be resolved.')
        const targetAuthorization = targetMachineAuthorizations.get(target.id)
        if (targetAuthorization) {
          const claimed = await repository.transitionMachineAuthorization(ownerUserId, targetAuthorization.authorizationFingerprint, 'authorized', 'executing', now)
          if (!claimed) { results.push({ status: 'failed', routeId: route.routeId, executor: route.executor, attempt, receipt: null, receiptFingerprint: null, replay: true, collision: false, reasons: ['per-target machine authorization CAS was not acquired; executor was not called'] }); continue }
          const budget = await repository.reserveAutopilotBudget({ ownerUserId, policyId: targetAuthorization.policyId, publicationTargetId: target.id, entryId: entry.id, kind: 'publication', units: 1, idempotencyKey: `publication:${targetAuthorization.authorizationFingerprint}`.slice(0, 160), inputFingerprint: stableFingerprint({ version: 'autopilot-budget-v1', kind: 'publication', authorizationFingerprint: targetAuthorization.authorizationFingerprint, entryId: entry.id, targetId: target.id }) })
          if (!budget.reserved) { await repository.transitionMachineAuthorization(ownerUserId, targetAuthorization.authorizationFingerprint, 'executing', 'revoked', now); results.push({ status: 'failed', routeId: route.routeId, executor: route.executor, attempt, receipt: null, receiptFingerprint: null, replay: false, collision: false, reasons: ['per-target publication budget exhausted; executor was not called'] }); continue }
          claimedMachineAuthorizations.set(route.routeId, targetAuthorization)
        }
        const routeAuthorityReference = targetAuthorization?.authorizationFingerprint || authorityReference
        const reservation = await repository.reservePublicationAttempt({ ownerUserId, clientId: lineage.client.id, entryId: entry.id, runId: leased.id, targetId: target.id, websiteId: target.websiteId || null, routingPlanId: plan.planFingerprint, routeId: route.routeId, executorRunId, authorityReference: routeAuthorityReference, mode: requestedMode, attemptNumber: attempt, idempotencyKey, inputFingerprint: requestFingerprint, publicationId: identityForRoute.publicationId, publicationSlug: identityForRoute.slug, publicationPath: identityForRoute.path, contentHash: draft.contentHash, publicationContentHash: bodyHash, evidenceSnapshotHash: entry.evidenceSnapshotHash, startedAt: now, leaseToken: token, jobId: job.id, draftId: draft.id, reviewId: routeAuthorityReference ? null : latestReview?.id || null, riskGateId: gate.id })
        reservations.set(route.routeId, reservation)
      }
      results.push(await executeMultiChannelPublication({ plan, routeId: route.routeId, content: draft.body, idempotencyKey, executorRunId, attempt, now: now.getTime(), mode: requestedMode, knownReceipts: previousLedger, registry, resolveCredential: dependencies.resolveMultiChannelCredential }))
    }
    const deliveredCount = results.filter(result => result.status === 'delivered').length
    const retryCount = results.filter(result => result.status === 'retry_wait').length
    const allDryRun = requestedMode === 'dry_run' && results.every(result => result.status === 'planned')
    const aggregateStatus = allDryRun ? 'dry_run_succeeded' as const : deliveredCount === results.length ? 'delivered' as const : retryCount > 0 && batchAttempt < MAX_ATTEMPTS ? 'retryable_failure' as const : retryCount > 0 ? 'permanent_failure' as const : 'blocked' as const
    const receiptLedger = results.flatMap(result => result.receipt ? [{ routeId: result.routeId, status: result.status, receipt: result.receipt, receiptFingerprint: result.receiptFingerprint, replay: result.replay }] : [])
    const finalization = { status: aggregateStatus, artifactFingerprint: stableFingerprint({ planFingerprint: plan.planFingerprint, receiptLedger }), remoteState: aggregateStatus, receiptLedger, remoteRevision: null, errorCode: aggregateStatus === 'delivered' || aggregateStatus === 'dry_run_succeeded' ? null : 'MULTI_CHANNEL_DISPATCH_BLOCKED', errorSummary: aggregateStatus === 'delivered' || aggregateStatus === 'dry_run_succeeded' ? null : sanitizeErrorSummary(results.flatMap(result => result.reasons).join('; ')), completedAt: now } as const
    const finalized = await repository.transaction(async transaction => {
      for (const result of results) {
        const route = plan.routes.find(candidate => candidate.routeId === result.routeId)
        const target = route ? routeTarget.get(route.targetId) : null
        const identityForRoute = route ? routeIdentity.get(route.routeId) : null
        if (!route || !target || !identityForRoute) badRequest('Multi-channel route lineage could not be finalized.')
        const dispatch = dispatchInputs.get(route.routeId) || { idempotencyKey: `ref-replay-${stableFingerprint({ entryId: entry.id, routeId: route.routeId }).slice(0, 64)}`, executorRunId: routeExecutorRunId(route.routeId, result.attempt), attempt: result.attempt }
        const reservation = reservations.get(route.routeId)
        if (requestedMode === 'execute' && reservation) {
          const patch: PublicationAttemptFinalization = { status: result.status === 'delivered' ? 'delivered' : result.status === 'retry_wait' ? 'retryable_failure' : result.status === 'planned' ? 'dry_run_succeeded' : 'permanent_failure', artifactFingerprint: stableFingerprint({ routeId: route.routeId, receiptFingerprint: result.receiptFingerprint, status: result.status }), remoteState: result.status, receiptLedger: result.receipt ? [result.receipt] : [], remoteRevision: null, receiptFingerprint: result.receiptFingerprint, publicationUrl: null, errorCode: result.status === 'delivered' || result.status === 'planned' ? null : 'MULTI_CHANNEL_DISPATCH_BLOCKED', errorSummary: result.status === 'delivered' || result.status === 'planned' ? null : sanitizeErrorSummary(result.reasons.join('; ')), completedAt: now }
          const stored = await transaction.finalizePublicationAttempt(ownerUserId, reservation.attempt.id, patch)
          if (!stored) badRequest('A per-target multi-channel attempt could not be finalized from planned state.')
          const machineAuthorization = claimedMachineAuthorizations.get(route.routeId)
          if (machineAuthorization) {
            const nextAuthorizationStatus = result.status === 'delivered' ? 'published' : result.status === 'retry_wait' ? 'authorized' : 'revoked'
            const transitioned = await transaction.transitionMachineAuthorization(ownerUserId, machineAuthorization.authorizationFingerprint, 'executing', nextAuthorizationStatus, now)
            if (!transitioned) badRequest('Per-target machine authorization finalization CAS failed.')
          }
        } else if (requestedMode === 'dry_run' && !await transaction.findPublicationAttemptByIdempotency(ownerUserId, dispatch.idempotencyKey)) {
          await transaction.insertPublicationAttempt({ ownerUserId, clientId: lineage.client.id, entryId: entry.id, runId: leased.id, targetId: target.id, websiteId: target.websiteId || null, routingPlanId: plan.planFingerprint, routeId: route.routeId, executorRunId: dispatch.executorRunId, authorityReference, publicationUrl: null, receiptFingerprint: result.receiptFingerprint, mode: requestedMode, attemptNumber: dispatch.attempt, idempotencyKey: dispatch.idempotencyKey, inputFingerprint: requestFingerprint, publicationId: identityForRoute.publicationId, publicationSlug: identityForRoute.slug, publicationPath: identityForRoute.path, contentHash: draft.contentHash, publicationContentHash: bodyHash, evidenceSnapshotHash: entry.evidenceSnapshotHash, artifactFingerprint: finalization.artifactFingerprint, status: 'dry_run_succeeded', remoteState: 'dry_run', receiptLedger: [], remoteRevision: null, errorCode: null, errorSummary: null, startedAt: now, completedAt: now })
        }
        const routeEvent = event(ownerUserId, entry, leased.id, `publication_route_${result.status}`, entry.status, aggregateStatus === 'delivered' ? 'delivered' : aggregateStatus === 'retryable_failure' ? 'ready_to_publish' : entry.status, { routeId: route.routeId, targetId: target.id, status: result.status, replay: result.replay, receiptFingerprint: result.receiptFingerprint, reason: result.reasons[0] || null }, { entryId: entry.id, planFingerprint: plan.planFingerprint, routeId: route.routeId, attempt: result.attempt, status: result.status })
        await transaction.appendEvent({ ...routeEvent, clientId: lineage.client.id, websiteId: target.websiteId || null, deliverableId: entry.productionDeliverableId, draftId: draft.id, routingPlanId: plan.planFingerprint, routeId: route.routeId, executorRunId: dispatch.executorRunId, contentHash: bodyHash, evidenceSnapshotHash: entry.evidenceSnapshotHash, authorityReference: targetMachineAuthorizations.get(target.id)?.authorizationFingerprint || authorityReference })
      }
      const nextStatus = aggregateStatus === 'delivered' ? 'delivered' : aggregateStatus === 'retryable_failure' ? 'ready_to_publish' : aggregateStatus === 'dry_run_succeeded' ? entry.status : 'blocked'
      const updated = await transaction.updateEntry(ownerUserId, entry.id, { status: nextStatus, contentHash: draft.contentHash, publicationContentHash: bodyHash, publicationTargetId: targets[0]!.id, publicationSlug: identity.slug, publicationPath: identity.path, publicationIdentityFingerprint: identity.identityFingerprint, publicationRoutingPlanId: plan.planFingerprint, publicationAuthorityReference: authorityReference, publicationTargetCount: targets.length })
      const runState: RunInsert['state'] = aggregateStatus === 'delivered' || aggregateStatus === 'dry_run_succeeded' ? 'succeeded' : aggregateStatus === 'retryable_failure' ? 'retry_wait' : 'blocked'
      const completed = await transaction.releaseRunLease(ownerUserId, leased.id, runState, token, now, { code: finalization.errorCode || undefined, summary: finalization.errorSummary || undefined, retryEligibleAt: aggregateStatus === 'retryable_failure' ? retryDate(now, batchAttempt) : null })
      if (!completed) badRequest('Multi-channel publication lease could not be completed.')
      return { updated, completed }
    })
    return { entryId: entry.id, entry: finalized.updated, previousStatus: entry.status, resultingStatus: finalized.updated.status, runId: finalized.completed.id, stage: 'publication', outcome: aggregateStatus === 'delivered' ? 'delivered' : aggregateStatus === 'dry_run_succeeded' ? 'dry_run_succeeded' : aggregateStatus === 'retryable_failure' ? 'retry_wait' : 'blocked', retryAt: aggregateStatus === 'retryable_failure' ? retryDate(now, batchAttempt) : null, limitations: aggregateStatus === 'delivered' ? ['all target routes delivered with exact remote identity and body hash; each target has an independent append-only attempt'] : aggregateStatus === 'retryable_failure' ? ['only unresolved retryable target routes are eligible for the next batch attempt; delivered routes replay from verified receipts'] : ['multi-channel publication did not complete; no unvalidated target is treated as delivered'] }
  } catch (error) {
    for (const authorization of claimedMachineAuthorizations.values()) await repository.transitionMachineAuthorization(ownerUserId, authorization.authorizationFingerprint, 'executing', 'authorized', now).catch(() => null)
    const released = await repository.releaseRunLease(ownerUserId, leased.id, 'blocked', token, now, { code: 'MULTI_CHANNEL_EXECUTION_FAILED', summary: sanitizeErrorSummary(error) })
    if (!released) badRequest('Multi-channel publication failure lease could not be completed.')
    throw error
  }
}

async function executePublication(ownerUserId: number, entry: ContentOperationCalendarEntryRow, input: ExecuteContentOperationInput & { trigger: 'owner_manual' | 'scheduler' }, repository: ContentOperationsRepository, dependencies: ContentOperationOrchestratorDependencies, now: Date, expectedRunId?: number): Promise<ExecuteContentOperationResult> {
  const lineage = await repository.resolveWorkspaceEntry(ownerUserId, entry.id)
  if (!lineage || !lineage.calendar || !lineage.client || !lineage.job || !lineage.draft || !lineage.deliverable) badRequest('Publication lineage is incomplete.')
  const bindings = await repository.listEntryTargetBindings(ownerUserId, entry.id)
  const boundTargets = bindings.length ? await Promise.all(bindings.sort((left, right) => left.slot - right.slot).map(async binding => repository.findPublicationTarget(ownerUserId, binding.targetId))) : []
  if (boundTargets.some(target => !target || target.ownerUserId !== ownerUserId || target.clientId !== lineage.client.id)) badRequest('Entry target binding is not owner/client scoped.')
  const selectedTargets = (boundTargets.filter((target): target is ContentOperationPublicationTargetRow => Boolean(target)) as ContentOperationPublicationTargetRow[])
  const legacyTarget = lineage.target || await repository.findActivePublicationTarget(ownerUserId, lineage.client.id)
  const executionTargets = selectedTargets.length ? selectedTargets : legacyTarget ? [legacyTarget] : []
  if (!executionTargets.length) badRequest('An active publication target is required before publication.')
  if (executionTargets.length > 1 || executionTargets.some(target => !isFirstPartyTarget(target))) return executeMultiChannelPublicationPath(ownerUserId, entry, input, repository, dependencies, now, executionTargets, expectedRunId)
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
  const schedulerMayUseGovernedAutopilot = input.trigger === 'scheduler' && dependencies.autopilotPolicy !== undefined && dependencies.autopilotPolicy.requireApprovedForDelivery !== true
  if ((!latestReview || latestReview.reviewerUserId !== ownerUserId || latestReview.jobId !== job.id || latestReview.draftId !== draft.id || latestReview.evidenceSnapshotHash !== entry.evidenceSnapshotHash) && !schedulerMayUseGovernedAutopilot) badRequest('A current owner review is required before publication.')
  if (latestReview && latestReview.decision !== 'approved_for_delivery') {
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
  if (typeof job.status === 'string' && job.status !== 'approved' && !schedulerMayUseGovernedAutopilot) badRequest('Publication requires the content job to remain approved.')
  if (typeof deliverable.status === 'string' && !['approved', 'exported'].includes(deliverable.status) && !schedulerMayUseGovernedAutopilot) badRequest('Publication requires the deliverable to remain approved.')
  const context = await repository.resolveCanonicalContext(ownerUserId, lineage.calendar.productionPlanId, entry.productionDeliverableId)
  if (context.plan.id !== lineage.calendar.productionPlanId || context.deliverable.id !== entry.productionDeliverableId || context.strategy.id !== entry.strategyRecommendationId || context.evidenceSnapshot.hash !== entry.evidenceSnapshotHash) badRequest('Publication canonical context is stale or mismatched.')
  const gate = await repository.findRiskGate(ownerUserId, draft.id, entry.evidenceSnapshotHash)
  const riskGate = gate as typeof gate & { gateVersion?: string; findings?: unknown; riskLevel?: string }
  if (!gate || gate.draftId !== draft.id || gate.evidenceSnapshotHash !== entry.evidenceSnapshotHash || gate.status !== 'passed' || !safeString(riskGate.gateVersion) || !safeString(riskGate.riskLevel)) badRequest('Publication requires the latest exact passed risk gate.')
  let authorityReference: string | null = null
  let machineAuthorization: Awaited<ReturnType<typeof repository.findMachineAuthorizationForTarget>> = null
  if (input.trigger === 'scheduler' && dependencies.autopilotPolicy) {
    const provenance = readRecord(draft.provenance)
    const providerProvenance = readRecord(provenance.providerProvenance)
    const providerModel = safeString(provenance.providerModel) || safeString(provenance.model) || safeString(providerProvenance.model) || (safeString(provenance.provider) ? `${safeString(provenance.provider)}:${safeString(provenance.providerVersion) || 'unknown'}` : null)
    const evidenceAuthority = canonicalEvidenceForAutopilot(context, entry.evidenceSnapshotHash, now)
    const { evidenceApproved, evidenceCapturedAt } = evidenceAuthority
    const findings = Array.isArray(riskGate.findings) ? riskGate.findings : []
    const unsupportedFactualClaim = findings.some(item => { const record = readRecord(item); const id = safeString(record.id) || ''; return /unsupported|source_bound_claim|fabricated|performance|guarantee/iu.test(id) })
    if (dependencies.autopilotPolicy.policyVersion === GOVERNED_AUTOPILOT_POLICY_V4_VERSION) {
      const currentPolicyRow = await repository.findAutopilotPolicy(ownerUserId, lineage.client.id, target.id)
      const currentProfile = await repository.findEntityStrategyProfile(ownerUserId, lineage.client.id, dependencies.autopilotPolicy.websiteId, dependencies.autopilotPolicy.entityStrategyProfileId)
      const currentQuery = await repository.findQueryOwnership(ownerUserId, lineage.client.id, dependencies.autopilotPolicy.websiteId, entry.topicCluster)
      machineAuthorization = await repository.findMachineAuthorizationForTarget(ownerUserId, entry.id, target.id)
      const payload = readRecord(machineAuthorization?.authorizationPayload)
      const { authorizationFingerprint: _embeddedFingerprint, ...payloadBase } = payload
      const riskPayload = readRecord(payload.risk)
      const expectedQualityFingerprint = evaluateCanonicalGeoContentQuality({ content: draft.body, contentHash: draft.contentHash, evidenceSnapshotHash: entry.evidenceSnapshotHash, riskGateStatus: riskGate.status, riskGateVersion: riskGate.gateVersion || null, riskFindings: Array.isArray(riskGate.findings) ? riskGate.findings : [], entityProfileFingerprint: currentProfile?.profileFingerprint || null, queryOwnershipFingerprint: currentQuery?.fingerprint || null }).evaluationFingerprint
      const authorizationExpiresAt = machineAuthorization?.authorizationExpiresAt?.getTime() || 0
      const valid = Boolean(
        currentPolicyRow && currentPolicyRow.status === 'enabled' && currentPolicyRow.configurationFingerprint === dependencies.autopilotPolicy.configurationFingerprint
        && Date.parse(dependencies.autopilotPolicy.expiresAt) > now.getTime()
        && currentProfile?.status === 'active' && currentProfile.profileFingerprint === machineAuthorization?.entityProfileFingerprint && currentProfile.evidenceSnapshotHash === entry.evidenceSnapshotHash
        && currentQuery?.status === 'active' && currentQuery.fingerprint === machineAuthorization?.queryOwnershipFingerprint && currentQuery.evidenceSnapshotHash === entry.evidenceSnapshotHash
        && machineAuthorization?.status === 'authorized' && authorizationExpiresAt > now.getTime()
        && machineAuthorization.ownerUserId === ownerUserId && machineAuthorization.clientId === lineage.client.id && machineAuthorization.websiteId === target.websiteId
        && machineAuthorization.entryId === entry.id && machineAuthorization.jobId === job.id && machineAuthorization.draftId === draft.id && machineAuthorization.publicationTargetId === target.id
        && machineAuthorization.targetId === target.targetId && machineAuthorization.contentHash === draft.contentHash && machineAuthorization.evidenceSnapshotHash === entry.evidenceSnapshotHash
        && machineAuthorization.policyId === dependencies.autopilotPolicy.policyId && machineAuthorization.policyFingerprint === dependencies.autopilotPolicy.configurationFingerprint
        && riskPayload.severity === (riskGate.riskLevel === 'high' ? 'high' : 'low') && riskPayload.businessClass === 'general' && riskPayload.fingerprint === machineAuthorization.riskFingerprint
        && machineAuthorization.qualityFingerprint === expectedQualityFingerprint
        && stableFingerprint(payloadBase) === machineAuthorization.authorizationFingerprint,
      )
      if (!valid) return { entryId: entry.id, entry, previousStatus: entry.status, resultingStatus: entry.status, runId: 0, stage: 'publication', outcome: 'blocked', retryAt: null, limitations: ['exact V4 machine authorization reload failed; executor was not called'] }
      authorityReference = machineAuthorization!.authorizationFingerprint
    } else {
      const autopilot = evaluateOwnerAutopilotPolicy({ policy: dependencies.autopilotPolicy, ownerUserId, clientId: lineage.client.id, targetRowId: target.id, targetId: target.targetId, targetStatus: target.status, targetExecutionEnabled: target.executionEnabled, entry, entryCadenceDays: lineage.calendar.cadenceDays, reviewDecision: latestReview?.decision || null, riskGateStatus: gate.status, riskLevel: safeString(riskGate.riskLevel), qualityGateVersion: safeString(riskGate.gateVersion), evidenceApproved, evidenceCapturedAt, providerExecution: provenance.providerExecution === true && providerProvenance.providerExecution === true, providerModel, providerProvenanceComplete: Boolean(providerModel && provenance.stage === 'optimized' && provenance.evidenceSnapshotHash === entry.evidenceSnapshotHash && providerProvenance.providerExecution === true), unsupportedFactualClaim, contentHashMatchesDraft: draft.contentHash === entry.contentHash, now })
      if (!autopilot.allowed) return { entryId: entry.id, entry, previousStatus: entry.status, resultingStatus: entry.status, runId: 0, stage: 'publication', outcome: 'blocked', retryAt: null, limitations: [...autopilot.reasons, `decisionCode=${autopilot.code}`] }
      authorityReference = `ref-autopilot-${dependencies.autopilotPolicy.policyId}`
    }
  }
  const rules = context.rules.map(rule => rule.id)
  const authoritySourceIds = context.evidenceSnapshot.refs.map(ref => ref.artifactId ? `artifact:${ref.artifactId}` : `source:${ref.sourceId}`).filter(Boolean)
  const identityInput = { clientId: lineage.client.id, entryId: entry.id, targetId: target.targetId, targetOrigin: target.targetOrigin, contentRoot: target.contentRoot, contentType: entry.contentType, language: entry.language, title: draft.title, ownerScopeKey: validatedTarget.ownerScopeKey }
  const persistedIdentity = hasPersistedIdentity ? { publicationId: `publication-${entry.id}`, slug: entry.publicationSlug!, path: entry.publicationPath!, identityFingerprint: entry.publicationIdentityFingerprint! } : null
  const identityResult = persistedIdentity ? validatePersistedPublicationIdentity({ ...identityInput, existingIdentity: persistedIdentity }) : buildPublicationIdentity(identityInput)
  if (!identityResult.ok) badRequest(`Publication identity is invalid: ${identityResult.reason}`)
  const identity = identityResult.identity
  if (hasPersistedIdentity && entry.publicationTargetId !== target.id) badRequest('Persisted publication identity is bound to a different target row.')
  const needsLineagePatch = !hasPersistedIdentity || entry.publicationAuthorityReference !== authorityReference || entry.publicationContentHash !== draft.contentHash
  const persistedEntry = needsLineagePatch ? await repository.transaction(async transaction => transaction.updateEntry(ownerUserId, entry.id, { publicationTargetId: target.id, publicationSlug: identity.slug, publicationPath: identity.path, publicationIdentityFingerprint: identity.identityFingerprint, publicationAuthorityReference: authorityReference, publicationContentHash: draft.contentHash })) : entry
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
  if (machineAuthorization) {
    const claimed = await repository.transitionMachineAuthorization(ownerUserId, machineAuthorization.authorizationFingerprint, 'authorized', 'executing', now)
    if (!claimed) {
      await repository.releaseRunLease(ownerUserId, leased.id, 'queued', token, now, { code: 'MACHINE_AUTH_ALREADY_CLAIMED', summary: 'Machine authorization was not claimable.' })
      return { entryId: entry.id, entry: persistedEntry, previousStatus: entry.status, resultingStatus: entry.status, runId: leased.id, stage: 'publication', outcome: 'replayed', retryAt: null, limitations: ['machine authorization CAS was not acquired; executor was not called'] }
    }
    const budgetFingerprint = stableFingerprint({ version: 'autopilot-budget-v1', kind: 'publication', authorizationFingerprint: machineAuthorization.authorizationFingerprint, entryId: entry.id, targetId: target.id })
    const budget = await repository.reserveAutopilotBudget({ ownerUserId, policyId: machineAuthorization.policyId, publicationTargetId: target.id, entryId: entry.id, kind: 'publication', units: 1, idempotencyKey: `publication:${machineAuthorization.authorizationFingerprint}`.slice(0, 160), inputFingerprint: budgetFingerprint })
    if (!budget.reserved) {
      await repository.transitionMachineAuthorization(ownerUserId, machineAuthorization.authorizationFingerprint, 'executing', 'revoked', now)
      await repository.releaseRunLease(ownerUserId, leased.id, 'blocked', token, now, { code: 'PUBLICATION_BUDGET_EXHAUSTED', summary: `Publication budget exhausted (${budget.used}/${budget.limit}).` })
      return { entryId: entry.id, entry: persistedEntry, previousStatus: entry.status, resultingStatus: entry.status, runId: leased.id, stage: 'publication', outcome: 'blocked', retryAt: null, limitations: ['publication budget exhausted; executor was not called'] }
    }
  }
  const publication = publicationFromLineage(ownerUserId, persistedEntry, lineage.calendar, target, job, draft, latestReview, rules, authoritySourceIds, identity, now, authorityReference || undefined)
  const mode = requestedMode
  let reservation: PublicationAttemptReservation | null = null
  const attemptNumber = mode === 'dry_run' ? Math.max(1, attempts.filter(attempt => attempt.mode === 'dry_run').reduce((max, attempt) => Math.max(max, attempt.attemptNumber), 0) + 1) : Math.max(1, stageRun.attemptNumber + 1)
  if (mode !== 'dry_run') {
    try {
      reservation = await repository.reservePublicationAttempt({ ownerUserId, clientId: lineage.client.id, entryId: entry.id, runId: leased.id, targetId: target.id, mode, attemptNumber, idempotencyKey: attemptKey, inputFingerprint: requestFingerprint, publicationId: identity.publicationId, publicationSlug: identity.slug, publicationPath: identity.path, contentHash: draft.contentHash, evidenceSnapshotHash: entry.evidenceSnapshotHash, startedAt: now, leaseToken: token, jobId: job.id, draftId: draft.id, reviewId: latestReview?.id || null, riskGateId: gate.id, authorityReference })
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
  const finalizePatch = (status: PublicationAttemptFinalization['status'], values: Partial<PublicationAttemptFinalization> = {}): PublicationAttemptFinalization => ({ status, artifactFingerprint: values.artifactFingerprint ?? null, remoteState: values.remoteState ?? null, receiptLedger: values.receiptLedger ?? null, remoteRevision: values.remoteRevision ?? null, receiptFingerprint: values.receiptFingerprint ?? null, publicationUrl: values.publicationUrl ?? null, errorCode: values.errorCode ?? null, errorSummary: values.errorSummary ?? null, completedAt: now })
  if (result.status === 'delivered') {
    const receiptFingerprint = stableFingerprint({ publicationId: result.publicationId, contentHash: result.contentHash, artifactFingerprint: result.artifactFingerprint, remoteState: result.remoteState, remoteRevision: result.remoteRevision })
    const delivered = await repository.transaction(async transaction => {
      const stored = await transaction.finalizePublicationAttempt(ownerUserId, reservation?.attempt.id || existingAttempt?.id || 0, finalizePatch('delivered', { artifactFingerprint: result.artifactFingerprint, remoteState: result.remoteState, remoteRevision: result.remoteRevision, receiptFingerprint }))
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
      if (machineAuthorization) {
        const published = await transaction.transitionMachineAuthorization(ownerUserId, machineAuthorization.authorizationFingerprint, 'executing', 'published', now)
        if (!published) badRequest('Machine authorization publication CAS failed.')
      }
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
    if (machineAuthorization) {
      const transitioned = await transaction.transitionMachineAuthorization(ownerUserId, machineAuthorization.authorizationFingerprint, 'executing', status === 'retryable_failure' ? 'authorized' : 'revoked', now)
      if (!transitioned) badRequest('Machine authorization failure CAS failed.')
    }
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
  const generationPolicies = [...new Map(Object.values(dependencies.autopilotPoliciesByTarget || {})
    .filter((policy): policy is OwnerAutopilotPolicy => Boolean(policy?.policyVersion === GOVERNED_AUTOPILOT_POLICY_V4_VERSION))
    .map(policy => [policy.policyId, policy])).values()]
  for (const policy of generationPolicies) {
    const inputFingerprint = stableFingerprint({ version: 'autopilot-budget-v1', kind: 'generation', policyId: policy.policyId, entryId: entry.id, draftId: null, evidenceSnapshotHash: entry.evidenceSnapshotHash })
    const budget = await repository.reserveAutopilotBudget({ ownerUserId, policyId: policy.policyId, publicationTargetId: policy.targetRowId, entryId: entry.id, kind: 'generation', units: 1, idempotencyKey: `generation:${entry.id}:${policy.policyId}`.slice(0, 160), inputFingerprint })
    if (!budget.reserved) {
      const blockedEntry = await repository.updateEntry(ownerUserId, entry.id, { status: 'blocked' })
      await repository.releaseRunLease(ownerUserId, leased.id, 'blocked', token, now, { code: 'GENERATION_BUDGET_EXHAUSTED', summary: `Generation budget exhausted (${budget.used}/${budget.limit}).` })
      return { entryId: entry.id, entry: blockedEntry, previousStatus: entry.status, resultingStatus: blockedEntry.status, runId: run.id, stage: 'generation', outcome: 'blocked', retryAt: null, limitations: ['generation budget exhausted; provider was not called'] }
    }
  }
  const productionRuntime = dependencies.productionRuntime || {}
  const runner = dependencies.productionDeliverableRunner || (async input => runOwnerProductionDeliverable(input))
  try {
    const calendar = await repository.findCalendar(ownerUserId, entry.calendarId)
    if (!calendar?.productionPlanId) badRequest('Generation requires a canonical calendar production plan.')
    const result = await runner({ ownerUserId, clientId: calendar.clientId, calendarEntryId: entry.id, planId: calendar.productionPlanId, deliverableId: entry.productionDeliverableId, now, dependencies: productionRuntime })
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
    return { entryId: entry.id, entry: failed.updated, previousStatus: entry.status, resultingStatus: failed.updated.status, runId: failed.completed.id, stage: 'generation', outcome: 'blocked', retryAt: null, limitations: ['generation exception was converted to a bounded blocked result', `error=${sanitizeErrorSummary(error)}`] }
  }
}

async function executeV4MachineReview(
  ownerUserId: number,
  entry: ContentOperationCalendarEntryRow,
  repository: ContentOperationsRepository,
  dependencies: ContentOperationOrchestratorDependencies,
  now: Date,
  expectedRunId?: number,
): Promise<ExecuteContentOperationResult> {
  if (!entry.jobId || !entry.draftId) badRequest('V4 machine review requires exact job and draft lineage.')
  const reviewRun = await ensureRun(repository, ownerUserId, entry, 'review_wait')
  if (expectedRunId !== undefined && reviewRun.id !== expectedRunId) badRequest('The expected V4 review run is stale.')
  const token = randomUUID()
  const leased = await repository.acquireRunLease(ownerUserId, reviewRun.id, token, now, leaseMsFor(dependencies.leaseMs))
  if (!leased) return { entryId: entry.id, entry, previousStatus: entry.status, resultingStatus: entry.status, runId: reviewRun.id, stage: 'review_wait', outcome: 'replayed', retryAt: reviewRun.retryEligibleAt, limitations: ['another worker owns the durable V4 review lease'] }
  try {
    const lineage = await repository.resolveWorkspaceEntry(ownerUserId, entry.id)
    if (!lineage?.client || !lineage.calendar || !lineage.job || !lineage.draft) badRequest('V4 machine review lineage is incomplete.')
    const bindings = await repository.listEntryTargetBindings(ownerUserId, entry.id)
    const rows = bindings.length
      ? await Promise.all(bindings.sort((left, right) => left.slot - right.slot).map(binding => repository.findPublicationTarget(ownerUserId, binding.targetId)))
      : [lineage.target || await repository.findActivePublicationTarget(ownerUserId, lineage.client.id)]
    const targets = rows.filter((row): row is ContentOperationPublicationTargetRow => Boolean(row))
    if (!targets.length || targets.some(target => target.status !== 'active' || !target.executionEnabled)) badRequest('V4 machine review requires active executable target identities.')
    const draft = lineage.draft as typeof lineage.draft & { title: string; body: string; provenance: unknown }
    const context = await repository.resolveCanonicalContext(ownerUserId, lineage.calendar.productionPlanId, entry.productionDeliverableId)
    if (context.evidenceSnapshot.hash !== entry.evidenceSnapshotHash || context.deliverable.id !== entry.productionDeliverableId || context.strategy.id !== entry.strategyRecommendationId) badRequest('V4 canonical context is stale.')
    const evidenceAuthority = canonicalEvidenceForAutopilot(context, entry.evidenceSnapshotHash, now)
    const gate = await repository.findRiskGate(ownerUserId, draft.id, entry.evidenceSnapshotHash) as Awaited<ReturnType<typeof repository.findRiskGate>> & { gateVersion?: string; findings?: unknown; riskLevel?: string }
    if (!gate || gate.status !== 'passed' || gate.evidenceSnapshotHash !== entry.evidenceSnapshotHash || draft.contentHash !== entry.contentHash) badRequest('V4 machine review requires the exact passed draft/risk/evidence tuple.')
    const provenance = readRecord(draft.provenance)
    const providerProvenance = readRecord(provenance.providerProvenance)
    const providerModel = safeString(provenance.providerModel) || safeString(provenance.model) || safeString(providerProvenance.model) || (safeString(provenance.provider) ? `${safeString(provenance.provider)}:${safeString(provenance.providerVersion) || 'unknown'}` : null)
    const findings = Array.isArray(gate.findings) ? gate.findings : []
    const unsupportedFactualClaim = findings.some(item => /unsupported|source_bound_claim|fabricated|performance|guarantee/iu.test(safeString(readRecord(item).id) || ''))
    for (const target of targets) {
      const policyRow = await repository.findAutopilotPolicy(ownerUserId, lineage.client.id, target.id)
      const policy = policyRow ? projectAutopilotPolicy(policyRow, target.targetId) : undefined
      if (!policy || policy.policyVersion !== GOVERNED_AUTOPILOT_POLICY_V4_VERSION || policy.status !== 'enabled') badRequest('Every V4 target requires a current enabled repository policy.')
      const balanced = await persistBalancedAutopilotDecision({ ownerUserId, entry, lineage, policy, target, draft, gate, evidenceAuthority, now, repository, providerModel, unsupportedFactualClaim })
      if (balanced.decision.action !== 'publish') badRequest(`V4 machine review did not authorize publication: ${balanced.decision.code}`)
    }
    const ready = await repository.transaction(async transaction => {
      const updated = await transaction.updateEntry(ownerUserId, entry.id, { status: 'ready_to_publish', reviewId: null })
      const completed = await transaction.releaseRunLease(ownerUserId, leased.id, 'succeeded', token, now)
      if (!completed) badRequest('V4 review lease could not be completed.')
      const publicationRun = await ensureRun(transaction, ownerUserId, updated, 'publication')
      await transaction.appendEvent(event(ownerUserId, entry, completed.id, 'v4_machine_review_authorized', entry.status, updated.status, { targetCount: targets.length, humanReviewId: null }, { entryId: entry.id, draftId: entry.draftId, event: 'v4_machine_review_authorized' }))
      return { updated, publicationRun }
    })
    return executePublication(ownerUserId, ready.updated, { trigger: 'scheduler', mode: 'execute', idempotencyKey: `scheduler:publication:${ready.publicationRun.id}:attempt:1` }, repository, dependencies, now, ready.publicationRun.id)
  } catch (error) {
    await repository.releaseRunLease(ownerUserId, leased.id, 'blocked', token, now, { code: 'V4_MACHINE_REVIEW_BLOCKED', summary: sanitizeErrorSummary(error) }).catch(() => null)
    return { entryId: entry.id, entry, previousStatus: entry.status, resultingStatus: entry.status, runId: reviewRun.id, stage: 'review_wait', outcome: 'blocked', retryAt: null, limitations: ['V4 machine review failed closed before publication', `error=${sanitizeErrorSummary(error)}`] }
  }
}

export async function createOwnerPublicationTarget(ownerUserId: number, clientId: number, value: unknown, repository?: ContentOperationsRepository) {
  const db = repository || createContentOperationsRepository()
  const input = parsePublicationTargetInput(value)
  const client = await db.findClient(ownerUserId, clientId)
  if (!client || client.status !== 'active') notFound('Content operation client was not found for this owner.')
  if (isFirstPartyTarget(input) && (input.framework !== client.framework || input.transport !== client.publicationTransport)) badRequest('First-party publication target framework/transport must match the owner client configuration.')
  const targetIdValue = targetId(ownerUserId, client.id, input.idempotencyKey)
  const websiteId = targetWebsiteId(ownerUserId, client.id, client.canonicalSiteOrigin)
  const capability = capabilityFor(input.framework as never, input.transport as never)
  if (!capability) badRequest('Publication target capability is not supported by the server matrix.')
  const baseTarget = { targetId: targetIdValue, ownerScopeKey: ownerScopeKey(ownerUserId), framework: input.framework, transport: input.transport, targetOrigin: input.targetOrigin, contentRoot: input.contentRoot, defaultBranch: input.defaultBranch ?? null, repositoryOwner: input.repositoryOwner ?? null, repositoryName: input.repositoryName ?? null, endpointPath: input.endpointPath ?? null, serviceReference: input.serviceReference ?? null, credentialReference: input.credentialReference, status: 'active' as const, allowedContentTypes: input.allowedContentTypes, allowedLanguages: input.allowedLanguages, maximumPayloadBytes: input.maximumPayloadBytes, executionEnabled: input.executionEnabled === true }
  let canonicalOrigin = input.targetOrigin
  let canonicalServiceReference = input.serviceReference ?? null
  if (isFirstPartyTarget(baseTarget)) {
    const validated = validateFirstPartyPublishTarget({ targetId: baseTarget.targetId, ownerScopeKey: baseTarget.ownerScopeKey, framework: baseTarget.framework, transport: baseTarget.transport, targetOrigin: baseTarget.targetOrigin, contentRoot: baseTarget.contentRoot, defaultBranch: input.transport === 'first_party_signed_api' ? 'main' : input.defaultBranch, repositoryOwner: baseTarget.repositoryOwner, repositoryName: baseTarget.repositoryName, endpointPath: baseTarget.endpointPath, credentialReference: baseTarget.credentialReference, status: baseTarget.status, allowedContentTypes: baseTarget.allowedContentTypes, allowedLanguages: baseTarget.allowedLanguages, maximumPayloadBytes: baseTarget.maximumPayloadBytes, executionEnabled: baseTarget.executionEnabled })
    if (validated.status === 'blocked') badRequest(`Publication target is invalid: ${validated.reasons.join('; ')}`)
    canonicalOrigin = validated.target.targetOrigin
    canonicalServiceReference = null
    baseTarget.allowedContentTypes = canonicalList(stringList(validated.target.allowedContentTypes))
    baseTarget.allowedLanguages = canonicalList(stringList(validated.target.allowedLanguages))
  } else {
    const routeTarget = { targetId: targetIdValue, siteIdentity: websiteId, framework: input.framework, transport: input.transport, targetUrl: input.transport === 'geoflow_local' ? null : input.targetOrigin, serviceReference: input.transport === 'geoflow_local' ? input.serviceReference ?? null : null, credentialReference: input.credentialReference, destinationPublicationIdentity: destinationIdentityFor(targetIdValue, input.targetOrigin, input.contentRoot) }
    const guarded = guardTarget(routeTarget as never)
    if (!guarded.valid) badRequest(`Publication target is invalid: ${guarded.reasonCodes.join('; ')}`)
    canonicalOrigin = guarded.normalizedUrl || input.targetOrigin
    canonicalServiceReference = guarded.normalizedServiceReference
  }
  const canonicalTargetInput: PublicationTargetInput = { ...input, targetOrigin: canonicalOrigin, serviceReference: canonicalServiceReference, allowedContentTypes: canonicalList(stringList(baseTarget.allowedContentTypes)), allowedLanguages: canonicalList(stringList(baseTarget.allowedLanguages)) }
  const fingerprint = targetConfigFingerprint(canonicalTargetInput)
  const existing = await db.findPublicationTargetByIdempotency(ownerUserId, input.idempotencyKey)
  if (existing) {
    if (existing.configurationFingerprint !== fingerprint || existing.clientId !== client.id) collision('Publication target idempotency key is associated with a different configuration.')
    return { target: redactedTarget(existing), replayed: true }
  }
  const existingTargets = await db.listPublicationTargets(ownerUserId)
  const slot = activeSlotFor(existingTargets.filter(candidate => candidate.clientId === client.id))
  const destinationPublicationIdentity = destinationIdentityFor(targetIdValue, canonicalOrigin, input.contentRoot)
  const row: PublicationTargetInsert = { ownerUserId, clientId: client.id, websiteId, targetId: targetIdValue, destinationPublicationIdentity, framework: input.framework, transport: input.transport, targetOrigin: canonicalOrigin, contentRoot: input.contentRoot, defaultBranch: input.transport === 'first_party_signed_api' ? null : input.defaultBranch ?? null, repositoryOwner: input.repositoryOwner ?? null, repositoryName: input.repositoryName ?? null, endpointPath: input.endpointPath ?? null, serviceReference: canonicalServiceReference, credentialReference: input.credentialReference, allowedContentTypes: canonicalList(stringList(baseTarget.allowedContentTypes)), allowedLanguages: canonicalList(stringList(baseTarget.allowedLanguages)), maximumPayloadBytes: input.maximumPayloadBytes, status: 'active', activeSlot: slot, executionEnabled: input.executionEnabled === true, configurationFingerprint: fingerprint, provenance: { source: 'owner_configured_target', capabilityMatrix: 'publication-routing-v2', executor: capability.executor, authority: capability.authority, projection: capability.projection, websiteId, targetId: targetIdValue }, idempotencyKey: input.idempotencyKey, revokedAt: null }
  try {
    const stored = await db.transaction(async transaction => transaction.insertPublicationTarget(row))
    return { target: redactedTarget(stored), replayed: false }
  } catch (error) {
    const statusCode = typeof error === 'object' && error !== null && 'statusCode' in error ? Number((error as { statusCode?: unknown }).statusCode) : 0
    const code = typeof error === 'object' && error !== null && 'code' in error ? String((error as { code?: unknown }).code) : ''
    if (statusCode === 409 || code === 'ER_DUP_ENTRY' || /duplicate|unique|active slot/i.test(error instanceof Error ? error.message : '')) collision('Publication target idempotency or active slot conflicts with an existing owner target.')
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
  const requestedStatus = patch.status ?? existing.status
  const existingTargets = await db.listPublicationTargets(ownerUserId)
  const activeSlot = requestedStatus === 'active' ? existing.activeSlot ?? activeSlotFor(existingTargets.filter(candidate => candidate.clientId === existing.clientId && candidate.id !== existing.id)) : null
  const next = { ...existing, targetOrigin: patch.targetOrigin ?? existing.targetOrigin, serviceReference: patch.serviceReference === undefined ? existing.serviceReference ?? null : patch.serviceReference, contentRoot: patch.contentRoot ?? existing.contentRoot, defaultBranch: patch.defaultBranch ?? existing.defaultBranch, repositoryOwner: patch.repositoryOwner === undefined ? existing.repositoryOwner : patch.repositoryOwner, repositoryName: patch.repositoryName === undefined ? existing.repositoryName : patch.repositoryName, endpointPath: patch.endpointPath === undefined ? existing.endpointPath : patch.endpointPath, credentialReference: patch.credentialReference ?? existing.credentialReference, allowedContentTypes: patch.allowedContentTypes ?? existing.allowedContentTypes, allowedLanguages: patch.allowedLanguages ?? existing.allowedLanguages, maximumPayloadBytes: patch.maximumPayloadBytes ?? existing.maximumPayloadBytes, executionEnabled: patch.executionEnabled ?? existing.executionEnabled, status: requestedStatus, activeSlot, revokedAt: requestedStatus === 'revoked' ? existing.revokedAt || new Date() : null }
  if (next.executionEnabled && !next.credentialReference) badRequest('Execution requires a server-side credential reference.')
  let canonicalOrigin = next.targetOrigin
  let canonicalServiceReference = next.serviceReference || null
  if (isFirstPartyTarget(next)) {
    const validated = validateFirstPartyPublishTarget({ ...targetForPublisher(next, ownerUserId), status: 'active' })
    if (validated.status === 'blocked') badRequest(`Publication target is invalid: ${validated.reasons.join('; ')}`)
    canonicalOrigin = validated.target.targetOrigin
    canonicalServiceReference = null
    next.allowedContentTypes = canonicalList(stringList(validated.target.allowedContentTypes))
    next.allowedLanguages = canonicalList(stringList(validated.target.allowedLanguages))
  } else {
    const routeTarget = { targetId: next.targetId, siteIdentity: next.websiteId || targetWebsiteId(ownerUserId, next.clientId, client.canonicalSiteOrigin), framework: next.framework, transport: next.transport, targetUrl: next.transport === 'geoflow_local' ? null : next.targetOrigin, serviceReference: next.transport === 'geoflow_local' ? next.serviceReference || null : null, credentialReference: next.credentialReference, destinationPublicationIdentity: next.destinationPublicationIdentity || destinationIdentityFor(next.targetId, next.targetOrigin, next.contentRoot) }
    const guarded = guardTarget(routeTarget as never)
    if (!guarded.valid) badRequest(`Publication target is invalid: ${guarded.reasonCodes.join('; ')}`)
    canonicalOrigin = guarded.normalizedUrl || next.targetOrigin
    canonicalServiceReference = guarded.normalizedServiceReference
  }
  const canonicalTargetInput: PublicationTargetInput = { idempotencyKey: existing.idempotencyKey, framework: next.framework as PublicationTargetInput['framework'], transport: next.transport as PublicationTargetInput['transport'], targetOrigin: canonicalOrigin, serviceReference: canonicalServiceReference, contentRoot: next.contentRoot, defaultBranch: next.defaultBranch, repositoryOwner: next.repositoryOwner, repositoryName: next.repositoryName, endpointPath: next.endpointPath, credentialReference: next.credentialReference, allowedContentTypes: canonicalList(stringList(next.allowedContentTypes)), allowedLanguages: canonicalList(stringList(next.allowedLanguages)), maximumPayloadBytes: next.maximumPayloadBytes, executionEnabled: next.executionEnabled }
  const configurationFingerprint = targetConfigFingerprint(canonicalTargetInput)
  const provenance = { source: 'owner_configured_target', capabilityMatrix: 'publication-routing-v2', executor: capabilityFor(next.framework as never, next.transport as never)?.executor || null, authority: capabilityFor(next.framework as never, next.transport as never)?.authority || null, projection: capabilityFor(next.framework as never, next.transport as never)?.projection || null, websiteId: next.websiteId || targetWebsiteId(ownerUserId, next.clientId, client.canonicalSiteOrigin), targetId: next.targetId }
  const stored = await db.transaction(async transaction => transaction.updatePublicationTarget(ownerUserId, existing.id, { targetOrigin: canonicalOrigin, serviceReference: canonicalServiceReference, destinationPublicationIdentity: next.destinationPublicationIdentity || destinationIdentityFor(next.targetId, canonicalOrigin, next.contentRoot), contentRoot: next.contentRoot, defaultBranch: next.defaultBranch, repositoryOwner: next.repositoryOwner, repositoryName: next.repositoryName, endpointPath: next.endpointPath, credentialReference: next.credentialReference, allowedContentTypes: canonicalList(stringList(next.allowedContentTypes)), allowedLanguages: canonicalList(stringList(next.allowedLanguages)), maximumPayloadBytes: next.maximumPayloadBytes, status: next.status, activeSlot: next.activeSlot, executionEnabled: next.executionEnabled, configurationFingerprint, provenance, revokedAt: next.revokedAt }))
  return { target: redactedTarget(stored), replayed: false }
}

export async function bindOwnerEntryPublicationTargets(ownerUserId: number, entryId: number, value: unknown, repository?: ContentOperationsRepository) {
  const db = repository || createContentOperationsRepository()
  const parsed = parseEntryPublicationTargetsInput(value)
  const entry = await db.findEntry(ownerUserId, entryId)
  if (!entry) notFound('Content operation calendar entry was not found for this owner.')
  if (!['planned', 'materialized', 'awaiting_generation'].includes(entry.status)) collision('Publication target bindings are immutable after generation or review begins.')
  const calendar = await db.findCalendar(ownerUserId, entry.calendarId)
  if (!calendar || calendar.ownerUserId !== ownerUserId) notFound('Content operation calendar was not found for this owner.')
  const existing = await db.listEntryTargetBindings(ownerUserId, entry.id)
  if (existing.length) {
    const same = existing.length === parsed.targetRowIds.length && existing.every((binding, index) => binding.targetId === parsed.targetRowIds[index] && binding.slot === index + 1)
    if (same) return { bindings: existing, replayed: true }
    collision('This entry already has a different immutable publication target binding.')
  }
  const targets: ContentOperationPublicationTargetRow[] = []
  for (const targetRowId of parsed.targetRowIds) {
    const target = await db.findPublicationTarget(ownerUserId, targetRowId)
    if (!target || target.ownerUserId !== ownerUserId || target.clientId !== calendar.clientId || target.status !== 'active' || target.activeSlot === null || target.activeSlot === undefined) notFound('Every entry publication target must be an active target owned by the same client.')
    routeTargetForExecution(target, ownerUserId)
    targets.push(target)
  }
  const bindings = await db.transaction(async transaction => {
    const stored = []
    for (const [index, target] of targets.entries()) {
      stored.push(await transaction.insertEntryTargetBinding({ ownerUserId, clientId: calendar.clientId, entryId: entry.id, targetId: target.id, slot: index + 1, bindingFingerprint: stableFingerprint({ ownerUserId, clientId: calendar.clientId, entryId: entry.id, targetId: target.id, targetConfigurationFingerprint: target.configurationFingerprint, slot: index + 1 }) }))
    }
    const updated = await transaction.updateEntry(ownerUserId, entry.id, { publicationTargetId: targets[0]?.id || null, publicationTargetCount: stored.length })
    await transaction.appendEvent(event(ownerUserId, updated, null, 'publication_targets_bound', entry.status, updated.status, { targetCount: stored.length, targetIds: targets.map(target => target.targetId), websiteId: targets[0]?.websiteId || null, providerExecution: false }, { entryId: entry.id, event: 'publication_targets_bound', bindingFingerprints: stored.map(binding => binding.bindingFingerprint) }))
    return { stored, updated }
  })
  return { bindings: bindings.stored, replayed: false }
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
    const v4Policies = Object.values(dependencies.autopilotPoliciesByTarget || {}).filter((policy): policy is OwnerAutopilotPolicy => Boolean(policy && policy.policyVersion === GOVERNED_AUTOPILOT_POLICY_V4_VERSION))
    if (input.trigger === 'scheduler' && (dependencies.autopilotPolicy?.policyVersion === GOVERNED_AUTOPILOT_POLICY_V4_VERSION || v4Policies.length > 0)) return executeV4MachineReview(input.ownerUserId, entry, repository, dependencies, now, input.expectedRunId)
    const synchronized = await synchronizeReview(input.ownerUserId, entry, repository, now, leaseMsFor(dependencies.leaseMs), input.expectedRunId)
    if (synchronized.outcome === 'awaiting_review' || synchronized.outcome === 'blocked') return { entryId: entry.id, previousStatus: entry.status, resultingStatus: synchronized.entry.status, runId: synchronized.run.id, stage: 'review_wait', outcome: synchronized.outcome, retryAt: synchronized.run.retryEligibleAt, limitations: synchronized.outcome === 'awaiting_review' ? ['no automatic human approval was created; waiting for the owner review'] : ['review decision blocked publication'] }
    if (synchronized.outcome === 'ready_to_publish') return { entryId: entry.id, previousStatus: entry.status, resultingStatus: synchronized.entry.status, runId: synchronized.run.id, stage: 'review_wait', outcome: 'ready_to_publish', retryAt: null, limitations: ['owner approval is synchronized; publication requires a separate explicit execute request'] }
    entry = synchronized.entry
  }
  if (entry.status === 'ready_to_publish' || entry.status === 'publishing') return executePublication(input.ownerUserId, entry, { ...parsed, trigger: input.trigger }, repository, dependencies, now, input.expectedRunId)
  return { entryId: entry.id, previousStatus: entry.status, resultingStatus: entry.status, runId: 0, stage: 'publication', outcome: 'blocked', retryAt: null, limitations: ['entry is not executable from its current durable status'] }
}

async function persistBalancedAutopilotDecision(input: { ownerUserId: number; entry: ContentOperationCalendarEntryRow; lineage: Awaited<ReturnType<ContentOperationsRepository['resolveWorkspaceEntry']>>; policy: OwnerAutopilotPolicy; target: ContentOperationPublicationTargetRow; draft: { id: number; title: string; body: string; contentHash: string; provenance?: unknown }; gate: { status: string; evidenceSnapshotHash?: string; riskLevel?: string; gateVersion?: string; findings?: unknown } | null; evidenceAuthority: { evidenceApproved: boolean; evidenceCapturedAt: string | null }; now: Date; repository: ContentOperationsRepository; providerModel: string | null; unsupportedFactualClaim: boolean }): Promise<{ decision: ReturnType<typeof decideBalancedAutopilot>; repairContract?: ReturnType<typeof buildRepairContract> }> {
  if (!input.lineage?.client || !input.lineage.calendar || !input.lineage.entry) throw new Error('balanced autopilot lineage is incomplete')
  const repairs = await input.repository.listRepairAttempts(input.ownerUserId, input.entry.id)
  const substitutions = await input.repository.listTopicSubstitutions(input.ownerUserId, input.entry.id)
  const profileRow = await input.repository.findEntityStrategyProfile(input.ownerUserId, input.lineage.client.id, input.policy.websiteId, input.policy.entityStrategyProfileId)
  const ownershipRow = await input.repository.findQueryOwnership(input.ownerUserId, input.lineage.client.id, input.policy.websiteId, input.entry.topicCluster)
  const findings = Array.isArray(input.gate?.findings) ? input.gate?.findings : []
  const reasonCodes = [...new Set(findings.map(item => safeString(readRecord(item).id)).filter(Boolean).map(value => String(value).replace(/[^A-Za-z0-9]+/gu, '_').toUpperCase()).filter(Boolean))]
  if (input.unsupportedFactualClaim) reasonCodes.push('UNSUPPORTED_FACTUAL_CLAIM')
  const qualityEvaluation = evaluateCanonicalGeoContentQuality({ content: input.draft.body, contentHash: input.draft.contentHash, evidenceSnapshotHash: input.entry.evidenceSnapshotHash, riskGateStatus: input.gate?.status || null, riskGateVersion: input.gate?.gateVersion || null, riskFindings: findings, entityProfileFingerprint: profileRow?.profileFingerprint || (input.policy.policyVersion === 'governed-autopilot-policy-v3' ? 'legacy-v3' : null), queryOwnershipFingerprint: ownershipRow?.fingerprint || (input.policy.policyVersion === 'governed-autopilot-policy-v3' ? 'legacy-v3' : null) })
  reasonCodes.push(...qualityEvaluation.reasonCodes)
  const riskClass = input.gate?.riskLevel === 'low' || input.gate?.riskLevel === 'high' ? input.gate.riskLevel : 'general'
  const riskSeverity = input.gate?.riskLevel === 'high' ? 'high' as const : input.gate?.riskLevel === 'general' ? 'moderate' as const : 'low' as const
  const businessRiskClass = reasonCodes.some(code => /MEDICAL/u.test(code)) ? 'medical' as const : reasonCodes.some(code => /LEGAL/u.test(code)) ? 'legal' as const : reasonCodes.some(code => /FINANC|INVEST/u.test(code)) ? 'financial' as const : 'general' as const
  const policySnapshot = balancedPolicySnapshot(input.policy)
  const draftProvenance = readRecord(input.draft.provenance)
  const repairedChildLineageVerified = Boolean(input.draft.id > 0 && input.gate) || Boolean(safeString(draftProvenance.evidenceSnapshotHash) === input.entry.evidenceSnapshotHash && Number(draftProvenance.parentDraftId) > 0 && Number(draftProvenance.repairAttempt) > 0)
  const decision = decideBalancedAutopilot({
    policy: policySnapshot,
    candidateId: `entry-${input.entry.id}:draft-${input.draft.id}`,
    contentType: input.entry.contentType,
    locale: input.entry.language,
    destinationId: input.target.targetId,
    cadenceDays: input.lineage.calendar.cadenceDays,
    riskClass,
    riskSeverity,
    businessRiskClass,
    qualityStatus: qualityEvaluation.status,
    reasonCodes,
    contentHash: input.draft.contentHash,
    evidenceSnapshotHash: input.entry.evidenceSnapshotHash,
    evidenceStatus: input.evidenceAuthority.evidenceApproved && input.evidenceAuthority.evidenceCapturedAt ? 'approved_fresh' : 'missing',
    providerProvenanceComplete: Boolean(input.providerModel && safeString(readRecord(input.draft.provenance).stage) === 'optimized' && Boolean(readRecord(input.draft.provenance).evidenceSnapshotHash) && readRecord(input.draft.provenance).evidenceSnapshotHash === input.entry.evidenceSnapshotHash && readRecord(readRecord(input.draft.provenance).providerProvenance).providerExecution === true),
    targetIdentityVerified: input.target.status === 'active' && input.target.executionEnabled === true,
    lineageVerified: input.lineage.calendar.productionPlanId > 0 && (input.draft.contentHash === input.entry.contentHash || repairedChildLineageVerified),
    repairAttempts: repairs.length,
    topicSubstitutions: substitutions.length,
    candidateSafeTopics: [input.lineage.deliverable.title, input.entry.topicCluster].filter((value): value is string => Boolean(value)),
    entityProfile: balancedEntityProfile(profileRow),
    queryOwnership: balancedQueryOwnership(ownershipRow),
    contentText: input.draft.body,
    primaryQuery: input.entry.topicCluster,
    now: input.now,
  })
  if (decision.action === 'repair') {
    const qualityMetrics: Record<string, number | string | null> = Object.fromEntries(Object.entries(qualityEvaluation.metrics).map(([key, value]) => [key, typeof value === 'boolean' ? Number(value) : value]))
    const repairContract = buildRepairContract({ originalDraftId: String(input.draft.id), originalContentHash: input.draft.contentHash, repairAttempt: repairs.length + 1, reasonCodes: decision.reasons, failingMetrics: qualityMetrics, evidenceDeficiencies: qualityEvaluation.reasonCodes.filter(code => /EVIDENCE/u.test(code)), entityCoverageDeficiencies: qualityEvaluation.reasonCodes.filter(code => /ENTITY|QUERY/u.test(code)), requestedRepairs: decision.repairInstructions, providerModel: input.providerModel, candidateId: `entry-${input.entry.id}:draft-${input.draft.id}`, evidenceSnapshotHash: input.entry.evidenceSnapshotHash, createdAt: input.now.toISOString() })
    await input.repository.insertRepairAttempt({ ownerUserId: input.ownerUserId, clientId: input.lineage.client.id, websiteId: input.policy.websiteId, entryId: input.entry.id, originalDraftId: String(input.draft.id), originalContentHash: input.draft.contentHash, repairAttempt: repairs.length + 1, reasonCodes: repairContract.reasonCodes, failingMetrics: repairContract.failingMetrics, evidenceDeficiencies: repairContract.evidenceDeficiencies, entityCoverageDeficiencies: repairContract.entityCoverageDeficiencies, prohibitedClaimLocations: repairContract.prohibitedClaimLocations, citationDeficiencies: repairContract.citationDeficiencies, keywordStuffingLocations: repairContract.keywordStuffingLocations, internalLinkDeficiencies: repairContract.internalLinkDeficiencies, requestedRepairs: repairContract.requestedRepairs, providerModel: repairContract.providerModel, repairedDraftId: null, repairedContentHash: null, parentLineage: repairContract.parentLineage, repairFingerprint: repairContract.repairFingerprint, status: 'planned', leaseOwner: null, leaseExpiresAt: null })
    await input.repository.appendEvent({ ownerUserId: input.ownerUserId, clientId: input.lineage.client.id, calendarId: input.entry.calendarId, entryId: input.entry.id, runId: null, eventType: 'autopilot_repair_planned', fromStatus: input.entry.status, toStatus: input.entry.status, eventFingerprint: stableFingerprint({ entryId: input.entry.id, event: 'autopilot_repair_planned', repairFingerprint: repairContract.repairFingerprint }), metadata: { decisionCode: decision.code, decisionFingerprint: decision.decisionFingerprint, repairContract } })
    return { decision, repairContract }
  }
  if (decision.action === 'substitute' && decision.nextTopic) {
    if (decision.nextTopic.normalize('NFKC').trim().toLowerCase() === input.entry.topicCluster.normalize('NFKC').trim().toLowerCase()) throw new Error('Topic substitution cannot select the original topic.')
    const substitutionFingerprint = stableFingerprint({ entryId: input.entry.id, originalTopic: input.entry.topicCluster, substitutedTopic: decision.nextTopic, reasons: decision.reasons, attempt: substitutions.length + 1 })
    const replacement = await input.repository.transaction(async transaction => {
      const existing = (await transaction.listEntries(input.ownerUserId, input.entry.calendarId)).find(row => row.replacementFingerprint === substitutionFingerprint)
      let replacementEntry = existing
      if (!replacementEntry) {
        const { id: _id, createdAt: _createdAt, updatedAt: _updatedAt, ...base } = input.entry
        replacementEntry = await transaction.insertEntry({ ...base, jobId: null, draftId: null, reviewId: null, contentHash: null, publicationContentHash: null, publicationTargetId: null, publicationSlug: null, publicationPath: null, publicationIdentityFingerprint: null, publicationRoutingPlanId: null, publicationAuthorityReference: null, publicationTargetCount: 0, topicCluster: decision.nextTopic!, status: 'materialized', engineEntryId: `replacement-${substitutionFingerprint.slice(0, 48)}`, idempotencyKey: `replacement:${substitutionFingerprint}`.slice(0, 128), replacementOfEntryId: input.entry.id, replacementFingerprint: substitutionFingerprint })
        const bindings = await transaction.listEntryTargetBindings(input.ownerUserId, input.entry.id)
        for (const binding of bindings) await transaction.insertEntryTargetBinding({ ownerUserId: binding.ownerUserId, clientId: binding.clientId, entryId: replacementEntry.id, targetId: binding.targetId, slot: binding.slot, bindingFingerprint: stableFingerprint({ replacementFingerprint: substitutionFingerprint, targetId: binding.targetId, slot: binding.slot }) })
      }
      const generationRun = await ensureRun(transaction, input.ownerUserId, replacementEntry, 'generation')
      await transaction.insertTopicSubstitution({ ownerUserId: input.ownerUserId, clientId: input.lineage!.client!.id, websiteId: input.policy.websiteId, entryId: input.entry.id, substitutionAttempt: substitutions.length + 1, originalTopic: input.entry.topicCluster, substitutedTopic: decision.nextTopic!, reasonCodes: decision.reasons, lineage: { policyId: input.policy.policyId, policyVersion: input.policy.policyVersion, evidenceSnapshotHash: input.entry.evidenceSnapshotHash, decisionFingerprint: decision.decisionFingerprint, replacementEntryId: replacementEntry.id, replacementRunId: generationRun.id, replacementFingerprint: substitutionFingerprint }, substitutionFingerprint, status: 'applied' })
      return { replacementEntry, generationRun }
    })
    await input.repository.appendEvent({ ownerUserId: input.ownerUserId, clientId: input.lineage.client.id, calendarId: input.entry.calendarId, entryId: input.entry.id, runId: replacement.generationRun.id, eventType: 'autopilot_topic_substituted', fromStatus: input.entry.status, toStatus: input.entry.status, eventFingerprint: stableFingerprint({ entryId: input.entry.id, event: 'autopilot_topic_substituted', substitutionFingerprint }), metadata: { decisionCode: decision.code, decisionFingerprint: decision.decisionFingerprint, originalTopic: input.entry.topicCluster, substitutedTopic: decision.nextTopic, replacementEntryId: replacement.replacementEntry.id, replacementRunId: replacement.generationRun.id } })
  }
  if (decision.action === 'publish') {
    if (input.policy.policyVersion === GOVERNED_AUTOPILOT_POLICY_V4_VERSION && (!profileRow || !ownershipRow || profileRow.evidenceSnapshotHash !== input.entry.evidenceSnapshotHash || ownershipRow.evidenceSnapshotHash !== input.entry.evidenceSnapshotHash)) throw new Error('V4 machine authorization requires exact active profile/query evidence lineage.')
    const qualityFingerprint = qualityEvaluation.evaluationFingerprint
    const authorization = buildMachineAuthorization({ decision, policy: policySnapshot, candidateId: `entry-${input.entry.id}:draft-${input.draft.id}`, contentHash: input.draft.contentHash, contentType: input.entry.contentType, locale: input.entry.language, evidenceSnapshotHash: input.entry.evidenceSnapshotHash, evidenceCapturedAt: input.evidenceAuthority.evidenceCapturedAt || input.now.toISOString(), riskClass, riskSeverity, businessRiskClass, riskReasonCodes: decision.reasons, qualityFingerprint, entryId: input.entry.id, jobId: Number(input.lineage.job?.id), draftId: String(input.draft.id), entityProfileFingerprint: profileRow?.profileFingerprint || 'legacy-v3', queryOwnershipFingerprint: ownershipRow?.fingerprint || 'legacy-v3', providerModel: input.providerModel || 'unknown', repairAttempts: repairs.length, substitutionCount: substitutions.length, targetRowId: input.target.id, destinationId: input.target.targetId, now: input.now.toISOString() })
    await input.repository.insertMachineAuthorization({ authorizationId: authorization.authorizationId, ownerUserId: input.ownerUserId, clientId: input.lineage.client.id, websiteId: input.policy.websiteId, entryId: input.entry.id, jobId: Number(input.lineage.job?.id), draftId: input.draft.id, publicationTargetId: input.target.id, policyId: authorization.policy.policyId, policyVersion: authorization.policy.policyVersion, policyFingerprint: authorization.policy.configurationFingerprint, candidateId: authorization.candidate.candidateId, contentHash: authorization.candidate.contentHash, evidenceSnapshotHash: authorization.evidence.snapshotHash, entityProfileFingerprint: authorization.lineage.entityProfileFingerprint, queryOwnershipFingerprint: authorization.lineage.queryOwnershipFingerprint, riskClass: authorization.risk.businessClass, riskFingerprint: authorization.risk.fingerprint, qualityStatus: authorization.quality.status, qualityFingerprint: authorization.quality.fingerprint, targetId: authorization.target.destinationId, authorizationPayload: authorization, authorizationFingerprint: authorization.authorizationFingerprint, status: 'authorized', decidedAt: input.now, authorizationExpiresAt: new Date(Math.min(Date.parse(input.policy.expiresAt), input.now.getTime() + 15 * 60 * 1000)), claimedAt: null, revokedAt: null })
    await input.repository.appendEvent({ ownerUserId: input.ownerUserId, clientId: input.lineage.client.id, calendarId: input.entry.calendarId, entryId: input.entry.id, runId: null, eventType: 'autopilot_machine_authorized', fromStatus: input.entry.status, toStatus: input.entry.status, eventFingerprint: stableFingerprint({ entryId: input.entry.id, event: 'autopilot_machine_authorized', authorizationFingerprint: authorization.authorizationFingerprint }), metadata: { authorizationId: authorization.authorizationId, authorizationFingerprint: authorization.authorizationFingerprint, decisionFingerprint: decision.decisionFingerprint, policyId: input.policy.policyId, policyVersion: input.policy.policyVersion, humanReviewId: null } })
  }
  return { decision }
}

export type OwnerContentEntryWorkflowDependencies = ContentOperationOrchestratorDependencies & {
  reviewService?: (input: { ownerUserId: number; entryId: number; jobId: number; draftId: number; decision: 'approved_for_delivery' | 'changes_requested' | 'rejected'; reviewNote?: string }) => Promise<unknown>
}

export async function runOwnerContentEntryWorkflow(input: { ownerUserId: number; entryId: number; mode?: 'dry_run' | 'execute'; idempotencyKey: string; now?: Date; reviewDecision?: 'approved_for_delivery' | 'changes_requested' | 'rejected'; dependencies?: OwnerContentEntryWorkflowDependencies }): Promise<ExecuteContentOperationResult> {
  const dependencies = input.dependencies || {}
  const repository = dependencies.repository || createContentOperationsRepository()
  const now = input.now || (dependencies.clock || getDefaultContentOperationsClock()).now()
  const mode = input.mode || 'dry_run'
  let result = await executeContentOperationEntry({ ownerUserId: input.ownerUserId, entryId: input.entryId, trigger: 'owner_manual', now, value: { idempotencyKey: `${input.idempotencyKey}:generation`.slice(0, 128), mode: 'dry_run' }, dependencies: { ...dependencies, repository } })
  if (result.outcome !== 'awaiting_review') return result
  const current = await repository.findEntry(input.ownerUserId, input.entryId)
  if (!current || !current.jobId || !current.draftId) badRequest('Application workflow generation did not persist a complete job/draft lineage.')
  if (dependencies.autopilotPolicy) {
    let balancedPass = 0
    while (balancedPass <= dependencies.autopilotPolicy.maximumRepairAttempts) {
      const live = await repository.findEntry(input.ownerUserId, input.entryId)
      if (!live || !live.jobId || !live.draftId) badRequest('Balanced autopilot requires a current owner-scoped job and draft lineage.')
      const lineage = await repository.resolveWorkspaceEntry(input.ownerUserId, input.entryId)
      const targetBindings = await repository.listEntryTargetBindings(input.ownerUserId, input.entryId)
      const boundTargets = targetBindings.length ? await Promise.all(targetBindings.sort((left, right) => left.slot - right.slot).map(binding => repository.findPublicationTarget(input.ownerUserId, binding.targetId))) : []
      const targets = boundTargets.filter((target): target is ContentOperationPublicationTargetRow => Boolean(target))
      const target = targets[0] || lineage?.target || await repository.findActivePublicationTarget(input.ownerUserId, lineage?.client?.id || 0)
      if (!lineage || !lineage.client || !lineage.job || !lineage.draft || !target) badRequest('Governed autopilot workflow lineage or target is incomplete.')
      const evaluationTargets = targets.length ? targets : [target]
      const draft = lineage.draft as typeof lineage.draft & { title: string; body: string; provenance: unknown }
      const context = await repository.resolveCanonicalContext(input.ownerUserId, lineage.calendar.productionPlanId, live.productionDeliverableId)
      if (context.plan.id !== lineage.calendar.productionPlanId || context.deliverable.id !== live.productionDeliverableId || context.strategy.id !== live.strategyRecommendationId || context.evidenceSnapshot.hash !== live.evidenceSnapshotHash) badRequest('Governed autopilot promotion requires a current canonical production context.')
      const evidenceAuthority = canonicalEvidenceForAutopilot(context, live.evidenceSnapshotHash, now)
      const gate = await repository.findRiskGate(input.ownerUserId, draft.id, live.evidenceSnapshotHash)
      const riskGate = gate as typeof gate & { gateVersion?: string; findings?: unknown; riskLevel?: string }
      const provenance = readRecord(draft.provenance)
      const providerProvenance = readRecord(provenance.providerProvenance)
      const providerModel = safeString(provenance.providerModel) || safeString(provenance.model) || safeString(providerProvenance.model) || (safeString(provenance.provider) ? `${safeString(provenance.provider)}:${safeString(provenance.providerVersion) || 'unknown'}` : null)
      const findings = Array.isArray(riskGate?.findings) ? riskGate.findings : []
      const unsupportedFactualClaim = findings.some(item => /unsupported|source_bound_claim|fabricated|performance|guarantee/iu.test(safeString(readRecord(item).id) || ''))
      const prospectiveEntry = { ...live, status: 'ready_to_publish' as const }
      for (const candidateTarget of evaluationTargets) {
        const targetPolicy = dependencies.autopilotPoliciesByTarget?.[candidateTarget.id] || dependencies.autopilotPolicy
        if (targetPolicy && !targetPolicy.mode) {
          const evaluation = evaluateOwnerAutopilotPolicy({ policy: targetPolicy, ownerUserId: input.ownerUserId, clientId: lineage.client.id, targetRowId: candidateTarget.id, targetId: candidateTarget.targetId, targetStatus: candidateTarget.status, targetExecutionEnabled: candidateTarget.executionEnabled, entry: prospectiveEntry, entryCadenceDays: lineage.calendar.cadenceDays, reviewDecision: null, riskGateStatus: gate?.status || null, riskLevel: safeString(riskGate?.riskLevel), qualityGateVersion: safeString(riskGate?.gateVersion), evidenceApproved: evidenceAuthority.evidenceApproved, evidenceCapturedAt: evidenceAuthority.evidenceCapturedAt, providerExecution: provenance.providerExecution === true && providerProvenance.providerExecution === true, providerModel, providerProvenanceComplete: Boolean(providerModel && provenance.stage === 'optimized' && provenance.evidenceSnapshotHash === live.evidenceSnapshotHash && providerProvenance.providerExecution === true), unsupportedFactualClaim, contentHashMatchesDraft: draft.contentHash === live.contentHash, now })
          if (!evaluation.allowed) return { ...result, outcome: 'blocked', limitations: [...evaluation.reasons, `decisionCode=${evaluation.code}`, 'legacy governed autopilot did not promote the entry; no review or executor call was created'] }
        }
      }
      const balanced = await persistBalancedAutopilotDecision({ ownerUserId: input.ownerUserId, entry: live, lineage, policy: dependencies.autopilotPolicy, target, draft, gate: riskGate, evidenceAuthority, now, repository, providerModel, unsupportedFactualClaim })
      if (balanced.decision.action === 'repair' && balanced.repairContract) {
        const repairLeaseOwner = randomUUID()
        const claimedRepair = await repository.claimRepairAttempt(input.ownerUserId, balanced.repairContract.repairFingerprint, repairLeaseOwner, now, new Date(now.getTime() + leaseMsFor(dependencies.leaseMs)))
        if (!claimedRepair) return { ...result, outcome: 'replayed', limitations: ['another worker owns the durable repair lease; repair provider was not called'] }
        const repairRunner = dependencies.repairRunner || (async repairInput => runOwnerProductionRepair({ ...repairInput, dependencies: dependencies.productionRuntime }))
        try {
          await repairRunner({ ownerUserId: input.ownerUserId, planId: lineage.calendar.productionPlanId, deliverableId: live.productionDeliverableId, jobId: live.jobId, originalDraft: { id: draft.id, title: draft.title, body: draft.body, contentHash: draft.contentHash, provenance: draft.provenance }, repairInstructions: balanced.decision.repairInstructions, repairAttempt: balanced.repairContract.repairAttempt, repairContractFingerprint: balanced.repairContract.repairFingerprint, now, dependencies: dependencies.productionRuntime })
          const repairedDraft = await repository.findLatestOptimizedDraft(input.ownerUserId, live.jobId)
          if (!repairedDraft || repairedDraft.id === draft.id || !/^[a-f0-9]{64}$/u.test(repairedDraft.contentHash)) throw new Error('Repair runner did not persist a new optimized child draft with a valid content hash.')
          await repository.updateRepairAttempt(input.ownerUserId, balanced.repairContract.repairFingerprint, { repairedDraftId: String(repairedDraft.id), repairedContentHash: repairedDraft.contentHash, status: 'succeeded' })
        } catch (error) {
          await repository.updateRepairAttempt(input.ownerUserId, balanced.repairContract.repairFingerprint, { status: 'failed' }).catch(() => undefined)
          throw error
        }
        balancedPass += 1
        continue
      }
      if (balanced.decision.action === 'substitute' || balanced.decision.action === 'skip' || balanced.decision.action === 'hard_block') {
        const terminalStatus = balanced.decision.action === 'hard_block' ? 'blocked' : 'skipped'
        const terminal = await repository.transaction(async transaction => {
          const updated = await transaction.updateEntry(input.ownerUserId, live.id, { status: terminalStatus })
          const runs = await transaction.listRuns(input.ownerUserId, live.id)
          for (const run of runs.filter(run => ['queued', 'processing', 'retry_wait'].includes(run.state))) await transaction.updateRun(input.ownerUserId, run.id, { state: 'cancelled', errorCode: `AUTOPILOT_${balanced.decision.code}`, errorSummary: balanced.decision.reasons.join('; ').slice(0, 500) })
          await transaction.appendEvent(event(input.ownerUserId, live, null, `autopilot_${balanced.decision.action}`, live.status, updated.status, { decisionCode: balanced.decision.code, decisionFingerprint: balanced.decision.decisionFingerprint, nextTopic: balanced.decision.nextTopic, targetId: target.targetId }, { entryId: live.id, event: `autopilot_${balanced.decision.action}` }))
          return updated
        })
        return { ...result, entry: terminal, resultingStatus: terminal.status, outcome: 'blocked', limitations: [...balanced.decision.reasons, balanced.decision.action === 'substitute' ? 'a safe replacement topic was durably recorded and this entry was skipped without blocking the calendar' : 'no human review row or external executor call was created'] }
      }
      const promoted = await repository.transaction(async transaction => {
        const updated = await transaction.updateEntry(input.ownerUserId, live.id, { status: 'ready_to_publish', reviewId: null, publicationAuthorityReference: null })
        const runs = await transaction.listRuns(input.ownerUserId, live.id)
        for (const run of runs.filter(run => run.stage === 'review_wait' && ['queued', 'processing', 'retry_wait'].includes(run.state))) await transaction.updateRun(input.ownerUserId, run.id, { state: 'cancelled', errorCode: 'AUTOPILOT_SUPERSEDED_REVIEW_WAIT', errorSummary: 'Balanced autopilot policy authorized publication without a per-article human review.' })
        await ensureRun(transaction, input.ownerUserId, updated, 'publication', { jobId: live.jobId!, draftId: live.draftId!, evidenceSnapshotHash: live.evidenceSnapshotHash })
        await transaction.appendEvent(event(input.ownerUserId, live, null, 'autopilot_entry_authorized', live.status, updated.status, { policyId: dependencies.autopilotPolicy?.policyId || null, policyVersion: dependencies.autopilotPolicy?.policyVersion || null, targetCount: targets.length || 1, reviewId: null, authorityReference: 'machine-authorization-record' }, { entryId: live.id, event: 'autopilot_entry_authorized', policyId: dependencies.autopilotPolicy?.policyId || 'missing' }))
        return updated
      })
      result = await executeContentOperationEntry({ ownerUserId: input.ownerUserId, entryId: promoted.id, trigger: 'scheduler', now, value: { idempotencyKey: `${input.idempotencyKey}:publication`.slice(0, 128), mode }, dependencies: { ...dependencies, repository } })
      return result
    }
    return { ...result, outcome: 'blocked', limitations: ['balanced repair budget was exhausted without a publishable candidate; no human review row or external executor call was created'] }
  }
  if (!input.reviewDecision || !dependencies.reviewService) return result
  const lineage = await repository.resolveWorkspaceEntry(input.ownerUserId, input.entryId)
  if (!lineage?.job || !lineage.draft) badRequest('Application workflow review lineage is incomplete.')
  await dependencies.reviewService({ ownerUserId: input.ownerUserId, entryId: input.entryId, jobId: lineage.job.id, draftId: lineage.draft.id, decision: input.reviewDecision })
  result = await executeContentOperationEntry({ ownerUserId: input.ownerUserId, entryId: input.entryId, trigger: 'owner_manual', now, value: { idempotencyKey: `${input.idempotencyKey}:review`.slice(0, 128), mode: 'dry_run' }, dependencies: { ...dependencies, repository } })
  if (result.outcome !== 'ready_to_publish') return result
  return executeContentOperationEntry({ ownerUserId: input.ownerUserId, entryId: input.entryId, trigger: 'owner_manual', now, value: { idempotencyKey: `${input.idempotencyKey}:publication`.slice(0, 128), mode }, dependencies: { ...dependencies, repository } })
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
  const results: Array<{ runId: number; ownerUserId: number; status: string; outcome?: string; errorSummary?: string; limitations?: string[] }> = []
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
      let persistedAutopilotPolicy: OwnerAutopilotPolicy | undefined
      let persistedAutopilotPoliciesByTarget: Record<number, OwnerAutopilotPolicy | undefined> | undefined
      if (run.stage === 'generation' || run.stage === 'review_wait' || run.stage === 'publication') {
        const lineage = await repository.resolveWorkspaceEntry(run.ownerUserId, entry.id)
        if (lineage?.client) {
          const bindings = await repository.listEntryTargetBindings(run.ownerUserId, entry.id)
          const boundTargets = bindings.length ? await Promise.all(bindings.sort((left, right) => left.slot - right.slot).map(binding => repository.findPublicationTarget(run.ownerUserId, binding.targetId))) : []
          const targets = boundTargets.filter((target): target is ContentOperationPublicationTargetRow => Boolean(target))
          const effectiveTargets = targets.length ? targets : lineage.target ? [lineage.target] : []
          persistedAutopilotPoliciesByTarget = {}
          for (const target of effectiveTargets) {
            const policyRow = await repository.findAutopilotPolicy(run.ownerUserId, lineage.client.id, target.id)
            persistedAutopilotPoliciesByTarget[target.id] = policyRow ? projectAutopilotPolicy(policyRow, target.targetId) : undefined
          }
          const firstTarget = effectiveTargets[0]
          persistedAutopilotPolicy = firstTarget ? persistedAutopilotPoliciesByTarget[firstTarget.id] : undefined
        }
      }
      const result = await executeContentOperationEntry({ ownerUserId: run.ownerUserId, entryId: entry.id, trigger: 'scheduler', expectedRunId: run.id, now, value: { idempotencyKey: `scheduler:publication:${run.id}:attempt:${run.attemptNumber + 1}`, mode }, dependencies: { ...input.dependencies, repository, productionRuntime: input.dependencies?.productionRuntime || {}, autopilotPolicy: persistedAutopilotPolicy, autopilotPoliciesByTarget: persistedAutopilotPoliciesByTarget } })
      results.push({ runId: run.id, ownerUserId: run.ownerUserId, status: result.resultingStatus, outcome: result.outcome, limitations: result.limitations })
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

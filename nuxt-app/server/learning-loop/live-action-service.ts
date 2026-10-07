import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { fingerprint } from '../geo-outcome-model/canonical'
import { createContentOperationsRepository, type ContentOperationsRepository, type PublicationAttemptReservation } from '../content-operations/repository'
import type { LearningPublicationAction } from '../database/schema'
import { DrizzleLearningLoopRepository } from './repository'
import { learningError, resolveLearningAuthority } from './authority'
import type { LearningLoopRepository, LearningScope } from './types'
import { DrizzleLiveActionRepository, type LiveActionRepository, type ActionLease, type PublicationLease } from './live-action-repository'
import { captureAuthorizedLivePage, type LiveAcquisitionAuthority, type LivePageFetcherDependencies } from './live-page-fetcher'
import { buildPlannedLiveAction, livePageMatchesExpected, verifyLivePageProjection, verifyPlannedLiveAction, type PlannedLiveAction } from './live-page-projection'
import { resolveLiveActionContext, resolveLiveActionReceipt, type LiveActionContext } from './live-action-context'

export type LiveActionDependencies = {
  operations?: ContentOperationsRepository
  learning?: LearningLoopRepository
  actions?: LiveActionRepository
  enabled?: boolean
  now?: () => Date
  capture?: typeof captureAuthorizedLivePage
  acquisition?: Omit<LivePageFetcherDependencies, 'resolveCurrentAuthority' | 'now'>
}
const MAX_AFTER_AGE_MS = 24 * 60 * 60 * 1000
const CAPTURE_LEASE_MS = 60_000
const enabled = (deps: LiveActionDependencies) => deps.enabled ?? process.env.NUXT_LEARNING_LIVE_ACTION_ENABLED === 'true'
const at = (deps: LiveActionDependencies) => (deps.now || (() => new Date()))()
const hash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
const validDate = (value: unknown): value is Date => value instanceof Date && Number.isFinite(value.getTime())
const actionsFor = (deps: LiveActionDependencies) => deps.actions || new DrizzleLiveActionRepository()
const operationsFor = (deps: LiveActionDependencies) => deps.operations || createContentOperationsRepository()
const learningFor = (deps: LiveActionDependencies) => deps.learning || new DrizzleLearningLoopRepository()
type CurrentScope = { scope: LearningScope; acquisition: LiveAcquisitionAuthority }

async function currentScope(owner: number, clientId: number, authorizationId: number, publicationUrl: string, learning: LearningLoopRepository, now: Date): Promise<CurrentScope | null> {
  const scope = await learning.getScope(owner, authorizationId)
  if (!scope || scope.authorization.clientId !== clientId) return null
  const authority = resolveLearningAuthority(scope, { ownerUserId: owner, clientId, sourceId: scope.authorization.sourceId }, now)
  if (!authority || scope.authorization.authorizedOrigin !== new URL(publicationUrl).origin) return null
  return { scope, acquisition: { authorizationFingerprint: scope.authorization.authorizationFingerprint, authority } }
}
async function chooseScope(context: LiveActionContext, learning: LearningLoopRepository, deps: LiveActionDependencies) {
  const grants = (await learning.listAuthorizations(context.ownerUserId)).filter(row => row.ownerUserId === context.ownerUserId && row.clientId === context.clientId).sort((a, b) => a.id - b.id)
  for (const grant of grants) {
    const current = await currentScope(context.ownerUserId, context.clientId, grant.id, context.publicationUrl, learning, at(deps))
    if (current) return current
  }
  return null
}
function actionInputFingerprint(context: LiveActionContext, scope: CurrentScope) {
  return fingerprint({ contractVersion: 'learning-live-action-input-v1', contextFingerprint: context.contextFingerprint, authorizationId: scope.scope.authorization.id, authorizationFingerprint: scope.acquisition.authorizationFingerprint, sourceFingerprint: scope.acquisition.authority.sourceFingerprint })
}
function rowMatchesContext(row: LearningPublicationAction, context: LiveActionContext, scope: CurrentScope, now: Date): boolean {
  return row.ownerUserId === context.ownerUserId && row.clientId === context.clientId && row.entryId === context.entryId && row.attemptId === context.attempt.id && row.runId === context.attempt.runId
    && row.targetId === context.target.id && row.draftId === context.lineage.draft!.id && row.draftVersion === context.lineage.draft!.version
    && row.draftContentHash === context.lineage.draft!.contentHash && row.publicationContentHash === context.attempt.publicationContentHash && row.evidenceSnapshotHash === context.attempt.evidenceSnapshotHash
    && row.publicationIdentityFingerprint === context.publicationIdentityFingerprint && row.targetConfigurationFingerprint === context.target.configurationFingerprint && row.publicationUrlHash === context.publicationUrlHash
    && row.authorizationId === scope.scope.authorization.id && row.authorizationFingerprint === scope.acquisition.authorizationFingerprint && row.sourceFingerprint === scope.acquisition.authority.sourceFingerprint
    && row.inputFingerprint === actionInputFingerprint(context, scope) && validDate(row.expiresAt) && row.expiresAt > now
    && row.expiresAt <= scope.scope.authorization.expiresAt && (!scope.scope.source.retentionUntil || row.expiresAt <= scope.scope.source.retentionUntil)
    && !['expired', 'blocked'].includes(row.status) && verifyLivePageProjection(row.expectedProjection) && row.expectedProjection.projectionFingerprint === context.expected.projectionFingerprint
}
function evidenceBody(row: LearningPublicationAction, context: LiveActionContext, receipt: NonNullable<Awaited<ReturnType<typeof resolveLiveActionReceipt>>>) {
  if (!verifyLivePageProjection(row.beforeProjection) || !verifyLivePageProjection(row.afterProjection) || !verifyLivePageProjection(row.expectedProjection)
    || !verifyPlannedLiveAction(row.plannedAction, row.beforeProjection, row.expectedProjection)
    || !livePageMatchesExpected(row.afterProjection, context.expected)
    || !validDate(row.beforeCapturedAt) || !validDate(row.dispatchStartedAt) || !validDate(row.afterCapturedAt) || !validDate(row.deliveredAt)
    || row.beforeCapturedAt > row.dispatchStartedAt || row.dispatchStartedAt > receipt.deliveredAt || row.afterCapturedAt < receipt.deliveredAt
    || row.afterCapturedAt.getTime() > receipt.deliveredAt.getTime() + MAX_AFTER_AGE_MS
    || row.deliveredAt.getTime() !== receipt.deliveredAt.getTime() || row.receiptFingerprint !== receipt.receiptFingerprint
    || row.beforeCapturedAt.getTime() + 30_000 < row.dispatchStartedAt.getTime()) return null
  return {
    contractVersion: 'learning-live-publication-action-evidence-v1', inputFingerprint: row.inputFingerprint,
    contextFingerprint: context.contextFingerprint, receiptIdentityFingerprint: receipt.receiptIdentityFingerprint,
    beforeProjectionFingerprint: row.beforeProjection.projectionFingerprint, expectedProjectionFingerprint: row.expectedProjection.projectionFingerprint,
    afterProjectionFingerprint: row.afterProjection.projectionFingerprint, plannedActionFingerprint: row.plannedAction.actionFingerprint,
    beforeCapturedAt: row.beforeCapturedAt.toISOString(), dispatchStartedAt: row.dispatchStartedAt.toISOString(), deliveredAt: receipt.deliveredAt.toISOString(), afterCapturedAt: row.afterCapturedAt.toISOString(), expiresAt: row.expiresAt.toISOString(),
    receiptFingerprint: receipt.receiptFingerprint, authorizationFingerprint: row.authorizationFingerprint, sourceFingerprint: row.sourceFingerprint,
    primaryCitationLabelAllowed: false as const, causalEligibility: false as const,
  }
}
function actionReviewFingerprint(row: Pick<LearningPublicationAction, 'id' | 'ownerUserId' | 'evidenceFingerprint'>, decision: 'approved' | 'rejected', reasonHash: string, reviewedAt: Date) {
  return fingerprint({ contractVersion: 'learning-live-action-owner-review-v1', ownerUserId: row.ownerUserId, actionId: row.id, evidenceFingerprint: row.evidenceFingerprint, decision, reasonHash, reviewedAt: reviewedAt.toISOString(), piiReviewConfirmed: true, rightsConfirmed: true, observationalOnlyAcknowledged: true })
}

/** Post-read selectors retain one exact grant, never fall back to a changed/new grant mid-capture. */
function acquisitionFor(context: LiveActionContext, scope: CurrentScope, learning: LearningLoopRepository, deps: LiveActionDependencies) {
  return {
    ...deps.acquisition, now: () => at(deps),
    resolveCurrentAuthority: async (selector: { ownerUserId: number; clientId: number; sourceId: number }, now: Date) => {
      if (selector.ownerUserId !== context.ownerUserId || selector.clientId !== context.clientId || selector.sourceId !== scope.scope.authorization.sourceId) return null
      const current = await currentScope(context.ownerUserId, context.clientId, scope.scope.authorization.id, context.publicationUrl, learning, now)
      return current?.acquisition || null
    },
  }
}

/** Internal server hook only. Failure blocks learning, not an independently approved business write. */
export async function captureLiveActionBeforePublication(ownerUserId: number, entryId: number, reservation: PublicationAttemptReservation, publicationLease: PublicationLease, deps: LiveActionDependencies = {}) {
  if (!enabled(deps)) return { status: 'disabled' as const, actionId: null, reasonCode: null }
  const actions = actionsFor(deps), operations = operationsFor(deps), learning = learningFor(deps)
  if (reservation.replayed) {
    // A replayed planned attempt may already have made an uncertain external write. Never invent before.
    const existing = await actions.findByAttempt(ownerUserId, reservation.attempt.id)
    return { status: 'skipped' as const, actionId: existing?.id || null, reasonCode: 'RESUMED_ATTEMPT_BEFORE_CAPTURE_FORBIDDEN' }
  }
  let reserved: LearningPublicationAction | null = null
  try {
    const context = await resolveLiveActionContext(ownerUserId, entryId, reservation.attempt.id, operations)
    if (!context || context.attempt.status !== 'planned' || context.attempt.runId !== publicationLease.runId) return { status: 'blocked' as const, actionId: null, reasonCode: 'EXACT_PLANNED_PUBLICATION_REQUIRED' }
    const scope = await chooseScope(context, learning, deps)
    if (!scope) return { status: 'blocked' as const, actionId: null, reasonCode: 'CURRENT_LEARNING_AUTHORIZATION_REQUIRED' }
    const now = at(deps), grant = scope.scope.authorization
    const expiresAt = new Date(Math.min(grant.expiresAt.getTime(), now.getTime() + grant.retentionDays * 86400000, scope.scope.source.retentionUntil?.getTime() ?? Number.POSITIVE_INFINITY))
    if (expiresAt <= now) return { status: 'blocked' as const, actionId: null, reasonCode: 'LEARNING_RETENTION_EXPIRED' }
    const leaseToken = randomUUID()
    const result = await actions.reserve({
      ownerUserId, clientId: context.clientId, authorizationId: grant.id, entryId, attemptId: context.attempt.id, runId: context.attempt.runId, targetId: context.target.id,
      draftId: context.lineage.draft!.id, draftVersion: context.lineage.draft!.version, inputFingerprint: actionInputFingerprint(context, scope), draftContentHash: context.lineage.draft!.contentHash,
      evidenceSnapshotHash: context.attempt.evidenceSnapshotHash, publicationContentHash: context.attempt.publicationContentHash!, publicationIdentityFingerprint: context.publicationIdentityFingerprint,
      targetConfigurationFingerprint: context.target.configurationFingerprint, publicationUrlHash: context.publicationUrlHash, authorizationFingerprint: grant.authorizationFingerprint, sourceFingerprint: scope.acquisition.authority.sourceFingerprint,
      expectedProjection: context.expected, beforeProjection: null, afterProjection: null, plannedAction: null, status: 'capturing_before', reasonCode: null,
      dispatchStartedAt: null, beforeCapturedAt: null, deliveredAt: null, afterCapturedAt: null, nextAttemptAt: null, receiptFingerprint: null, evidenceFingerprint: null,
      afterAttemptCount: 0, leaseToken, leaseVersion: 1, leaseExpiresAt: new Date(Math.min(now.getTime() + CAPTURE_LEASE_MS, expiresAt.getTime())), expiresAt,
      reviewStatus: 'pending', reviewFingerprint: null, reviewEvidenceFingerprint: null, reviewReasonHash: null, reviewedAt: null,
    })
    reserved = result.row
    if (result.replayed) return { status: 'skipped' as const, actionId: reserved.id, reasonCode: 'IMMUTABLE_ACTION_ALREADY_RESERVED' }
    const lease: ActionLease = { ownerUserId, id: reserved.id, leaseToken, leaseVersion: reserved.leaseVersion }
    const captured = await (deps.capture || captureAuthorizedLivePage)({ selector: { ownerUserId, clientId: context.clientId, sourceId: grant.sourceId }, publicationUrl: context.publicationUrl }, acquisitionFor(context, scope, learning, deps))
    const current = await resolveLiveActionContext(ownerUserId, entryId, context.attempt.id, operations)
    const currentGrant = await currentScope(ownerUserId, context.clientId, grant.id, context.publicationUrl, learning, at(deps))
    if (!current || !currentGrant || current.contextFingerprint !== context.contextFingerprint || !rowMatchesContext(reserved, current, currentGrant, at(deps)) || captured.status !== 'captured' || !captured.projection || !captured.capturedAt
      || captured.authorizationFingerprint !== reserved.authorizationFingerprint || captured.sourceFingerprint !== reserved.sourceFingerprint || captured.consentReceiptHash !== grant.consentReceiptHash) {
      await actions.clear(ownerUserId, reserved.id, reserved.leaseVersion, at(deps), 'BEFORE_CAPTURE_NOT_VERIFIED')
      return { status: 'blocked' as const, actionId: reserved.id, reasonCode: captured.reasonCode || 'BEFORE_CAPTURE_NOT_VERIFIED' }
    }
    const plannedAction = buildPlannedLiveAction(captured.projection, current.expected)
    const capturedAt = new Date(captured.capturedAt)
    if (!plannedAction || !validDate(capturedAt) || capturedAt < grant.approvedAt || capturedAt > at(deps)) {
      await actions.clear(ownerUserId, reserved.id, reserved.leaseVersion, at(deps), 'BEFORE_PROJECTION_INVALID')
      return { status: 'blocked' as const, actionId: reserved.id, reasonCode: 'BEFORE_PROJECTION_INVALID' }
    }
    const saved = await actions.saveBefore(lease, at(deps), { beforeProjection: captured.projection, plannedAction, beforeCapturedAt: capturedAt }, publicationLease)
    if (!saved) return { status: 'blocked' as const, actionId: reserved.id, reasonCode: 'BEFORE_CAPTURE_LEASE_LOST' }
    // The durable dispatch boundary must precede the publisher. No after worker accepts before_ready.
    const finalContext = await resolveLiveActionContext(ownerUserId, entryId, context.attempt.id, operations)
    const finalGrant = await currentScope(ownerUserId, context.clientId, grant.id, context.publicationUrl, learning, at(deps))
    if (!finalContext || !finalGrant || !rowMatchesContext(saved, finalContext, finalGrant, at(deps)) || at(deps).getTime() - capturedAt.getTime() > 30_000) {
      await actions.clear(ownerUserId, saved.id, saved.leaseVersion, at(deps), 'BEFORE_IDENTITY_CHANGED')
      return { status: 'blocked' as const, actionId: saved.id, reasonCode: 'BEFORE_IDENTITY_CHANGED' }
    }
    const dispatch = await actions.markDispatch(ownerUserId, saved.id, saved.leaseVersion, at(deps), publicationLease)
    return { status: dispatch ? 'recorded' as const : 'blocked' as const, actionId: saved.id, reasonCode: dispatch ? null : 'PUBLICATION_DISPATCH_BOUNDARY_NOT_RECORDED' }
  } catch {
    // An incomplete record cannot be used by after/release. Clear any known private projection.
    if (reserved) await actions.clear(ownerUserId, reserved.id, reserved.leaseVersion, at(deps), 'BEFORE_CAPTURE_DEFERRED').catch(() => false)
    return { status: 'deferred' as const, actionId: reserved?.id || null, reasonCode: 'BEFORE_CAPTURE_DEFERRED' }
  }
}

/** Recovery is only GET/capture. This function has no publisher, generator, LINE or payment boundary. */
export async function reconcileLivePublicationAction(ownerUserId: number, actionId: number, deps: LiveActionDependencies = {}) {
  if (!enabled(deps)) return { status: 'disabled' as const, actionId, reasonCode: null }
  const actions = actionsFor(deps), operations = operationsFor(deps), learning = learningFor(deps)
  let row = await actions.get(ownerUserId, actionId)
  if (!row || row.ownerUserId !== ownerUserId) return { status: 'blocked' as const, actionId, reasonCode: 'ACTION_NOT_FOUND' }
  if (['expired', 'blocked', 'observed'].includes(row.status)) return { status: row.status, actionId, reasonCode: row.reasonCode }
  const context = await resolveLiveActionContext(ownerUserId, row.entryId, row.attemptId, operations)
  const scope = context ? await currentScope(ownerUserId, row.clientId, row.authorizationId, context.publicationUrl, learning, at(deps)) : null
  if (!context || !scope || !rowMatchesContext(row, context, scope, at(deps))) {
    await actions.clear(ownerUserId, row.id, row.leaseVersion, at(deps), 'CURRENT_ACTION_AUTHORITY_REQUIRED')
    return { status: 'blocked' as const, actionId, reasonCode: 'CURRENT_ACTION_AUTHORITY_REQUIRED' }
  }
  if (context.attempt.status === 'planned') return { status: 'waiting_for_receipt' as const, actionId, reasonCode: null }
  const receipt = await resolveLiveActionReceipt(context, operations, at(deps))
  if (!receipt || !row.dispatchStartedAt || !row.beforeCapturedAt || !verifyLivePageProjection(row.beforeProjection) || !verifyPlannedLiveAction(row.plannedAction, row.beforeProjection, context.expected)) {
    await actions.clear(ownerUserId, row.id, row.leaseVersion, at(deps), 'EXACT_BEFORE_AND_RECEIPT_REQUIRED')
    return { status: 'blocked' as const, actionId, reasonCode: 'EXACT_BEFORE_AND_RECEIPT_REQUIRED' }
  }
  if (receipt.deliveredAt < row.dispatchStartedAt || at(deps).getTime() > receipt.deliveredAt.getTime() + MAX_AFTER_AGE_MS || row.afterAttemptCount >= 6) {
    await actions.clear(ownerUserId, row.id, row.leaseVersion, at(deps), 'AFTER_VERIFICATION_WINDOW_EXPIRED')
    return { status: 'blocked' as const, actionId, reasonCode: 'AFTER_VERIFICATION_WINDOW_EXPIRED' }
  }
  if (row.status === 'dispatch_started') {
    row = await actions.attachReceipt(ownerUserId, row.id, { inputFingerprint: row.inputFingerprint, receiptFingerprint: receipt.receiptFingerprint, deliveredAt: receipt.deliveredAt }, at(deps))
    if (!row) return { status: 'deferred' as const, actionId, reasonCode: 'RECEIPT_BINDING_DEFERRED' }
  }
  const token = randomUUID(), claimedAt = at(deps)
  const claimed = await actions.claimAfter(ownerUserId, row.id, row.leaseVersion, token, claimedAt, new Date(Math.min(claimedAt.getTime() + CAPTURE_LEASE_MS, row.expiresAt.getTime(), receipt.deliveredAt.getTime() + MAX_AFTER_AGE_MS)))
  if (!claimed) return { status: 'busy_or_not_due' as const, actionId, reasonCode: null }
  const lease: ActionLease = { ownerUserId, id: claimed.id, leaseToken: token, leaseVersion: claimed.leaseVersion }
  try {
    // A SQL claim may wait. Never spend network work with an expired/replaced lease or stale receipt.
    const active = await actions.get(ownerUserId, claimed.id)
    const beforeContext = await resolveLiveActionContext(ownerUserId, claimed.entryId, claimed.attemptId, operations)
    const beforeScope = beforeContext ? await currentScope(ownerUserId, claimed.clientId, claimed.authorizationId, beforeContext.publicationUrl, learning, at(deps)) : null
    const beforeReceipt = beforeContext ? await resolveLiveActionReceipt(beforeContext, operations, at(deps)) : null
    if (!active || active.status !== 'capturing_after' || active.leaseToken !== lease.leaseToken || active.leaseVersion !== lease.leaseVersion || !active.leaseExpiresAt || active.leaseExpiresAt <= at(deps)
      || !beforeContext || !beforeScope || !beforeReceipt || beforeReceipt.receiptIdentityFingerprint !== receipt.receiptIdentityFingerprint || !rowMatchesContext(active, beforeContext, beforeScope, at(deps))) return { status: 'deferred' as const, actionId, reasonCode: 'AFTER_CAPTURE_LEASE_OR_AUTHORITY_LOST' }
    const captured = await (deps.capture || captureAuthorizedLivePage)({ selector: { ownerUserId, clientId: claimed.clientId, sourceId: scope.scope.authorization.sourceId }, publicationUrl: context.publicationUrl }, acquisitionFor(context, scope, learning, deps))
    const current = await resolveLiveActionContext(ownerUserId, claimed.entryId, claimed.attemptId, operations)
    const currentScopeRow = current ? await currentScope(ownerUserId, claimed.clientId, claimed.authorizationId, current.publicationUrl, learning, at(deps)) : null
    const currentReceipt = current ? await resolveLiveActionReceipt(current, operations, at(deps)) : null
    if (!current || !currentScopeRow || !currentReceipt || currentReceipt.receiptIdentityFingerprint !== receipt.receiptIdentityFingerprint || !rowMatchesContext(claimed, current, currentScopeRow, at(deps)) || captured.authorizationFingerprint !== claimed.authorizationFingerprint || captured.sourceFingerprint !== claimed.sourceFingerprint) {
      await actions.clear(ownerUserId, claimed.id, claimed.leaseVersion, at(deps), 'ACTION_CHANGED_DURING_AFTER_CAPTURE')
      return { status: 'blocked' as const, actionId, reasonCode: 'ACTION_CHANGED_DURING_AFTER_CAPTURE' }
    }
    const afterCapturedAt = captured.capturedAt ? new Date(captured.capturedAt) : null
    if (captured.status === 'captured' && captured.projection && afterCapturedAt && afterCapturedAt <= at(deps) && livePageMatchesExpected(captured.projection, current.expected)) {
      const observed = { ...claimed, afterProjection: captured.projection, afterCapturedAt }
      const body = evidenceBody(observed, current, currentReceipt)
      if (!body) {
        await actions.clear(ownerUserId, claimed.id, claimed.leaseVersion, at(deps), 'AFTER_EVIDENCE_IDENTITY_INVALID')
        return { status: 'blocked' as const, actionId, reasonCode: 'AFTER_EVIDENCE_IDENTITY_INVALID' }
      }
      const saved = await actions.finishAfter(lease, at(deps), { status: 'observed', afterProjection: captured.projection, afterCapturedAt, evidenceFingerprint: fingerprint(body), reasonCode: null, nextAttemptAt: null })
      return { status: saved ? 'observed' as const : 'deferred' as const, actionId, reasonCode: saved ? null : 'AFTER_CAPTURE_LEASE_LOST' }
    }
    const retryable = captured.status !== 'blocked' || captured.reasonCode === 'PROJECTION_NOT_VERIFIED'
    const delay = Math.min(60 * 60_000, 5 * 60_000 * 2 ** Math.max(0, claimed.afterAttemptCount - 1))
    const nextAttemptAt = new Date(at(deps).getTime() + delay)
    const canRetry = retryable && claimed.afterAttemptCount < 6 && nextAttemptAt < claimed.expiresAt && nextAttemptAt.getTime() <= receipt.deliveredAt.getTime() + MAX_AFTER_AGE_MS
    const saved = await actions.finishAfter(lease, at(deps), { status: canRetry ? 'awaiting_after' : 'blocked', afterProjection: null, afterCapturedAt: null, evidenceFingerprint: null, reasonCode: captured.reasonCode || 'LIVE_PAGE_NOT_YET_MATCHED', nextAttemptAt: canRetry ? nextAttemptAt : null })
    return { status: saved?.status || 'deferred', actionId, reasonCode: saved?.reasonCode || 'AFTER_CAPTURE_LEASE_LOST' }
  } catch {
    const retryAt = new Date(at(deps).getTime() + 5 * 60_000)
    const canRetry = claimed.afterAttemptCount < 6 && retryAt < claimed.expiresAt && retryAt.getTime() <= receipt.deliveredAt.getTime() + MAX_AFTER_AGE_MS
    await actions.finishAfter(lease, at(deps), { status: canRetry ? 'awaiting_after' : 'blocked', afterProjection: null, afterCapturedAt: null, evidenceFingerprint: null, reasonCode: 'AFTER_VERIFICATION_DEFERRED', nextAttemptAt: canRetry ? retryAt : null }).catch(() => null)
    return { status: 'deferred' as const, actionId, reasonCode: 'AFTER_VERIFICATION_DEFERRED' }
  }
}

/** Only an exact owner-scoped durable attempt selects the after-only worker; no URLs are accepted. */
export async function reconcileLivePublicationAttempt(ownerUserId: number, attemptId: number, deps: LiveActionDependencies = {}) {
  if (!enabled(deps)) return { status: 'disabled' as const, actionId: null }
  const actions = actionsFor(deps)
  const row = await actions.findByAttempt(ownerUserId, attemptId)
  return row ? reconcileLivePublicationAction(ownerUserId, row.id, { ...deps, actions }) : { status: 'no_before_evidence' as const, actionId: null }
}

async function currentEvidence(owner: number, actionId: number, deps: LiveActionDependencies) {
  const actions = actionsFor(deps), operations = operationsFor(deps), learning = learningFor(deps)
  const row = await actions.get(owner, actionId)
  if (!row || row.ownerUserId !== owner || row.status !== 'observed') return null
  const context = await resolveLiveActionContext(owner, row.entryId, row.attemptId, operations)
  const scope = context ? await currentScope(owner, row.clientId, row.authorizationId, context.publicationUrl, learning, at(deps)) : null
  const receipt = context ? await resolveLiveActionReceipt(context, operations, at(deps)) : null
  if (!context || !scope || !receipt || !rowMatchesContext(row, context, scope, at(deps))) return null
  const body = evidenceBody(row, context, receipt)
  if (!body || fingerprint(body) !== row.evidenceFingerprint || row.beforeCapturedAt! < scope.scope.authorization.approvedAt || row.afterCapturedAt! > at(deps)
    || row.expiresAt.getTime() > row.beforeCapturedAt!.getTime() + scope.scope.authorization.retentionDays * 86400000) return null
  return { row, context, scope, receipt, body }
}

/** Every export is a use and gets a second fresh authority/receipt/row check after all awaited work. */
export async function resolveReviewedLivePublicationAction(ownerUserId: number, actionId: number, deps: LiveActionDependencies = {}) {
  const first = await currentEvidence(ownerUserId, actionId, deps)
  if (!first || first.row.reviewStatus !== 'approved' || !hash(first.row.reviewReasonHash) || !validDate(first.row.reviewedAt) || first.row.reviewEvidenceFingerprint !== first.row.evidenceFingerprint
    || first.row.reviewFingerprint !== actionReviewFingerprint(first.row, 'approved', first.row.reviewReasonHash, first.row.reviewedAt)) return null
  const current = await currentEvidence(ownerUserId, actionId, deps)
  if (!current || current.row.reviewStatus !== 'approved' || fingerprint(current.body) !== fingerprint(first.body) || current.row.reviewFingerprint !== first.row.reviewFingerprint) return null
  const planned = current.row.plannedAction as PlannedLiveAction
  const body = { contractVersion: 'reviewed-live-publication-action-v1' as const, actionId, entryId: current.row.entryId, attemptId: current.row.attemptId, targetId: current.row.targetId,
    draftId: current.row.draftId, draftVersion: current.row.draftVersion, draftContentHash: current.row.draftContentHash, evidenceSnapshotHash: current.row.evidenceSnapshotHash,
    receiptFingerprint: current.receipt.receiptFingerprint, evidenceFingerprint: current.row.evidenceFingerprint!, reviewFingerprint: current.row.reviewFingerprint!,
    authorizationFingerprint: current.row.authorizationFingerprint, sourceFingerprint: current.row.sourceFingerprint,
    beforeCapturedAt: current.row.beforeCapturedAt!.toISOString(), dispatchStartedAt: current.row.dispatchStartedAt!.toISOString(), deliveredAt: current.receipt.deliveredAt.toISOString(), verifiedAt: current.row.afterCapturedAt!.toISOString(), expiresAt: current.row.expiresAt.toISOString(),
    features: planned.features, plannedActionFingerprint: planned.actionFingerprint, liveBeforeState: current.row.beforeProjection && verifyLivePageProjection(current.row.beforeProjection) && current.row.beforeProjection.kind === 'not_found' ? 'known_not_found' as const : 'known_controlled_document' as const,
    modelTrainingAllowed: true as const, primaryCitationLabelAllowed: false as const, causalEligibility: false as const,
    limitations: ['http_served_semantic_content_not_browser_or_indexing_proof', 'planned_pre_dispatch_features_only', 'auxiliary_observational_not_causal', 'independent_model_dataset_review_still_required'],
  }
  return { ...body, releaseFingerprint: fingerprint(body) }
}
export type ReviewedLivePublicationAction = NonNullable<Awaited<ReturnType<typeof resolveReviewedLivePublicationAction>>>

const reviewSchema = z.object({ actionId: z.number().int().positive(), evidenceFingerprint: z.string().regex(/^[a-f0-9]{64}$/), decision: z.enum(['approved', 'rejected']), piiReviewConfirmed: z.literal(true), rightsConfirmed: z.literal(true), observationalOnlyAcknowledged: z.literal(true), reviewReason: z.string().trim().min(10).max(500) }).strict()
export async function reviewLivePublicationAction(ownerUserId: number, input: unknown, deps: LiveActionDependencies = {}) {
  const parsed = reviewSchema.safeParse(input)
  if (!parsed.success) learningError('INVALID_LIVE_ACTION_REVIEW', '請核對改動證據、權利與個資，並記錄審查理由。', 422)
  const before = await currentEvidence(ownerUserId, parsed.data.actionId, deps)
  if (!before || before.row.evidenceFingerprint !== parsed.data.evidenceFingerprint) learningError('CURRENT_LIVE_ACTION_EVIDENCE_REQUIRED', '改動證據或授權已變動，請重新讀取。')
  const current = await currentEvidence(ownerUserId, parsed.data.actionId, deps)
  if (!current || current.row.evidenceFingerprint !== before.row.evidenceFingerprint) learningError('CURRENT_LIVE_ACTION_EVIDENCE_REQUIRED')
  const reasonHash = fingerprint(parsed.data.reviewReason), reviewedAt = at(deps)
  const reviewHash = actionReviewFingerprint(current.row, parsed.data.decision, reasonHash, reviewedAt)
  const row = current.row.reviewStatus === 'pending' ? await actionsFor(deps).review(ownerUserId, current.row.id, current.row.evidenceFingerprint!, parsed.data.decision, reviewHash, reasonHash, reviewedAt) : current.row
  if (!row || row.reviewStatus !== parsed.data.decision || row.reviewReasonHash !== reasonHash || row.reviewEvidenceFingerprint !== current.row.evidenceFingerprint) learningError('LIVE_ACTION_REVIEW_IMMUTABLE', '這份改動證據已有不同審查，不能覆寫。')
  const after = await currentEvidence(ownerUserId, row.id, deps)
  if (!after || after.row.reviewFingerprint !== row.reviewFingerprint) learningError('CURRENT_LIVE_ACTION_EVIDENCE_REQUIRED')
  return { actionId: row.id, reviewStatus: row.reviewStatus, reviewFingerprint: row.reviewFingerprint, trainingPerformed: false as const, publicationPerformed: false as const }
}

export async function getLivePublicationActionWorkspace(ownerUserId: number, deps: LiveActionDependencies = {}) {
  const rows = await actionsFor(deps).list(ownerUserId, 50)
  const items = []
  for (const row of rows) {
    const evidence = row.status === 'observed' ? await currentEvidence(ownerUserId, row.id, deps) : null
    items.push({ id: row.id, clientId: row.clientId, entryId: row.entryId, targetId: row.targetId, status: row.status, reviewStatus: row.reviewStatus, evidenceFingerprint: evidence ? row.evidenceFingerprint : null,
      currentEvidenceValid: Boolean(evidence), evidenceSummary: evidence ? { liveBeforeState: verifyLivePageProjection(row.beforeProjection) ? row.beforeProjection.kind : null, features: (row.plannedAction as PlannedLiveAction).features, beforeCapturedAt: row.beforeCapturedAt!.toISOString(), deliveredAt: row.deliveredAt!.toISOString(), afterCapturedAt: row.afterCapturedAt!.toISOString() } : null,
      expiresAt: row.expiresAt.toISOString(), attemptCount: row.afterAttemptCount, nextAttemptAt: row.nextAttemptAt?.toISOString() || null, reasonCode: row.reasonCode, primaryCitationLabelAllowed: false as const, causalEligibility: false as const })
  }
  return { enabled: enabled(deps), limit: 50, items, requiresIndependentReview: true as const, productionActivation: false as const }
}

/** At most one external after capture per tick; existing completed evidence is not re-fetched. */
export async function runLivePublicationActionRecovery(ownerUserId: number, deps: LiveActionDependencies = {}) {
  if (!enabled(deps)) return { status: 'disabled' as const, considered: 0, captured: 0 }
  const actions = actionsFor(deps), count = await actions.countLive(ownerUserId), now = at(deps)
  const pages = Math.max(1, Math.ceil(count / 25)), offset = (Math.floor(now.getTime() / 300000) % pages) * 25
  const rows = await actions.listLive(ownerUserId, offset, 25)
  let considered = 0
  for (const row of rows) {
    if (['observed', 'blocked', 'expired'].includes(row.status) || row.nextAttemptAt && row.nextAttemptAt > at(deps) || row.status === 'capturing_after' && row.leaseExpiresAt && row.leaseExpiresAt > at(deps)) continue
    considered++
    const result = await reconcileLivePublicationAction(ownerUserId, row.id, { ...deps, actions })
    if (result.status !== 'waiting_for_receipt') return { status: result.status, considered, captured: result.status === 'observed' ? 1 : 0 }
  }
  return { status: 'no_due_after_verification' as const, considered, captured: 0 }
}

/** Physical payload cleanup is allowed independently of publication/capture/training switches. */
export async function cleanInvalidLivePublicationActions(ownerUserId: number, deps: LiveActionDependencies = {}) {
  const actions = actionsFor(deps), operations = operationsFor(deps), learning = learningFor(deps)
  let cleared = await actions.purgeExpired(ownerUserId, at(deps), 50)
  const count = await actions.countLive(ownerUserId), pages = Math.max(1, Math.ceil(count / 50)), offset = (Math.floor(at(deps).getTime() / 300000) % pages) * 50
  const rows = await actions.listLive(ownerUserId, offset, 50)
  for (const row of rows) {
    const context = await resolveLiveActionContext(ownerUserId, row.entryId, row.attemptId, operations)
    const scope = context ? await currentScope(ownerUserId, row.clientId, row.authorizationId, context.publicationUrl, learning, at(deps)) : null
    if (!context || !scope || !rowMatchesContext(row, context, scope, at(deps)) || row.status === 'blocked'
      || ['capturing_before', 'before_ready'].includes(row.status) && (!row.leaseExpiresAt || row.leaseExpiresAt <= at(deps))
      || row.status === 'dispatch_started' && row.dispatchStartedAt && row.dispatchStartedAt.getTime() + MAX_AFTER_AGE_MS <= at(deps).getTime()) cleared += Number(await actions.clear(ownerUserId, row.id, row.leaseVersion, at(deps), 'LEARNING_ACTION_NO_LONGER_CURRENT'))
  }
  return { checked: rows.length, cleared }
}

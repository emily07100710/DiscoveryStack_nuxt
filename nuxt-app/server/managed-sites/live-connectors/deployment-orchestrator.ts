import { randomBytes } from 'node:crypto'
import { createError } from 'h3'
import { stableFingerprint } from '../../seo-geo-core/repository'
import { assertPublicHttpsUrl } from '../../content-operations/normalization'
import { isOpaqueReference } from '../../first-party-publishing/normalization'
import { getManagedSiteRepository } from '../repository'
import { getPreviewRepository } from '../ordering-repository'
import type { PreviewRepository } from '../ordering-types'
import { managedSiteCommerceSnapshotFingerprint } from '../prepurchase-service'
import { linkManagedSiteContentOperations } from '../modules-service'
import type { ManagedSiteRepository } from '../types'
import { canonicalizeManagedDomain } from './domain-connectors'
import { inspectManagedSitePreviewGates, runManagedSitePreviewGates } from './gates'
import { getManagedSiteLiveConnectorRepository } from './repository'
import { requireVerifiedManagedSiteProvider, resolveManagedSiteCredential } from './provider-registry'
import type {
  ManagedSiteConnectorExecutionMode,
  ManagedSiteCredentialResolver,
  ManagedSiteDeploymentAdapter,
  ManagedSiteDeploymentReceipt,
  ManagedSiteExistingSiteOwnershipAdapter,
  ManagedSiteExistingSiteOwnershipReceipt,
  ManagedSiteLiveConnectorRepository,
} from './types'

const DEPLOYMENT_TIMEOUT_MS = 30_000
const DEPLOYMENT_LEASE_MS = 45_000
const DEPLOYMENT_MAX_ATTEMPTS = 3

function invalid(message: string): never { throw createError({ statusCode: 422, statusMessage: message }) }
function conflict(message: string): never { throw createError({ statusCode: 409, statusMessage: message }) }
function unavailable(message: string): never { throw createError({ statusCode: 503, statusMessage: message }) }

function assertExecutionMode(mode: Exclude<ManagedSiteConnectorExecutionMode, 'dry_run'>): void {
  if (!['mocked', 'live'].includes(mode)) invalid('Deployment execution mode is invalid.')
  if (mode === 'mocked' && process.env.NODE_ENV !== 'test') unavailable('Mock deployment execution is restricted to tests.')
}

async function deploymentProvider(ownerUserId: number, mode: Exclude<ManagedSiteConnectorExecutionMode, 'dry_run'>, repository: ManagedSiteLiveConnectorRepository, resolver: ManagedSiteCredentialResolver) {
  const configuration = await repository.findProviderConfiguration(ownerUserId, 'deployment')
  if (mode === 'live') return requireVerifiedManagedSiteProvider(ownerUserId, 'deployment', repository, resolver)
  if (!configuration || !['mock', 'verified'].includes(configuration.readinessStatus)) unavailable('Mock deployment provider is not explicitly configured.')
  return configuration
}

function releaseFingerprint(value: unknown): string { return stableFingerprint({ schemaVersion: 'managed-site-release-projection-v1', value }) }

export async function createGeneratedManagedSiteRelease(ownerUserId: number, input: { projectId: number; generationCandidateId: number; canonicalDomain: string; targetKey: string; idempotencyKey: string }, dependencies: { repository?: ManagedSiteLiveConnectorRepository; managedRepository?: ManagedSiteRepository } = {}) {
  if (!isOpaqueReference(input.targetKey, 120) || !isOpaqueReference(input.idempotencyKey, 128)) invalid('Release target or idempotency identity is invalid.')
  const repository = dependencies.repository || getManagedSiteLiveConnectorRepository()
  const managedRepository = dependencies.managedRepository || getManagedSiteRepository()
  const project = await managedRepository.findProject(ownerUserId, input.projectId)
  const candidate = await repository.findGenerationCandidate(ownerUserId, input.generationCandidateId)
  const commerce = project ? await repository.findPrePurchaseBinding(ownerUserId, project.id) : null
  if (!project || !candidate || candidate.projectId !== project.id || !commerce || commerce.sourceVersionId !== candidate.sourceVersionId) throw createError({ statusCode: 404, statusMessage: 'Generated release pre-purchase lineage was not found.' })
  const version = await managedRepository.findVersion(ownerUserId, candidate.sourceVersionId)
  if (!version || version.projectId !== project.id) conflict('Generated release source version does not match its project.')
  const domain = canonicalizeManagedDomain(input.canonicalDomain)
  const identity = { ownerUserId, projectId: project.id, generationCandidateId: candidate.id, versionId: version.id, previewId: commerce.previewId, quoteId: commerce.quoteId, draftOrderId: commerce.draftOrderId, commerceSnapshotFingerprint: commerce.commerceSnapshotFingerprint, releaseKind: 'generated_site' as const, targetKey: input.targetKey, canonicalDomain: domain.canonicalDomain, contentHash: candidate.contentHash }
  const projectionFingerprint = releaseFingerprint(identity)
  const replay = await repository.findReleaseByIdempotency(ownerUserId, input.idempotencyKey)
  if (replay) {
    if (replay.projectionFingerprint !== projectionFingerprint) conflict('Release idempotency key was already used for another immutable candidate or target.')
    return { release: replay, replayed: true }
  }
  const release = await repository.insertRelease({ ...identity, status: 'candidate', previewUrl: null, providerPreviewId: null, approvalFingerprint: null, approvedAt: null, activeDeploymentReceiptFingerprint: null, rollbackFromReleaseId: null, blockedReasonCode: null, nextSafeAction: 'build_preview', projectionFingerprint, idempotencyKey: input.idempotencyKey } as any)
  return { release, replayed: false }
}

export async function createExistingSiteRelease(ownerUserId: number, input: { projectId: number; canonicalDomain: string; targetKey: string; idempotencyKey: string }, dependencies: { repository?: ManagedSiteLiveConnectorRepository; managedRepository?: ManagedSiteRepository } = {}) {
  if (!isOpaqueReference(input.targetKey, 120) || !isOpaqueReference(input.idempotencyKey, 128)) invalid('Existing-site target or idempotency identity is invalid.')
  const repository = dependencies.repository || getManagedSiteLiveConnectorRepository()
  const managedRepository = dependencies.managedRepository || getManagedSiteRepository()
  const project = await managedRepository.findProject(ownerUserId, input.projectId)
  if (!project?.activeVersionId) throw createError({ statusCode: 404, statusMessage: 'Existing managed-site project and active version were not found.' })
  const version = await managedRepository.findVersion(ownerUserId, project.activeVersionId)
  if (!version || version.projectId !== project.id) conflict('Existing-site active version lineage is invalid.')
  const domain = canonicalizeManagedDomain(input.canonicalDomain)
  const projectDomain = (() => { try { return canonicalizeManagedDomain(new URL(project.canonicalWebsiteIdentity).hostname).canonicalDomain } catch { return null } })()
  if (projectDomain && projectDomain !== domain.canonicalDomain) conflict('Existing-site domain does not match the canonical project website identity.')
  const contentHash = stableFingerprint({ versionFingerprint: version.versionFingerprint, ownershipTarget: domain.canonicalDomain })
  const identity = { ownerUserId, projectId: project.id, generationCandidateId: null, versionId: version.id, previewId: null, quoteId: null, draftOrderId: null, commerceSnapshotFingerprint: null, releaseKind: 'existing_site' as const, targetKey: input.targetKey, canonicalDomain: domain.canonicalDomain, contentHash }
  const projectionFingerprint = releaseFingerprint(identity)
  const replay = await repository.findReleaseByIdempotency(ownerUserId, input.idempotencyKey)
  if (replay) {
    if (replay.projectionFingerprint !== projectionFingerprint) conflict('Existing-site release idempotency key collides with another target.')
    return { release: replay, replayed: true }
  }
  const release = await repository.insertRelease({ ...identity, status: 'candidate', previewUrl: null, providerPreviewId: null, approvalFingerprint: null, approvedAt: null, activeDeploymentReceiptFingerprint: null, rollbackFromReleaseId: null, blockedReasonCode: 'OWNERSHIP_NOT_VERIFIED', nextSafeAction: 'verify_existing_site_ownership', projectionFingerprint, idempotencyKey: input.idempotencyKey } as any)
  return { release, replayed: false }
}

function validateDeploymentReceipt(receipt: ManagedSiteDeploymentReceipt, expected: { providerKey: string; projectId: number; versionId: number; contentHash: string; canonicalDomain: string; status: ManagedSiteDeploymentReceipt['status'] }): void {
  if (receipt.providerKey !== expected.providerKey || receipt.projectId !== expected.projectId || receipt.versionId !== expected.versionId || receipt.contentHash !== expected.contentHash || receipt.canonicalDomain !== expected.canonicalDomain || receipt.status !== expected.status) conflict('Deployment receipt does not match the exact project, version, content hash, domain, provider, and requested state.')
  if (!isOpaqueReference(receipt.providerEventId, 160) || !isOpaqueReference(receipt.providerDeploymentId, 160) || !isOpaqueReference(receipt.exactResponseIdentity, 256)) conflict('Deployment receipt external identity is incomplete.')
  const observedAt = new Date(receipt.observedAt)
  const expectedPayloadHash = stableFingerprint({ providerKey: receipt.providerKey, providerEventId: receipt.providerEventId, providerDeploymentId: receipt.providerDeploymentId, projectId: receipt.projectId, versionId: receipt.versionId, contentHash: receipt.contentHash, canonicalDomain: receipt.canonicalDomain, deploymentUrl: receipt.deploymentUrl, status: receipt.status, observedAt: receipt.observedAt })
  if (!Number.isFinite(observedAt.getTime()) || receipt.payloadHash !== expectedPayloadHash) conflict('Deployment receipt timestamp or canonical payload hash is invalid.')
  const canonicalUrl = assertPublicHttpsUrl(receipt.deploymentUrl, 'Deployment receipt URL')
  if (expected.status !== 'preview_ready' && new URL(canonicalUrl).hostname !== expected.canonicalDomain) conflict('Production deployment receipt URL does not match the canonical domain.')
}

async function createDeploymentAttempt(ownerUserId: number, input: { projectId: number; releaseId: number; operation: string; executionMode: 'mocked' | 'live'; requestFingerprint: string; idempotencyKey: string }, repository: ManagedSiteLiveConnectorRepository) {
  let attempt = await repository.findAttemptByIdempotency(ownerUserId, input.idempotencyKey)
  if (attempt && attempt.requestFingerprint !== input.requestFingerprint) conflict('Deployment idempotency key collides with another request fingerprint.')
  if (!attempt) attempt = await repository.insertAttempt({ ownerUserId, projectId: input.projectId, draftOrderId: null, releaseId: input.releaseId, capability: 'deployment', operation: input.operation, executionMode: input.executionMode, status: 'queued', attemptNumber: 0, maxAttempts: DEPLOYMENT_MAX_ATTEMPTS, timeoutMs: DEPLOYMENT_TIMEOUT_MS, requestFingerprint: input.requestFingerprint, idempotencyKey: input.idempotencyKey, leaseOwner: null, leaseExpiresAt: null, retryEligibleAt: null, exactResponseIdentity: null, errorCode: null, errorSummary: null } as any)
  return attempt
}

async function failAttempt(ownerUserId: number, attempt: Awaited<ReturnType<typeof createDeploymentAttempt>>, leaseOwner: string, repository: ManagedSiteLiveConnectorRepository, now: Date) {
  const attemptNumber = attempt.attemptNumber + 1
  const retryEligibleAt = attemptNumber < DEPLOYMENT_MAX_ATTEMPTS ? new Date(now.getTime() + (attemptNumber === 1 ? 5 : 30) * 60_000) : null
  await repository.releaseAttemptLease(ownerUserId, attempt.id, leaseOwner, { status: retryEligibleAt ? 'retry_wait' : 'failed', attemptNumber, retryEligibleAt, exactResponseIdentity: null, errorCode: 'DEPLOYMENT_FAILED', errorSummary: 'Deployment transport or receipt validation failed; no live state was accepted.' }).catch(() => null)
  return retryEligibleAt
}

export async function buildManagedSitePreview(ownerUserId: number, input: { releaseId: number; executionMode: 'mocked' | 'live'; idempotencyKey: string }, adapter: ManagedSiteDeploymentAdapter, dependencies: { repository?: ManagedSiteLiveConnectorRepository; credentialResolver?: ManagedSiteCredentialResolver; clock?: () => Date } = {}) {
  assertExecutionMode(input.executionMode)
  const repository = dependencies.repository || getManagedSiteLiveConnectorRepository()
  const resolver = dependencies.credentialResolver || resolveManagedSiteCredential
  const clock = dependencies.clock || (() => new Date())
  const configuration = await deploymentProvider(ownerUserId, input.executionMode, repository, resolver)
  const release = await repository.findRelease(ownerUserId, input.releaseId)
  if (!release || release.releaseKind !== 'generated_site' || !release.generationCandidateId || !['candidate', 'retry_wait', 'preview_ready'].includes(release.status)) conflict('Preview build requires a generated immutable candidate release.')
  const candidate = await repository.findGenerationCandidate(ownerUserId, release.generationCandidateId)
  if (!candidate || candidate.projectId !== release.projectId || candidate.contentHash !== release.contentHash) conflict('Preview build candidate identity is incomplete or mismatched.')
  const requestFingerprint = stableFingerprint({ operation: 'preview_build', releaseId: release.id, projectId: release.projectId, versionId: release.versionId, contentHash: release.contentHash, vaultReference: candidate.vaultReference, providerKey: configuration.providerKey })
  const attempt = await createDeploymentAttempt(ownerUserId, { projectId: release.projectId, releaseId: release.id, operation: 'preview_build', executionMode: input.executionMode, requestFingerprint, idempotencyKey: input.idempotencyKey }, repository)
  if (attempt.status === 'succeeded' && release.status === 'preview_ready') {
    const receipt = (await repository.listReceipts(ownerUserId, release.projectId)).find(item => item.attemptId === attempt.id && item.receiptType === 'preview_build_verified')
    if (receipt) return { release, receipt, replayed: true }
  }
  if (release.status === 'preview_ready') conflict('Preview is already verified under a different attempt identity.')
  const leaseOwner = `preview-${randomBytes(10).toString('hex')}`
  const leased = await repository.acquireAttemptLease(ownerUserId, attempt.id, leaseOwner, clock(), DEPLOYMENT_LEASE_MS)
  if (!leased) conflict('Preview build is already leased, terminal, or waiting for retry.')
  const leasedAttemptNumber = leased.attemptNumber
  const pendingFingerprint = releaseFingerprint({ previous: release.projectionFingerprint, operation: 'preview_build', requestFingerprint })
  const pending = await repository.transitionRelease(ownerUserId, release.id, release.status, release.projectionFingerprint, { status: 'preview_pending', blockedReasonCode: null, nextSafeAction: 'wait_for_preview_build_receipt', projectionFingerprint: pendingFingerprint })
  if (!pending) {
    await repository.releaseAttemptLease(ownerUserId, leased.id, leaseOwner, { status: 'blocked', attemptNumber: leased.attemptNumber, errorCode: 'STALE_RELEASE_PROJECTION', errorSummary: 'Release changed before preview transport authority was acquired.' }).catch(() => null)
    conflict('Preview release changed concurrently before build execution.')
  }
  const pendingProjectionFingerprint = pending.projectionFingerprint
  try {
    const result = await adapter.buildPreview({ projectId: release.projectId, versionId: release.versionId, releaseId: release.id, vaultReference: candidate.vaultReference, contentHash: release.contentHash, canonicalDomain: release.canonicalDomain, requestFingerprint, timeoutMs: DEPLOYMENT_TIMEOUT_MS })
    validateDeploymentReceipt(result, { providerKey: configuration.providerKey, projectId: release.projectId, versionId: release.versionId, contentHash: release.contentHash, canonicalDomain: release.canonicalDomain, status: 'preview_ready' })
    const receiptFingerprint = stableFingerprint({ ownerUserId, releaseId: release.id, requestFingerprint, result })
    const { receipt, gates, updated } = await repository.transaction(async transaction => {
      const receipt = await transaction.insertReceipt({ ownerUserId, projectId: release.projectId, draftOrderId: release.draftOrderId, releaseId: release.id, attemptId: leased.id, capability: 'deployment', providerKey: result.providerKey, providerEventId: result.providerEventId, receiptType: 'preview_build_verified', receiptStatus: 'verified', externalReference: result.providerDeploymentId, exactResponseIdentity: result.exactResponseIdentity, requestFingerprint, contentHash: release.contentHash, canonicalDomain: release.canonicalDomain, metadata: { deploymentUrl: result.deploymentUrl, providerDeploymentId: result.providerDeploymentId, gateAuthority: false, requiresIndependentGateReceipts: true }, receiptFingerprint, verifiedAt: clock() } as any)
      const gates = await runManagedSitePreviewGates(ownerUserId, release.id, receipt.receiptFingerprint, transaction, clock)
      const updatedFingerprint = releaseFingerprint({ previous: pendingProjectionFingerprint, previewReceiptFingerprint: receiptFingerprint, gateReceipts: gates.gates.map(gate => gate.receiptFingerprint) })
      const updated = await transaction.transitionRelease(ownerUserId, release.id, 'preview_pending', pendingProjectionFingerprint, { status: 'preview_ready', previewUrl: result.deploymentUrl, providerPreviewId: result.providerDeploymentId, blockedReasonCode: null, nextSafeAction: 'inspect_preview_gates', projectionFingerprint: updatedFingerprint })
      if (!updated) conflict('Preview release changed concurrently before gate acceptance.')
      const completed = await transaction.releaseAttemptLease(ownerUserId, leased.id, leaseOwner, { status: 'succeeded', attemptNumber: leased.attemptNumber + 1, exactResponseIdentity: result.exactResponseIdentity, errorCode: null, errorSummary: null })
      if (!completed) conflict('Preview attempt lease changed before local receipt commit.')
      return { receipt, gates, updated }
    })
    return { release: updated, receipt, gates: gates.gates }
  } catch (error) {
    const retryEligibleAt = await failAttempt(ownerUserId, { ...leased, attemptNumber: leasedAttemptNumber }, leaseOwner, repository, clock())
    await repository.transitionRelease(ownerUserId, release.id, 'preview_pending', pendingProjectionFingerprint, { status: retryEligibleAt ? 'retry_wait' : 'failed', blockedReasonCode: 'PREVIEW_BUILD_FAILED', nextSafeAction: retryEligibleAt ? 'retry_preview_after_eligibility' : 'inspect_redacted_failure', projectionFingerprint: releaseFingerprint({ previous: pendingProjectionFingerprint, previewFailedAt: clock().toISOString() }) }).catch(() => null)
    throw error
  }
}

export async function approveManagedSitePreview(ownerUserId: number, input: { releaseId: number; idempotencyKey: string }, repository: ManagedSiteLiveConnectorRepository = getManagedSiteLiveConnectorRepository(), clock: () => Date = () => new Date()) {
  if (!isOpaqueReference(input.idempotencyKey, 128)) invalid('Preview approval idempotency key is invalid.')
  const release = await repository.findRelease(ownerUserId, input.releaseId)
  if (!release || !['preview_ready', 'approved'].includes(release.status) || !release.previewUrl || !release.providerPreviewId) conflict('Owner approval requires a verified preview receipt and passed preview gates.')
  const receipts = await repository.listReceipts(ownerUserId, release.projectId)
  const previewReceipt = receipts.find(receipt => receipt.releaseId === release.id && receipt.receiptType === 'preview_build_verified' && receipt.receiptStatus === 'verified' && receipt.contentHash === release.contentHash)
  if (!previewReceipt) conflict('Owner approval cannot proceed without the exact verified preview receipt.')
  const approvalFingerprint = stableFingerprint({ authority: 'owner_session', ownerUserId, releaseId: release.id, previewReceiptFingerprint: previewReceipt.receiptFingerprint, contentHash: release.contentHash, idempotencyKey: input.idempotencyKey })
  if (release.status === 'approved') {
    if (release.approvalFingerprint !== approvalFingerprint) conflict('Preview was approved under a different exact owner intent.')
    const receipt = receipts.find(item => item.releaseId === release.id && item.receiptType === 'owner_preview_approved' && item.requestFingerprint === approvalFingerprint && item.receiptStatus === 'verified')
    const humanGateReceiptFingerprint = receipt && typeof (receipt.metadata as any).humanGateReceiptFingerprint === 'string' ? (receipt.metadata as any).humanGateReceiptFingerprint : null
    const humanGate = humanGateReceiptFingerprint ? (await repository.listGateResults(ownerUserId, release.id)).find(gate => gate.receiptFingerprint === humanGateReceiptFingerprint && gate.result === 'passed') : null
    if (!receipt || !humanGate) conflict('Approved release is missing its exact append-only owner or human-review receipt.')
    return { release, receipt, humanGate, approvalFingerprint, replayed: true }
  }
  const gateInspection = await inspectManagedSitePreviewGates(ownerUserId, release.id, repository)
  if (!gateInspection.allAutomatedRequiredPassed || gateInspection.staleOrMismatched || gateInspection.humanReview?.result !== 'required' || !gateInspection.humanReview.contentHashMatches) conflict('Owner approval requires fresh, content-bound automated gates and an outstanding human review requirement.')
  const providerEventId = `approval-${approvalFingerprint.slice(0, 32)}`
  const receiptFingerprint = stableFingerprint({ ownerUserId, releaseId: release.id, approvalFingerprint })
  return repository.transaction(async transaction => {
    const observedAt = clock()
    const humanInputFingerprint = stableFingerprint({ releaseId: release.id, contentHash: release.contentHash, previewReceiptFingerprint: previewReceipt.receiptFingerprint, automatedGateReceipts: gateInspection.required.map(gate => gate.receiptFingerprint), approvalFingerprint })
    const humanReceiptFingerprint = stableFingerprint({ gateType: 'human_review', result: 'passed', humanInputFingerprint })
    const humanGate = await transaction.insertGateResult({ ownerUserId, projectId: release.projectId, versionId: release.versionId, generationCandidateId: release.generationCandidateId!, releaseId: release.id, gateType: 'human_review', inputFingerprint: humanInputFingerprint, contentHash: release.contentHash, result: 'passed', reasonCodes: ['OWNER_SESSION_EXPLICIT_APPROVAL'], limitations: ['Approval authorizes checkout only; it does not prove payment, domain, deployment, or business outcomes.'], receiptFingerprint: humanReceiptFingerprint, observedAt } as any)
    const receipt = await transaction.insertReceipt({ ownerUserId, projectId: release.projectId, draftOrderId: release.draftOrderId, releaseId: release.id, attemptId: null, capability: 'deployment', providerKey: 'discoverystack-owner-authority', providerEventId, receiptType: 'owner_preview_approved', receiptStatus: 'verified', externalReference: null, exactResponseIdentity: `owner-approval:${approvalFingerprint.slice(0, 48)}`, requestFingerprint: approvalFingerprint, contentHash: release.contentHash, canonicalDomain: release.canonicalDomain, metadata: { previewReceiptFingerprint: previewReceipt.receiptFingerprint, automatedGateReceipts: gateInspection.required.map(gate => gate.receiptFingerprint), humanGateReceiptFingerprint: humanGate.receiptFingerprint, authority: 'owner_session' }, receiptFingerprint, verifiedAt: observedAt } as any)
    const updated = await transaction.transitionRelease(ownerUserId, release.id, 'preview_ready', release.projectionFingerprint, { status: 'approved', approvalFingerprint, approvedAt: observedAt, blockedReasonCode: null, nextSafeAction: 'create_checkout_session', projectionFingerprint: releaseFingerprint({ previous: release.projectionFingerprint, approvalFingerprint, humanGateReceiptFingerprint: humanReceiptFingerprint }) })
    if (!updated) conflict('Preview release changed concurrently before owner approval committed.')
    return { release: updated, receipt, humanGate, approvalFingerprint, replayed: false }
  })
}

export async function bindManagedSiteReleasePayment(ownerUserId: number, input: { releaseId: number; paymentReceiptFingerprint: string; idempotencyKey: string }, repository: ManagedSiteLiveConnectorRepository = getManagedSiteLiveConnectorRepository(), clock: () => Date = () => new Date(), ordering: PreviewRepository = getPreviewRepository()) {
  const release = await repository.findRelease(ownerUserId, input.releaseId)
  const payment = await repository.findReceiptByFingerprint(ownerUserId, input.paymentReceiptFingerprint)
  if (!release || !['checkout_pending', 'payment_verified'].includes(release.status) || !release.approvalFingerprint || !release.previewId || !release.quoteId || !release.draftOrderId || !release.commerceSnapshotFingerprint) conflict('Release must have an exact approved checkout lineage before payment authority is bound.')
  if (!payment || payment.ownerUserId !== ownerUserId || payment.projectId !== release.projectId || payment.releaseId !== release.id || payment.draftOrderId !== release.draftOrderId || payment.receiptType !== 'checkout_succeeded' || payment.receiptStatus !== 'verified' || payment.contentHash !== release.contentHash || payment.canonicalDomain !== release.canonicalDomain) conflict('Release payment authority is not an exact verified checkout receipt for this release.')
  const [order, quote] = await Promise.all([ordering.findDraftOrderById(release.draftOrderId), ordering.findQuoteById(release.quoteId)])
  const lines = quote ? await ordering.listQuoteLines(quote.id) : []
  if (!order || !quote || order.ownerUserId !== ownerUserId || order.projectId !== release.projectId || order.previewId !== release.previewId || order.quoteId !== release.quoteId || order.status !== 'payment_verified' || quote.ownerUserId !== ownerUserId || quote.projectId !== release.projectId || quote.previewId !== release.previewId || quote.status !== 'locked') conflict('Verified payment database lineage does not match the release commerce binding.')
  const snapshot = managedSiteCommerceSnapshotFingerprint({ previewId: release.previewId, quoteId: quote.id, draftOrderId: order.id, quoteVersion: quote.quoteVersion, totalMinor: quote.totalMinor, currency: quote.currency, planKey: quote.planKey, cadenceDays: quote.cadenceDays, domainOption: quote.domainOption, taxStatus: quote.taxStatus, lines: lines.map(line => ({ lineKey: line.lineKey, quantity: line.quantity, unitAmountMinor: line.unitAmountMinor, lineAmountMinor: line.lineAmountMinor, lineFingerprint: line.lineFingerprint })) })
  const metadata = payment.metadata as Record<string, unknown>
  if (snapshot !== release.commerceSnapshotFingerprint || metadata.commerceSnapshotFingerprint !== snapshot || metadata.previewId !== release.previewId || metadata.quoteId !== release.quoteId || metadata.draftOrderId !== release.draftOrderId || metadata.amountMinor !== quote.totalMinor || metadata.currency !== quote.currency || metadata.planKey !== quote.planKey || metadata.cadenceDays !== quote.cadenceDays || metadata.domainOption !== quote.domainOption) conflict('Payment receipt price snapshot does not equal the exact release quote and order.')
  const receiptFingerprint = stableFingerprint({ ownerUserId, releaseId: release.id, paymentReceiptFingerprint: payment.receiptFingerprint, approvalFingerprint: release.approvalFingerprint, idempotencyKey: input.idempotencyKey })
  if (release.status === 'payment_verified') {
    const receipt = (await repository.listReceipts(ownerUserId, release.projectId)).find(item => item.releaseId === release.id && item.receiptType === 'release_payment_bound' && ((item.metadata as any).checkoutReceiptFingerprint === payment.receiptFingerprint || (item.metadata as any).paymentReceiptFingerprint === payment.receiptFingerprint))
    if (!receipt) conflict('Payment was bound under a different exact release payment intent.')
    return { release, receipt, replayed: true }
  }
  return repository.transaction(async transaction => {
    const receipt = await transaction.insertReceipt({ ownerUserId, projectId: release.projectId, draftOrderId: payment.draftOrderId, releaseId: release.id, attemptId: null, capability: 'payment', providerKey: payment.providerKey, providerEventId: `release-payment-${receiptFingerprint.slice(0, 32)}`, receiptType: 'release_payment_bound', receiptStatus: 'verified', externalReference: payment.externalReference, exactResponseIdentity: `release-payment:${receiptFingerprint.slice(0, 48)}`, requestFingerprint: receiptFingerprint, contentHash: release.contentHash, canonicalDomain: release.canonicalDomain, metadata: { checkoutReceiptFingerprint: payment.receiptFingerprint }, receiptFingerprint, verifiedAt: clock() } as any)
    const updated = await transaction.transitionRelease(ownerUserId, release.id, 'checkout_pending', release.projectionFingerprint, { status: 'payment_verified', blockedReasonCode: null, nextSafeAction: 'quote_domain_or_start_existing_domain_claim', projectionFingerprint: releaseFingerprint({ previous: release.projectionFingerprint, paymentReceiptFingerprint: payment.receiptFingerprint }) })
    if (!updated) conflict('Release changed concurrently before exact payment binding committed.')
    return { release: updated, receipt, replayed: false }
  })
}

export async function deployManagedSiteProduction(ownerUserId: number, input: { releaseId: number; executionMode: 'mocked' | 'live'; idempotencyKey: string }, adapter: ManagedSiteDeploymentAdapter, dependencies: { repository?: ManagedSiteLiveConnectorRepository; managedRepository?: ManagedSiteRepository; credentialResolver?: ManagedSiteCredentialResolver; clock?: () => Date } = {}) {
  assertExecutionMode(input.executionMode)
  const repository = dependencies.repository || getManagedSiteLiveConnectorRepository()
  const managedRepository = dependencies.managedRepository || getManagedSiteRepository()
  const resolver = dependencies.credentialResolver || resolveManagedSiteCredential
  const clock = dependencies.clock || (() => new Date())
  const configuration = await deploymentProvider(ownerUserId, input.executionMode, repository, resolver)
  const release = await repository.findRelease(ownerUserId, input.releaseId)
  if (!release || !['provisioning', 'retry_wait', 'live_verified', 'geo_active'].includes(release.status) || !release.approvalFingerprint || !release.generationCandidateId) conflict('Production deployment requires generated candidate, owner approval, verified payment, domain, and DNS/TLS authority.')
  const candidate = await repository.findGenerationCandidate(ownerUserId, release.generationCandidateId)
  const receipts = await repository.listReceipts(ownerUserId, release.projectId)
  if (receipts.some(receipt => receipt.releaseId === release.id && receipt.receiptType === 'payment_refunded' && receipt.receiptStatus === 'verified' && (receipt.metadata as any)?.effective === true)) conflict('Verified refund authority blocks production deployment for this release.')
  const preview = receipts.find(receipt => receipt.releaseId === release.id && receipt.receiptType === 'preview_build_verified' && receipt.contentHash === release.contentHash && receipt.receiptStatus === 'verified')
  const approval = receipts.find(receipt => receipt.releaseId === release.id && receipt.receiptType === 'owner_preview_approved' && receipt.requestFingerprint === release.approvalFingerprint && receipt.receiptStatus === 'verified')
  const payment = receipts.find(receipt => receipt.releaseId === release.id && receipt.receiptType === 'release_payment_bound' && receipt.receiptStatus === 'verified')
  const domainClaim = await repository.findDomainClaim(release.canonicalDomain)
  const domain = domainClaim?.authorityReceiptFingerprint ? await repository.findReceiptByFingerprint(ownerUserId, domainClaim.authorityReceiptFingerprint) : null
  const dnsTls = receipts.find(receipt => receipt.releaseId === release.id && receipt.receiptType === 'dns_tls_verified' && receipt.contentHash === release.contentHash && receipt.receiptStatus === 'verified')
  if (!candidate || !preview || !approval || !payment || !domainClaim || domainClaim.status !== 'verified' || domainClaim.releaseId !== release.id || !domain || domain.projectId !== release.projectId || domain.releaseId !== release.id || !dnsTls) conflict('Production deployment lineage is missing preview, approval, payment, atomic domain claim, or DNS/TLS verified authority.')
  const requestFingerprint = stableFingerprint({ operation: 'production_deploy', releaseId: release.id, projectId: release.projectId, versionId: release.versionId, contentHash: release.contentHash, canonicalDomain: release.canonicalDomain, previewReceiptFingerprint: preview.receiptFingerprint, approvalFingerprint: release.approvalFingerprint, providerKey: configuration.providerKey })
  const attempt = await createDeploymentAttempt(ownerUserId, { projectId: release.projectId, releaseId: release.id, operation: 'production_deploy', executionMode: input.executionMode, requestFingerprint, idempotencyKey: input.idempotencyKey }, repository)
  if (attempt.status === 'succeeded' && ['live_verified', 'geo_active'].includes(release.status)) {
    const receipt = receipts.find(item => item.attemptId === attempt.id && item.receiptType === 'production_deployment_verified')
    if (receipt) return { release, receipt, replayed: true }
  }
  const leaseOwner = `deploy-${randomBytes(10).toString('hex')}`
  const leased = await repository.acquireAttemptLease(ownerUserId, attempt.id, leaseOwner, clock(), DEPLOYMENT_LEASE_MS)
  if (!leased) conflict('Production deployment is already leased, terminal, or waiting for retry.')
  const pendingFingerprint = releaseFingerprint({ previous: release.projectionFingerprint, operation: 'production_deploy', requestFingerprint, status: 'deployment_pending' })
  const pending = await repository.transitionRelease(ownerUserId, release.id, release.status, release.projectionFingerprint, { status: 'deployment_pending', blockedReasonCode: null, nextSafeAction: 'wait_for_production_deployment_receipt', projectionFingerprint: pendingFingerprint })
  if (!pending) {
    await repository.releaseAttemptLease(ownerUserId, leased.id, leaseOwner, { status: 'blocked', attemptNumber: leased.attemptNumber, errorCode: 'STALE_RELEASE_PROJECTION', errorSummary: 'Release changed before production transport authority was acquired.' }).catch(() => null)
    conflict('Release changed before production deployment transport was authorized.')
  }
  const pendingProjectionFingerprint = pending.projectionFingerprint
  const leasedAttemptNumber = leased.attemptNumber
  try {
    const result = await adapter.deployProduction({ projectId: release.projectId, versionId: release.versionId, releaseId: release.id, vaultReference: candidate.vaultReference, contentHash: release.contentHash, canonicalDomain: release.canonicalDomain, previewReceiptFingerprint: preview.receiptFingerprint, approvalFingerprint: release.approvalFingerprint, requestFingerprint, timeoutMs: DEPLOYMENT_TIMEOUT_MS })
    validateDeploymentReceipt(result, { providerKey: configuration.providerKey, projectId: release.projectId, versionId: release.versionId, contentHash: release.contentHash, canonicalDomain: release.canonicalDomain, status: 'production_verified' })
    const receiptFingerprint = stableFingerprint({ ownerUserId, releaseId: release.id, requestFingerprint, result })
    const { receipt, updated } = await repository.transaction(async transaction => {
      const receipt = await transaction.insertReceipt({ ownerUserId, projectId: release.projectId, draftOrderId: payment.draftOrderId, releaseId: release.id, attemptId: leased.id, capability: 'deployment', providerKey: result.providerKey, providerEventId: result.providerEventId, receiptType: 'production_deployment_verified', receiptStatus: 'verified', externalReference: result.providerDeploymentId, exactResponseIdentity: result.exactResponseIdentity, requestFingerprint, contentHash: release.contentHash, canonicalDomain: release.canonicalDomain, metadata: { deploymentUrl: result.deploymentUrl, providerDeploymentId: result.providerDeploymentId, previewReceiptFingerprint: preview.receiptFingerprint, approvalFingerprint: release.approvalFingerprint }, receiptFingerprint, verifiedAt: clock() } as any)
      const updated = await transaction.transitionRelease(ownerUserId, release.id, 'deployment_pending', pendingProjectionFingerprint, { status: 'live_verified', activeDeploymentReceiptFingerprint: receiptFingerprint, blockedReasonCode: null, nextSafeAction: 'activate_geo', projectionFingerprint: releaseFingerprint({ previous: pendingProjectionFingerprint, deploymentReceiptFingerprint: receiptFingerprint }) })
      if (!updated) conflict('Release changed concurrently before production deployment acceptance.')
      const completed = await transaction.releaseAttemptLease(ownerUserId, leased.id, leaseOwner, { status: 'succeeded', attemptNumber: leased.attemptNumber + 1, exactResponseIdentity: result.exactResponseIdentity, errorCode: null, errorSummary: null })
      if (!completed) conflict('Production deployment attempt lease changed before receipt commit.')
      return { receipt, updated }
    })
    await managedRepository.updateProject(ownerUserId, release.projectId, { status: 'active' } as any)
    return { release: updated, receipt }
  } catch (error) {
    const retryEligibleAt = await failAttempt(ownerUserId, { ...leased, attemptNumber: leasedAttemptNumber }, leaseOwner, repository, clock())
    await repository.transitionRelease(ownerUserId, release.id, 'deployment_pending', pendingProjectionFingerprint, { status: retryEligibleAt ? 'retry_wait' : 'failed', blockedReasonCode: 'PRODUCTION_DEPLOYMENT_FAILED', nextSafeAction: retryEligibleAt ? 'retry_deployment_after_eligibility' : 'inspect_redacted_failure', projectionFingerprint: releaseFingerprint({ previous: pendingProjectionFingerprint, deploymentFailedAt: clock().toISOString() }) }).catch(() => null)
    throw error
  }
}

export async function createExistingSiteOwnershipChallenge(ownerUserId: number, input: { releaseId: number; idempotencyKey: string; executionMode?: 'mocked' | 'live' }, repository: ManagedSiteLiveConnectorRepository = getManagedSiteLiveConnectorRepository(), clock: () => Date = () => new Date(), adapter?: ManagedSiteExistingSiteOwnershipAdapter) {
  if (!isOpaqueReference(input.idempotencyKey, 128)) invalid('Existing-site challenge idempotency key is invalid.')
  const release = await repository.findRelease(ownerUserId, input.releaseId)
  if (!release || release.releaseKind !== 'existing_site' || release.status !== 'candidate') conflict('Ownership challenge requires an existing-site release candidate.')
  const requestFingerprint = stableFingerprint({ ownerUserId, projectId: release.projectId, releaseId: release.id, canonicalDomain: release.canonicalDomain, contentHash: release.contentHash, operation: 'existing_site_challenge_create' })
  const claimProjectionFingerprint = stableFingerprint({ requestFingerprint, status: 'pending' })
  const claim = await repository.insertDomainClaim({ canonicalDomain: release.canonicalDomain, activeCanonicalDomainKey: release.canonicalDomain, ownerUserId, projectId: release.projectId, releaseId: release.id, claimKind: 'existing', status: 'pending', authorityReceiptFingerprint: null, requestFingerprint, idempotencyKey: input.idempotencyKey, projectionFingerprint: claimProjectionFingerprint } as any)
  if (claim.ownerUserId !== ownerUserId || claim.projectId !== release.projectId || claim.releaseId !== release.id || claim.requestFingerprint !== requestFingerprint) conflict('Existing-site atomic domain claim replay is mismatched.')
  const providerChallenge = adapter ? await adapter.createChallenge({ ownerUserId, projectId: release.projectId, releaseId: release.id, canonicalDomain: release.canonicalDomain, verificationMethod: 'dns_txt', requestFingerprint, idempotencyKey: input.idempotencyKey, timeoutMs: DEPLOYMENT_TIMEOUT_MS }) : null
  if (providerChallenge && (providerChallenge.canonicalDomain !== release.canonicalDomain || providerChallenge.projectId !== release.projectId || providerChallenge.verificationMethod !== 'dns_txt' || !isOpaqueReference(providerChallenge.providerEventId, 160) || !isOpaqueReference(providerChallenge.challengeReference, 160) || !isOpaqueReference(providerChallenge.exactResponseIdentity, 256))) conflict('Existing-site challenge provider response is mismatched.')
  const challengeReference = providerChallenge?.challengeReference || `dns-challenge-${stableFingerprint({ requestFingerprint, claimId: claim.id }).slice(0, 36)}`
  const receiptFingerprint = stableFingerprint({ requestFingerprint, challengeReference })
  const receipt = await repository.insertReceipt({ ownerUserId, projectId: release.projectId, draftOrderId: null, releaseId: release.id, attemptId: null, capability: 'dns_tls', providerKey: providerChallenge?.providerKey || 'discoverystack-ownership-challenge', providerEventId: providerChallenge?.providerEventId || `challenge-${receiptFingerprint.slice(0, 32)}`, receiptType: 'existing_site_challenge_created', receiptStatus: 'verified', externalReference: challengeReference, exactResponseIdentity: providerChallenge?.exactResponseIdentity || `ownership-challenge:${receiptFingerprint.slice(0, 48)}`, requestFingerprint, contentHash: release.contentHash, canonicalDomain: release.canonicalDomain, metadata: { verificationMethod: 'dns_txt', challengeValueHash: stableFingerprint(challengeReference), expiresAt: new Date(clock().getTime() + 24 * 60 * 60_000).toISOString(), mutatesDns: false }, receiptFingerprint, verifiedAt: clock() } as any)
  return { release, claim, receipt, challengeReference, externalMutation: false }
}

export async function verifyExistingSiteOwnership(ownerUserId: number, input: { releaseId: number; challengeReceiptFingerprint: string; executionMode: 'mocked' | 'live'; idempotencyKey: string }, adapter: ManagedSiteExistingSiteOwnershipAdapter, dependencies: { repository?: ManagedSiteLiveConnectorRepository; credentialResolver?: ManagedSiteCredentialResolver; clock?: () => Date } = {}) {
  assertExecutionMode(input.executionMode)
  if (!/^[a-f0-9]{64}$/u.test(input.challengeReceiptFingerprint)) invalid('Existing-site ownership challenge receipt is invalid.')
  const repository = dependencies.repository || getManagedSiteLiveConnectorRepository()
  const resolver = dependencies.credentialResolver || resolveManagedSiteCredential
  const clock = dependencies.clock || (() => new Date())
  const configuration = input.executionMode === 'live' ? await requireVerifiedManagedSiteProvider(ownerUserId, 'dns_tls', repository, resolver) : await repository.findProviderConfiguration(ownerUserId, 'dns_tls')
  if (!configuration || input.executionMode === 'mocked' && !['mock', 'verified'].includes(configuration.readinessStatus)) unavailable('Existing-site ownership verification provider is not configured.')
  const release = await repository.findRelease(ownerUserId, input.releaseId)
  if (release?.releaseKind === 'existing_site' && release.status === 'live_verified') {
    const attempt = await repository.findAttemptByIdempotency(ownerUserId, input.idempotencyKey)
    const receipt = attempt?.status === 'succeeded' ? (await repository.listReceipts(ownerUserId, release.projectId)).find(item => item.attemptId === attempt.id && item.receiptType === 'existing_site_ownership_verified') : null
    if (receipt) return { release, receipt, replayed: true }
    conflict('Existing-site ownership is already verified under another request identity.')
  }
  if (!release || release.releaseKind !== 'existing_site' || !['candidate', 'retry_wait'].includes(release.status)) conflict('Ownership verification requires an existing-site release candidate.')
  const claim = await repository.findDomainClaim(release.canonicalDomain)
  const challenge = await repository.findReceiptByFingerprint(ownerUserId, input.challengeReceiptFingerprint)
  if (!claim || claim.status !== 'pending' || claim.ownerUserId !== ownerUserId || claim.projectId !== release.projectId || claim.releaseId !== release.id || !challenge || challenge.releaseId !== release.id || challenge.receiptType !== 'existing_site_challenge_created' || !challenge.externalReference || new Date(String((challenge.metadata as any).expiresAt)).getTime() <= clock().getTime()) conflict('Existing-site challenge is stale, mismatched, or lacks the atomic domain claim.')
  const challengeReference = challenge.externalReference
  const requestFingerprint = stableFingerprint({ ownerUserId, projectId: release.projectId, releaseId: release.id, canonicalDomain: release.canonicalDomain, challengeReceiptFingerprint: challenge.receiptFingerprint, challengeReference, providerKey: configuration.providerKey })
  const attempt = await createDeploymentAttempt(ownerUserId, { projectId: release.projectId, releaseId: release.id, operation: 'existing_site_ownership_verify', executionMode: input.executionMode, requestFingerprint, idempotencyKey: input.idempotencyKey }, repository)
  const leaseOwner = `ownership-${randomBytes(10).toString('hex')}`
  const leased = await repository.acquireAttemptLease(ownerUserId, attempt.id, leaseOwner, clock(), DEPLOYMENT_LEASE_MS)
  if (!leased) conflict('Ownership verification is already leased, terminal, or waiting for retry.')
  try {
    const result = await adapter.verify({ projectId: release.projectId, canonicalDomain: release.canonicalDomain, challengeReference, requestFingerprint, timeoutMs: DEPLOYMENT_TIMEOUT_MS })
    if (result.providerKey !== configuration.providerKey || result.projectId !== release.projectId || result.canonicalDomain !== release.canonicalDomain || result.status !== 'verified' || !/^[a-f0-9]{64}$/u.test(result.evidenceHash) || !isOpaqueReference(result.providerEventId, 160) || !isOpaqueReference(result.providerReference, 160) || !isOpaqueReference(result.exactResponseIdentity, 256)) conflict('Existing-site ownership receipt is incomplete or mismatched.')
    const receiptFingerprint = stableFingerprint({ ownerUserId, releaseId: release.id, requestFingerprint, result })
    const { receipt, updated } = await repository.transaction(async transaction => {
      const receipt = await transaction.insertReceipt({ ownerUserId, projectId: release.projectId, draftOrderId: null, releaseId: release.id, attemptId: leased.id, capability: 'dns_tls', providerKey: result.providerKey, providerEventId: result.providerEventId, receiptType: 'existing_site_ownership_verified', receiptStatus: 'verified', externalReference: result.providerReference, exactResponseIdentity: result.exactResponseIdentity, requestFingerprint, contentHash: release.contentHash, canonicalDomain: release.canonicalDomain, metadata: { verificationMethod: result.verificationMethod, evidenceHash: result.evidenceHash }, receiptFingerprint, verifiedAt: clock() } as any)
      const claimUpdated = await transaction.transitionDomainClaim(ownerUserId, claim.id, 'pending', claim.projectionFingerprint, { status: 'verified', authorityReceiptFingerprint: receiptFingerprint, projectionFingerprint: stableFingerprint({ previous: claim.projectionFingerprint, receiptFingerprint, status: 'verified' }) })
      if (!claimUpdated) conflict('Existing-site domain claim changed concurrently before verification acceptance.')
      const updated = await transaction.transitionRelease(ownerUserId, release.id, release.status, release.projectionFingerprint, { status: 'live_verified', activeDeploymentReceiptFingerprint: receiptFingerprint, blockedReasonCode: null, nextSafeAction: 'activate_geo', projectionFingerprint: releaseFingerprint({ previous: release.projectionFingerprint, ownershipReceiptFingerprint: receiptFingerprint }) })
      if (!updated) conflict('Existing-site release changed concurrently before ownership acceptance.')
      const completed = await transaction.releaseAttemptLease(ownerUserId, leased.id, leaseOwner, { status: 'succeeded', attemptNumber: leased.attemptNumber + 1, exactResponseIdentity: result.exactResponseIdentity, errorCode: null, errorSummary: null })
      if (!completed) conflict('Ownership verification attempt lease changed before receipt commit.')
      return { receipt, updated }
    })
    return { release: updated, receipt }
  } catch (error) {
    const retryEligibleAt = await failAttempt(ownerUserId, leased, leaseOwner, repository, clock())
    await repository.transitionRelease(ownerUserId, release.id, release.status, release.projectionFingerprint, { status: retryEligibleAt ? 'retry_wait' : 'blocked', blockedReasonCode: 'OWNERSHIP_VERIFICATION_FAILED', nextSafeAction: retryEligibleAt ? 'retry_ownership_after_eligibility' : 'replace_ownership_challenge', projectionFingerprint: releaseFingerprint({ previous: release.projectionFingerprint, ownershipFailedAt: clock().toISOString() }) }).catch(() => null)
    throw error
  }
}

export async function activateManagedSiteGeoOperations(ownerUserId: number, input: { releaseId: number; timeZone: string; cadenceDays: 3 | 7 | 15 | 30; monthlyBudgetUnits: number; idempotencyKey: string }, dependencies: { repository?: ManagedSiteLiveConnectorRepository; managedRepository?: ManagedSiteRepository; activate?: typeof linkManagedSiteContentOperations; clock?: () => Date } = {}) {
  const repository = dependencies.repository || getManagedSiteLiveConnectorRepository()
  const managedRepository = dependencies.managedRepository || getManagedSiteRepository()
  const clock = dependencies.clock || (() => new Date())
  const release = await repository.findRelease(ownerUserId, input.releaseId)
  const project = release ? await managedRepository.findProject(ownerUserId, release.projectId) : null
  if (!release || !project || !['live_verified', 'geo_active'].includes(release.status) || !release.activeDeploymentReceiptFingerprint) conflict('GEO/content activation requires a provider-verified live site or verified existing-site ownership receipt.')
  const authorityReceipt = await repository.findReceiptByFingerprint(ownerUserId, release.activeDeploymentReceiptFingerprint)
  if (!authorityReceipt || authorityReceipt.projectId !== release.projectId || !['production_deployment_verified', 'existing_site_ownership_verified'].includes(authorityReceipt.receiptType) || authorityReceipt.receiptStatus !== 'verified') conflict('GEO/content activation live-site authority receipt is invalid.')
  const activationRequestFingerprint = stableFingerprint({ ownerUserId, projectId: project.id, releaseId: release.id, liveAuthorityReceipt: authorityReceipt.receiptFingerprint, timeZone: input.timeZone, cadenceDays: input.cadenceDays, monthlyBudgetUnits: input.monthlyBudgetUnits, idempotencyKey: input.idempotencyKey })
  if (release.status === 'geo_active') {
    const receipt = (await repository.listReceipts(ownerUserId, release.projectId)).find(item => item.releaseId === release.id && item.receiptType === 'geo_subscription_activated' && item.requestFingerprint === activationRequestFingerprint && item.receiptStatus === 'verified')
    if (!receipt) conflict('GEO/content operations were activated under a different exact activation intent.')
    return { release, receipt, contentOperations: { replayed: true, contentOperationClientId: receipt.externalReference }, replayed: true }
  }
  const activate = dependencies.activate || linkManagedSiteContentOperations
  const client = await activate(ownerUserId, project.id, { displayName: project.canonicalClientIdentity, canonicalSiteOrigin: `https://${release.canonicalDomain}`, framework: 'astro', publicationTransport: 'first_party_signed_api', timeZone: input.timeZone, defaultCadenceDays: input.cadenceDays, defaultPublishLocalTime: '09:00', monthlyBudgetUnits: input.monthlyBudgetUnits, idempotencyKey: input.idempotencyKey }, managedRepository as any, undefined as any)
  const receiptFingerprint = stableFingerprint({ activationRequestFingerprint, contentOperationClientId: (client as any).client?.id || (client as any).contentOperationClientId })
  const receipt = await repository.insertReceipt({ ownerUserId, projectId: project.id, draftOrderId: authorityReceipt.draftOrderId, releaseId: release.id, attemptId: null, capability: 'deployment', providerKey: 'discoverystack-content-operations', providerEventId: `geo-activation-${receiptFingerprint.slice(0, 32)}`, receiptType: 'geo_subscription_activated', receiptStatus: 'verified', externalReference: String((client as any).client?.id || project.contentOperationClientId || ''), exactResponseIdentity: `content-operations:${receiptFingerprint.slice(0, 48)}`, requestFingerprint: activationRequestFingerprint, contentHash: release.contentHash, canonicalDomain: release.canonicalDomain, metadata: { liveAuthorityReceipt: authorityReceipt.receiptFingerprint, reusedCanonicalContentOperations: true, measurementStartsAfterVerifiedLiveSite: true }, receiptFingerprint, verifiedAt: clock() } as any)
  const updated = await repository.transitionRelease(ownerUserId, release.id, 'live_verified', release.projectionFingerprint, { status: 'geo_active', blockedReasonCode: null, nextSafeAction: 'operate_existing_content_calendar_and_measurement', projectionFingerprint: releaseFingerprint({ previous: release.projectionFingerprint, geoActivationReceipt: receiptFingerprint }) })
  if (!updated) conflict('Release changed concurrently before GEO activation committed.')
  return { release: updated, receipt, contentOperations: client, replayed: false }
}

export async function rollbackManagedSiteRelease(ownerUserId: number, input: { fromReleaseId: number; toReleaseId: number; executionMode: 'mocked' | 'live'; idempotencyKey: string }, adapter: ManagedSiteDeploymentAdapter, dependencies: { repository?: ManagedSiteLiveConnectorRepository; credentialResolver?: ManagedSiteCredentialResolver; clock?: () => Date } = {}) {
  assertExecutionMode(input.executionMode)
  const repository = dependencies.repository || getManagedSiteLiveConnectorRepository()
  const resolver = dependencies.credentialResolver || resolveManagedSiteCredential
  const clock = dependencies.clock || (() => new Date())
  const configuration = await deploymentProvider(ownerUserId, input.executionMode, repository, resolver)
  const from = await repository.findRelease(ownerUserId, input.fromReleaseId)
  const to = await repository.findRelease(ownerUserId, input.toReleaseId)
  if (!from || !to || from.id === to.id || from.projectId !== to.projectId || from.canonicalDomain !== to.canonicalDomain || !['live_verified', 'geo_active', 'rolled_back'].includes(from.status) || !to.activeDeploymentReceiptFingerprint) conflict('Rollback requires two owner-scoped releases for the same project/domain and a prior verified deployment receipt.')
  const replayAttempt = await repository.findAttemptByIdempotency(ownerUserId, input.idempotencyKey)
  if (replayAttempt?.status === 'succeeded' && from.status === 'rolled_back') {
    const receipt = (await repository.listReceipts(ownerUserId, to.projectId)).find(item => item.attemptId === replayAttempt.id && item.receiptType === 'rollback_deployment_verified')
    if (receipt) return { release: to, receipt, replayed: true }
  }
  const priorReceipt = await repository.findReceiptByFingerprint(ownerUserId, to.activeDeploymentReceiptFingerprint)
  if (!priorReceipt || priorReceipt.receiptType !== 'production_deployment_verified' || priorReceipt.contentHash !== to.contentHash || priorReceipt.receiptStatus !== 'verified') conflict('Rollback target is not bound to a prior exact verified production deployment.')
  const requestFingerprint = stableFingerprint({ operation: 'rollback', fromReleaseId: from.id, toReleaseId: to.id, priorDeploymentReceiptFingerprint: priorReceipt.receiptFingerprint, targetContentHash: to.contentHash })
  const attempt = await createDeploymentAttempt(ownerUserId, { projectId: from.projectId, releaseId: to.id, operation: 'rollback', executionMode: input.executionMode, requestFingerprint, idempotencyKey: input.idempotencyKey }, repository)
  if (attempt.status === 'succeeded' && from.status === 'rolled_back') {
    const receipt = (await repository.listReceipts(ownerUserId, to.projectId)).find(item => item.attemptId === attempt.id && item.receiptType === 'rollback_deployment_verified')
    if (receipt) return { release: to, receipt, replayed: true }
  }
  const leaseOwner = `rollback-${randomBytes(10).toString('hex')}`
  const leased = await repository.acquireAttemptLease(ownerUserId, attempt.id, leaseOwner, clock(), DEPLOYMENT_LEASE_MS)
  if (!leased) conflict('Rollback is already leased, terminal, or waiting for retry.')
  const leasedAttemptNumber = leased.attemptNumber
  const rollbackPendingFingerprint = releaseFingerprint({ previous: from.projectionFingerprint, operation: 'rollback', requestFingerprint, status: 'rollback_pending' })
  const pendingFrom = await repository.transitionRelease(ownerUserId, from.id, from.status, from.projectionFingerprint, { status: 'rollback_pending', blockedReasonCode: null, nextSafeAction: 'wait_for_rollback_receipt', projectionFingerprint: rollbackPendingFingerprint })
  if (!pendingFrom) {
    await repository.releaseAttemptLease(ownerUserId, leased.id, leaseOwner, { status: 'blocked', attemptNumber: leased.attemptNumber, errorCode: 'STALE_RELEASE_PROJECTION', errorSummary: 'Release changed before rollback transport authority was acquired.' }).catch(() => null)
    conflict('Rollback source changed before transport was authorized.')
  }
  const pendingFromProjectionFingerprint = pendingFrom.projectionFingerprint
  try {
    const result = await adapter.rollback({ projectId: from.projectId, fromReleaseId: from.id, toReleaseId: to.id, versionId: to.versionId, contentHash: to.contentHash, canonicalDomain: to.canonicalDomain, priorDeploymentReceiptFingerprint: priorReceipt.receiptFingerprint, requestFingerprint, timeoutMs: DEPLOYMENT_TIMEOUT_MS })
    validateDeploymentReceipt(result, { providerKey: configuration.providerKey, projectId: to.projectId, versionId: to.versionId, contentHash: to.contentHash, canonicalDomain: to.canonicalDomain, status: 'rollback_verified' })
    const receiptFingerprint = stableFingerprint({ ownerUserId, requestFingerprint, result })
    const { target, receipt } = await repository.transaction(async transaction => {
      const receipt = await transaction.insertReceipt({ ownerUserId, projectId: to.projectId, draftOrderId: priorReceipt.draftOrderId, releaseId: to.id, attemptId: leased.id, capability: 'deployment', providerKey: result.providerKey, providerEventId: result.providerEventId, receiptType: 'rollback_deployment_verified', receiptStatus: 'verified', externalReference: result.providerDeploymentId, exactResponseIdentity: result.exactResponseIdentity, requestFingerprint, contentHash: to.contentHash, canonicalDomain: to.canonicalDomain, metadata: { fromReleaseId: from.id, toReleaseId: to.id, priorDeploymentReceiptFingerprint: priorReceipt.receiptFingerprint }, receiptFingerprint, verifiedAt: clock() } as any)
      const fromUpdated = await transaction.transitionRelease(ownerUserId, from.id, 'rollback_pending', pendingFromProjectionFingerprint, { status: 'rolled_back', blockedReasonCode: null, nextSafeAction: 'retain_for_audit', projectionFingerprint: releaseFingerprint({ previous: pendingFromProjectionFingerprint, rolledBackTo: to.id, receiptFingerprint }) })
      if (!fromUpdated) conflict('Rollback source release changed concurrently.')
      const toUpdated = await transaction.transitionRelease(ownerUserId, to.id, to.status, to.projectionFingerprint, { status: 'live_verified', activeDeploymentReceiptFingerprint: receiptFingerprint, rollbackFromReleaseId: from.id, blockedReasonCode: null, nextSafeAction: 'reactivate_geo_if_required', projectionFingerprint: releaseFingerprint({ previous: to.projectionFingerprint, rollbackFrom: from.id, receiptFingerprint }) })
      if (!toUpdated) conflict('Rollback target release changed concurrently.')
      const completed = await transaction.releaseAttemptLease(ownerUserId, leased.id, leaseOwner, { status: 'succeeded', attemptNumber: leasedAttemptNumber + 1, exactResponseIdentity: result.exactResponseIdentity, errorCode: null, errorSummary: null })
      if (!completed) conflict('Rollback attempt lease changed before receipt commit.')
      return { target: toUpdated, receipt }
    })
    return { release: target, receipt }
  } catch (error) {
    await failAttempt(ownerUserId, { ...leased, attemptNumber: leasedAttemptNumber }, leaseOwner, repository, clock())
    await repository.transitionRelease(ownerUserId, from.id, 'rollback_pending', pendingFromProjectionFingerprint, { status: 'retry_wait', blockedReasonCode: 'ROLLBACK_FAILED', nextSafeAction: 'retry_rollback_after_eligibility', projectionFingerprint: releaseFingerprint({ previous: pendingFromProjectionFingerprint, rollbackFailedAt: clock().toISOString() }) }).catch(() => null)
    throw error
  }
}

export function createMockManagedSiteDeploymentAdapter(options: { providerKey?: string; failOperations?: Partial<Record<'preview' | 'deploy' | 'rollback', number>>; collision?: Partial<ManagedSiteDeploymentReceipt>; now?: () => Date } = {}): ManagedSiteDeploymentAdapter {
  const providerKey = options.providerKey || 'mock-deployment'
  const counters = { preview: 0, deploy: 0, rollback: 0 }
  const maybeFail = (operation: keyof typeof counters) => { counters[operation]++; if (counters[operation] <= (options.failOperations?.[operation] || 0)) throw Object.assign(new Error('synthetic provider timeout'), { code: 'TIMEOUT', retryable: true }) }
  const receipt = (input: { projectId: number; versionId: number; contentHash: string; canonicalDomain: string; requestFingerprint: string }, status: ManagedSiteDeploymentReceipt['status']): ManagedSiteDeploymentReceipt => { const core = { providerKey, providerEventId: `${status}-${stableFingerprint(input).slice(0, 24)}`, providerDeploymentId: `deployment-${stableFingerprint({ input, status }).slice(0, 24)}`, projectId: input.projectId, versionId: input.versionId, contentHash: input.contentHash, canonicalDomain: input.canonicalDomain, deploymentUrl: status === 'preview_ready' ? `https://preview-${stableFingerprint(input).slice(0, 16)}.preview.discoverystack.dev` : `https://${input.canonicalDomain}`, status, observedAt: (options.now || (() => new Date('2026-08-27T00:00:00.000Z')))().toISOString() }; return { ...core, payloadHash: stableFingerprint(core), exactResponseIdentity: `deployment-response:${stableFingerprint({ input, status }).slice(0, 32)}`, ...options.collision } }
  return {
    async buildPreview(input) { maybeFail('preview'); return receipt(input, 'preview_ready') },
    async deployProduction(input) { maybeFail('deploy'); return receipt(input, 'production_verified') },
    async rollback(input) { maybeFail('rollback'); return receipt(input, 'rollback_verified') },
  }
}

export function createMockExistingSiteOwnershipAdapter(providerKey = 'mock-dns-tls'): ManagedSiteExistingSiteOwnershipAdapter {
  return {
    async createChallenge(input) { return { providerKey, providerEventId: `ownership-challenge-${stableFingerprint(input).slice(0, 20)}`, challengeReference: `challenge-${stableFingerprint(input).slice(0, 24)}`, canonicalDomain: input.canonicalDomain, projectId: input.projectId, verificationMethod: input.verificationMethod, exactResponseIdentity: `ownership-challenge-response:${stableFingerprint(input).slice(0, 24)}` } },
    async verify(input): Promise<ManagedSiteExistingSiteOwnershipReceipt> { return { providerKey, providerEventId: `ownership-${stableFingerprint(input).slice(0, 24)}`, providerReference: `ownership-ref-${input.projectId}`, canonicalDomain: input.canonicalDomain, projectId: input.projectId, verificationMethod: 'dns_txt', evidenceHash: stableFingerprint({ challengeReference: input.challengeReference, canonicalDomain: input.canonicalDomain }), status: 'verified', exactResponseIdentity: `ownership-response:${stableFingerprint(input).slice(0, 32)}` } },
  }
}

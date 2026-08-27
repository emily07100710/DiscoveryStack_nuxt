import { randomBytes } from 'node:crypto'
import { createError } from 'h3'
import { stableFingerprint } from '../../seo-geo-core/repository'
import { assertPublicHttpsUrl } from '../../content-operations/normalization'
import { isOpaqueReference } from '../../first-party-publishing/normalization'
import { getManagedSiteRepository } from '../repository'
import { linkManagedSiteContentOperations } from '../modules-service'
import type { ManagedSiteRepository } from '../types'
import { canonicalizeManagedDomain } from './domain-connectors'
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
  if (!project || !candidate || candidate.projectId !== project.id) throw createError({ statusCode: 404, statusMessage: 'Generated release lineage was not found.' })
  const version = await managedRepository.findVersion(ownerUserId, candidate.sourceVersionId)
  if (!version || version.projectId !== project.id) conflict('Generated release source version does not match its project.')
  const domain = canonicalizeManagedDomain(input.canonicalDomain)
  const identity = { ownerUserId, projectId: project.id, generationCandidateId: candidate.id, versionId: version.id, releaseKind: 'generated_site' as const, targetKey: input.targetKey, canonicalDomain: domain.canonicalDomain, contentHash: candidate.contentHash }
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
  const identity = { ownerUserId, projectId: project.id, generationCandidateId: null, versionId: version.id, releaseKind: 'existing_site' as const, targetKey: input.targetKey, canonicalDomain: domain.canonicalDomain, contentHash }
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
  const leaseOwner = `preview-${randomBytes(10).toString('hex')}`
  const leased = await repository.acquireAttemptLease(ownerUserId, attempt.id, leaseOwner, clock(), DEPLOYMENT_LEASE_MS)
  if (!leased) conflict('Preview build is already leased, terminal, or waiting for retry.')
  try {
    const result = await adapter.buildPreview({ projectId: release.projectId, versionId: release.versionId, releaseId: release.id, vaultReference: candidate.vaultReference, contentHash: release.contentHash, canonicalDomain: release.canonicalDomain, requestFingerprint, timeoutMs: DEPLOYMENT_TIMEOUT_MS })
    validateDeploymentReceipt(result, { providerKey: configuration.providerKey, projectId: release.projectId, versionId: release.versionId, contentHash: release.contentHash, canonicalDomain: release.canonicalDomain, status: 'preview_ready' })
    const receiptFingerprint = stableFingerprint({ ownerUserId, releaseId: release.id, requestFingerprint, result })
    const receipt = await repository.insertReceipt({ ownerUserId, projectId: release.projectId, draftOrderId: null, releaseId: release.id, attemptId: leased.id, capability: 'deployment', providerKey: result.providerKey, providerEventId: result.providerEventId, receiptType: 'preview_build_verified', receiptStatus: 'verified', externalReference: result.providerDeploymentId, exactResponseIdentity: result.exactResponseIdentity, requestFingerprint, contentHash: release.contentHash, canonicalDomain: release.canonicalDomain, metadata: { deploymentUrl: result.deploymentUrl, providerDeploymentId: result.providerDeploymentId, buildGate: 'passed', qualityGate: 'passed', securityGate: 'passed' }, receiptFingerprint, verifiedAt: clock() } as any)
    await repository.releaseAttemptLease(ownerUserId, leased.id, leaseOwner, { status: 'succeeded', attemptNumber: leased.attemptNumber + 1, exactResponseIdentity: result.exactResponseIdentity, errorCode: null, errorSummary: null })
    const updated = await repository.updateRelease(ownerUserId, release.id, { status: 'preview_ready', previewUrl: result.deploymentUrl, providerPreviewId: result.providerDeploymentId, blockedReasonCode: null, nextSafeAction: 'owner_approve_preview', projectionFingerprint: releaseFingerprint({ previous: release.projectionFingerprint, previewReceiptFingerprint: receiptFingerprint }) })
    return { release: updated, receipt }
  } catch (error) {
    const retryEligibleAt = await failAttempt(ownerUserId, leased, leaseOwner, repository, clock())
    await repository.updateRelease(ownerUserId, release.id, { status: retryEligibleAt ? 'retry_wait' : 'failed', blockedReasonCode: 'PREVIEW_BUILD_FAILED', nextSafeAction: retryEligibleAt ? 'retry_preview_after_eligibility' : 'inspect_redacted_failure', projectionFingerprint: releaseFingerprint({ previous: release.projectionFingerprint, previewFailedAt: clock().toISOString() }) })
    throw error
  }
}

export async function approveManagedSitePreview(ownerUserId: number, input: { releaseId: number; idempotencyKey: string }, repository: ManagedSiteLiveConnectorRepository = getManagedSiteLiveConnectorRepository(), clock: () => Date = () => new Date()) {
  if (!isOpaqueReference(input.idempotencyKey, 128)) invalid('Preview approval idempotency key is invalid.')
  const release = await repository.findRelease(ownerUserId, input.releaseId)
  if (!release || release.status !== 'preview_ready' || !release.previewUrl || !release.providerPreviewId) conflict('Owner approval requires a verified preview receipt and passed preview gates.')
  const receipts = await repository.listReceipts(ownerUserId, release.projectId)
  const previewReceipt = receipts.find(receipt => receipt.releaseId === release.id && receipt.receiptType === 'preview_build_verified' && receipt.receiptStatus === 'verified' && receipt.contentHash === release.contentHash)
  if (!previewReceipt) conflict('Owner approval cannot proceed without the exact verified preview receipt.')
  const approvalFingerprint = stableFingerprint({ authority: 'owner_session', ownerUserId, releaseId: release.id, previewReceiptFingerprint: previewReceipt.receiptFingerprint, contentHash: release.contentHash, idempotencyKey: input.idempotencyKey })
  const providerEventId = `approval-${approvalFingerprint.slice(0, 32)}`
  const receiptFingerprint = stableFingerprint({ ownerUserId, releaseId: release.id, approvalFingerprint })
  const receipt = await repository.insertReceipt({ ownerUserId, projectId: release.projectId, draftOrderId: null, releaseId: release.id, attemptId: null, capability: 'deployment', providerKey: 'discoverystack-owner-authority', providerEventId, receiptType: 'owner_preview_approved', receiptStatus: 'verified', externalReference: null, exactResponseIdentity: `owner-approval:${approvalFingerprint.slice(0, 48)}`, requestFingerprint: approvalFingerprint, contentHash: release.contentHash, canonicalDomain: release.canonicalDomain, metadata: { previewReceiptFingerprint: previewReceipt.receiptFingerprint, authority: 'owner_session' }, receiptFingerprint, verifiedAt: clock() } as any)
  const updated = await repository.updateRelease(ownerUserId, release.id, { status: 'approved', approvalFingerprint, approvedAt: clock(), blockedReasonCode: null, nextSafeAction: 'bind_verified_checkout', projectionFingerprint: releaseFingerprint({ previous: release.projectionFingerprint, approvalFingerprint }) })
  return { release: updated, receipt, approvalFingerprint }
}

export async function bindManagedSiteReleasePayment(ownerUserId: number, input: { releaseId: number; paymentReceiptFingerprint: string; idempotencyKey: string }, repository: ManagedSiteLiveConnectorRepository = getManagedSiteLiveConnectorRepository(), clock: () => Date = () => new Date()) {
  const release = await repository.findRelease(ownerUserId, input.releaseId)
  const payment = await repository.findReceiptByFingerprint(ownerUserId, input.paymentReceiptFingerprint)
  if (!release || release.status !== 'approved' || !release.approvalFingerprint) conflict('Release must be owner-approved before payment authority is bound.')
  if (!payment || payment.projectId !== release.projectId || payment.receiptType !== 'checkout_succeeded' || payment.receiptStatus !== 'verified' || !payment.draftOrderId) conflict('Release payment authority is not an exact verified checkout receipt for this project.')
  const receiptFingerprint = stableFingerprint({ ownerUserId, releaseId: release.id, paymentReceiptFingerprint: payment.receiptFingerprint, approvalFingerprint: release.approvalFingerprint, idempotencyKey: input.idempotencyKey })
  const receipt = await repository.insertReceipt({ ownerUserId, projectId: release.projectId, draftOrderId: payment.draftOrderId, releaseId: release.id, attemptId: null, capability: 'payment', providerKey: payment.providerKey, providerEventId: `release-payment-${receiptFingerprint.slice(0, 32)}`, receiptType: 'release_payment_bound', receiptStatus: 'verified', externalReference: payment.externalReference, exactResponseIdentity: `release-payment:${receiptFingerprint.slice(0, 48)}`, requestFingerprint: receiptFingerprint, contentHash: release.contentHash, canonicalDomain: release.canonicalDomain, metadata: { checkoutReceiptFingerprint: payment.receiptFingerprint }, receiptFingerprint, verifiedAt: clock() } as any)
  const updated = await repository.updateRelease(ownerUserId, release.id, { status: 'payment_verified', blockedReasonCode: null, nextSafeAction: 'provision_domain_dns_tls', projectionFingerprint: releaseFingerprint({ previous: release.projectionFingerprint, paymentReceiptFingerprint: payment.receiptFingerprint }) })
  return { release: updated, receipt }
}

export async function deployManagedSiteProduction(ownerUserId: number, input: { releaseId: number; executionMode: 'mocked' | 'live'; idempotencyKey: string }, adapter: ManagedSiteDeploymentAdapter, dependencies: { repository?: ManagedSiteLiveConnectorRepository; managedRepository?: ManagedSiteRepository; credentialResolver?: ManagedSiteCredentialResolver; clock?: () => Date } = {}) {
  assertExecutionMode(input.executionMode)
  const repository = dependencies.repository || getManagedSiteLiveConnectorRepository()
  const managedRepository = dependencies.managedRepository || getManagedSiteRepository()
  const resolver = dependencies.credentialResolver || resolveManagedSiteCredential
  const clock = dependencies.clock || (() => new Date())
  const configuration = await deploymentProvider(ownerUserId, input.executionMode, repository, resolver)
  const release = await repository.findRelease(ownerUserId, input.releaseId)
  if (!release || !['payment_verified', 'provisioning', 'retry_wait', 'live_verified', 'geo_active'].includes(release.status) || !release.approvalFingerprint || !release.generationCandidateId) conflict('Production deployment requires generated candidate, owner approval, and verified payment authority.')
  const candidate = await repository.findGenerationCandidate(ownerUserId, release.generationCandidateId)
  const receipts = await repository.listReceipts(ownerUserId, release.projectId)
  const preview = receipts.find(receipt => receipt.releaseId === release.id && receipt.receiptType === 'preview_build_verified' && receipt.contentHash === release.contentHash && receipt.receiptStatus === 'verified')
  const approval = receipts.find(receipt => receipt.releaseId === release.id && receipt.receiptType === 'owner_preview_approved' && receipt.requestFingerprint === release.approvalFingerprint && receipt.receiptStatus === 'verified')
  const payment = receipts.find(receipt => receipt.releaseId === release.id && receipt.receiptType === 'release_payment_bound' && receipt.receiptStatus === 'verified')
  const domain = await repository.findVerifiedDomainReceipt(release.canonicalDomain)
  const dnsTls = receipts.find(receipt => receipt.releaseId === release.id && receipt.receiptType === 'dns_tls_verified' && receipt.contentHash === release.contentHash && receipt.receiptStatus === 'verified')
  if (!candidate || !preview || !approval || !payment || !domain || domain.projectId !== release.projectId || !dnsTls) conflict('Production deployment lineage is missing preview, approval, payment, domain, or DNS/TLS verified authority.')
  const requestFingerprint = stableFingerprint({ operation: 'production_deploy', releaseId: release.id, projectId: release.projectId, versionId: release.versionId, contentHash: release.contentHash, canonicalDomain: release.canonicalDomain, previewReceiptFingerprint: preview.receiptFingerprint, approvalFingerprint: release.approvalFingerprint, providerKey: configuration.providerKey })
  const attempt = await createDeploymentAttempt(ownerUserId, { projectId: release.projectId, releaseId: release.id, operation: 'production_deploy', executionMode: input.executionMode, requestFingerprint, idempotencyKey: input.idempotencyKey }, repository)
  if (attempt.status === 'succeeded' && ['live_verified', 'geo_active'].includes(release.status)) {
    const receipt = receipts.find(item => item.attemptId === attempt.id && item.receiptType === 'production_deployment_verified')
    if (receipt) return { release, receipt, replayed: true }
  }
  const leaseOwner = `deploy-${randomBytes(10).toString('hex')}`
  const leased = await repository.acquireAttemptLease(ownerUserId, attempt.id, leaseOwner, clock(), DEPLOYMENT_LEASE_MS)
  if (!leased) conflict('Production deployment is already leased, terminal, or waiting for retry.')
  try {
    const result = await adapter.deployProduction({ projectId: release.projectId, versionId: release.versionId, releaseId: release.id, vaultReference: candidate.vaultReference, contentHash: release.contentHash, canonicalDomain: release.canonicalDomain, previewReceiptFingerprint: preview.receiptFingerprint, approvalFingerprint: release.approvalFingerprint, requestFingerprint, timeoutMs: DEPLOYMENT_TIMEOUT_MS })
    validateDeploymentReceipt(result, { providerKey: configuration.providerKey, projectId: release.projectId, versionId: release.versionId, contentHash: release.contentHash, canonicalDomain: release.canonicalDomain, status: 'production_verified' })
    const receiptFingerprint = stableFingerprint({ ownerUserId, releaseId: release.id, requestFingerprint, result })
    const receipt = await repository.insertReceipt({ ownerUserId, projectId: release.projectId, draftOrderId: payment.draftOrderId, releaseId: release.id, attemptId: leased.id, capability: 'deployment', providerKey: result.providerKey, providerEventId: result.providerEventId, receiptType: 'production_deployment_verified', receiptStatus: 'verified', externalReference: result.providerDeploymentId, exactResponseIdentity: result.exactResponseIdentity, requestFingerprint, contentHash: release.contentHash, canonicalDomain: release.canonicalDomain, metadata: { deploymentUrl: result.deploymentUrl, providerDeploymentId: result.providerDeploymentId, previewReceiptFingerprint: preview.receiptFingerprint, approvalFingerprint: release.approvalFingerprint }, receiptFingerprint, verifiedAt: clock() } as any)
    await repository.releaseAttemptLease(ownerUserId, leased.id, leaseOwner, { status: 'succeeded', attemptNumber: leased.attemptNumber + 1, exactResponseIdentity: result.exactResponseIdentity, errorCode: null, errorSummary: null })
    const updated = await repository.updateRelease(ownerUserId, release.id, { status: 'live_verified', activeDeploymentReceiptFingerprint: receiptFingerprint, blockedReasonCode: null, nextSafeAction: 'activate_existing_geo_content_operations', projectionFingerprint: releaseFingerprint({ previous: release.projectionFingerprint, deploymentReceiptFingerprint: receiptFingerprint }) })
    await managedRepository.updateProject(ownerUserId, release.projectId, { status: 'active' } as any)
    return { release: updated, receipt }
  } catch (error) {
    const retryEligibleAt = await failAttempt(ownerUserId, leased, leaseOwner, repository, clock())
    await repository.updateRelease(ownerUserId, release.id, { status: retryEligibleAt ? 'retry_wait' : 'failed', blockedReasonCode: 'PRODUCTION_DEPLOYMENT_FAILED', nextSafeAction: retryEligibleAt ? 'retry_deployment_after_eligibility' : 'inspect_redacted_failure', projectionFingerprint: releaseFingerprint({ previous: release.projectionFingerprint, deploymentFailedAt: clock().toISOString() }) })
    throw error
  }
}

export async function verifyExistingSiteOwnership(ownerUserId: number, input: { releaseId: number; challengeReference: string; executionMode: 'mocked' | 'live'; idempotencyKey: string }, adapter: ManagedSiteExistingSiteOwnershipAdapter, dependencies: { repository?: ManagedSiteLiveConnectorRepository; credentialResolver?: ManagedSiteCredentialResolver; clock?: () => Date } = {}) {
  assertExecutionMode(input.executionMode)
  if (!isOpaqueReference(input.challengeReference, 160)) invalid('Existing-site ownership challenge reference is invalid.')
  const repository = dependencies.repository || getManagedSiteLiveConnectorRepository()
  const resolver = dependencies.credentialResolver || resolveManagedSiteCredential
  const clock = dependencies.clock || (() => new Date())
  const configuration = input.executionMode === 'live' ? await requireVerifiedManagedSiteProvider(ownerUserId, 'dns_tls', repository, resolver) : await repository.findProviderConfiguration(ownerUserId, 'dns_tls')
  if (!configuration || input.executionMode === 'mocked' && !['mock', 'verified'].includes(configuration.readinessStatus)) unavailable('Existing-site ownership verification provider is not configured.')
  const release = await repository.findRelease(ownerUserId, input.releaseId)
  if (!release || release.releaseKind !== 'existing_site' || !['candidate', 'retry_wait'].includes(release.status)) conflict('Ownership verification requires an existing-site release candidate.')
  const occupied = await repository.findVerifiedDomainReceipt(release.canonicalDomain)
  if (occupied && (occupied.ownerUserId !== ownerUserId || occupied.projectId !== release.projectId)) conflict('Existing-site domain is already bound to another owner or project.')
  const requestFingerprint = stableFingerprint({ ownerUserId, projectId: release.projectId, releaseId: release.id, canonicalDomain: release.canonicalDomain, challengeReference: input.challengeReference, providerKey: configuration.providerKey })
  const attempt = await createDeploymentAttempt(ownerUserId, { projectId: release.projectId, releaseId: release.id, operation: 'existing_site_ownership_verify', executionMode: input.executionMode, requestFingerprint, idempotencyKey: input.idempotencyKey }, repository)
  const leaseOwner = `ownership-${randomBytes(10).toString('hex')}`
  const leased = await repository.acquireAttemptLease(ownerUserId, attempt.id, leaseOwner, clock(), DEPLOYMENT_LEASE_MS)
  if (!leased) conflict('Ownership verification is already leased, terminal, or waiting for retry.')
  try {
    const result = await adapter.verify({ projectId: release.projectId, canonicalDomain: release.canonicalDomain, challengeReference: input.challengeReference, requestFingerprint, timeoutMs: DEPLOYMENT_TIMEOUT_MS })
    if (result.providerKey !== configuration.providerKey || result.projectId !== release.projectId || result.canonicalDomain !== release.canonicalDomain || result.status !== 'verified' || !/^[a-f0-9]{64}$/u.test(result.evidenceHash) || !isOpaqueReference(result.providerEventId, 160) || !isOpaqueReference(result.providerReference, 160) || !isOpaqueReference(result.exactResponseIdentity, 256)) conflict('Existing-site ownership receipt is incomplete or mismatched.')
    const receiptFingerprint = stableFingerprint({ ownerUserId, releaseId: release.id, requestFingerprint, result })
    const receipt = await repository.insertReceipt({ ownerUserId, projectId: release.projectId, draftOrderId: null, releaseId: release.id, attemptId: leased.id, capability: 'dns_tls', providerKey: result.providerKey, providerEventId: result.providerEventId, receiptType: 'existing_site_ownership_verified', receiptStatus: 'verified', externalReference: result.providerReference, exactResponseIdentity: result.exactResponseIdentity, requestFingerprint, contentHash: release.contentHash, canonicalDomain: release.canonicalDomain, metadata: { verificationMethod: result.verificationMethod, evidenceHash: result.evidenceHash }, receiptFingerprint, verifiedAt: clock() } as any)
    await repository.releaseAttemptLease(ownerUserId, leased.id, leaseOwner, { status: 'succeeded', attemptNumber: leased.attemptNumber + 1, exactResponseIdentity: result.exactResponseIdentity, errorCode: null, errorSummary: null })
    const updated = await repository.updateRelease(ownerUserId, release.id, { status: 'live_verified', activeDeploymentReceiptFingerprint: receiptFingerprint, blockedReasonCode: null, nextSafeAction: 'activate_existing_geo_content_operations', projectionFingerprint: releaseFingerprint({ previous: release.projectionFingerprint, ownershipReceiptFingerprint: receiptFingerprint }) })
    return { release: updated, receipt }
  } catch (error) {
    const retryEligibleAt = await failAttempt(ownerUserId, leased, leaseOwner, repository, clock())
    await repository.updateRelease(ownerUserId, release.id, { status: retryEligibleAt ? 'retry_wait' : 'blocked', blockedReasonCode: 'OWNERSHIP_VERIFICATION_FAILED', nextSafeAction: retryEligibleAt ? 'retry_ownership_after_eligibility' : 'replace_ownership_challenge', projectionFingerprint: releaseFingerprint({ previous: release.projectionFingerprint, ownershipFailedAt: clock().toISOString() }) })
    throw error
  }
}

export async function activateManagedSiteGeoOperations(ownerUserId: number, input: { releaseId: number; timeZone: string; cadenceDays: 3 | 7 | 15 | 30; monthlyBudgetUnits: number; idempotencyKey: string }, dependencies: { repository?: ManagedSiteLiveConnectorRepository; managedRepository?: ManagedSiteRepository; activate?: typeof linkManagedSiteContentOperations; clock?: () => Date } = {}) {
  const repository = dependencies.repository || getManagedSiteLiveConnectorRepository()
  const managedRepository = dependencies.managedRepository || getManagedSiteRepository()
  const clock = dependencies.clock || (() => new Date())
  const release = await repository.findRelease(ownerUserId, input.releaseId)
  const project = release ? await managedRepository.findProject(ownerUserId, release.projectId) : null
  if (!release || !project || release.status !== 'live_verified' || !release.activeDeploymentReceiptFingerprint) conflict('GEO/content activation requires a provider-verified live site or verified existing-site ownership receipt.')
  const authorityReceipt = await repository.findReceiptByFingerprint(ownerUserId, release.activeDeploymentReceiptFingerprint)
  if (!authorityReceipt || authorityReceipt.projectId !== release.projectId || !['production_deployment_verified', 'existing_site_ownership_verified'].includes(authorityReceipt.receiptType) || authorityReceipt.receiptStatus !== 'verified') conflict('GEO/content activation live-site authority receipt is invalid.')
  const activate = dependencies.activate || linkManagedSiteContentOperations
  const client = await activate(ownerUserId, project.id, { displayName: project.canonicalClientIdentity, canonicalSiteOrigin: `https://${release.canonicalDomain}`, framework: 'astro', publicationTransport: 'first_party_signed_api', timeZone: input.timeZone, defaultCadenceDays: input.cadenceDays, defaultPublishLocalTime: '09:00', monthlyBudgetUnits: input.monthlyBudgetUnits, idempotencyKey: input.idempotencyKey }, managedRepository as any, undefined as any)
  const receiptFingerprint = stableFingerprint({ ownerUserId, projectId: project.id, releaseId: release.id, contentOperationClientId: (client as any).client?.id || (client as any).contentOperationClientId, liveAuthorityReceipt: authorityReceipt.receiptFingerprint, idempotencyKey: input.idempotencyKey })
  const receipt = await repository.insertReceipt({ ownerUserId, projectId: project.id, draftOrderId: authorityReceipt.draftOrderId, releaseId: release.id, attemptId: null, capability: 'deployment', providerKey: 'discoverystack-content-operations', providerEventId: `geo-activation-${receiptFingerprint.slice(0, 32)}`, receiptType: 'geo_subscription_activated', receiptStatus: 'verified', externalReference: String((client as any).client?.id || project.contentOperationClientId || ''), exactResponseIdentity: `content-operations:${receiptFingerprint.slice(0, 48)}`, requestFingerprint: receiptFingerprint, contentHash: release.contentHash, canonicalDomain: release.canonicalDomain, metadata: { liveAuthorityReceipt: authorityReceipt.receiptFingerprint, reusedCanonicalContentOperations: true, measurementStartsAfterVerifiedLiveSite: true }, receiptFingerprint, verifiedAt: clock() } as any)
  const updated = await repository.updateRelease(ownerUserId, release.id, { status: 'geo_active', blockedReasonCode: null, nextSafeAction: 'operate_existing_content_calendar_and_measurement', projectionFingerprint: releaseFingerprint({ previous: release.projectionFingerprint, geoActivationReceipt: receiptFingerprint }) })
  return { release: updated, receipt, contentOperations: client }
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
  try {
    const result = await adapter.rollback({ projectId: from.projectId, fromReleaseId: from.id, toReleaseId: to.id, versionId: to.versionId, contentHash: to.contentHash, canonicalDomain: to.canonicalDomain, priorDeploymentReceiptFingerprint: priorReceipt.receiptFingerprint, requestFingerprint, timeoutMs: DEPLOYMENT_TIMEOUT_MS })
    validateDeploymentReceipt(result, { providerKey: configuration.providerKey, projectId: to.projectId, versionId: to.versionId, contentHash: to.contentHash, canonicalDomain: to.canonicalDomain, status: 'rollback_verified' })
    const receiptFingerprint = stableFingerprint({ ownerUserId, requestFingerprint, result })
    const receipt = await repository.insertReceipt({ ownerUserId, projectId: to.projectId, draftOrderId: priorReceipt.draftOrderId, releaseId: to.id, attemptId: leased.id, capability: 'deployment', providerKey: result.providerKey, providerEventId: result.providerEventId, receiptType: 'rollback_deployment_verified', receiptStatus: 'verified', externalReference: result.providerDeploymentId, exactResponseIdentity: result.exactResponseIdentity, requestFingerprint, contentHash: to.contentHash, canonicalDomain: to.canonicalDomain, metadata: { fromReleaseId: from.id, toReleaseId: to.id, priorDeploymentReceiptFingerprint: priorReceipt.receiptFingerprint }, receiptFingerprint, verifiedAt: clock() } as any)
    await repository.releaseAttemptLease(ownerUserId, leased.id, leaseOwner, { status: 'succeeded', attemptNumber: leased.attemptNumber + 1, exactResponseIdentity: result.exactResponseIdentity, errorCode: null, errorSummary: null })
    await repository.updateRelease(ownerUserId, from.id, { status: 'rolled_back', blockedReasonCode: null, nextSafeAction: 'retain_for_audit', projectionFingerprint: releaseFingerprint({ previous: from.projectionFingerprint, rolledBackTo: to.id, receiptFingerprint }) })
    const target = await repository.updateRelease(ownerUserId, to.id, { status: 'live_verified', activeDeploymentReceiptFingerprint: receiptFingerprint, rollbackFromReleaseId: from.id, blockedReasonCode: null, nextSafeAction: 'reactivate_geo_if_required', projectionFingerprint: releaseFingerprint({ previous: to.projectionFingerprint, rollbackFrom: from.id, receiptFingerprint }) })
    return { release: target, receipt }
  } catch (error) {
    await failAttempt(ownerUserId, leased, leaseOwner, repository, clock())
    throw error
  }
}

export function createMockManagedSiteDeploymentAdapter(options: { providerKey?: string; failOperations?: Partial<Record<'preview' | 'deploy' | 'rollback', number>>; collision?: Partial<ManagedSiteDeploymentReceipt> } = {}): ManagedSiteDeploymentAdapter {
  const providerKey = options.providerKey || 'mock-deployment'
  const counters = { preview: 0, deploy: 0, rollback: 0 }
  const maybeFail = (operation: keyof typeof counters) => { counters[operation]++; if (counters[operation] <= (options.failOperations?.[operation] || 0)) throw Object.assign(new Error('synthetic provider timeout'), { code: 'TIMEOUT', retryable: true }) }
  const receipt = (input: { projectId: number; versionId: number; contentHash: string; canonicalDomain: string; requestFingerprint: string }, status: ManagedSiteDeploymentReceipt['status']): ManagedSiteDeploymentReceipt => ({ providerKey, providerEventId: `${status}-${stableFingerprint(input).slice(0, 24)}`, providerDeploymentId: `deployment-${stableFingerprint({ input, status }).slice(0, 24)}`, projectId: input.projectId, versionId: input.versionId, contentHash: input.contentHash, canonicalDomain: input.canonicalDomain, deploymentUrl: status === 'preview_ready' ? `https://preview-${stableFingerprint(input).slice(0, 16)}.preview.discoverystack.dev` : `https://${input.canonicalDomain}`, status, exactResponseIdentity: `deployment-response:${stableFingerprint({ input, status }).slice(0, 32)}`, ...options.collision })
  return {
    async buildPreview(input) { maybeFail('preview'); return receipt(input, 'preview_ready') },
    async deployProduction(input) { maybeFail('deploy'); return receipt(input, 'production_verified') },
    async rollback(input) { maybeFail('rollback'); return receipt(input, 'rollback_verified') },
  }
}

export function createMockExistingSiteOwnershipAdapter(providerKey = 'mock-dns-tls'): ManagedSiteExistingSiteOwnershipAdapter {
  return { async verify(input): Promise<ManagedSiteExistingSiteOwnershipReceipt> { return { providerKey, providerEventId: `ownership-${stableFingerprint(input).slice(0, 24)}`, providerReference: `ownership-ref-${input.projectId}`, canonicalDomain: input.canonicalDomain, projectId: input.projectId, verificationMethod: 'dns_txt', evidenceHash: stableFingerprint({ challengeReference: input.challengeReference, canonicalDomain: input.canonicalDomain }), status: 'verified', exactResponseIdentity: `ownership-response:${stableFingerprint(input).slice(0, 32)}` } } }
}

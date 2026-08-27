import { domainToASCII, domainToUnicode } from 'node:url'
import { randomBytes } from 'node:crypto'
import { createError } from 'h3'
import { parse as parseDomain } from 'tldts'
import { stableFingerprint } from '../../seo-geo-core/repository'
import { isOpaqueReference } from '../../first-party-publishing/normalization'
import { getManagedSiteRepository } from '../repository'
import type { ManagedSiteRepository } from '../types'
import { getManagedSiteLiveConnectorRepository } from './repository'
import { requireVerifiedManagedSiteProvider, resolveManagedSiteCredential } from './provider-registry'
import type {
  ManagedSiteConnectorExecutionMode,
  ManagedSiteCredentialResolver,
  ManagedSiteDnsTlsAdapter,
  ManagedSiteDnsTlsReceipt,
  ManagedSiteDomainAdapter,
  ManagedSiteDomainQuote,
  ManagedSiteDomainReceipt,
  ManagedSiteLiveConnectorRepository,
} from './types'

const DOMAIN_TIMEOUT_MS = 15_000
const DOMAIN_LEASE_MS = 25_000

function invalid(message: string): never { throw createError({ statusCode: 422, statusMessage: message }) }
function conflict(message: string): never { throw createError({ statusCode: 409, statusMessage: message }) }
function unavailable(message: string): never { throw createError({ statusCode: 503, statusMessage: message }) }

function mixedScript(label: string): boolean {
  const latin = /\p{Script=Latin}/u.test(label)
  const cyrillic = /\p{Script=Cyrillic}/u.test(label)
  const greek = /\p{Script=Greek}/u.test(label)
  return Number(latin) + Number(cyrillic) + Number(greek) > 1 || (/[a-z0-9]/iu.test(label) && /[^\x00-\x7f]/u.test(label))
}

export function canonicalizeManagedDomain(input: unknown): { canonicalDomain: string; unicodeDomain: string; registrableDomain: string; publicSuffix: string } {
  if (typeof input !== 'string' || !input.trim() || input.trim().length > 253 || input !== input.normalize('NFKC')) invalid('Domain input is invalid or not canonical Unicode.')
  const raw = input.trim().replace(/\.$/u, '').toLowerCase()
  if (raw.includes('://') || /[\/@:*?#\[\]]/u.test(raw) || raw.includes('..')) invalid('Domain must not contain a URL scheme, credentials, path, port, wildcard, query, fragment, or empty label.')
  const canonicalDomain = domainToASCII(raw).toLowerCase()
  if (!canonicalDomain || canonicalDomain.length > 253 || !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/u.test(canonicalDomain)) invalid('Domain could not be safely canonicalized with IDNA.')
  const unicodeDomain = domainToUnicode(canonicalDomain).normalize('NFKC').toLowerCase()
  if (unicodeDomain.split('.').some(mixedScript)) invalid('Domain contains a mixed-script homograph risk.')
  if (/(^|\.)(?:localhost|local|internal|home|lan|onion|test|invalid|example)$/u.test(canonicalDomain)) invalid('Domain uses a local, special-use, or documentation suffix.')
  const parsed = parseDomain(canonicalDomain, { allowPrivateDomains: false, validateHostname: true })
  if (parsed.isIp || !parsed.publicSuffix || !parsed.domain || !parsed.domainWithoutSuffix || parsed.hostname !== canonicalDomain) invalid('Domain is not a registrable public-suffix domain.')
  if (parsed.domain === parsed.publicSuffix || parsed.subdomain && parsed.domainWithoutSuffix.length < 1) invalid('A public suffix cannot be purchased as a customer domain.')
  return { canonicalDomain, unicodeDomain, registrableDomain: parsed.domain, publicSuffix: parsed.publicSuffix }
}

function assertMode(mode: ManagedSiteConnectorExecutionMode): void {
  if (!['dry_run', 'mocked', 'live'].includes(mode)) invalid('Domain connector execution mode is invalid.')
  if (mode === 'mocked' && process.env.NODE_ENV !== 'test') unavailable('Mock domain execution is restricted to tests.')
}

async function providerFor(ownerUserId: number, capability: 'domain_registration' | 'dns_tls', mode: ManagedSiteConnectorExecutionMode, repository: ManagedSiteLiveConnectorRepository, resolver: ManagedSiteCredentialResolver) {
  const configuration = await repository.findProviderConfiguration(ownerUserId, capability)
  if (mode === 'live') return requireVerifiedManagedSiteProvider(ownerUserId, capability, repository, resolver)
  if (mode === 'mocked' && (!configuration || !['mock', 'verified'].includes(configuration.readinessStatus))) unavailable(`Mock ${capability} provider is not explicitly configured.`)
  return configuration
}

function validateQuote(quote: ManagedSiteDomainQuote, expected: { providerKey: string; canonicalDomain: string }, clock: () => Date): void {
  if (quote.providerKey !== expected.providerKey || quote.canonicalDomain !== expected.canonicalDomain || !isOpaqueReference(quote.quoteId, 160) || !isOpaqueReference(quote.exactResponseIdentity, 256)) conflict('Domain quote response identity is incomplete or mismatched.')
  if (!Number.isSafeInteger(quote.amountMinor) || quote.amountMinor < 0 || !/^[A-Z]{3}$/u.test(quote.currency) || !Number.isFinite(Date.parse(quote.expiresAt)) || Date.parse(quote.expiresAt) <= clock().getTime()) conflict('Domain quote commercial snapshot is invalid or expired.')
}

async function assertNoEffectiveRefund(ownerUserId: number, projectId: number, releaseId: number, repository: ManagedSiteLiveConnectorRepository): Promise<void> {
  const refunded = (await repository.listReceipts(ownerUserId, projectId)).some(receipt => receipt.releaseId === releaseId && receipt.receiptType === 'payment_refunded' && receipt.receiptStatus === 'verified' && (receipt.metadata as any)?.effective === true)
  if (refunded) conflict('Verified refund authority blocks domain and DNS/TLS mutations for this release.')
}

export async function quoteManagedSiteDomain(ownerUserId: number, input: { projectId: number; releaseId: number; requestedDomain: string; executionMode: ManagedSiteConnectorExecutionMode; idempotencyKey: string }, adapter?: ManagedSiteDomainAdapter, dependencies: { repository?: ManagedSiteLiveConnectorRepository; managedRepository?: ManagedSiteRepository; credentialResolver?: ManagedSiteCredentialResolver; clock?: () => Date } = {}) {
  assertMode(input.executionMode)
  if (!isOpaqueReference(input.idempotencyKey, 128)) invalid('Domain quote idempotency key is invalid.')
  const domain = canonicalizeManagedDomain(input.requestedDomain)
  const repository = dependencies.repository || getManagedSiteLiveConnectorRepository()
  const managedRepository = dependencies.managedRepository || getManagedSiteRepository()
  const resolver = dependencies.credentialResolver || resolveManagedSiteCredential
  const clock = dependencies.clock || (() => new Date())
  const project = await managedRepository.findProject(ownerUserId, input.projectId)
  const release = await repository.findRelease(ownerUserId, input.releaseId)
  if (!project || !release || release.projectId !== project.id || release.status !== 'payment_verified' || !release.draftOrderId || !release.commerceSnapshotFingerprint) throw createError({ statusCode: 404, statusMessage: 'Paid owner-scoped release was not found for domain quote.' })
  await assertNoEffectiveRefund(ownerUserId, project.id, release.id, repository)
  if (domain.canonicalDomain !== release.canonicalDomain) conflict('Domain quote must match the immutable release canonical domain.')
  if (project.status === 'suspended') conflict('Suspended projects cannot quote domains.')
  const occupied = await repository.findDomainClaim(domain.canonicalDomain)
  if (occupied && (occupied.ownerUserId !== ownerUserId || occupied.projectId !== project.id || occupied.releaseId !== release.id)) conflict('Domain is already claimed by another owner, project, or release.')
  const configuration = await providerFor(ownerUserId, 'domain_registration', input.executionMode, repository, resolver)
  const providerKey = configuration?.providerKey || 'unconfigured'
  const requestFingerprint = stableFingerprint({ ownerUserId, projectId: project.id, releaseId: release.id, commerceSnapshotFingerprint: release.commerceSnapshotFingerprint, operation: 'domain_quote', canonicalDomain: domain.canonicalDomain, providerKey })
  if (input.executionMode === 'dry_run') return { quote: null, domain, requestFingerprint, externalCalls: false, nextSafeAction: 'configure_and_verify_domain_provider' }
  if (!adapter) unavailable('Domain adapter is not injected.')
  let attempt = await repository.findAttemptByIdempotency(ownerUserId, input.idempotencyKey)
  if (attempt && attempt.requestFingerprint !== requestFingerprint) conflict('Domain quote idempotency key collides with another request.')
  if (!attempt) attempt = await repository.insertAttempt({ ownerUserId, projectId: project.id, draftOrderId: release.draftOrderId, releaseId: release.id, capability: 'domain_registration', operation: 'domain_quote', executionMode: input.executionMode, status: 'queued', attemptNumber: 0, maxAttempts: 3, timeoutMs: DOMAIN_TIMEOUT_MS, requestFingerprint, idempotencyKey: input.idempotencyKey, leaseOwner: null, leaseExpiresAt: null, retryEligibleAt: null, exactResponseIdentity: null, errorCode: null, errorSummary: null } as any)
  if (attempt.status === 'succeeded') {
    const receipts = await repository.listReceipts(ownerUserId, project.id)
    const replay = receipts.find(receipt => receipt.attemptId === attempt!.id && receipt.receiptType === 'domain_quote_verified')
    if (replay) return { quote: replay.metadata as unknown as ManagedSiteDomainQuote, domain, requestFingerprint, replayed: true }
  }
  const leaseOwner = `domain-quote-${randomBytes(10).toString('hex')}`
  const leased = await repository.acquireAttemptLease(ownerUserId, attempt.id, leaseOwner, clock(), DOMAIN_LEASE_MS)
  if (!leased) conflict('Domain quote is already leased, terminal, or waiting for retry.')
  try {
    const quote = await adapter.quote({ ownerUserId, projectId: project.id, releaseId: release.id, canonicalDomain: domain.canonicalDomain, requestFingerprint, timeoutMs: DOMAIN_TIMEOUT_MS })
    validateQuote(quote, { providerKey, canonicalDomain: domain.canonicalDomain }, clock)
    const receiptFingerprint = stableFingerprint({ ownerUserId, projectId: project.id, requestFingerprint, quote })
    await repository.insertReceipt({ ownerUserId, projectId: project.id, draftOrderId: release.draftOrderId, releaseId: release.id, attemptId: leased.id, capability: 'domain_registration', providerKey, providerEventId: quote.quoteId, receiptType: 'domain_quote_verified', receiptStatus: 'verified', externalReference: quote.quoteId, exactResponseIdentity: quote.exactResponseIdentity, requestFingerprint, contentHash: release.contentHash, canonicalDomain: domain.canonicalDomain, metadata: { ...quote, commerceSnapshotFingerprint: release.commerceSnapshotFingerprint }, receiptFingerprint, verifiedAt: clock() } as any)
    await repository.releaseAttemptLease(ownerUserId, leased.id, leaseOwner, { status: 'succeeded', attemptNumber: leased.attemptNumber + 1, exactResponseIdentity: quote.exactResponseIdentity, errorCode: null, errorSummary: null })
    return { quote, domain, requestFingerprint, receiptFingerprint, replayed: false }
  } catch (error) {
    await repository.releaseAttemptLease(ownerUserId, leased.id, leaseOwner, { status: 'blocked', attemptNumber: leased.attemptNumber + 1, errorCode: 'DOMAIN_QUOTE_FAILED', errorSummary: 'Domain quote failed without accepting provider state.' }).catch(() => null)
    throw error
  }
}

export function managedSiteDomainConfirmationFingerprint(input: { ownerUserId: number; projectId: number; releaseId: number; commerceSnapshotFingerprint: string; quoteReceiptFingerprint: string; draftOrderId: number; paymentReceiptFingerprint: string }): string {
  return stableFingerprint({ ...input, authority: 'owner_explicit_confirmation_v1' })
}

export async function createManagedSiteDomainPurchaseIntent(ownerUserId: number, input: { projectId: number; releaseId: number; draftOrderId: number; quoteReceiptFingerprint: string; paymentReceiptFingerprint: string; ownerConfirmationFingerprint: string; executionMode: Exclude<ManagedSiteConnectorExecutionMode, 'dry_run'>; idempotencyKey: string }, adapter: ManagedSiteDomainAdapter, dependencies: { repository?: ManagedSiteLiveConnectorRepository; credentialResolver?: ManagedSiteCredentialResolver; clock?: () => Date } = {}) {
  assertMode(input.executionMode)
  const repository = dependencies.repository || getManagedSiteLiveConnectorRepository()
  const resolver = dependencies.credentialResolver || resolveManagedSiteCredential
  const clock = dependencies.clock || (() => new Date())
  const configuration = await providerFor(ownerUserId, 'domain_registration', input.executionMode, repository, resolver)
  const quoteReceipt = await repository.findReceiptByFingerprint(ownerUserId, input.quoteReceiptFingerprint)
  const paymentReceipt = await repository.findReceiptByFingerprint(ownerUserId, input.paymentReceiptFingerprint)
  const release = await repository.findRelease(ownerUserId, input.releaseId)
  if (!release || release.projectId !== input.projectId || release.draftOrderId !== input.draftOrderId || release.status !== 'payment_verified' || !release.commerceSnapshotFingerprint) conflict('Domain purchase requires an exact paid release commerce binding.')
  await assertNoEffectiveRefund(ownerUserId, input.projectId, release.id, repository)
  if (!quoteReceipt || quoteReceipt.projectId !== input.projectId || quoteReceipt.releaseId !== release.id || quoteReceipt.draftOrderId !== release.draftOrderId || quoteReceipt.receiptType !== 'domain_quote_verified' || quoteReceipt.receiptStatus !== 'verified' || quoteReceipt.contentHash !== release.contentHash || (quoteReceipt.metadata as any).commerceSnapshotFingerprint !== release.commerceSnapshotFingerprint) conflict('Domain purchase requires an exact server-verified quote receipt.')
  if (!paymentReceipt || paymentReceipt.releaseId !== release.id || paymentReceipt.draftOrderId !== input.draftOrderId || paymentReceipt.projectId !== input.projectId || paymentReceipt.receiptType !== 'release_payment_bound' || paymentReceipt.receiptStatus !== 'verified' || paymentReceipt.contentHash !== release.contentHash) conflict('Domain purchase requires exact release-bound payment authority for this project and order.')
  const expectedConfirmation = managedSiteDomainConfirmationFingerprint({ ownerUserId, projectId: input.projectId, releaseId: release.id, commerceSnapshotFingerprint: release.commerceSnapshotFingerprint, quoteReceiptFingerprint: input.quoteReceiptFingerprint, draftOrderId: input.draftOrderId, paymentReceiptFingerprint: input.paymentReceiptFingerprint })
  if (input.ownerConfirmationFingerprint !== expectedConfirmation) conflict('Domain purchase requires exact owner confirmation of the quote and payment snapshot.')
  const quote = quoteReceipt.metadata as unknown as ManagedSiteDomainQuote
  if (quote.canonicalDomain !== release.canonicalDomain) conflict('Domain quote does not match the immutable release canonical domain.')
  validateQuote(quote, { providerKey: configuration?.providerKey || '', canonicalDomain: quoteReceipt.canonicalDomain || '' }, clock)
  const requestFingerprint = stableFingerprint({ ownerUserId, projectId: input.projectId, releaseId: release.id, commerceSnapshotFingerprint: release.commerceSnapshotFingerprint, draftOrderId: input.draftOrderId, quoteReceiptFingerprint: input.quoteReceiptFingerprint, paymentReceiptFingerprint: input.paymentReceiptFingerprint, ownerConfirmationFingerprint: input.ownerConfirmationFingerprint })
  const claimFingerprint = stableFingerprint({ status: 'pending', requestFingerprint })
  const claim = await repository.insertDomainClaim({ canonicalDomain: quote.canonicalDomain, activeCanonicalDomainKey: quote.canonicalDomain, ownerUserId, projectId: input.projectId, releaseId: release.id, claimKind: 'generated', status: 'pending', authorityReceiptFingerprint: null, requestFingerprint, idempotencyKey: input.idempotencyKey, projectionFingerprint: claimFingerprint } as any)
  if (claim.ownerUserId !== ownerUserId || claim.projectId !== input.projectId || claim.releaseId !== release.id || claim.requestFingerprint !== requestFingerprint) conflict('Atomic domain claim replay does not match the release authority.')
  let attempt = await repository.findAttemptByIdempotency(ownerUserId, input.idempotencyKey)
  if (attempt && attempt.requestFingerprint !== requestFingerprint) conflict('Domain purchase idempotency key collides with another request.')
  if (!attempt) attempt = await repository.insertAttempt({ ownerUserId, projectId: input.projectId, draftOrderId: input.draftOrderId, releaseId: release.id, capability: 'domain_registration', operation: 'domain_purchase_intent', executionMode: input.executionMode, status: 'queued', attemptNumber: 0, maxAttempts: 3, timeoutMs: DOMAIN_TIMEOUT_MS, requestFingerprint, idempotencyKey: input.idempotencyKey, leaseOwner: null, leaseExpiresAt: null, retryEligibleAt: null, exactResponseIdentity: null, errorCode: null, errorSummary: null } as any)
  if (attempt.status === 'succeeded') {
    const receipt = (await repository.listReceipts(ownerUserId, input.projectId)).find(item => item.attemptId === attempt!.id && ['domain_registered', 'domain_purchase_intent_created'].includes(item.receiptType))
    if (receipt?.externalReference) return { receipt, result: { providerKey: receipt.providerKey, providerEventId: receipt.providerEventId, providerReference: receipt.externalReference, canonicalDomain: receipt.canonicalDomain!, status: receipt.receiptType === 'domain_registered' ? 'registered' as const : 'purchase_intent_created' as const, exactResponseIdentity: receipt.exactResponseIdentity }, claim, replayed: true }
    conflict('Domain purchase attempt succeeded without its exact append-only receipt.')
  }
  const leaseOwner = `domain-purchase-${randomBytes(10).toString('hex')}`
  const leased = await repository.acquireAttemptLease(ownerUserId, attempt.id, leaseOwner, clock(), DOMAIN_LEASE_MS)
  if (!leased) conflict('Domain purchase intent is already leased, terminal, or waiting for retry.')
  try {
    const result = await adapter.createPurchaseIntent({ ownerUserId, projectId: input.projectId, releaseId: release.id, draftOrderId: input.draftOrderId, commerceSnapshotFingerprint: release.commerceSnapshotFingerprint, quote, ownerConfirmationFingerprint: input.ownerConfirmationFingerprint, paymentReceiptFingerprint: input.paymentReceiptFingerprint, idempotencyKey: input.idempotencyKey, timeoutMs: DOMAIN_TIMEOUT_MS })
    if (result.providerKey !== quote.providerKey || result.canonicalDomain !== quote.canonicalDomain || !['purchase_intent_created', 'registered'].includes(result.status) || !isOpaqueReference(result.providerEventId, 160) || !isOpaqueReference(result.providerReference, 160) || !isOpaqueReference(result.exactResponseIdentity, 256)) conflict('Domain provider receipt identity is incomplete or mismatched.')
    const receiptFingerprint = stableFingerprint({ ownerUserId, projectId: input.projectId, requestFingerprint, result })
    const claimStatus = result.status === 'registered' ? 'verified' : 'pending'
    const { receipt, claimUpdated } = await repository.transaction(async transaction => {
      const receipt = await transaction.insertReceipt({ ownerUserId, projectId: input.projectId, draftOrderId: input.draftOrderId, releaseId: release.id, attemptId: leased.id, capability: 'domain_registration', providerKey: result.providerKey, providerEventId: result.providerEventId, receiptType: result.status === 'registered' ? 'domain_registered' : 'domain_purchase_intent_created', receiptStatus: 'verified', externalReference: result.providerReference, exactResponseIdentity: result.exactResponseIdentity, requestFingerprint, contentHash: release.contentHash, canonicalDomain: result.canonicalDomain, metadata: { commerceSnapshotFingerprint: release.commerceSnapshotFingerprint, quoteReceiptFingerprint: input.quoteReceiptFingerprint, paymentReceiptFingerprint: input.paymentReceiptFingerprint, ownerConfirmationFingerprint: input.ownerConfirmationFingerprint }, receiptFingerprint, verifiedAt: clock() } as any)
      const claimUpdated = claimStatus === claim.status ? claim : await transaction.transitionDomainClaim(ownerUserId, claim.id, claim.status, claim.projectionFingerprint, { status: claimStatus, authorityReceiptFingerprint: receiptFingerprint, projectionFingerprint: stableFingerprint({ previous: claim.projectionFingerprint, status: claimStatus, receiptFingerprint }) })
      if (!claimUpdated) conflict('Domain claim changed concurrently before provider receipt acceptance.')
      const completed = await transaction.releaseAttemptLease(ownerUserId, leased.id, leaseOwner, { status: 'succeeded', attemptNumber: leased.attemptNumber + 1, exactResponseIdentity: result.exactResponseIdentity, errorCode: null, errorSummary: null })
      if (!completed) conflict('Domain purchase attempt lease changed before receipt commit.')
      return { receipt, claimUpdated }
    })
    return { receipt, result, claim: claimUpdated }
  } catch (error) {
    await repository.releaseAttemptLease(ownerUserId, leased.id, leaseOwner, { status: 'retry_wait', attemptNumber: leased.attemptNumber + 1, retryEligibleAt: new Date(clock().getTime() + 30_000), errorCode: 'DOMAIN_PURCHASE_RECONCILE_REQUIRED', errorSummary: 'Provider result was not locally committed; retry will reuse the exact idempotency key.' }).catch(() => null)
    throw error
  }
}

export async function executeManagedSiteDnsTls(ownerUserId: number, input: { projectId: number; releaseId: number; executionMode: Exclude<ManagedSiteConnectorExecutionMode, 'dry_run'>; idempotencyKey: string }, adapter: ManagedSiteDnsTlsAdapter, dependencies: { repository?: ManagedSiteLiveConnectorRepository; credentialResolver?: ManagedSiteCredentialResolver; clock?: () => Date } = {}) {
  assertMode(input.executionMode)
  const repository = dependencies.repository || getManagedSiteLiveConnectorRepository()
  const resolver = dependencies.credentialResolver || resolveManagedSiteCredential
  const clock = dependencies.clock || (() => new Date())
  const configuration = await providerFor(ownerUserId, 'dns_tls', input.executionMode, repository, resolver)
  const release = await repository.findRelease(ownerUserId, input.releaseId)
  if (!release || release.projectId !== input.projectId || !['approved', 'payment_verified', 'provisioning', 'retry_wait'].includes(release.status)) conflict('DNS/TLS requires an approved owner-scoped release projection.')
  await assertNoEffectiveRefund(ownerUserId, input.projectId, release.id, repository)
  const claim = await repository.findDomainClaim(release.canonicalDomain)
  if (!claim || claim.status !== 'verified' || claim.ownerUserId !== ownerUserId || claim.projectId !== input.projectId || claim.releaseId !== release.id || !claim.authorityReceiptFingerprint) conflict('DNS/TLS requires an atomic verified domain claim for this release.')
  const domainReceipt = await repository.findReceiptByFingerprint(ownerUserId, claim.authorityReceiptFingerprint)
  if (!domainReceipt || domainReceipt.releaseId !== release.id || !['domain_registered', 'existing_site_ownership_verified'].includes(domainReceipt.receiptType)) conflict('DNS/TLS domain claim authority receipt is invalid.')
  const requestFingerprint = stableFingerprint({ ownerUserId, projectId: input.projectId, releaseId: release.id, contentHash: release.contentHash, canonicalDomain: release.canonicalDomain, providerKey: configuration?.providerKey })
  let attempt = await repository.findAttemptByIdempotency(ownerUserId, input.idempotencyKey)
  if (attempt && attempt.requestFingerprint !== requestFingerprint) conflict('DNS/TLS idempotency key collides with another request.')
  if (!attempt) attempt = await repository.insertAttempt({ ownerUserId, projectId: input.projectId, draftOrderId: domainReceipt.draftOrderId, releaseId: release.id, capability: 'dns_tls', operation: 'dns_tls_configure_verify', executionMode: input.executionMode, status: 'queued', attemptNumber: 0, maxAttempts: 3, timeoutMs: DOMAIN_TIMEOUT_MS, requestFingerprint, idempotencyKey: input.idempotencyKey, leaseOwner: null, leaseExpiresAt: null, retryEligibleAt: null, exactResponseIdentity: null, errorCode: null, errorSummary: null } as any)
  if (attempt.status === 'succeeded' && release.status === 'provisioning') {
    const receipt = (await repository.listReceipts(ownerUserId, release.projectId)).find(item => item.attemptId === attempt!.id && item.receiptType === 'dns_tls_verified')
    if (receipt?.externalReference) return { receipt, ready: true, result: { providerKey: receipt.providerKey, providerEventId: receipt.providerEventId, providerReference: receipt.externalReference, canonicalDomain: release.canonicalDomain, dnsStatus: 'verified' as const, tlsStatus: 'verified' as const, exactResponseIdentity: receipt.exactResponseIdentity }, replayed: true }
    conflict('DNS/TLS attempt succeeded without its exact append-only receipt.')
  }
  const leaseOwner = `dns-tls-${randomBytes(10).toString('hex')}`
  const leased = await repository.acquireAttemptLease(ownerUserId, attempt.id, leaseOwner, clock(), DOMAIN_LEASE_MS)
  if (!leased) conflict('DNS/TLS attempt is already leased, terminal, or waiting for retry.')
  try {
    const result = await adapter.configureAndVerify({ ownerUserId, canonicalDomain: release.canonicalDomain, projectId: release.projectId, releaseId: release.id, contentHash: release.contentHash, requestFingerprint, idempotencyKey: input.idempotencyKey, timeoutMs: DOMAIN_TIMEOUT_MS })
    if (result.providerKey !== configuration?.providerKey || result.canonicalDomain !== release.canonicalDomain || !isOpaqueReference(result.providerEventId, 160) || !isOpaqueReference(result.providerReference, 160) || !isOpaqueReference(result.exactResponseIdentity, 256)) conflict('DNS/TLS receipt identity is incomplete or mismatched.')
    const ready = result.dnsStatus === 'verified' && result.tlsStatus === 'verified'
    const receiptFingerprint = stableFingerprint({ ownerUserId, projectId: release.projectId, releaseId: release.id, requestFingerprint, result })
    const { receipt } = await repository.transaction(async transaction => {
      const receipt = await transaction.insertReceipt({ ownerUserId, projectId: release.projectId, draftOrderId: domainReceipt.draftOrderId, releaseId: release.id, attemptId: leased.id, capability: 'dns_tls', providerKey: result.providerKey, providerEventId: result.providerEventId, receiptType: ready ? 'dns_tls_verified' : result.dnsStatus === 'partial_failure' || result.tlsStatus === 'failed' ? 'dns_tls_partial_failure' : 'dns_tls_propagation_pending', receiptStatus: 'verified', externalReference: result.providerReference, exactResponseIdentity: result.exactResponseIdentity, requestFingerprint, contentHash: release.contentHash, canonicalDomain: release.canonicalDomain, metadata: { dnsStatus: result.dnsStatus, tlsStatus: result.tlsStatus, rollbackIntent: ready ? null : 'restore_last_verified_dns_snapshot' }, receiptFingerprint, verifiedAt: clock() } as any)
      const transitioned = await transaction.transitionRelease(ownerUserId, release.id, release.status, release.projectionFingerprint, { status: ready ? 'provisioning' : 'retry_wait', blockedReasonCode: ready ? null : 'DNS_TLS_PENDING', nextSafeAction: ready ? 'deploy_production' : 'retry_dns_tls_after_eligibility', projectionFingerprint: stableFingerprint({ releaseId: release.id, previous: release.projectionFingerprint, dnsTlsReceipt: receiptFingerprint }) })
      if (!transitioned) conflict('Release changed concurrently before DNS/TLS state acceptance.')
      const completed = await transaction.releaseAttemptLease(ownerUserId, leased.id, leaseOwner, { status: ready ? 'succeeded' : 'retry_wait', attemptNumber: leased.attemptNumber + 1, retryEligibleAt: ready ? null : new Date(clock().getTime() + 5 * 60_000), exactResponseIdentity: result.exactResponseIdentity, errorCode: ready ? null : 'DNS_TLS_PENDING', errorSummary: ready ? null : 'DNS/TLS is pending propagation or requires bounded retry.' })
      if (!completed) conflict('DNS/TLS attempt lease changed before receipt commit.')
      return { receipt }
    })
    return { receipt, ready, result }
  } catch (error) {
    await repository.releaseAttemptLease(ownerUserId, leased.id, leaseOwner, { status: 'retry_wait', attemptNumber: leased.attemptNumber + 1, retryEligibleAt: new Date(clock().getTime() + 30_000), errorCode: 'DNS_TLS_RECONCILE_REQUIRED', errorSummary: 'Provider result was not locally committed; retry will reuse the exact idempotency key.' }).catch(() => null)
    throw error
  }
}

export function createMockManagedSiteDomainAdapter(options: { providerKey?: string; registeredImmediately?: boolean; now?: () => Date } = {}): ManagedSiteDomainAdapter {
  const providerKey = options.providerKey || 'mock-domain'
  const now = options.now || (() => new Date('2026-08-27T00:00:00.000Z'))
  return {
    async quote(input): Promise<ManagedSiteDomainQuote> { return { providerKey, quoteId: `quote-${stableFingerprint(input).slice(0, 20)}`, canonicalDomain: input.canonicalDomain, amountMinor: 1200, currency: 'USD', expiresAt: new Date(now().getTime() + 60 * 60_000).toISOString(), exactResponseIdentity: `quote-response:${stableFingerprint(input).slice(0, 24)}` } },
    async createPurchaseIntent(input): Promise<ManagedSiteDomainReceipt> { return { providerKey, providerEventId: `domain-event-${stableFingerprint(input).slice(0, 20)}`, providerReference: `domain-ref-${stableFingerprint(input.quote).slice(0, 20)}`, canonicalDomain: input.quote.canonicalDomain, status: options.registeredImmediately === false ? 'purchase_intent_created' : 'registered', exactResponseIdentity: `domain-response:${stableFingerprint(input).slice(0, 24)}` } },
  }
}

export function createMockManagedSiteDnsTlsAdapter(options: { providerKey?: string; result?: Partial<Pick<ManagedSiteDnsTlsReceipt, 'dnsStatus' | 'tlsStatus'>> } = {}): ManagedSiteDnsTlsAdapter {
  const providerKey = options.providerKey || 'mock-dns-tls'
  return { async configureAndVerify(input) { return { providerKey, providerEventId: `dns-tls-${stableFingerprint(input).slice(0, 20)}`, providerReference: `dns-zone-${input.projectId}`, canonicalDomain: input.canonicalDomain, dnsStatus: options.result?.dnsStatus || 'verified', tlsStatus: options.result?.tlsStatus || 'verified', exactResponseIdentity: `dns-tls-response:${stableFingerprint(input).slice(0, 24)}` } } }
}

/** Explicit owner-authorized release of the active key; the historical claim row and receipt remain immutable. */
export async function releaseManagedSiteDomainClaim(ownerUserId: number, input: { projectId: number; releaseId: number; claimId: number; expectedProjectionFingerprint: string; idempotencyKey: string }, repository: ManagedSiteLiveConnectorRepository = getManagedSiteLiveConnectorRepository(), clock: () => Date = () => new Date()) {
  if (![input.projectId, input.releaseId, input.claimId].every(value => Number.isSafeInteger(value) && value > 0) || !/^[a-f0-9]{64}$/u.test(input.expectedProjectionFingerprint) || !isOpaqueReference(input.idempotencyKey, 128)) invalid('Domain claim release identity is invalid.')
  const release = await repository.findRelease(ownerUserId, input.releaseId)
  const claim = await repository.findDomainClaimByRelease(ownerUserId, input.releaseId)
  if (!release || release.projectId !== input.projectId || !claim || claim.id !== input.claimId || claim.projectId !== input.projectId || claim.activeCanonicalDomainKey !== claim.canonicalDomain) conflict('Owner-scoped active domain claim was not found.')
  if (claim.projectionFingerprint !== input.expectedProjectionFingerprint) conflict('Domain claim projection is stale.')
  if (['live_verified', 'geo_active', 'deployment_pending', 'rollback_pending'].includes(release.status)) conflict('A live or deploying domain cannot be released before a governed suspend or rollback transition.')
  const requestFingerprint = stableFingerprint({ ownerUserId, projectId: input.projectId, releaseId: input.releaseId, claimId: input.claimId, canonicalDomain: claim.canonicalDomain, expectedProjectionFingerprint: input.expectedProjectionFingerprint, authority: 'owner_explicit_domain_release_v1' })
  const providerEventId = `domain-release-${stableFingerprint({ ownerUserId, idempotencyKey: input.idempotencyKey }).slice(0, 32)}`
  const receiptFingerprint = stableFingerprint({ requestFingerprint, providerEventId })
  return repository.transaction(async tx => {
    const replay = await tx.findReceiptByProviderEvent('discoverystack-owner-authority', providerEventId)
    if (replay) {
      if (replay.receiptFingerprint !== receiptFingerprint) conflict('Domain release idempotency identity collided.')
      const historical = await tx.findDomainClaimByRelease(ownerUserId, input.releaseId)
      return { claim: historical, receipt: replay, replayed: true }
    }
    const receipt = await tx.insertReceipt({ ownerUserId, projectId: input.projectId, draftOrderId: release.draftOrderId, releaseId: release.id, attemptId: null, capability: 'domain_registration', providerKey: 'discoverystack-owner-authority', providerEventId, receiptType: 'domain_claim_released', receiptStatus: 'verified', externalReference: `domain-claim:${claim.id}`, exactResponseIdentity: `owner-domain-release:${receiptFingerprint.slice(0, 48)}`, requestFingerprint, contentHash: release.contentHash, canonicalDomain: claim.canonicalDomain, metadata: { claimId: claim.id, claimKind: claim.claimKind, previousStatus: claim.status, activeCanonicalDomainKeyReleased: true, silentRelease: false }, receiptFingerprint, verifiedAt: clock() } as any)
    const updated = await tx.transitionDomainClaim(ownerUserId, claim.id, claim.status, claim.projectionFingerprint, { status: 'released', activeCanonicalDomainKey: null, authorityReceiptFingerprint: receipt.receiptFingerprint, projectionFingerprint: stableFingerprint({ previous: claim.projectionFingerprint, releaseReceiptFingerprint: receipt.receiptFingerprint }) })
    if (!updated) conflict('Domain claim changed concurrently before release acceptance.')
    return { claim: updated, receipt, replayed: false }
  })
}

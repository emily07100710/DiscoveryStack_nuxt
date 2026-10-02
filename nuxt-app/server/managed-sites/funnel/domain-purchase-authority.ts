import { createError } from 'h3'
import { stableFingerprint } from '../../seo-geo-core/repository'
import type { ManagedSiteFunnelSession } from '../../database/schema'
import { getPreviewRepository } from '../ordering-repository'
import type { PreviewRepository } from '../ordering-types'
import { getManagedSiteRepository } from '../repository'
import type { ManagedSiteRepository } from '../types'
import { canonicalizeManagedDomain, createManagedSiteDomainPurchaseIntent } from '../live-connectors/domain-connectors'
import { parsePorkbunRegistrantContact, type PorkbunRegistrantContact } from '../live-connectors/porkbun-adapters'
import { assertManagedSiteProductionPayment } from '../live-connectors/production-payment-authority'
import { getManagedSiteLiveConnectorRepository } from '../live-connectors/repository'
import { managedSiteLiveDomainAdapter } from '../live-connectors/runtime-adapters'
import { managedSiteProviderAuthorityMetadata, resolveManagedSiteProviderAuthority } from '../live-connectors/provider-registry'
import type { ManagedSiteProductionTransaction } from '../live-connectors/deployment-orchestrator'
import type { ManagedSiteCredentialResolver, ManagedSiteDomainAdapter, ManagedSiteDomainQuote, ManagedSiteLiveConnectorRepository } from '../live-connectors/types'
import { getFunnelSessionRepository, type FunnelSessionRepository } from './session-repository'
import { projectFunnelQuote } from './quote-projection'
import type { FunnelAnswers } from './session-service'

export const MANAGED_SITE_FUNNEL_DOMAIN_DELEGATION_VERSION = 'funnel-domain-registration-delegation-v1' as const
export const MANAGED_SITE_FUNNEL_DOMAIN_DELEGATION_TERMS = '我授權 DiscoveryStack 在付款確認後，依已確認的網域與價格上限，透過平台管理的註冊商帳戶代為註冊一年網域、登記我提供的註冊聯絡資料，並設定 DNS 與網站連線；不加收未同意的費用。我會完成註冊商要求的電子郵件驗證。'
export type FunnelDomainRegistrationDelegation = {
  schemaVersion: typeof MANAGED_SITE_FUNNEL_DOMAIN_DELEGATION_VERSION
  sessionId: number
  canonicalDomain: string
  acceptedAt: string
  delegated: true
  registrant: PorkbunRegistrantContact
  quote: ManagedSiteDomainQuote
  customerPrice: { amountMinor: number; currency: string }
  consentFingerprint: string
}
export type FunnelDomainProcurementPolicy = { currency: string; maxAmountMinor: number }
type SessionAuthority = Pick<ManagedSiteFunnelSession, 'id' | 'answers' | 'consentSnapshot'>
type DomainDependencies = {
  funnelRepository?: FunnelSessionRepository; repository?: ManagedSiteLiveConnectorRepository; orderingRepository?: PreviewRepository; managedRepository?: ManagedSiteRepository
  executionMode?: 'live' | 'mocked'; clock?: () => Date; credentialResolver?: ManagedSiteCredentialResolver
  domainAdapter?: (ownerUserId: number, repository: ManagedSiteLiveConnectorRepository) => Promise<ManagedSiteDomainAdapter>
  productionTransaction?: ManagedSiteProductionTransaction
}

function denied(message: string, statusCode = 409, code = 'FUNNEL_DOMAIN_AUTHORITY_BLOCKED'): never { throw createError({ statusCode, statusMessage: message, data: { code } }) }
function record(value: unknown): Record<string, any> { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {} }

export function funnelDomainProcurementPolicy(canonicalDomain: string, raw = process.env.MANAGED_SITE_FUNNEL_DOMAIN_PROCUREMENT_POLICY_JSON): { policy: FunnelDomainProcurementPolicy; fingerprint: string } {
  const domain = canonicalizeManagedDomain(canonicalDomain)
  if (domain.registrableDomain !== canonicalDomain) denied('只能代註冊完整的可註冊網域。')
  let parsed: unknown
  try { parsed = raw ? JSON.parse(raw) : null } catch { denied('網域自動採購尚未設定有效的預算政策。', 503) }
  const candidate = record(record(parsed)[domain.publicSuffix])
  if (Object.keys(candidate).sort().join(',') !== 'currency,maxAmountMinor' || !/^[A-Z]{3}$/u.test(candidate.currency || '') || !Number.isSafeInteger(candidate.maxAmountMinor) || candidate.maxAmountMinor <= 0) denied('此網域尚未開放自動採購，請稍後再試。', 503)
  const policy = { currency: String(candidate.currency), maxAmountMinor: Number(candidate.maxAmountMinor) }
  return { policy, fingerprint: stableFingerprint({ scope: 'funnel-domain-procurement-policy-v1', tld: domain.publicSuffix, ...policy }) }
}

/** Server constructor: the route supplies a stored verified quote and server catalog price. */
export function createFunnelDomainRegistrationDelegation(input: { sessionId: number; canonicalDomain: string; registrant: unknown; quote: ManagedSiteDomainQuote; customerPrice: { amountMinor: number; currency: string }; acceptedAt: string }): FunnelDomainRegistrationDelegation {
  const canonicalDomain = canonicalizeManagedDomain(input.canonicalDomain).canonicalDomain
  const quote = input.quote
  const acceptedAt = Date.parse(input.acceptedAt)
  if (!Number.isSafeInteger(input.sessionId) || input.sessionId < 1 || !Number.isFinite(acceptedAt) || !quote || quote.canonicalDomain !== canonicalDomain || !Number.isSafeInteger(quote.amountMinor) || quote.amountMinor < 0 || !/^[A-Z]{3}$/u.test(quote.currency) || !Number.isFinite(Date.parse(quote.expiresAt)) || Date.parse(quote.expiresAt) <= acceptedAt || !/^[a-f0-9]{64}$/u.test(quote.providerAuthorityFingerprint) || !Number.isSafeInteger(input.customerPrice.amountMinor) || input.customerPrice.amountMinor < 0 || !/^[A-Z]{3}$/u.test(input.customerPrice.currency)) denied('網域報價或註冊授權已失效，請重新確認。')
  const authority = { schemaVersion: MANAGED_SITE_FUNNEL_DOMAIN_DELEGATION_VERSION, sessionId: input.sessionId, canonicalDomain, acceptedAt: new Date(acceptedAt).toISOString(), delegated: true as const, registrant: parsePorkbunRegistrantContact(input.registrant), quote: structuredClone(quote), customerPrice: { ...input.customerPrice } }
  return { ...authority, consentFingerprint: stableFingerprint(authority) }
}

export function assertFunnelDomainDelegationForSession(session: SessionAuthority, clock: () => Date = () => new Date(), options: { allowExpiredAcceptedQuote?: boolean } = {}) {
  const answers = record(session.answers) as FunnelAnswers
  const consent = record(session.consentSnapshot)
  const stored = record(consent.domainRegistration)
  if (answers.domain?.option !== 'new' || consent.scrolledToBottom !== true || stored.delegated !== true || stored.schemaVersion !== MANAGED_SITE_FUNNEL_DOMAIN_DELEGATION_VERSION) denied('請先確認網域代註冊授權與註冊聯絡資料。')
  const canonicalDomain = canonicalizeManagedDomain(`${answers.domain.name}.${answers.domain.tld}`).canonicalDomain
  const delegation = createFunnelDomainRegistrationDelegation(stored as any)
  if (delegation.sessionId !== session.id || delegation.canonicalDomain !== canonicalDomain || delegation.consentFingerprint !== stored.consentFingerprint || Date.parse(delegation.acceptedAt) > clock().getTime() || !options.allowExpiredAcceptedQuote && Date.parse(delegation.quote.expiresAt) <= clock().getTime()) denied('網域選擇或報價已變更，請重新確認代註冊授權。')
  const retail = projectFunnelQuote(answers, session.id)
  if (delegation.customerPrice.amountMinor !== retail.totals.domainFirstYearMinor || delegation.customerPrice.currency !== retail.currency) denied('網域授權價格與目前方案不一致，請重新確認。')
  const { policy, fingerprint } = funnelDomainProcurementPolicy(canonicalDomain)
  if (delegation.quote.currency !== policy.currency || delegation.quote.amountMinor > policy.maxAmountMinor) denied('網域報價超過自動採購預算，無法開始扣款或註冊。')
  return { canonicalDomain, delegation, policy, procurementPolicyFingerprint: fingerprint, delegationFingerprint: delegation.consentFingerprint, registrant: delegation.registrant }
}

/** Internal broker guard. Test checkout receipts never authorize real registrar or DNS spend. */
export async function assertFunnelDomainMutationAuthority(ownerUserId: number, releaseId: number, sessionId: number, dependencies: DomainDependencies = {}) {
  const funnel = dependencies.funnelRepository || getFunnelSessionRepository()
  const repository = dependencies.repository || getManagedSiteLiveConnectorRepository()
  const ordering = dependencies.orderingRepository || getPreviewRepository()
  const managed = dependencies.managedRepository || getManagedSiteRepository()
  const clock = dependencies.clock || (() => new Date())
  const session = await funnel.findSession(sessionId)
  const release = await repository.findRelease(ownerUserId, releaseId)
  if (!session || !release || session.releaseId !== release.id || session.projectId !== release.projectId || session.draftOrderId !== release.draftOrderId || session.previewId !== release.previewId || session.quoteId !== release.quoteId) denied('網域代註冊付款資料不完整。')
  const authority = assertFunnelDomainDelegationForSession(session, clock, { allowExpiredAcceptedQuote: true })
  if (authority.canonicalDomain !== release.canonicalDomain) denied('網域代註冊授權與網站不一致。')
  await assertManagedSiteProductionPayment(ownerUserId, release, repository, ordering, managed)
  const receipts = await repository.listReceiptsByDraftOrder(ownerUserId, release.draftOrderId!)
  const payment = receipts.find(receipt => receipt.releaseId === release.id && receipt.receiptType === 'checkout_succeeded' && receipt.receiptStatus === 'verified' && record(receipt.metadata).effective === true)
  const mocked = dependencies.executionMode === 'mocked' && process.env.NODE_ENV === 'test'
  if (!mocked && (payment?.providerKey !== 'stripe' || record(payment.metadata).capabilityIdentity !== 'stripe-balance:live')) denied('Stripe 測試付款不會啟動真實網域採購或 DNS 變更。')
  const bound = receipts.find(receipt => receipt.releaseId === release.id && receipt.receiptType === 'release_payment_bound' && receipt.receiptStatus === 'verified' && (record(receipt.metadata).paymentReceiptFingerprint || record(receipt.metadata).checkoutReceiptFingerprint) === payment?.receiptFingerprint)
  const lines = await ordering.listQuoteLines(release.quoteId!)
  const domainLines = lines.filter(line => /^domain-[a-z0-9-]+-year1$/u.test(line.lineKey))
  if (!bound || domainLines.length !== 1 || domainLines[0]!.lineAmountMinor !== authority.delegation.customerPrice.amountMinor) denied('網域代註冊授權與已付款網域價格不一致。')
  return { ...authority, paymentReceiptFingerprint: bound.receiptFingerprint }
}

export async function purchaseFunnelDomain(ownerUserId: number, releaseId: number, sessionId: number, dependencies: DomainDependencies = {}) {
  const repository = dependencies.repository || getManagedSiteLiveConnectorRepository()
  const clock = dependencies.clock || (() => new Date())
  const executionMode = dependencies.executionMode || 'live'
  const authority = await assertFunnelDomainMutationAuthority(ownerUserId, releaseId, sessionId, dependencies)
  const release = await repository.findRelease(ownerUserId, releaseId)
  if (!release || release.status !== 'payment_verified') denied('網站目前無法開始網域代註冊。')
  const existingClaim = await repository.findDomainClaim(authority.canonicalDomain)
  if (existingClaim && (existingClaim.ownerUserId !== ownerUserId || existingClaim.projectId !== release.projectId || existingClaim.releaseId !== release.id)) denied('所選網域已有其他註冊申請。')
  if (existingClaim?.status === 'verified') return { claim: existingClaim, replayed: true }
  const idempotencyKey = stableFingerprint({ scope: 'funnel-domain-purchase-v1', sessionId, releaseId, delegationFingerprint: authority.delegationFingerprint })
  const priorAttempt = await repository.findAttemptByIdempotency(ownerUserId, idempotencyKey)
  if (priorAttempt && (['blocked', 'failed', 'succeeded'].includes(priorAttempt.status) || priorAttempt.attemptNumber >= priorAttempt.maxAttempts)) denied('網域註冊結果需要進一步核對，系統不會重複採購。')
  if (priorAttempt && (priorAttempt.retryEligibleAt && priorAttempt.retryEligibleAt.getTime() > clock().getTime() || priorAttempt.status === 'processing' && priorAttempt.leaseExpiresAt && priorAttempt.leaseExpiresAt.getTime() > clock().getTime())) denied('網域註冊正在處理或等待供應商確認，請稍候。', 409, 'FUNNEL_DOMAIN_WAITING')
  const adapter = await (dependencies.domainAdapter || managedSiteLiveDomainAdapter)(ownerUserId, repository)
  const providerAuthority = await resolveManagedSiteProviderAuthority(ownerUserId, 'domain_registration', executionMode, repository, dependencies.credentialResolver)
  if (providerAuthority.authorityFingerprint !== authority.delegation.quote.providerAuthorityFingerprint) denied('網域註冊商設定已變更，請重新確認報價與授權。')
  const priorQuotes = (await repository.listReceiptsByDraftOrder(ownerUserId, release.draftOrderId!)).filter(receipt => receipt.releaseId === release.id && receipt.receiptType === 'domain_quote_verified' && receipt.receiptStatus === 'verified' && record(receipt.metadata).purchaseIdempotencyKey === idempotencyKey)
  let quoteReceipt = priorQuotes[priorQuotes.length - 1]
  if (!quoteReceipt || !priorAttempt && Date.parse(record(quoteReceipt.metadata).expiresAt) <= clock().getTime()) {
    if (priorAttempt) denied('網域註冊結果尚待核對，不能建立另一筆採購。')
    const requestFingerprint = stableFingerprint({ scope: 'funnel-paid-domain-quote-v1', sessionId, releaseId, idempotencyKey, checkedAt: clock().toISOString() })
    let quote: ManagedSiteDomainQuote
    try { quote = await adapter.quote({ ownerUserId, projectId: release.projectId, releaseId, canonicalDomain: authority.canonicalDomain, providerAuthority, requestFingerprint, timeoutMs: 15_000, requireAutomaticEligibility: true }) } catch (error) {
      if ([409, 422].includes(Number((error as { statusCode?: number }).statusCode))) denied('網域最新報價不可用或註冊條件已變更，未執行採購。')
      throw error
    }
    if (quote.providerKey !== providerAuthority.providerKey || quote.providerAuthorityFingerprint !== providerAuthority.authorityFingerprint || quote.canonicalDomain !== authority.canonicalDomain || !Number.isSafeInteger(quote.amountMinor) || quote.amountMinor < 0 || quote.currency !== authority.policy.currency || quote.amountMinor > authority.policy.maxAmountMinor || quote.currency !== authority.delegation.quote.currency || quote.amountMinor > authority.delegation.quote.amountMinor || !Number.isFinite(Date.parse(quote.expiresAt)) || Date.parse(quote.expiresAt) <= clock().getTime()) denied('網域最新報價已超過同意的價格或不可註冊，未執行採購。')
    quoteReceipt = await repository.insertReceipt({ ownerUserId, projectId: release.projectId, draftOrderId: release.draftOrderId, releaseId, attemptId: null, capability: 'domain_registration', providerKey: quote.providerKey, providerEventId: quote.quoteId, receiptType: 'domain_quote_verified', receiptStatus: 'verified', externalReference: quote.quoteId, exactResponseIdentity: quote.exactResponseIdentity, requestFingerprint, contentHash: release.contentHash, canonicalDomain: authority.canonicalDomain, metadata: { ...quote, purchaseIdempotencyKey: idempotencyKey, commerceSnapshotFingerprint: release.commerceSnapshotFingerprint, ...managedSiteProviderAuthorityMetadata(providerAuthority) }, receiptFingerprint: stableFingerprint({ ownerUserId, requestFingerprint, quote }), verifiedAt: clock() })
  }
  return createManagedSiteDomainPurchaseIntent(ownerUserId, { projectId: release.projectId, releaseId, draftOrderId: release.draftOrderId!, quoteReceiptFingerprint: quoteReceipt.receiptFingerprint, paymentReceiptFingerprint: authority.paymentReceiptFingerprint, ownerConfirmationFingerprint: '', executionMode, idempotencyKey }, adapter, {
    repository, managedRepository: dependencies.managedRepository || getManagedSiteRepository(), credentialResolver: dependencies.credentialResolver, clock, productionTransaction: dependencies.productionTransaction,
    authorizeDelegatedPurchase: async scoped => {
      const current = await assertFunnelDomainMutationAuthority(ownerUserId, releaseId, sessionId, { ...dependencies, ...(scoped || {}) })
      if (current.delegationFingerprint !== authority.delegationFingerprint || current.procurementPolicyFingerprint !== authority.procurementPolicyFingerprint) denied('網域代註冊授權或採購政策已變更。')
      const currentProvider = await resolveManagedSiteProviderAuthority(ownerUserId, 'domain_registration', executionMode, scoped?.repository || repository, dependencies.credentialResolver)
      if (currentProvider.authorityFingerprint !== providerAuthority.authorityFingerprint) denied('網域註冊商設定已變更，無法執行註冊或接受結果。')
      return { kind: 'customer_domain_delegation_v1', sessionId, fingerprint: current.delegationFingerprint, procurementPolicyFingerprint: current.procurementPolicyFingerprint, registrant: current.registrant }
    },
  })
}

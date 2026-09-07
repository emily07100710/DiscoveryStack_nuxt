import { createError } from 'h3'
import { stableFingerprint } from '../../seo-geo-core/repository'
import type { ManagedSiteFunnelSession } from '../../database/schema'
import { getManagedSitePriceCatalog } from '../ordering-service'
import { canonicalizeManagedDomain } from '../live-connectors/domain-connectors'
import { quotePorkbunRegistration } from '../live-connectors/porkbun-adapters'
import { resolveManagedSiteCredential, resolveManagedSiteProviderAuthority } from '../live-connectors/provider-registry'
import { getManagedSiteLiveConnectorRepository } from '../live-connectors/repository'
import type { ManagedSiteCredentialResolver, ManagedSiteDomainQuote, ManagedSiteLiveConnectorRepository, ManagedSiteProviderAuthoritySnapshot } from '../live-connectors/types'
import { assertFunnelDomainDelegationForSession, funnelDomainProcurementPolicy } from './domain-purchase-authority'

export type FunnelDomainAvailabilitySnapshot = {
  schemaVersion: 'funnel-domain-availability-v1'
  canonicalDomain: string
  available: true
  checkedAt: string
  expiresAt: string
  quote: ManagedSiteDomainQuote
  providerAuthority: ManagedSiteProviderAuthoritySnapshot
  quoteFingerprint: string
  customerPrice: { amountMinor: number; currency: 'TWD' }
}
export type FunnelDomainUnavailable = { canonicalDomain: string; available: false; reason: 'unavailable' | 'unsupported' | 'premium'; messageZh: string }
type Dependencies = { repository?: ManagedSiteLiveConnectorRepository; credentialResolver?: ManagedSiteCredentialResolver; fetchImpl?: typeof fetch; clock?: () => Date; procurementPolicyJson?: string }

/** Read-only provider query before payment. Store the complete result server-side; expose only the public projection. */
export async function checkFunnelDomainAvailability(ownerUserId: number, sessionId: number, requestedDomain: string, dependencies: Dependencies = {}): Promise<FunnelDomainAvailabilitySnapshot | FunnelDomainUnavailable> {
  if (!Number.isSafeInteger(ownerUserId) || ownerUserId < 1 || !Number.isSafeInteger(sessionId) || sessionId < 1) throw createError({ statusCode: 422, statusMessage: '網域查詢資料不正確。' })
  const domain = canonicalizeManagedDomain(requestedDomain)
  const catalog = getManagedSitePriceCatalog().domainTlds.find(item => item.tld === domain.publicSuffix)
  if (!catalog || domain.canonicalDomain !== domain.registrableDomain) return { canonicalDomain: domain.canonicalDomain, available: false, reason: 'unsupported', messageZh: '此網域結尾暫不支援自動註冊，請選擇其他網域。' }
  const { policy } = funnelDomainProcurementPolicy(domain.canonicalDomain, dependencies.procurementPolicyJson)
  const repository = dependencies.repository || getManagedSiteLiveConnectorRepository()
  const resolver = dependencies.credentialResolver || resolveManagedSiteCredential
  const providerAuthority = await resolveManagedSiteProviderAuthority(ownerUserId, 'domain_registration', 'live', repository, resolver)
  const configuration = await repository.findProviderConfiguration(ownerUserId, 'domain_registration')
  const transport = configuration?.transportConfiguration as { endpointOrigin?: unknown } | null
  if (!configuration || configuration.providerKey !== 'porkbun' || configuration.configurationFingerprint !== providerAuthority.configurationFingerprint || providerAuthority.capabilityIdentity !== 'porkbun:production' || configuration.readinessStatus !== 'verified' || !configuration.credentialReference || typeof transport?.endpointOrigin !== 'string') throw createError({ statusCode: 503, statusMessage: '網域自動註冊尚未完成供應商設定。' })
  const clock = dependencies.clock || (() => new Date())
  const checkedAt = clock().toISOString()
  let quote: ManagedSiteDomainQuote
  try {
    quote = await quotePorkbunRegistration({ endpointOrigin: transport.endpointOrigin, providerKey: 'porkbun', credentialReference: configuration.credentialReference, resolveCredential: resolver, providerAuthorityFingerprint: providerAuthority.authorityFingerprint, fetchImpl: dependencies.fetchImpl, clock }, { canonicalDomain: domain.canonicalDomain, providerAuthority, requestFingerprint: stableFingerprint({ scope: 'funnel-domain-availability-v1', ownerUserId, sessionId, canonicalDomain: domain.canonicalDomain, checkedAt }), timeoutMs: 5_000, requireAutomaticEligibility: true })
  } catch (error) {
    const failure = error as { data?: { code?: string }; statusMessage?: string }
    const reason = ({ DOMAIN_UNAVAILABLE: 'unavailable', DOMAIN_UNSUPPORTED: 'unsupported', DOMAIN_PREMIUM: 'premium' } as const)[failure.data?.code as 'DOMAIN_UNAVAILABLE' | 'DOMAIN_UNSUPPORTED' | 'DOMAIN_PREMIUM']
    if (reason) return { canonicalDomain: domain.canonicalDomain, available: false, reason, messageZh: failure.statusMessage || '此網域目前無法自動註冊，請選擇其他名稱。' }
    throw error
  }
  if (quote.currency !== policy.currency || quote.amountMinor > policy.maxAmountMinor) return { canonicalDomain: domain.canonicalDomain, available: false, reason: 'unsupported', messageZh: '此網域價格不在目前自動註冊方案內，請選擇其他名稱。' }
  const snapshot = { schemaVersion: 'funnel-domain-availability-v1' as const, canonicalDomain: domain.canonicalDomain, available: true as const, checkedAt, expiresAt: quote.expiresAt, quote, providerAuthority, customerPrice: { amountMinor: catalog.annualMinor, currency: 'TWD' as const } }
  return { ...snapshot, quoteFingerprint: stableFingerprint({ ownerUserId, sessionId, ...snapshot }) }
}

export function publicFunnelDomainAvailability(snapshot: FunnelDomainAvailabilitySnapshot | FunnelDomainUnavailable) {
  if (!snapshot.available) return snapshot
  return { canonicalDomain: snapshot.canonicalDomain, available: true as const, quoteFingerprint: snapshot.quoteFingerprint, expiresAt: snapshot.expiresAt, customerPrice: { ...snapshot.customerPrice } }
}

/** Refresh availability within the already accepted delegation; it cannot change customer consent or prices. */
export async function assertFunnelDomainReadyForCheckout(ownerUserId: number, session: Pick<ManagedSiteFunnelSession, 'id' | 'answers' | 'consentSnapshot'>, dependencies: Dependencies = {}) {
  const original = assertFunnelDomainDelegationForSession(session, dependencies.clock, { allowExpiredAcceptedQuote: true })
  const current = await checkFunnelDomainAvailability(ownerUserId, session.id, original.canonicalDomain, dependencies)
  if (!current.available) throw createError({ statusCode: 409, statusMessage: current.messageZh })
  const accepted = original.delegation
  if (current.canonicalDomain !== accepted.canonicalDomain || current.quote.providerKey !== accepted.quote.providerKey || current.providerAuthority.authorityFingerprint !== accepted.quote.providerAuthorityFingerprint || current.quote.providerAuthorityFingerprint !== accepted.quote.providerAuthorityFingerprint || current.customerPrice.currency !== accepted.customerPrice.currency || current.customerPrice.amountMinor !== accepted.customerPrice.amountMinor || current.quote.currency !== accepted.quote.currency || current.quote.amountMinor > accepted.quote.amountMinor) throw createError({ statusCode: 409, statusMessage: '網域價格或註冊商設定已變更，無法依原授權繼續付款。' })
  return current
}

import { createError } from 'h3'
import { getManagedSitePriceCatalog } from '../ordering-service'
import { checkFunnelDomainAvailability } from './domain-registration'
import { createFunnelDomainRegistrationDelegation, MANAGED_SITE_FUNNEL_DOMAIN_DELEGATION_TERMS, MANAGED_SITE_FUNNEL_DOMAIN_DELEGATION_VERSION } from './domain-purchase-authority'
import { getFunnelSessionRepository, type FunnelSessionRepository } from './session-repository'
import { loadFunnelSession, MANAGED_SITE_FUNNEL_CONSENT_VERSION, type FunnelAnswers } from './session-service'

function record(value: unknown): Record<string, any> { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {} }
function invalid(message: string, statusCode = 409): never { throw createError({ statusCode, statusMessage: message }) }

/** Public projection deliberately excludes provider credentials, wholesale prices and authority snapshots. */
export function projectFunnelDomainSelection(snapshot: unknown) {
  const consent = record(snapshot)
  const available = record(consent.domainAvailability)
  const delegation = record(consent.domainRegistration)
  return {
    domainAvailability: available.available === true ? { available: true as const, canonicalDomain: available.canonicalDomain, quoteFingerprint: available.quoteFingerprint, expiresAt: available.expiresAt, customerPrice: available.customerPrice } : null,
    domainRegistration: delegation.delegated === true ? { delegated: true as const, canonicalDomain: delegation.canonicalDomain, registrant: delegation.registrant, termsVersion: delegation.schemaVersion } : null,
    domainDelegationTerms: MANAGED_SITE_FUNNEL_DOMAIN_DELEGATION_TERMS,
    domainDelegationVersion: MANAGED_SITE_FUNNEL_DOMAIN_DELEGATION_VERSION,
  }
}

export async function checkAndStoreFunnelDomain(ownerUserId: number, sessionId: number, token: string, input: { name: unknown; tld: unknown }, dependencies: { repository?: FunnelSessionRepository; checkAvailability?: typeof checkFunnelDomainAvailability; clock?: () => Date } = {}) {
  const repository = dependencies.repository || getFunnelSessionRepository()
  const clock = dependencies.clock || (() => new Date())
  const session = await loadFunnelSession(sessionId, token, repository, clock)
  if (session.status !== 'active') invalid('網站建置已開始，不能變更網域。')
  if (typeof input.name !== 'string' || typeof input.tld !== 'string') invalid('請填寫有效的網域名稱與結尾。', 422)
  const name = input.name.trim().toLowerCase()
  const tld = input.tld.trim().toLowerCase()
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(name) || !getManagedSitePriceCatalog().domainTlds.some(item => item.tld === tld)) invalid('請填寫支援的網域名稱與結尾。', 422)
  const result = await (dependencies.checkAvailability || checkFunnelDomainAvailability)(ownerUserId, sessionId, `${name}.${tld}`)
  // Re-read after external I/O so an unrelated newly saved wizard step is not overwritten.
  const latest = await loadFunnelSession(sessionId, token, repository, clock)
  const { domainAvailability: _oldQuote, domainRegistration: _oldConsent, ...retained } = record(latest.consentSnapshot)
  const updated = await repository.transitionSession(sessionId, 'active', { consentSnapshot: { ...retained, ...(result.available ? { domainAvailability: result } : {}) } })
  if (!updated) invalid('網站建置已開始，不能變更網域。')
  if (!result.available) return result
  return projectFunnelDomainSelection(updated.consentSnapshot).domainAvailability!
}

export async function recordFunnelDomainDelegation(sessionId: number, token: string, input: { delegated: unknown; registrant: unknown; quoteFingerprint: unknown; termsVersion: unknown }, repository: FunnelSessionRepository = getFunnelSessionRepository(), clock: () => Date = () => new Date()) {
  const session = await loadFunnelSession(sessionId, token, repository, clock)
  if (session.status !== 'active') invalid('網站建置已開始，不能變更網域授權。')
  const consent = record(session.consentSnapshot)
  const availability = record(consent.domainAvailability)
  const domain = (session.answers as FunnelAnswers).domain
  if (consent.policyVersion !== MANAGED_SITE_FUNNEL_CONSENT_VERSION || consent.scrolledToBottom !== true || input.delegated !== true || input.termsVersion !== MANAGED_SITE_FUNNEL_DOMAIN_DELEGATION_VERSION) invalid('請閱讀並同意網站與網域代註冊授權。')
  if (domain?.option !== 'new' || availability.available !== true || availability.canonicalDomain !== `${domain.name}.${domain.tld}` || input.quoteFingerprint !== availability.quoteFingerprint || !Number.isFinite(Date.parse(availability.expiresAt)) || Date.parse(availability.expiresAt) <= clock().getTime()) invalid('網域選擇或報價已失效，請重新查詢。')
  const delegation = createFunnelDomainRegistrationDelegation({ sessionId, canonicalDomain: availability.canonicalDomain, registrant: input.registrant, quote: availability.quote, customerPrice: availability.customerPrice, acceptedAt: clock().toISOString() })
  const updated = await repository.transitionSession(sessionId, 'active', { consentSnapshot: { ...consent, domainRegistration: delegation } })
  if (!updated) invalid('網站建置已開始，不能變更網域授權。')
  return updated
}

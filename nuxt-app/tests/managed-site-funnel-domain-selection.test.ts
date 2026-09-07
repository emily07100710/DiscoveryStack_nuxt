import { describe, expect, it, vi } from 'vitest'
import { checkAndStoreFunnelDomain, projectFunnelDomainSelection, recordFunnelDomainDelegation } from '../server/managed-sites/funnel/domain-selection'
import { MANAGED_SITE_FUNNEL_DOMAIN_DELEGATION_VERSION } from '../server/managed-sites/funnel/domain-purchase-authority'
import { createFunnelSession, MANAGED_SITE_FUNNEL_CONSENT_VERSION, recordFunnelConsent, saveFunnelStep } from '../server/managed-sites/funnel/session-service'
import type { FunnelDomainAvailabilitySnapshot } from '../server/managed-sites/funnel/domain-registration'
import { createFunnelSessionMemoryRepository } from './fixtures/managed-site/funnel-session-repository'

const now = new Date('2026-09-06T12:00:00Z')
const clock = () => now
const registrant = { firstName: 'Customer', lastName: 'Example', organization: '', address1: '1 Example Road', city: 'Taipei', state: '', postalCode: '100', country: 'TW', phoneCountryCode: '886', phone: '912345678', email: 'customer@example.test' }
const snapshot: FunnelDomainAvailabilitySnapshot = { schemaVersion: 'funnel-domain-availability-v1', canonicalDomain: 'selected-example.com', available: true, checkedAt: now.toISOString(), expiresAt: new Date(now.getTime() + 600_000).toISOString(), quote: { providerKey: 'porkbun', quoteId: 'porkbun-quote:123', canonicalDomain: 'selected-example.com', amountMinor: 1100, currency: 'USD', expiresAt: new Date(now.getTime() + 600_000).toISOString(), providerAuthorityFingerprint: 'a'.repeat(64), exactResponseIdentity: 'supplier-private-reference' }, providerAuthority: { credentialReference: 'never-public' } as any, quoteFingerprint: 'b'.repeat(64), customerPrice: { amountMinor: 150000, currency: 'TWD' } }
async function fixture() {
  const memory = createFunnelSessionMemoryRepository()
  const created = await createFunnelSession(memory.repository, clock)
  const checkAvailability = vi.fn(async () => structuredClone(snapshot))
  const check = (name: unknown = 'selected-example', tld: unknown = 'com') => checkAndStoreFunnelDomain(1, created.sessionId, created.sessionToken, { name, tld }, { repository: memory.repository, clock, checkAvailability })
  const consent = () => recordFunnelConsent(created.sessionId, created.sessionToken, { policyVersion: MANAGED_SITE_FUNNEL_CONSENT_VERSION, scrolledToBottom: true }, memory.repository, clock)
  const saveDomain = (name = 'selected-example') => saveFunnelStep(created.sessionId, created.sessionToken, { step: 7, answers: { domain: { option: 'new', name, tld: 'com' } } }, memory.repository, clock)
  const delegate = (patch: Record<string, unknown> = {}) => recordFunnelDomainDelegation(created.sessionId, created.sessionToken, { delegated: true, registrant, quoteFingerprint: snapshot.quoteFingerprint, termsVersion: MANAGED_SITE_FUNNEL_DOMAIN_DELEGATION_VERSION, ...patch }, memory.repository, clock)
  return { ...memory, created, checkAvailability, check, consent, saveDomain, delegate }
}

describe('funnel exact selected-domain authorization', () => {
  it('stores the authoritative quote while returning only customer-safe information', async () => {
    const f = await fixture()
    const result = await f.check()
    expect(f.checkAvailability).toHaveBeenCalledWith(1, f.created.sessionId, 'selected-example.com')
    expect(result).toMatchObject({ available: true, canonicalDomain: snapshot.canonicalDomain, customerPrice: snapshot.customerPrice })
    expect(JSON.stringify(result)).not.toMatch(/USD|supplier-private-reference|never-public|providerAuthority/)
    expect((f.state.sessions[0]!.consentSnapshot as any).domainAvailability).toEqual(snapshot)
  })
  it('retains a verified quote through domain saving and the normal consent action', async () => {
    const f = await fixture(); await f.check(); await f.saveDomain(); await f.consent()
    const session = await f.delegate()
    expect((session.consentSnapshot as any).domainRegistration).toMatchObject({ canonicalDomain: snapshot.canonicalDomain, delegated: true, registrant, quote: snapshot.quote })
    await f.consent()
    expect((f.state.sessions[0]!.consentSnapshot as any).domainRegistration.consentFingerprint).toMatch(/^[a-f0-9]{64}$/)
    expect(JSON.stringify(projectFunnelDomainSelection(session.consentSnapshot))).not.toMatch(/USD|supplier-private-reference|never-public|providerAuthority/)
  })
  it.each([{ delegated: false }, { quoteFingerprint: 'forged' }, { termsVersion: 'old' }, { registrant: { ...registrant, address1: '' } }])('rejects missing or substituted customer authorization %j', async patch => {
    const f = await fixture(); await f.check(); await f.saveDomain(); await f.consent()
    await expect(f.delegate(patch)).rejects.toBeTruthy()
    expect((f.state.sessions[0]!.consentSnapshot as any).domainRegistration).toBeUndefined()
  })
  it('requires the standard consent and the exact currently selected domain', async () => {
    const f = await fixture(); await f.check(); await f.saveDomain()
    await expect(f.delegate()).rejects.toMatchObject({ statusCode: 409 })
    await f.consent(); await f.saveDomain('someone-else')
    await expect(f.delegate()).rejects.toMatchObject({ statusCode: 409 })
  })
  it('invalidates old delegation on domain change and replaces the complete domain answer', async () => {
    const f = await fixture(); await f.check(); await f.saveDomain(); await f.consent(); await f.delegate()
    const session = await saveFunnelStep(f.created.sessionId, f.created.sessionToken, { step: 7, answers: { domain: { option: 'existing', name: 'owned.example' } } }, f.repository, clock)
    expect((session.answers as any).domain).toEqual({ option: 'existing', name: 'owned.example' })
    expect((session.consentSnapshot as any).domainRegistration).toBeUndefined()
  })
  it('rejects expired verified quotes without accepting client-supplied prices', async () => {
    const f = await fixture(); await f.check(); await f.saveDomain(); await f.consent()
    ;(f.state.sessions[0]!.consentSnapshot as any).domainAvailability.expiresAt = now.toISOString()
    await expect(f.delegate()).rejects.toMatchObject({ statusCode: 409 })
    await expect(saveFunnelStep(f.created.sessionId, f.created.sessionToken, { step: 7, answers: { domainRegistration: { quote: snapshot.quote } } as any }, f.repository, clock)).rejects.toBeTruthy()
  })
  it('does not store a late provider response after a build claims the session', async () => {
    const f = await fixture()
    f.checkAvailability.mockImplementationOnce(async () => { await f.repository.transitionSession(f.created.sessionId, 'active', { status: 'building' }); return snapshot })
    await expect(f.check()).rejects.toMatchObject({ statusCode: 409 })
    expect(f.state.sessions[0]!.consentSnapshot).toBeNull()
  })
  it.each([['bad/name', 'com'], ['good', 'unsupported'], [123, 'com']])('rejects invalid domain %s.%s before provider I/O', async (name, tld) => {
    const f = await fixture(); await expect(f.check(name, tld)).rejects.toMatchObject({ statusCode: 422 })
    expect(f.checkAvailability).not.toHaveBeenCalled()
  })
})

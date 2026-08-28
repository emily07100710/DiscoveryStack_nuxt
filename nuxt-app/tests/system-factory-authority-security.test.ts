import { describe, expect, it } from 'vitest'
import { createGuidedSystemSpec } from '../server/system-factory/planner'
import { compileSystemSpec } from '../server/system-factory/compiler'
import { assertPublicFrappeOrigin, createTenantAppAdapter } from '../server/system-factory/frappe-adapter'
import { MemoryNoncePort, signEnvelope, verifyRawEnvelopeBeforeLookup } from '../server/system-factory/hmac'
import { MemoryWorkflowRepository, applyVerifiedTransition } from '../server/system-factory/workflow'
import { fingerprint } from '../server/system-factory/canonical'

function spec() { return createGuidedSystemSpec({ requirements: '建立受治理的預約服務流程。', businessType: 'service', industry: 'wellness', preferredTemplate: 'appointment_booking', identity: { specId: 'spec-security', ownerId: 'owner:1', clientId: 'client:1', websiteId: 'website:1', managedSiteId: null, systemTenantId: 'tenant:1', locale: 'zh-hant', timezone: 'Asia/Taipei', currency: 'TWD' } }) }

describe('System Factory authority and security boundaries', () => {
  it('verifies raw body hash and HMAC before any nonce lookup/write', async () => {
    const body = JSON.stringify({ tenant: 'tenant:1' }); const key = 'test-only-hmac-key-material'; const headers = signEnvelope({ method: 'POST', path: '/internal/apply', rawBody: body, sender: 'nuxt-server', receiver: 'frappe-site', keyId: 'key:1', key, now: new Date('2030-01-01T00:00:00.000Z'), nonce: 'nonce-00000001' }); let nonceCalls = 0
    const noncePort = { consume: async () => { nonceCalls += 1; return true as const } }
    await expect(verifyRawEnvelopeBeforeLookup({ method: 'POST', path: '/internal/apply', rawBody: `${body}x`, headers, expectedSender: 'nuxt-server', expectedReceiver: 'frappe-site', expectedKeyId: 'key:1', key, noncePort, now: new Date('2030-01-01T00:00:00.000Z') })).rejects.toThrow(/body hash/i); expect(nonceCalls).toBe(0)
    await expect(verifyRawEnvelopeBeforeLookup({ method: 'POST', path: '/internal/apply', rawBody: body, headers, expectedSender: 'nuxt-server', expectedReceiver: 'frappe-site', expectedKeyId: 'key:1', key, noncePort, now: new Date('2030-01-01T00:00:00.000Z') })).resolves.toMatchObject({ bodySha256: headers.bodySha256 }); expect(nonceCalls).toBe(1)
  })

  it('requires atomic nonce exact true and rejects replay/stale timestamp', async () => {
    const body = '{}'; const key = 'test-only-hmac-key-material'; const at = new Date('2030-01-01T00:00:00.000Z'); const headers = signEnvelope({ method: 'POST', path: '/internal/apply', rawBody: body, sender: 'nuxt-server', receiver: 'frappe-site', keyId: 'key:1', key, now: at, nonce: 'nonce-00000002' }); const nonces = new MemoryNoncePort()
    await verifyRawEnvelopeBeforeLookup({ method: 'POST', path: '/internal/apply', rawBody: body, headers, expectedSender: 'nuxt-server', expectedReceiver: 'frappe-site', expectedKeyId: 'key:1', key, noncePort: nonces, now: at })
    await expect(verifyRawEnvelopeBeforeLookup({ method: 'POST', path: '/internal/apply', rawBody: body, headers, expectedSender: 'nuxt-server', expectedReceiver: 'frappe-site', expectedKeyId: 'key:1', key, noncePort: nonces, now: at })).rejects.toThrow(/nonce/i)
    const stale = signEnvelope({ method: 'POST', path: '/internal/apply', rawBody: body, sender: 'nuxt-server', receiver: 'frappe-site', keyId: 'key:1', key, now: at, nonce: 'nonce-00000003' }); await expect(verifyRawEnvelopeBeforeLookup({ method: 'POST', path: '/internal/apply', rawBody: body, headers: stale, expectedSender: 'nuxt-server', expectedReceiver: 'frappe-site', expectedKeyId: 'key:1', key, noncePort: new MemoryNoncePort(), now: new Date('2030-01-01T01:00:00.000Z') })).rejects.toThrow(/stale/i)
  })

  it.each(['http://erp.example.com', 'https://localhost', 'https://127.0.0.1', 'https://10.0.0.1', 'https://169.254.1.2', 'https://service.internal', 'https://[::1]'])('rejects SSRF and special-use Frappe origin %s', origin => { expect(() => assertPublicFrappeOrigin(origin, [origin])).toThrow() })

  it('keeps credentials server-only and dry-run redacted with zero fetch', async () => {
    let resolverCalls = 0; let fetchCalls = 0; const adapter = createTenantAppAdapter({ endpointOrigin: 'https://frappe.vendor.example.org', allowedOrigins: ['https://frappe.vendor.example.org'], sender: 'nuxt-server', receiver: 'frappe-site', keyId: 'key:1', liveEnabled: false, credentialResolver: async () => { resolverCalls += 1; return { ok: true, value: { hmacKey: 'never-browser-visible-secret'.repeat(2), authorizationHeader: 'token opaque-api-key:opaque-api-secret' } } }, fetchImpl: async () => { fetchCalls += 1; return new Response() } }); const compiledPlan = compileSystemSpec(spec())
    await expect(adapter.health({ ownerId: 'owner:1', clientId: 'client:1', websiteId: 'website:1', managedSiteId: null, systemTenantId: 'tenant:1', siteName: 'opaque.example.org', credentialReference: 'vault:frappe-test', idempotencyKey: 'disabled-0001', compiledPlan, executionMode: 'mocked', runtimeAuthority: (await import('../server/system-factory/runtime-authority')).testRuntimeAuthority() })).rejects.toThrow(/disabled/i)
    expect(resolverCalls).toBe(0); expect(fetchCalls).toBe(0)
  })

  it('fails owner/client/tenant mismatch and cross-tenant verified events closed', async () => {
    const repository = new MemoryWorkflowRepository(); const compiled = compileSystemSpec(spec()); repository.seed({ ownerId: 'owner:1', clientId: 'client:1', websiteId: 'website:1', managedSiteId: null, systemTenantId: 'tenant:1', state: 'active', stateVersion: 1, specFingerprint: compiled.specFingerprint, compiledPlanFingerprint: compiled.planFingerprint, managedSiteOrderId: 10, verifiedPaymentReceiptFingerprint: 'a'.repeat(64), leaseOwner: null, leaseExpiresAt: null, attempt: 1, maxAttempts: 3, retryEligibleAt: null, healthyReceiptFingerprint: 'b'.repeat(64), invitationReceiptFingerprint: 'c'.repeat(64) })
    const event = { eventId: 'event-1', type: 'suspended', ownerId: 'owner:2', clientId: 'client:1', systemTenantId: 'tenant:1', verified: true as const, authorityFingerprint: 'd'.repeat(64), occurredAt: new Date().toISOString(), payloadFingerprint: fingerprint({ event: 1 }) }
    await expect(applyVerifiedTransition(repository, 'owner:1', 'tenant:1', event)).rejects.toThrow(/authority/i)
  })
})

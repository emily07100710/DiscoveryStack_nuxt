import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { stableFingerprint } from '../server/seo-geo-core/repository'
import { createInternalHmacV1CheckoutAdapter } from '../server/managed-sites/live-connectors/broker-adapters'
import { managedSiteBrokerSignature } from '../server/managed-sites/live-connectors/hmac-broker-transport'
import { configureManagedSiteProvider, verifyManagedSiteProviderConfiguration } from '../server/managed-sites/live-connectors/provider-registry'
import { createLiveConnectorMemoryRepository } from './fixtures/managed-site/live-connectors-repository'

const originalOrigins = process.env.DISCOVERYSTACK_MANAGED_SITE_ALLOWED_PROVIDER_ORIGINS
const originalCheckoutOrigins = process.env.DISCOVERYSTACK_MANAGED_SITE_ALLOWED_CHECKOUT_ORIGINS
afterEach(() => {
  if (originalOrigins === undefined) delete process.env.DISCOVERYSTACK_MANAGED_SITE_ALLOWED_PROVIDER_ORIGINS; else process.env.DISCOVERYSTACK_MANAGED_SITE_ALLOWED_PROVIDER_ORIGINS = originalOrigins
  if (originalCheckoutOrigins === undefined) delete process.env.DISCOVERYSTACK_MANAGED_SITE_ALLOWED_CHECKOUT_ORIGINS; else process.env.DISCOVERYSTACK_MANAGED_SITE_ALLOWED_CHECKOUT_ORIGINS = originalCheckoutOrigins
})

describe('managed-site reachable server-only provider transports', () => {
  it('performs an owner-triggered bounded Bailian model capability probe without retaining generated text', async () => {
    const live = createLiveConnectorMemoryRepository(); const clock = () => new Date('2026-08-27T00:00:00.000Z')
    await configureManagedSiteProvider(1, { capability: 'website_generator', providerKey: 'bailian-qwen', readinessStatus: 'configured', credentialReference: 'vault:qwen-probe', transportConfiguration: { endpointOrigin: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions', model: 'qwen-plus' }, idempotencyKey: 'qwen-probe-config' }, live.repository)
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      expect(init.redirect).toBe('error'); const request = JSON.parse(String(init.body)); expect(request).toMatchObject({ model: 'qwen-plus', temperature: 0, max_tokens: 4, stream: false })
      expect(JSON.stringify(request)).toContain('no customer data'); expect(JSON.stringify(request)).not.toContain('Authoritative Managed Site')
      return new Response(JSON.stringify({ id: 'probe-request-001', object: 'chat.completion', created: 1787788800, model: 'qwen-plus', choices: [{ index: 0, message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }], usage: { prompt_tokens: 12, completion_tokens: 1, total_tokens: 13 } }), { status: 200, headers: { 'x-request-id': 'probe-request-001' } })
    })
    await verifyManagedSiteProviderConfiguration(1, 'website_generator', live.repository, async () => ({ ok: true, value: 'runtime-only-qwen-key' }), clock, undefined, fetchImpl as typeof fetch)
    expect((await live.repository.findProviderConfiguration(1, 'website_generator'))?.readinessStatus).toBe('verified')
    expect(JSON.stringify(live.state)).not.toContain('runtime-only-qwen-key')
    expect(JSON.stringify(live.state)).not.toContain('"OK"')
  })

  it('signs and validates exact internal_hmac_v1 checkout lineage and rejects response identity drift', async () => {
    process.env.DISCOVERYSTACK_MANAGED_SITE_ALLOWED_PROVIDER_ORIGINS = 'https://payments.acme-payments.com'
    process.env.DISCOVERYSTACK_MANAGED_SITE_ALLOWED_CHECKOUT_ORIGINS = 'https://checkout.acme-payments.com'
    const credential = 'runtime-only-hmac-gateway-key'; const now = new Date('2026-08-27T00:00:00.000Z')
    const input = { ownerUserId: 7, projectId: 11, releaseId: 13, previewId: 17, approvalFingerprint: 'a'.repeat(64), draftOrderId: 19, quoteId: 23, amountMinor: 2400, currency: 'USD', planKey: 'basic', cadenceDays: 7, domainOption: 'new', lineSnapshot: [{ lineKey: 'base', quantity: 1, unitAmountMinor: 2400, lineAmountMinor: 2400 }], taxStatus: 'not_calculated', snapshotFingerprint: 'b'.repeat(64), configurationFingerprint: 'c'.repeat(64), verificationReceiptFingerprint: 'd'.repeat(64), capabilityIdentity: 'payment-gateway:merchant-007', idempotencyKey: 'checkout-hmac-exact-001', timeoutMs: 5000 }
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe('https://payments.acme-payments.com/v1/managed-sites/checkout-sessions'); expect(init.redirect).toBe('error')
      const requestNonce = new Headers(init.headers).get('x-discoverystack-nonce')!; const providerRequestId = 'provider-checkout-001'
      const requestPayloadHash = stableFingerprint({ ownerUserId: input.ownerUserId, projectId: input.projectId, releaseId: input.releaseId, previewId: input.previewId, quoteId: input.quoteId, draftOrderId: input.draftOrderId, approvalFingerprint: input.approvalFingerprint, configurationFingerprint: input.configurationFingerprint, verificationReceiptFingerprint: input.verificationReceiptFingerprint, capabilityIdentity: input.capabilityIdentity, snapshotFingerprint: input.snapshotFingerprint, idempotencyKey: input.idempotencyKey })
      const body = JSON.stringify({ schemaVersion: 'managed-site-checkout-response-v1', providerKey: 'internal_hmac_v1', providerEventId: providerRequestId, providerReference: 'checkout-session-001', checkoutUrl: 'https://checkout.acme-payments.com/session/001', ownerUserId: input.ownerUserId, projectId: input.projectId, releaseId: input.releaseId, previewId: input.previewId, quoteId: input.quoteId, draftOrderId: input.draftOrderId, approvalFingerprint: input.approvalFingerprint, configurationFingerprint: input.configurationFingerprint, verificationReceiptFingerprint: input.verificationReceiptFingerprint, capabilityIdentity: input.capabilityIdentity, amountMinor: input.amountMinor, currency: input.currency, snapshotFingerprint: input.snapshotFingerprint, requestPayloadHash })
      const bodyHash = createHash('sha256').update(body).digest('hex'); const timestamp = now.toISOString(); const nonce = 'provider-response-nonce-001'
      const signature = managedSiteBrokerSignature({ method: 'POST', path: '/v1/managed-sites/checkout-sessions', timestamp, nonce, requestNonce, bodyHash }, credential)
      return new Response(body, { status: 200, headers: { 'x-discoverystack-timestamp': timestamp, 'x-discoverystack-nonce': nonce, 'x-provider-request-id': providerRequestId, 'x-discoverystack-signature': signature } })
    })
    const adapter = createInternalHmacV1CheckoutAdapter({ endpointOrigin: 'https://payments.acme-payments.com', checkoutOrigin: 'https://checkout.acme-payments.com', providerKey: 'internal_hmac_v1', credentialReference: 'vault:payments', resolveCredential: async () => ({ ok: true, value: credential }), fetchImpl: fetchImpl as typeof fetch, clock: () => now })
    const result = await adapter.createSession(input); expect(result).toMatchObject({ providerKey: 'internal_hmac_v1', draftOrderId: 19, amountMinor: 2400, currency: 'USD' }); expect(fetchImpl).toHaveBeenCalledOnce()
    expect(() => createInternalHmacV1CheckoutAdapter({ endpointOrigin: 'https://127.0.0.1', providerKey: 'internal_hmac_v1', credentialReference: 'vault:payments', resolveCredential: async () => ({ ok: true, value: credential }) })).toThrow()
  })

  it.each([
    ['attacker domain', 'https://attacker.example/session/001'],
    ['lookalike domain', 'https://checkout.acme-payments.com.attacker.example/session/001'],
    ['userinfo', 'https://user@checkout.acme-payments.com/session/001'],
    ['fragment', 'https://checkout.acme-payments.com/session/001#continue'],
    ['redirect-like query', 'https://checkout.acme-payments.com/session/001?redirect=https%3A%2F%2Fattacker.example'],
    ['private host', 'https://127.0.0.1/session/001'],
    ['special-use host', 'https://localhost/session/001'],
  ])('rejects a validly signed checkout response containing a %s URL', async (_label, checkoutUrl) => {
    process.env.DISCOVERYSTACK_MANAGED_SITE_ALLOWED_PROVIDER_ORIGINS = 'https://payments.acme-payments.com'
    process.env.DISCOVERYSTACK_MANAGED_SITE_ALLOWED_CHECKOUT_ORIGINS = 'https://checkout.acme-payments.com'
    const credential = 'runtime-only-hmac-gateway-key'; const now = new Date('2026-08-27T00:00:00.000Z')
    const input = { ownerUserId: 7, projectId: 11, releaseId: 13, previewId: 17, approvalFingerprint: 'a'.repeat(64), draftOrderId: 19, quoteId: 23, amountMinor: 2400, currency: 'USD', planKey: 'basic', cadenceDays: 7, domainOption: 'new', lineSnapshot: [{ lineKey: 'base', quantity: 1, unitAmountMinor: 2400, lineAmountMinor: 2400 }], taxStatus: 'not_calculated', snapshotFingerprint: 'b'.repeat(64), configurationFingerprint: 'c'.repeat(64), verificationReceiptFingerprint: 'd'.repeat(64), capabilityIdentity: 'payment-gateway:merchant-007', idempotencyKey: `checkout-malicious-${_label.replace(/ /gu, '-')}`, timeoutMs: 5000 }
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      const requestNonce = new Headers(init.headers).get('x-discoverystack-nonce')!; const providerRequestId = `provider-${input.idempotencyKey}`
      const requestPayloadHash = stableFingerprint({ ownerUserId: input.ownerUserId, projectId: input.projectId, releaseId: input.releaseId, previewId: input.previewId, quoteId: input.quoteId, draftOrderId: input.draftOrderId, approvalFingerprint: input.approvalFingerprint, configurationFingerprint: input.configurationFingerprint, verificationReceiptFingerprint: input.verificationReceiptFingerprint, capabilityIdentity: input.capabilityIdentity, snapshotFingerprint: input.snapshotFingerprint, idempotencyKey: input.idempotencyKey })
      const body = JSON.stringify({ schemaVersion: 'managed-site-checkout-response-v1', providerKey: 'internal_hmac_v1', providerEventId: providerRequestId, providerReference: 'checkout-session-malicious-001', checkoutUrl, ownerUserId: input.ownerUserId, projectId: input.projectId, releaseId: input.releaseId, previewId: input.previewId, quoteId: input.quoteId, draftOrderId: input.draftOrderId, approvalFingerprint: input.approvalFingerprint, configurationFingerprint: input.configurationFingerprint, verificationReceiptFingerprint: input.verificationReceiptFingerprint, capabilityIdentity: input.capabilityIdentity, amountMinor: input.amountMinor, currency: input.currency, snapshotFingerprint: input.snapshotFingerprint, requestPayloadHash })
      const bodyHash = createHash('sha256').update(body).digest('hex'); const timestamp = now.toISOString(); const nonce = `nonce-${input.idempotencyKey}`
      const signature = managedSiteBrokerSignature({ method: 'POST', path: '/v1/managed-sites/checkout-sessions', timestamp, nonce, requestNonce, bodyHash }, credential)
      return new Response(body, { status: 200, headers: { 'x-discoverystack-timestamp': timestamp, 'x-discoverystack-nonce': nonce, 'x-provider-request-id': providerRequestId, 'x-discoverystack-signature': signature } })
    })
    const adapter = createInternalHmacV1CheckoutAdapter({ endpointOrigin: 'https://payments.acme-payments.com', checkoutOrigin: 'https://checkout.acme-payments.com', providerKey: 'internal_hmac_v1', credentialReference: 'vault:payments', resolveCredential: async () => ({ ok: true, value: credential }), fetchImpl: fetchImpl as typeof fetch, clock: () => now })
    await expect(adapter.createSession(input)).rejects.toMatchObject({ statusCode: 409 })
  })
})

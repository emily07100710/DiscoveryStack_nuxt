import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { stableFingerprint } from '../server/seo-geo-core/repository'
import { createInternalDomainBrokerHmacV1Adapter, createInternalHmacV1CheckoutAdapter } from '../server/managed-sites/live-connectors/broker-adapters'
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
  it('binds the domain broker transport to one exact non-sensitive provider authority', async () => {
    process.env.DISCOVERYSTACK_MANAGED_SITE_ALLOWED_PROVIDER_ORIGINS = 'https://domains.acme-provider.com'
    const credential = 'runtime-only-domain-broker-key'; const now = new Date('2026-08-27T00:00:00.000Z'); const authorityFingerprint = 'a'.repeat(64)
    const providerAuthority = { schemaVersion: 'managed-site-provider-authority-v1' as const, capability: 'domain_registration' as const, providerKey: 'internal-domain-broker-hmac-v1', configurationFingerprint: 'b'.repeat(64), verificationReceiptFingerprint: 'c'.repeat(64), capabilityIdentity: 'domain-account:merchant-001', readinessStatus: 'verified' as const, executionMode: 'live' as const, verifiedAt: now.toISOString(), authorityFingerprint }
    const input = { ownerUserId: 1, projectId: 2, releaseId: 3, canonicalDomain: 'authority.acme.taipei', providerAuthority, requestFingerprint: 'd'.repeat(64), timeoutMs: 5000 }
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      const requestNonce = new Headers(init.headers).get('x-discoverystack-nonce')!; const providerRequestId = 'domain-authority-event-001'
      const body = JSON.stringify({ schemaVersion: 'managed-site-domain-quote-response-v1', providerKey: 'internal-domain-broker-hmac-v1', providerEventId: providerRequestId, quoteId: 'domain-quote-001', ownerUserId: 1, projectId: 2, releaseId: 3, canonicalDomain: input.canonicalDomain, amountMinor: 1200, currency: 'TWD', expiresAt: new Date(now.getTime() + 60_000).toISOString(), requestFingerprint: input.requestFingerprint, providerAuthorityFingerprint: authorityFingerprint })
      const bodyHash = createHash('sha256').update(body).digest('hex'); const timestamp = now.toISOString(); const nonce = 'domain-authority-response-nonce'
      const signature = managedSiteBrokerSignature({ method: 'POST', path: '/v1/managed-sites/domain/quote', timestamp, nonce, requestNonce, bodyHash }, credential)
      return new Response(body, { status: 200, headers: { 'x-discoverystack-timestamp': timestamp, 'x-discoverystack-nonce': nonce, 'x-provider-request-id': providerRequestId, 'x-discoverystack-signature': signature } })
    })
    const adapter = createInternalDomainBrokerHmacV1Adapter({ endpointOrigin: 'https://domains.acme-provider.com', providerKey: 'internal-domain-broker-hmac-v1', credentialReference: 'vault:domains', resolveCredential: async () => ({ ok: true, value: credential }), providerAuthorityFingerprint: authorityFingerprint, fetchImpl: fetchImpl as typeof fetch, clock: () => now })
    await expect(adapter.quote(input)).resolves.toMatchObject({ providerAuthorityFingerprint: authorityFingerprint, canonicalDomain: input.canonicalDomain }); expect(fetchImpl).toHaveBeenCalledOnce()
    await expect(adapter.quote({ ...input, providerAuthority: { ...providerAuthority, authorityFingerprint: 'f'.repeat(64) } })).rejects.toMatchObject({ statusCode: 409 }); expect(fetchImpl).toHaveBeenCalledOnce()
  })

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

  it('accepts a real vendor chat-completion shape with additive metadata while still rejecting identity drift', async () => {
    const clock = () => new Date('2026-09-04T00:00:00.000Z')
    const endpointOrigin = 'https://ws-yythvp4rp02q11he.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1/chat/completions'
    const model = 'qwen3.8-max-0902'
    // Captured verbatim from the owner's Bailian workspace: the body id carries a `chatcmpl-` prefix over the
    // transport request id, the choice carries `logprobs`, the message carries `reasoning_content`, and usage
    // carries token detail objects. None of that is tampering, so verification must succeed.
    const transportRequestId = '849240a6-0c33-9001-ac59-c5c9765e817d'
    const vendorBody = (overrides: Record<string, unknown> = {}) => ({
      id: `chatcmpl-${transportRequestId}`, object: 'chat.completion', created: 1788506021, model,
      choices: [{ index: 0, message: { role: 'assistant', reasoning_content: 'We need to respond to user with OK.', content: 'OK' }, finish_reason: 'stop', logprobs: null }],
      usage: { prompt_tokens: 76, total_tokens: 109, completion_tokens: 33, prompt_tokens_details: { cached_tokens: 0, text_tokens: 76 }, completion_tokens_details: { reasoning_tokens: 29, text_tokens: 33 } },
      ...overrides,
    })
    const probe = async (body: Record<string, unknown>, requestId = transportRequestId) => {
      const live = createLiveConnectorMemoryRepository()
      await configureManagedSiteProvider(1, { capability: 'website_generator', providerKey: 'bailian-qwen', readinessStatus: 'configured', credentialReference: 'vault:qwen-real-shape', transportConfiguration: { endpointOrigin, model }, idempotencyKey: 'qwen-real-shape-config' }, live.repository)
      const fetchImpl = vi.fn(async () => new Response(JSON.stringify(body), { status: 200, headers: { 'x-request-id': requestId } }))
      const verified = verifyManagedSiteProviderConfiguration(1, 'website_generator', live.repository, async () => ({ ok: true, value: 'runtime-only-qwen-key' }), clock, undefined, fetchImpl as unknown as typeof fetch)
      return { live, verified }
    }

    const accepted = await probe(vendorBody())
    await accepted.verified
    const stored = await accepted.live.repository.findProviderConfiguration(1, 'website_generator')
    expect(stored?.readinessStatus).toBe('verified')
    expect(JSON.stringify(accepted.live.state)).not.toContain('runtime-only-qwen-key')
    expect(JSON.stringify(accepted.live.state)).not.toContain('reasoning_content')

    // The additive-metadata tolerance must not weaken the anti-tampering checks the probe exists for.
    await expect((await probe(vendorBody({ model: 'qwen-plus' }))).verified).rejects.toMatchObject({ statusCode: 409 })
    await expect((await probe(vendorBody(), 'a-different-request-id')).verified).rejects.toMatchObject({ statusCode: 409 })
    await expect((await probe(vendorBody({ id: `chatcmpl-${transportRequestId}-tail` }))).verified).rejects.toMatchObject({ statusCode: 409 })
    await expect((await probe(vendorBody({ usage: { prompt_tokens: 76, completion_tokens: 33, total_tokens: 999 } }))).verified).rejects.toMatchObject({ statusCode: 409 })
    await expect((await probe(vendorBody({ choices: [{ index: 0, message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }, { index: 1, message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }] }))).verified).rejects.toMatchObject({ statusCode: 409 })
  })

  it('signs and validates exact internal_hmac_v1 checkout lineage and rejects response identity drift', async () => {
    process.env.DISCOVERYSTACK_MANAGED_SITE_ALLOWED_PROVIDER_ORIGINS = 'https://payments.acme-payments.com'
    process.env.DISCOVERYSTACK_MANAGED_SITE_ALLOWED_CHECKOUT_ORIGINS = 'https://checkout.acme-payments.com'
    const credential = 'runtime-only-hmac-gateway-key'; const now = new Date('2026-08-27T00:00:00.000Z')
    const input = { ownerUserId: 7, projectId: 11, releaseId: 13, previewId: 17, approvalFingerprint: 'a'.repeat(64), draftOrderId: 19, quoteId: 23, amountMinor: 2400, currency: 'TWD', planKey: 'site_geo', cadenceDays: 7, domainOption: 'new', lineSnapshot: [{ lineKey: 'monthly-plan-site_geo', quantity: 1, unitAmountMinor: 2400, lineAmountMinor: 2400 }], taxStatus: 'not_calculated', snapshotFingerprint: 'b'.repeat(64), checkoutReceiptFingerprint: 'e'.repeat(64), configurationFingerprint: 'c'.repeat(64), verificationReceiptFingerprint: 'd'.repeat(64), capabilityIdentity: 'payment-gateway:merchant-007', idempotencyKey: 'checkout-hmac-exact-001', timeoutMs: 5000 }
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
    const result = await adapter.createSession(input); expect(result).toMatchObject({ providerKey: 'internal_hmac_v1', draftOrderId: 19, amountMinor: 2400, currency: 'TWD' }); expect(fetchImpl).toHaveBeenCalledOnce()
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
    const input = { ownerUserId: 7, projectId: 11, releaseId: 13, previewId: 17, approvalFingerprint: 'a'.repeat(64), draftOrderId: 19, quoteId: 23, amountMinor: 2400, currency: 'TWD', planKey: 'site_geo', cadenceDays: 7, domainOption: 'new', lineSnapshot: [{ lineKey: 'monthly-plan-site_geo', quantity: 1, unitAmountMinor: 2400, lineAmountMinor: 2400 }], taxStatus: 'not_calculated', snapshotFingerprint: 'b'.repeat(64), checkoutReceiptFingerprint: 'e'.repeat(64), configurationFingerprint: 'c'.repeat(64), verificationReceiptFingerprint: 'd'.repeat(64), capabilityIdentity: 'payment-gateway:merchant-007', idempotencyKey: `checkout-malicious-${_label.replace(/ /gu, '-')}`, timeoutMs: 5000 }
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

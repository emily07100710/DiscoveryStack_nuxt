import { describe, expect, it } from 'vitest'
import { createManagedSitePreview, createManagedSiteQuote, createManagedSiteDraftOrder, createManagedSiteLeadIntent, recordVerifiedPaymentEvent } from '../server/managed-sites/ordering-service'
import { convertPaidOrderToManagedProject } from '../server/managed-sites/conversion-service'
import type { PaymentEventVerifier } from '../server/managed-sites/ordering-types'
import type { ProvisioningAdapters } from '../server/managed-sites/provisioning-types'
import { createManagedSiteMemoryRepository } from './fixtures/managed-site/repository'
import { createProvisioningMemoryRepository } from './fixtures/managed-site/provisioning-repository'
import { createOrderingMemoryRepository } from './fixtures/managed-site/ordering-repository'
import { createManagedSiteDomainIntent, createManagedSiteProvisioningPlan, executeManagedSiteProvisioningPlan, getProvisioningWorkspace, normalizeDomain } from '../server/managed-sites/provisioning-service'

const actor = { ownerUserId: 1, actorUserId: 1, authority: 'owner_session' as const, role: 'owner' as const, principal: 'owner@acme.taipei' }
const mockPaymentVerifier: PaymentEventVerifier = { verify: async () => true }

async function makeLineage() {
  const managed = createManagedSiteMemoryRepository()
  const provisioning = createProvisioningMemoryRepository()
  const ordering = createOrderingMemoryRepository()
  const preview = await createManagedSitePreview(1, { draftIdentity: 'provisioning-preview-001', brandName: 'Provisioning Client', audience: 'Taiwan customers', brief: 'A governed managed website.', businessGoals: ['increase_inquiries'], siteType: 'brand_blog', selectedModules: ['managed_content_admin', 'geo_content_subscription'], styleReferences: [] }, ordering.repository)
  const quote = await createManagedSiteQuote({ previewId: preview.preview.id, previewAccessToken: preview.accessToken!, planKey: 'basic', cadenceDays: 7, domainOption: 'new', idempotencyKey: 'provisioning-quote-001' }, ordering.repository)
  const lead = await createManagedSiteLeadIntent({ previewId: preview.preview.id, previewAccessToken: preview.accessToken!, quoteId: quote.quote.quoteId, name: 'Provisioning Owner', email: 'owner@acme.taipei', company: 'Provisioning Client', website: 'https://provisioning-client.acme.taipei', privacyConsent: true, recontactConsent: false, idempotencyKey: 'provisioning-lead-001' }, ordering.repository)
  const order = await createManagedSiteDraftOrder({ previewId: preview.preview.id, previewAccessToken: preview.accessToken!, quoteId: quote.quote.quoteId, leadIntentId: lead.leadIntent.id, idempotencyKey: 'provisioning-order-001' }, ordering.repository)
  await recordVerifiedPaymentEvent({ draftOrderId: order.order.id, providerKey: 'mock-payment', eventId: 'provisioning-payment-001', providerReference: 'provisioning-payment-ref-001', eventType: 'payment_succeeded', amountMinor: quote.quote.totalMinor, currency: quote.quote.currency, canonicalPayloadHash: 'd'.repeat(64) }, mockPaymentVerifier, ordering.repository)
  const conversion = await convertPaidOrderToManagedProject(1, { draftOrderId: order.order.id, idempotencyKey: 'provisioning-conversion-001' }, { ordering: ordering.repository, managed: managed.repository })
  return { managed, provisioning, ordering, project: { project: conversion.project }, version: conversion.version, order: order.order }
}

describe('managed site provisioning core', () => {
  it('normalizes public domains and rejects URLs, wildcards, private names, and malformed labels', () => {
    expect(normalizeDomain('Acme.TAIPEI.')).toBe('acme.taipei')
    expect(() => normalizeDomain('https://acme.taipei')).toThrow()
    expect(() => normalizeDomain('*.acme.taipei')).toThrow()
    expect(() => normalizeDomain('localhost')).toThrow()
    expect(() => normalizeDomain('example..com')).toThrow()
  })

  it('creates an owner-scoped domain intent and replays exact idempotency', async () => {
    const line = await makeLineage()
    const first = await createManagedSiteDomainIntent(1, { projectId: line.project.project.id, mode: 'new_registration', requestedDomain: 'Acme.acme.taipei.', providerKey: 'porkbun-neutral', idempotencyKey: 'domain-intent-1' }, line.provisioning.repository, line.managed.repository)
    const replay = await createManagedSiteDomainIntent(1, { projectId: line.project.project.id, mode: 'new_registration', requestedDomain: 'acme.acme.taipei', providerKey: 'porkbun-neutral', idempotencyKey: 'domain-intent-1' }, line.provisioning.repository, line.managed.repository)
    expect(first.intent.normalizedDomain).toBe('acme.acme.taipei')
    expect(first.execution.externalCalls).toBe(false)
    expect(replay.replayed).toBe(true)
    await expect(createManagedSiteDomainIntent(2, { projectId: line.project.project.id, mode: 'new_registration', requestedDomain: 'other.acme.taipei', idempotencyKey: 'domain-cross-1' }, line.provisioning.repository, line.managed.repository)).rejects.toMatchObject({ statusCode: 404 })
  })

  it('creates an ordered provisioning plan and fails closed in dry-run without deployed claims', async () => {
    const line = await makeLineage()
    const intent = await createManagedSiteDomainIntent(1, { projectId: line.project.project.id, mode: 'customer_owned', requestedDomain: 'customer.acme.taipei', idempotencyKey: 'domain-dry-run-1' }, line.provisioning.repository, line.managed.repository)
    const plan = await createManagedSiteProvisioningPlan(1, { projectId: line.project.project.id, versionId: line.version.id, domainIntentId: intent.intent.id, platform: 'vercel', deploymentMode: 'preview_only', idempotencyKey: 'plan-dry-run-1' }, line.provisioning.repository, line.managed.repository)
    expect(plan.steps.map(step => step.stepKey)).toEqual(['domain_intent', 'domain_registration', 'dns_configuration', 'tls_verification', 'deployment'])
    const result = await executeManagedSiteProvisioningPlan(1, plan.plan.id, 'dry_run', undefined, line.provisioning.repository, line.managed.repository)
    expect(result.plan?.status).toBe('blocked')
    expect(result.externalCalls).toBe(false)
    expect(result.plan?.deployedUrl).toBeNull()
    expect(result.results.find(step => step.stepKey === 'domain_registration')?.providerConfigured).toBe(false)
    expect(result.events).toHaveLength(5)
  })

  it('supports an injected mocked provider path without enabling external execution', async () => {
    const line = await makeLineage()
    const intent = await createManagedSiteDomainIntent(1, { projectId: line.project.project.id, draftOrderId: line.order.id, mode: 'new_registration', requestedDomain: 'mocked.acme.taipei', providerKey: 'mock-registrar', idempotencyKey: 'domain-mocked-1' }, line.provisioning.repository, line.managed.repository)
    const plan = await createManagedSiteProvisioningPlan(1, { projectId: line.project.project.id, versionId: line.version.id, domainIntentId: intent.intent.id, platform: 'cloudflare_pages', deploymentMode: 'customer_authorized', idempotencyKey: 'plan-mocked-1' }, line.provisioning.repository, line.managed.repository, undefined, line.ordering.repository)
    const result = await executeManagedSiteProvisioningPlan(1, plan.plan.id, 'mocked', {
      async checkDomainAvailability(input) { return { status: 'available', normalizedDomain: input.normalizedDomain, providerKey: input.providerKey, externalCalls: false, limitation: 'Injected mock only.' } },
      async registerDomain(input) { return { status: 'registered', normalizedDomain: input.normalizedDomain, providerKey: input.providerKey, externalReference: 'mock-domain-ref', externalCalls: false, limitation: 'Injected mock only.' } },
      async configureDns(input) { return { status: 'configured', normalizedDomain: input.normalizedDomain, records: [{ type: 'CNAME', name: '@', value: 'mock.pages.dev' }], externalCalls: false, limitation: 'Injected mock only.' } },
      async verifyTls(input) { return { status: 'verified', normalizedDomain: input.normalizedDomain, certificateReference: 'mock-tls-ref', externalCalls: false, limitation: 'Injected mock only.' } },
      async deploySite(input) { return { status: 'deployed', platform: input.platform, deployedUrl: `https://${input.normalizedDomain}`, externalReference: 'mock-deployment-ref', externalCalls: false, limitation: 'Injected mock only.' } },
    }, line.provisioning.repository, line.managed.repository, undefined, line.ordering.repository)
    expect(result.plan?.status).toBe('succeeded')
    expect(result.plan?.deploymentStatus).toBe('built')
    expect(result.externalCalls).toBe(false)
    expect(result.plan?.deployedUrl).toBeNull()
    expect(result.results.every(step => step.externalCalls === false)).toBe(true)
  })

  it('rejects external execution and reports every provider as not connected', async () => {
    const line = await makeLineage()
    const intent = await createManagedSiteDomainIntent(1, { projectId: line.project.project.id, mode: 'assisted', requestedDomain: 'blocked.acme.taipei', idempotencyKey: 'domain-blocked-1' }, line.provisioning.repository, line.managed.repository)
    const plan = await createManagedSiteProvisioningPlan(1, { projectId: line.project.project.id, versionId: line.version.id, domainIntentId: intent.intent.id, platform: 'manual_export', deploymentMode: 'preview_only', idempotencyKey: 'plan-blocked-1' }, line.provisioning.repository, line.managed.repository)
    expect(getProvisioningWorkspace().domain.configured).toBe(false)
    expect(getProvisioningWorkspace().deployment.message).toContain('尚未連線')
    await expect(executeManagedSiteProvisioningPlan(1, plan.plan.id, 'external', undefined, line.provisioning.repository, line.managed.repository)).rejects.toMatchObject({ statusCode: 403 })
  })
})


describe('managed site provisioning hardening', () => {
  async function makePlan(line: Awaited<ReturnType<typeof makeLineage>>, options: { domain?: string; mode?: 'customer_owned' | 'new_registration' | 'assisted'; deploymentMode?: 'preview_only' | 'customer_authorized' | 'owner_authorized'; key: string; draftOrder?: boolean }) {
    const intent = await createManagedSiteDomainIntent(1, { projectId: line.project.project.id, draftOrderId: options.draftOrder === false ? null : line.order.id, mode: options.mode || 'new_registration', requestedDomain: options.domain || `${options.key}.acme.taipei`, providerKey: 'mock-registrar', idempotencyKey: `${options.key}-domain` }, line.provisioning.repository, line.managed.repository)
    return createManagedSiteProvisioningPlan(1, { projectId: line.project.project.id, versionId: line.version.id, domainIntentId: intent.intent.id, platform: 'vercel', deploymentMode: options.deploymentMode || 'customer_authorized', idempotencyKey: `${options.key}-plan` }, line.provisioning.repository, line.managed.repository, undefined, line.ordering.repository)
  }

  it('does not create an authorized plan without a verified paid-order lineage', async () => {
    const line = await makeLineage()
    await expect(makePlan(line, { key: 'unpaid', draftOrder: false })).rejects.toMatchObject({ statusCode: 409 })
  })

  it('executes dry-run without invoking any adapter and never claims deployment', async () => {
    const line = await makeLineage()
    const plan = await makePlan(line, { key: 'dry-zero', deploymentMode: 'preview_only' })
    let calls = 0
    const adapters = {
      async checkDomainAvailability() { calls++; throw new Error('dry-run must not call adapters') },
      async registerDomain() { calls++; throw new Error('dry-run must not call adapters') },
      async configureDns() { calls++; throw new Error('dry-run must not call adapters') },
      async verifyTls() { calls++; throw new Error('dry-run must not call adapters') },
      async deploySite() { calls++; throw new Error('dry-run must not call adapters') },
    }
    const result = await executeManagedSiteProvisioningPlan(1, plan.plan.id, 'dry_run', adapters, line.provisioning.repository, line.managed.repository, undefined, line.ordering.repository)
    expect(calls).toBe(0)
    expect(result.plan?.status).toBe('blocked')
    expect(result.plan?.deployedUrl).toBeNull()
    expect(result.results.every(item => item.externalCalls === false)).toBe(true)
  })

  it('blocks downstream adapters when domain availability or customer authorization is missing', async () => {
    const line = await makeLineage()
    const plan = await makePlan(line, { key: 'dependency-gate' })
    const calls: string[] = []
    const result = await executeManagedSiteProvisioningPlan(1, plan.plan.id, 'mocked', {
      async checkDomainAvailability(input) { calls.push('availability'); return { status: 'unavailable', normalizedDomain: input.normalizedDomain, providerKey: input.providerKey, externalCalls: false, limitation: 'Synthetic unavailable result.' } },
      async registerDomain() { calls.push('register'); return { status: 'registered', normalizedDomain: 'dependency-gate.acme.taipei', providerKey: 'mock-registrar', externalReference: 'should-not-run', externalCalls: false, limitation: 'should not run' } },
      async configureDns() { calls.push('dns'); return { status: 'configured', normalizedDomain: 'dependency-gate.acme.taipei', records: [{ type: 'CNAME', name: '@', value: 'synthetic.invalid' }], externalCalls: false, limitation: 'should not run' } },
      async verifyTls() { calls.push('tls'); return { status: 'verified', normalizedDomain: 'dependency-gate.acme.taipei', certificateReference: 'should-not-run', externalCalls: false, limitation: 'should not run' } },
      async deploySite() { calls.push('deploy'); return { status: 'deployed', platform: 'vercel', deployedUrl: 'https://dependency-gate.acme.taipei', externalReference: 'should-not-run', externalCalls: false, limitation: 'should not run' } },
    }, line.provisioning.repository, line.managed.repository, undefined, line.ordering.repository)
    expect(calls).toEqual(['availability'])
    expect(result.plan?.status).toBe('blocked')
    expect(result.results.slice(2).every(item => item.status === 'blocked')).toBe(true)
  })

  it('records retry_wait with bounded backoff and succeeds only after the retry window', async () => {
    const line = await makeLineage()
    const plan = await makePlan(line, { key: 'retry-gate' })
    let now = new Date('2026-08-27T00:00:00.000Z')
    let registrationCalls = 0
    const adapters: ProvisioningAdapters = {
      async checkDomainAvailability(input) { return { status: 'available', normalizedDomain: input.normalizedDomain, providerKey: input.providerKey, externalCalls: false, limitation: 'Injected mock only.' } },
      async registerDomain(input) {
        registrationCalls++
        if (registrationCalls === 1) throw Object.assign(new Error('synthetic timeout'), { retryable: true, code: 'TIMEOUT' })
        return { status: 'registered', normalizedDomain: input.normalizedDomain, providerKey: input.providerKey, externalReference: 'retry-domain-ref', externalCalls: false, limitation: 'Injected mock only.' }
      },
      async configureDns(input) { return { status: 'configured', normalizedDomain: input.normalizedDomain, records: [{ type: 'CNAME', name: '@', value: 'synthetic.pages.dev' }], externalCalls: false, limitation: 'Injected mock only.' } },
      async verifyTls(input) { return { status: 'verified', normalizedDomain: input.normalizedDomain, certificateReference: 'retry-tls-ref', externalCalls: false, limitation: 'Injected mock only.' } },
      async deploySite(input) { return { status: 'deployed', platform: input.platform, deployedUrl: `https://${input.normalizedDomain}`, externalReference: 'retry-deploy-ref', externalCalls: false, limitation: 'Injected mock only.' } },
    }
    const first = await executeManagedSiteProvisioningPlan(1, plan.plan.id, 'mocked', adapters, line.provisioning.repository, line.managed.repository, () => now, line.ordering.repository)
    expect(first.plan?.status).toBe('retry_wait')
    expect(first.plan?.retryEligibleAt?.getTime()).toBe(new Date('2026-08-27T00:05:00.000Z').getTime())
    await expect(executeManagedSiteProvisioningPlan(1, plan.plan.id, 'mocked', adapters, line.provisioning.repository, line.managed.repository, () => now, line.ordering.repository)).rejects.toMatchObject({ statusCode: 409 })
    now = new Date('2026-08-27T00:06:00.000Z')
    const second = await executeManagedSiteProvisioningPlan(1, plan.plan.id, 'mocked', adapters, line.provisioning.repository, line.managed.repository, () => now, line.ordering.repository)
    expect(second.plan?.status).toBe('succeeded')
    expect(second.steps.find(step => step.stepKey === 'domain_registration')?.attemptNumber).toBe(2)
  })

  it('allows only one leased worker to execute a plan concurrently', async () => {
    const line = await makeLineage()
    const plan = await makePlan(line, { key: 'lease-race' })
    const adapters: ProvisioningAdapters = {
      async checkDomainAvailability(input) { await new Promise(resolve => setTimeout(resolve, 5)); return { status: 'available', normalizedDomain: input.normalizedDomain, providerKey: input.providerKey, externalCalls: false, limitation: 'Injected mock only.' } },
      async registerDomain(input) { return { status: 'registered', normalizedDomain: input.normalizedDomain, providerKey: input.providerKey, externalReference: 'race-domain-ref', externalCalls: false, limitation: 'Injected mock only.' } },
      async configureDns(input) { return { status: 'configured', normalizedDomain: input.normalizedDomain, records: [{ type: 'CNAME', name: '@', value: 'synthetic.pages.dev' }], externalCalls: false, limitation: 'Injected mock only.' } },
      async verifyTls(input) { return { status: 'verified', normalizedDomain: input.normalizedDomain, certificateReference: 'race-tls-ref', externalCalls: false, limitation: 'Injected mock only.' } },
      async deploySite(input) { return { status: 'deployed', platform: input.platform, deployedUrl: `https://${input.normalizedDomain}`, externalReference: 'race-deploy-ref', externalCalls: false, limitation: 'Injected mock only.' } },
    }
    const results = await Promise.allSettled([
      executeManagedSiteProvisioningPlan(1, plan.plan.id, 'mocked', adapters, line.provisioning.repository, line.managed.repository, undefined, line.ordering.repository),
      executeManagedSiteProvisioningPlan(1, plan.plan.id, 'mocked', adapters, line.provisioning.repository, line.managed.repository, undefined, line.ordering.repository),
    ])
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1)
    expect(line.provisioning.state.events.filter(event => event.status === 'succeeded')).toHaveLength(5)
  })

  it('rejects a deployment receipt whose URL or platform does not match the requested target', async () => {
    const line = await makeLineage()
    const plan = await makePlan(line, { key: 'receipt-mismatch' })
    const result = await executeManagedSiteProvisioningPlan(1, plan.plan.id, 'mocked', {
      async checkDomainAvailability(input) { return { status: 'available', normalizedDomain: input.normalizedDomain, providerKey: input.providerKey, externalCalls: false, limitation: 'Injected mock only.' } },
      async registerDomain(input) { return { status: 'registered', normalizedDomain: input.normalizedDomain, providerKey: input.providerKey, externalReference: 'receipt-domain-ref', externalCalls: false, limitation: 'Injected mock only.' } },
      async configureDns(input) { return { status: 'configured', normalizedDomain: input.normalizedDomain, records: [{ type: 'CNAME', name: '@', value: 'synthetic.pages.dev' }], externalCalls: false, limitation: 'Injected mock only.' } },
      async verifyTls(input) { return { status: 'verified', normalizedDomain: input.normalizedDomain, certificateReference: 'receipt-tls-ref', externalCalls: false, limitation: 'Injected mock only.' } },
      async deploySite(input) { return { status: 'deployed', platform: input.platform, deployedUrl: 'https://other.acme.taipei', externalReference: 'receipt-deploy-ref', externalCalls: false, limitation: 'Injected mock only.' } },
    }, line.provisioning.repository, line.managed.repository, undefined, line.ordering.repository)
    expect(result.plan?.status).toBe('failed')
    expect(result.plan?.deployedUrl).toBeNull()
    expect(result.steps.find(step => step.stepKey === 'deployment')?.status).toBe('failed')
  })
})

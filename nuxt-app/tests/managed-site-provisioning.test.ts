import { describe, expect, it } from 'vitest'
import { createManagedSitePreview, createManagedSiteQuote, createManagedSiteDraftOrder, createManagedSiteLeadIntent } from '../server/managed-sites/ordering-service'
import { processManagedSitePaymentAndConversion } from '../server/managed-sites/conversion-service'
import type { PaymentEventVerifier } from '../server/managed-sites/ordering-types'
import type { ProvisioningAdapters } from '../server/managed-sites/provisioning-types'
import { createManagedSiteMemoryRepository } from './fixtures/managed-site/repository'
import { createProvisioningMemoryRepository } from './fixtures/managed-site/provisioning-repository'
import { createInjectedManagedSiteCheckoutAuthorityResolver, createOrderingMemoryRepository } from './fixtures/managed-site/ordering-repository'
import { createManagedSiteDomainIntent, createManagedSiteProvisioningPlan, executeManagedSiteProvisioningPlan, getProvisioningWorkspace, normalizeDomain } from '../server/managed-sites/provisioning-service'

const actor = { ownerUserId: 1, actorUserId: 1, authority: 'owner_session' as const, role: 'owner' as const, principal: 'owner@acme.taipei' }
const mockPaymentVerifier: PaymentEventVerifier = { verify: async () => true }

async function makeLineage() {
  const managed = createManagedSiteMemoryRepository()
  const provisioning = createProvisioningMemoryRepository()
  const ordering = createOrderingMemoryRepository()
  const preview = await createManagedSitePreview(1, { draftIdentity: 'provisioning-preview-001', brandName: 'Provisioning Client', audience: 'Taiwan customers', brief: 'A governed managed website.', businessGoals: ['increase_inquiries'], siteType: 'brand_blog', selectedModules: ['managed_content_admin', 'geo_content_subscription'], styleReferences: [] }, ordering.repository)
  const quote = await createManagedSiteQuote({ previewId: preview.preview.id, previewAccessToken: preview.accessToken!, planKey: 'site_geo', cadenceDays: 7, domainOption: 'new', domainTld: 'com', idempotencyKey: 'provisioning-quote-001' }, ordering.repository)
  const lead = await createManagedSiteLeadIntent({ previewId: preview.preview.id, previewAccessToken: preview.accessToken!, quoteId: quote.quote.quoteId, name: 'Provisioning Owner', email: 'owner@acme.taipei', company: 'Provisioning Client', website: 'https://provisioning-client.acme.taipei', privacyConsent: true, recontactConsent: false, idempotencyKey: 'provisioning-lead-001' }, ordering.repository)
  const order = await createManagedSiteDraftOrder({ previewId: preview.preview.id, previewAccessToken: preview.accessToken!, quoteId: quote.quote.quoteId, leadIntentId: lead.leadIntent.id, idempotencyKey: 'provisioning-order-001' }, ordering.repository)
  const conversion = await processManagedSitePaymentAndConversion({ draftOrderId: order.order.id, providerKey: 'mock-payment', eventId: 'provisioning-payment-001', providerReference: 'provisioning-payment-ref-001', eventType: 'payment_succeeded', amountMinor: quote.quote.totalMinor, currency: quote.quote.currency, canonicalPayloadHash: 'd'.repeat(64), idempotencyKey: 'provisioning-conversion-001' }, mockPaymentVerifier, { ordering: ordering.repository, managed: managed.repository }, createInjectedManagedSiteCheckoutAuthorityResolver(1))
  return { managed, provisioning, ordering, project: { project: conversion.project }, version: conversion.version, order: conversion.order }
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
    expect(result.plan?.status).toBe('draft')
    expect(result.externalCalls).toBe(false)
    expect(result.plan?.deployedUrl).toBeNull()
    expect(result.steps.every(step => step.status === 'pending' && step.attemptNumber === 0 && step.completedAt === null)).toBe(true)
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
    expect(result.plan?.deployedUrl).toBe('https://mocked.acme.taipei')
    expect((result.results.find(step => step.stepKey === 'deployment') as any)?.deployedUrl).toBe('https://mocked.acme.taipei')
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
    expect(result.plan?.status).toBe('draft')
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
    let adapterCalls = 0
    const adapters: ProvisioningAdapters = {
      async checkDomainAvailability(input) { adapterCalls++; await new Promise(resolve => setTimeout(resolve, 5)); return { status: 'available', normalizedDomain: input.normalizedDomain, providerKey: input.providerKey, externalCalls: false, limitation: 'Injected mock only.' } },
      async registerDomain(input) { adapterCalls++; return { status: 'registered', normalizedDomain: input.normalizedDomain, providerKey: input.providerKey, externalReference: 'race-domain-ref', externalCalls: false, limitation: 'Injected mock only.' } },
      async configureDns(input) { adapterCalls++; return { status: 'configured', normalizedDomain: input.normalizedDomain, records: [{ type: 'CNAME', name: '@', value: 'synthetic.pages.dev' }], externalCalls: false, limitation: 'Injected mock only.' } },
      async verifyTls(input) { adapterCalls++; return { status: 'verified', normalizedDomain: input.normalizedDomain, certificateReference: 'race-tls-ref', externalCalls: false, limitation: 'Injected mock only.' } },
      async deploySite(input) { adapterCalls++; return { status: 'deployed', platform: input.platform, deployedUrl: `https://${input.normalizedDomain}`, externalReference: 'race-deploy-ref', externalCalls: false, limitation: 'Injected mock only.' } },
    }
    const results = await Promise.allSettled([
      executeManagedSiteProvisioningPlan(1, plan.plan.id, 'mocked', adapters, line.provisioning.repository, line.managed.repository, undefined, line.ordering.repository),
      executeManagedSiteProvisioningPlan(1, plan.plan.id, 'mocked', adapters, line.provisioning.repository, line.managed.repository, undefined, line.ordering.repository),
    ])
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1)
    expect(adapterCalls).toBe(5)
    expect(line.provisioning.state.events.filter(event => event.status === 'succeeded')).toHaveLength(5)
  })

  it('keeps a dry-run non-mutating and then executes the same plan through injected mocks', async () => {
    const line = await makeLineage()
    const plan = await makePlan(line, { key: 'dry-then-mocked', deploymentMode: 'preview_only' })
    const dryRun = await executeManagedSiteProvisioningPlan(1, plan.plan.id, 'dry_run', undefined, line.provisioning.repository, line.managed.repository, undefined, line.ordering.repository)
    expect(dryRun.plan?.status).toBe('draft')
    const calls: string[] = []
    const adapters: ProvisioningAdapters = {
      async checkDomainAvailability(input) { calls.push('availability'); return { status: 'available', normalizedDomain: input.normalizedDomain, providerKey: input.providerKey, externalCalls: false, limitation: 'Injected mock only.' } },
      async registerDomain(input) { calls.push('register'); return { status: 'registered', normalizedDomain: input.normalizedDomain, providerKey: input.providerKey, externalReference: 'dry-then-domain-ref', externalCalls: false, limitation: 'Injected mock only.' } },
      async configureDns(input) { calls.push('dns'); return { status: 'configured', normalizedDomain: input.normalizedDomain, records: [{ type: 'CNAME', name: '@', value: 'dry-then.pages.dev' }], externalCalls: false, limitation: 'Injected mock only.' } },
      async verifyTls(input) { calls.push('tls'); return { status: 'verified', normalizedDomain: input.normalizedDomain, certificateReference: 'dry-then-tls-ref', externalCalls: false, limitation: 'Injected mock only.' } },
      async deploySite(input) { calls.push('deploy'); return { status: 'deployed', platform: input.platform, deployedUrl: `https://${input.normalizedDomain}`, externalReference: 'dry-then-deploy-ref', externalCalls: false, limitation: 'Injected mock only.' } },
    }
    const executed = await executeManagedSiteProvisioningPlan(1, plan.plan.id, 'mocked', adapters, line.provisioning.repository, line.managed.repository, undefined, line.ordering.repository)
    expect(calls).toEqual(['availability', 'register', 'dns', 'tls', 'deploy'])
    expect(executed.plan?.status).toBe('succeeded')
    expect(executed.plan?.deployedUrl).toBe('https://dry-then-mocked.acme.taipei')
    expect(executed.events.filter(event => event.executionMode === 'dry_run')).toHaveLength(5)
    expect(executed.events.filter(event => event.status === 'succeeded')).toHaveLength(5)
  })

  it('restarts after a fourth-step retry without repeating the first three adapters and preserves receipt lineage', async () => {
    const line = await makeLineage()
    const plan = await makePlan(line, { key: 'restart-retry' })
    let now = new Date('2026-08-27T00:00:00.000Z')
    const calls = { availability: 0, register: 0, dns: 0, tls: 0, deploy: 0 }
    const adapters: ProvisioningAdapters = {
      async checkDomainAvailability(input) { calls.availability++; return { status: 'available', normalizedDomain: input.normalizedDomain, providerKey: input.providerKey, externalCalls: false, limitation: 'Injected mock only.' } },
      async registerDomain(input) { calls.register++; return { status: 'registered', normalizedDomain: input.normalizedDomain, providerKey: input.providerKey, externalReference: 'restart-domain-ref', externalCalls: false, limitation: 'Injected mock only.' } },
      async configureDns(input) { calls.dns++; return { status: 'configured', normalizedDomain: input.normalizedDomain, records: [{ type: 'CNAME', name: '@', value: 'restart.pages.dev' }], externalCalls: false, limitation: 'Injected mock only.' } },
      async verifyTls(input) { calls.tls++; if (calls.tls === 1) throw Object.assign(new Error('synthetic TLS timeout'), { retryable: true, code: 'TIMEOUT' }); return { status: 'verified', normalizedDomain: input.normalizedDomain, certificateReference: 'restart-tls-ref', externalCalls: false, limitation: 'Injected mock only.' } },
      async deploySite(input) { calls.deploy++; return { status: 'deployed', platform: input.platform, deployedUrl: `https://${input.normalizedDomain}`, externalReference: 'restart-deploy-ref', externalCalls: false, limitation: 'Injected mock only.' } },
    }
    const first = await executeManagedSiteProvisioningPlan(1, plan.plan.id, 'mocked', adapters, line.provisioning.repository, line.managed.repository, () => now, line.ordering.repository)
    expect(first.plan?.status).toBe('retry_wait')
    expect(first.steps.filter(step => step.status === 'succeeded')).toHaveLength(3)
    expect(first.steps.find(step => step.stepKey === 'domain_registration')?.externalReference).toBe('restart-domain-ref')
    expect(first.plan?.providerProjectReference).toBe('restart-domain-ref')
    now = new Date('2026-08-27T00:06:00.000Z')
    const second = await executeManagedSiteProvisioningPlan(1, plan.plan.id, 'mocked', adapters, line.provisioning.repository, line.managed.repository, () => now, line.ordering.repository)
    expect(second.plan?.status).toBe('succeeded')
    expect(calls).toEqual({ availability: 1, register: 1, dns: 1, tls: 2, deploy: 1 })
    expect(second.plan?.tlsCertificateReference).toBe('restart-tls-ref')
    expect(second.plan?.providerDeploymentReference).toBe('restart-deploy-ref')
    expect(second.plan?.deployedUrl).toBe('https://restart-retry.acme.taipei')
    expect(second.steps.find(step => step.stepKey === 'domain_registration')?.externalReference).toBe('restart-domain-ref')
    expect(second.steps.find(step => step.stepKey === 'tls_verification')?.externalReference).toBe('restart-tls-ref')
    expect(second.steps.find(step => step.stepKey === 'deployment')?.externalReference).toBe('restart-deploy-ref')
    expect(second.events.filter(event => event.status === 'succeeded')).toHaveLength(5)
    await expect(executeManagedSiteProvisioningPlan(1, plan.plan.id, 'mocked', adapters, line.provisioning.repository, line.managed.repository, () => now, line.ordering.repository)).rejects.toMatchObject({ statusCode: 409 })
    expect(second.events.filter(event => event.status === 'succeeded')).toHaveLength(5)
  })

  it('does not exceed the bounded retry attempt cap', async () => {
    const line = await makeLineage()
    const plan = await makePlan(line, { key: 'attempt-cap' })
    let now = new Date('2026-08-27T00:00:00.000Z')
    let tlsCalls = 0
    const adapters: ProvisioningAdapters = {
      async checkDomainAvailability(input) { return { status: 'available', normalizedDomain: input.normalizedDomain, providerKey: input.providerKey, externalCalls: false, limitation: 'Injected mock only.' } },
      async registerDomain(input) { return { status: 'registered', normalizedDomain: input.normalizedDomain, providerKey: input.providerKey, externalReference: 'cap-domain-ref', externalCalls: false, limitation: 'Injected mock only.' } },
      async configureDns(input) { return { status: 'configured', normalizedDomain: input.normalizedDomain, records: [{ type: 'CNAME', name: '@', value: 'cap.pages.dev' }], externalCalls: false, limitation: 'Injected mock only.' } },
      async verifyTls() { tlsCalls++; throw Object.assign(new Error('synthetic persistent timeout'), { retryable: true, code: 'TIMEOUT' }) },
      async deploySite() { throw new Error('deployment must remain downstream') },
    }
    const first = await executeManagedSiteProvisioningPlan(1, plan.plan.id, 'mocked', adapters, line.provisioning.repository, line.managed.repository, () => now, line.ordering.repository)
    expect(first.plan?.status).toBe('retry_wait')
    now = new Date('2026-08-27T00:06:00.000Z')
    const second = await executeManagedSiteProvisioningPlan(1, plan.plan.id, 'mocked', adapters, line.provisioning.repository, line.managed.repository, () => now, line.ordering.repository)
    expect(second.plan?.status).toBe('retry_wait')
    now = new Date('2026-08-27T00:37:00.000Z')
    const third = await executeManagedSiteProvisioningPlan(1, plan.plan.id, 'mocked', adapters, line.provisioning.repository, line.managed.repository, () => now, line.ordering.repository)
    expect(third.plan?.status).toBe('failed')
    expect(third.steps.find(step => step.stepKey === 'tls_verification')?.attemptNumber).toBe(3)
    expect(tlsCalls).toBe(3)
    await expect(executeManagedSiteProvisioningPlan(1, plan.plan.id, 'mocked', adapters, line.provisioning.repository, line.managed.repository, () => new Date('2026-08-27T01:00:00.000Z'), line.ordering.repository)).rejects.toMatchObject({ statusCode: 409 })
    expect(tlsCalls).toBe(3)
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

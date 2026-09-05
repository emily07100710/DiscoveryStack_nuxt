import { describe, expect, it } from 'vitest'
import { createFunnelSession, MANAGED_SITE_FUNNEL_CONSENT_VERSION, recordFunnelConsent, saveFunnelStep, type FunnelAnswers } from '../server/managed-sites/funnel/session-service'
import { runFunnelBuild } from '../server/managed-sites/funnel/checkout-orchestrator'
import { projectFunnelQuote } from '../server/managed-sites/funnel/quote-projection'
import { closeManagedSiteManualModuleFulfilment } from '../server/managed-sites/funnel/module-fulfilment'
import { createMemoryManagedSiteArtifactVault, createMockManagedSiteGenerationAdapter } from '../server/managed-sites/live-connectors/adapters'
import { createMockManagedSiteDeploymentAdapter } from '../server/managed-sites/live-connectors/deployment-orchestrator'
import { evaluateManagedSiteLaunchReadiness } from '../server/managed-sites/live-connectors/launch-readiness'
import { configureManagedSiteProvider, verifyManagedSiteProviderConfiguration } from '../server/managed-sites/live-connectors/provider-registry'
import type { ManagedSiteProviderVerifierRegistry } from '../server/managed-sites/live-connectors/provider-verifiers'
import { recordVerifiedPaymentEvent } from '../server/managed-sites/ordering-service'
import { createFunnelSessionMemoryRepository } from './fixtures/managed-site/funnel-session-repository'
import { createLiveConnectorMemoryRepository } from './fixtures/managed-site/live-connectors-repository'
import { createManagedSiteMemoryRepository } from './fixtures/managed-site/repository'
import { createOrderingMemoryRepository } from './fixtures/managed-site/ordering-repository'

const now = new Date('2026-09-03T02:00:00.000Z')

async function seedVerifiedProvider(repository: ReturnType<typeof createLiveConnectorMemoryRepository>['repository'], capability: 'payment' | 'domain_registration', providerKey: string, capabilityIdentity: string) {
  return repository.insertProviderConfiguration({ ownerUserId: 1, capability, providerKey, readinessStatus: 'verified', credentialReference: `vault:${providerKey}`, transportConfiguration: {}, configurationFingerprint: `${capability === 'payment' ? 'a' : 'b'}`.repeat(64), verificationReceiptFingerprint: `${capability === 'payment' ? 'c' : 'd'}`.repeat(64), capabilityIdentity, blockedReasonCode: null, verifiedAt: now } as any)
}

describe('managed-site launch readiness', () => {
  it('blocks a Stripe provider whose stored verified receipt says test mode', async () => {
    const live = createLiveConnectorMemoryRepository()
    await seedVerifiedProvider(live.repository, 'payment', 'stripe', 'stripe-balance:test')
    await expect(evaluateManagedSiteLaunchReadiness(1, live.repository)).resolves.toMatchObject({ ready: false, blockers: [expect.objectContaining({ providerKey: 'stripe', messageZh: expect.stringContaining('Stripe') })] })
  })

  it('remains blocked when Stripe is live but Porkbun is still sandboxed', async () => {
    const live = createLiveConnectorMemoryRepository()
    await seedVerifiedProvider(live.repository, 'payment', 'stripe', 'stripe-balance:live')
    await seedVerifiedProvider(live.repository, 'domain_registration', 'porkbun', 'porkbun:sandbox')
    const result = await evaluateManagedSiteLaunchReadiness(1, live.repository)
    expect(result.ready).toBe(false)
    expect(result.blockers).toEqual([expect.objectContaining({ capability: 'domain_registration', providerKey: 'porkbun' })])
  })

  it('blocks an open manual-service fulfilment and clears after the row is closed', async () => {
    const live = createLiveConnectorMemoryRepository()
    await live.repository.insertModuleFulfilment({ ownerUserId: 1, draftOrderId: 10, quoteId: 11, moduleKey: 'stripe_payment', mode: 'manual_service', status: 'pending_manual_setup', billedMinor: 3000, customerVisibleStatus: '已付款・待我們為你設定開通', ownerActionRequired: true, completedAt: null })
    await expect(evaluateManagedSiteLaunchReadiness(1, live.repository)).resolves.toMatchObject({ ready: false, blockers: [expect.objectContaining({ moduleKey: 'stripe_payment' })] })
    await closeManagedSiteManualModuleFulfilment(1, 10, 'stripe_payment', live.repository, now)
    await expect(evaluateManagedSiteLaunchReadiness(1, live.repository)).resolves.toEqual({ ready: true, blockers: [] })
  })

  it('refuses payment production promotion with 409 and leaves stored configuration unchanged', async () => {
    const live = createLiveConnectorMemoryRepository()
    await seedVerifiedProvider(live.repository, 'domain_registration', 'porkbun', 'porkbun:sandbox')
    await live.repository.insertProviderConfiguration({ ownerUserId: 1, capability: 'payment', providerKey: 'stripe', readinessStatus: 'configured', credentialReference: 'vault:stripe', transportConfiguration: { checkoutOrigin: 'https://checkout.example.com' }, configurationFingerprint: 'a'.repeat(64), verificationReceiptFingerprint: null, capabilityIdentity: null, blockedReasonCode: null, verifiedAt: null } as any)
    const before = structuredClone(await live.repository.findProviderConfiguration(1, 'payment'))
    const verifierRegistry: ManagedSiteProviderVerifierRegistry = new Map([['stripe', new Map([['payment', async input => ({ capability: 'payment', providerKey: 'stripe', configurationFingerprint: input.configurationFingerprint, capabilityIdentity: 'stripe-balance:live', providerEventId: 'stripe-verification-live-001', payloadHash: 'e'.repeat(64), exactResponseIdentity: 'stripe-production-verification-001', observedAt: now.toISOString() })]])]]) as ManagedSiteProviderVerifierRegistry
    await expect(verifyManagedSiteProviderConfiguration(1, 'payment', live.repository, async () => ({ ok: true, value: 'test-only-resolved-value' }), () => now, verifierRegistry)).rejects.toMatchObject({ statusCode: 409, statusMessage: expect.stringMatching(/正式環境.*Porkbun/u) })
    expect(await live.repository.findProviderConfiguration(1, 'payment')).toEqual(before)
  })

  it('reports ready with no blockers when verified provider identities are live and no manual setup is open', async () => {
    const live = createLiveConnectorMemoryRepository()
    await seedVerifiedProvider(live.repository, 'payment', 'stripe', 'stripe-balance:live')
    await seedVerifiedProvider(live.repository, 'domain_registration', 'porkbun', 'porkbun:production')
    await expect(evaluateManagedSiteLaunchReadiness(1, live.repository)).resolves.toEqual({ ready: true, blockers: [] })
  })

  it('「未完成不假裝開通」：即將推出模組不收費，人工設定模組如實收費並待設定', async () => {
    const funnel = createFunnelSessionMemoryRepository()
    const ordering = createOrderingMemoryRepository()
    const managed = createManagedSiteMemoryRepository()
    const live = createLiveConnectorMemoryRepository()
    for (const [capability, providerKey] of [['website_generator', 'mock-generator'], ['deployment', 'mock-deployment']] as const) {
      await configureManagedSiteProvider(1, { capability, providerKey, readinessStatus: 'mock', credentialReference: null, transportConfiguration: {}, idempotencyKey: `launch-acceptance-${capability}` }, live.repository, () => now)
    }
    const created = await createFunnelSession(funnel.repository, () => now)
    const answers: FunnelAnswers = {
      existingSite: { hasSite: false },
      company: { brandName: '誠實模組商店', whatWeDo: '提供需要金流串接的實體服務。', feelings: ['專業'], mainOffer: '專業服務', conversionGoals: ['increase_inquiries'] },
      contact: { email: 'ledger@example.test', contactName: '測試聯絡人' },
      style: { referenceUrls: [], stylePreset: 'business', designTier: 'template' },
      siteType: 'one_page',
      modules: ['ecpay_payment', 'stripe_payment'],
      previewDraft: { generatedAt: now.toISOString(), source: 'template', headline: '誠實模組商店', sections: [{ heading: '專業服務', body: '清楚說明服務內容。' }] },
      domain: { option: 'existing' },
      plan: { planKey: 'site_only' },
    }
    await saveFunnelStep(created.sessionId, created.sessionToken, { step: 9, answers }, funnel.repository, () => now)
    await recordFunnelConsent(created.sessionId, created.sessionToken, { policyVersion: MANAGED_SITE_FUNNEL_CONSENT_VERSION, scrolledToBottom: true }, funnel.repository, () => now)
    const projected = projectFunnelQuote(answers, created.sessionId)
    const withoutModule = projectFunnelQuote({ ...answers, modules: [] }, created.sessionId)
    await runFunnelBuild(created.sessionId, created.sessionToken, { funnelRepository: funnel.repository, orderingRepository: ordering.repository, managedRepository: managed.repository, connectorRepository: live.repository, generationAdapter: createMockManagedSiteGenerationAdapter(), artifactVault: createMemoryManagedSiteArtifactVault(), deploymentAdapter: createMockManagedSiteDeploymentAdapter({ now: () => now }), executionMode: 'mocked', clock: () => now, resolveOwnerUserId: async () => 1 })
    const order = ordering.state.orders[0]!
    const persistedQuote = ordering.state.quotes.find(quote => quote.id === order.quoteId)!
    expect(persistedQuote.totalMinor).toBe(projected.totals.dueTodayMinor)
    expect(projected.totals.dueTodayMinor - withoutModule.totals.dueTodayMinor).toBe(3000)
    expect(ordering.state.lines.filter(line => line.lineKey.startsWith('module-ecpay_payment') || line.lineKey === 'monthly-module-ecpay_payment')).toEqual([expect.objectContaining({ lineKey: 'module-ecpay_payment-intent', lineAmountMinor: 0 })])
    expect(ordering.state.lines.filter(line => line.lineKey.startsWith('module-stripe_payment') || line.lineKey === 'monthly-module-stripe_payment')).toEqual([expect.objectContaining({ lineKey: 'module-stripe_payment-setup', lineAmountMinor: 3000 })])
    await recordVerifiedPaymentEvent({ draftOrderId: order.id, providerKey: 'mock-payment', eventId: 'launch-acceptance-payment-001', providerReference: 'launch-acceptance-reference-001', eventType: 'payment_succeeded', amountMinor: persistedQuote.totalMinor, currency: persistedQuote.currency, canonicalPayloadHash: 'f'.repeat(64) }, { verify: async () => true }, ordering.repository, () => now)
    const comingSoonFulfilment = ordering.state.moduleFulfilments.find(row => row.moduleKey === 'ecpay_payment')
    const manualSetupFulfilment = ordering.state.moduleFulfilments.find(row => row.moduleKey === 'stripe_payment')
    expect(comingSoonFulfilment).toMatchObject({ draftOrderId: order.id, mode: 'manual_service', status: 'recorded_intent_unbilled', billedMinor: 0, customerVisibleStatus: '已登記需求・尚未開通（未收費）', ownerActionRequired: true })
    expect(manualSetupFulfilment).toMatchObject({ draftOrderId: order.id, mode: 'manual_service', status: 'pending_manual_setup', billedMinor: 3000, customerVisibleStatus: '已付款・待我們為你設定開通', ownerActionRequired: true })
    expect(comingSoonFulfilment!.customerVisibleStatus).toContain('尚未開通')
    expect(manualSetupFulfilment!.customerVisibleStatus).not.toContain('已開通')
    expect(live.state.receipts.filter(receipt => ['ecpay_payment', 'stripe_payment'].includes(String((receipt.metadata as any)?.moduleKey)) || /activation/iu.test(receipt.receiptType))).toHaveLength(0)
  })
})

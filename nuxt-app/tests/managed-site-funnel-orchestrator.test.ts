import { beforeAll, afterEach, describe, expect, it } from 'vitest'
import { createApp, createError, createRouter, defineEventHandler, send, setResponseStatus, toWebHandler } from 'h3'
import { MANAGED_SITE_FUNNEL_BUILD_STALE_MS, MANAGED_SITE_FUNNEL_CHECKOUT_SESSION_TTL_MS, runFunnelBuild, runFunnelCheckout, type ManagedSiteFunnelOrchestratorDependencies } from '../server/managed-sites/funnel/checkout-orchestrator'
import { projectFunnelQuote } from '../server/managed-sites/funnel/quote-projection'
import { setManagedSiteContactInboxBindingDependenciesForTests } from '../server/managed-sites/contact-inbox/binding-service'
import { createFunnelSession, loadFunnelSession, MANAGED_SITE_FUNNEL_CONSENT_VERSION, recordFunnelConsent, saveFunnelStep, type FunnelAnswers } from '../server/managed-sites/funnel/session-service'
import { getManagedSitePriceCatalog } from '../server/managed-sites/ordering-service'
import { setManagedSiteFunnelRepositoryForTests } from '../server/managed-sites/funnel/session-repository'
import { createMemoryManagedSiteArtifactVault, createMockManagedSiteGenerationAdapter } from '../server/managed-sites/live-connectors/adapters'
import { createMockManagedSiteCheckoutSessionAdapter } from '../server/managed-sites/live-connectors/checkout-session'
import { createMockManagedSiteDeploymentAdapter } from '../server/managed-sites/live-connectors/deployment-orchestrator'
import { configureManagedSiteProvider } from '../server/managed-sites/live-connectors/provider-registry'
import { createFunnelSessionMemoryRepository } from './fixtures/managed-site/funnel-session-repository'
import { createContactInboxBindingMemoryRepository } from './fixtures/managed-site/contact-inbox-binding-repository'
import { createLiveConnectorMemoryRepository } from './fixtures/managed-site/live-connectors-repository'
import { createManagedSiteMemoryRepository } from './fixtures/managed-site/repository'
import { createOrderingMemoryRepository } from './fixtures/managed-site/ordering-repository'
import { managedSiteFixedNow } from './fixtures/managed-site/live-connectors-application'

const savedPrivateOrigin = process.env.NUXT_DISCOVERYSTACK_PRIVATE_ORIGIN
const savedOwnerOpenId = process.env.OWNER_OPEN_ID

beforeAll(() => {
  ;(globalThis as any).defineEventHandler = defineEventHandler
  ;(globalThis as any).createError = createError
  ;(globalThis as any).useRuntimeConfig = () => ({ ownerOpenId: process.env.OWNER_OPEN_ID || '' })
})

afterEach(() => {
  setManagedSiteFunnelRepositoryForTests(null)
  setManagedSiteContactInboxBindingDependenciesForTests(null)
  if (savedPrivateOrigin === undefined) delete process.env.NUXT_DISCOVERYSTACK_PRIVATE_ORIGIN
  else process.env.NUXT_DISCOVERYSTACK_PRIVATE_ORIGIN = savedPrivateOrigin
  if (savedOwnerOpenId === undefined) delete process.env.OWNER_OPEN_ID
  else process.env.OWNER_OPEN_ID = savedOwnerOpenId
})

function completeAnswers(label = 'Acme'): FunnelAnswers {
  return {
    existingSite: { hasSite: false },
    company: { brandName: label, whatWeDo: '提供可信任的品牌顧問服務。', feelings: ['專業', '溫暖'], mainOffer: '品牌策略顧問', conversionGoals: ['increase_inquiries', 'build_brand'] },
    contact: { email: `${label.toLowerCase().replace(/[^a-z0-9]+/gu, '-')}@example.test`, contactName: `${label} 聯絡人`, phone: '+886 2 1234 5678' },
    style: { referenceUrls: ['https://openai.com/reference'], stylePreset: 'premium', designTier: 'designer' },
    siteType: 'brand_blog',
    modules: ['managed_content_admin', 'geo_content_subscription', 'geo_measurement_dashboard'],
    previewDraft: { generatedAt: managedSiteFixedNow.toISOString(), source: 'template', headline: `${label} 品牌網站`, sections: [{ heading: `${label} 品牌網站`, body: '這是儲存後可重新載入的示意草稿。' }] },
    domain: { option: 'new', name: label.toLowerCase().replace(/[^a-z0-9]+/gu, '-'), tld: 'com' },
    plan: { planKey: 'site_geo', cadenceDays: 7 },
  }
}

async function configuredLine(label = 'Acme') {
  const funnel = createFunnelSessionMemoryRepository()
  const ordering = createOrderingMemoryRepository()
  const managed = createManagedSiteMemoryRepository()
  const live = createLiveConnectorMemoryRepository()
  for (const [capability, providerKey] of [['website_generator', 'mock-generator'], ['deployment', 'mock-deployment'], ['payment', 'mock-payment']] as const) {
    await configureManagedSiteProvider(1, { capability, providerKey, readinessStatus: 'mock', credentialReference: null, transportConfiguration: {}, idempotencyKey: `funnel-config-${label}-${capability}` }, live.repository, () => managedSiteFixedNow)
  }
  const created = await createFunnelSession(funnel.repository, () => managedSiteFixedNow)
  await saveFunnelStep(created.sessionId, created.sessionToken, { step: 9, answers: completeAnswers(label) }, funnel.repository, () => managedSiteFixedNow)
  await recordFunnelConsent(created.sessionId, created.sessionToken, { policyVersion: MANAGED_SITE_FUNNEL_CONSENT_VERSION, scrolledToBottom: true }, funnel.repository, () => managedSiteFixedNow)
  const dependencies: ManagedSiteFunnelOrchestratorDependencies = {
    funnelRepository: funnel.repository,
    orderingRepository: ordering.repository,
    managedRepository: managed.repository,
    connectorRepository: live.repository,
    generationAdapter: createMockManagedSiteGenerationAdapter(),
    artifactVault: createMemoryManagedSiteArtifactVault(),
    deploymentAdapter: createMockManagedSiteDeploymentAdapter({ now: () => managedSiteFixedNow }),
    checkoutAdapter: createMockManagedSiteCheckoutSessionAdapter(),
    executionMode: 'mocked',
    clock: () => managedSiteFixedNow,
    resolveOwnerUserId: async () => 1,
  }
  return { funnel, ordering, managed, live, created, dependencies, answers: completeAnswers(label) }
}

async function routeRequest(repository: ReturnType<typeof createFunnelSessionMemoryRepository>['repository'], path: string, body: unknown, token?: string, method?: 'GET' | 'PATCH' | 'POST') {
  setManagedSiteFunnelRepositoryForTests(repository)
  setManagedSiteContactInboxBindingDependenciesForTests({ repository: createContactInboxBindingMemoryRepository().repository, transport: { configured: false, async send(): Promise<never> { throw new Error('unconfigured') } }, pepper: '', clock: () => new Date(managedSiteFixedNow) })
  process.env.NUXT_DISCOVERYSTACK_PRIVATE_ORIGIN = 'https://funnel.test'
  const handler = (await import('../server/api/managed-sites/funnel/[...path]')).default
  const app = createApp({ debug: false, onError: async (error, event) => { setResponseStatus(event, (error as any).statusCode || 500, (error as any).statusMessage); await send(event, JSON.stringify({ statusCode: (error as any).statusCode || 500, statusMessage: (error as any).statusMessage || 'Request failed.' }), 'application/json') } })
  const router = createRouter(); router.use('/api/managed-sites/funnel/**', handler); app.use(router)
  const requestMethod = method || (path.endsWith('/status') ? 'GET' : path.match(/\/sessions\/\d+$/u) ? 'PATCH' : 'POST')
  return toWebHandler(app)(new Request(`https://funnel.test${path}`, { method: requestMethod, headers: { 'content-type': 'application/json', origin: 'https://funnel.test', ...(token ? { 'x-managed-site-funnel-token': token } : {}) }, ...(requestMethod === 'GET' ? {} : { body: JSON.stringify(body) }) }))
}

describe('managed-site self-serve funnel', () => {
  it('keeps all nine saved steps refreshable and hides missing, wrong-token, and expired distinctions', async () => {
    const memory = createFunnelSessionMemoryRepository()
    const created = await createFunnelSession(memory.repository, () => managedSiteFixedNow)
    const answers = completeAnswers('Lifecycle')
    const stepAnswers: Partial<FunnelAnswers>[] = [
      { existingSite: answers.existingSite },
      { company: answers.company, contact: answers.contact },
      { style: answers.style },
      { siteType: answers.siteType },
      { modules: answers.modules },
      { previewDraft: answers.previewDraft },
      { domain: answers.domain },
      { plan: answers.plan },
      {},
    ]
    for (let index = 0; index < stepAnswers.length; index += 1) await saveFunnelStep(created.sessionId, created.sessionToken, { step: index + 1, answers: stepAnswers[index]! }, memory.repository, () => managedSiteFixedNow)
    const reloaded = await loadFunnelSession(created.sessionId, created.sessionToken, memory.repository, () => managedSiteFixedNow)
    expect(reloaded.answers).toEqual(answers)
    expect(reloaded.currentStep).toBe(9)
    const resume = await routeRequest(memory.repository, `/api/managed-sites/funnel/sessions/${created.sessionId}`, {}, created.sessionToken, 'GET')
    expect(resume.status).toBe(200)
    const browserProjection = await resume.json() as Record<string, unknown>
    expect(browserProjection.answers).toEqual(answers)
    expect(browserProjection).not.toHaveProperty('sessionTokenHash')
    expect(browserProjection).not.toHaveProperty('previewAccessTokenHash')
    expect(browserProjection).not.toHaveProperty('draftOrderId')
    await expect(loadFunnelSession(created.sessionId, 'x'.repeat(43), memory.repository, () => managedSiteFixedNow)).rejects.toMatchObject({ statusCode: 404, statusMessage: 'Managed site funnel session was not found.' })
    memory.state.sessions[0]!.expiresAt = new Date(managedSiteFixedNow.getTime() - 1)
    await expect(loadFunnelSession(created.sessionId, created.sessionToken, memory.repository, () => managedSiteFixedNow)).rejects.toMatchObject({ statusCode: 404, statusMessage: 'Managed site funnel session was not found.' })
  })

  it('strictly validates answer keys, references, catalogs, and step bounds', async () => {
    const invalidPatch = async (answers: any, step = 1) => {
      const memory = createFunnelSessionMemoryRepository(); const created = await createFunnelSession(memory.repository, () => managedSiteFixedNow)
      return saveFunnelStep(created.sessionId, created.sessionToken, { step, answers }, memory.repository, () => managedSiteFixedNow)
    }
    await expect(invalidPatch({ unknownAnswer: true })).rejects.toMatchObject({ statusCode: 422 })
    await expect(invalidPatch({ style: { referenceUrls: ['https://a.test', 'https://b.test', 'https://c.test', 'https://d.test'], designTier: 'template' } })).rejects.toMatchObject({ statusCode: 422 })
    await expect(invalidPatch({ style: { referenceUrls: ['http://a.test'], designTier: 'template' } })).rejects.toMatchObject({ statusCode: 422 })
    await expect(invalidPatch({ modules: ['invented_module'] })).rejects.toMatchObject({ statusCode: 422 })
    await expect(invalidPatch({ plan: { planKey: 'invented_plan' } })).rejects.toMatchObject({ statusCode: 422 })
    await expect(invalidPatch({ domain: { option: 'assisted', tld: 'com' } })).rejects.toMatchObject({ statusCode: 422, statusMessage: 'Domain TLD is only available for a new domain.' })
    await expect(invalidPatch({ domain: { option: 'new', name: 'acme' } })).rejects.toMatchObject({ statusCode: 422 })
    await expect(invalidPatch({ domain: { option: 'none' } })).rejects.toMatchObject({ statusCode: 422, statusMessage: 'Domain option is not supported.' })
    await expect(invalidPatch({}, 0)).rejects.toMatchObject({ statusCode: 422 })
    await expect(invalidPatch({}, 10)).rejects.toMatchObject({ statusCode: 422 })
  })

  it('requires exact, fully-read consent before build and proceeds once it is recorded', async () => {
    const line = await configuredLine('Consent')
    line.funnel.state.sessions[0]!.consentSnapshot = null
    await expect(recordFunnelConsent(line.created.sessionId, line.created.sessionToken, { policyVersion: MANAGED_SITE_FUNNEL_CONSENT_VERSION, scrolledToBottom: false as any }, line.funnel.repository, () => managedSiteFixedNow)).rejects.toMatchObject({ statusCode: 400, statusMessage: 'Consent requires reading the full agreement.' })
    await expect(recordFunnelConsent(line.created.sessionId, line.created.sessionToken, { policyVersion: 'wrong-policy', scrolledToBottom: true }, line.funnel.repository, () => managedSiteFixedNow)).rejects.toMatchObject({ statusCode: 400 })
    await expect(runFunnelBuild(line.created.sessionId, line.created.sessionToken, line.dependencies)).rejects.toMatchObject({ statusCode: 409 })
    await recordFunnelConsent(line.created.sessionId, line.created.sessionToken, { policyVersion: MANAGED_SITE_FUNNEL_CONSENT_VERSION, scrolledToBottom: true }, line.funnel.repository, () => managedSiteFixedNow)
    await expect(runFunnelBuild(line.created.sessionId, line.created.sessionToken, line.dependencies)).resolves.toMatchObject({ releaseId: expect.any(Number), previewUrl: expect.stringMatching(/^https:\/\//u) })
  })

  it('rejects client-supplied prices and uses the server catalog total exactly', async () => {
    const memory = createFunnelSessionMemoryRepository(); const created = await createFunnelSession(memory.repository, () => managedSiteFixedNow)
    const amountPatch = await routeRequest(memory.repository, `/api/managed-sites/funnel/sessions/${created.sessionId}`, { step: 1, answers: {}, totalMinor: 1 }, created.sessionToken)
    expect(amountPatch.status).toBe(400)
    const amountCheckout = await routeRequest(memory.repository, `/api/managed-sites/funnel/sessions/${created.sessionId}/checkout`, { amount: 1, price: 1 }, created.sessionToken)
    expect(amountCheckout.status).toBe(400)
    const line = await configuredLine('Catalog')
    const projected = projectFunnelQuote(line.answers, line.created.sessionId)
    await runFunnelBuild(line.created.sessionId, line.created.sessionToken, line.dependencies)
    expect(line.ordering.state.quotes[0]!.totalMinor).toBe(projected.totals.dueTodayMinor)
  })

  it('projects the catalog assisted-domain setup fee without remapping the domain option', () => {
    const answers = completeAnswers('Assisted')
    const existing = projectFunnelQuote({ ...answers, domain: { option: 'existing' } })
    const assisted = projectFunnelQuote({ ...answers, domain: { option: 'assisted' } })
    const assistedSetup = assisted.lines.find(line => line.lineKey === 'domain-assisted-setup')
    const catalog = getManagedSitePriceCatalog()
    expect(assistedSetup?.unitAmountMinor).toBe(catalog.assistedDomainSetupMinor)
    expect(assisted.totals.dueTodayMinor - existing.totals.dueTodayMinor).toBe(catalog.assistedDomainSetupMinor)
  })

  it('runs the complete governed mocked build and checkout chain', async () => {
    const line = await configuredLine('Complete')
    const projection = projectFunnelQuote(line.answers, line.created.sessionId)
    const built = await runFunnelBuild(line.created.sessionId, line.created.sessionToken, line.dependencies)
    const checkout = await runFunnelCheckout(line.created.sessionId, line.created.sessionToken, line.dependencies)
    const session = line.funnel.state.sessions[0]!
    expect(line.ordering.state.orders).toHaveLength(1)
    expect(session.draftOrderId).toBe(line.ordering.state.orders[0]!.id)
    expect(session.sessionTokenHash).not.toBe(line.created.sessionToken)
    expect(session.previewAccessTokenHash).toBe(line.ordering.state.previews[0]!.accessTokenHash)
    expect(JSON.stringify(session)).not.toContain(line.created.sessionToken)
    expect(line.ordering.state.quotes[0]!.totalMinor).toBe(projection.totals.dueTodayMinor)
    expect(line.ordering.state.leads[0]!.email).toBe(line.answers.contact!.email)
    expect(line.ordering.state.leads.some(lead => lead.email.endsWith('@example.invalid'))).toBe(false)
    expect(built.quote.totals).toEqual(projection.totals)
    expect(line.live.state.releases[0]!.status).toBe('checkout_pending')
    expect(checkout.checkoutUrl).toMatch(/^https:\/\//u)
  })

  it('replays build and checkout without duplicate projects, releases, or checkout receipts', async () => {
    const line = await configuredLine('Replay')
    const firstBuild = await runFunnelBuild(line.created.sessionId, line.created.sessionToken, line.dependencies)
    const secondBuild = await runFunnelBuild(line.created.sessionId, line.created.sessionToken, line.dependencies)
    expect(secondBuild).toEqual(firstBuild)
    expect(line.managed.state.projects).toHaveLength(1)
    expect(line.live.state.releases).toHaveLength(1)
    const firstCheckout = await runFunnelCheckout(line.created.sessionId, line.created.sessionToken, line.dependencies)
    const secondCheckout = await runFunnelCheckout(line.created.sessionId, line.created.sessionToken, line.dependencies)
    expect(secondCheckout).toEqual(firstCheckout)
    expect(line.live.state.receipts.filter(receipt => receipt.receiptType === 'checkout_session_created')).toHaveLength(1)
  })

  it('restores a failed late build for an idempotent retry without duplicate durable lineage', async () => {
    const line = await configuredLine('RetryAfterFailure')
    let current = new Date(managedSiteFixedNow)
    let deploymentCalls = 0
    const successfulDeployment = createMockManagedSiteDeploymentAdapter({ now: () => current })
    line.dependencies.clock = () => current
    line.dependencies.deploymentAdapter = {
      ...successfulDeployment,
      async buildPreview(input) {
        deploymentCalls += 1
        if (deploymentCalls === 1) throw createError({ statusCode: 503, statusMessage: 'provider unavailable' })
        return successfulDeployment.buildPreview(input)
      },
    }

    await expect(runFunnelBuild(line.created.sessionId, line.created.sessionToken, line.dependencies)).rejects.toMatchObject({ statusCode: 503, statusMessage: '網站建置暫時未完成，請稍後再試。' })
    expect(line.funnel.state.sessions[0]!.status).toBe('active')
    expect(line.funnel.state.sessions[0]!.releaseId).toBe(line.live.state.releases[0]!.id)
    current = new Date(current.getTime() + 6 * 60_000)
    await expect(runFunnelBuild(line.created.sessionId, line.created.sessionToken, line.dependencies)).resolves.toMatchObject({ releaseId: line.live.state.releases[0]!.id, previewUrl: expect.stringMatching(/^https:\/\//u) })
    expect(deploymentCalls).toBe(2)
    expect(line.ordering.state.previews).toHaveLength(1)
    expect(line.ordering.state.quotes).toHaveLength(1)
    expect(line.ordering.state.leadIntents).toHaveLength(1)
    expect(line.ordering.state.orders).toHaveLength(1)
    expect(line.managed.state.projects).toHaveLength(1)
    expect(line.live.state.releases).toHaveLength(1)
  })

  it('replays preview, quote, lead, order, and project after an early provider failure', async () => {
    const line = await configuredLine('RetryEarlyFailure')
    let current = new Date(managedSiteFixedNow)
    let generationCalls = 0
    const successfulGeneration = createMockManagedSiteGenerationAdapter()
    line.dependencies.clock = () => current
    line.dependencies.deploymentAdapter = createMockManagedSiteDeploymentAdapter({ now: () => current })
    line.dependencies.generationAdapter = {
      async generate(request, context) {
        generationCalls += 1
        if (generationCalls === 1) throw Object.assign(new Error('provider timeout'), { code: 'TIMEOUT', retryable: true })
        return successfulGeneration.generate(request, context)
      },
    }

    await expect(runFunnelBuild(line.created.sessionId, line.created.sessionToken, line.dependencies)).rejects.toMatchObject({ statusCode: 503, statusMessage: '網站建置暫時未完成，請稍後再試。' })
    expect(line.funnel.state.sessions[0]!.status).toBe('active')
    current = new Date(current.getTime() + 6 * 60_000)
    await expect(runFunnelBuild(line.created.sessionId, line.created.sessionToken, line.dependencies)).resolves.toMatchObject({ releaseId: expect.any(Number) })
    expect(generationCalls).toBe(2)
    expect(line.ordering.state.previews).toHaveLength(1)
    expect(line.ordering.state.quotes).toHaveLength(1)
    expect(line.ordering.state.leadIntents).toHaveLength(1)
    expect(line.ordering.state.orders).toHaveLength(1)
    expect(line.managed.state.projects).toHaveLength(1)
  })

  it('admits exactly one of two concurrent build requests for a session', async () => {
    const line = await configuredLine('Concurrent')
    const current = new Date()
    line.dependencies.clock = () => current
    line.dependencies.deploymentAdapter = createMockManagedSiteDeploymentAdapter({ now: () => current })
    line.funnel.state.sessions[0]!.updatedAt = current
    const successfulGeneration = createMockManagedSiteGenerationAdapter()
    let releaseGeneration!: () => void
    let markEntered!: () => void
    const entered = new Promise<void>(resolve => { markEntered = resolve })
    const gate = new Promise<void>(resolve => { releaseGeneration = resolve })
    let generationCalls = 0
    line.dependencies.generationAdapter = {
      async generate(request, context) {
        generationCalls += 1
        markEntered()
        await gate
        return successfulGeneration.generate(request, context)
      },
    }
    const first = runFunnelBuild(line.created.sessionId, line.created.sessionToken, line.dependencies)
    await entered
    const second = runFunnelBuild(line.created.sessionId, line.created.sessionToken, line.dependencies)
    await expect(second).rejects.toMatchObject({ statusCode: 409, statusMessage: '網站正在建置中，請稍候再試。' })
    releaseGeneration()
    await expect(first).resolves.toMatchObject({ releaseId: expect.any(Number) })
    expect(generationCalls).toBe(1)
    expect(line.managed.state.projects).toHaveLength(1)
  })

  it('recovers a stale building session and resumes the build', async () => {
    const line = await configuredLine('StaleBuild')
    line.funnel.state.sessions[0]!.status = 'building'
    line.funnel.state.sessions[0]!.updatedAt = new Date(managedSiteFixedNow.getTime() - MANAGED_SITE_FUNNEL_BUILD_STALE_MS - 1)
    await expect(runFunnelBuild(line.created.sessionId, line.created.sessionToken, line.dependencies)).resolves.toMatchObject({ releaseId: expect.any(Number) })
    expect(line.funnel.state.sessions[0]!.status).toBe('checkout_pending')
  })

  it('refreshes an expired Stripe checkout once and never creates checkout for an already-paid order', async () => {
    const expired = await configuredLine('ExpiredCheckout')
    let current = new Date(managedSiteFixedNow)
    let checkoutCalls = 0
    const stripeCheckout = createMockManagedSiteCheckoutSessionAdapter('stripe')
    const paymentConfiguration = expired.live.state.configurations.find(row => row.capability === 'payment')!
    paymentConfiguration.providerKey = 'stripe'
    expired.dependencies.clock = () => current
    expired.dependencies.checkoutAdapter = {
      async createSession(input) {
        checkoutCalls += 1
        return stripeCheckout.createSession(input)
      },
    }
    await runFunnelBuild(expired.created.sessionId, expired.created.sessionToken, expired.dependencies)
    const first = await runFunnelCheckout(expired.created.sessionId, expired.created.sessionToken, expired.dependencies)
    current = new Date(current.getTime() + MANAGED_SITE_FUNNEL_CHECKOUT_SESSION_TTL_MS + 1)
    const refreshed = await runFunnelCheckout(expired.created.sessionId, expired.created.sessionToken, expired.dependencies)
    expect(refreshed.checkoutUrl).not.toBe(first.checkoutUrl)
    expect(checkoutCalls).toBe(2)
    await expect(runFunnelCheckout(expired.created.sessionId, expired.created.sessionToken, expired.dependencies)).resolves.toEqual(refreshed)
    expect(checkoutCalls).toBe(2)

    expired.ordering.state.orders[0]!.status = 'payment_verified'
    await expect(runFunnelCheckout(expired.created.sessionId, expired.created.sessionToken, expired.dependencies)).rejects.toMatchObject({ statusCode: 409, statusMessage: '這筆訂單已完成付款，無需再次結帳。' })
    expect(checkoutCalls).toBe(2)
  })

  it('rejects an oversized public funnel body with a controlled 413', async () => {
    const memory = createFunnelSessionMemoryRepository()
    const response = await routeRequest(memory.repository, '/api/managed-sites/funnel/sessions', { padding: 'x'.repeat(70 * 1024) })
    expect(response.status).toBe(413)
    await expect(response.json()).resolves.toMatchObject({ statusCode: 413, statusMessage: '申請內容超過大小限制，請縮短後再試。' })
  })

  it('fails before creating a lead or draft order when contact is missing', async () => {
    const line = await configuredLine('MissingContact')
    const { contact: _contact, ...answersWithoutContact } = line.funnel.state.sessions[0]!.answers as FunnelAnswers
    line.funnel.state.sessions[0]!.answers = answersWithoutContact
    await expect(runFunnelBuild(line.created.sessionId, line.created.sessionToken, line.dependencies)).rejects.toMatchObject({ statusCode: 409, statusMessage: 'Contact details are required before building the website.' })
    expect(line.ordering.state.leads).toHaveLength(0)
    expect(line.ordering.state.orders).toHaveLength(0)
  })

  it('keeps owner authority server-side and fails closed when ownerOpenId is unset', async () => {
    const memory = createFunnelSessionMemoryRepository(); const created = await createFunnelSession(memory.repository, () => managedSiteFixedNow)
    const ownerBody = await routeRequest(memory.repository, `/api/managed-sites/funnel/sessions/${created.sessionId}`, { step: 1, answers: {}, ownerUserId: 99 }, created.sessionToken)
    expect(ownerBody.status).toBe(422)
    const ownerOpenIdBody = await routeRequest(memory.repository, `/api/managed-sites/funnel/sessions/${created.sessionId}`, { step: 1, answers: {}, ownerOpenId: 'attacker' }, created.sessionToken)
    expect(ownerOpenIdBody.status).toBe(422)
    const line = await configuredLine('Authority')
    delete process.env.OWNER_OPEN_ID
    const dependencies = { ...line.dependencies, resolveOwnerUserId: undefined }
    await expect(runFunnelBuild(line.created.sessionId, line.created.sessionToken, dependencies)).rejects.toMatchObject({ statusCode: 503, statusMessage: 'Platform owner authority is not configured.' })
  })
})

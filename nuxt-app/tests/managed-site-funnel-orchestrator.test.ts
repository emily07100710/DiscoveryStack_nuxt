import { beforeAll, afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, createError, createRouter, defineEventHandler, send, setResponseStatus, toWebHandler } from 'h3'
import { MANAGED_SITE_FUNNEL_BUILD_STALE_MS, MANAGED_SITE_FUNNEL_CHECKOUT_SESSION_TTL_MS, MANAGED_SITE_FUNNEL_DAILY_CAP_MESSAGE, MANAGED_SITE_FUNNEL_DEFAULT_DAILY_BUILD_LIMIT, managedSiteFunnelDailyBuildLimit, runFunnelBuild, runFunnelCheckout, type ManagedSiteFunnelOrchestratorDependencies } from '../server/managed-sites/funnel/checkout-orchestrator'
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
const savedDailyBuildLimit = process.env.MANAGED_SITE_FUNNEL_DAILY_BUILD_LIMIT
const savedStripeLiveMode = process.env.MANAGED_SITE_FUNNEL_STRIPE_LIVE_MODE
const savedAllowedProviderOrigins = process.env.DISCOVERYSTACK_MANAGED_SITE_ALLOWED_PROVIDER_ORIGINS
const savedAllowedCheckoutOrigins = process.env.DISCOVERYSTACK_MANAGED_SITE_ALLOWED_CHECKOUT_ORIGINS
const savedCredentialsJson = process.env.DISCOVERYSTACK_MANAGED_SITE_CREDENTIALS_JSON

beforeAll(() => {
  ;(globalThis as any).defineEventHandler = defineEventHandler
  ;(globalThis as any).createError = createError
  ;(globalThis as any).useRuntimeConfig = () => ({ ownerOpenId: process.env.OWNER_OPEN_ID || '' })
})

afterEach(() => {
  vi.unstubAllGlobals()
  setManagedSiteFunnelRepositoryForTests(null)
  setManagedSiteContactInboxBindingDependenciesForTests(null)
  if (savedPrivateOrigin === undefined) delete process.env.NUXT_DISCOVERYSTACK_PRIVATE_ORIGIN
  else process.env.NUXT_DISCOVERYSTACK_PRIVATE_ORIGIN = savedPrivateOrigin
  if (savedOwnerOpenId === undefined) delete process.env.OWNER_OPEN_ID
  else process.env.OWNER_OPEN_ID = savedOwnerOpenId
  if (savedDailyBuildLimit === undefined) delete process.env.MANAGED_SITE_FUNNEL_DAILY_BUILD_LIMIT
  else process.env.MANAGED_SITE_FUNNEL_DAILY_BUILD_LIMIT = savedDailyBuildLimit
  if (savedStripeLiveMode === undefined) delete process.env.MANAGED_SITE_FUNNEL_STRIPE_LIVE_MODE
  else process.env.MANAGED_SITE_FUNNEL_STRIPE_LIVE_MODE = savedStripeLiveMode
  if (savedAllowedProviderOrigins === undefined) delete process.env.DISCOVERYSTACK_MANAGED_SITE_ALLOWED_PROVIDER_ORIGINS
  else process.env.DISCOVERYSTACK_MANAGED_SITE_ALLOWED_PROVIDER_ORIGINS = savedAllowedProviderOrigins
  if (savedAllowedCheckoutOrigins === undefined) delete process.env.DISCOVERYSTACK_MANAGED_SITE_ALLOWED_CHECKOUT_ORIGINS
  else process.env.DISCOVERYSTACK_MANAGED_SITE_ALLOWED_CHECKOUT_ORIGINS = savedAllowedCheckoutOrigins
  if (savedCredentialsJson === undefined) delete process.env.DISCOVERYSTACK_MANAGED_SITE_CREDENTIALS_JSON
  else process.env.DISCOVERYSTACK_MANAGED_SITE_CREDENTIALS_JSON = savedCredentialsJson
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
  const managed = createManagedSiteMemoryRepository()
  const funnel = createFunnelSessionMemoryRepository({ projects: () => managed.state.projects, audits: () => managed.state.audits })
  const ordering = createOrderingMemoryRepository()
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
  it('parses only safe integer daily build limits', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    expect(managedSiteFunnelDailyBuildLimit('0')).toBe(0)
    expect(managedSiteFunnelDailyBuildLimit('21')).toBe(21)
    for (const value of ['-1', ' 20', '20.0', '1e3']) expect(managedSiteFunnelDailyBuildLimit(value)).toBe(MANAGED_SITE_FUNNEL_DEFAULT_DAILY_BUILD_LIMIT)
    warn.mockClear()
    for (const value of ['99999999999999999999', '9007199254740992']) expect(managedSiteFunnelDailyBuildLimit(value)).toBe(MANAGED_SITE_FUNNEL_DEFAULT_DAILY_BUILD_LIMIT)
    expect(warn).toHaveBeenCalledWith('[managed-site-funnel] ignoring invalid MANAGED_SITE_FUNNEL_DAILY_BUILD_LIMIT; using the default', { limit: MANAGED_SITE_FUNNEL_DEFAULT_DAILY_BUILD_LIMIT })
    warn.mockClear()
    expect(managedSiteFunnelDailyBuildLimit('abc')).toBe(MANAGED_SITE_FUNNEL_DEFAULT_DAILY_BUILD_LIMIT)
    expect(warn).toHaveBeenCalledWith('[managed-site-funnel] ignoring invalid MANAGED_SITE_FUNNEL_DAILY_BUILD_LIMIT; using the default', { limit: MANAGED_SITE_FUNNEL_DEFAULT_DAILY_BUILD_LIMIT })
    warn.mockClear()
    managedSiteFunnelDailyBuildLimit('')
    managedSiteFunnelDailyBuildLimit(undefined)
    expect(warn).not.toHaveBeenCalled()
    warn.mockRestore()
  })

  it('fails closed before durable work when the daily build cap is reached', async () => {
    const line = await configuredLine('DailyCap')
    process.env.MANAGED_SITE_FUNNEL_DAILY_BUILD_LIMIT = '2'
    line.managed.state.projects.push({ id: 900_001, ownerUserId: 1, createdAt: new Date(managedSiteFixedNow) } as any, { id: 900_002, ownerUserId: 1, createdAt: new Date(managedSiteFixedNow.getTime() - 1) } as any)
    await expect(runFunnelBuild(line.created.sessionId, line.created.sessionToken, line.dependencies)).rejects.toMatchObject({ statusCode: 429, statusMessage: MANAGED_SITE_FUNNEL_DAILY_CAP_MESSAGE })
    expect(line.funnel.state.sessions[0]!.status).toBe('active')
    expect(line.ordering.state.previews).toHaveLength(0)
    expect(line.managed.state.projects).toHaveLength(2)
  })

  it('counts a project at 24h minus 1ms in the daily window', async () => {
    const line = await configuredLine('DailyWindowEdge')
    process.env.MANAGED_SITE_FUNNEL_DAILY_BUILD_LIMIT = '1'
    line.managed.state.projects.push({ id: 900_001, ownerUserId: 1, createdAt: new Date(managedSiteFixedNow.getTime() - 24 * 60 * 60_000 + 1) } as any)
    await expect(runFunnelBuild(line.created.sessionId, line.created.sessionToken, line.dependencies)).rejects.toMatchObject({ statusCode: 429, statusMessage: MANAGED_SITE_FUNNEL_DAILY_CAP_MESSAGE })
    expect(line.funnel.state.sessions[0]!.status).toBe('active')
    expect(line.managed.state.projects).toHaveLength(1)
  })

  it('excludes a project at 24h plus 1ms and exempts release rebuilds', async () => {
    const line = await configuredLine('DailyWindow')
    process.env.MANAGED_SITE_FUNNEL_DAILY_BUILD_LIMIT = '1'
    line.managed.state.projects.push({ id: 900_001, ownerUserId: 1, createdAt: new Date(managedSiteFixedNow.getTime() - 24 * 60 * 60_000 - 1) } as any)
    await expect(runFunnelBuild(line.created.sessionId, line.created.sessionToken, line.dependencies)).resolves.toMatchObject({ releaseId: expect.any(Number) })
    line.managed.state.projects.push({ id: 900_002, ownerUserId: 1, createdAt: new Date(managedSiteFixedNow) } as any, { id: 900_003, ownerUserId: 1, createdAt: new Date(managedSiteFixedNow) } as any)
    line.funnel.state.sessions[0]!.builtPreviewUrl = null
    line.funnel.state.sessions[0]!.status = 'building'
    line.funnel.state.sessions[0]!.updatedAt = new Date(managedSiteFixedNow.getTime() - MANAGED_SITE_FUNNEL_BUILD_STALE_MS - 1)
    await expect(runFunnelBuild(line.created.sessionId, line.created.sessionToken, line.dependencies)).resolves.toMatchObject({ releaseId: expect.any(Number) })
    expect(line.managed.state.projects).toHaveLength(4)
  })

  it('reports an in-flight build before the daily cap', async () => {
    const line = await configuredLine('BuildingFirst')
    process.env.MANAGED_SITE_FUNNEL_DAILY_BUILD_LIMIT = '1'
    line.managed.state.projects.push({ id: 900_001, ownerUserId: 1, createdAt: new Date(managedSiteFixedNow) } as any)
    line.funnel.state.sessions[0]!.status = 'building'
    line.funnel.state.sessions[0]!.updatedAt = new Date(managedSiteFixedNow)
    await expect(runFunnelBuild(line.created.sessionId, line.created.sessionToken, line.dependencies)).rejects.toMatchObject({ statusCode: 409, statusMessage: '網站正在建置中，請稍候再試。' })
    expect(line.managed.state.projects).toHaveLength(1)
  })

  it("fails closed when a retry's own reservation has aged out of the window", async () => {
    const line = await configuredLine('CapAgedRetry')
    let now = new Date()
    let generationCalls = 0
    const successfulGeneration = createMockManagedSiteGenerationAdapter()
    line.dependencies.clock = () => now
    line.dependencies.deploymentAdapter = createMockManagedSiteDeploymentAdapter({ now: () => now })
    line.dependencies.generationAdapter = {
      async generate(request, context) {
        generationCalls += 1
        if (generationCalls === 1) throw Object.assign(new Error('provider timeout'), { code: 'TIMEOUT', retryable: true })
        return successfulGeneration.generate(request, context)
      },
    }

    await expect(runFunnelBuild(line.created.sessionId, line.created.sessionToken, line.dependencies)).rejects.toMatchObject({ statusCode: 503, statusMessage: '網站建置暫時未完成，請稍後再試。' })
    const session = line.funnel.state.sessions[0]!
    expect(session.status).toBe('active')
    expect(session.projectId).toEqual(expect.any(Number))
    expect(session.releaseId).toBeNull()
    expect(line.managed.state.projects).toHaveLength(1)
    expect(line.live.state.releases).toHaveLength(0)

    now = new Date(now.getTime() + 25 * 60 * 60_000)
    process.env.MANAGED_SITE_FUNNEL_DAILY_BUILD_LIMIT = '0'
    await expect(runFunnelBuild(line.created.sessionId, line.created.sessionToken, line.dependencies)).rejects.toMatchObject({ statusCode: 429, statusMessage: MANAGED_SITE_FUNNEL_DAILY_CAP_MESSAGE })
    expect(line.live.state.releases).toHaveLength(0)
    expect(line.managed.state.projects).toHaveLength(1)
    expect(session.status).toBe('active')

    process.env.MANAGED_SITE_FUNNEL_DAILY_BUILD_LIMIT = '1'
    line.managed.state.projects.push({ id: 900_001, ownerUserId: 1, createdAt: new Date(now) } as any)
    await expect(runFunnelBuild(line.created.sessionId, line.created.sessionToken, line.dependencies)).rejects.toMatchObject({ statusCode: 429, statusMessage: MANAGED_SITE_FUNNEL_DAILY_CAP_MESSAGE })
    expect(line.managed.state.projects).toHaveLength(2)

    process.env.MANAGED_SITE_FUNNEL_DAILY_BUILD_LIMIT = '2'
    await expect(runFunnelBuild(line.created.sessionId, line.created.sessionToken, line.dependencies)).resolves.toMatchObject({ releaseId: expect.any(Number) })
    expect(line.managed.state.projects).toHaveLength(2)
    expect(line.live.state.releases).toHaveLength(1)
    expect(session.status).toBe('checkout_pending')
  })

  it('keeps an admitted aged retry in the daily count for other old and new sessions', async () => {
    const line = await configuredLine('AgedRetryFirst')
    const second = await createFunnelSession(line.funnel.repository, () => managedSiteFixedNow)
    await saveFunnelStep(second.sessionId, second.sessionToken, { step: 9, answers: completeAnswers('AgedRetrySecond') }, line.funnel.repository, () => managedSiteFixedNow)
    await recordFunnelConsent(second.sessionId, second.sessionToken, { policyVersion: MANAGED_SITE_FUNNEL_CONSENT_VERSION, scrolledToBottom: true }, line.funnel.repository, () => managedSiteFixedNow)
    let now = new Date(managedSiteFixedNow)
    const attemptedProjects = new Set<number>()
    const successfulGeneration = createMockManagedSiteGenerationAdapter()
    const generate = vi.fn(async (request, context) => {
      if (!attemptedProjects.has(request.projectId)) {
        attemptedProjects.add(request.projectId)
        throw Object.assign(new Error('provider timeout'), { code: 'TIMEOUT', retryable: true })
      }
      return successfulGeneration.generate(request, context)
    })
    line.dependencies.clock = () => now
    line.dependencies.generationAdapter = { generate }
    line.dependencies.deploymentAdapter = createMockManagedSiteDeploymentAdapter({ now: () => now })
    for (const created of [line.created, second]) {
      await expect(runFunnelBuild(created.sessionId, created.sessionToken, line.dependencies)).rejects.toMatchObject({ statusCode: 503 })
    }
    expect(generate).toHaveBeenCalledTimes(2)

    now = new Date(now.getTime() + 25 * 60 * 60_000)
    process.env.MANAGED_SITE_FUNNEL_DAILY_BUILD_LIMIT = '1'
    await expect(runFunnelBuild(line.created.sessionId, line.created.sessionToken, line.dependencies)).resolves.toMatchObject({ releaseId: expect.any(Number) })
    await expect(runFunnelBuild(second.sessionId, second.sessionToken, line.dependencies)).rejects.toMatchObject({ statusCode: 429, statusMessage: MANAGED_SITE_FUNNEL_DAILY_CAP_MESSAGE })
    expect(generate).toHaveBeenCalledTimes(3)

    const fresh = await createFunnelSession(line.funnel.repository, () => now)
    await saveFunnelStep(fresh.sessionId, fresh.sessionToken, { step: 9, answers: completeAnswers('FreshAfterAgedRetry') }, line.funnel.repository, () => now)
    await recordFunnelConsent(fresh.sessionId, fresh.sessionToken, { policyVersion: MANAGED_SITE_FUNNEL_CONSENT_VERSION, scrolledToBottom: true }, line.funnel.repository, () => now)
    await expect(runFunnelBuild(fresh.sessionId, fresh.sessionToken, line.dependencies)).rejects.toMatchObject({ statusCode: 429, statusMessage: MANAGED_SITE_FUNNEL_DAILY_CAP_MESSAGE })
    expect(line.managed.state.projects).toHaveLength(2)
    expect(line.live.state.releases).toHaveLength(1)
  })

  it('fails closed after project reservation when concurrent builds overshoot the cap, then admits the idempotent retry once the window frees', async () => {
    const line = await configuredLine('CapRace')
    const current = new Date()
    process.env.MANAGED_SITE_FUNNEL_DAILY_BUILD_LIMIT = '1'
    line.dependencies.clock = () => current
    line.dependencies.deploymentAdapter = createMockManagedSiteDeploymentAdapter({ now: () => current })
    const ordering = line.ordering.repository
    let injected = false
    line.dependencies.orderingRepository = {
      ...ordering,
      async updatePreview(...args) {
        if (!injected) {
          injected = true
          line.managed.state.projects.push({ id: 900_001, ownerUserId: 1, createdAt: new Date(current) } as any)
        }
        return ordering.updatePreview(...args)
      },
    }

    await expect(runFunnelBuild(line.created.sessionId, line.created.sessionToken, line.dependencies)).rejects.toMatchObject({ statusCode: 429, statusMessage: MANAGED_SITE_FUNNEL_DAILY_CAP_MESSAGE })
    const session = line.funnel.state.sessions[0]!
    const realProject = line.managed.state.projects.find(project => project.id !== 900_001 && project.creationIdempotencyKey !== undefined)!
    expect(session.status).toBe('active')
    expect(session.projectId).toBe(realProject.id)
    expect(session.releaseId).toBeNull()
    expect(line.managed.state.projects).toHaveLength(2)
    expect(line.live.state.candidates).toHaveLength(0)
    expect(line.live.state.releases).toHaveLength(0)

    line.managed.state.projects.find(project => project.id === 900_001)!.createdAt = new Date(current.getTime() - 24 * 60 * 60_000 - 1)
    await expect(runFunnelBuild(line.created.sessionId, line.created.sessionToken, line.dependencies)).resolves.toMatchObject({ releaseId: expect.any(Number) })
    expect(line.managed.state.projects).toHaveLength(2)
    expect(line.live.state.releases).toHaveLength(1)
    expect(session.status).toBe('checkout_pending')
  })

  it('applies the Stripe test-mode guard on the live funnel checkout path before any durable checkout write', async () => {
    const line = await configuredLine('LiveGuard')
    // This regression isolates payment policy; domain procurement has its own live authorization tests.
    await saveFunnelStep(line.created.sessionId, line.created.sessionToken, { step: 7, answers: { domain: { option: 'existing', name: 'liveguard.example.com' } } }, line.funnel.repository, () => managedSiteFixedNow)
    await runFunnelBuild(line.created.sessionId, line.created.sessionToken, line.dependencies)
    delete process.env.MANAGED_SITE_FUNNEL_STRIPE_LIVE_MODE
    process.env.DISCOVERYSTACK_MANAGED_SITE_ALLOWED_PROVIDER_ORIGINS = 'https://api.stripe.com'
    process.env.DISCOVERYSTACK_MANAGED_SITE_ALLOWED_CHECKOUT_ORIGINS = 'https://checkout.stripe.com'
    process.env.DISCOVERYSTACK_MANAGED_SITE_CREDENTIALS_JSON = JSON.stringify({ 'vault:stripe-funnel-live-guard': 'sk_live_placeholder' })
    await configureManagedSiteProvider(1, { capability: 'payment', providerKey: 'stripe', readinessStatus: 'configured', credentialReference: 'vault:stripe-funnel-live-guard', transportConfiguration: { endpointOrigin: 'https://api.stripe.com', checkoutOrigin: 'https://checkout.stripe.com', returnOrigin: 'https://merchant.example.com' }, idempotencyKey: 'funnel-config-LiveGuard-payment-stripe' }, line.live.repository, () => managedSiteFixedNow)
    const configuration = await line.live.repository.findProviderConfiguration(1, 'payment')
    Object.assign(configuration!, { readinessStatus: 'verified', verificationReceiptFingerprint: 'b'.repeat(64), capabilityIdentity: 'stripe-balance:test', verifiedAt: managedSiteFixedNow })
    const spy = vi.fn(async () => { throw new Error('network must not be reached') })
    vi.stubGlobal('fetch', spy)
    const { checkoutAdapter: _mocked, ...liveDependencies } = line.dependencies
    await expect(runFunnelCheckout(line.created.sessionId, line.created.sessionToken, { ...liveDependencies, executionMode: 'live' })).rejects.toMatchObject({ statusCode: 503, statusMessage: '自助下單目前僅開放 Stripe 測試模式，請聯絡客服。' })
    expect(spy).not.toHaveBeenCalled()
    expect(line.live.state.releases[0]!.status).toBe('preview_ready')
    expect(line.live.state.attempts.filter(attempt => attempt.operation === 'checkout_session_create')).toHaveLength(0)
    expect(line.funnel.state.sessions[0]!.checkoutUrl).toBeFalsy()

    process.env.DISCOVERYSTACK_MANAGED_SITE_CREDENTIALS_JSON = JSON.stringify({ 'vault:stripe-funnel-live-guard': 'sk_test_placeholder' })
    await expect(runFunnelCheckout(line.created.sessionId, line.created.sessionToken, { ...liveDependencies, executionMode: 'live' })).rejects.toMatchObject({ statusCode: 503, statusMessage: 'Stripe checkout transport failed.' })
    expect(spy).toHaveBeenCalledTimes(1)
  })

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

import { readFileSync } from 'node:fs'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { createApp, createError, createRouter, defineEventHandler, send, setResponseStatus, toWebHandler } from 'h3'
import {
  MANAGED_SITE_FUNNEL_MANUAL_DOMAIN_CHECKOUT_MESSAGE,
  runFunnelCheckout,
} from '../server/managed-sites/funnel/checkout-orchestrator'
import { projectFunnelPriceCatalog } from '../server/managed-sites/funnel/quote-projection'
import { getManagedSitePriceCatalog } from '../server/managed-sites/ordering-service'
import { setManagedSiteFunnelRepositoryForTests } from '../server/managed-sites/funnel/session-repository'
import {
  createFunnelSession,
  MANAGED_SITE_FUNNEL_CONSENT_VERSION,
  recordFunnelConsent,
  saveFunnelStep,
} from '../server/managed-sites/funnel/session-service'
import { createFunnelSessionMemoryRepository } from './fixtures/managed-site/funnel-session-repository'

const page = readFileSync(new URL('../pages/customer/managed-sites/start.vue', import.meta.url), 'utf8')
const savedPrivateOrigin = process.env.NUXT_DISCOVERYSTACK_PRIVATE_ORIGIN

beforeAll(() => {
  ;(globalThis as any).defineEventHandler = defineEventHandler
  ;(globalThis as any).createError = createError
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  setManagedSiteFunnelRepositoryForTests(null)
  if (savedPrivateOrigin === undefined) delete process.env.NUXT_DISCOVERYSTACK_PRIVATE_ORIGIN
  else process.env.NUXT_DISCOVERYSTACK_PRIVATE_ORIGIN = savedPrivateOrigin
})

async function persistedManualDomainSession(option: 'existing' | 'assisted') {
  const now = new Date()
  const memory = createFunnelSessionMemoryRepository()
  const created = await createFunnelSession(memory.repository, () => now)
  await saveFunnelStep(created.sessionId, created.sessionToken, { step: 7, answers: { domain: { option } } }, memory.repository, () => now)
  await recordFunnelConsent(created.sessionId, created.sessionToken, { policyVersion: MANAGED_SITE_FUNNEL_CONSENT_VERSION, scrolledToBottom: true }, memory.repository, () => now)
  await memory.repository.updateSession(created.sessionId, {
    status: 'checkout_pending',
    projectId: 101,
    releaseId: 102,
    previewId: 103,
    draftOrderId: 104,
    previewAccessTokenHash: 'a'.repeat(64),
    builtPreviewUrl: 'https://preview.example.net/manual-domain',
  })
  return { ...memory, created, now }
}

function forbiddenDependency(label: string, access: (value: string) => void) {
  return new Proxy({}, {
    get(_target, property) {
      access(`${label}.${String(property)}`)
      throw new Error(`${label} must not be accessed`)
    },
  })
}

async function serveFunnel(handler: any) {
  const app = createApp({
    debug: false,
    onError: async (error, event) => {
      setResponseStatus(event, (error as any).statusCode || 500, (error as any).statusMessage)
      await send(event, JSON.stringify({ statusCode: (error as any).statusCode || 500, statusMessage: (error as any).statusMessage || 'Request failed.' }), 'application/json')
    },
  })
  const router = createRouter()
  router.use('/api/managed-sites/funnel/**', handler)
  app.use(router)
  return toWebHandler(app)
}

describe('managed-site funnel manual-domain launch guard', () => {
  it.each(['existing', 'assisted'] as const)('rejects a persisted %s-domain preview before order or provider access', async option => {
    const line = await persistedManualDomainSession(option)
    const dependencyAccess = vi.fn()
    const externalCheckout = vi.fn()
    const externalFetch = vi.fn()
    const resolveOwnerUserId = vi.fn(async () => 1)
    const updateSession = vi.spyOn(line.repository, 'updateSession')
    vi.stubGlobal('fetch', externalFetch)

    await expect(runFunnelCheckout(line.created.sessionId, line.created.sessionToken, {
      funnelRepository: line.repository,
      orderingRepository: forbiddenDependency('ordering', dependencyAccess) as any,
      connectorRepository: forbiddenDependency('connector', dependencyAccess) as any,
      managedRepository: forbiddenDependency('managed', dependencyAccess) as any,
      checkoutAdapter: { createSession: externalCheckout } as any,
      executionMode: 'live',
      clock: () => line.now,
      resolveOwnerUserId,
    })).rejects.toMatchObject({ statusCode: 409, statusMessage: MANAGED_SITE_FUNNEL_MANUAL_DOMAIN_CHECKOUT_MESSAGE })

    expect(dependencyAccess).not.toHaveBeenCalled()
    expect(resolveOwnerUserId).not.toHaveBeenCalled()
    expect(externalCheckout).not.toHaveBeenCalled()
    expect(externalFetch).not.toHaveBeenCalled()
    expect(updateSession).not.toHaveBeenCalled()
  })

  it.each(['existing', 'assisted'] as const)('enforces the same %s-domain guard through the real public handler', async option => {
    const line = await persistedManualDomainSession(option)
    const updateSession = vi.spyOn(line.repository, 'updateSession')
    const externalFetch = vi.fn()
    vi.stubGlobal('fetch', externalFetch)
    setManagedSiteFunnelRepositoryForTests(line.repository)
    process.env.NUXT_DISCOVERYSTACK_PRIVATE_ORIGIN = 'https://funnel.test'
    const handler = (await import('../server/api/managed-sites/funnel/[...path]')).default
    const request = await serveFunnel(handler)

    const response = await request(new Request(`https://funnel.test/api/managed-sites/funnel/sessions/${line.created.sessionId}/checkout`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: 'https://funnel.test',
        'x-managed-site-funnel-token': line.created.sessionToken,
      },
      body: '{}',
    }))

    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toMatchObject({ statusCode: 409, statusMessage: MANAGED_SITE_FUNNEL_MANUAL_DOMAIN_CHECKOUT_MESSAGE })
    expect(updateSession).not.toHaveBeenCalled()
    expect(externalFetch).not.toHaveBeenCalled()
  })

  it('publishes only the supported new-domain option without removing owner/manual pricing', () => {
    expect(projectFunnelPriceCatalog().domainOptions).toEqual(['new'])
    expect(getManagedSitePriceCatalog().domainOptions).toEqual(['existing', 'new', 'assisted'])
  })

  it('renders manual alternatives as enquiry handoffs and hides checkout for restored sessions', () => {
    expect(page).toContain('runtimeConfig.public.discoveryStackPublicSiteOrigin')
    expect(page).toContain("new URL('/zh-hant'")
    expect(page).toContain("url.hash = 'fit'")
    expect(page).toContain('前往合作諮詢表單')
    expect(page).toContain('目前不提供自助付款')
    expect(page).toContain('目前不在這裡選擇或付款')
    expect(page).toContain('!paymentVerified && selfServeDomainSupported')
    expect(page).toContain('不會建立付款頁面')
    expect(page).not.toContain('formatTwd(catalog.assistedDomainSetupMinor)')
  })
})

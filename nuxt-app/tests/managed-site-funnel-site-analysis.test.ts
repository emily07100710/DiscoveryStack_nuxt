import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { createApp, createError, createRouter, defineEventHandler, send, setResponseStatus, toWebHandler } from 'h3'
import { createFunnelSession, loadFunnelSession, type FunnelAnswers } from '../server/managed-sites/funnel/session-service'
import { setManagedSiteFunnelRepositoryForTests } from '../server/managed-sites/funnel/session-repository'
import { setManagedSiteContactInboxBindingDependenciesForTests } from '../server/managed-sites/contact-inbox/binding-service'
import { createFunnelSessionMemoryRepository } from './fixtures/managed-site/funnel-session-repository'
import { createContactInboxBindingMemoryRepository } from './fixtures/managed-site/contact-inbox-binding-repository'

vi.mock('../server/utils/publicSiteAnalysis', () => ({ analysePublicHomepage: vi.fn() }))

import { analysePublicHomepage } from '../server/utils/publicSiteAnalysis'

const analysePublicHomepageMock = vi.mocked(analysePublicHomepage)
const now = new Date('2026-09-04T00:00:00.000Z')
let funnelHandler: Awaited<typeof import('../server/api/managed-sites/funnel/[...path]')>['default']
const serverAnalysis = {
  requestedUrl: 'https://example.test/',
  finalUrl: 'https://example.test/',
  hostname: 'example.test',
  analysedAt: '2026-09-04T00:00:00.000Z',
  analysisVersion: 'public-homepage-structural-v2' as const,
  snapshotFingerprint: 'a'.repeat(64),
  scope: 'public_homepage_only' as const,
  scores: { overall: 71, seo: 68, geo: 72, brandContent: 74, ux: 70 },
  checks: { titlePresent: true },
  recommendationKeys: ['add_structured_data'],
}

beforeAll(async () => {
  ;(globalThis as any).defineEventHandler = defineEventHandler
  ;(globalThis as any).createError = createError
  ;(globalThis as any).useRuntimeConfig = () => ({})
  funnelHandler = (await import('../server/api/managed-sites/funnel/[...path]')).default
}, 60_000)

afterEach(() => {
  setManagedSiteFunnelRepositoryForTests(null)
  setManagedSiteContactInboxBindingDependenciesForTests(null)
  analysePublicHomepageMock.mockReset()
  delete process.env.NUXT_DISCOVERYSTACK_PRIVATE_ORIGIN
})

async function routeRequest(
  repository: ReturnType<typeof createFunnelSessionMemoryRepository>['repository'],
  path: string,
  body: unknown,
  options: { token?: string; origin?: boolean; method?: 'POST' | 'PATCH' } = {},
) {
  setManagedSiteFunnelRepositoryForTests(repository)
  setManagedSiteContactInboxBindingDependenciesForTests({ repository: createContactInboxBindingMemoryRepository().repository, transport: { configured: false, async send(): Promise<never> { throw new Error('unconfigured') } }, pepper: '', clock: () => new Date(now) })
  process.env.NUXT_DISCOVERYSTACK_PRIVATE_ORIGIN = 'https://funnel.test'
  const app = createApp({ debug: false, onError: async (error, event) => { setResponseStatus(event, (error as any).statusCode || 500, (error as any).statusMessage); await send(event, JSON.stringify({ statusCode: (error as any).statusCode || 500, statusMessage: (error as any).statusMessage || 'Request failed.' }), 'application/json') } })
  const router = createRouter(); router.use('/api/managed-sites/funnel/**', funnelHandler); app.use(router)
  return toWebHandler(app)(new Request(`https://funnel.test${path}`, {
    method: options.method || 'POST',
    headers: { 'content-type': 'application/json', ...(options.origin === false ? {} : { origin: 'https://funnel.test' }), ...(options.token ? { 'x-managed-site-funnel-token': options.token } : {}) },
    body: JSON.stringify(body),
  }))
}

describe('managed-site funnel server site analysis', () => {
  it('persists only the server-computed snapshot and rejects body smuggling', async () => {
    const memory = createFunnelSessionMemoryRepository()
    const created = await createFunnelSession(memory.repository, () => now)
    analysePublicHomepageMock.mockResolvedValue(serverAnalysis)
    const path = `/api/managed-sites/funnel/sessions/${created.sessionId}/site-analysis`

    const response = await routeRequest(memory.repository, path, { url: 'https://example.test' }, { token: created.sessionToken })
    expect(response.status).toBe(200)
    const payload = await response.json() as any
    const snapshot = { analysedAt: serverAnalysis.analysedAt, analysisVersion: serverAnalysis.analysisVersion, snapshotFingerprint: serverAnalysis.snapshotFingerprint, scores: serverAnalysis.scores }
    expect(payload.analysis).toEqual(serverAnalysis)
    expect(payload.session.answers.existingSite).toEqual({ hasSite: true, url: 'https://example.test/', snapshot })

    const smuggled = await routeRequest(memory.repository, path, { url: 'https://other.test', snapshot: { scores: { overall: 100 } } }, { token: created.sessionToken })
    expect(smuggled.status).toBe(422)
    const restored = await loadFunnelSession(created.sessionId, created.sessionToken, memory.repository, () => now)
    expect((restored.answers as FunnelAnswers).existingSite?.snapshot).toEqual(snapshot)
  })

  it('rejects a forged snapshot in the step-one PATCH and clears stale analysis for no-site answers', async () => {
    const memory = createFunnelSessionMemoryRepository()
    const created = await createFunnelSession(memory.repository, () => now)
    analysePublicHomepageMock.mockResolvedValue(serverAnalysis)
    await routeRequest(memory.repository, `/api/managed-sites/funnel/sessions/${created.sessionId}/site-analysis`, { url: 'https://example.test' }, { token: created.sessionToken })

    const forged = await routeRequest(memory.repository, `/api/managed-sites/funnel/sessions/${created.sessionId}`, {
      step: 1,
      answers: {
        existingSite: {
          hasSite: true,
          url: 'https://example.test',
          snapshot: { analysedAt: now.toISOString(), analysisVersion: 'forged', snapshotFingerprint: 'b'.repeat(64), scores: { overall: 100, seo: 100, geo: 100, brandContent: 100, ux: 100 } },
        },
      },
    }, { token: created.sessionToken, method: 'PATCH' })
    expect(forged.status).toBe(400)

    const cleared = await routeRequest(memory.repository, `/api/managed-sites/funnel/sessions/${created.sessionId}`, { step: 1, answers: { existingSite: { hasSite: false } } }, { token: created.sessionToken, method: 'PATCH' })
    expect(cleared.status).toBe(200)
    const restored = await loadFunnelSession(created.sessionId, created.sessionToken, memory.repository, () => now)
    expect((restored.answers as FunnelAnswers).existingSite).toEqual({ hasSite: false })
  })

  it('limits one session to five analyses inside the window', async () => {
    const memory = createFunnelSessionMemoryRepository()
    await createFunnelSession(memory.repository, () => now)
    const created = await createFunnelSession(memory.repository, () => now)
    analysePublicHomepageMock.mockResolvedValue(serverAnalysis)
    const path = `/api/managed-sites/funnel/sessions/${created.sessionId}/site-analysis`
    for (let attempt = 0; attempt < 5; attempt += 1) expect((await routeRequest(memory.repository, path, { url: 'https://example.test' }, { token: created.sessionToken })).status).toBe(200)
    const sixth = await routeRequest(memory.repository, path, { url: 'https://example.test' }, { token: created.sessionToken })
    expect(sixth.status).toBe(429)
  })

  it('maps private-network analysis failures without persisting a snapshot', async () => {
    const memory = createFunnelSessionMemoryRepository()
    const created = await createFunnelSession(memory.repository, () => now)
    analysePublicHomepageMock.mockRejectedValue(new Error('private_network_target'))
    const response = await routeRequest(memory.repository, `/api/managed-sites/funnel/sessions/${created.sessionId}/site-analysis`, { url: 'https://example.test' }, { token: created.sessionToken })
    expect(response.status).toBe(422)
    const restored = await loadFunnelSession(created.sessionId, created.sessionToken, memory.repository, () => now)
    expect((restored.answers as FunnelAnswers).existingSite?.snapshot).toBeUndefined()
  })

  it('requires the token and an exact same-origin mutation', async () => {
    const memory = createFunnelSessionMemoryRepository()
    const created = await createFunnelSession(memory.repository, () => now)
    const path = `/api/managed-sites/funnel/sessions/${created.sessionId}/site-analysis`
    expect((await routeRequest(memory.repository, path, { url: 'https://example.test' })).status).toBe(404)
    expect((await routeRequest(memory.repository, path, { url: 'https://example.test' }, { token: 'x'.repeat(43) })).status).toBe(404)
    expect((await routeRequest(memory.repository, path, { url: 'https://example.test' }, { token: created.sessionToken, origin: false })).status).toBe(403)
  })
})

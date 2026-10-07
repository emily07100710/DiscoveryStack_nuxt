import { createApp, createError, createRouter, defineEventHandler, getHeader, send, setResponseStatus, toWebHandler, type EventHandler } from 'h3'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const seams = vi.hoisted(() => ({
  owner: vi.fn(),
  ownerDatabaseId: vi.fn(),
  workspace: vi.fn(),
  release: vi.fn(),
  review: vi.fn(),
  reconcile: vi.fn(),
}))

vi.mock('../server/utils/auth', () => ({ requireOwner: seams.owner }))
vi.mock('../server/audit/repository', () => ({ getOwnerDatabaseUserId: seams.ownerDatabaseId }))
vi.mock('../server/learning-loop/live-action-service', () => ({
  getLivePublicationActionWorkspace: seams.workspace,
  resolveReviewedLivePublicationAction: seams.release,
  reviewLivePublicationAction: seams.review,
  reconcileLivePublicationAction: seams.reconcile,
}))

const ORIGIN = 'https://synthetic-learning-owner.taipei'
let handler: EventHandler

beforeAll(async () => {
  vi.stubGlobal('defineEventHandler', defineEventHandler)
  handler = (await import('../server/api/interventions/[...path]')).default
})

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubEnv('NUXT_DISCOVERYSTACK_PRIVATE_ORIGIN', ORIGIN)
  seams.owner.mockImplementation(async event => {
    const session = getHeader(event, 'x-test-owner-session')
    if (!session) throw createError({ statusCode: 401, statusMessage: 'synthetic-auth-required' })
    if (session !== 'synthetic-owner-1' && session !== 'synthetic-owner-2') throw createError({ statusCode: 403, statusMessage: 'synthetic-owner-forbidden' })
    return { openId: session }
  })
  seams.ownerDatabaseId.mockImplementation(async openId => openId === 'synthetic-owner-1' ? 71 : 72)
  seams.workspace.mockImplementation(async ownerUserId => ({ ownerUserId, actions: [] }))
  seams.release.mockImplementation(async (ownerUserId, id) => ({ ownerUserId, id, status: 'reviewed' }))
  seams.review.mockImplementation(async (ownerUserId, body) => ({ ownerUserId, accepted: body }))
  seams.reconcile.mockImplementation(async (ownerUserId, id) => ({ ownerUserId, id, reconciled: true }))
})

afterEach(() => { vi.unstubAllEnvs() })
afterAll(() => { vi.unstubAllGlobals() })

function createSyntheticHttp() {
  const app = createApp({
    debug: false,
    onError: async (error, event) => {
      setResponseStatus(event, error.statusCode || 500, error.statusMessage)
      await send(event, JSON.stringify({ statusCode: error.statusCode || 500, statusMessage: error.statusMessage || 'Request failed.' }), 'application/json')
    },
  })
  const router = createRouter()
  const route = defineEventHandler(event => {
    // Reproduce the named catch-all route parameter while keeping the real handler and
    // its body/origin/auth guards in-process; no listener or network is opened.
    const prefix = '/api/interventions/'
    event.context.params = { ...(event.context.params || {}), path: new URL(event.node.req.url || '/', ORIGIN).pathname.slice(prefix.length) }
    return handler(event)
  })
  router.use('/api/interventions/**', route)
  app.use(router)
  const web = toWebHandler(app)
  return async (path: string, options: { method?: 'GET' | 'POST'; raw?: string; body?: unknown; origin?: string | null; site?: string; owner?: string | null } = {}) => {
    const method = options.method || (options.body !== undefined || options.raw !== undefined ? 'POST' : 'GET')
    const headers: Record<string, string> = { ...(options.origin === null ? {} : { origin: options.origin ?? ORIGIN }), ...(options.owner === null ? {} : { 'x-test-owner-session': options.owner ?? 'synthetic-owner-1' }) }
    if (method === 'POST') headers['content-type'] = 'application/json'
    if (options.site) headers['sec-fetch-site'] = options.site
    const response = await web(new Request(ORIGIN + path, { method, headers, ...(method === 'POST' ? { body: options.raw ?? JSON.stringify(options.body ?? {}) } : {}) }))
    const text = await response.text()
    return { response, value: text ? JSON.parse(text) as Record<string, unknown> : null }
  }
}

describe('learning live-action intervention HTTP boundary', () => {
  it('uses session-derived owner scope and private headers for workspace and release reads', async () => {
    const call = createSyntheticHttp()
    const workspace = await call('/api/interventions/closed-loop/live-actions')
    expect(workspace.response.status).toBe(200)
    expect(workspace.value).toEqual({ ownerUserId: 71, actions: [] })
    expect(seams.workspace).toHaveBeenCalledExactlyOnceWith(71)

    const release = await call('/api/interventions/closed-loop/live-actions/23/release')
    expect(release.response.status).toBe(200)
    expect(release.value).toEqual({ action: { ownerUserId: 71, id: 23, status: 'reviewed' } })
    expect(seams.release).toHaveBeenCalledExactlyOnceWith(71, 23)
    for (const result of [workspace, release]) {
      expect(result.response.headers.get('cache-control')).toContain('no-store')
      expect(result.response.headers.get('x-robots-tag')).toContain('noindex')
      expect(result.response.headers.get('access-control-allow-origin')).toBeNull()
    }
    expect(seams.ownerDatabaseId).toHaveBeenNthCalledWith(1, 'synthetic-owner-1')
  })

  it('rejects missing and forbidden owner sessions before live-action services', async () => {
    const call = createSyntheticHttp()
    expect((await call('/api/interventions/closed-loop/live-actions', { owner: null })).response.status).toBe(401)
    expect((await call('/api/interventions/closed-loop/live-actions/23/release', { owner: 'synthetic-forbidden' })).response.status).toBe(403)
    expect(seams.ownerDatabaseId).not.toHaveBeenCalled()
    expect(seams.workspace).not.toHaveBeenCalled()
    expect(seams.release).not.toHaveBeenCalled()
    expect(seams.review).not.toHaveBeenCalled()
    expect(seams.reconcile).not.toHaveBeenCalled()
  })

  it.each([
    { origin: null, site: undefined },
    { origin: 'https://foreign.invalid', site: undefined },
    { origin: ORIGIN, site: 'cross-site' },
  ])('rejects a missing or cross-site mutation authority before action review', async options => {
    const result = await createSyntheticHttp()('/api/interventions/closed-loop/live-actions/review', { method: 'POST', body: { actionId: 23 }, ...options })
    expect(result.response.status).toBe(403)
    expect(seams.review).not.toHaveBeenCalled()
  })

  it('rejects malformed JSON, arrays, and payloads above the real 64 KiB bound', async () => {
    const call = createSyntheticHttp()
    expect((await call('/api/interventions/closed-loop/live-actions/23/reconcile', { method: 'POST', raw: '{broken' })).response.status).toBe(400)
    expect((await call('/api/interventions/closed-loop/live-actions/23/reconcile', { method: 'POST', raw: '[]' })).response.status).toBe(400)
    expect((await call('/api/interventions/closed-loop/live-actions/23/reconcile', { method: 'POST', raw: JSON.stringify({}) + ' '.repeat(65 * 1024) })).response.status).toBe(413)
    expect(seams.reconcile).not.toHaveBeenCalled()
  })

  it.each(['0', '-1', '1.5', 'not-an-id', '9007199254740992'])('rejects non-positive/non-safe action IDs before service access (%s)', async id => {
    const call = createSyntheticHttp()
    expect((await call(`/api/interventions/closed-loop/live-actions/${id}/release`)).response.status).toBe(422)
    expect((await call(`/api/interventions/closed-loop/live-actions/${id}/reconcile`, { method: 'POST', body: {} })).response.status).toBe(422)
    expect(seams.release).not.toHaveBeenCalled()
    expect(seams.reconcile).not.toHaveBeenCalled()
  })

  it('allows only an empty reconcile body and never forwards caller URL, owner, or enablement fields', async () => {
    const call = createSyntheticHttp()
    for (const body of [{ url: 'https://forged.invalid/' }, { ownerUserId: 72 }, { enabled: true }, { url: 'https://forged.invalid/', ownerUserId: 72, enabled: true }]) {
      expect((await call('/api/interventions/closed-loop/live-actions/23/reconcile', { method: 'POST', body })).response.status).toBe(422)
    }
    expect(seams.reconcile).not.toHaveBeenCalled()
    const accepted = await call('/api/interventions/closed-loop/live-actions/23/reconcile', { method: 'POST', body: {} })
    expect(accepted.response.status).toBe(200)
    expect(seams.reconcile).toHaveBeenCalledExactlyOnceWith(71, 23)
  })

  it('passes review body only alongside the server-derived owner, never as owner authority', async () => {
    const body = { actionId: 23, decision: 'approve', ownerUserId: 72, enabled: true, url: 'https://forged.invalid/' }
    const result = await createSyntheticHttp()('/api/interventions/closed-loop/live-actions/review', { method: 'POST', body })
    expect(result.response.status).toBe(200)
    expect(seams.review).toHaveBeenCalledExactlyOnceWith(71, body)
    expect(result.value).toEqual({ ownerUserId: 71, accepted: body })
  })
})

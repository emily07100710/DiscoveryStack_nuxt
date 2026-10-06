import { createApp, createError, createRouter, defineEventHandler, toWebHandler } from 'h3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ owner: vi.fn(), ownerId: vi.fn(), delivery: vi.fn() }))
vi.mock('../server/utils/auth', () => ({ requireOwner: mocks.owner }))
vi.mock('../server/audit/repository', () => ({ getOwnerDatabaseUserId: mocks.ownerId }))
vi.mock('../server/managed-sites/member-invitation-delivery', () => ({ inviteAndDeliverManagedSiteMember: mocks.delivery }))

async function request(options: { origin?: string | null; raw?: string; fetchSite?: string } = {}) {
  vi.stubGlobal('defineEventHandler', defineEventHandler)
  const handler = (await import('../server/api/managed-sites/projects/[id]/members.post')).default
  const router = createRouter().post('/api/managed-sites/projects/:id/members', handler)
  const web = toWebHandler(createApp({ debug: false }).use(router))
  const origin = options.origin === undefined ? 'https://ops.synthetic-ds.taipei' : options.origin
  return web(new Request('https://ops.synthetic-ds.taipei/api/managed-sites/projects/7/members', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(origin ? { origin } : {}), ...(options.fetchSite ? { 'sec-fetch-site': options.fetchSite } : {}) },
    body: options.raw || JSON.stringify({ email: 'fixture@example.com', role: 'editor', idempotencyKey: 'fixture-invite-001' }),
  }))
}

describe('member invitation HTTP delivery boundary', () => {
  beforeEach(() => {
    vi.stubEnv('NUXT_DISCOVERYSTACK_PRIVATE_ORIGIN', 'https://ops.synthetic-ds.taipei')
    mocks.owner.mockResolvedValue({ openId: 'synthetic-owner' })
    mocks.ownerId.mockResolvedValue(1)
    mocks.delivery.mockResolvedValue({ delivery: { status: 'sent' }, invitationToken: null })
  })
  afterEach(() => { vi.clearAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals() })

  it.each([null, 'https://foreign.synthetic-ds.taipei'])('rejects foreign or absent origin before identity or email for %s', async origin => {
    expect((await request({ origin })).status).toBe(403)
    expect(mocks.owner).not.toHaveBeenCalled()
    expect(mocks.delivery).not.toHaveBeenCalled()
  })
  it('rejects cross-site metadata and oversized bodies before sending', async () => {
    expect((await request({ fetchSite: 'same-site' })).status).toBe(403)
    expect((await request({ raw: JSON.stringify({ email: 'x'.repeat(13 * 1024) }) })).status).toBe(413)
    expect(mocks.owner).not.toHaveBeenCalled()
    expect(mocks.delivery).not.toHaveBeenCalled()
  })
  it('does not deliver without a current owner session', async () => {
    mocks.owner.mockRejectedValueOnce(createError({ statusCode: 401 }))
    expect((await request()).status).toBe(401)
    expect(mocks.delivery).not.toHaveBeenCalled()
  })
  it('uses server-owned project identity and private headers for a valid request', async () => {
    const response = await request()
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toContain('no-store')
    expect(response.headers.get('referrer-policy')).toBe('no-referrer')
    expect(response.headers.get('x-robots-tag')).toContain('noindex')
    expect(mocks.delivery).toHaveBeenCalledWith(1, 7, { ownerUserId: 1, actorUserId: 1, authority: 'owner_session', role: 'owner' }, expect.any(Object))
    expect(await response.text()).not.toContain('synthetic-owner')
  })
})

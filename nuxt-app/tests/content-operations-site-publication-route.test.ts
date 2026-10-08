import { createError, createEvent } from 'h3'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ owner: vi.fn(), ownerId: vi.fn(), body: vi.fn(), check: vi.fn(), runtime: vi.fn(), fetch: vi.fn(), headers: vi.fn(), router: vi.fn(), requestHeader: vi.fn() }))
vi.mock('h3', async original => ({ ...await original<typeof import('h3')>(), setResponseHeaders: mocks.headers, getRouterParam: mocks.router, getRequestHeader: mocks.requestHeader }))
vi.mock('../server/utils/auth', () => ({ requireOwner: mocks.owner }))
vi.mock('../server/audit/repository', () => ({ getOwnerDatabaseUserId: mocks.ownerId }))
vi.mock('../server/utils/bounded-request-body', () => ({ readBoundedRequestBody: mocks.body }))
vi.mock('../server/content-operations/runtime-dependencies', () => ({ getContentOperationsRuntimeDependencies: mocks.runtime }))
vi.mock('../server/content-operations/bounded-fetch', () => ({ createBoundedFetch: mocks.fetch }))
vi.mock('../server/content-operations/site-publication', async original => ({ ...await original<typeof import('../server/content-operations/site-publication')>(), checkOwnerSitePublication: mocks.check }))

const event = () => createEvent({ method: 'POST', url: '/api/content-operations/entries/123/site-publication-check', headers: { host: 'owner.discoverystack.com' } } as never, {} as never)
const handler = async () => (await import('../server/api/content-operations/entries/[id]/site-publication-check.post')).default

beforeEach(() => {
  vi.stubEnv('NUXT_DISCOVERYSTACK_PRIVATE_ORIGIN', 'https://owner.discoverystack.com')
  mocks.owner.mockReset().mockResolvedValue({ openId: 'synthetic-owner' })
  mocks.ownerId.mockReset().mockResolvedValue(41)
  mocks.headers.mockReset()
  mocks.router.mockReset().mockReturnValue('123')
  mocks.requestHeader.mockReset().mockImplementation((_event, name) => name === 'origin' ? 'https://owner.discoverystack.com' : name === 'sec-fetch-site' ? 'same-origin' : undefined)
  mocks.body.mockReset().mockResolvedValue({ targetRowId: 456, idempotencyKey: 'site-query-fixture-0001' })
  mocks.runtime.mockReset().mockReturnValue({ nonceProvider: () => 'synthetic-nonce', serverCredentialResolver: async () => ({ ok: false }) })
  mocks.fetch.mockReset().mockReturnValue(vi.fn())
  mocks.check.mockReset().mockResolvedValue({ status: 'verified', workflowChanged: false, learningAuthorized: false, observation: { receiptIsCurrentState: false } })
})

describe('owner site-publication-check route boundary', () => {
  it('requires owner before parsing body, database lookup, runtime construction or remote query', async () => {
    mocks.owner.mockRejectedValueOnce(createError({ statusCode: 401, statusMessage: 'Owner required.' }))
    await expect((await handler())(event())).rejects.toMatchObject({ statusCode: 401 })
    expect(mocks.body).not.toHaveBeenCalled(); expect(mocks.ownerId).not.toHaveBeenCalled(); expect(mocks.runtime).not.toHaveBeenCalled(); expect(mocks.check).not.toHaveBeenCalled()
    expect(mocks.headers).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ 'cache-control': 'private, no-store, max-age=0', 'x-robots-tag': 'noindex, nofollow, noarchive', 'referrer-policy': 'no-referrer' }))
  })

  it.each([undefined, 'https://attacker.com'])('requires exact same-origin before body and DB access (%s)', async origin => {
    mocks.requestHeader.mockImplementation((_event, name) => name === 'origin' ? origin : 'same-origin')
    await expect((await handler())(event())).rejects.toMatchObject({ statusCode: 403 })
    expect(mocks.body).not.toHaveBeenCalled(); expect(mocks.ownerId).not.toHaveBeenCalled(); expect(mocks.check).not.toHaveBeenCalled()
  })

  it('rejects cross-site fetch metadata even when the origin string matches', async () => {
    mocks.requestHeader.mockImplementation((_event, name) => name === 'origin' ? 'https://owner.discoverystack.com' : 'cross-site')
    await expect((await handler())(event())).rejects.toMatchObject({ statusCode: 403 }); expect(mocks.check).not.toHaveBeenCalled()
  })

  it.each([{ targetRowId: 456, idempotencyKey: 'site-query-fixture-0001', ownerUserId: 9 }, { targetRowId: 456, idempotencyKey: 'site-query-fixture-0001', publicationUrl: 'https://attacker.com' }, { targetRowId: 456, idempotencyKey: 'site-query-fixture-0001', published: true }, { targetRowId: '456', idempotencyKey: 'site-query-fixture-0001' }])('rejects unknown authority or invalid identity before owner DB lookup', async body => {
    mocks.body.mockResolvedValue(body)
    await expect((await handler())(event())).rejects.toMatchObject({ statusCode: 422 })
    expect(mocks.ownerId).not.toHaveBeenCalled(); expect(mocks.runtime).not.toHaveBeenCalled(); expect(mocks.check).not.toHaveBeenCalled()
  })

  it('maps owner exclusively from session and uses a 4 KiB capped read-only transport', async () => {
    expect(await (await handler())(event())).toMatchObject({ status: 'verified', workflowChanged: false, learningAuthorized: false })
    expect(mocks.ownerId).toHaveBeenCalledWith('synthetic-owner')
    expect(mocks.body).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ maxBytes: 512 }))
    expect(mocks.fetch).toHaveBeenCalledWith({ maxResponseBodyBytes: 4096 })
    expect(mocks.check).toHaveBeenCalledWith(expect.objectContaining({ ownerUserId: 41, entryId: 123, value: { targetRowId: 456, idempotencyKey: 'site-query-fixture-0001' } }))
  })

  it('redacts arbitrary database/runtime errors', async () => {
    mocks.check.mockRejectedValue(new Error('synthetic-sensitive-db-error'))
    await expect((await handler())(event())).rejects.toMatchObject({ statusCode: 503, statusMessage: '網站發布狀態暫時無法核驗，沒有執行發布或授予學習權限。' })
  })
})

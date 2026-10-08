import { createError, createEvent } from 'h3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ owner: vi.fn(), ownerId: vi.fn(), body: vi.fn(), confirm: vi.fn(), runtime: vi.fn(), fetch: vi.fn(), headers: vi.fn(), router: vi.fn(), requestHeader: vi.fn(), repository: vi.fn(), weeklyRepository: vi.fn() }))
vi.mock('h3', async original => ({ ...await original<typeof import('h3')>(), setResponseHeaders: mocks.headers, getRouterParam: mocks.router, getRequestHeader: mocks.requestHeader }))
vi.mock('../server/utils/auth', () => ({ requireOwner: mocks.owner }))
vi.mock('../server/audit/repository', () => ({ getOwnerDatabaseUserId: mocks.ownerId }))
vi.mock('../server/utils/bounded-request-body', () => ({ readBoundedRequestBody: mocks.body }))
vi.mock('../server/content-operations/runtime-dependencies', () => ({ getContentOperationsRuntimeDependencies: mocks.runtime }))
vi.mock('../server/content-operations/bounded-fetch', () => ({ createBoundedFetch: mocks.fetch }))
vi.mock('../server/content-operations/repository', () => ({ createContentOperationsRepository: mocks.repository }))
vi.mock('../server/weekly-content/repository', () => ({ createWeeklyContentRepository: mocks.weeklyRepository }))
vi.mock('../server/content-operations/site-measurement', async original => ({ ...await original<typeof import('../server/content-operations/site-measurement')>(), confirmOwnerSiteMeasurement: mocks.confirm }))

const confirmationInput = {
  targetRowId: 456,
  expectedPublicationFingerprint: 'c'.repeat(64),
  confirmed: true,
  idempotencyKey: 'site-measurement-fixture-0001',
}
const event = () => createEvent({ method: 'POST', url: '/api/content-operations/entries/123/site-measurement-confirm', headers: { host: 'owner.discoverystack.com' } } as never, {} as never)
const handler = async () => (await import('../server/api/content-operations/entries/[id]/site-measurement-confirm.post')).default

function expectPrivateHeaders() {
  expect(mocks.headers).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
    'cache-control': 'private, no-store, max-age=0',
    'x-robots-tag': 'noindex, nofollow, noarchive',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
  }))
  const sent = mocks.headers.mock.calls[0]?.[1] as Record<string, string> | undefined
  expect(Object.keys(sent || {}).some(name => name.toLowerCase().startsWith('access-control-'))).toBe(false)
}

function expectRepositoriesNotInitialized() {
  expect(mocks.repository).not.toHaveBeenCalled()
  expect(mocks.weeklyRepository).not.toHaveBeenCalled()
}

beforeEach(() => {
  vi.stubEnv('NUXT_DISCOVERYSTACK_PRIVATE_ORIGIN', 'https://owner.discoverystack.com')
  mocks.owner.mockReset().mockResolvedValue({ openId: 'synthetic-owner' })
  mocks.ownerId.mockReset().mockResolvedValue(41)
  mocks.headers.mockReset()
  mocks.router.mockReset().mockReturnValue('123')
  mocks.requestHeader.mockReset().mockImplementation((_event, name) => name === 'origin' ? 'https://owner.discoverystack.com' : name === 'sec-fetch-site' ? 'same-origin' : undefined)
  mocks.body.mockReset().mockResolvedValue(confirmationInput)
  mocks.runtime.mockReset().mockReturnValue({ fetchImpl: vi.fn(), serverCredentialResolver: vi.fn(), nonceProvider: vi.fn() })
  mocks.fetch.mockReset().mockReturnValue(vi.fn())
  mocks.confirm.mockReset().mockResolvedValue({ status: 'confirmed', replayed: false, workflowChanged: false, learningAuthorized: false, receiptIsCurrentAuthority: false, confirmedAt: '2026-10-08T06:00:00.000Z' })
  mocks.repository.mockReset().mockReturnValue({ syntheticRepository: true })
  mocks.weeklyRepository.mockReset().mockReturnValue({ syntheticWeeklyRepository: true })
})

afterEach(() => vi.unstubAllEnvs())

describe('owner site-measurement-confirm route boundary', () => {
  it('requires owner before parsing body, database lookup, runtime construction or confirmation', async () => {
    mocks.owner.mockRejectedValueOnce(createError({ statusCode: 401, statusMessage: 'Owner required.' }))
    await expect((await handler())(event())).rejects.toMatchObject({ statusCode: 401 })
    expect(mocks.body).not.toHaveBeenCalled()
    expect(mocks.ownerId).not.toHaveBeenCalled()
    expect(mocks.runtime).not.toHaveBeenCalled()
    expect(mocks.fetch).not.toHaveBeenCalled()
    expect(mocks.confirm).not.toHaveBeenCalled()
    expectRepositoriesNotInitialized()
    expectPrivateHeaders()
  })

  it.each([undefined, 'https://attacker.invalid'])('requires exact same-origin before parsing body (%s)', async origin => {
    mocks.requestHeader.mockImplementation((_event, name) => name === 'origin' ? origin : 'same-origin')
    await expect((await handler())(event())).rejects.toMatchObject({ statusCode: 403 })
    expect(mocks.body).not.toHaveBeenCalled()
    expect(mocks.ownerId).not.toHaveBeenCalled()
    expect(mocks.runtime).not.toHaveBeenCalled()
    expect(mocks.confirm).not.toHaveBeenCalled()
    expectRepositoriesNotInitialized()
  })

  it('rejects cross-site fetch metadata even when the origin matches', async () => {
    mocks.requestHeader.mockImplementation((_event, name) => name === 'origin' ? 'https://owner.discoverystack.com' : 'cross-site')
    await expect((await handler())(event())).rejects.toMatchObject({ statusCode: 403 })
    expect(mocks.body).not.toHaveBeenCalled()
    expect(mocks.ownerId).not.toHaveBeenCalled()
    expect(mocks.confirm).not.toHaveBeenCalled()
    expectRepositoriesNotInitialized()
  })

  it.each(['not a URL', 'https://owner.discoverystack.com/private/path', 'https://user:password@owner.discoverystack.com'])('rejects invalid configured private origin %s before body and DB work', async origin => {
    vi.stubEnv('NUXT_DISCOVERYSTACK_PRIVATE_ORIGIN', origin)
    await expect((await handler())(event())).rejects.toMatchObject({ statusCode: 503 })
    expect(mocks.body).not.toHaveBeenCalled()
    expect(mocks.ownerId).not.toHaveBeenCalled()
    expect(mocks.runtime).not.toHaveBeenCalled()
    expect(mocks.confirm).not.toHaveBeenCalled()
    expectRepositoriesNotInitialized()
  })

  it.each(['0', '01', '-1', '1234567890123'])('rejects invalid entry route id %s before body and DB work', async entryId => {
    mocks.router.mockReturnValue(entryId)
    await expect((await handler())(event())).rejects.toMatchObject({ statusCode: 422 })
    expect(mocks.body).not.toHaveBeenCalled()
    expect(mocks.ownerId).not.toHaveBeenCalled()
    expect(mocks.confirm).not.toHaveBeenCalled()
    expectRepositoriesNotInitialized()
  })

  it.each([
    { ...confirmationInput, ownerUserId: 99 },
    { ...confirmationInput, publicationUrl: 'https://private.synthetic.invalid/post' },
    { ...confirmationInput, authorityReference: 'synthetic-authority' },
    { ...confirmationInput, publishedAt: '2026-10-08T06:00:00.000Z' },
    { ...confirmationInput, targetRowId: '456' },
    { ...confirmationInput, confirmed: false },
    { ...confirmationInput, expectedPublicationFingerprint: 'not-a-fingerprint' },
    { ...confirmationInput, idempotencyKey: 'short' },
  ])('rejects extra authority or malformed exact four-field body before owner DB lookup', async body => {
    mocks.body.mockResolvedValue(body)
    await expect((await handler())(event())).rejects.toMatchObject({ statusCode: 422 })
    expect(mocks.ownerId).not.toHaveBeenCalled()
    expect(mocks.runtime).not.toHaveBeenCalled()
    expect(mocks.confirm).not.toHaveBeenCalled()
    expectRepositoriesNotInitialized()
  })

  it('uses the byte-bounded body reader and preserves its oversized request failure', async () => {
    mocks.body.mockRejectedValue(createError({ statusCode: 413, statusMessage: 'synthetic raw parser details' }))
    const result = await (await handler())(event()).catch(error => error)
    expect(result).toMatchObject({ statusCode: 413, statusMessage: '目前無法確認接入成效觀察；沒有發布文章或授予訓練權限。' })
    expect(mocks.body).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ maxBytes: 1024 }))
    expect(mocks.ownerId).not.toHaveBeenCalled()
    expect(mocks.runtime).not.toHaveBeenCalled()
    expect(mocks.confirm).not.toHaveBeenCalled()
    expectRepositoriesNotInitialized()
  })

  it('maps owner only from the authenticated session and constructs only bounded runtime transport', async () => {
    expect(await (await handler())(event())).toEqual({ status: 'confirmed', replayed: false, workflowChanged: false, learningAuthorized: false, receiptIsCurrentAuthority: false, confirmedAt: '2026-10-08T06:00:00.000Z' })
    expectPrivateHeaders()
    expect(mocks.ownerId).toHaveBeenCalledWith('synthetic-owner')
    expect(mocks.body).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ maxBytes: 1024 }))
    expect(mocks.fetch).toHaveBeenCalledWith({ maxResponseBodyBytes: 4096 })
    expect(mocks.repository).toHaveBeenCalledTimes(1)
    expect(mocks.weeklyRepository).not.toHaveBeenCalled()
    expect(mocks.confirm).toHaveBeenCalledWith(expect.objectContaining({ ownerUserId: 41, entryId: 123, value: confirmationInput, repository: { syntheticRepository: true }, weeklyRepositoryFactory: mocks.weeklyRepository }))
    expect(mocks.confirm.mock.calls[0]?.[0].dependencies.fetchImpl).toBe(mocks.fetch.mock.results[0]?.value)
  })

  it('redacts arbitrary service errors and never returns secret-bearing details', async () => {
    mocks.confirm.mockRejectedValue(createError({ statusCode: 409, statusMessage: 'synthetic-secret-authority-details' }))
    const result = await (await handler())(event()).catch(error => error)
    expect(result).toMatchObject({ statusCode: 409, statusMessage: '目前無法確認接入成效觀察；沒有發布文章或授予訓練權限。' })
    expect(JSON.stringify(result)).not.toContain('synthetic-secret-authority-details')
  })
})

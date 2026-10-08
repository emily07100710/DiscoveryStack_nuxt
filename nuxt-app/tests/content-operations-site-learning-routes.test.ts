import { createError, createEvent } from 'h3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  owner: vi.fn(), ownerId: vi.fn(), body: vi.fn(), headers: vi.fn(), router: vi.fn(), requestHeader: vi.fn(),
  runtime: vi.fn(), fetch: vi.fn(), operations: vi.fn(), weekly: vi.fn(), learning: vi.fn(), lineages: vi.fn(),
  workspace: vi.fn(), release: vi.fn(), optIn: vi.fn(), revoke: vi.fn(), review: vi.fn(),
}))

vi.mock('h3', async original => ({
  ...await original<typeof import('h3')>(),
  setResponseHeaders: mocks.headers,
  getRouterParam: mocks.router,
  getRequestHeader: mocks.requestHeader,
}))
vi.mock('../server/utils/auth', () => ({ requireOwner: mocks.owner }))
vi.mock('../server/audit/repository', () => ({ getOwnerDatabaseUserId: mocks.ownerId }))
vi.mock('../server/utils/bounded-request-body', () => ({ readBoundedRequestBody: mocks.body }))
vi.mock('../server/content-operations/runtime-dependencies', () => ({ getContentOperationsRuntimeDependencies: mocks.runtime }))
vi.mock('../server/content-operations/bounded-fetch', () => ({ createBoundedFetch: mocks.fetch }))
vi.mock('../server/content-operations/repository', () => ({ createContentOperationsRepository: mocks.operations }))
vi.mock('../server/weekly-content/repository', () => ({ createWeeklyContentRepository: mocks.weekly }))
vi.mock('../server/learning-loop/repository', () => ({ DrizzleLearningLoopRepository: class { constructor() { mocks.learning() } } }))
vi.mock('../server/content-operations/site-measurement', () => ({ resolveConfirmedSiteMeasurementLineages: mocks.lineages }))
vi.mock('../server/content-operations/site-learning', () => ({
  getSiteLearningWorkspace: mocks.workspace,
  buildSiteLearningRelease: mocks.release,
  recordSiteLearningOptIn: mocks.optIn,
  revokeSiteLearningOptIn: mocks.revoke,
  reviewSiteLearningOutcome: mocks.review,
}))

const HASH_A = 'a'.repeat(64)
const HASH_B = 'b'.repeat(64)
const HASH_C = 'c'.repeat(64)
const ID_KEY = 'synthetic-learning-key-0001'
const event = (method: string, pathname: string) => createEvent({ method, url: pathname, headers: { host: 'owner.discoverystack.test' } } as never, {} as never)
const route = async (id: string) => (await import(id)).default as (event: unknown) => Promise<unknown>

const paths = {
  workspace: '../server/api/content-operations/site-learning/workspace.get',
  release: '../server/api/content-operations/site-learning/release.post',
  optIn: '../server/api/content-operations/entries/[id]/site-learning-opt-in.post',
  revoke: '../server/api/content-operations/entries/[id]/site-learning-revoke.post',
  review: '../server/api/content-operations/site-learning/outcomes/[id]/review.post',
}
const optInValue = {
  targetRowId: 22, expectedConfirmationFingerprint: HASH_A, authorizationId: 33,
  expectedAuthorizationFingerprint: HASH_B, customerEvidenceConfirmed: true, scopeConfirmed: true, idempotencyKey: ID_KEY,
}
const revokeValue = { targetRowId: 22, expectedGrantFingerprint: HASH_C, confirmed: true, idempotencyKey: ID_KEY }
const reviewValue = {
  expectedAssessmentFingerprint: HASH_A, expectedGrantFingerprint: HASH_C, decision: 'approve',
  piiReviewed: true, limitationsUnderstood: true, idempotencyKey: ID_KEY,
}

function expectPrivateHeaders() {
  expect(mocks.headers).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
    'cache-control': 'private, no-store, max-age=0',
    'x-robots-tag': 'noindex, nofollow, noarchive',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
  }))
  const headers = mocks.headers.mock.calls[0]?.[1] as Record<string, string> | undefined
  expect(Object.keys(headers ?? {}).some(name => name.toLowerCase().startsWith('access-control-'))).toBe(false)
}

function expectNoRepositories() {
  expect(mocks.ownerId).not.toHaveBeenCalled()
  expect(mocks.operations).not.toHaveBeenCalled()
  expect(mocks.weekly).not.toHaveBeenCalled()
  expect(mocks.learning).not.toHaveBeenCalled()
}

beforeEach(() => {
  vi.stubEnv('NUXT_DISCOVERYSTACK_PRIVATE_ORIGIN', 'https://owner.discoverystack.test')
  mocks.owner.mockReset().mockResolvedValue({ openId: 'synthetic-owner' })
  mocks.ownerId.mockReset().mockResolvedValue(41)
  mocks.body.mockReset().mockResolvedValue({})
  mocks.headers.mockReset()
  mocks.router.mockReset().mockReturnValue('11')
  mocks.requestHeader.mockReset().mockImplementation((_event, name) => name === 'origin' ? 'https://owner.discoverystack.test' : name === 'sec-fetch-site' ? 'same-origin' : undefined)
  mocks.runtime.mockReset().mockReturnValue({ syntheticRuntimeOnly: true })
  mocks.fetch.mockReset().mockReturnValue(vi.fn())
  mocks.operations.mockReset().mockReturnValue({ syntheticRepository: 'operations' })
  mocks.weekly.mockReset().mockReturnValue({ syntheticRepository: 'weekly' })
  mocks.learning.mockReset()
  mocks.lineages.mockReset().mockResolvedValue([{ synthetic: true }])
  mocks.workspace.mockReset().mockResolvedValue({ entries: [], outcomes: [], release: { state: 'not_generated' } })
  mocks.release.mockReset().mockResolvedValue({ status: 'gate_blocked', modelTrainingAllowed: false, citationTrainingEligible: false })
  mocks.optIn.mockReset().mockResolvedValue({ state: 'granted', replayed: false, grantFingerprint: HASH_C })
  mocks.revoke.mockReset().mockResolvedValue({ state: 'revoked', replayed: false, grantFingerprint: HASH_C })
  mocks.review.mockReset().mockResolvedValue({ state: 'approved', replayed: false, reviewFingerprint: HASH_C })
})

afterEach(() => vi.unstubAllEnvs())

describe('site-learning owner route security boundary', () => {
  it('requires an authenticated owner before body parsing, owner mapping, repositories or learning calls', async () => {
    mocks.owner.mockRejectedValueOnce(createError({ statusCode: 401, statusMessage: 'Owner required.' }))
    await expect((await route(paths.optIn))(
      event('POST', '/api/content-operations/entries/11/site-learning-opt-in'),
    )).rejects.toMatchObject({ statusCode: 401 })
    expect(mocks.body).not.toHaveBeenCalled()
    expect(mocks.runtime).not.toHaveBeenCalled()
    expect(mocks.fetch).not.toHaveBeenCalled()
    expect(mocks.lineages).not.toHaveBeenCalled()
    expect(mocks.optIn).not.toHaveBeenCalled()
    expectNoRepositories()
    expectPrivateHeaders()
  })

  it.each([undefined, 'https://attacker.invalid'])('rejects missing or foreign Origin before parsing any POST body (%s)', async origin => {
    mocks.requestHeader.mockImplementation((_event, name) => name === 'origin' ? origin : 'same-origin')
    await expect((await route(paths.release))(
      event('POST', '/api/content-operations/site-learning/release'),
    )).rejects.toMatchObject({ statusCode: 403 })
    expect(mocks.body).not.toHaveBeenCalled()
    expectNoRepositories()
    expect(mocks.release).not.toHaveBeenCalled()
  })

  it('rejects cross-site fetch metadata and an invalid configured origin before body or repository work', async () => {
    mocks.requestHeader.mockImplementation((_event, name) => name === 'origin' ? 'https://owner.discoverystack.test' : 'cross-site')
    await expect((await route(paths.release))(
      event('POST', '/api/content-operations/site-learning/release'),
    )).rejects.toMatchObject({ statusCode: 403 })
    expect(mocks.body).not.toHaveBeenCalled()
    expectNoRepositories()

    vi.stubEnv('NUXT_DISCOVERYSTACK_PRIVATE_ORIGIN', 'https://owner.discoverystack.test/path')
    mocks.requestHeader.mockImplementation((_event, name) => name === 'origin' ? 'https://owner.discoverystack.test' : 'same-origin')
    await expect((await route(paths.release))(
      event('POST', '/api/content-operations/site-learning/release'),
    )).rejects.toMatchObject({ statusCode: 503 })
    expect(mocks.body).not.toHaveBeenCalled()
    expectNoRepositories()
  })

  it.each([
    { ...optInValue, ownerUserId: 100 }, { ...optInValue, customerEvidenceConfirmed: false },
    { ...optInValue, scopeConfirmed: false }, { ...optInValue, targetRowId: '22' },
    { ...optInValue, expectedConfirmationFingerprint: 'not-a-hash' }, { ...optInValue, authorizationId: 0 },
    { ...optInValue, unexpectedAuthority: 'synthetic' },
  ])('rejects malformed or extra opt-in authority before repository construction', async body => {
    mocks.body.mockResolvedValue(body)
    await expect((await route(paths.optIn))(
      event('POST', '/api/content-operations/entries/11/site-learning-opt-in'),
    )).rejects.toMatchObject({ statusCode: 422 })
    expectNoRepositories()
    expect(mocks.optIn).not.toHaveBeenCalled()
  })

  it.each([
    { ...revokeValue, customerConfirmed: true }, { ...revokeValue, confirmed: false },
    { ...revokeValue, expectedGrantFingerprint: 'bad' }, { ...revokeValue, targetRowId: 0 },
  ])('rejects malformed or extra revoke authority before repository construction', async body => {
    mocks.body.mockResolvedValue(body)
    await expect((await route(paths.revoke))(
      event('POST', '/api/content-operations/entries/11/site-learning-revoke'),
    )).rejects.toMatchObject({ statusCode: 422 })
    expectNoRepositories()
    expect(mocks.revoke).not.toHaveBeenCalled()
  })

  it.each([
    { ...reviewValue, ownerUserId: 41 }, { ...reviewValue, decision: 'skip' },
    { ...reviewValue, piiReviewed: false }, { ...reviewValue, limitationsUnderstood: false },
    { ...reviewValue, extra: 'field' },
  ])('rejects malformed outcome review requests before repository construction', async body => {
    mocks.body.mockResolvedValue(body)
    await expect((await route(paths.review))(
      event('POST', '/api/content-operations/site-learning/outcomes/55/review'),
    )).rejects.toMatchObject({ statusCode: 422 })
    expectNoRepositories()
    expect(mocks.review).not.toHaveBeenCalled()
  })

  it.each([
    ['opt-in', paths.optIn, '/api/content-operations/entries/11/site-learning-opt-in', () => mocks.router.mockReturnValue('0')],
    ['revoke', paths.revoke, '/api/content-operations/entries/11/site-learning-revoke', () => mocks.router.mockReturnValue('0')],
    ['outcome review', paths.review, '/api/content-operations/site-learning/outcomes/55/review', () => mocks.router.mockReturnValue('01')],
  ])('rejects invalid route identity for %s before body and storage setup', async (_name, path, pathname, configure) => {
    configure()
    await expect((await route(path))(event('POST', pathname))).rejects.toMatchObject({ statusCode: 422 })
    expect(mocks.body).not.toHaveBeenCalled()
    expectNoRepositories()
  })

  it('uses bounded bodies and sanitizes parser failures without initializing persistence', async () => {
    mocks.body.mockRejectedValue(createError({ statusCode: 413, statusMessage: 'synthetic-secret-parser-detail' }))
    const response = await (await route(paths.optIn))(
      event('POST', '/api/content-operations/entries/11/site-learning-opt-in'),
    ).catch(error => error)
    expect(response).toMatchObject({ statusCode: 413, statusMessage: '網站成效資料授權目前無法核實；沒有收集或訓練資料。' })
    expect(JSON.stringify(response)).not.toContain('synthetic-secret-parser-detail')
    expect(mocks.body).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ maxBytes: 2048 }))
    expectNoRepositories()
  })

  it('reads a private safe-summary workspace without remote lineages or fetch construction', async () => {
    await expect((await route(paths.workspace))(
      event('GET', '/api/content-operations/site-learning/workspace'),
    )).resolves.toEqual({ entries: [], outcomes: [], release: { state: 'not_generated' } })
    expectPrivateHeaders()
    expect(mocks.workspace).toHaveBeenCalledWith(41, expect.objectContaining({ operations: { syntheticRepository: 'operations' } }))
    expect(mocks.body).not.toHaveBeenCalled()
    expect(mocks.runtime).not.toHaveBeenCalled()
    expect(mocks.fetch).not.toHaveBeenCalled()
    expect(mocks.weekly).not.toHaveBeenCalled()
    expect(mocks.lineages).not.toHaveBeenCalled()
  })

  it.each([{}, { confirmed: true }])('builds a release only after explicit owner POST confirmation: %j', async body => {
    mocks.body.mockResolvedValue(body)
    const result = await (await route(paths.release))(
      event('POST', '/api/content-operations/site-learning/release'),
    )
    expect(result).toEqual({ status: 'gate_blocked', modelTrainingAllowed: false, citationTrainingEligible: false })
    expect(mocks.body).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ maxBytes: 512 }))
    expect(mocks.release).toHaveBeenCalledWith(41, expect.objectContaining({ learning: expect.anything() }))
    expectPrivateHeaders()
  })

  it.each([{ confirmed: false }, { release: true }, { confirmed: true, ownerUserId: 41 }])('does not release on malformed or extra release body %j', async body => {
    mocks.body.mockResolvedValue(body)
    await expect((await route(paths.release))(
      event('POST', '/api/content-operations/site-learning/release'),
    )).rejects.toMatchObject({ statusCode: 422 })
    expectNoRepositories()
    expect(mocks.release).not.toHaveBeenCalled()
  })

  it('maps opt-in solely from the owner session and keeps lineage/fetch resolution lazy and bounded', async () => {
    mocks.body.mockResolvedValue(optInValue)
    await expect((await route(paths.optIn))(
      event('POST', '/api/content-operations/entries/11/site-learning-opt-in'),
    )).resolves.toEqual({ state: 'granted', replayed: false, grantFingerprint: HASH_C })
    expectPrivateHeaders()
    expect(mocks.ownerId).toHaveBeenCalledWith('synthetic-owner')
    expect(mocks.optIn).toHaveBeenCalledWith(41, 11, optInValue, expect.objectContaining({ operations: expect.anything(), learning: expect.anything() }))
    const options = mocks.optIn.mock.calls[0]?.[3]
    expect(mocks.runtime).not.toHaveBeenCalled()
    expect(mocks.fetch).not.toHaveBeenCalled()
    expect(mocks.weekly).not.toHaveBeenCalled()
    await expect(options.resolveSiteLineages(41, 11, { fresh: true })).resolves.toEqual([{ synthetic: true }])
    expect(mocks.runtime).toHaveBeenCalledTimes(1)
    expect(mocks.fetch).toHaveBeenCalledWith({ maxResponseBodyBytes: 4096 })
    expect(mocks.weekly).not.toHaveBeenCalled()
    expect(mocks.lineages).toHaveBeenCalledWith(41, 11, expect.objectContaining({ fresh: true, repository: expect.anything(), weeklyRepositoryFactory: mocks.weekly }))
  })

  it('allows an explicit revoke without resolving current site state and redacts service failures', async () => {
    mocks.body.mockResolvedValue(revokeValue)
    mocks.revoke.mockRejectedValueOnce(new Error('synthetic-secret-database-detail'))
    const response = await (await route(paths.revoke))(
      event('POST', '/api/content-operations/entries/11/site-learning-revoke'),
    ).catch(error => error)
    expect(response).toMatchObject({ statusCode: 503, statusMessage: '撤銷網站成效資料授權目前無法完成；既有資料不會被宣稱已刪除。' })
    expect(JSON.stringify(response)).not.toContain('synthetic-secret-database-detail')
    expect(mocks.revoke).toHaveBeenCalledWith(41, 11, revokeValue, expect.objectContaining({ operations: expect.anything() }))
    expect(mocks.runtime).not.toHaveBeenCalled()
    expect(mocks.fetch).not.toHaveBeenCalled()
    expect(mocks.lineages).not.toHaveBeenCalled()
  })

  it('passes only the exact guarded review fields and uses the numeric owner/outcome identities', async () => {
    mocks.body.mockResolvedValue(reviewValue)
    mocks.router.mockReturnValue('55')
    await expect((await route(paths.review))(
      event('POST', '/api/content-operations/site-learning/outcomes/55/review'),
    )).resolves.toEqual({ state: 'approved', replayed: false, reviewFingerprint: HASH_C })
    expect(mocks.review).toHaveBeenCalledWith(41, 55, reviewValue, expect.objectContaining({ learning: expect.anything() }))
  })
})

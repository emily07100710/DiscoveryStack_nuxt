import { ServerResponse } from 'node:http'
import { PassThrough } from 'node:stream'
import { createEvent } from 'h3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const routeMocks = vi.hoisted(() => {
  class MockKnowledgeConsumerBindingError extends Error {
    constructor(readonly code: string) { super('mock binding error') }
  }
  class MockDrizzleKnowledgeConsumerBindingRepository {
    constructor() { routeMocks.repositoryCreated() }
    readOnly(work: (tx: unknown) => Promise<unknown>) { return routeMocks.readOnly(work) }
  }
  return {
    requireKnowledgeOwner: vi.fn(),
    setKnowledgePrivateApiHeaders: vi.fn(),
    parseKnowledgeConsumerCatalogQuery: vi.fn(),
    actualParseKnowledgeConsumerCatalogQuery: null as null | ((input: unknown) => { kind: string; afterId: number }),
    readKnowledgeConsumerCatalog: vi.fn(),
    readOnly: vi.fn(),
    repositoryCreated: vi.fn(),
    KnowledgeConsumerBindingError: MockKnowledgeConsumerBindingError,
    KnowledgeRevisionError: class MockKnowledgeRevisionError extends Error { constructor(readonly code: string) { super('mock revision error') } },
    DrizzleKnowledgeConsumerBindingRepository: MockDrizzleKnowledgeConsumerBindingRepository,
  }
})

vi.mock('../server/api/knowledge/_helpers', () => ({
  requireKnowledgeOwner: routeMocks.requireKnowledgeOwner,
  setKnowledgePrivateApiHeaders: routeMocks.setKnowledgePrivateApiHeaders,
}))
vi.mock('../server/knowledge/consumer-bindings-drizzle', () => ({ DrizzleKnowledgeConsumerBindingRepository: routeMocks.DrizzleKnowledgeConsumerBindingRepository }))
vi.mock('../server/knowledge/consumer-catalog', async importOriginal => {
  const actual = await importOriginal<typeof import('../server/knowledge/consumer-catalog')>()
  routeMocks.actualParseKnowledgeConsumerCatalogQuery = actual.parseKnowledgeConsumerCatalogQuery
  return { ...actual, parseKnowledgeConsumerCatalogQuery: routeMocks.parseKnowledgeConsumerCatalogQuery, readKnowledgeConsumerCatalog: routeMocks.readKnowledgeConsumerCatalog }
})
vi.mock('../server/knowledge/consumer-binding-types', () => ({ KnowledgeConsumerBindingError: routeMocks.KnowledgeConsumerBindingError }))
vi.mock('../server/knowledge/revision-types', () => ({ KnowledgeRevisionError: routeMocks.KnowledgeRevisionError }))

const OWNER = 57
const allocated: Array<{ req: PassThrough; res: ServerResponse }> = []
function event(url: string) {
  const req = Object.assign(new PassThrough(), { method: 'GET', url, headers: { host: 'owner.example.test' } })
  const res = new ServerResponse(req as never)
  allocated.push({ req, res })
  return createEvent(req as never, res)
}
async function handler() { return (await import('../server/api/knowledge/consumer-catalog.get')).default }
const catalog = { kind: 'geo_dataset', items: [{ id: 42 }], nextAfterId: null }

beforeEach(() => {
  routeMocks.requireKnowledgeOwner.mockReset().mockResolvedValue({ ownerUserId: OWNER, openId: 'trusted-session-subject' })
  routeMocks.setKnowledgePrivateApiHeaders.mockReset()
  routeMocks.parseKnowledgeConsumerCatalogQuery.mockReset().mockImplementation((input: unknown) => routeMocks.actualParseKnowledgeConsumerCatalogQuery!(input))
  routeMocks.readKnowledgeConsumerCatalog.mockReset().mockResolvedValue(catalog)
  routeMocks.readOnly.mockReset().mockImplementation(async (work: (tx: unknown) => Promise<unknown>) => work({ native: 'transaction' }))
  routeMocks.repositoryCreated.mockReset()
})
afterEach(() => { for (const { req, res } of allocated.splice(0)) { res.destroy(); req.destroy() } })

describe('owner-private knowledge consumer catalog GET route', () => {
  it.each([401, 403, 503])('sets private headers and preserves authorization status %i before query validation or storage', async statusCode => {
    routeMocks.requireKnowledgeOwner.mockRejectedValueOnce(Object.assign(new Error('SECRET AUTH DETAIL'), { statusCode }))
    const load = await handler()
    const req = event('/api/knowledge/consumer-catalog?kind=geo_dataset&ownerUserId=999')
    await expect(load(req)).rejects.toMatchObject({ statusCode, statusMessage: 'Knowledge owner authorization could not be verified.' })
    expect(routeMocks.setKnowledgePrivateApiHeaders).toHaveBeenCalledExactlyOnceWith(req)
    expect(routeMocks.parseKnowledgeConsumerCatalogQuery).not.toHaveBeenCalled()
    expect(routeMocks.repositoryCreated).not.toHaveBeenCalled()
  })

  it.each([
    ['missing kind', ''], ['unknown kind', '?kind=owner'], ['unknown key', '?kind=geo_dataset&ownerUserId=7'],
    ['array kind', '?kind=geo_dataset&kind=benchmark_prompt'], ['array cursor', '?kind=geo_dataset&afterId=1&afterId=2'],
    ['zero cursor', '?kind=geo_dataset&afterId=0'], ['noncanonical cursor', '?kind=geo_dataset&afterId=01'],
    ['overflow cursor', '?kind=geo_dataset&afterId=2147483648'],
  ])('rejects %s as 422 before constructing repository', async (_label, suffix) => {
    const load = await handler()
    await expect(load(event(`/api/knowledge/consumer-catalog${suffix}`))).rejects.toMatchObject({ statusCode: 422, statusMessage: 'Knowledge catalog read could not be completed.' })
    expect(routeMocks.repositoryCreated).not.toHaveBeenCalled()
    expect(routeMocks.readOnly).not.toHaveBeenCalled()
    expect(routeMocks.readKnowledgeConsumerCatalog).not.toHaveBeenCalled()
  })

  it('validates the query before constructing storage and passes the exact authenticated owner, raw query, and transaction', async () => {
    const load = await handler()
    const req = event('/api/knowledge/consumer-catalog?kind=benchmark_prompt&afterId=42')
    await expect(load(req)).resolves.toEqual({ status: 'ok', catalog })
    expect(routeMocks.setKnowledgePrivateApiHeaders).toHaveBeenCalledExactlyOnceWith(req)
    expect(routeMocks.parseKnowledgeConsumerCatalogQuery).toHaveBeenCalledOnce()
    expect(routeMocks.repositoryCreated).toHaveBeenCalledOnce()
    expect(routeMocks.readOnly).toHaveBeenCalledOnce()
    expect(routeMocks.readKnowledgeConsumerCatalog).toHaveBeenCalledExactlyOnceWith(OWNER, { kind: 'benchmark_prompt', afterId: '42' }, { native: 'transaction' })
    expect(routeMocks.parseKnowledgeConsumerCatalogQuery.mock.invocationCallOrder[0]).toBeLessThan(routeMocks.repositoryCreated.mock.invocationCallOrder[0]!)
  })

  it.each([['INVALID_INPUT', 422], ['NOT_FOUND', 409], ['CORRUPT_STATE', 409]])('maps catalog service error %s to static status %i', async (code, statusCode) => {
    routeMocks.readKnowledgeConsumerCatalog.mockRejectedValueOnce(new routeMocks.KnowledgeConsumerBindingError(String(code)))
    const load = await handler()
    await expect(load(event('/api/knowledge/consumer-catalog?kind=geo_dataset'))).rejects.toMatchObject({ statusCode, statusMessage: 'Knowledge catalog read could not be completed.' })
  })

  it.each([['INVALID_INPUT', 422], ['REVISION_CONFLICT', 409], ['CORRUPT_STATE', 409]])('maps revision error %s to static status %i', async (code, statusCode) => {
    routeMocks.readKnowledgeConsumerCatalog.mockRejectedValueOnce(new routeMocks.KnowledgeRevisionError(String(code)))
    const load = await handler()
    await expect(load(event('/api/knowledge/consumer-catalog?kind=geo_dataset'))).rejects.toMatchObject({ statusCode, statusMessage: 'Knowledge catalog read could not be completed.' })
  })

  it('maps unexpected storage failures to fixed 503 without exposing details', async () => {
    routeMocks.readKnowledgeConsumerCatalog.mockRejectedValueOnce(new Error('DATABASE PASSWORD PRIVATE'))
    const load = await handler()
    let thrown: unknown
    try { await load(event('/api/knowledge/consumer-catalog?kind=geo_dataset')) } catch (error) { thrown = error }
    expect(thrown).toMatchObject({ statusCode: 503, statusMessage: 'Knowledge catalog storage is unavailable.' })
    expect(String(thrown)).not.toContain('DATABASE PASSWORD PRIVATE')
  })

  it('performs no body read or mutation and passes the exact authenticated owner', async () => {
    const load = await handler()
    await load(event('/api/knowledge/consumer-catalog?kind=geo_dataset'))
    expect(routeMocks.readKnowledgeConsumerCatalog.mock.calls[0]?.[0]).toBe(OWNER)
    expect(routeMocks.readKnowledgeConsumerCatalog.mock.calls[0]).toHaveLength(3)
    expect(routeMocks.readOnly).toHaveBeenCalledOnce()
  })
})

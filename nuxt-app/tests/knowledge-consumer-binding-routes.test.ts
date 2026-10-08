import { ServerResponse } from 'node:http'
import { PassThrough } from 'node:stream'
import { createEvent } from 'h3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const routeMocks = vi.hoisted(() => {
  class MockKnowledgeConsumerBindingError extends Error {
    constructor(readonly code: string) { super('mock binding error') }
  }
  class MockKnowledgeRevisionError extends Error {
    constructor(readonly code: string) { super('mock revision error') }
  }
  class MockDrizzleKnowledgeConsumerBindingRepository {
    constructor() { routeMocks.repositoryCreated() }
    readOnly(work: (repository: unknown) => Promise<unknown>) { return routeMocks.readOnly(work) }
  }
  return {
    requireKnowledgeOwner: vi.fn(),
    setKnowledgePrivateApiHeaders: vi.fn(),
    readKnowledgeBody: vi.fn(),
    strictKeys: vi.fn((body: Record<string, unknown>, allowed: readonly string[]) => {
      for (const key of Object.keys(body)) if (!allowed.includes(key)) throw Object.assign(new Error(`Unknown request field: ${key}.`), { statusCode: 422 })
    }),
    mutateKnowledgeConsumerBinding: vi.fn(),
    readKnowledgeConsumerBindingWorkspace: vi.fn(),
    readOnly: vi.fn(),
    repositoryCreated: vi.fn(),
    KnowledgeConsumerBindingError: MockKnowledgeConsumerBindingError,
    KnowledgeRevisionError: MockKnowledgeRevisionError,
    DrizzleKnowledgeConsumerBindingRepository: MockDrizzleKnowledgeConsumerBindingRepository,
  }
})

vi.mock('../server/api/knowledge/_helpers', () => ({
  requireKnowledgeOwner: routeMocks.requireKnowledgeOwner,
  setKnowledgePrivateApiHeaders: routeMocks.setKnowledgePrivateApiHeaders,
  readKnowledgeBody: routeMocks.readKnowledgeBody,
  strictKeys: routeMocks.strictKeys,
}))
vi.mock('../server/knowledge/consumer-bindings-drizzle', () => ({ DrizzleKnowledgeConsumerBindingRepository: routeMocks.DrizzleKnowledgeConsumerBindingRepository }))
vi.mock('../server/knowledge/consumer-bindings', () => ({
  mutateKnowledgeConsumerBinding: routeMocks.mutateKnowledgeConsumerBinding,
  readKnowledgeConsumerBindingWorkspace: routeMocks.readKnowledgeConsumerBindingWorkspace,
}))
vi.mock('../server/knowledge/consumer-binding-types', () => ({ KnowledgeConsumerBindingError: routeMocks.KnowledgeConsumerBindingError }))
vi.mock('../server/knowledge/revision-types', () => ({ KnowledgeRevisionError: routeMocks.KnowledgeRevisionError }))

const OWNER = 57
const PRIVATE_ORIGIN = 'https://owner.example.test'
const savedOrigin = process.env.NUXT_DISCOVERYSTACK_PRIVATE_ORIGIN
const allocated: Array<{ req: PassThrough; res: ServerResponse }> = []

function event(url: string, method: 'GET' | 'POST', headers: Record<string, string> = {}) {
  const req = Object.assign(new PassThrough(), { method, url, headers: { host: 'owner.example.test', ...headers } })
  const res = new ServerResponse(req as never)
  allocated.push({ req, res })
  return createEvent(req as never, res)
}

async function getHandler() { return (await import('../server/api/knowledge/consumer-bindings.get')).default }
async function postHandler() { return (await import('../server/api/knowledge/consumer-bindings.post')).default }

function resetMocks() {
  routeMocks.requireKnowledgeOwner.mockReset()
  routeMocks.setKnowledgePrivateApiHeaders.mockReset()
  routeMocks.readKnowledgeBody.mockReset()
  routeMocks.strictKeys.mockReset()
  routeMocks.strictKeys.mockImplementation((body: Record<string, unknown>, allowed: readonly string[]) => {
    for (const key of Object.keys(body)) if (!allowed.includes(key)) throw Object.assign(new Error(`Unknown request field: ${key}.`), { statusCode: 422 })
  })
  routeMocks.mutateKnowledgeConsumerBinding.mockReset()
  routeMocks.readKnowledgeConsumerBindingWorkspace.mockReset()
  routeMocks.readOnly.mockReset()
  routeMocks.repositoryCreated.mockReset()
  routeMocks.requireKnowledgeOwner.mockResolvedValue({ ownerUserId: OWNER, openId: 'trusted-session-subject' })
  routeMocks.readKnowledgeBody.mockResolvedValue({ consumerKind: 'geo_dataset', consumerId: 9, subjectKind: 'entity', subjectId: 4 })
  routeMocks.mutateKnowledgeConsumerBinding.mockResolvedValue({ binding: { id: 1 }, replayed: false })
  routeMocks.readKnowledgeConsumerBindingWorkspace.mockResolvedValue({
    coverage: [{
      category: 'dataset', state: 'complete', scope: 'owner_private_inventory', limitationCodes: ['secondary_only'],
      consumers: [
        { ownerUserId: OWNER, consumerKind: 'geo_dataset', consumerId: 9, promptText: 'PRIVATE PROMPT CONTENT', idempotencyKey: 'private-idempotency-key', rawSnapshot: { secret: 'PRIVATE SNAPSHOT' } },
        { ownerUserId: OWNER, consumerKind: 'geo_dataset', consumerId: 10, dependencyGraph: { ownerUserId: OWNER, promptText: 'PRIVATE DEPENDENCY' } },
      ],
    }],
    bindings: [],
  })
  routeMocks.readOnly.mockImplementation(async (work: (repository: unknown) => Promise<unknown>) => work({ native: 'repository' }))
}

beforeEach(() => {
  process.env.NUXT_DISCOVERYSTACK_PRIVATE_ORIGIN = PRIVATE_ORIGIN
  resetMocks()
})

afterEach(() => {
  if (savedOrigin === undefined) delete process.env.NUXT_DISCOVERYSTACK_PRIVATE_ORIGIN
  else process.env.NUXT_DISCOVERYSTACK_PRIVATE_ORIGIN = savedOrigin
  for (const { req, res } of allocated.splice(0)) { res.destroy(); req.destroy() }
})

describe('Knowledge consumer binding GET route', () => {
  it.each([401, 403, 503])('sets private headers and preserves authorization status %i before query/storage work', async statusCode => {
    routeMocks.requireKnowledgeOwner.mockRejectedValueOnce(Object.assign(new Error('SECRET AUTH DETAIL'), { statusCode }))
    const load = await getHandler()
    const req = event('/api/knowledge/consumer-bindings?ownerUserId=999', 'GET')
    await expect(load(req)).rejects.toMatchObject({ statusCode, statusMessage: 'Knowledge owner authorization could not be verified.' })
    expect(routeMocks.setKnowledgePrivateApiHeaders).toHaveBeenCalledExactlyOnceWith(req)
    expect(routeMocks.readOnly).not.toHaveBeenCalled()
    expect(routeMocks.readKnowledgeConsumerBindingWorkspace).not.toHaveBeenCalled()
    expect(routeMocks.repositoryCreated).not.toHaveBeenCalled()
  })

  it('rejects all query parameters and performs no database read', async () => {
    const load = await getHandler()
    const req = event('/api/knowledge/consumer-bindings?cursor=1', 'GET')
    await expect(load(req)).rejects.toMatchObject({ statusCode: 422, statusMessage: 'Knowledge binding read could not be completed.' })
    expect(routeMocks.repositoryCreated).not.toHaveBeenCalled()
    expect(routeMocks.readOnly).not.toHaveBeenCalled()
    expect(routeMocks.readKnowledgeConsumerBindingWorkspace).not.toHaveBeenCalled()
  })

  it('reads through one private read-only repository hook and performs no mutation or body read', async () => {
    const load = await getHandler()
    const req = event('/api/knowledge/consumer-bindings', 'GET')
    const response = await load(req)
    expect(response).toEqual({
      status: 'ok',
      coverage: [{ category: 'dataset', state: 'complete', scope: 'owner_private_inventory', limitationCodes: ['secondary_only'], registeredConsumerCount: 2 }],
      bindings: [], exhaustive: false, automaticPublication: false, automaticTrainingAdmission: false, productionActivation: false,
    })
    const responseJson = JSON.stringify(response)
    expect(responseJson).not.toContain('ownerUserId')
    expect(responseJson).not.toContain('promptText')
    expect(responseJson).not.toContain('idempotencyKey')
    expect(responseJson).not.toContain('rawSnapshot')
    expect(responseJson).not.toContain('PRIVATE PROMPT CONTENT')
    expect(responseJson).not.toContain('PRIVATE SNAPSHOT')
    expect(routeMocks.setKnowledgePrivateApiHeaders).toHaveBeenCalledExactlyOnceWith(req)
    expect(routeMocks.repositoryCreated).toHaveBeenCalledOnce()
    expect(routeMocks.readOnly).toHaveBeenCalledOnce()
    const [owner, repository] = routeMocks.readKnowledgeConsumerBindingWorkspace.mock.calls[0] as [number, unknown]
    expect(owner).toBe(OWNER)
    expect(repository).toEqual({ native: 'repository' })
    expect(routeMocks.readKnowledgeBody).not.toHaveBeenCalled()
    expect(routeMocks.mutateKnowledgeConsumerBinding).not.toHaveBeenCalled()
  })

  it.each([
    ['INVALID_INPUT', 422], ['NOT_FOUND', 409], ['CORRUPT_STATE', 409],
  ])('maps binding read failure %s to static status %i', async (code, statusCode) => {
    routeMocks.readKnowledgeConsumerBindingWorkspace.mockRejectedValueOnce(new routeMocks.KnowledgeConsumerBindingError(String(code)))
    const load = await getHandler()
    await expect(load(event('/api/knowledge/consumer-bindings', 'GET'))).rejects.toMatchObject({ statusCode, statusMessage: 'Knowledge binding read could not be completed.' })
  })

  it('maps unexpected storage failures to a fixed 503 without exposing details', async () => {
    routeMocks.readKnowledgeConsumerBindingWorkspace.mockRejectedValueOnce(new Error('DATABASE PASSWORD PRIVATE'))
    const load = await getHandler()
    let thrown: unknown
    try { await load(event('/api/knowledge/consumer-bindings', 'GET')) } catch (error) { thrown = error }
    expect(thrown).toMatchObject({ statusCode: 503, statusMessage: 'Knowledge binding storage is unavailable.' })
    expect(String(thrown)).not.toContain('DATABASE PASSWORD PRIVATE')
  })
})

describe('Knowledge consumer binding POST route', () => {
  it.each([401, 403, 503])('sets private headers and preserves authorization status %i before reading the body', async statusCode => {
    routeMocks.requireKnowledgeOwner.mockRejectedValueOnce(Object.assign(new Error('SECRET AUTH DETAIL'), { statusCode }))
    const save = await postHandler()
    const req = event('/api/knowledge/consumer-bindings', 'POST', { origin: PRIVATE_ORIGIN })
    await expect(save(req)).rejects.toMatchObject({ statusCode, statusMessage: 'Knowledge owner authorization could not be verified.' })
    expect(routeMocks.setKnowledgePrivateApiHeaders).toHaveBeenCalledExactlyOnceWith(req)
    expect(routeMocks.readKnowledgeBody).not.toHaveBeenCalled()
    expect(routeMocks.mutateKnowledgeConsumerBinding).not.toHaveBeenCalled()
    expect(routeMocks.repositoryCreated).not.toHaveBeenCalled()
  })

  it.each([
    ['missing Origin', {}],
    ['wrong Origin', { origin: 'https://attacker.example.test' }],
    ['cross-site Fetch Metadata', { origin: PRIVATE_ORIGIN, 'sec-fetch-site': 'cross-site' }],
  ])('rejects %s before reading body or constructing storage', async (_label, headers) => {
    const save = await postHandler()
    await expect(save(event('/api/knowledge/consumer-bindings', 'POST', headers))).rejects.toMatchObject({ statusCode: 403, statusMessage: 'Knowledge binding request could not be completed.' })
    expect(routeMocks.readKnowledgeBody).not.toHaveBeenCalled()
    expect(routeMocks.mutateKnowledgeConsumerBinding).not.toHaveBeenCalled()
    expect(routeMocks.repositoryCreated).not.toHaveBeenCalled()
  })

  it('accepts exact same-origin input and passes only the authenticated owner to mutation', async () => {
    const save = await postHandler()
    const body = { consumerKind: 'geo_dataset', consumerId: 9, subjectKind: 'entity', subjectId: 4, operation: 'bind', expectedRevisionFingerprint: 'a'.repeat(64), expectedBindingFingerprint: null, idempotencyKey: 'route-bind-0001' }
    routeMocks.readKnowledgeBody.mockResolvedValueOnce(body)
    const req = event('/api/knowledge/consumer-bindings', 'POST', { origin: PRIVATE_ORIGIN, 'sec-fetch-site': 'same-origin' })
    await expect(save(req)).resolves.toEqual({ status: 'ok', value: { binding: { id: 1 }, replayed: false } })
    expect(routeMocks.setKnowledgePrivateApiHeaders).toHaveBeenCalledExactlyOnceWith(req)
    expect(routeMocks.readKnowledgeBody).toHaveBeenCalledExactlyOnceWith(req)
    expect(routeMocks.repositoryCreated).toHaveBeenCalledOnce()
    expect(routeMocks.mutateKnowledgeConsumerBinding).toHaveBeenCalledOnce()
    expect(routeMocks.mutateKnowledgeConsumerBinding.mock.calls[0]).toEqual([OWNER, body, expect.any(routeMocks.DrizzleKnowledgeConsumerBindingRepository)])
    expect(routeMocks.requireKnowledgeOwner.mock.invocationCallOrder[0]).toBeLessThan(routeMocks.readKnowledgeBody.mock.invocationCallOrder[0]!)
    expect(routeMocks.readKnowledgeBody.mock.invocationCallOrder[0]).toBeLessThan(routeMocks.mutateKnowledgeConsumerBinding.mock.invocationCallOrder[0]!)
  })

  it.each(['ownerUserId', 'consumerVersion', 'promptText'])('rejects unknown authoritative field %s before repository construction or mutation', async field => {
    routeMocks.readKnowledgeBody.mockResolvedValueOnce({ consumerKind: 'geo_dataset', consumerId: 9, subjectKind: 'entity', subjectId: 4, operation: 'bind', expectedRevisionFingerprint: 'a'.repeat(64), expectedBindingFingerprint: null, idempotencyKey: 'route-bind-0001', [field]: 'PRIVATE UNKNOWN VALUE' })
    const save = await postHandler()
    let thrown: unknown
    try { await save(event('/api/knowledge/consumer-bindings', 'POST', { origin: PRIVATE_ORIGIN })) } catch (error) { thrown = error }
    expect(thrown).toMatchObject({ statusCode: 422, statusMessage: 'Knowledge binding request could not be completed.' })
    expect(String(thrown)).not.toContain(field)
    expect(String(thrown)).not.toContain('PRIVATE UNKNOWN VALUE')
    expect(routeMocks.strictKeys).toHaveBeenCalledOnce()
    expect(routeMocks.mutateKnowledgeConsumerBinding).not.toHaveBeenCalled()
    expect(routeMocks.repositoryCreated).not.toHaveBeenCalled()
  })

  it('maps oversized-body failures to a fixed 413 without echoing body or parser details', async () => {
    routeMocks.readKnowledgeBody.mockRejectedValueOnce(Object.assign(new Error('SECRET REQUEST BODY'), { statusCode: 413, statusMessage: 'Request body exceeds the bounded knowledge limit.' }))
    const save = await postHandler()
    let thrown: unknown
    try { await save(event('/api/knowledge/consumer-bindings', 'POST', { origin: PRIVATE_ORIGIN })) } catch (error) { thrown = error }
    expect(thrown).toMatchObject({ statusCode: 413, statusMessage: 'Knowledge binding request could not be completed.' })
    expect(String(thrown)).not.toContain('SECRET REQUEST BODY')
    expect(routeMocks.mutateKnowledgeConsumerBinding).not.toHaveBeenCalled()
  })

  it.each([
    ['INVALID_INPUT', 422], ['NOT_FOUND', 404], ['CONFLICT', 409], ['CORRUPT_STATE', 409],
  ])('maps binding service failure %s to static status %i', async (code, statusCode) => {
    routeMocks.mutateKnowledgeConsumerBinding.mockRejectedValueOnce(new routeMocks.KnowledgeConsumerBindingError(String(code)))
    const save = await postHandler()
    await expect(save(event('/api/knowledge/consumer-bindings', 'POST', { origin: PRIVATE_ORIGIN }))).rejects.toMatchObject({ statusCode, statusMessage: 'Knowledge binding request could not be completed.' })
  })

  it('maps storage failures to a fixed 503 without exposing provider or database details', async () => {
    routeMocks.mutateKnowledgeConsumerBinding.mockRejectedValueOnce(new Error('DATABASE URL SECRET'))
    const save = await postHandler()
    let thrown: unknown
    try { await save(event('/api/knowledge/consumer-bindings', 'POST', { origin: PRIVATE_ORIGIN })) } catch (error) { thrown = error }
    expect(thrown).toMatchObject({ statusCode: 503, statusMessage: 'Knowledge binding storage is unavailable.' })
    expect(String(thrown)).not.toContain('DATABASE URL SECRET')
  })
})

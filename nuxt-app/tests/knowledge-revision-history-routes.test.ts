import { createEvent } from 'h3'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const routeMocks = vi.hoisted(() => {
  class MockKnowledgeRevisionError extends Error {
    constructor(readonly code: string, message = 'mock revision error') { super(message) }
  }
  class MockDrizzleKnowledgeRepository {}
  return {
    requireKnowledgeOwner: vi.fn(),
    setKnowledgePrivateApiHeaders: vi.fn(),
    getHistory: vi.fn(),
    KnowledgeRevisionError: MockKnowledgeRevisionError,
    DrizzleKnowledgeRepository: MockDrizzleKnowledgeRepository,
  }
})

vi.mock('../server/api/knowledge/_helpers', () => ({
  requireKnowledgeOwner: routeMocks.requireKnowledgeOwner,
  setKnowledgePrivateApiHeaders: routeMocks.setKnowledgePrivateApiHeaders,
}))
vi.mock('../server/knowledge/revision-history', () => ({ getKnowledgeRevisionHistory: routeMocks.getHistory }))
vi.mock('../server/knowledge/revision-types', () => ({ KnowledgeRevisionError: routeMocks.KnowledgeRevisionError }))
vi.mock('../server/knowledge/repository-drizzle', () => ({ DrizzleKnowledgeRepository: routeMocks.DrizzleKnowledgeRepository }))

function eventWithUrl(url: string) { return createEvent({ url } as never, {} as never) }
const subjectHistory = {
  subject: { kind: 'entity', id: 7 }, items: [], nextCursor: null, historyScope: 'recorded_mutations_only',
  rawSnapshotIncluded: false, automaticPublication: false, productionActivation: false, automaticTrainingAdmission: false,
}

describe('owner-private knowledge revision history GET route', () => {
  beforeEach(() => {
    routeMocks.requireKnowledgeOwner.mockReset()
    routeMocks.setKnowledgePrivateApiHeaders.mockReset()
    routeMocks.getHistory.mockReset()
  })

  async function handler() { return (await import('../server/api/knowledge/revision-history.get')).default }

  it('sets private headers and authenticates before inspecting untrusted query parameters', async () => {
    routeMocks.requireKnowledgeOwner.mockRejectedValueOnce(Object.assign(new Error('secret auth detail'), { statusCode: 401 }))
    const load = await handler()
    const event = eventWithUrl('/api/knowledge/revision-history?kind=entity&id=7&ownerUserId=22')
    await expect(load(event)).rejects.toMatchObject({ statusCode: 401, statusMessage: 'Knowledge owner authorization could not be verified.' })
    expect(routeMocks.setKnowledgePrivateApiHeaders).toHaveBeenCalledWith(event)
    expect(routeMocks.getHistory).not.toHaveBeenCalled()
  })

  it('rejects unknown query keys without consulting history storage', async () => {
    routeMocks.requireKnowledgeOwner.mockResolvedValue({ ownerUserId: 17, openId: 'opaque' })
    const load = await handler()
    await expect(load(eventWithUrl('/api/knowledge/revision-history?kind=entity&id=7&snapshot=true'))).rejects.toMatchObject({ statusCode: 422 })
    expect(routeMocks.getHistory).not.toHaveBeenCalled()
  })

  it('passes only owner and strict query inputs, returning the safe history envelope', async () => {
    routeMocks.requireKnowledgeOwner.mockResolvedValue({ ownerUserId: 17, openId: 'opaque' })
    routeMocks.getHistory.mockResolvedValue(subjectHistory)
    const load = await handler()
    await expect(load(eventWithUrl('/api/knowledge/revision-history?kind=entity&id=7&cursor=opaque-cursor'))).resolves.toEqual({ status: 'success', history: subjectHistory })
    expect(routeMocks.getHistory).toHaveBeenCalledOnce()
    const [owner, input, repository] = routeMocks.getHistory.mock.calls[0] as [number, Record<string, unknown>, unknown]
    expect(owner).toBe(17)
    expect(input).toEqual({ kind: 'entity', id: '7', cursor: 'opaque-cursor' })
    expect(repository).toBeInstanceOf(routeMocks.DrizzleKnowledgeRepository)
  })

  it.each([
    ['INVALID_INPUT', 422], ['SUBJECT_NOT_FOUND', 404], ['CORRUPT_STATE', 409], ['REVISION_CONFLICT', 409], ['LIMIT_EXCEEDED', 409],
  ])('maps %s to status %i without leaking the service message', async (code, status) => {
    routeMocks.requireKnowledgeOwner.mockResolvedValue({ ownerUserId: 17, openId: 'opaque' })
    routeMocks.getHistory.mockRejectedValue(new routeMocks.KnowledgeRevisionError(String(code), 'PRIVATE SNAPSHOT CONTENT'))
    const load = await handler()
    await expect(load(eventWithUrl('/api/knowledge/revision-history?kind=entity&id=7'))).rejects.toMatchObject({ statusCode: status })
    try { await load(eventWithUrl('/api/knowledge/revision-history?kind=entity&id=7')) } catch (error) {
      expect(String((error as Error).message)).not.toContain('PRIVATE SNAPSHOT CONTENT')
    }
  })

  it('maps unexpected repository errors to a static 503', async () => {
    routeMocks.requireKnowledgeOwner.mockResolvedValue({ ownerUserId: 17, openId: 'opaque' })
    routeMocks.getHistory.mockRejectedValue(new Error('DATABASE SECRET'))
    const load = await handler()
    await expect(load(eventWithUrl('/api/knowledge/revision-history?kind=entity&id=7'))).rejects.toMatchObject({ statusCode: 503, statusMessage: 'Knowledge history is unavailable.' })
  })
})

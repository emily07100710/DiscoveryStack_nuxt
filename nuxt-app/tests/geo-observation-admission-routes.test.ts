import { createError, createEvent, defineEventHandler, type H3Event } from 'h3'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  owner: vi.fn(),
  privateHeaders: vi.fn(),
  readBody: vi.fn(),
  getDatabase: vi.fn(),
  workspace: vi.fn(),
  intake: vi.fn(),
  GeoAdmissionError: class GeoAdmissionError extends Error {
    constructor(readonly statusCode: number, readonly statusMessage: string, readonly code: string) { super(statusMessage) }
  },
}))

vi.mock('../server/api/geo-outcome-model/_helpers', () => ({
  requireGeoOutcomeOwner: mocks.owner,
  setGeoOutcomePrivateApiHeaders: mocks.privateHeaders,
  readGeoBody: mocks.readBody,
}))
vi.mock('../server/database', () => ({ getDatabase: mocks.getDatabase }))
vi.mock('../server/geo-outcome-model/admission', () => ({
  GeoAdmissionError: mocks.GeoAdmissionError,
  getGeoObservationAdmissionWorkspace: mocks.workspace,
  admitGeoObservation: mocks.intake,
}))

vi.stubGlobal('defineEventHandler', defineEventHandler)
vi.stubGlobal('createError', createError)

const database = { isolated: true }
function event(url: string, method = 'GET'): H3Event {
  const request = createEvent({ url } as never, {} as never)
  request.node.req.url = url
  request.node.req.method = method
  return request
}
async function loadWorkspace() { return (await import('../server/api/geo-outcome-model/admission/workspace.get')).default }
async function loadIntake() { return (await import('../server/api/geo-outcome-model/admission/intake.post')).default }

beforeEach(() => {
  vi.resetModules()
  mocks.owner.mockReset()
  mocks.privateHeaders.mockReset()
  mocks.readBody.mockReset()
  mocks.getDatabase.mockReset().mockReturnValue(database)
  mocks.workspace.mockReset()
  mocks.intake.mockReset()
})

describe('GEO observation admission owner routes', () => {
  it('authenticates before workspace query processing and never exposes cross-owner data', async () => {
    mocks.owner.mockRejectedValueOnce(createError({ statusCode: 401, statusMessage: 'Owner required.' }))
    const handler = await loadWorkspace()
    const request = event('/api/geo-outcome-model/admission/workspace?sourceRecordId=41&ownerUserId=999')
    await expect(handler(request)).rejects.toMatchObject({ statusCode: 401 })
    expect(mocks.privateHeaders).toHaveBeenCalledWith(request)
    expect(mocks.owner).toHaveBeenCalledOnce()
    expect(mocks.workspace).not.toHaveBeenCalled()
    expect(mocks.getDatabase).not.toHaveBeenCalled()
  })

  it('passes repeated query values to the workspace service only after owner auth', async () => {
    mocks.owner.mockResolvedValue({ ownerUserId: 42, openId: 'opaque-owner' })
    mocks.workspace.mockResolvedValue({ sources: [], nextCursor: null, selectedSource: null })
    const handler = await loadWorkspace()
    await expect(handler(event('/api/geo-outcome-model/admission/workspace?sourceRecordId=41&sourceRecordId=42')))
      .resolves.toEqual({ status: 'success', workspace: { sources: [], nextCursor: null, selectedSource: null } })
    expect(mocks.owner).toHaveBeenCalledOnce()
    expect(mocks.workspace).toHaveBeenCalledWith(42, { sourceRecordId: ['41', '42'] }, database)
  })

  it('fails closed with 503 when storage is not configured', async () => {
    mocks.owner.mockResolvedValue({ ownerUserId: 42, openId: 'opaque-owner' })
    mocks.getDatabase.mockReturnValue(null)
    const handler = await loadWorkspace()
    await expect(handler(event('/api/geo-outcome-model/admission/workspace')))
      .rejects.toMatchObject({ statusCode: 503, statusMessage: 'GEO admission workspace is unavailable.' })
    expect(mocks.workspace).not.toHaveBeenCalled()
  })

  it('checks owner authority before parsing or consuming intake body', async () => {
    mocks.owner.mockRejectedValueOnce(createError({ statusCode: 401, statusMessage: 'Owner required.' }))
    const handler = await loadIntake()
    const request = event('/api/geo-outcome-model/admission/intake', 'POST')
    await expect(handler(request)).rejects.toMatchObject({ statusCode: 401 })
    expect(mocks.privateHeaders).toHaveBeenCalledWith(request)
    expect(mocks.owner).toHaveBeenCalledOnce()
    expect(mocks.readBody).not.toHaveBeenCalled()
    expect(mocks.intake).not.toHaveBeenCalled()
    expect(mocks.getDatabase).not.toHaveBeenCalled()
  })

  it('passes only the authenticated owner and bounded intake command, returning non-authoritative status', async () => {
    mocks.owner.mockResolvedValue({ ownerUserId: 42, openId: 'opaque-owner' })
    mocks.readBody.mockResolvedValue({ idempotencyKey: 'admission-key-0001', sourceRecordId: 41, candidateUrl: 'https://public.example/page' })
    const pending = { status: 'success', observation: { sourceRecordId: 41, verificationStatus: 'unverified', trainingAdmission: false, productionActivation: false, replayed: false } }
    mocks.intake.mockResolvedValue(pending)
    const handler = await loadIntake()
    const request = event('/api/geo-outcome-model/admission/intake', 'POST')
    await expect(handler(request)).resolves.toEqual(pending)
    expect(mocks.readBody).toHaveBeenCalledWith(request, 64 * 1024)
    expect(mocks.intake).toHaveBeenCalledWith(42, { idempotencyKey: 'admission-key-0001', sourceRecordId: 41, candidateUrl: 'https://public.example/page' }, database)
    expect(mocks.intake.mock.calls[0]?.[0]).not.toBe(999)
    expect(pending.observation).toMatchObject({ trainingAdmission: false, productionActivation: false, verificationStatus: 'unverified' })
  })

  it('redacts unexpected storage/service errors rather than reflecting private details', async () => {
    mocks.owner.mockResolvedValue({ ownerUserId: 42, openId: 'opaque-owner' })
    mocks.readBody.mockResolvedValue({ idempotencyKey: 'admission-key-0001', sourceRecordId: 41, candidateUrl: 'https://public.example/page' })
    mocks.intake.mockRejectedValue(new Error('PRIVATE DATABASE URL and request payload'))
    const handler = await loadIntake()
    let mappedError: unknown
    try { await handler(event('/api/geo-outcome-model/admission/intake', 'POST')) } catch (error) { mappedError = error }
    expect(mappedError).toMatchObject({ statusCode: 503, statusMessage: 'GEO admission could not be completed.' })
    expect(String(mappedError)).not.toContain('PRIVATE DATABASE URL')
    expect(String(mappedError)).not.toContain('request payload')
  })

  it('redacts a real H3 error with private statusMessage and message fields', async () => {
    mocks.owner.mockResolvedValue({ ownerUserId: 42, openId: 'opaque-owner' })
    mocks.readBody.mockResolvedValue({ idempotencyKey: 'admission-key-0001', sourceRecordId: 41, candidateUrl: 'https://public.example/page' })
    mocks.intake.mockRejectedValue(createError({ statusCode: 503, statusMessage: 'PRIVATE STATUS', message: 'PRIVATE H3 MESSAGE' }))
    const handler = await loadIntake()
    let mappedError: unknown
    try { await handler(event('/api/geo-outcome-model/admission/intake', 'POST')) } catch (error) { mappedError = error }
    expect(mappedError).toMatchObject({ statusCode: 503, statusMessage: 'GEO admission could not be completed.' })
    expect(String(mappedError)).not.toContain('PRIVATE STATUS')
    expect(String(mappedError)).not.toContain('PRIVATE H3 MESSAGE')
  })

  it.each([
    [400, 'Request body must be an object.', 'invalid_body'],
    [409, 'Source or candidate authority is not currently eligible for admission.', 'authority_not_eligible'],
  ] as const)('preserves safe domain status %s without leaking service internals', async (statusCode, statusMessage, code) => {
    mocks.owner.mockResolvedValue({ ownerUserId: 42, openId: 'opaque-owner' })
    mocks.readBody.mockResolvedValue({ idempotencyKey: 'admission-key-0001', sourceRecordId: 41, candidateUrl: 'https://public.example/page' })
    mocks.intake.mockRejectedValue(new mocks.GeoAdmissionError(statusCode, statusMessage, code))
    const handler = await loadIntake()
    let mappedError: unknown
    try { await handler(event('/api/geo-outcome-model/admission/intake', 'POST')) } catch (error) { mappedError = error }
    expect(mappedError).toMatchObject({ statusCode, statusMessage })
    expect(String(mappedError)).not.toContain('PRIVATE')
  })
})

import { ServerResponse } from 'node:http'
import { PassThrough } from 'node:stream'
import { createError, createEvent, defineEventHandler, readBody, type H3Event } from 'h3'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MAX_REQUEST_BYTES, readKnowledgeBody } from '../server/api/knowledge/_helpers'

const RAW_BODY = Symbol.for('h3RawBody')
const PARSED_BODY = Symbol.for('h3ParsedBody')
const allocated: Array<{ req: PassThrough, res: ServerResponse }> = []

function fixture(headers: Record<string, string> = {}) {
  const req = Object.assign(new PassThrough(), {
    method: 'POST', url: '/api/knowledge/entities',
    headers: { 'content-type': 'application/json', ...headers },
  })
  const res = new ServerResponse(req as never)
  allocated.push({ req, res })
  return { req, res, event: createEvent(req as never, res) }
}

function expectTooLarge(promise: Promise<unknown>) {
  return expect(promise).rejects.toMatchObject({
    statusCode: 413,
    statusMessage: 'Request body exceeds the bounded knowledge limit.',
  })
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.clearAllMocks()
  for (const { req, res } of allocated.splice(0)) { res.destroy(); req.destroy() }
})

describe('bounded Knowledge API request bodies', () => {
  it('rejects an unended chunked request immediately at byte max + 1 and stops reading', async () => {
    const { req, event } = fixture({ 'transfer-encoding': 'chunked' })
    const rejected = expectTooLarge(readKnowledgeBody(event))
    req.write(Buffer.alloc(MAX_REQUEST_BYTES, 0x20))
    req.write(Buffer.from('x'))
    await rejected
    expect(req.writableEnded).toBe(false)
    expect(req.isPaused()).toBe(true)
    expect(req.listenerCount('data')).toBe(0)
  })

  it('measures UTF-8 bytes and accepts exactly 64 KiB while rejecting one extra byte', async () => {
    const exact = Buffer.from(`{"x":"${'測'.repeat(21_842)}ab"}`, 'utf8')
    expect(exact.byteLength).toBe(MAX_REQUEST_BYTES)
    const accepted = fixture({ 'transfer-encoding': 'chunked' })
    const pending = readKnowledgeBody(accepted.event)
    accepted.req.end(exact)
    await expect(pending).resolves.toEqual({ x: `${'測'.repeat(21_842)}ab` })

    const over = fixture({ 'transfer-encoding': 'chunked' })
    over.event._requestBody = Buffer.concat([exact, Buffer.from(' ')])
    await expectTooLarge(readKnowledgeBody(over.event))
  })

  it('does not trust a low Content-Length when the incoming stream is larger', async () => {
    const { req, event } = fixture({ 'content-length': '1' })
    const rejected = expectTooLarge(readKnowledgeBody(event))
    req.write(Buffer.from(`{"x":"${'x'.repeat(MAX_REQUEST_BYTES)}"}`))
    await rejected
    expect(req.writableEnded).toBe(false)
  })

  it('counts original raw whitespace, not just the parsed object', async () => {
    const { event, req } = fixture()
    Object.assign(req, { rawBody: Buffer.from('{}' + ' '.repeat(MAX_REQUEST_BYTES)) })
    await expectTooLarge(readKnowledgeBody(event))
  })

  it.each(['_requestBody', 'raw cache', 'rawBody', 'body', 'web Request'] as const)(
    'bounds a cached or adapter-provided %s source', async source => {
      const { event, req } = fixture()
      const bytes = Buffer.from(`{"x":"${'z'.repeat(MAX_REQUEST_BYTES)}"}`)
      if (source === '_requestBody') event._requestBody = bytes
      else if (source === 'raw cache') Object.assign(req, { [RAW_BODY]: Promise.resolve(bytes) })
      else if (source === 'web Request') event.web = { request: new Request('https://example.test', { method: 'POST', body: bytes }) } as typeof event.web
      else Object.assign(req, { [source]: bytes })
      await expectTooLarge(readKnowledgeBody(event))
    },
  )

  it('bounds parsed h3 cache values and preserves object-only validation', async () => {
    const parsed = fixture()
    Object.assign(parsed.req, { [PARSED_BODY]: { x: 'x'.repeat(MAX_REQUEST_BYTES) } })
    await expectTooLarge(readKnowledgeBody(parsed.event))

    for (const body of [undefined, null, [], 'text', 5]) {
      const { event, req } = fixture()
      if (body !== undefined) Object.assign(req, { [PARSED_BODY]: body })
      await expect(readKnowledgeBody(event)).rejects.toMatchObject({ statusCode: 400, statusMessage: 'Request body must be an object.' })
    }
    const { event, req } = fixture()
    Object.assign(req, { [PARSED_BODY]: { ok: true } })
    await expect(readKnowledgeBody(event)).resolves.toEqual({ ok: true })
  })

  it('preserves allowed methods and absent-body response semantics', async () => {
    const absent = fixture()
    await expect(readKnowledgeBody(absent.event)).rejects.toMatchObject({ statusCode: 400, statusMessage: 'Request body must be an object.' })
    const get = fixture()
    get.req.method = 'GET'
    get.event._requestBody = Buffer.from('{}')
    await expect(readKnowledgeBody(get.event)).rejects.toMatchObject({ statusCode: 405 })
  })

  it.each([
    ['malformed JSON', '{"secret-marker":'],
    ['array JSON', '[]'],
    ['string JSON', '"not-an-object"'],
    ['null JSON', 'null'],
  ])('returns 400 for raw %s without reflecting request content', async (_label, json) => {
    const { event, req } = fixture()
    Object.assign(req, { rawBody: Buffer.from(json) })
    let thrown: unknown
    try { await readKnowledgeBody(event) } catch (error) { thrown = error }
    expect(thrown).toMatchObject({ statusCode: 400 })
    const details = thrown as { statusMessage?: unknown, message?: unknown }
    expect([String(thrown), String(details.statusMessage), String(details.message)].join(' ')).not.toContain('secret-marker')
  })

  it('reads a streamed event body once and returns the same parsed cache on reread', async () => {
    const { req, event } = fixture({ 'transfer-encoding': 'chunked' })
    const pending = readKnowledgeBody(event)
    req.end(Buffer.from('{"entityType":"Brand","canonicalName":"Example"}'))
    await expect(pending).resolves.toEqual({ entityType: 'Brand', canonicalName: 'Example' })
    await expect(readKnowledgeBody(event)).resolves.toEqual({ entityType: 'Brand', canonicalName: 'Example' })
    expect(req.readableEnded).toBe(true)
  })
})

vi.mock('../server/api/knowledge/_helpers', async importOriginal => {
  const actual = await importOriginal<typeof import('../server/api/knowledge/_helpers')>()
  return {
    ...actual,
    requireKnowledgeOwner: vi.fn(),
    getKnowledgeService: vi.fn(),
  }
})

describe('Knowledge entity POST body boundary', () => {
  it('authenticates before reading body and never derives the owner from request JSON', async () => {
    vi.stubGlobal('defineEventHandler', defineEventHandler)
    vi.stubGlobal('createError', createError)
    const helpers = await import('../server/api/knowledge/_helpers')
    const requireOwner = vi.mocked(helpers.requireKnowledgeOwner)
    const getService = vi.mocked(helpers.getKnowledgeService)
    const createEntity = vi.fn()
    createEntity.mockResolvedValue({ status: 'ok', value: { entity: { id: 1 } } })
    getService.mockReturnValue({ createEntity } as never)
    requireOwner.mockRejectedValue(createError({ statusCode: 401, statusMessage: 'unauthorized' }))
    const route = (await import('../server/api/knowledge/entities/index.post')).default

    const unauthorized = fixture({ 'transfer-encoding': 'chunked' })
    const unauthorizedResult = route(unauthorized.event)
    const unauthRejected = expect(unauthorizedResult).rejects.toMatchObject({ statusCode: 401 })
    unauthorized.req.write(Buffer.from('{"ownerUserId":999}'))
    await unauthRejected
    expect(unauthorized.req.readableLength).toBeGreaterThan(0)
    expect(getService).not.toHaveBeenCalled()

    requireOwner.mockResolvedValue({ ownerUserId: 42, openId: 'trusted-owner' })
    const malformed = fixture({ 'transfer-encoding': 'chunked' })
    const preparse = readBody(malformed.event)
    malformed.req.end(Buffer.from('{}' + ' '.repeat(MAX_REQUEST_BYTES)))
    await expect(preparse).resolves.toEqual({})
    await expect(route(malformed.event)).rejects.toMatchObject({ statusCode: 413 })
    expect(getService).not.toHaveBeenCalled()
    expect(createEntity).not.toHaveBeenCalled()

    const bodyOwner = fixture()
    Object.assign(bodyOwner.req, { rawBody: Buffer.from(JSON.stringify({ ownerUserId: 999, entityType: 'Brand', canonicalName: 'Body owner is not authority' })) })
    await expect(route(bodyOwner.event)).rejects.toMatchObject({ statusCode: 422 })
    expect(getService).not.toHaveBeenCalled()
    expect(createEntity).not.toHaveBeenCalled()

    const valid = fixture()
    const allowedFields = { entityType: 'Brand', canonicalName: 'Authenticated owner entity' }
    Object.assign(valid.req, { rawBody: Buffer.from(JSON.stringify(allowedFields)) })
    await expect(route(valid.event)).resolves.toMatchObject({ status: 'success' })
    expect(getService).toHaveBeenCalledExactlyOnceWith(42)
    expect(createEntity).toHaveBeenCalledExactlyOnceWith(allowedFields)
    vi.unstubAllGlobals()
  })
})

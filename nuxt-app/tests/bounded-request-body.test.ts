import { ServerResponse } from 'node:http'
import { PassThrough, Readable } from 'node:stream'
import { createEvent, readBody, readRawBody, type H3Event } from 'h3'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { readBoundedRequestBody, readBoundedRequestRawBody } from '../server/utils/bounded-request-body'
import { readBoundedEditorBody } from '../server/managed-sites/page-editor/http'
import { MAX_REQUEST_BYTES, readInterventionBody } from '../server/intervention-loop/http'

// Only the body readers are under test. Authentication/database imports never execute.
vi.mock('../server/managed-sites/auth', () => ({ requireManagedSiteCustomer: vi.fn() }))
vi.mock('../server/audit/repository', () => ({ getOwnerDatabaseUserId: vi.fn() }))
vi.mock('../server/utils/auth', () => ({ requireOwner: vi.fn() }))

const RAW_BODY = Symbol.for('h3RawBody')
const PARSED_BODY = Symbol.for('h3ParsedBody')
const editorOptions = { maxBytes: 16, oversizedMessage: 'Editor request body is too large.', invalidMessage: 'Editor request body is not JSON-safe.', invalidStatusCode: 422 as const }
const editor413 = { statusCode: 413, statusMessage: editorOptions.oversizedMessage }
const allocated: Array<{ req: PassThrough; res: ServerResponse }> = []

function requestEvent(headers: Record<string, string> = {}) {
  const req = Object.assign(new PassThrough(), { method: 'POST', url: '/body-test', headers })
  const res = new ServerResponse(req as never)
  allocated.push({ req, res })
  return { req, res, event: createEvent(req as never, res) }
}
function materialEvent(body: unknown, contentType = 'application/json') {
  const fixture = requestEvent({ 'content-type': contentType })
  Object.assign(fixture.req, { rawBody: body })
  return fixture
}
function bounded(event: H3Event, maxBytes = 16) {
  return readBoundedRequestBody(event, { ...editorOptions, maxBytes })
}
afterEach(() => { for (const { req, res } of allocated.splice(0)) { res.destroy(); req.destroy() } })

describe('bounded HTTP request bodies', () => {
  it('rejects an unended chunked editor request as soon as it exceeds the limit, then closes after the error response', async () => {
    const { req, res, event } = requestEvent({ 'transfer-encoding': 'chunked', 'content-type': 'application/json' })
    const pending = readBoundedEditorBody(event, 8)
    const rejected = expect(pending).rejects.toMatchObject(editor413)
    req.write(Buffer.from('{"a": 1}'))
    req.write(Buffer.from(' '))
    await rejected
    expect(req.writableEnded).toBe(false)
    expect(req.isPaused()).toBe(true)
    expect(req.listenerCount('data')).toBe(0)
    expect(req.destroyed).toBe(false)
    expect(() => req.emit('error', new Error('synthetic peer reset after 413'))).not.toThrow()
    await expect(readBoundedEditorBody(event, 8)).rejects.toMatchObject(editor413)
    req.write(Buffer.from('not consumed'))
    expect(req.readableLength).toBeGreaterThan(0)
    res.emit('finish')
    expect(req.destroyed).toBe(true)
  })

  it('enforces the intervention 64 KB limit for chunked data with no Content-Length', async () => {
    const { req, event } = requestEvent({ 'transfer-encoding': 'chunked', 'content-type': 'application/json' })
    const rejected = expect(readInterventionBody(event)).rejects.toMatchObject({ statusCode: 413, statusMessage: 'Request body exceeds the 64 KB intervention limit.' })
    req.write(Buffer.alloc(MAX_REQUEST_BYTES, 0x20))
    req.write(Buffer.from('x'))
    await rejected
    expect(req.isPaused()).toBe(true)
    expect(req.writableEnded).toBe(false)
  })

  it('accepts exactly the UTF-8 byte limit, even when a multibyte character crosses Node chunks', async () => {
    const bytes = Buffer.from('{"名":"測"}', 'utf8')
    const { req, event } = requestEvent({ 'transfer-encoding': 'chunked', 'content-type': 'application/json' })
    const pending = readBoundedEditorBody(event, bytes.byteLength)
    req.write(bytes.subarray(0, 3))
    req.write(bytes.subarray(3, 5))
    req.end(bytes.subarray(5))
    await expect(pending).resolves.toEqual({ 名: '測' })
    await expect(readBoundedEditorBody(materialEvent(bytes).event, bytes.byteLength - 1)).rejects.toMatchObject(editor413)
  })

  it('measures raw whitespace rather than only the much smaller parsed object', async () => {
    await expect(readBoundedEditorBody(materialEvent('{}' + ' '.repeat(17)).event, 16)).rejects.toMatchObject(editor413)
  })

  it('does not trust a smaller declared Content-Length', async () => {
    const { req, event } = requestEvent({ 'content-length': '1', 'content-type': 'application/json' })
    const rejected = expect(readBoundedEditorBody(event, 8)).rejects.toMatchObject(editor413)
    req.write(Buffer.from('{"long":1}'))
    await rejected
    expect(req.writableEnded).toBe(false)
  })

  it('rejects a declared oversized body before touching its materialized source', async () => {
    const then = vi.fn()
    const { req, event } = requestEvent({ 'content-length': '17' })
    Object.assign(req, { rawBody: { then } })
    await expect(bounded(event)).rejects.toMatchObject(editor413)
    expect(then).not.toHaveBeenCalled()
    expect(req.listenerCount('data')).toBe(0)
  })

  it.each(['_requestBody', 'web', 'rawCache', 'rawBody', 'body'] as const)('bounds an authoritative %s source even with no body headers', async slot => {
    const { event, req } = requestEvent({ 'content-type': 'application/json' })
    const oversized = Buffer.from('{"x":"' + 'x'.repeat(17) + '"}')
    if (slot === '_requestBody') event._requestBody = oversized
    else if (slot === 'web') event.web = { request: new Request('https://test.invalid', { method: 'POST', body: oversized }) }
    else if (slot === 'rawCache') Object.assign(req, { [RAW_BODY]: Promise.resolve(oversized) })
    else Object.assign(req, { [slot]: oversized })
    await expect(bounded(event)).rejects.toMatchObject(editor413)
  })

  it('preserves h3 raw-source precedence instead of accepting an undersized lower-priority body', async () => {
    const first = materialEvent('{}')
    first.event._requestBody = Buffer.from(' '.repeat(17))
    await expect(bounded(first.event)).rejects.toMatchObject(editor413)
    const second = materialEvent(' '.repeat(17))
    second.event._requestBody = Buffer.from('{"ok":true}')
    await expect(bounded(second.event)).resolves.toEqual({ ok: true })
  })

  it.each([
    ['string', () => ' '.repeat(17)],
    ['plain object', () => ({ title: '測'.repeat(6) })],
    ['promise string', () => Promise.resolve(' '.repeat(17))],
    ['promise Buffer', () => Promise.resolve(Buffer.alloc(17))],
    ['Uint8Array', () => new Uint8Array(17)],
    ['ArrayBuffer', () => new ArrayBuffer(17)],
    ['byte array', () => new Array(17).fill(0)],
    ['Node stream', () => Readable.from([Buffer.alloc(8), Buffer.alloc(9)])],
    ['URLSearchParams', () => new URLSearchParams({ title: '測'.repeat(3) })],
    ['FormData', () => { const form = new FormData(); form.set('title', '測試'); return form }],
  ])('bounds materialized %s values', async (_label, source) => {
    await expect(bounded(materialEvent((source as () => unknown)()).event)).rejects.toMatchObject(editor413)
  })

  it('premeasures FormData encoding exactly at the boundary, including escaped names, linefeeds and file bytes', async () => {
    const form = new FormData()
    form.append('名"\n稱', 'line1\nline2\rline3\r\n測')
    form.append('file', new Blob(['test file'], { type: 'text/plain' }), 'a"b.txt')
    const encoded = await new Response(form).arrayBuffer()
    await expect(bounded(materialEvent(form, 'text/plain').event, encoded.byteLength - 1)).rejects.toMatchObject(editor413)
    const result = await bounded(materialEvent(form, 'text/plain').event, encoded.byteLength)
    expect(typeof result).toBe('string')
    expect(Buffer.byteLength(result as string)).toBe(encoded.byteLength)
    expect(result).toContain('line1\r\nline2\r\nline3\r\n測')
    expect(result).toContain('filename="a%22b.txt"')
  })

  it('rejects oversized FormData files before reading any file bytes', async () => {
    const form = new FormData()
    form.append('file', new Blob([Buffer.alloc(1024)]), 'synthetic.bin')
    const file = form.get('file') as File
    const stream = vi.spyOn(file, 'stream')
    await expect(bounded(materialEvent(form).event)).rejects.toMatchObject(editor413)
    expect(stream).not.toHaveBeenCalled()
  })

  it('cancels a Web stream at the first oversized chunk and never reads the next chunk', async () => {
    const chunks = [Buffer.alloc(8), Buffer.alloc(9), Buffer.alloc(1_000_000)]
    let reads = 0
    const cancel = vi.fn()
    const stream = new ReadableStream<Uint8Array>({ pull(controller) { controller.enqueue(chunks[reads++]!) }, cancel }, { highWaterMark: 0 })
    await expect(bounded(materialEvent(stream).event)).rejects.toMatchObject(editor413)
    expect(reads).toBe(2)
    expect(cancel).toHaveBeenCalledTimes(1)
    expect(stream.locked).toBe(false)
  })

  it('rejects promptly even when the oversized Web source never finishes its cancellation', async () => {
    const cancel = vi.fn(() => new Promise<void>(() => undefined))
    const stream = new ReadableStream<Uint8Array>({ pull(controller) { controller.enqueue(Buffer.alloc(17)) }, cancel }, { highWaterMark: 0 })
    await expect(bounded(materialEvent(stream).event)).rejects.toMatchObject(editor413)
    expect(cancel).toHaveBeenCalledTimes(1)
    expect(stream.locked).toBe(false)
  })

  it('reuses consumed Web data for h3 parsing and subsequent body reads', async () => {
    let pulls = 0
    const stream = new ReadableStream<Uint8Array>({ pull(controller) { pulls += 1; controller.enqueue(Buffer.from('{"ok":true}')); controller.close() } }, { highWaterMark: 0 })
    const { event } = requestEvent({ 'content-type': 'application/json' })
    event._requestBody = stream
    await expect(bounded(event)).resolves.toEqual({ ok: true })
    await expect(readBody(event)).resolves.toEqual({ ok: true })
    await expect(readRawBody(event)).resolves.toBe('{"ok":true}')
    await expect(bounded(event)).resolves.toEqual({ ok: true })
    expect(pulls).toBe(1)
    expect(stream.locked).toBe(false)
  })

  it('rejects a disturbed source before caching its tail as bounded original bytes', async () => {
    const stream = new PassThrough()
    stream.write(Buffer.from(' '))
    expect(stream.read(1)).toEqual(Buffer.from(' '))
    stream.end(Buffer.from('{"x":1}'))
    const { event, req } = requestEvent({ 'content-type': 'application/json' })
    Object.assign(req, { rawBody: stream })

    await expect(bounded(event)).rejects.toMatchObject({ statusCode: 422, statusMessage: editorOptions.invalidMessage })
    await expect(readBoundedRequestRawBody(event, { ...editorOptions, invalidStatusCode: 400 })).rejects.toBeDefined()
  })

  it('retains raw byte size when a second bounded read asks for a smaller limit', async () => {
    const { event } = materialEvent('{}' + ' '.repeat(12))
    await expect(bounded(event, 16)).resolves.toEqual({})
    await expect(bounded(event, 8)).rejects.toMatchObject(editor413)
  })

  it.each([false, true])('bounds h3 parsed cache values (promise: %s)', async promised => {
    const { req, event } = requestEvent()
    const value = { title: '測'.repeat(6) }
    Object.assign(req, { [PARSED_BODY]: promised ? Promise.resolve(value) : value, rawBody: '{}' })
    await expect(bounded(event)).rejects.toMatchObject(editor413)
    expect(req.listenerCount('data')).toBe(0)
  })

  it('keeps parsed cache authoritative over raw data and measures inherited cache entries too', async () => {
    const { req, event } = materialEvent('{"ignored":1}')
    const parsed = { ok: true }
    Object.setPrototypeOf(req, Object.create(Object.getPrototypeOf(req), { [PARSED_BODY]: { value: parsed, configurable: true } }))
    await expect(bounded(event)).resolves.toBe(parsed)
  })

  it('rejects original raw bytes above the limit even when h3 has cached a small parsed object', async () => {
    const { req, event } = materialEvent('{}' + ' '.repeat(17))
    Object.assign(req, { [PARSED_BODY]: {} })
    await expect(bounded(event)).rejects.toMatchObject(editor413)
  })

  it('checks the original raw promise installed by h3 before trusting its parsed cache', async () => {
    const { req, event } = requestEvent({ 'transfer-encoding': 'chunked', 'content-type': 'application/json' })
    const parsed = readBody(event)
    req.end(Buffer.from('{}' + ' '.repeat(17)))
    await expect(parsed).resolves.toEqual({})
    expect((req as unknown as Record<PropertyKey, unknown>)[RAW_BODY]).toBeDefined()
    await expect(bounded(event)).rejects.toMatchObject(editor413)
  })

  it('fails closed when h3 parsed a body but its original Node stream is disturbed and unavailable', async () => {
    const { req, event } = requestEvent({ 'transfer-encoding': 'chunked' })
    req.write(Buffer.from('{}'))
    req.read()
    Object.assign(req, { [PARSED_BODY]: {} })
    await expect(bounded(event)).rejects.toMatchObject({ statusCode: 422, statusMessage: editorOptions.invalidMessage })
  })

  it('fails closed when h3 parsed a consumed Web stream without retaining original bytes', async () => {
    const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(Buffer.from('{}')); controller.close() } })
    const reader = stream.getReader()
    await reader.read()
    reader.releaseLock()
    const { req, event } = requestEvent()
    event.web = { request: { body: stream } } as typeof event.web
    Object.assign(req, { [PARSED_BODY]: {} })
    await expect(bounded(event)).rejects.toMatchObject({ statusCode: 422, statusMessage: editorOptions.invalidMessage })
  })

  it('uses bytes retained by an h3 Node parse without consuming the stream again and applies smaller later limits', async () => {
    const { req, event } = requestEvent({ 'transfer-encoding': 'chunked', 'content-type': 'application/json' })
    const parsed = readBody(event)
    req.end(Buffer.from('{"ok":true}'))
    await expect(parsed).resolves.toEqual({ ok: true })
    await expect(bounded(event)).resolves.toEqual({ ok: true })
    expect(req.readableEnded).toBe(true)
    await expect(bounded(event, 8)).rejects.toMatchObject(editor413)
  })

  it('uses available adapter bytes for a parsed Web request without consuming its body stream', async () => {
    const { event } = requestEvent()
    const bytes = Buffer.from('{"ok":true}')
    let pulls = 0
    const stream = new ReadableStream<Uint8Array>({ pull(controller) { pulls++; controller.enqueue(bytes); controller.close() } }, { highWaterMark: 0 })
    event._requestBody = bytes
    event.web = { request: { body: stream } } as typeof event.web
    await expect(readBody(event)).resolves.toEqual({ ok: true })
    await expect(bounded(event)).resolves.toEqual({ ok: true })
    expect(pulls).toBe(0)
    expect(stream.locked).toBe(false)
  })

  it('keeps a small parsed-only cache valid when original raw bytes are unavailable', async () => {
    const { req, event } = requestEvent()
    const parsed = { ok: true }
    Object.assign(req, { [PARSED_BODY]: parsed })
    await expect(bounded(event)).resolves.toBe(parsed)
  })

  it('retains the editor JSON-safe 422 for a cyclic cached parsed body', async () => {
    const { req, event } = requestEvent()
    const value: Record<string, unknown> = {}; value.self = value
    Object.assign(req, { [PARSED_BODY]: value })
    await expect(readBoundedEditorBody(event)).rejects.toMatchObject({ statusCode: 422, statusMessage: 'Editor request body is not JSON-safe.' })
  })

  it.each([
    ['application/json', '{"ok":true}', { ok: true }],
    ['application/json; charset=utf-8', 'plain value', 'plain value'],
    ['application/octet-stream', '{"ok":true}', { ok: true }],
    ['application/octet-stream', 'plain value', 'plain value'],
    ['text/plain', '{"ok":true}', '{"ok":true}'],
    ['application/x-www-form-urlencoded; charset=utf-8', 'tag=a&tag=b&name=%E6%B8%AC', { tag: ['a', 'b'], name: '測' }],
  ])('preserves h3 parsing for %s with body %s', async (contentType, raw, expected) => {
    const { event } = materialEvent(raw, contentType)
    const result = await bounded(event, 128)
    expect(result).toEqual(expected)
    if (contentType.startsWith('application/x-www-form-urlencoded')) expect(Object.getPrototypeOf(result)).toBeNull()
  })

  it('preserves the exact h3 malformed JSON error', async () => {
    await expect(readBoundedEditorBody(materialEvent('{broken').event)).rejects.toMatchObject({ statusCode: 400, statusMessage: 'Bad Request', message: 'Invalid JSON body' })
    await expect(readInterventionBody(materialEvent('{broken').event)).rejects.toMatchObject({ statusCode: 400, statusMessage: 'Bad Request', message: 'Invalid JSON body' })
  })

  it('retains empty-body behavior without rereading an empty incoming stream', async () => {
    await expect(readBoundedEditorBody(requestEvent().event)).rejects.toMatchObject({ statusCode: 422, statusMessage: 'Editor request body is not JSON-safe.' })
    await expect(readInterventionBody(requestEvent().event)).resolves.toEqual({})
    const { req, event } = requestEvent({ 'transfer-encoding': 'chunked', 'content-type': 'application/json' })
    const pending = readInterventionBody(event)
    req.end()
    await expect(pending).resolves.toEqual({})
    await expect(readInterventionBody(event)).resolves.toEqual({})
    expect(req.listenerCount('data')).toBe(0)
  })

  it('preserves h3 absent versus framed empty text and empty URL-encoded forms', async () => {
    await expect(bounded(requestEvent({ 'content-type': 'text/plain' }).event)).resolves.toBeUndefined()
    await expect(readBoundedEditorBody(requestEvent({ 'content-type': 'text/plain' }).event)).rejects.toMatchObject({ statusCode: 422, statusMessage: 'Editor request body is not JSON-safe.' })
    const { req, event } = requestEvent({ 'content-type': 'text/plain', 'transfer-encoding': 'chunked' })
    const pending = bounded(event)
    req.end()
    await expect(pending).resolves.toBe('')
    const form = await bounded(requestEvent({ 'content-type': 'application/x-www-form-urlencoded' }).event)
    expect(form).toEqual({})
    expect(Object.getPrototypeOf(form)).toBeNull()
  })

  it.each([undefined, null, ''])('preserves an empty parsed cache (%s)', async value => {
    const { req, event } = requestEvent()
    Object.assign(req, { [PARSED_BODY]: value })
    await expect(readInterventionBody(event)).resolves.toEqual({})
    expect(req.listenerCount('data')).toBe(0)
  })

  it.each(['42', '[]', '"text"'])('retains the intervention plain-object error for %s', async raw => {
    await expect(readInterventionBody(materialEvent(raw).event)).rejects.toMatchObject({ statusCode: 400, statusMessage: 'Request body must be a plain object.' })
  })

  it('accepts exactly 64 KB for an intervention plain object', async () => {
    const raw = '{"x":"' + 'x'.repeat(MAX_REQUEST_BYTES - 8) + '"}'
    expect(Buffer.byteLength(raw)).toBe(MAX_REQUEST_BYTES)
    await expect(readInterventionBody(materialEvent(raw).event)).resolves.toEqual({ x: 'x'.repeat(MAX_REQUEST_BYTES - 8) })
    await expect(readInterventionBody(materialEvent(raw + ' ').event)).rejects.toMatchObject({ statusCode: 413, statusMessage: 'Request body exceeds the 64 KB intervention limit.' })
  })

  it('rejects an aborted Node request without waiting for an end event', async () => {
    const { req, event } = requestEvent({ 'transfer-encoding': 'chunked' })
    const rejected = expect(bounded(event)).rejects.toMatchObject({ statusCode: 400, statusMessage: 'Bad Request', message: 'Request body was aborted.' })
    req.write(Buffer.from('{'))
    req.emit('aborted')
    await rejected
    expect(req.listenerCount('data')).toBe(0)
  })

  it('fails immediately for a request that was already aborted', async () => {
    const { req, event } = requestEvent({ 'transfer-encoding': 'chunked' })
    Object.assign(req, { aborted: true })
    await expect(bounded(event)).rejects.toMatchObject({ statusCode: 400, message: 'Request body was aborted.' })
    expect(req.listenerCount('data')).toBe(0)
  })

  it('keeps a Node stream error instead of turning it into an oversize or JSON error', async () => {
    const { req, event } = requestEvent({ 'transfer-encoding': 'chunked' })
    const error = new Error('synthetic stream failure')
    const rejected = expect(bounded(event)).rejects.toBe(error)
    req.emit('error', error)
    await rejected
    expect(req.listenerCount('data')).toBe(0)
  })
})

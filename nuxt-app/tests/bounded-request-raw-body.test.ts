import { ServerResponse } from 'node:http'
import { PassThrough, Readable } from 'node:stream'
import { createEvent, readBody, type H3Event } from 'h3'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { readBoundedRequestBody, readBoundedRequestRawBody } from '../server/utils/bounded-request-body'

const RAW_BODY = Symbol.for('h3RawBody'), PARSED_BODY = Symbol.for('h3ParsedBody')
const options = { maxBytes: 16, oversizedMessage: 'Raw body too large.', invalidMessage: 'Original raw bytes unavailable.', invalidStatusCode: 400 as const }
const allocated: Array<{ req: PassThrough; res: ServerResponse }> = []
function fixture(body?: unknown, headers: Record<string, string> = {}) {
  const req = Object.assign(new PassThrough(), { method: 'POST', url: '/raw-body-test', headers: { 'content-type': 'application/json', ...headers } })
  const res = new ServerResponse(req as never)
  allocated.push({ req, res })
  if (body !== undefined) Object.assign(req, { rawBody: body })
  return { req, res, event: createEvent(req as never, res) }
}
const raw = (event: H3Event, maxBytes = 16) => readBoundedRequestRawBody(event, { ...options, maxBytes })
afterEach(() => { for (const { req, res } of allocated.splice(0)) { res.destroy(); req.destroy() } })

describe('bounded untouched raw HTTP bytes', () => {
  it.each([
    ['Buffer', () => Buffer.from(' { "名": 1 }\n')],
    ['string', () => ' { "名": 1 }\n'],
    ['Uint8Array', () => new Uint8Array(Buffer.from(' { "名": 1 }\n'))],
    ['ArrayBuffer', () => new Uint8Array(Buffer.from(' { "名": 1 }\n')).buffer],
    ['promise', () => Promise.resolve(Buffer.from(' { "名": 1 }\n'))],
    ['Node stream', () => Readable.from([Buffer.from(' { "名'), Buffer.from('": 1 }\n')])],
  ])('preserves exact whitespace and UTF-8 bytes from %s', async (_name, source) => {
    const { event } = fixture(source())
    expect(await raw(event)).toEqual(Buffer.from(' { "名": 1 }\n'))
    expect(await raw(event)).toEqual(Buffer.from(' { "名": 1 }\n'))
    await expect(readBody(event)).resolves.toEqual({ 名: 1 })
    await expect(readBoundedRequestBody(event, options)).resolves.toEqual({ 名: 1 })
  })
  it('keeps byte splitting and Node stream hard limits without trusting Content-Length', async () => {
    const { req, res, event } = fixture(undefined, { 'content-length': '1' })
    const rejected = expect(raw(event)).rejects.toMatchObject({ statusCode: 413, statusMessage: options.oversizedMessage })
    req.write(Buffer.alloc(16)); req.write(Buffer.from('x'))
    await rejected
    expect(req.isPaused()).toBe(true)
    expect(req.destroyed).toBe(false)
    expect(req.listenerCount('data')).toBe(0)
    res.emit('finish')
    expect(req.destroyed).toBe(true)
  })
  it('reads chunked Node bytes exactly once and applies smaller subsequent limits', async () => {
    const { req, event } = fixture(undefined, { 'transfer-encoding': 'chunked' })
    const bytes = Buffer.from(' { "名": 1 }\n')
    const pending = raw(event, bytes.byteLength)
    req.write(bytes.subarray(0, 5)); req.end(bytes.subarray(5))
    await expect(pending).resolves.toEqual(bytes)
    await expect(raw(event, bytes.byteLength)).resolves.toEqual(bytes)
    await expect(raw(event, bytes.byteLength - 1)).rejects.toMatchObject({ statusCode: 413 })
    expect(req.listenerCount('data')).toBe(0)
  })
  it('cancels an oversized unframed Web stream before its next chunk', async () => {
    let pulls = 0
    const cancel = vi.fn()
    const stream = new ReadableStream<Uint8Array>({ pull(controller) { pulls++; controller.enqueue(Buffer.alloc(pulls === 1 ? 16 : 1)) }, cancel }, { highWaterMark: 0 })
    const { event } = fixture(stream)
    await expect(raw(event)).rejects.toMatchObject({ statusCode: 413 })
    expect(pulls).toBe(2); expect(cancel).toHaveBeenCalledTimes(1); expect(stream.locked).toBe(false)
  })
  it('reuses a Web adapter body without decoding malformed UTF-8 or JSON', async () => {
    const bytes = Buffer.from([0x7b, 0xc3, 0x28, 0x7d])
    const { event } = fixture()
    event.web = { request: new Request('https://synthetic.example.test', { method: 'POST', body: bytes }) } as typeof event.web
    await expect(raw(event)).resolves.toEqual(bytes)
    await expect(raw(event)).resolves.toEqual(bytes)
  })
  it.each(['_requestBody', 'rawCache', 'rawBody', 'body'])('hard-bounds materialized %s and preserves h3 raw-source precedence', async slot => {
    const { req, event } = fixture('{}')
    const bytes = Buffer.alloc(17)
    if (slot === '_requestBody') event._requestBody = bytes
    else if (slot === 'rawCache') Object.assign(req, { [RAW_BODY]: Promise.resolve(bytes) })
    else if (slot === 'body') { delete (req as unknown as { rawBody?: unknown }).rawBody; Object.assign(req, { body: bytes }) }
    else Object.assign(req, { rawBody: bytes })
    await expect(raw(event)).rejects.toMatchObject({ statusCode: 413 })
  })
  it.each([
    ['object', () => ({ ok: true })], ['promise object', () => Promise.resolve({ ok: true })],
    ['array', () => [123]], ['URLSearchParams', () => new URLSearchParams({ ok: 'true' })],
    ['FormData', () => new FormData()],
  ])('refuses %s reconstruction, even when it would fit', async (_name, source) => {
    await expect(raw(fixture(source()).event)).rejects.toMatchObject({ statusCode: 400, statusMessage: options.invalidMessage })
  })
  it('refuses a parsed-only cache but permits its available untouched original raw bytes', async () => {
    const parsedOnly = fixture()
    Object.assign(parsedOnly.req, { [PARSED_BODY]: { ok: true } })
    await expect(raw(parsedOnly.event)).rejects.toMatchObject({ statusCode: 400 })
    const original = fixture(' { "ok": true }')
    Object.assign(original.req, { [PARSED_BODY]: { ok: true } })
    await expect(raw(original.event)).resolves.toEqual(Buffer.from(' { "ok": true }'))
  })
  it('refuses JSON-reader reconstruction cached as raw while retaining its legacy parsing', async () => {
    const { event } = fixture({ ok: true })
    await expect(readBoundedRequestBody(event, options)).resolves.toEqual({ ok: true })
    await expect(raw(event)).rejects.toMatchObject({ statusCode: 400 })
  })
  it('preserves real raw JSON-reader caches and original whitespace size', async () => {
    const { event } = fixture('{}' + ' '.repeat(14))
    await expect(readBoundedRequestBody(event, options)).resolves.toEqual({})
    await expect(raw(event)).resolves.toEqual(Buffer.from('{}' + ' '.repeat(14)))
    await expect(raw(event, 8)).rejects.toMatchObject({ statusCode: 413 })
  })
  it('rejects an aborted incoming Node stream promptly and cleans listeners', async () => {
    const { req, event } = fixture(undefined, { 'transfer-encoding': 'chunked' })
    const rejected = expect(raw(event)).rejects.toMatchObject({ statusCode: 400, message: 'Request body was aborted.' })
    req.write(Buffer.from('{')); req.emit('aborted')
    await rejected
    expect(req.listenerCount('data')).toBe(0)
  })
  it('returns empty original bytes without parsing, but rejects unsafe request methods', async () => {
    await expect(raw(fixture().event)).resolves.toEqual(Buffer.alloc(0))
    const { req, event } = fixture('{}')
    req.method = 'GET'
    await expect(raw(event)).rejects.toMatchObject({ statusCode: 405 })
  })
})

import { ServerResponse } from 'node:http'
import { PassThrough } from 'node:stream'
import { createEvent, type H3Event } from 'h3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { assertGeoOutcomeSameOriginMutation, readGeoBody } from '../server/api/geo-outcome-model/_helpers'
import { MAX_REQUEST_BYTES } from '../server/geo-outcome-model/constants'

const allocated: Array<{ req: PassThrough; res: ServerResponse }> = []
const RAW = Symbol.for('h3RawBody')
const PARSED = Symbol.for('h3ParsedBody')
function fixture(headers: Record<string, string | undefined> = {}) {
  const req = Object.assign(new PassThrough(), { method: 'POST', url: '/api/geo-outcome-model/candidate-sets/review', headers: { host: 'ops.example.test', origin: 'http://ops.example.test', 'content-type': 'application/json', ...headers } })
  const res = new ServerResponse(req as never)
  allocated.push({ req, res })
  return { req, res, event: createEvent(req as never, res) }
}
function material(body: unknown, headers: Record<string, string | undefined> = {}) {
  const f = fixture(headers)
  Object.assign(f.req, { rawBody: body })
  return f
}
const oversized = { statusCode: 413, statusMessage: 'Request body exceeds the bounded GEO outcome limit.' }
beforeEach(() => { vi.stubEnv('NUXT_DISCOVERYSTACK_PRIVATE_ORIGIN', '') })
afterEach(() => { vi.unstubAllEnvs(); for (const { req, res } of allocated.splice(0)) { res.destroy(); req.destroy() } })

describe('GEO owner mutation origin and actual request byte boundary', () => {
  it('accepts a same-origin browser request without requiring fetch metadata from non-browser clients', async () => {
    await expect(readGeoBody(material('{"ok":true}').event)).resolves.toEqual({ ok: true })
    await expect(readGeoBody(material('{}', { 'sec-fetch-site': 'same-origin' }).event)).resolves.toEqual({})
  })
  it.each([undefined, '', 'null', 'https://evil.example', 'http://ops.example.test/path', 'http://ops.example.test?x=1', 'http://user@ops.example.test', 'not-an-origin'])(
    'rejects missing, forged or cross-origin %s before consuming the request body', async origin => {
      const f = fixture({ origin })
      const observed = vi.fn()
      Object.defineProperty(f.req, 'rawBody', { get: observed })
      await expect(readGeoBody(f.event)).rejects.toMatchObject({ statusCode: 403 })
      expect(observed).not.toHaveBeenCalled()
      expect(f.req.listenerCount('data')).toBe(0)
    },
  )
  it.each(['cross-site', 'same-site', 'none'])('rejects conflicting Sec-Fetch-Site %s', async site => {
    await expect(readGeoBody(material('{}', { 'sec-fetch-site': site }).event)).rejects.toMatchObject({ statusCode: 403 })
  })
  it('uses the configured private origin instead of trusting a caller host', async () => {
    vi.stubEnv('NUXT_DISCOVERYSTACK_PRIVATE_ORIGIN', 'https://private.example.test')
    await expect(readGeoBody(material('{}', { origin: 'http://ops.example.test' }).event)).rejects.toMatchObject({ statusCode: 403 })
    await expect(readGeoBody(material('{}', { origin: 'https://private.example.test' }).event)).resolves.toEqual({})
  })
  it.each(['not a URL', 'ftp://private.example.test', 'https://user:password@private.example.test', 'https://private.example.test/path'])('rejects invalid private origin configuration %s', configured => {
    vi.stubEnv('NUXT_DISCOVERYSTACK_PRIVATE_ORIGIN', configured)
    expect(() => assertGeoOutcomeSameOriginMutation(fixture().event)).toThrow(expect.objectContaining({ statusCode: 503 }))
  })
  it('rejects a chunked request at max plus one before the stream ends', async () => {
    const f = fixture({ 'transfer-encoding': 'chunked' })
    const rejected = expect(readGeoBody(f.event)).rejects.toMatchObject(oversized)
    f.req.write(Buffer.alloc(MAX_REQUEST_BYTES, 0x20)); f.req.write('x')
    await rejected
    expect(f.req.writableEnded).toBe(false)
    expect(f.req.isPaused()).toBe(true)
    expect(f.req.listenerCount('data')).toBe(0)
  })
  it('preserves the existing GEO limit and accepts exactly that many UTF-8 bytes', async () => {
    const multibyteCount = Math.floor((MAX_REQUEST_BYTES - 8) / 3)
    const padding = 'x'.repeat(MAX_REQUEST_BYTES - 8 - multibyteCount * 3)
    const value = '測'.repeat(multibyteCount) + padding
    const bytes = Buffer.from(JSON.stringify({ x: value }))
    expect(bytes.length).toBe(MAX_REQUEST_BYTES)
    await expect(readGeoBody(material(bytes).event)).resolves.toEqual({ x: value })
    await expect(readGeoBody(material(Buffer.concat([bytes, Buffer.from(' ')])).event)).rejects.toMatchObject(oversized)
  })
  it('allows a route to tighten the existing limit to 64 KiB, but never expand it', async () => {
    const bytes = Buffer.from(`{"x":"${'測'.repeat(21_842)}ab"}`)
    await expect(readGeoBody(material(bytes).event, 64 * 1024)).resolves.toHaveProperty('x')
    await expect(readGeoBody(material(Buffer.concat([bytes, Buffer.from(' ')])).event, 64 * 1024)).rejects.toMatchObject(oversized)
    await expect(readGeoBody(material('{}').event, MAX_REQUEST_BYTES + 1)).rejects.toMatchObject({ statusCode: 503 })
  })
  it('does not trust understated Content-Length', async () => {
    const f = fixture({ 'content-length': '1' })
    const rejected = expect(readGeoBody(f.event)).rejects.toMatchObject(oversized)
    f.req.write(Buffer.from('{}' + ' '.repeat(MAX_REQUEST_BYTES)))
    await rejected
  })
  it.each(['rawBody', 'raw-cache', 'parsed-cache', 'web'] as const)('bounds adapter and cached %s values', async kind => {
    const f = fixture()
    const bytes = Buffer.from('{}' + ' '.repeat(MAX_REQUEST_BYTES))
    if (kind === 'rawBody') Object.assign(f.req, { rawBody: bytes })
    if (kind === 'raw-cache') Object.assign(f.req, { [RAW]: Promise.resolve(bytes) })
    if (kind === 'parsed-cache') Object.assign(f.req, { [PARSED]: { large: 'x'.repeat(MAX_REQUEST_BYTES) } })
    if (kind === 'web') f.event.web = { request: new Request('http://ops.example.test', { method: 'POST', body: bytes }) } as H3Event['web']
    await expect(readGeoBody(f.event)).rejects.toMatchObject(oversized)
  })
  it('rejects invalid JSON and non-object bodies without reflecting payload contents', async () => {
    for (const value of ['bad-json', '[]', 'null', '"private fixture"', '5']) {
      await expect(readGeoBody(material(value).event)).rejects.toMatchObject({ statusCode: 400, statusMessage: 'Request body must be an object.' })
    }
  })
})

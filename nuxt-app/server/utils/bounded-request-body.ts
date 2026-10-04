import { assertMethod, createError, getRequestHeader, readBody, type H3Event } from 'h3'
import type { Readable } from 'node:stream'

const RAW_BODY = Symbol.for('h3RawBody')
const PARSED_BODY = Symbol.for('h3ParsedBody')
const BOUNDED_RAW_BODY = Symbol('boundedRequestRawBody')

type BodyOptions = {
  maxBytes: number
  oversizedMessage: string
  invalidMessage: string
  invalidStatusCode: 400 | 422
}
type CachedRequest = H3Event['node']['req'] & { [RAW_BODY]?: unknown; [PARSED_BODY]?: unknown; [BOUNDED_RAW_BODY]?: Promise<Buffer | undefined>; rawBody?: unknown; body?: unknown }

function oversized(options: BodyOptions): never { throw createError({ statusCode: 413, statusMessage: options.oversizedMessage }) }
function invalid(options: BodyOptions): never { throw createError({ statusCode: options.invalidStatusCode, statusMessage: options.invalidMessage }) }
function aborted() { return createError({ statusCode: 400, statusMessage: 'Bad Request', message: 'Request body was aborted.' }) }
function checkSize(bytes: number, options: BodyOptions) { if (bytes > options.maxBytes) oversized(options) }
function jsonBytes(value: unknown, options: BodyOptions): string | undefined {
  try { return JSON.stringify(value) } catch { return invalid(options) }
}

function stopNodeStream(event: H3Event, stream: Readable) {
  stream.pause()
  // A peer reset after the 413 must not become an unhandled stream error during cleanup.
  const ignoreLateError = () => undefined
  stream.on('error', ignoreLateError)
  stream.once('close', () => stream.off('error', ignoreLateError))
  if (stream !== event.node.req) { stream.destroy(); return }
  // Let the HTTP response carry the 413 before closing an oversized incoming request.
  const response = event.node.res
  const destroy = () => { response.off('finish', destroy); response.off('close', destroy); if (!stream.destroyed) stream.destroy() }
  if (response.writableFinished || response.destroyed) destroy()
  else response.once('finish', destroy).once('close', destroy)
}

function readNodeStream(event: H3Event, stream: Readable, options: BodyOptions): Promise<Buffer> {
  if ((stream as Readable & { aborted?: boolean }).aborted || stream.destroyed || stream.readableEnded) return Promise.reject(aborted())
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let bytes = 0
    const cleanup = () => { stream.off('data', onData); stream.off('end', onEnd); stream.off('error', onError); stream.off('aborted', onAborted); stream.off('close', onAborted) }
    const fail = (error: unknown, stop = false) => { cleanup(); chunks.length = 0; if (stop) stopNodeStream(event, stream); reject(error) }
    const onData = (chunk: Uint8Array | string) => {
      try {
        checkSize(bytes + (typeof chunk === 'string' ? Buffer.byteLength(chunk, 'utf8') : chunk.byteLength), options)
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
        bytes += buffer.byteLength; chunks.push(buffer)
      } catch (error) { fail(error, true) }
    }
    const onEnd = () => { cleanup(); resolve(Buffer.concat(chunks, bytes)) }
    const onError = (error: Error) => fail(error)
    const onAborted = () => fail(aborted())
    stream.on('error', onError).on('aborted', onAborted).on('close', onAborted).on('data', onData).on('end', onEnd)
  })
}

async function readWebStream(stream: ReadableStream<Uint8Array>, options: BodyOptions): Promise<Buffer> {
  const reader = stream.getReader()
  const chunks: Buffer[] = []
  let bytes = 0
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) return Buffer.concat(chunks, bytes)
      checkSize(bytes + next.value.byteLength, options)
      const buffer = Buffer.from(next.value)
      bytes += buffer.byteLength; chunks.push(buffer)
    }
  } catch (error) {
    void reader.cancel(error).catch(() => undefined)
    throw error
  } finally { reader.releaseLock() }
}

// h3 delegates materialized FormData to Node's Response encoder. Its multipart boundary
// is 32 bytes; count headers and Blob sizes before creating that eagerly produced stream.
// This also avoids Node 24's unhandled enqueue when an oversized multipart stream is canceled.
function assertFormDataSize(form: FormData, options: BodyOptions) {
  const boundary = '-'.repeat(32)
  const prefix = `--${boundary}\r\nContent-Disposition: form-data`
  const normalize = (text: string) => text.replace(/\r?\n|\r/gu, '\r\n')
  const escape = (text: string) => text.replace(/\n/gu, '%0A').replace(/\r/gu, '%0D').replace(/"/gu, '%22')
  let bytes = Buffer.byteLength(`--${boundary}--\r\n`, 'utf8')
  checkSize(bytes, options)
  for (const [name, value] of form) {
    checkSize(bytes + Buffer.byteLength(name, 'utf8'), options)
    const field = `${prefix}; name="${escape(normalize(name))}"`
    if (typeof value === 'string') {
      checkSize(bytes + Buffer.byteLength(value, 'utf8'), options)
      bytes += Buffer.byteLength(`${field}\r\n\r\n${normalize(value)}\r\n`, 'utf8')
    } else {
      checkSize(bytes + value.size + Buffer.byteLength(value.name, 'utf8') + Buffer.byteLength(value.type, 'utf8'), options)
      const filename = value.name ? `; filename="${escape(value.name)}"` : ''
      bytes += Buffer.byteLength(`${field}${filename}\r\nContent-Type: ${value.type || 'application/octet-stream'}\r\n\r\n`, 'utf8') + value.size + 2
    }
    checkSize(bytes, options)
  }
}

async function materialize(event: H3Event, source: unknown, options: BodyOptions): Promise<Buffer | undefined> {
  const value = await source
  if (value === undefined || value === null) return undefined
  if (Buffer.isBuffer(value)) { checkSize(value.byteLength, options); return value }
  if (typeof (value as ReadableStream).getReader === 'function') return readWebStream(value as ReadableStream<Uint8Array>, options)
  if (typeof (value as Readable).pipe === 'function') return readNodeStream(event, value as Readable, options)
  if (typeof (value as ReadableStream).pipeTo === 'function') {
    const chunks: Buffer[] = []; let bytes = 0
    await (value as ReadableStream<Uint8Array>).pipeTo(new WritableStream({ write(chunk: Uint8Array) { checkSize(bytes + chunk.byteLength, options); const buffer = Buffer.from(chunk); bytes += buffer.byteLength; chunks.push(buffer) } }))
    return Buffer.concat(chunks, bytes)
  }
  let serialized: unknown = value
  if ((value as object).constructor === Object) serialized = jsonBytes(value, options)
  else if (value instanceof URLSearchParams) serialized = value.toString()
  else if (value instanceof FormData) {
    assertFormDataSize(value, options)
    const stream = new Response(value).body
    return stream ? readWebStream(stream, options) : undefined
  }
  if (serialized === undefined) return undefined
  if (typeof serialized === 'string') checkSize(Buffer.byteLength(serialized, 'utf8'), options)
  else if (serialized instanceof Uint8Array || serialized instanceof ArrayBuffer) checkSize(serialized.byteLength, options)
  else if (Array.isArray(serialized)) checkSize(serialized.length, options)
  const buffer = Buffer.from(serialized as string)
  checkSize(buffer.byteLength, options)
  return buffer
}

/** Bound h3's authoritative body before parsing, including bodies already cached by another adapter. */
export async function readBoundedRequestBody(event: H3Event, options: BodyOptions): Promise<unknown> {
  const length = Number(getRequestHeader(event, 'content-length') || 0)
  if (length > options.maxBytes) oversized(options)
  const request = event.node.req as CachedRequest
  // Enforce the original raw size on subsequent calls, even if h3 has now cached the parsed value.
  if (request[BOUNDED_RAW_BODY]) {
    const previousRaw = await request[BOUNDED_RAW_BODY]
    if (previousRaw) checkSize(previousRaw.byteLength, options)
  }
  // readBody returns this cache first, even when its value is undefined or a promise.
  if (PARSED_BODY in request) {
    const parsed = await request[PARSED_BODY]
    const serialized = jsonBytes(parsed, options)
    if (serialized !== undefined) checkSize(Buffer.byteLength(serialized, 'utf8'), options)
    return parsed
  }
  assertMethod(event, ['PATCH', 'POST', 'PUT', 'DELETE'])
  if (!request[BOUNDED_RAW_BODY]) {
    // Match h3 1.15.11 readRawBody precedence exactly. Never re-read a consumed Node/Web stream.
    const source = event._requestBody || event.web?.request?.body || request[RAW_BODY] || request.rawBody || request.body
    const hasIncomingBody = Boolean(Number.parseInt(String(request.headers['content-length'] || ''))) || /\bchunked\b/iu.test(String(request.headers['transfer-encoding'] || ''))
    // Preserve h3's absent-body distinction (text/* yields undefined, framed empty text yields '').
    if (!source && !hasIncomingBody) return readBody(event)
    const raw = source ? materialize(event, source, options) : readNodeStream(event, request, options)
    request[BOUNDED_RAW_BODY] = raw
    request[RAW_BODY] = raw
  }
  const raw = await request[BOUNDED_RAW_BODY]
  if (raw) checkSize(raw.byteLength, options)
  // _requestBody precedes event.web.request.body: overriding it is necessary after a Web stream was consumed.
  // An empty Buffer safely represents an absent body without asking h3 to consume the stream again.
  event._requestBody = new Uint8Array(raw ?? Buffer.alloc(0))
  return readBody(event)
}

import type { FirstPartyFetch, FirstPartyFetchResponse, FirstPartyRequestInit } from '../first-party-publishing/types'

const DEFAULT_RESPONSE_BODY_BYTES = 10 * 1024 * 1024

export class BoundedFetchTimeoutError extends Error {
  constructor() {
    super('bounded request timeout')
    this.name = 'BoundedFetchTimeoutError'
  }
}

export class BoundedFetchNetworkError extends Error {
  constructor() {
    super('bounded network request failed')
    this.name = 'BoundedFetchNetworkError'
  }
}

function safeTimeout(timeoutMs: number): number {
  return Number.isSafeInteger(timeoutMs) && timeoutMs >= 1 && timeoutMs <= 120_000 ? timeoutMs : 120_000
}

function safeBodyLimit(maxResponseBodyBytes: number | undefined): number {
  return Number.isSafeInteger(maxResponseBodyBytes) && (maxResponseBodyBytes as number) >= 1 && (maxResponseBodyBytes as number) <= DEFAULT_RESPONSE_BODY_BYTES
    ? maxResponseBodyBytes as number
    : DEFAULT_RESPONSE_BODY_BYTES
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === 'AbortError' || /abort|timeout/i.test(error.message))
}

async function readBoundedBody(response: Response, maximumBytes: number, controller: AbortController): Promise<string> {
  const contentLength = response.headers.get('content-length')
  if (contentLength !== null && /^\d+$/.test(contentLength) && Number(contentLength) > maximumBytes) {
    controller.abort()
    throw new BoundedFetchNetworkError()
  }
  if (!response.body) return ''
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let totalBytes = 0
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      totalBytes += chunk.value.byteLength
      if (totalBytes > maximumBytes) {
        controller.abort()
        throw new BoundedFetchNetworkError()
      }
      chunks.push(chunk.value)
    }
  } finally {
    reader.releaseLock()
  }
  const joined = new Uint8Array(totalBytes)
  let offset = 0
  for (const chunk of chunks) {
    joined.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(joined)
}

export type BoundedFetchOptions = {
  nativeFetch?: typeof globalThis.fetch
  maxResponseBodyBytes?: number
}

export function createBoundedFetch(options: BoundedFetchOptions = {}): FirstPartyFetch {
  const nativeFetch = options.nativeFetch || globalThis.fetch
  const maxResponseBodyBytes = safeBodyLimit(options.maxResponseBodyBytes)
  return async (url: string, init: FirstPartyRequestInit): Promise<FirstPartyFetchResponse> => {
    const timeoutMs = safeTimeout(init.timeoutMs)
    const controller = new AbortController()
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, timeoutMs)
    try {
      const response = await nativeFetch(url, {
        method: init.method,
        headers: { ...init.headers },
        ...(init.body === undefined ? {} : { body: init.body }),
        redirect: 'manual',
        signal: controller.signal,
      })
      const body = await readBoundedBody(response, maxResponseBodyBytes, controller)
      if (timedOut) throw new BoundedFetchTimeoutError()
      return {
        status: response.status,
        headers: Object.fromEntries(response.headers.entries()),
        text: async () => body,
      }
    } catch (error) {
      if (timedOut || isAbortError(error)) throw new BoundedFetchTimeoutError()
      if (error instanceof BoundedFetchNetworkError) throw error
      throw new BoundedFetchNetworkError()
    } finally {
      clearTimeout(timer)
    }
  }
}

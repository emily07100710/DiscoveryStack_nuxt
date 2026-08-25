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
      const body = await response.text()
      if (timedOut) throw new BoundedFetchTimeoutError()
      if (Buffer.byteLength(body, 'utf8') > maxResponseBodyBytes) throw new BoundedFetchNetworkError()
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

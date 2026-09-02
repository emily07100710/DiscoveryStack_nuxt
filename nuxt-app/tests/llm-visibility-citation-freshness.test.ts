import { afterEach, describe, expect, it, vi } from 'vitest'
import { CITATION_HEAD_MAX_REQUESTS, isPublicHttpUrl, resolveCitationFreshness, type CitationHeadFetchOptions } from '../server/llm-visibility/citation-freshness'

const observedAt = new Date('2026-09-02T12:00:00.000Z')
const publicDns = async () => ['8.8.8.8']
const head = (fetchImpl: typeof fetch, overrides: Partial<CitationHeadFetchOptions> = {}): CitationHeadFetchOptions => ({ enabled: true, fetchImpl, resolveDns: publicDns, budget: { maxRequests: 100 }, cache: new Map(), now: () => observedAt, ...overrides })

afterEach(() => vi.useRealTimers())

describe('LLM visibility citation freshness', () => {
  it('uses provider metadata before URL patterns and URL patterns before HEAD', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 200, headers: { 'last-modified': 'Mon, 01 Jan 2024 00:00:00 GMT' } })) as unknown as typeof fetch
    const urls = ['https://example.com/2025/01/02/article', 'https://example.com/news/2025-02-03-story', 'https://example.com/no-date']
    const result = await resolveCitationFreshness(urls, { observedAt, providerDates: { [urls[0]!]: '2026-01-01' }, headFetch: head(fetchImpl) })
    expect(result.map(row => row.dateSource)).toEqual(['provider_metadata', 'url_pattern', 'http_last_modified'])
    expect(result.map(row => row.sourceDate)).toEqual(['2026-01-01', '2025-02-03', '2024-01-01'])
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('keeps unknown dates honest when HEAD is disabled', async () => {
    const fetchImpl = vi.fn()
    expect(await resolveCitationFreshness(['https://example.com/no-date'], { observedAt, headFetch: { ...head(fetchImpl as unknown as typeof fetch), enabled: false } })).toEqual([{ url: 'https://example.com/no-date', dateSource: 'unknown', sourceDate: null, ageDays: null }])
    expect(fetchImpl).not.toHaveBeenCalled()
    expect((await resolveCitationFreshness(['https://example.com/2025/02/30/nope', 'https://example.com/1999-01-01/old'], { observedAt }))).toEqual([
      { url: 'https://example.com/2025/02/30/nope', dateSource: 'unknown', sourceDate: null, ageDays: null },
      { url: 'https://example.com/1999-01-01/old', dateSource: 'unknown', sourceDate: null, ageDays: null },
    ])
  })

  it('rejects fake Last-Modified values', async () => {
    for (const headers of [
      {},
      { 'last-modified': 'not-a-date' },
      { date: 'Wed, 02 Sep 2026 12:00:00 GMT', 'last-modified': 'Wed, 02 Sep 2026 12:00:00 GMT' },
      { 'last-modified': 'Thu, 03 Sep 2026 12:00:00 GMT' },
      { 'last-modified': 'Wed, 02 Sep 2026 00:00:01 GMT' },
    ]) {
      const result = await resolveCitationFreshness(['https://example.com/no-date'], { observedAt, headFetch: head(vi.fn(async () => new Response(null, { status: 200, headers } as ResponseInit)) as unknown as typeof fetch) })
      expect(result[0]?.dateSource).toBe('unknown')
    }
  })

  it('blocks private literals, private DNS answers, and redirects to private hosts', async () => {
    expect(isPublicHttpUrl('http://127.0.0.1/a')).toBe(false)
    expect(isPublicHttpUrl('http://[::1]/a')).toBe(false)
    expect(isPublicHttpUrl('http://[::ffff:127.0.0.1]/a')).toBe(false)
    expect(isPublicHttpUrl('https://example.com/a', ['10.0.0.2'])).toBe(false)
    const fetchImpl = vi.fn(async () => new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/latest' } })) as unknown as typeof fetch
    const options = head(fetchImpl)
    const literal = await resolveCitationFreshness(['http://10.1.2.3/a'], { observedAt, headFetch: options })
    const privateDns = await resolveCitationFreshness(['https://private.example/a'], { observedAt, headFetch: head(fetchImpl, { resolveDns: async () => ['192.168.1.2'] }) })
    const redirect = await resolveCitationFreshness(['https://example.com/a'], { observedAt, headFetch: options })
    expect([literal[0]?.dateSource, privateDns[0]?.dateSource, redirect[0]?.dateSource]).toEqual(['unknown', 'unknown', 'unknown'])
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('passes a signal that aborts at five seconds', async () => {
    vi.useFakeTimers()
    let signal: AbortSignal | undefined
    const fetchImpl = vi.fn((_url: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      signal = init?.signal || undefined
      signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })))
    })) as unknown as typeof fetch
    const pending = resolveCitationFreshness(['https://example.com/no-date'], { observedAt, headFetch: head(fetchImpl) })
    await vi.advanceTimersByTimeAsync(5_000)
    expect(signal?.aborted).toBe(true)
    expect((await pending)[0]?.dateSource).toBe('unknown')
  })

  it('dedupes each URL and enforces one shared 100-request budget', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 200 })) as unknown as typeof fetch
    const options = head(fetchImpl)
    const urls = Array.from({ length: 101 }, (_, index) => `https://example.com/no-date-${index}`)
    await resolveCitationFreshness(urls.slice(0, 50), { observedAt, headFetch: options })
    await resolveCitationFreshness(urls.slice(50, 100), { observedAt, headFetch: options })
    await resolveCitationFreshness([urls[0]!, urls[100]!], { observedAt, headFetch: options })
    expect(fetchImpl).toHaveBeenCalledTimes(CITATION_HEAD_MAX_REQUESTS)
    expect(options.budget.used).toBe(100)
  })
})

import { describe, expect, it, vi } from 'vitest'
import { safeFetch, SiteEvidenceFetchError } from '../server/site-evidence/fetcher'

const dnsOk = vi.fn(async () => undefined)
const html = (body: string, init: ResponseInit = {}) => new Response(body, { status: 200, headers: { 'content-type': 'text/html', ...(init.headers || {}) }, ...init })

describe('site evidence safe fetcher', () => {
  it('records redirects and revalidates DNS at every hop', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      const url = String(input)
      if (url.endsWith('/start')) return new Response(null, { status: 302, headers: { location: '/middle' } })
      if (url.endsWith('/middle')) return new Response(null, { status: 301, headers: { location: 'https://www.example.com/final' } })
      return html('<h1>done</h1>')
    })
    const result = await safeFetch('https://example.com/start', { purpose: 'page', fetchImpl, dnsCheck: dnsOk })
    expect(result.finalUrl).toBe('https://www.example.com/final')
    expect(result.redirectChain).toEqual([{ url: 'https://example.com/start', status: 302 }, { url: 'https://example.com/middle', status: 301 }])
    expect(dnsOk).toHaveBeenCalledTimes(3)
  })

  it('maps a private DNS target introduced by a redirect to a stable code', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(null, { status: 302, headers: { location: 'https://private.example/secret' } }))
    const dnsCheck = vi.fn(async (host: string) => { if (host === 'private.example') throw new Error('private_network_target') })
    await expect(safeFetch('https://example.com/', { purpose: 'page', fetchImpl, dnsCheck })).rejects.toMatchObject({ code: 'private_network_target' })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('enforces five redirects, response bytes, timeout, and content types', async () => {
    const redirects = vi.fn<typeof fetch>(async input => {
      const current = Number(new URL(String(input)).pathname.slice(1) || 0)
      return new Response(null, { status: 302, headers: { location: `/${current + 1}` } })
    })
    await expect(safeFetch('https://example.com/0', { purpose: 'page', fetchImpl: redirects, dnsCheck: dnsOk })).rejects.toMatchObject({ code: 'redirect_limit' })
    expect(redirects).toHaveBeenCalledTimes(6)

    await expect(safeFetch('https://example.com/', { purpose: 'page', fetchImpl: async () => html('large', { headers: { 'content-type': 'text/html', 'content-length': '100' } }), dnsCheck: dnsOk, maxBytes: 10 })).rejects.toMatchObject({ code: 'response_too_large' })
    await expect(safeFetch('https://example.com/', { purpose: 'page', fetchImpl: async () => new Response('{}', { headers: { 'content-type': 'application/json' } }), dnsCheck: dnsOk })).rejects.toMatchObject({ code: 'unsupported_content_type' })

    const hanging = vi.fn<typeof fetch>((_input, init) => new Promise((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })))
    await expect(safeFetch('https://example.com/', { purpose: 'page', fetchImpl: hanging, dnsCheck: dnsOk, timeoutMs: 5 })).rejects.toMatchObject({ code: 'fetch_timeout' })

    const hangingBody = vi.fn<typeof fetch>(async (_input, init) => {
      let streamController: ReadableStreamDefaultController<Uint8Array>
      const stream = new ReadableStream<Uint8Array>({ start(controller) { streamController = controller; controller.enqueue(new TextEncoder().encode('partial')) } })
      init?.signal?.addEventListener('abort', () => streamController.error(new DOMException('aborted', 'AbortError')), { once: true })
      return new Response(stream, { headers: { 'content-type': 'text/html' } })
    })
    await expect(safeFetch('https://example.com/', { purpose: 'page', fetchImpl: hangingBody, dnsCheck: dnsOk, timeoutMs: 5 })).rejects.toMatchObject({ code: 'fetch_timeout' })
  })

  it('sends no cookie or authorization header', async () => {
    let sent = new Headers()
    await safeFetch('https://example.com/', { purpose: 'page', dnsCheck: dnsOk, fetchImpl: async (_input, init) => { sent = new Headers(init?.headers); return html('ok') } })
    expect([...sent.keys()].sort()).toEqual(['accept', 'user-agent'])
    expect(sent.get('cookie')).toBeNull()
    expect(sent.get('authorization')).toBeNull()
    expect(sent.get('user-agent')).toBe('DiscoveryStack-SiteEvidence/1.0')
  })

  it('exposes only the documented stable fetch codes', () => {
    expect(new SiteEvidenceFetchError('fetch_failed').code).toBe('fetch_failed')
  })
})

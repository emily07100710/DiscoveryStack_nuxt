import { describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { captureAuthorizedLivePage, type LiveAcquisitionAuthority } from '../server/learning-loop/live-page-fetcher'
import type { LearningAuthoritySelector } from '../server/site-evidence/learning-crawler'

const nowValue = new Date('2026-10-07T00:00:00.000Z')
const selector: LearningAuthoritySelector = { ownerUserId: 7, clientId: 11, sourceId: 13 }
const pageUrl = 'https://example.test/published'
const address = [{ address: '93.184.216.34', family: 4 }]

function grant(overrides: Partial<LiveAcquisitionAuthority['authority']> = {}): LiveAcquisitionAuthority {
  return {
    authorizationFingerprint: 'c'.repeat(64),
    authority: {
      ownerUserId: selector.ownerUserId,
      clientId: selector.clientId,
      sourceId: selector.sourceId,
      sourceUrl: 'https://example.test/source',
      authorizedHost: 'example.test',
      sourceFingerprint: 'a'.repeat(64),
      authorizationStatus: 'active',
      rightsBasis: 'owner_authorized',
      rightsReviewStatus: 'approved',
      allowModelImprovement: true,
      consentVersion: 'consent-v1',
      consentReceiptHash: 'b'.repeat(64),
      approvedAt: new Date('2026-10-01T00:00:00.000Z'),
      expiresAt: new Date('2026-10-08T00:00:00.000Z'),
      revokedAt: null,
      sourceStatus: 'training_candidate',
      termsAllowTraining: true,
      piiReviewStatus: 'none_detected',
      retentionActive: true,
      removalRequested: false,
      ...overrides,
    },
  }
}

function response(statusCode: number, contentType: string, body: string | Buffer): { statusCode: number; headers: Record<string, string>; body: Buffer } {
  return { statusCode, headers: { 'content-type': contentType }, body: Buffer.isBuffer(body) ? body : Buffer.from(body) }
}

const robotsAllow = () => response(200, 'text/plain; charset=utf-8', 'User-agent: *\nAllow: /\n')
const notFound = () => response(404, 'text/html; charset=utf-8', '<html>not found</html>')

function controlledHtml(): string {
  const title = 'Release overview'
  const body = 'This page explains the latest approved update.'
  const contentHash = createHash('sha256').update(body).digest('hex')
  return `<html><head><link rel="canonical" href="${pageUrl}"></head><body><main><article data-ds-live-content="v1" data-ds-publication-id="publication-7" data-ds-draft-id="draft-11" data-ds-review-id="review-13" data-ds-content-hash="${contentHash}" data-ds-evidence-hash="${'d'.repeat(64)}"><h1 data-ds-live-title="">${title}</h1><section data-ds-live-body=""><p>${body}</p></section></article></main></body></html>`
}

function deps(overrides: Record<string, unknown> = {}) {
  return {
    resolveCurrentAuthority: vi.fn(async () => grant()),
    dnsLookup: vi.fn(async () => address),
    transport: vi.fn(async ({ request }: { request: any }) => request.path === '/robots.txt' ? robotsAllow() : notFound()),
    now: () => new Date(nowValue),
    ...overrides,
  }
}

describe('captureAuthorizedLivePage', () => {
  it('does no DNS or HTTP work without a current grant', async () => {
    const d = deps({ resolveCurrentAuthority: vi.fn(async () => null) })
    const result = await captureAuthorizedLivePage({ selector, publicationUrl: pageUrl }, d as any)
    expect(result).toMatchObject({ status: 'blocked', projection: null, reasonCode: 'AUTHORIZATION_NOT_CURRENT' })
    expect(d.dnsLookup).not.toHaveBeenCalled()
    expect(d.transport).not.toHaveBeenCalled()
  })

  it('rejects caller-supplied authority fields instead of forwarding them to the resolver', async () => {
    const d = deps()
    const result = await captureAuthorizedLivePage({ selector: { ...selector, ownerUserId: 999, url: pageUrl } as any, publicationUrl: pageUrl }, d as any)
    expect(result).toMatchObject({ status: 'blocked', reasonCode: 'INVALID_SELECTOR' })
    expect(d.resolveCurrentAuthority).not.toHaveBeenCalled()
    expect(d.dnsLookup).not.toHaveBeenCalled()
    expect(d.transport).not.toHaveBeenCalled()
  })

  it('rejects query, fragment, credential and non-standard-port publication URLs before DNS', async () => {
    for (const publicationUrl of ['https://example.test:8443/published', 'https://user@example.test/published', 'https://example.test/published?x=1', 'https://example.test/published#']) {
      const d = deps()
      const result = await captureAuthorizedLivePage({ selector, publicationUrl }, d as any)
      expect(result.status).toBe('blocked')
      expect(d.dnsLookup).not.toHaveBeenCalled()
      expect(d.transport).not.toHaveBeenCalled()
    }
  })

  it('blocks mixed public/private DNS results before any pinned request', async () => {
    const d = deps({ dnsLookup: vi.fn(async () => [...address, { address: '10.0.0.8', family: 4 }]) })
    const result = await captureAuthorizedLivePage({ selector, publicationUrl: pageUrl }, d as any)
    expect(result).toMatchObject({ status: 'blocked', reasonCode: 'SCOPE_REJECTED', projection: null })
    expect(d.transport).not.toHaveBeenCalled()
  })

  it('fails closed when authority is revoked after DNS but before the request', async () => {
    let valid = true
    const d = deps({
      resolveCurrentAuthority: vi.fn(async () => valid ? grant() : null),
      dnsLookup: vi.fn(async () => { valid = false; return address }),
    })
    const result = await captureAuthorizedLivePage({ selector, publicationUrl: pageUrl }, d as any)
    expect(result).toMatchObject({ status: 'blocked', reasonCode: 'AUTHORIZATION_CHANGED' })
    expect(d.transport).not.toHaveBeenCalled()
  })

  it('fails closed when the grant expires during DNS resolution', async () => {
    let now = new Date(nowValue)
    const d = deps({
      now: () => new Date(now),
      resolveCurrentAuthority: vi.fn(async () => grant({ expiresAt: new Date(nowValue.getTime() + 1_000) })),
      dnsLookup: vi.fn(async () => { now = new Date(nowValue.getTime() + 1_001); return address }),
    })
    const result = await captureAuthorizedLivePage({ selector, publicationUrl: pageUrl }, d as any)
    expect(result).toMatchObject({ status: 'blocked', reasonCode: 'AUTHORIZATION_CHANGED' })
    expect(d.transport).not.toHaveBeenCalled()
  })

  it('drops the projection when authority changes while the page body is acquired', async () => {
    let valid = true
    let requests = 0
    const d = deps({
      resolveCurrentAuthority: vi.fn(async () => valid ? grant() : null),
      transport: vi.fn(async ({ request }: { request: any }) => {
        requests += 1
        if (request.path === '/robots.txt') return robotsAllow()
        valid = false
        return notFound()
      }),
    })
    const result = await captureAuthorizedLivePage({ selector, publicationUrl: pageUrl }, d as any)
    expect(requests).toBe(2)
    expect(result).toMatchObject({ status: 'blocked', reasonCode: 'AUTHORIZATION_CHANGED', projection: null, capturedAt: null })
  })

  it('drops the projection when the grant expires while the page body is acquired', async () => {
    let now = new Date(nowValue)
    const expiresAt = new Date(nowValue.getTime() + 10_000)
    const d = deps({
      now: () => new Date(now),
      resolveCurrentAuthority: vi.fn(async () => grant({ expiresAt })),
      transport: vi.fn(async ({ request }: { request: any }) => {
        if (request.path === '/robots.txt') return robotsAllow()
        now = new Date(expiresAt.getTime() + 1)
        return notFound()
      }),
    })
    const result = await captureAuthorizedLivePage({ selector, publicationUrl: pageUrl }, d as any)
    expect(result).toMatchObject({ status: 'blocked', reasonCode: 'AUTHORIZATION_CHANGED', projection: null, capturedAt: null })
  })

  it('requires fresh same-origin robots permission and never follows redirects', async () => {
    const denied = deps({ transport: vi.fn(async ({ request }: { request: any }) => response(200, 'text/plain', 'User-agent: *\nDisallow: /published\n')) })
    const deniedResult = await captureAuthorizedLivePage({ selector, publicationUrl: pageUrl }, denied as any)
    expect(deniedResult).toMatchObject({ status: 'blocked', projection: null })
    expect(denied.transport).toHaveBeenCalledTimes(1)

    let calls = 0
    const redirect = deps({ transport: vi.fn(async ({ request }: { request: any }) => {
      calls += 1
      return request.path === '/robots.txt' ? robotsAllow() : response(302, 'text/html', '<html>redirect</html>')
    }) })
    const redirectResult = await captureAuthorizedLivePage({ selector, publicationUrl: pageUrl }, redirect as any)
    expect(redirectResult.status).toBe('blocked')
    expect(calls).toBe(2)
    expect(redirect.transport).toHaveBeenCalledTimes(2)
  })

  it('requires strict MIME/UTF-8 and rejects an oversized streamed response', async () => {
    const malformed = deps({ transport: vi.fn(async ({ request }: { request: any }) => request.path === '/robots.txt' ? robotsAllow() : response(200, 'text/html; charset=made-up', '<html/>')) })
    expect((await captureAuthorizedLivePage({ selector, publicationUrl: pageUrl }, malformed as any)).status).toBe('blocked')

    const tooLarge = deps({ transport: vi.fn(async ({ request }: { request: any }) => request.path === '/robots.txt' ? robotsAllow() : response(404, 'text/html', Buffer.alloc(256 * 1024 + 1))) })
    expect((await captureAuthorizedLivePage({ selector, publicationUrl: pageUrl }, tooLarge as any)).status).toBe('blocked')
  })

  it('rejects compressed encodings on robots and page responses even when the supplied body is plain text', async () => {
    const encodedRobots = deps({ transport: vi.fn(async () => ({ ...robotsAllow(), headers: { ...robotsAllow().headers, 'content-encoding': 'gzip' } })) })
    const robotsResult = await captureAuthorizedLivePage({ selector, publicationUrl: pageUrl }, encodedRobots as any)
    expect(robotsResult).toMatchObject({ status: 'blocked', reasonCode: 'CONTENT_REJECTED', projection: null })
    expect(encodedRobots.transport).toHaveBeenCalledTimes(1)

    const encodedPage = deps({ transport: vi.fn(async ({ request }: { request: any }) => request.path === '/robots.txt'
      ? robotsAllow()
      : ({ ...response(200, 'text/html; charset=utf-8', controlledHtml()), headers: { 'content-type': 'text/html; charset=utf-8', 'content-encoding': 'br' } })) })
    const pageResult = await captureAuthorizedLivePage({ selector, publicationUrl: pageUrl }, encodedPage as any)
    expect(pageResult).toMatchObject({ status: 'blocked', reasonCode: 'CONTENT_REJECTED', projection: null, capturedAt: null })
    expect(encodedPage.transport).toHaveBeenCalledTimes(2)
  }, 5_000)

  it('reports uninstrumented HTML separately from unsafe content', async () => {
    const uninstrumented = deps({ transport: vi.fn(async ({ request }: { request: any }) => request.path === '/robots.txt'
      ? robotsAllow()
      : response(200, 'text/html; charset=utf-8', '<html><body>ordinary uninstrumented content</body></html>')) })
    const result = await captureAuthorizedLivePage({ selector, publicationUrl: pageUrl }, uninstrumented as any)
    expect(result).toMatchObject({ status: 'blocked', reasonCode: 'PROJECTION_NOT_VERIFIED', projection: null, capturedAt: null })
  }, 5_000)

  it('pins one validated address while retaining hostname TLS verification and credential-free headers', async () => {
    const calls: Array<{ request: any; at: number }> = []
    const d = deps({ transport: vi.fn(async ({ request }: { request: any }) => {
      calls.push({ request, at: performance.now() })
      return request.path === '/robots.txt' ? robotsAllow() : notFound()
    }) })
    const result = await captureAuthorizedLivePage({ selector, publicationUrl: pageUrl }, d as any)
    expect(result).toMatchObject({ status: 'captured', projection: { kind: 'not_found' }, authorizationFingerprint: 'c'.repeat(64), sourceFingerprint: 'a'.repeat(64), consentReceiptHash: 'b'.repeat(64) })
    expect(calls).toHaveLength(2)
    for (const { request } of calls) {
      expect(request).toMatchObject({ hostname: 'example.test', port: 443, method: 'GET', agent: false, rejectUnauthorized: true, servername: 'example.test' })
      expect(request.headers['Accept-Encoding']).toBe('identity')
      expect(request.headers).not.toHaveProperty('Cookie')
      expect(request.headers).not.toHaveProperty('Authorization')
      const pinned = await new Promise<any>((resolve, reject) => request.lookup('example.test', { all: true }, (error: unknown, rows: unknown) => error ? reject(error) : resolve(rows)))
      expect(pinned).toEqual(address)
    }
    expect(calls[1]!.at - calls[0]!.at).toBeGreaterThanOrEqual(950)
    const serialized = JSON.stringify(result)
    expect(serialized).not.toContain('example.test')
    expect(serialized).not.toContain('not found')
  }, 5_000)

  it('returns only the semantic projection for an exact controlled 200 page', async () => {
    const html = controlledHtml()
    const d = deps({ transport: vi.fn(async ({ request }: { request: any }) => request.path === '/robots.txt' ? robotsAllow() : response(200, 'text/html; charset=utf-8', html)) })
    const result = await captureAuthorizedLivePage({ selector, publicationUrl: pageUrl }, d as any)
    expect(result.status).toBe('captured')
    expect(result.projection).toMatchObject({ contractVersion: 'learning-live-page-projection-v1', kind: 'controlled_document' })
    const serialized = JSON.stringify(result)
    expect(serialized).not.toContain(pageUrl)
    expect(serialized).not.toContain('Release overview')
    expect(serialized).not.toContain('latest approved update')
  }, 5_000)

  it('validates a public literal IP without weakening TLS verification', async () => {
    const calls: any[] = []
    const d = deps({
      dnsLookup: vi.fn(async () => { throw new Error('literal IP should not use DNS') }),
      transport: vi.fn(async ({ request }: { request: any }) => { calls.push(request); return request.path === '/robots.txt' ? robotsAllow() : notFound() }),
    })
    const result = await captureAuthorizedLivePage({ selector, publicationUrl: 'https://93.184.216.34/published' }, {
      ...d,
      resolveCurrentAuthority: vi.fn(async () => grant({ sourceUrl: 'https://93.184.216.34/source', authorizedHost: '93.184.216.34' })),
    } as any)
    expect(result.status).toBe('captured')
    expect(d.dnsLookup).not.toHaveBeenCalled()
    expect(calls[0]).toMatchObject({ hostname: '93.184.216.34', rejectUnauthorized: true, agent: false })
    expect(calls[0]).not.toHaveProperty('servername')
  }, 5_000)

  it('bounds DNS and HTTP/body waits by the single acquisition deadline', async () => {
    const dnsHang = deps({ deadlineMs: 20, dnsLookup: vi.fn(() => new Promise<never>(() => {})) })
    expect(await captureAuthorizedLivePage({ selector, publicationUrl: pageUrl }, dnsHang as any)).toMatchObject({ status: 'deferred', reasonCode: 'DEADLINE_REACHED', projection: null })
    expect(dnsHang.transport).not.toHaveBeenCalled()

    const bodyHang = deps({ deadlineMs: 20, transport: vi.fn(() => new Promise<never>(() => {})) })
    expect(await captureAuthorizedLivePage({ selector, publicationUrl: pageUrl }, bodyHang as any)).toMatchObject({ status: 'deferred', reasonCode: 'DEADLINE_REACHED', projection: null })
    expect(bodyHang.transport).toHaveBeenCalledTimes(1)
  })
})

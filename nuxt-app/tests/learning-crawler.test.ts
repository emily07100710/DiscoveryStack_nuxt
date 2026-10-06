import { describe, expect, it, vi } from 'vitest'
import { collectLearningEvidence, type LearningAuthority, type LearningAuthoritySelector } from '../server/site-evidence/learning-crawler'

const selector: LearningAuthoritySelector = { ownerUserId: 7, clientId: 11, sourceId: 13 }
const authority: LearningAuthority = {
  ownerUserId: 7, clientId: 11, sourceId: 13,
  sourceUrl: 'https://owner.example/', authorizedHost: 'owner.example', sourceFingerprint: 'b'.repeat(64), authorizationStatus: 'active',
  rightsBasis: 'owner_authorized', rightsReviewStatus: 'approved', allowModelImprovement: true,
  consentVersion: 'model-improvement-v1', consentReceiptHash: 'a'.repeat(64),
  approvedAt: '2026-10-01T00:00:00.000Z', expiresAt: '2026-11-01T00:00:00.000Z', revokedAt: null,
  sourceStatus: 'training_candidate', termsAllowTraining: true, piiReviewStatus: 'none_detected',
  retentionActive: true, removalRequested: false,
}
const fixedNow = () => new Date('2026-10-06T00:00:00.000Z')
const html = (links = '') => `<html><head><title>Private title must not escape</title></head><body><h1>Private heading</h1>${links}</body></html>`
const okHtml = (body = html()) => new Response(body, { status: 200, headers: { 'content-type': 'text/html' } })
const okRobots = (body = 'User-agent: *\nAllow: /') => new Response(body, { status: 200, headers: { 'content-type': 'text/plain' } })

function dependencies(fetchImpl: typeof fetch, overrides: Partial<Parameters<typeof collectLearningEvidence>[1]> = {}) {
  return {
    resolveCurrentAuthority: vi.fn(async () => authority), fetchImpl, dnsCheck: async () => undefined,
    now: fixedNow, sleep: async () => undefined, ...overrides,
  }
}

describe('governed learning evidence crawler', () => {
  it('does zero DNS and HTTP I/O for missing, wrong-owner, expired, revoked, or incomplete authority', async () => {
    const invalidAuthorities: Array<LearningAuthority | null> = [
      null,
      { ...authority, ownerUserId: 8 },
      { ...authority, expiresAt: '2026-10-06T00:00:00.000Z' },
      { ...authority, revokedAt: new Date('2026-10-05T00:00:00.000Z') as never },
      { ...authority, termsAllowTraining: false as never },
      { ...authority, piiReviewStatus: 'unknown' as never },
    ]
    for (const current of invalidAuthorities) {
      const fetchImpl = vi.fn<typeof fetch>()
      const dnsCheck = vi.fn(async () => undefined)
      const result = await collectLearningEvidence(selector, dependencies(fetchImpl, {
        resolveCurrentAuthority: vi.fn(async () => current), dnsCheck,
      }))
      expect(result.status).toBe('blocked_authorization')
      expect(result.pages).toEqual([])
      expect(fetchImpl).not.toHaveBeenCalled()
      expect(dnsCheck).not.toHaveBeenCalled()
    }
  })

  it('stops before any page when robots is unavailable or disallows the seed', async () => {
    for (const robotsResponse of [
      new Response('temporary error', { status: 503, headers: { 'content-type': 'text/plain' } }),
      okRobots('User-agent: *\nDisallow: /'),
    ]) {
      const paths: string[] = []
      const fetchImpl = vi.fn<typeof fetch>(async input => {
        const url = new URL(String(input)); paths.push(url.pathname)
        return url.pathname === '/robots.txt' ? robotsResponse : okHtml()
      })
      const result = await collectLearningEvidence(selector, dependencies(fetchImpl))
      expect(result.status).toBe('blocked_robots')
      expect(result.pages).toEqual([])
      expect(paths).toEqual(['/robots.txt'])
    }
  })

  it('bounds a hung initial authority lookup by the total deadline without starting crawl I/O', async () => {
    vi.useFakeTimers()
    try {
      const fetchImpl = vi.fn<typeof fetch>()
      const dnsCheck = vi.fn(async () => undefined)
      let releaseAuthority!: (value: LearningAuthority | null) => void
      const pendingAuthority = new Promise<LearningAuthority | null>(resolve => { releaseAuthority = resolve })
      const resultPromise = collectLearningEvidence(selector, dependencies(fetchImpl, {
        resolveCurrentAuthority: vi.fn(() => pendingAuthority), dnsCheck,
      }))
      await vi.advanceTimersByTimeAsync(30_001)
      const result = await resultPromise
      expect(result.reasonCode).toBe('DEADLINE_REACHED')
      releaseAuthority(authority)
      await Promise.resolve()
      expect(fetchImpl).not.toHaveBeenCalled()
      expect(dnsCheck).not.toHaveBeenCalled()
    } finally { vi.useRealTimers() }
  })

  it('bounds a hung DNS lookup by the total deadline and never sends HTTP afterward', async () => {
    vi.useFakeTimers()
    try {
      let signalDnsStarted!: () => void
      let releaseDns!: () => void
      const dnsStarted = new Promise<void>(resolve => { signalDnsStarted = resolve })
      const fetchImpl = vi.fn<typeof fetch>()
      const dnsCheck = vi.fn(() => {
        signalDnsStarted()
        return new Promise<void>(resolve => { releaseDns = resolve })
      })
      const resultPromise = collectLearningEvidence(selector, dependencies(fetchImpl, { dnsCheck }))
      await dnsStarted
      await vi.advanceTimersByTimeAsync(30_001)
      const result = await resultPromise
      expect(result).toMatchObject({ status: 'completed_partial', reasonCode: 'DEADLINE_REACHED', pages: [] })
      releaseDns()
      await Promise.resolve()
      expect(fetchImpl).not.toHaveBeenCalled()
    } finally { vi.useRealTimers() }
  })

  it('bounds a hung HTTP fetch and returns the deadline reason', async () => {
    vi.useFakeTimers()
    try {
      const fetchImpl = vi.fn<typeof fetch>(() => new Promise<Response>(() => {}))
      const resultPromise = collectLearningEvidence(selector, dependencies(fetchImpl))
      await vi.advanceTimersByTimeAsync(30_001)
      const result = await resultPromise
      expect(result).toMatchObject({ status: 'completed_partial', reasonCode: 'DEADLINE_REACHED', pages: [] })
      expect(fetchImpl).toHaveBeenCalledTimes(1)
    } finally { vi.useRealTimers() }
  })

  it('rejects cross-host and private redirects before resolving or requesting the redirect target', async () => {
    for (const destination of ['https://other.example/private', 'https://127.0.0.1/admin']) {
      const requested: string[] = []
      const resolvedDns: string[] = []
      const fetchImpl = vi.fn<typeof fetch>(async input => {
        const url = new URL(String(input)); requested.push(url.origin + url.pathname)
        return url.pathname === '/robots.txt'
          ? okRobots()
          : new Response(null, { status: 302, headers: { location: destination } })
      })
      const result = await collectLearningEvidence(selector, dependencies(fetchImpl, {
        dnsCheck: async hostname => { resolvedDns.push(hostname) },
      }))
      expect(result.status).toBe('completed_partial')
      expect(['SCOPE_REJECTED', 'PRIVATE_NETWORK_TARGET']).toContain(result.reasonCode)
      expect(requested).toEqual(['https://owner.example/robots.txt', 'https://owner.example/'])
      expect(resolvedDns).toEqual(['owner.example', 'owner.example'])
      expect(JSON.stringify(result)).not.toContain(destination)
    }
  })

  it('checks robots policy on every same-host redirect hop', async () => {
    const requested: string[] = []
    const fetchImpl = vi.fn<typeof fetch>(async input => {
      const url = new URL(String(input)); requested.push(url.pathname)
      if (url.pathname === '/robots.txt') return okRobots('User-agent: *\nDisallow: /blocked')
      return new Response(null, { status: 302, headers: { location: '/blocked/private' } })
    })
    const result = await collectLearningEvidence(selector, dependencies(fetchImpl))
    expect(result).toMatchObject({ status: 'completed_partial', reasonCode: 'SCOPE_REJECTED', pages: [] })
    expect(requested).toEqual(['/robots.txt', '/'])
  })

  it('rechecks consent before each hop and discards the projection if consent is revoked mid-run', async () => {
    let resolutions = 0
    const fetchImpl = vi.fn<typeof fetch>(async input => new URL(String(input)).pathname === '/robots.txt' ? okRobots() : okHtml())
    const result = await collectLearningEvidence(selector, dependencies(fetchImpl, {
      resolveCurrentAuthority: vi.fn(async () => {
        resolutions += 1
        return resolutions >= 4 ? { ...authority, revokedAt: '2026-10-06T00:00:00.000Z' as never } : authority
      }),
    }))
    expect(result).toMatchObject({ status: 'blocked_authorization', reasonCode: 'AUTHORIZATION_NO_LONGER_CURRENT', pages: [] })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('deduplicates links, honors depth and page caps, and returns only hashes and bounded structure', async () => {
    const paths: string[] = []
    const manyLinks = Array.from({ length: 30 }, (_, index) => `<a href="/p${index}">link</a>`).join('')
    const fetchImpl = vi.fn<typeof fetch>(async input => {
      const url = new URL(String(input)); paths.push(url.pathname)
      if (url.pathname === '/robots.txt') return okRobots()
      if (url.pathname === '/') return okHtml(html(`${manyLinks}<a href="/p0">duplicate</a>`))
      return okHtml('<a href="/">back</a>')
    })
    const result = await collectLearningEvidence(selector, dependencies(fetchImpl))
    expect(result.status).toBe('completed_partial')
    expect(result.reasonCode).toBe('PAGE_CAP_REACHED')
    expect(result.pagesAttempted).toBe(20)
    expect(result.pagesCaptured).toBe(20)
    expect(result.pages.every(page => page.depth <= 2)).toBe(true)
    expect(result.duplicatePagesSkipped).toBeGreaterThan(0)
    expect(result.pages[0]).toMatchObject({
      contentHash: expect.stringMatching(/^[a-f0-9]{64}$/u), urlHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
      evidenceLabel: 'unknown', structural: { titlePresent: true, h1Present: true },
    })
    expect(JSON.stringify(result)).not.toContain('owner.example')
    expect(JSON.stringify(result)).not.toContain('Private title')
    expect(JSON.stringify(result)).not.toContain('Private heading')
    expect(result.labels).toEqual({ aiCitation: 'unknown', searchVisibility: 'unknown', businessOutcome: 'unknown' })
    expect(result.requiresHumanReview).toBe(true)
    expect(paths.length).toBe(21) // one robots request plus twenty page attempts
  })
})

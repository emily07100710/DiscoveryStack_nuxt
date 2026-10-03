import { describe, expect, it } from 'vitest'
import { buildBotRobotsFindings, buildObservedInternalLinkFindings } from '../server/site-evidence/access-and-link-findings'
import { buildSiteEvidenceFindings, type FindingInventoryItem } from '../server/site-evidence/findings'
import { extractHtmlSignals } from '../server/site-evidence/html'
import { normalizeUrl, urlHash } from '../server/site-evidence/normalization'

function page(id: number, path: string, links: string[] = [], patch: Partial<FindingInventoryItem> = {}): FindingInventoryItem {
  const url = `https://example.com${path}`
  return { id, ownerUserId: 1, siteHost: 'example.com', url, normalizedUrl: normalizeUrl(url), urlHash: urlHash(url), lastScanId: 7, discoverySources: ['crawl'], canonicalUrl: null, robotsVerdict: 'allowed', robotsMatchedRule: null, metaRobots: null, xRobotsTag: null, httpStatus: 200, redirectChain: [], finalUrl: url, contentHash: 'a'.repeat(64), contentType: 'text/html', bytesFetched: 100, errorCode: null, firstSeenAt: new Date('2026-01-01T00:00:00Z'), lastFetchedAt: new Date('2026-01-01T00:00:00Z'), rawSignals: extractHtmlSignals(`<h1>Page</h1><p>Observed text.</p>${links.map(link => `<a href="${link}">Link</a>`).join('')}`, url), ...patch }
}
const scope = { targetOrigin: 'https://example.com', sitemaps: [] }

describe('observed internal link findings', () => {
  it('computes unique edges and shortest observed homepage depth without self links or rendered links', () => {
    const inventory = [page(1, '/', ['/a', '/a#part', '/']), page(2, '/a', ['/b']), page(3, '/b')]
    const findings = buildObservedInternalLinkFindings({ ...scope, inventory })
    expect(findings[0]).toMatchObject({ category: 'observed_internal_link_graph', status: 'detected', evidence: { edgeCount: 2, scopeComplete: true, nodes: [{ urlId: 1, incomingLinks: 0, outgoingLinks: 1, observedClickDepth: 0 }, { urlId: 2, incomingLinks: 1, outgoingLinks: 1, observedClickDepth: 1 }, { urlId: 3, incomingLinks: 1, outgoingLinks: 0, observedClickDepth: 2 }] } })
    expect(findings.some(item => item.category === 'orphan_page_candidate')).toBe(false)
    expect(buildObservedInternalLinkFindings({ ...scope, inventory: [...inventory].reverse() })).toEqual(findings)
  })

  it('reports broken links only for observed 404 or 410, keeping denied, failed and unattempted targets unknown', () => {
    const inventory = [page(1, '/', ['/missing', '/gone', '/denied', '/failed', '/unseen']), page(2, '/missing', [], { httpStatus: 404 }), page(3, '/gone', [], { httpStatus: 410 }), page(4, '/denied', [], { httpStatus: 403 }), page(5, '/failed', [], { httpStatus: null, errorCode: 'dns_lookup_failed', rawSignals: null })]
    const findings = buildObservedInternalLinkFindings({ ...scope, inventory })
    expect(findings.filter(item => item.category === 'broken_internal_link').map(item => item.evidence.observedHttpStatus)).toEqual([410, 404])
    expect(findings.filter(item => item.category === 'internal_link_target_unknown')).toHaveLength(3)
    expect(findings.find(item => item.category === 'internal_link_target_unknown' && item.evidence.targetUrlId === null)).toMatchObject({ status: 'unknown', evidence: { reason: 'target_not_attempted' } })
  })

  it('does not call zero observed inbound links a confirmed orphan when the scan is partial', () => {
    const input = { ...scope, inventory: [page(1, '/'), page(2, '/orphan')], limitations: ['page_cap_reached'] }
    expect(buildObservedInternalLinkFindings(input).find(item => item.category === 'orphan_page_candidate')).toMatchObject({ status: 'unknown', evidence: { limitations: ['page_cap_reached'] } })
  })

  it('keeps depth unknown without an observed homepage and omits non-HTML sources', () => {
    const findings = buildObservedInternalLinkFindings({ ...scope, inventory: [page(1, '/a', ['/b'], { contentType: 'image/png' }), page(2, '/b')] })
    expect(findings[0]).toMatchObject({ status: 'unknown', evidence: { edgeCount: 0, nodes: [{ urlId: 2, observedClickDepth: null }] } })
  })

  it('uses raw links only and does not expose URL query values in new evidence', () => {
    const source = page(1, '/', ['/a?token=synthetic-secret', 'https://other.example/private'])
    source.renderedSignals = extractHtmlSignals('<a href="/rendered-only">Link</a>', source.url)
    const findings = buildObservedInternalLinkFindings({ ...scope, inventory: [source] })
    expect(findings[0]?.evidence.edgeCount).toBe(1)
    expect(JSON.stringify(findings)).not.toContain('synthetic-secret')
    expect(JSON.stringify(findings)).not.toContain('rendered-only')
    expect(JSON.stringify(findings)).not.toContain('other.example')
  })

  it('caps graph and individual findings without pretending the truncated graph is complete', () => {
    const inventory = [page(1, '/', Array.from({ length: 2_001 }, (_, index) => `/p-${index}`))]
    const findings = buildObservedInternalLinkFindings({ ...scope, inventory })
    expect(findings[0]).toMatchObject({ status: 'unknown', evidence: { edgeCount: 2_000, scopeComplete: false, limitations: expect.arrayContaining(['internal_link_edge_cap_reached']) } })
    expect(findings.filter(item => item.category === 'internal_link_target_unknown')).toHaveLength(50)
    expect(findings.some(item => item.category === 'internal_link_findings_truncated')).toBe(true)
  })
})

describe('per-purpose robots findings', () => {
  it('distinguishes search and training rules using the captured robots content without asserting crawler or WAF proof', () => {
    const robotsContent = 'User-agent: *\nDisallow: /\nUser-agent: OAI-SearchBot\nAllow: /\nUser-agent: GPTBot\nDisallow: /'
    const inventory = [page(1, '/page?token=synthetic-secret')]
    const result = buildBotRobotsFindings({ ...scope, inventory, robotsContent, robotsCapturedAt: new Date('2026-01-01T00:00:00Z') })[0]!
    expect(result).toMatchObject({ status: 'detected', evidence: { capturedAt: '2026-01-01T00:00:00.000Z', identityVerified: false, crawlerObserved: false, wafVerified: false, policyChanged: false, bots: expect.arrayContaining([{ robotsToken: 'OAI-SearchBot', purpose: 'search', verdict: 'allowed', matchedRuleFingerprint: expect.any(String) }, { robotsToken: 'GPTBot', purpose: 'training', verdict: 'disallowed', matchedRuleFingerprint: expect.any(String) }]) } })
    expect(JSON.stringify(result)).not.toContain('synthetic-secret')
  })

  it.each([undefined, null, 'bad robots line'])('keeps missing or malformed robots unknown (%s)', robotsContent => {
    const result = buildBotRobotsFindings({ ...scope, inventory: [page(1, '/')], robotsContent, robotsCapturedAt: new Date('invalid') })[0]!
    expect(result.status).toBe('unknown')
    expect(result.evidence.capturedAt).toBe(null)
    expect(result.evidence.bots).toEqual(expect.arrayContaining([expect.objectContaining({ verdict: 'unknown' })]))
  })

  it('is reachable through the existing finding JSON contract', () => {
    const results = buildSiteEvidenceFindings({ ...scope, inventory: [page(1, '/')], robotsContent: 'User-agent: *\nAllow: /' })
    expect(results.map(result => result.category)).toEqual(expect.arrayContaining(['observed_internal_link_graph', 'bot_robots_policy']))
    expect(results.every(result => result.status === 'detected' || result.status === 'unknown')).toBe(true)
  })
})

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createSiteEvidenceFetcher } from '../server/site-evidence/fetcher'
import { startSiteEvidenceScan, runSiteEvidenceScan } from '../server/site-evidence/service'
import type { InventoryUpsert, ScanCreate, ScanPatch, SiteEvidenceFinding, SiteEvidenceRepository, SiteEvidenceScan, SiteEvidenceSitemap, SiteEvidenceSnapshot, SiteEvidenceUrl } from '../server/site-evidence/types'

class MemoryRepository implements SiteEvidenceRepository {
  scans: SiteEvidenceScan[] = []
  urls: SiteEvidenceUrl[] = []
  snapshots: SiteEvidenceSnapshot[] = []
  sitemaps: SiteEvidenceSitemap[] = []
  findings: Array<SiteEvidenceFinding & { ownerUserId: number, scanId: number }> = []
  async findScanByIdempotencyKey(ownerUserId: number, key: string) { return this.scans.find(scan => scan.ownerUserId === ownerUserId && scan.idempotencyKey === key) || null }
  async createScan(input: ScanCreate) {
    const row: SiteEvidenceScan = { id: this.scans.length + 1, ...input, status: 'pending', pagesDiscovered: 0, pagesFetched: 0, renderedCaptured: 0, errorCode: null, limitations: null, heartbeatAt: null, startedAt: null, finishedAt: null, updatedAt: input.createdAt }
    this.scans.push(row); return row
  }
  async getScanForOwner(id: number, owner: number) { return this.scans.find(scan => scan.id === id && scan.ownerUserId === owner) || null }
  async getScan(id: number) { return this.scans.find(scan => scan.id === id) || null }
  async updateScan(id: number, patch: ScanPatch) { const row = await this.getScan(id); if (row) Object.assign(row, patch) }
  async listScansForOwner(owner: number, limit: number) { return this.scans.filter(scan => scan.ownerUserId === owner).slice(0, limit) }
  async upsertUrl(input: InventoryUpsert) {
    const existing = this.urls.find(row => row.ownerUserId === input.ownerUserId && row.urlHash === input.urlHash)
    if (existing) { Object.assign(existing, input, { firstSeenAt: existing.firstSeenAt, discoverySources: [...new Set([...existing.discoverySources, ...input.discoverySources])] }); return existing }
    const row: SiteEvidenceUrl = { id: this.urls.length + 1, ...input }
    this.urls.push(row); return row
  }
  async insertSnapshot(input: SiteEvidenceSnapshot) { this.snapshots.push({ ...input, id: this.snapshots.length + 1 }) }
  async insertSitemap(input: SiteEvidenceSitemap) { this.sitemaps.push({ ...input, id: this.sitemaps.length + 1 }) }
  async insertFindings(input: Array<SiteEvidenceFinding & { ownerUserId: number, scanId: number }>) { this.findings.push(...input) }
  async listUrlsForScan(scan: number, owner: number, limit: number, offset: number) { return this.urls.filter(row => row.lastScanId === scan && row.ownerUserId === owner).slice(offset, offset + limit) }
  async listFindingsForScan(scan: number, owner: number) { return this.findings.filter(row => row.scanId === scan && row.ownerUserId === owner) }
  async countUrlsForScan(scan: number, owner: number) { return (await this.listUrlsForScan(scan, owner, 10_000, 0)).length }
  async countFindingsForScan(scan: number, owner: number) { return (await this.listFindingsForScan(scan, owner)).length }
}

const sitemapXml = `<urlset>
  <url><loc>https://example.com/</loc></url><url><loc>https://example.com/a</loc></url>
  <url><loc>https://example.com/blocked</loc></url><url><loc>https://example.com/redirect</loc></url>
  <url><loc>https://example.com/soft</loc></url><url><loc>https://example.com/js</loc></url><url><loc>https://example.com/large</loc></url>
</urlset>`

function siteHtml(path: string) {
  if (path === '/soft') return '<title>404 Page not found</title><h1>Missing</h1><p>Sorry.</p>'
  if (path === '/js') return '<title>JS raw</title><h1>Shell</h1><a href="/a">A</a>'
  if (path === '/blocked') return '<title>Blocked evidence</title><h1>Still fetched</h1>'
  if (path === '/final') return '<title>Final</title><h1>Redirect final</h1>'
  if (path === '/large') return `<title>Large</title><p>${'界'.repeat(210_000)}</p>`
  return `<title>${path}</title><link rel="canonical" href="https://example.com${path}"><h1>${path}</h1><a href="/a">A</a><a href="/b">B</a><a href="/c">C</a>`
}

describe('site evidence crawl orchestration', () => {
  let repository: MemoryRepository
  let fetchedPaths: string[]
  let fetchImpl: typeof fetch
  beforeEach(() => {
    repository = new MemoryRepository()
    fetchedPaths = []
    fetchImpl = vi.fn<typeof fetch>(async input => {
      const url = new URL(String(input)); fetchedPaths.push(url.pathname)
      if (url.pathname === '/robots.txt') return new Response('User-agent: *\nDisallow: /blocked\nSitemap: https://example.com/sitemap.xml', { headers: { 'content-type': 'text/plain' } })
      if (url.pathname === '/sitemap.xml') return new Response(sitemapXml, { headers: { 'content-type': 'application/xml' } })
      if (url.pathname === '/redirect') return new Response(null, { status: 301, headers: { location: '/redirect-two' } })
      if (url.pathname === '/redirect-two') return new Response(null, { status: 302, headers: { location: '/final' } })
      return new Response(siteHtml(url.pathname), { headers: { 'content-type': 'text/html', ...(url.pathname === '/c' ? { 'x-robots-tag': 'noindex' } : {}) } })
    })
  })

  it('runs an offline bounded crawl, persists evidence, and records disallowed-but-fetched URLs', async () => {
    const fetcher = createSiteEvidenceFetcher({ fetchImpl, dnsCheck: async () => undefined })
    const renderedProvider = {
      isConfigured: async () => true,
      capture: async (url: string) => url.endsWith('/js')
        ? { html: `<title>JS rendered</title><h1>Rendered</h1><p>${'main '.repeat(160)}</p><a href="/a">A</a><a href="/rendered-only">Only rendered</a>`, httpStatus: 200 }
        : { html: siteHtml(new URL(url).pathname), httpStatus: 200 },
    }
    const clock = { now: () => new Date('2026-09-01T00:00:00.000Z') }
    const scan = await startSiteEvidenceScan({ targetUrl: 'https://example.com/start', maxPages: 20, idempotencyKey: 'same-request' }, 17, { repository, clock })
    expect(await startSiteEvidenceScan({ targetUrl: 'https://different.example/', maxPages: 1, idempotencyKey: 'same-request' }, 17, { repository, clock })).toBe(scan)
    const result = await runSiteEvidenceScan(scan.id, { repository, fetcher, renderedProvider, clock, sleep: async () => undefined, requestSpacingMs: 0 })

    expect(result.status).toBe('completed')
    expect(result.pagesFetched).toBeGreaterThanOrEqual(8)
    expect(result.pagesFetched).toBeLessThanOrEqual(20)
    expect(result.pagesDiscovered).toBe(repository.urls.length)
    expect(repository.snapshots.some(row => row.kind === 'raw' && row.status === 'captured')).toBe(true)
    expect(repository.snapshots.some(row => row.kind === 'rendered' && row.status === 'captured')).toBe(true)
    expect(repository.sitemaps).toHaveLength(1)
    expect(repository.findings.map(row => row.category)).toEqual(expect.arrayContaining(['redirect_chain', 'soft_404_suspect', 'raw_missing_main_content', 'js_only_links', 'raw_rendered_mismatch']))
    const blocked = repository.urls.find(row => row.normalizedUrl === 'https://example.com/blocked')
    expect(blocked).toMatchObject({ robotsVerdict: 'disallowed', httpStatus: 200 })
    expect(fetchedPaths).toContain('/blocked')
    expect(repository.urls.every(row => row.ownerUserId === 17)).toBe(true)
    expect(repository.snapshots.every(row => !row.body || new TextEncoder().encode(row.body).byteLength <= 512 * 1024)).toBe(true)
    expect(repository.snapshots.some(row => row.bodyTruncated)).toBe(true)
  })

  it('finishes honestly with unavailable rendered snapshots and limitations', async () => {
    const siteFetch = fetchImpl
    const malformedRobotsFetch = vi.fn<typeof fetch>(async (input, init) => new URL(String(input)).pathname === '/robots.txt'
      ? new Response('malformed line\nDisallow: /orphan', { headers: { 'content-type': 'text/plain' } })
      : siteFetch(input, init))
    const fetcher = createSiteEvidenceFetcher({ fetchImpl: malformedRobotsFetch, dnsCheck: async () => undefined })
    const scan = await startSiteEvidenceScan({ targetUrl: 'https://example.com/', maxPages: 3, idempotencyKey: 'renderer-missing' }, 17, { repository })
    const result = await runSiteEvidenceScan(scan.id, { repository, fetcher, renderedProvider: { isConfigured: async () => false, capture: async () => ({ unavailable: true as const, reasonCode: 'renderer_not_configured' }) }, sleep: async () => undefined, requestSpacingMs: 0 })
    expect(result.status).toBe('completed_partial')
    expect(result.limitations).toEqual(expect.arrayContaining(['rendered_snapshots_unavailable', 'robots_txt_unavailable']))
    expect(repository.snapshots.some(row => row.kind === 'rendered' && row.status === 'unavailable' && row.reasonCode === 'renderer_not_configured')).toBe(true)
    expect(repository.findings.some(row => row.category === 'rendered_unknown' && row.status === 'unknown')).toBe(true)
    expect(repository.urls.every(row => row.robotsVerdict === 'unavailable')).toBe(true)
  })
})

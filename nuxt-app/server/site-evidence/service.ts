import { assertSafeAuditTarget } from '../audit/targetGuard'
import { buildSiteEvidenceFindings, type FindingInventoryItem } from './findings'
import { createSiteEvidenceFetcher, SiteEvidenceFetchError, type SiteEvidenceFetcher } from './fetcher'
import { extractHtmlSignals } from './html'
import { isSameSite, normalizeUrl, sha256Hex, urlHash } from './normalization'
import { createFirecrawlRenderedProvider, type RenderedSnapshotProvider } from './rendered'
import { createSiteEvidenceRepository } from './repository'
import { evaluateRobots, parseRobots } from './robots'
import { parseSitemap } from './sitemap'
import { notFound, parseStartScanInput, SITE_EVIDENCE_BODY_CAP_BYTES, type DiscoverySource, type HtmlSignals, type SiteEvidenceClock, type SiteEvidenceFinding, type SiteEvidenceLogger, type SiteEvidenceRepository, type SiteEvidenceScan, type SiteEvidenceSitemap, type SiteEvidenceSnapshot, type SiteEvidenceUrl } from './types'

const SCAN_DEADLINE_MS = 15 * 60 * 1_000
const STALE_AFTER_MS = 3 * 60 * 1_000
const MAX_DEPTH = 3
const noopLogger: SiteEvidenceLogger = { info() {}, warn() {}, error() {} }

export type SiteEvidenceDependencies = {
  repository?: SiteEvidenceRepository
  fetcher?: SiteEvidenceFetcher
  renderedProvider?: RenderedSnapshotProvider
  clock?: SiteEvidenceClock
  logger?: SiteEvidenceLogger
  sleep?: (milliseconds: number) => Promise<void>
  requestSpacingMs?: number
  scanDeadlineMs?: number
}

type ResolvedDependencies = Required<SiteEvidenceDependencies>

function dependencies(input: SiteEvidenceDependencies = {}): ResolvedDependencies {
  return {
    repository: input.repository || createSiteEvidenceRepository(),
    fetcher: input.fetcher || createSiteEvidenceFetcher(),
    renderedProvider: input.renderedProvider || createFirecrawlRenderedProvider(),
    clock: input.clock || { now: () => new Date() },
    logger: input.logger || noopLogger,
    sleep: input.sleep || (milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))),
    requestSpacingMs: input.requestSpacingMs ?? 250,
    scanDeadlineMs: input.scanDeadlineMs ?? SCAN_DEADLINE_MS,
  }
}

function errorCode(error: unknown) {
  if (error instanceof SiteEvidenceFetchError) return error.code
  const candidate = error as { code?: unknown, data?: { code?: unknown } }
  const value = typeof candidate?.code === 'string' ? candidate.code : typeof candidate?.data?.code === 'string' ? candidate.data.code : 'scan_failed'
  return value.slice(0, 80)
}

function unique<T>(values: T[]) { return [...new Set(values)] }

function capBody(body: string) {
  const encoded = new TextEncoder().encode(body)
  if (encoded.byteLength <= SITE_EVIDENCE_BODY_CAP_BYTES) return { body, bodyTruncated: false }
  let capped = new TextDecoder().decode(encoded.slice(0, SITE_EVIDENCE_BODY_CAP_BYTES))
  while (new TextEncoder().encode(capped).byteLength > SITE_EVIDENCE_BODY_CAP_BYTES) capped = capped.slice(0, -1)
  return { body: capped, bodyTruncated: true }
}

function pageSnapshot(input: { ownerUserId: number, scanId: number, urlId: number, status: SiteEvidenceSnapshot['status'], reasonCode?: string | null, httpStatus?: number | null, contentHash?: string | null, body?: string | null, bodyTruncated?: boolean, bytesFetched?: number | null, signals?: HtmlSignals | null, duration?: number | null, fetchedAt?: Date | null, kind?: SiteEvidenceSnapshot['kind'], provider?: string | null }): SiteEvidenceSnapshot {
  return {
    ownerUserId: input.ownerUserId,
    scanId: input.scanId,
    urlId: input.urlId,
    kind: input.kind || 'raw',
    status: input.status,
    reasonCode: input.reasonCode || null,
    provider: input.provider || null,
    httpStatus: input.httpStatus ?? null,
    contentHash: input.contentHash || null,
    body: input.body ?? null,
    bodyTruncated: input.bodyTruncated || false,
    bytesFetched: input.bytesFetched ?? null,
    signals: input.signals || null,
    fetchDurationMs: input.duration ?? null,
    fetchedAt: input.fetchedAt || null,
  }
}

function publicTargetOrigin(rawUrl: string) {
  const safe = assertSafeAuditTarget(rawUrl)
  const parsed = new URL(safe.normalizedUrl)
  return { origin: parsed.origin, host: parsed.hostname.toLowerCase() }
}

export async function startSiteEvidenceScan(inputValue: unknown, ownerUserId: number, inputDependencies: SiteEvidenceDependencies = {}): Promise<SiteEvidenceScan> {
  const deps = dependencies(inputDependencies)
  const input = parseStartScanInput(inputValue)
  const existing = await deps.repository.findScanByIdempotencyKey(ownerUserId, input.idempotencyKey)
  if (existing) return existing
  const target = publicTargetOrigin(input.targetUrl)
  try {
    return await deps.repository.createScan({ ownerUserId, targetOrigin: target.origin, targetHost: target.host, maxPages: input.maxPages, idempotencyKey: input.idempotencyKey, createdAt: deps.clock.now() })
  } catch (error) {
    const replay = await deps.repository.findScanByIdempotencyKey(ownerUserId, input.idempotencyKey)
    if (replay) return replay
    throw error
  }
}

async function discoverSitemaps(scan: SiteEvidenceScan, deps: ResolvedDependencies, robotsSitemaps: string[], deadline: () => boolean, limitations: string[]) {
  const documents: SiteEvidenceSitemap[] = []
  const entries = new Map<string, { url: string, lastmod: string | null }>()
  const seen = new Set<string>()
  const cap = scan.maxPages * 5
  type Pending = { url: string, from: 'robots' | 'wellknown' | 'index', depth: number }
  const pending: Pending[] = (robotsSitemaps.length ? robotsSitemaps.map(url => ({ url, from: 'robots' as const, depth: 0 })) : [{ url: new URL('/sitemap.xml', scan.targetOrigin).toString(), from: 'wellknown' as const, depth: 0 }])
  let anyEntries = false
  while (pending.length && entries.size < cap && !deadline()) {
    const item = pending.shift()!
    let normalized: string
    try { normalized = normalizeUrl(item.url) } catch { continue }
    if (seen.has(normalized) || !isSameSite(item.url, scan.targetOrigin)) continue
    seen.add(normalized)
    try {
      const fetched = await deps.fetcher(item.url, 'sitemap')
      const parsed = parseSitemap(fetched.body, fetched.contentType, Math.max(1, cap - entries.size))
      const failedHttp = fetched.status >= 400
      const sitemapError = failedHttp ? 'fetch_failed' : parsed.errorCode
      const acceptedEntries = failedHttp ? [] : parsed.entries
      const record: SiteEvidenceSitemap = { ownerUserId: scan.ownerUserId, scanId: scan.id, url: item.url, urlHash: urlHash(item.url), kind: parsed.kind, status: sitemapError ? 'failed' : 'fetched', httpStatus: fetched.status, urlCount: acceptedEntries.length, contentHash: sha256Hex(fetched.body), errorCode: sitemapError, discoveredFrom: item.from, fetchedAt: deps.clock.now(), entries: parsed.kind === 'urlset' ? acceptedEntries : [] }
      documents.push(record)
      await deps.repository.insertSitemap(record)
      if (parsed.truncated) limitations.push('sitemap_entries_truncated')
      if (!failedHttp && parsed.kind === 'sitemapindex' && item.depth === 0) for (const child of parsed.entries) pending.push({ url: child.url, from: 'index', depth: 1 })
      if (!failedHttp && parsed.kind === 'urlset') for (const entry of parsed.entries) { entries.set(normalizeUrl(entry.url), entry); anyEntries = true; if (entries.size >= cap) break }
    } catch (error) {
      const record: SiteEvidenceSitemap = { ownerUserId: scan.ownerUserId, scanId: scan.id, url: item.url, urlHash: urlHash(item.url), kind: 'unknown', status: 'failed', httpStatus: null, urlCount: 0, contentHash: null, errorCode: errorCode(error), discoveredFrom: item.from, fetchedAt: deps.clock.now(), entries: [] }
      documents.push(record)
      await deps.repository.insertSitemap(record)
    }
  }
  if (robotsSitemaps.length && !anyEntries && !seen.has(normalizeUrl(new URL('/sitemap.xml', scan.targetOrigin).toString()))) {
    const fallback = await discoverSitemaps(scan, deps, [], deadline, limitations)
    for (const document of fallback.documents) documents.push(document)
    for (const entry of fallback.entries) entries.set(normalizeUrl(entry.url), entry)
  }
  if (entries.size >= cap) limitations.push('sitemap_url_consideration_cap_reached')
  return { documents, entries: [...entries.values()] }
}

export async function runSiteEvidenceScan(scanId: number, inputDependencies: SiteEvidenceDependencies = {}): Promise<SiteEvidenceScan> {
  const deps = dependencies(inputDependencies)
  const scan = await deps.repository.getScan(scanId)
  if (!scan) notFound()
  if (scan.status !== 'pending') return scan
  const startedAt = deps.clock.now()
  const deadline = () => deps.clock.now().getTime() - startedAt.getTime() >= deps.scanDeadlineMs
  const limitations: string[] = []
  let pagesFetched = 0
  let renderedCaptured = 0
  let pagesDiscovered = 0
  try {
    await deps.repository.updateScan(scan.id, { status: 'running', startedAt, heartbeatAt: startedAt, errorCode: null, updatedAt: startedAt })
    let robotsContent: string | null = null
    let robotsAvailability: 'available' | 'unavailable' = 'unavailable'
    let sitemapDirectives: string[] = []
    try {
      const robots = await deps.fetcher(new URL('/robots.txt', scan.targetOrigin).toString(), 'robots')
      if (robots.status >= 200 && robots.status < 300) {
        const parsed = parseRobots(robots.body)
        if (!parsed.malformed) {
          robotsContent = robots.body
          robotsAvailability = 'available'
          sitemapDirectives = parsed.sitemaps
        }
      }
      if (robotsAvailability === 'unavailable') limitations.push('robots_txt_unavailable')
    } catch { limitations.push('robots_txt_unavailable') }

    const sitemap = await discoverSitemaps(scan, deps, sitemapDirectives, deadline, limitations)
    const queue = new Map<string, { url: string, depth: number, sources: Set<DiscoverySource> }>()
    const add = (url: string, depth: number, source: DiscoverySource) => {
      try {
        if (!isSameSite(url, scan.targetOrigin)) return
        const normalized = normalizeUrl(url)
        const existing = queue.get(normalized)
        if (existing) existing.sources.add(source)
        else queue.set(normalized, { url, depth, sources: new Set([source]) })
      } catch { /* invalid links are excluded from inventory */ }
    }
    add(new URL('/', scan.targetOrigin).toString(), 0, 'seed')
    for (const entry of sitemap.entries) add(entry.url, 0, 'sitemap')
    pagesDiscovered = queue.size
    const completed = new Set<string>()
    const inventory: FindingInventoryItem[] = []
    const inDegree = new Map<string, number>()

    const crawlOne = async (entry: { url: string, depth: number, sources: Set<DiscoverySource> }) => {
      const normalized = normalizeUrl(entry.url)
      if (completed.has(normalized) || pagesFetched >= scan.maxPages || deadline()) return
      completed.add(normalized)
      pagesFetched += 1
      const now = deps.clock.now()
      const robots = robotsContent ? evaluateRobots(robotsContent, new URL(entry.url).pathname + new URL(entry.url).search) : { verdict: robotsAvailability === 'unavailable' ? 'unavailable' as const : 'unknown' as const, matchedRule: null }
      try {
        const fetched = await deps.fetcher(entry.url, 'page')
        const signals = extractHtmlSignals(fetched.body, fetched.finalUrl)
        const contentHash = sha256Hex(fetched.body)
        const capped = capBody(fetched.body)
        const row = await deps.repository.upsertUrl({ ownerUserId: scan.ownerUserId, siteHost: scan.targetHost, url: entry.url, normalizedUrl: normalized, urlHash: sha256Hex(normalized), lastScanId: scan.id, discoverySources: [...entry.sources], canonicalUrl: signals.canonicalUrl, robotsVerdict: robots.verdict, robotsMatchedRule: robots.matchedRule, metaRobots: signals.metaRobots, xRobotsTag: fetched.headers.get('x-robots-tag'), httpStatus: fetched.status, redirectChain: fetched.redirectChain, finalUrl: fetched.finalUrl, contentHash, contentType: fetched.contentType, bytesFetched: fetched.bytesFetched, errorCode: null, firstSeenAt: now, lastFetchedAt: now })
        await deps.repository.insertSnapshot(pageSnapshot({ ownerUserId: scan.ownerUserId, scanId: scan.id, urlId: row.id, status: 'captured', httpStatus: fetched.status, contentHash, body: capped.body, bodyTruncated: capped.bodyTruncated, bytesFetched: fetched.bytesFetched, signals, duration: fetched.durationMs, fetchedAt: now }))
        inventory.push({ ...row, rawSignals: signals, renderedSignals: null, renderedUnavailableReason: 'not_selected_for_rendering' })
        for (const link of signals.internalLinks) {
          const key = normalizeUrl(link)
          inDegree.set(key, (inDegree.get(key) || 0) + 1)
          if (entry.depth < MAX_DEPTH) add(link, entry.depth + 1, 'crawl')
        }
      } catch (error) {
        const code = errorCode(error)
        const row = await deps.repository.upsertUrl({ ownerUserId: scan.ownerUserId, siteHost: scan.targetHost, url: entry.url, normalizedUrl: normalized, urlHash: sha256Hex(normalized), lastScanId: scan.id, discoverySources: [...entry.sources], canonicalUrl: null, robotsVerdict: robots.verdict, robotsMatchedRule: robots.matchedRule, metaRobots: null, xRobotsTag: null, httpStatus: null, redirectChain: null, finalUrl: null, contentHash: null, contentType: null, bytesFetched: null, errorCode: code, firstSeenAt: now, lastFetchedAt: now })
        await deps.repository.insertSnapshot(pageSnapshot({ ownerUserId: scan.ownerUserId, scanId: scan.id, urlId: row.id, status: 'failed', reasonCode: code, fetchedAt: now }))
        inventory.push({ ...row, rawSignals: null, renderedSignals: null, renderedUnavailableReason: 'raw_fetch_failed' })
      }
      pagesDiscovered = queue.size
      if (pagesFetched % 5 === 0) await deps.repository.updateScan(scan.id, { pagesDiscovered, pagesFetched, heartbeatAt: deps.clock.now(), updatedAt: deps.clock.now() })
    }

    let cursor = 0
    while (cursor < queue.size && pagesFetched < scan.maxPages && !deadline()) {
      const batch = [...queue.values()].slice(cursor, cursor + 2)
      cursor += batch.length
      await Promise.all(batch.map(async entry => { await deps.sleep(deps.requestSpacingMs); await crawlOne(entry) }))
    }
    pagesDiscovered = queue.size
    if (pagesFetched >= scan.maxPages && queue.size > completed.size) limitations.push('page_cap_reached')
    if (deadline()) limitations.push('scan_deadline_reached')

    const successful = inventory.filter(item => item.rawSignals && item.httpStatus !== null)
    const homepageKey = normalizeUrl(new URL('/', scan.targetOrigin).toString())
    const homepage = successful.find(item => item.normalizedUrl === homepageKey)
    const ranked = successful.filter(item => item !== homepage).sort((left, right) => (inDegree.get(right.normalizedUrl) || 0) - (inDegree.get(left.normalizedUrl) || 0) || left.normalizedUrl.localeCompare(right.normalizedUrl)).slice(0, 10)
    const renderTargets = [...(homepage ? [homepage] : []), ...ranked]
    const rendererConfigured = await deps.renderedProvider.isConfigured(scan.ownerUserId).catch(() => false)
    if (!rendererConfigured && renderTargets.length) limitations.push('rendered_snapshots_unavailable')
    for (const page of renderTargets) {
      if (deadline()) { limitations.push('scan_deadline_reached'); break }
      const captured = rendererConfigured
        ? await deps.renderedProvider.capture(page.finalUrl || page.url, scan.ownerUserId).catch(() => ({ unavailable: true as const, reasonCode: 'renderer_failed' }))
        : { unavailable: true as const, reasonCode: 'renderer_not_configured' }
      const now = deps.clock.now()
      if ('unavailable' in captured) {
        page.renderedUnavailableReason = captured.reasonCode
        await deps.repository.insertSnapshot(pageSnapshot({ ownerUserId: scan.ownerUserId, scanId: scan.id, urlId: page.id, kind: 'rendered', provider: 'firecrawl', status: 'unavailable', reasonCode: captured.reasonCode, fetchedAt: now }))
        if (!limitations.includes('rendered_snapshots_unavailable')) limitations.push('rendered_snapshots_unavailable')
      } else {
        const capped = capBody(captured.html)
        const signals = extractHtmlSignals(captured.html, page.finalUrl || page.url)
        page.renderedSignals = signals
        page.renderedUnavailableReason = null
        renderedCaptured += 1
        await deps.repository.insertSnapshot(pageSnapshot({ ownerUserId: scan.ownerUserId, scanId: scan.id, urlId: page.id, kind: 'rendered', provider: 'firecrawl', status: 'captured', httpStatus: captured.httpStatus ?? null, contentHash: sha256Hex(captured.html), body: capped.body, bodyTruncated: capped.bodyTruncated, bytesFetched: new TextEncoder().encode(captured.html).byteLength, signals, fetchedAt: now }))
      }
    }

    const findings = buildSiteEvidenceFindings({ inventory, sitemaps: sitemap.documents, targetOrigin: scan.targetOrigin, limitations }).map(item => ({ ...item, ownerUserId: scan.ownerUserId, scanId: scan.id }))
    await deps.repository.insertFindings(findings)
    const finalLimitations = unique(limitations)
    const partial = finalLimitations.some(value => ['page_cap_reached', 'scan_deadline_reached', 'sitemap_url_consideration_cap_reached', 'rendered_snapshots_unavailable'].includes(value))
    const finishedAt = deps.clock.now()
    await deps.repository.updateScan(scan.id, { status: partial ? 'completed_partial' : 'completed', pagesDiscovered, pagesFetched, renderedCaptured, heartbeatAt: finishedAt, finishedAt, limitations: finalLimitations, updatedAt: finishedAt })
    return (await deps.repository.getScan(scan.id)) || { ...scan, status: partial ? 'completed_partial' : 'completed', pagesDiscovered, pagesFetched, renderedCaptured, heartbeatAt: finishedAt, finishedAt, limitations: finalLimitations, updatedAt: finishedAt }
  } catch (error) {
    const failedAt = deps.clock.now()
    await deps.repository.updateScan(scan.id, { status: 'failed', pagesDiscovered, pagesFetched, renderedCaptured, errorCode: errorCode(error), heartbeatAt: failedAt, finishedAt: failedAt, limitations: unique(limitations), updatedAt: failedAt })
    deps.logger.error('site_evidence_scan_failed', { scanId: scan.id, errorCode: errorCode(error) })
    throw error
  }
}

export async function getScanStatus(scanId: number, ownerUserId: number, inputDependencies: SiteEvidenceDependencies = {}) {
  const deps = dependencies(inputDependencies)
  const scan = await deps.repository.getScanForOwner(scanId, ownerUserId)
  if (!scan) notFound()
  if (scan.status === 'running' && scan.heartbeatAt && deps.clock.now().getTime() - scan.heartbeatAt.getTime() > STALE_AFTER_MS) return { ...scan, status: 'failed' as const, errorCode: 'stale_scan', limitations: unique([...(scan.limitations || []), 'stale_scan_detected']) }
  return scan
}

export async function markStaleScans(ownerUserId: number, inputDependencies: SiteEvidenceDependencies = {}) {
  const deps = dependencies(inputDependencies)
  const scans = await deps.repository.listScansForOwner(ownerUserId, 100)
  const stale = scans.filter(scan => scan.status === 'running' && scan.heartbeatAt && deps.clock.now().getTime() - scan.heartbeatAt.getTime() > STALE_AFTER_MS)
  for (const scan of stale) await deps.repository.updateScan(scan.id, { status: 'failed', errorCode: 'stale_scan', finishedAt: deps.clock.now(), limitations: unique([...(scan.limitations || []), 'stale_scan_detected']), updatedAt: deps.clock.now() })
  return stale.length
}

export async function listScans(ownerUserId: number, limit = 20, inputDependencies: SiteEvidenceDependencies = {}) {
  return dependencies(inputDependencies).repository.listScansForOwner(ownerUserId, Math.max(1, Math.min(100, Math.trunc(limit))))
}

export async function listScanUrls(scanId: number, ownerUserId: number, options: { limit?: number, offset?: number } = {}, inputDependencies: SiteEvidenceDependencies = {}) {
  const deps = dependencies(inputDependencies)
  if (!await deps.repository.getScanForOwner(scanId, ownerUserId)) notFound()
  const limit = Math.max(1, Math.min(200, Math.trunc(options.limit || 50)))
  const offset = Math.max(0, Math.trunc(options.offset || 0))
  const [items, total] = await Promise.all([deps.repository.listUrlsForScan(scanId, ownerUserId, limit, offset), deps.repository.countUrlsForScan(scanId, ownerUserId)])
  return { items, total, limit, offset }
}

export async function listScanFindings(scanId: number, ownerUserId: number, inputDependencies: SiteEvidenceDependencies = {}) {
  const deps = dependencies(inputDependencies)
  if (!await deps.repository.getScanForOwner(scanId, ownerUserId)) notFound()
  const [items, total] = await Promise.all([deps.repository.listFindingsForScan(scanId, ownerUserId), deps.repository.countFindingsForScan(scanId, ownerUserId)])
  return { items, total }
}

export type { SiteEvidenceFinding, SiteEvidenceUrl }

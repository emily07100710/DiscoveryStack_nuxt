import { createError } from 'h3'

export const SITE_EVIDENCE_MAX_PAGES = 200
export const SITE_EVIDENCE_IDEMPOTENCY_KEY_MAX = 128
export const SITE_EVIDENCE_BODY_CAP_BYTES = 512 * 1024

export type ScanStatus = 'pending' | 'running' | 'completed' | 'completed_partial' | 'failed'
export type DiscoverySource = 'sitemap' | 'crawl' | 'seed'
export type RobotsVerdict = 'allowed' | 'disallowed' | 'unavailable' | 'unknown'
export type FindingStatus = 'detected' | 'unknown'
export type FindingSeverity = 'info' | 'warning' | 'critical'
export type SnapshotKind = 'raw' | 'rendered'
export type SnapshotStatus = 'captured' | 'unavailable' | 'failed'

export type StartSiteEvidenceScanInput = {
  targetUrl: string
  maxPages: number
  idempotencyKey: string
}

export type SiteEvidenceScan = {
  id: number
  ownerUserId: number
  targetOrigin: string
  targetHost: string
  status: ScanStatus
  maxPages: number
  pagesDiscovered: number
  pagesFetched: number
  renderedCaptured: number
  errorCode: string | null
  limitations: string[] | null
  idempotencyKey: string
  heartbeatAt: Date | null
  startedAt: Date | null
  finishedAt: Date | null
  createdAt: Date
  updatedAt: Date
}

export type RedirectHop = { url: string, status: number }

export type HtmlSignals = {
  title: string | null
  canonicalUrl: string | null
  metaRobots: string | null
  textLength: number
  anchorCount: number
  internalAnchorCount: number
  internalLinks: string[]
  externalLinks: string[]
  h1: string | null
  notFoundSignal: boolean
}

export type SiteEvidenceUrl = {
  id: number
  ownerUserId: number
  siteHost: string
  url: string
  normalizedUrl: string
  urlHash: string
  lastScanId: number
  discoverySources: DiscoverySource[]
  canonicalUrl: string | null
  robotsVerdict: RobotsVerdict
  robotsMatchedRule: string | null
  metaRobots: string | null
  xRobotsTag: string | null
  httpStatus: number | null
  redirectChain: RedirectHop[] | null
  finalUrl: string | null
  contentHash: string | null
  contentType: string | null
  bytesFetched: number | null
  errorCode: string | null
  firstSeenAt: Date
  lastFetchedAt: Date | null
  createdAt?: Date
  updatedAt?: Date
}

export type SiteEvidenceSnapshot = {
  id?: number
  ownerUserId: number
  scanId: number
  urlId: number
  kind: SnapshotKind
  status: SnapshotStatus
  reasonCode: string | null
  provider: string | null
  httpStatus: number | null
  contentHash: string | null
  body: string | null
  bodyTruncated: boolean
  bytesFetched: number | null
  signals: HtmlSignals | null
  fetchDurationMs: number | null
  fetchedAt: Date | null
}

export type SiteEvidenceSitemap = {
  id?: number
  ownerUserId: number
  scanId: number
  url: string
  urlHash: string
  kind: 'urlset' | 'sitemapindex' | 'unknown'
  status: 'fetched' | 'failed'
  httpStatus: number | null
  urlCount: number
  contentHash: string | null
  errorCode: string | null
  discoveredFrom: 'robots' | 'wellknown' | 'index'
  fetchedAt: Date | null
  entries?: Array<{ url: string, lastmod: string | null }>
}

export type SiteEvidenceFinding = {
  id?: number
  ownerUserId?: number
  scanId?: number
  urlId: number | null
  category: string
  severity: FindingSeverity
  status: FindingStatus
  evidence: Record<string, unknown>
}

export type InventoryUpsert = Omit<SiteEvidenceUrl, 'id' | 'createdAt' | 'updatedAt'>

export type ScanCreate = Pick<SiteEvidenceScan, 'ownerUserId' | 'targetOrigin' | 'targetHost' | 'maxPages' | 'idempotencyKey'> & { createdAt: Date }
export type ScanPatch = Partial<Pick<SiteEvidenceScan, 'status' | 'pagesDiscovered' | 'pagesFetched' | 'renderedCaptured' | 'errorCode' | 'limitations' | 'heartbeatAt' | 'startedAt' | 'finishedAt' | 'updatedAt'>>

export interface SiteEvidenceRepository {
  findScanByIdempotencyKey(ownerUserId: number, idempotencyKey: string): Promise<SiteEvidenceScan | null>
  createScan(input: ScanCreate): Promise<SiteEvidenceScan>
  getScanForOwner(scanId: number, ownerUserId: number): Promise<SiteEvidenceScan | null>
  getScan(scanId: number): Promise<SiteEvidenceScan | null>
  updateScan(scanId: number, patch: ScanPatch): Promise<void>
  listScansForOwner(ownerUserId: number, limit: number): Promise<SiteEvidenceScan[]>
  upsertUrl(input: InventoryUpsert): Promise<SiteEvidenceUrl>
  insertSnapshot(input: SiteEvidenceSnapshot): Promise<void>
  insertSitemap(input: SiteEvidenceSitemap): Promise<void>
  insertFindings(input: Array<SiteEvidenceFinding & { ownerUserId: number, scanId: number }>): Promise<void>
  listUrlsForScan(scanId: number, ownerUserId: number, limit: number, offset: number): Promise<SiteEvidenceUrl[]>
  listFindingsForScan(scanId: number, ownerUserId: number): Promise<SiteEvidenceFinding[]>
  countUrlsForScan(scanId: number, ownerUserId: number): Promise<number>
  countFindingsForScan(scanId: number, ownerUserId: number): Promise<number>
}

export type SiteEvidenceLogger = Pick<Console, 'info' | 'warn' | 'error'>
export type SiteEvidenceClock = { now(): Date }

export function invalidInput(statusMessage: string): never {
  throw createError({ statusCode: 422, statusMessage })
}

export function notFound(statusMessage = 'Site evidence scan was not found.'): never {
  throw createError({ statusCode: 404, statusMessage })
}

export function unavailable(statusMessage = 'Site evidence database is temporarily unavailable.'): never {
  throw createError({ statusCode: 503, statusMessage })
}

export function parseStartScanInput(value: unknown): StartSiteEvidenceScanInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalidInput('Scan input must be an object.')
  const record = value as Record<string, unknown>
  if (typeof record.targetUrl !== 'string' || !record.targetUrl.trim()) invalidInput('targetUrl is required.')
  let url: URL
  try { url = new URL(record.targetUrl.trim()) } catch { invalidInput('targetUrl must be a valid HTTP or HTTPS URL.') }
  if (!['http:', 'https:'].includes(url.protocol)) invalidInput('targetUrl must use HTTP or HTTPS.')
  const maxPages = record.maxPages === undefined ? SITE_EVIDENCE_MAX_PAGES : record.maxPages
  if (!Number.isSafeInteger(maxPages) || Number(maxPages) < 1 || Number(maxPages) > SITE_EVIDENCE_MAX_PAGES) invalidInput('maxPages must be an integer between 1 and 200.')
  if (typeof record.idempotencyKey !== 'string' || !record.idempotencyKey.trim() || record.idempotencyKey.trim().length > SITE_EVIDENCE_IDEMPOTENCY_KEY_MAX) invalidInput('idempotencyKey is required and must be at most 128 characters.')
  return { targetUrl: url.toString(), maxPages: Number(maxPages), idempotencyKey: record.idempotencyKey.trim() }
}

export function assertSha256(value: string | null, label = 'hash'): void {
  if (value !== null && !/^[a-f0-9]{64}$/u.test(value)) invalidInput(`${label} must be a SHA-256 hexadecimal digest.`)
}

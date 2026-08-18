import { ingestionRequestFingerprint, PUBLIC_INGESTION_EXTRACTOR_VERSION } from './ingestion'

export type BoundedCrawlSource = {
  id: number
  sourceUrl: string
  domain: string | null
  sourceType: string
  allowedUse: string
  reviewStatus: string
  robotsStatus: string
  termsStatus: string
  copyrightRisk: string
  piiStatus: string
  retentionUntil: Date | null
  removedAt: Date | null
}

export const MAX_CRAWL_PAGES = 10
export const MAX_CRAWL_DEPTH = 2
export const MAX_CRAWLS_PER_OWNER_WINDOW = 2
export const CRAWL_RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000

function hostnameFor(url: string) { return new URL(url).hostname.toLowerCase().replace(/^www\./, '') }
function approvedHost(source: BoundedCrawlSource) { return (source.domain || hostnameFor(source.sourceUrl)).toLowerCase().replace(/^www\./, '') }

export function isWithinApprovedHost(source: BoundedCrawlSource, url: string) { return hostnameFor(url) === approvedHost(source) }

export function getBoundedCrawlLimits(input: { maxPages?: number, maxDepth?: number }) {
  return {
    maxPages: Math.min(MAX_CRAWL_PAGES, Math.max(1, input.maxPages ?? 5)),
    maxDepth: Math.min(MAX_CRAWL_DEPTH, Math.max(0, input.maxDepth ?? 1)),
  }
}

export function getCrawlRateLimitDecision(recentCrawlCount: number) {
  return {
    allowed: recentCrawlCount < MAX_CRAWLS_PER_OWNER_WINDOW,
    maxRequests: MAX_CRAWLS_PER_OWNER_WINDOW,
    windowMs: CRAWL_RATE_LIMIT_WINDOW_MS,
  }
}

export function crawlRequestFingerprint(input: { sourceId: number, normalizedUrl: string, maxPages: number, maxDepth: number }) {
  return ingestionRequestFingerprint({ sourceId: input.sourceId, normalizedUrl: input.normalizedUrl, extractorVersion: `${PUBLIC_INGESTION_EXTRACTOR_VERSION}-firecrawl-${input.maxPages}-${input.maxDepth}` })
}

export function getCrawlPolicyBlockReason(source: BoundedCrawlSource) {
  if (source.removedAt || source.reviewStatus !== 'approved' || source.allowedUse === 'blocked') return 'source_not_approved'
  if (!['website', 'document'].includes(source.sourceType)) return 'unsupported_source_type'
  if (source.robotsStatus !== 'reviewed_allow') return 'robots_not_approved_for_crawl'
  if (!['allows_research', 'allows_evaluation', 'allows_training'].includes(source.termsStatus)) return 'terms_do_not_allow_crawl'
  if (source.copyrightRisk !== 'low') return 'copyright_risk_requires_review'
  if (source.piiStatus !== 'none_detected') return 'source_pii_requires_review'
  if (source.retentionUntil && source.retentionUntil.getTime() <= Date.now()) return 'source_retention_expired'
  return null
}

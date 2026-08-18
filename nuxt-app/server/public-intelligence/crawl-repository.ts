import { and, count, eq, gte, isNull } from 'drizzle-orm'
import { createError } from 'h3'
import { assertSafeAuditTarget } from '../audit/targetGuard'
import { publicIntelligenceIngestionJobs, publicIntelligenceSources } from '../database/schema'
import { requireAuditDatabase } from '../audit/repository'
import { cleanAndExtractPublicDocument, PUBLIC_INGESTION_EXTRACTOR_VERSION } from './ingestion'
import { createOwnerPublicArtifact } from './repository'
import { isFirecrawlConfigured, runFirecrawlBoundedCrawl } from './firecrawl'
import { CRAWL_RATE_LIMIT_WINDOW_MS, crawlRequestFingerprint, getBoundedCrawlLimits, getCrawlPolicyBlockReason, getCrawlRateLimitDecision, isWithinApprovedHost, MAX_CRAWL_DEPTH, MAX_CRAWL_PAGES, type BoundedCrawlSource } from './crawl-policy'

type CrawlSource = BoundedCrawlSource & Pick<typeof publicIntelligenceSources.$inferSelect, 'policyEvidence' | 'language'>
type CrawlResult = { url: string, depth: number, status: 'cleaned' | 'skipped' | 'failed', httpStatus: number | null, cleanedCharacterCount: number | null, piiOutcome: string | null, artifactId: number | null, errorCode: string | null }

export { MAX_CRAWL_DEPTH, MAX_CRAWL_PAGES }
function policySnapshot(source: CrawlSource) { return { provider: 'firecrawl', reviewStatus: source.reviewStatus, allowedUse: source.allowedUse, robotsStatus: source.robotsStatus, termsStatus: source.termsStatus, copyrightRisk: source.copyrightRisk, piiStatus: source.piiStatus, retentionUntil: source.retentionUntil?.toISOString() ?? null, sourcePolicyEvidence: source.policyEvidence } }
function safeCode(error: unknown) {
  const message = error instanceof Error ? error.message : 'firecrawl_failed'
  const known = ['firecrawl_not_configured', 'firecrawl_request_failed', 'firecrawl_missing_job_id', 'firecrawl_job_failed', 'firecrawl_job_timeout', 'response_too_large', 'empty_response_body', 'unexpected_content_type', 'unexpected_redirect', 'non_success_response', 'fetch_timeout']
  return known.find(code => message.includes(code)) || 'firecrawl_failed'
}
function journeyStage(features: ReturnType<typeof cleanAndExtractPublicDocument>['features']) { return !features.documentTitlePresent || !features.hasH1 ? 'discovery' : !features.signals.primaryCta ? 'progression' : !features.signals.expertContact ? 'response' : 'understanding' }
async function markJob(jobId: number, patch: Record<string, unknown>) { await requireAuditDatabase().update(publicIntelligenceIngestionJobs).set({ ...patch, completedAt: new Date() }).where(eq(publicIntelligenceIngestionJobs.id, jobId)) }

export async function crawlApprovedPublicSite(input: { ownerUserId: number, sourceId: number, requestedUrl: string, maxPages?: number, maxDepth?: number }) {
  const database = requireAuditDatabase()
  const safeTarget = assertSafeAuditTarget(input.requestedUrl)
  if (new URL(safeTarget.normalizedUrl).protocol !== 'https:') throw createError({ statusCode: 422, statusMessage: 'Bounded crawl requires an HTTPS URL.' })
  const { maxPages, maxDepth } = getBoundedCrawlLimits(input)
  const [source] = await database.select().from(publicIntelligenceSources).where(and(eq(publicIntelligenceSources.id, input.sourceId), eq(publicIntelligenceSources.ownerUserId, input.ownerUserId), isNull(publicIntelligenceSources.removedAt))).limit(1)
  if (!source) throw createError({ statusCode: 404, statusMessage: 'Approved public source was not found.' })
  if (!isWithinApprovedHost(source, safeTarget.normalizedUrl)) throw createError({ statusCode: 422, statusMessage: 'The crawl start URL must remain within the approved Source Card host.' })
  const policyError = getCrawlPolicyBlockReason(source)
  const requestFingerprint = crawlRequestFingerprint({ sourceId: source.id, normalizedUrl: safeTarget.normalizedUrl, maxPages, maxDepth })
  const duplicate = await database.select({ id: publicIntelligenceIngestionJobs.id, status: publicIntelligenceIngestionJobs.status, primaryArtifactId: publicIntelligenceIngestionJobs.primaryArtifactId }).from(publicIntelligenceIngestionJobs).where(and(eq(publicIntelligenceIngestionJobs.ownerUserId, input.ownerUserId), eq(publicIntelligenceIngestionJobs.requestFingerprint, requestFingerprint), eq(publicIntelligenceIngestionJobs.status, 'completed'))).limit(1)
  if (duplicate[0]) return { jobId: duplicate[0].id, status: 'duplicate' as const, primaryArtifactId: duplicate[0].primaryArtifactId, message: 'An identical Firecrawl bounded crawl was already processed.' }
  const windowStart = new Date(Date.now() - CRAWL_RATE_LIMIT_WINDOW_MS)
  const [recent] = await database.select({ total: count() }).from(publicIntelligenceIngestionJobs).where(and(eq(publicIntelligenceIngestionJobs.ownerUserId, input.ownerUserId), eq(publicIntelligenceIngestionJobs.collectionMode, 'owner_triggered_bounded_crawl'), gte(publicIntelligenceIngestionJobs.requestedAt, windowStart)))
  if (!getCrawlRateLimitDecision(Number(recent?.total || 0)).allowed) throw createError({ statusCode: 429, statusMessage: 'Bounded crawl rate limit reached. Please wait before starting another multi-page collection.' })

  const providerError = !policyError && !(await isFirecrawlConfigured(input.ownerUserId)) ? 'firecrawl_not_configured' : null
  const initialError = policyError || providerError
  const insertResult = await database.insert(publicIntelligenceIngestionJobs).values({ ownerUserId: input.ownerUserId, sourceId: source.id, requestedUrl: safeTarget.normalizedUrl, requestFingerprint, collectionMode: 'owner_triggered_bounded_crawl', status: initialError ? (policyError ? 'policy_blocked' : 'failed') : 'processing', policySnapshot: policySnapshot(source), piiFindingCounts: {}, extractorVersion: `${PUBLIC_INGESTION_EXTRACTOR_VERSION}-firecrawl`, maxPages, maxDepth, startedAt: initialError ? null : new Date(), completedAt: initialError ? new Date() : null, errorCode: initialError })
  const jobId = Number(insertResult[0].insertId)
  if (policyError) return { jobId, status: 'policy_blocked' as const, primaryArtifactId: null, message: 'This Source Card has not passed the crawler policy gate.' }
  if (providerError) return { jobId, status: 'failed' as const, primaryArtifactId: null, message: 'Firecrawl is not configured on the server. Set FIRECRAWL_API_KEY before starting a crawl.' }

  const results: CrawlResult[] = []
  let pagesFetched = 0
  let pagesCleaned = 0
  let artifactsCreated = 0
  let totalBytes = 0
  let firstArtifactId: number | null = null
  try {
    const crawl = await runFirecrawlBoundedCrawl({ ownerUserId: input.ownerUserId, url: safeTarget.normalizedUrl, maxPages, maxDepth })
    for (const page of crawl.pages) {
      if (!isWithinApprovedHost(source, page.url)) continue
      pagesFetched += 1
      const depth = Number(page.metadata.depth || page.metadata.discoveryDepth || 0) || 0
      const result: CrawlResult = { url: page.url, depth, status: 'failed', httpStatus: page.statusCode, cleanedCharacterCount: null, piiOutcome: null, artifactId: null, errorCode: null }
      try {
        totalBytes += Buffer.byteLength(page.html, 'utf8')
        const extracted = cleanAndExtractPublicDocument(page.html)
        result.cleanedCharacterCount = extracted.cleanedCharacterCount
        result.piiOutcome = extracted.piiOutcome
        if (extracted.piiOutcome === 'redacted') {
          result.status = 'skipped'
          result.errorCode = 'pii_detected_requires_review'
        } else {
          const artifact = await createOwnerPublicArtifact({ ownerUserId: input.ownerUserId, sourceId: source.id, sourceUrl: page.url, canonicalUrl: typeof page.metadata.canonicalUrl === 'string' ? page.metadata.canonicalUrl : null, artifactType: 'structural_features', artifactText: null, sourceLocator: `firecrawl:${crawl.providerJobId}:depth-${depth}:${page.url}`, sourceSpanHash: extracted.cleanedTextHash, fieldData: { provider: 'firecrawl', providerJobId: crawl.providerJobId, title: page.title, signals: extracted.features.signals, primaryJourneyStage: journeyStage(extracted.features), navigationDepth: depth, serviceRoutes: extracted.features.internalLinkCount, documentTitlePresent: extracted.features.documentTitlePresent, hasH1: extracted.features.hasH1, canonicalPresent: extracted.features.canonicalPresent, indexability: extracted.features.indexability, schemaTypes: extracted.features.schemaTypes }, language: source.language, extractionMethod: 'policy_approved_fetch', requestedUse: source.allowedUse, retentionUntil: source.retentionUntil })
          result.status = 'cleaned'
          result.artifactId = artifact.id
          pagesCleaned += 1
          artifactsCreated += 1
          if (!firstArtifactId) firstArtifactId = artifact.id
        }
      } catch (error: unknown) {
        result.errorCode = safeCode(error)
      }
      results.push(result)
    }
    const status = pagesCleaned ? 'completed' : 'failed'
    await markJob(jobId, { status, finalUrl: safeTarget.normalizedUrl, httpStatus: results[0]?.httpStatus || null, responseByteLength: totalBytes, cleanedCharacterCount: results.reduce((sum, item) => sum + (item.cleanedCharacterCount || 0), 0), piiOutcome: results.some(item => item.errorCode === 'pii_detected_requires_review') ? 'needs_human_review' : 'not_detected', piiFindingCounts: {}, pagesFetched, pagesCleaned, artifactsCreated, crawlResults: { provider: 'firecrawl', providerJobId: crawl.providerJobId, warning: crawl.warning, pages: results }, primaryArtifactId: firstArtifactId, errorCode: status === 'failed' ? results.find(item => item.errorCode)?.errorCode || 'no_pages_cleaned' : null })
    return { jobId, status: status as 'completed' | 'failed', provider: 'firecrawl', providerJobId: crawl.providerJobId, primaryArtifactId: firstArtifactId, pagesFetched, pagesCleaned, artifactsCreated, results, message: `${pagesCleaned} of ${pagesFetched} Firecrawl page(s) were cleaned into typed structural artifacts. Raw HTML and cleaned text were not stored.` }
  } catch (error: unknown) {
    const errorCode = safeCode(error)
    await markJob(jobId, { status: 'failed', pagesFetched, pagesCleaned, artifactsCreated, crawlResults: { provider: 'firecrawl', pages: results }, errorCode, errorDetail: 'Firecrawl provider failed before the approved page set could be materialised.' })
    throw createError({ statusCode: 422, statusMessage: 'The Firecrawl bounded crawl failed. Review the crawl ledger for its safe provider error code.' })
  }
}

import { and, desc, eq, isNull } from 'drizzle-orm'
import { assertSafeAuditTarget } from '../audit/targetGuard'
import { publicIntelligenceArtifacts, publicIntelligenceIngestionJobs, publicIntelligenceSources } from '../database/schema'
import { cleanAndExtractPublicDocument, ingestionRequestFingerprint, PUBLIC_INGESTION_EXTRACTOR_VERSION, readBoundedPublicHtml } from './ingestion'
import { createOwnerPublicArtifact } from './repository'
import { requireAuditDatabase } from '../audit/repository'

type FetchableSource = Pick<typeof publicIntelligenceSources.$inferSelect, 'id' | 'sourceUrl' | 'domain' | 'sourceType' | 'allowedUse' | 'reviewStatus' | 'robotsStatus' | 'termsStatus' | 'copyrightRisk' | 'piiStatus' | 'retentionUntil' | 'removedAt' | 'policyEvidence'>

function publicFetchBlockReason(source: FetchableSource) {
  if (source.removedAt || source.reviewStatus !== 'approved' || source.allowedUse === 'blocked') return 'source_not_approved'
  if (source.sourceType !== 'website' && source.sourceType !== 'document') return 'unsupported_source_type'
  if (source.robotsStatus !== 'reviewed_allow') return 'robots_not_approved_for_fetch'
  if (!['allows_research', 'allows_evaluation', 'allows_training'].includes(source.termsStatus)) return 'terms_do_not_allow_fetch'
  if (source.copyrightRisk !== 'low') return 'copyright_risk_requires_review'
  if (source.piiStatus !== 'none_detected') return 'source_pii_requires_review'
  if (source.retentionUntil && source.retentionUntil.getTime() <= Date.now()) return 'source_retention_expired'
  return null
}

function hostnameFor(url: string) {
  return new URL(url).hostname.toLowerCase().replace(/^www\./, '')
}

function isWithinApprovedSourceHost(source: FetchableSource, targetUrl: string) {
  const sourceHost = (source.domain || hostnameFor(source.sourceUrl)).toLowerCase().replace(/^www\./, '')
  const targetHost = hostnameFor(targetUrl)
  return targetHost === sourceHost || targetHost.endsWith(`.${sourceHost}`)
}

function policySnapshot(source: FetchableSource) {
  return {
    reviewStatus: source.reviewStatus,
    allowedUse: source.allowedUse,
    robotsStatus: source.robotsStatus,
    termsStatus: source.termsStatus,
    copyrightRisk: source.copyrightRisk,
    piiStatus: source.piiStatus,
    retentionUntil: source.retentionUntil?.toISOString() ?? null,
    sourcePolicyEvidence: source.policyEvidence,
  }
}

function stableErrorCode(error: unknown) {
  const code = error instanceof Error ? error.message : 'fetch_failed'
  return ['response_too_large', 'empty_response_body', 'unexpected_content_type', 'unexpected_redirect', 'non_success_response', 'fetch_timeout'].includes(code) ? code : 'fetch_failed'
}

async function markJob(input: { jobId: number, status: 'completed' | 'duplicate' | 'needs_human_review' | 'policy_blocked' | 'failed', patch?: Record<string, unknown> }) {
  const database = requireAuditDatabase()
  await database.update(publicIntelligenceIngestionJobs).set({ status: input.status, completedAt: new Date(), ...(input.patch || {}) }).where(eq(publicIntelligenceIngestionJobs.id, input.jobId))
}

export async function listOwnerIngestionJobs(ownerUserId: number) {
  const database = requireAuditDatabase()
  return database.select({
    id: publicIntelligenceIngestionJobs.id,
    sourceId: publicIntelligenceIngestionJobs.sourceId,
    sourceName: publicIntelligenceSources.sourceName,
    requestedUrl: publicIntelligenceIngestionJobs.requestedUrl,
    collectionMode: publicIntelligenceIngestionJobs.collectionMode,
    finalUrl: publicIntelligenceIngestionJobs.finalUrl,
    status: publicIntelligenceIngestionJobs.status,
    httpStatus: publicIntelligenceIngestionJobs.httpStatus,
    cleanedCharacterCount: publicIntelligenceIngestionJobs.cleanedCharacterCount,
    piiOutcome: publicIntelligenceIngestionJobs.piiOutcome,
    piiFindingCounts: publicIntelligenceIngestionJobs.piiFindingCounts,
    primaryArtifactId: publicIntelligenceIngestionJobs.primaryArtifactId,
    maxPages: publicIntelligenceIngestionJobs.maxPages,
    maxDepth: publicIntelligenceIngestionJobs.maxDepth,
    pagesFetched: publicIntelligenceIngestionJobs.pagesFetched,
    pagesCleaned: publicIntelligenceIngestionJobs.pagesCleaned,
    artifactsCreated: publicIntelligenceIngestionJobs.artifactsCreated,
    crawlResults: publicIntelligenceIngestionJobs.crawlResults,
    errorCode: publicIntelligenceIngestionJobs.errorCode,
    requestedAt: publicIntelligenceIngestionJobs.requestedAt,
    completedAt: publicIntelligenceIngestionJobs.completedAt,
  }).from(publicIntelligenceIngestionJobs)
    .innerJoin(publicIntelligenceSources, eq(publicIntelligenceIngestionJobs.sourceId, publicIntelligenceSources.id))
    .where(eq(publicIntelligenceIngestionJobs.ownerUserId, ownerUserId))
    .orderBy(desc(publicIntelligenceIngestionJobs.requestedAt))
}

/**
 * Performs one explicitly requested document fetch. It never follows redirects, never crawls a site graph,
 * never stores HTML or cleaned text, and does not create a usable artifact when PII is found.
 */
export async function ingestApprovedPublicDocument(input: { ownerUserId: number, sourceId: number, requestedUrl: string }) {
  const database = requireAuditDatabase()
  const safeTarget = assertSafeAuditTarget(input.requestedUrl)
  if (new URL(safeTarget.normalizedUrl).protocol !== 'https:') throw createError({ statusCode: 422, statusMessage: 'Approved document ingestion requires an HTTPS URL.' })
  const [source] = await database.select().from(publicIntelligenceSources)
    .where(and(eq(publicIntelligenceSources.id, input.sourceId), eq(publicIntelligenceSources.ownerUserId, input.ownerUserId), isNull(publicIntelligenceSources.removedAt))).limit(1)
  if (!source) throw createError({ statusCode: 404, statusMessage: 'Approved public source was not found.' })
  const blockReason = publicFetchBlockReason(source)
  const requestFingerprint = ingestionRequestFingerprint({ sourceId: source.id, normalizedUrl: safeTarget.normalizedUrl })
  const duplicate = await database.select({ id: publicIntelligenceIngestionJobs.id, status: publicIntelligenceIngestionJobs.status, primaryArtifactId: publicIntelligenceIngestionJobs.primaryArtifactId })
    .from(publicIntelligenceIngestionJobs)
    .where(and(eq(publicIntelligenceIngestionJobs.ownerUserId, input.ownerUserId), eq(publicIntelligenceIngestionJobs.requestFingerprint, requestFingerprint), eq(publicIntelligenceIngestionJobs.status, 'completed'))).limit(1)
  if (duplicate[0]) return { jobId: duplicate[0].id, status: 'duplicate' as const, primaryArtifactId: duplicate[0].primaryArtifactId, message: 'An identical approved document was already processed. Create a new request only after its source policy or content changes.' }

  const createResult = await database.insert(publicIntelligenceIngestionJobs).values({
    ownerUserId: input.ownerUserId,
    sourceId: source.id,
    requestedUrl: safeTarget.normalizedUrl,
    requestFingerprint,
    collectionMode: 'owner_triggered_approved_fetch',
    status: blockReason ? 'policy_blocked' : 'processing',
    policySnapshot: policySnapshot(source),
    piiFindingCounts: {},
    extractorVersion: PUBLIC_INGESTION_EXTRACTOR_VERSION,
    startedAt: blockReason ? null : new Date(),
    completedAt: blockReason ? new Date() : null,
    errorCode: blockReason,
  })
  const jobId = Number(createResult[0].insertId)
  if (blockReason) return { jobId, status: 'policy_blocked' as const, primaryArtifactId: null, message: 'This source has not passed the required policy gate for automated document acquisition.' }
  if (!isWithinApprovedSourceHost(source, safeTarget.normalizedUrl)) {
    await markJob({ jobId, status: 'policy_blocked', patch: { errorCode: 'target_outside_approved_source_host' } })
    throw createError({ statusCode: 422, statusMessage: 'The requested page must remain within the approved Source Card host.' })
  }

  try {
    const response = await fetch(safeTarget.normalizedUrl, { redirect: 'manual', signal: AbortSignal.timeout(20_000), headers: { Accept: 'text/html,application/xhtml+xml;q=0.9' } })
    if (response.status >= 300 && response.status < 400) throw new Error('unexpected_redirect')
    if (!response.ok) throw new Error('non_success_response')
    const contentType = response.headers.get('content-type') || ''
    if (!/^(text\/html|application\/xhtml\+xml)\b/i.test(contentType)) throw new Error('unexpected_content_type')
    const { html, byteLength } = await readBoundedPublicHtml(response)
    const extracted = cleanAndExtractPublicDocument(html)
    if (extracted.piiOutcome === 'redacted') {
      await markJob({ jobId, status: 'needs_human_review', patch: { finalUrl: response.url || safeTarget.normalizedUrl, httpStatus: response.status, contentHash: extracted.contentHash, cleanedTextHash: extracted.cleanedTextHash, responseByteLength: byteLength, cleanedCharacterCount: extracted.cleanedCharacterCount, piiOutcome: extracted.piiOutcome, piiFindingCounts: extracted.piiFindingCounts, errorCode: 'pii_detected_requires_review' } })
      return { jobId, status: 'needs_human_review' as const, primaryArtifactId: null, message: 'Potential personal data was redacted in memory. No artifact was created; review the source policy before another request.' }
    }
    const primaryJourneyStage = !extracted.features.documentTitlePresent || !extracted.features.hasH1 ? 'discovery' : !extracted.features.signals.primaryCta ? 'progression' : !extracted.features.signals.expertContact ? 'response' : 'understanding'
    const artifact = await createOwnerPublicArtifact({
      ownerUserId: input.ownerUserId,
      sourceId: source.id,
      sourceUrl: safeTarget.normalizedUrl,
      canonicalUrl: null,
      artifactType: 'structural_features',
      artifactText: null,
      sourceLocator: 'document:derived-structural-features',
      sourceSpanHash: extracted.cleanedTextHash,
      fieldData: { signals: extracted.features.signals, primaryJourneyStage, navigationDepth: 0, serviceRoutes: 0 },
      language: source.language,
      extractionMethod: 'policy_approved_fetch',
      requestedUse: source.allowedUse,
      retentionUntil: source.retentionUntil,
    })
    await markJob({ jobId, status: 'completed', patch: { finalUrl: response.url || safeTarget.normalizedUrl, httpStatus: response.status, contentHash: extracted.contentHash, cleanedTextHash: extracted.cleanedTextHash, responseByteLength: byteLength, cleanedCharacterCount: extracted.cleanedCharacterCount, piiOutcome: extracted.piiOutcome, piiFindingCounts: extracted.piiFindingCounts, primaryArtifactId: artifact.id } })
    return { jobId, status: 'completed' as const, primaryArtifactId: artifact.id, message: 'A bounded approved document was processed into a pending structural artifact. Raw HTML and cleaned text were not stored.' }
  } catch (error: unknown) {
    const code = error instanceof DOMException && error.name === 'TimeoutError' ? 'fetch_timeout' : stableErrorCode(error)
    await markJob({ jobId, status: 'failed', patch: { errorCode: code } })
    throw createError({ statusCode: 422, statusMessage: 'The approved document could not be processed. Review the job ledger for its safe error code.' })
  }
}

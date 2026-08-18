import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CRAWL_RATE_LIMIT_WINDOW_MS, MAX_CRAWL_DEPTH, MAX_CRAWL_PAGES, MAX_CRAWLS_PER_OWNER_WINDOW, crawlRequestFingerprint, getBoundedCrawlLimits, getCrawlPolicyBlockReason, getCrawlRateLimitDecision, isWithinApprovedHost } from '../server/public-intelligence/crawl-policy'
import { trainingMemberAdmissionError } from '../server/public-intelligence/training-admission'

const crawlRepository = readFileSync(join(process.cwd(), 'server/public-intelligence/crawl-repository.ts'), 'utf8')
const approvedSource = {
  id: 1,
  sourceUrl: 'https://developers.google.com/search/docs',
  domain: 'developers.google.com',
  sourceType: 'website' as const,
  allowedUse: 'training_candidate',
  reviewStatus: 'approved',
  robotsStatus: 'reviewed_allow',
  termsStatus: 'allows_training',
  copyrightRisk: 'low',
  piiStatus: 'none_detected',
  retentionUntil: null,
  removedAt: null,
  policyEvidence: {},
  language: 'en',
}

describe('bounded site crawl governance', () => {
  it('clamps page and depth controls to the server-enforced range, including explicit depth zero', () => {
    expect(MAX_CRAWL_PAGES).toBe(10)
    expect(MAX_CRAWL_DEPTH).toBe(2)
    expect(getBoundedCrawlLimits({ maxPages: 99, maxDepth: 99 })).toEqual({ maxPages: 10, maxDepth: 2 })
    expect(getBoundedCrawlLimits({ maxPages: 0, maxDepth: 0 })).toEqual({ maxPages: 1, maxDepth: 0 })
    expect(getBoundedCrawlLimits({})).toEqual({ maxPages: 5, maxDepth: 1 })
  })

  it('requires the exact approved host and blocks external hosts and subdomains', () => {
    expect(isWithinApprovedHost(approvedSource, 'https://developers.google.com/search/docs/crawling-indexing/overview')).toBe(true)
    expect(isWithinApprovedHost(approvedSource, 'https://www.google.com/search')).toBe(false)
    expect(isWithinApprovedHost(approvedSource, 'https://sub.developers.google.com/search/docs')).toBe(false)
  })

  it('requires every source-policy gate before a crawl can reach Firecrawl', () => {
    expect(getCrawlPolicyBlockReason(approvedSource)).toBeNull()
    expect(getCrawlPolicyBlockReason({ ...approvedSource, robotsStatus: 'reviewed_restrict' })).toBe('robots_not_approved_for_crawl')
    expect(getCrawlPolicyBlockReason({ ...approvedSource, termsStatus: 'prohibits_automation' })).toBe('terms_do_not_allow_crawl')
    expect(getCrawlPolicyBlockReason({ ...approvedSource, piiStatus: 'possible' })).toBe('source_pii_requires_review')
    expect(getCrawlPolicyBlockReason({ ...approvedSource, allowedUse: 'blocked' })).toBe('source_not_approved')
  })

  it('deduplicates only an identical approved crawl configuration and retains a PII skip path', () => {
    const first = crawlRequestFingerprint({ sourceId: 1, normalizedUrl: 'https://developers.google.com/search/docs', maxPages: 10, maxDepth: 1 })
    expect(first).toBe(crawlRequestFingerprint({ sourceId: 1, normalizedUrl: 'https://developers.google.com/search/docs', maxPages: 10, maxDepth: 1 }))
    expect(first).not.toBe(crawlRequestFingerprint({ sourceId: 1, normalizedUrl: 'https://developers.google.com/search/docs', maxPages: 5, maxDepth: 1 }))
    expect(crawlRepository).toContain("if (extracted.piiOutcome === 'redacted')")
    expect(crawlRepository).toContain("result.errorCode = 'pii_detected_requires_review'")
    expect(crawlRepository).toContain("if (duplicate[0]) return { jobId: duplicate[0].id, status: 'duplicate' as const")
  })

  it('limits each owner to a small number of bounded crawls in a persistent ten-minute window', () => {
    expect(MAX_CRAWLS_PER_OWNER_WINDOW).toBe(2)
    expect(CRAWL_RATE_LIMIT_WINDOW_MS).toBe(10 * 60 * 1000)
    expect(getCrawlRateLimitDecision(1).allowed).toBe(true)
    expect(getCrawlRateLimitDecision(2).allowed).toBe(false)
    expect(crawlRepository).toContain("eq(publicIntelligenceIngestionJobs.collectionMode, 'owner_triggered_bounded_crawl')")
    expect(crawlRepository).toContain('gte(publicIntelligenceIngestionJobs.requestedAt, windowStart)')
  })

  it('keeps crawled structural artifacts out of a training manifest until a human annotation passes review', () => {
    expect(crawlRepository).toContain("artifactType: 'structural_features'")
    const crawlArtifact = { artifactType: 'structural_features', qualityStatus: 'passed', piiStatus: 'none_detected', sourceUse: 'training_candidate', sourceReviewStatus: 'approved', sourceRemovedAt: null, artifactRemovedAt: null }
    expect(trainingMemberAdmissionError(crawlArtifact)).toBe('human_annotation_required')
    expect(trainingMemberAdmissionError({ ...crawlArtifact, artifactType: 'human_annotation', qualityStatus: 'pending' })).toBe('quality_review_required')
    expect(trainingMemberAdmissionError({ ...crawlArtifact, artifactType: 'human_annotation' })).toBeNull()
  })
})

import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ selectQueue: [] as unknown[][], inserts: [] as unknown[] }))

function queryChain(result: unknown[]) {
  const chain: Record<string, unknown> = {}
  for (const method of ['from', 'innerJoin', 'leftJoin', 'where', 'groupBy', 'orderBy']) chain[method] = () => chain
  chain.limit = async () => result
  chain.then = (resolve: (value: unknown[]) => unknown) => Promise.resolve(result).then(resolve)
  return chain
}

function createDatabase() {
  return {
    select: () => queryChain(state.selectQueue.shift() || []),
    insert: () => ({ values: async (value: unknown) => {
      state.inserts.push(value)
      return [{ insertId: state.inserts.length === 1 ? 41 : 77 }]
    } }),
    update: () => ({ set: () => ({ where: async () => [] }) }),
  }
}

vi.mock('../server/audit/repository', () => ({ requireAuditDatabase: () => createDatabase() }))
vi.mock('h3', () => ({ createError: (input: { statusCode: number, statusMessage: string }) => Object.assign(new Error(input.statusMessage), input) }))
vi.mock('../server/audit/targetGuard', () => ({ assertSafeAuditTarget: (url: string) => ({ normalizedUrl: url }) }))
vi.stubGlobal('createError', (input: { statusCode: number, statusMessage: string }) => Object.assign(new Error(input.statusMessage), input))
vi.mock('../server/public-intelligence/firecrawl', () => ({
  isFirecrawlConfigured: async () => true,
  runFirecrawlBoundedCrawl: async () => ({
    providerJobId: 'bounded-crawl-test',
    warning: null,
    pages: [{
      url: 'https://developers.google.com/search/docs',
      title: 'Google Search Central',
      statusCode: 200,
      metadata: { depth: 0, canonicalUrl: 'https://developers.google.com/search/docs' },
      html: '<html><head><title>Google Search Central</title><link rel="canonical" href="https://developers.google.com/search/docs"></head><body><h1>Search documentation</h1><p>Search documentation overview.</p></body></html>',
    }],
  }),
}))

const { crawlApprovedPublicSite } = await import('../server/public-intelligence/crawl-repository')
const { createOwnerPublicDatasetBuild } = await import('../server/public-intelligence/repository')

const approvedSource = {
  id: 1,
  ownerUserId: 1,
  sourceUrl: 'https://developers.google.com/search/docs',
  domain: 'developers.google.com',
  sourceType: 'website',
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

describe('Bounded crawl lifecycle training governance', () => {
  beforeEach(() => {
    state.inserts = []
    state.selectQueue = [
      [approvedSource], // bounded crawl source lookup
      [], // duplicate fingerprint lookup
      [{ total: 0 }], // per-owner crawl rate window
      [approvedSource], // real createOwnerPublicArtifact source lookup
    ]
  })

  it('persists a completed bounded-crawl structural artifact but blocks dataset inclusion until human quality review', async () => {
    const crawl = await crawlApprovedPublicSite({ ownerUserId: 1, sourceId: 1, requestedUrl: 'https://developers.google.com/search/docs', maxPages: 2, maxDepth: 0 })

    expect(crawl.status).toBe('completed')
    expect(crawl.artifactsCreated).toBe(1)
    const persistedArtifact = state.inserts[1] as { artifactType: string, qualityStatus: string, piiStatus: string }
    expect(persistedArtifact).toMatchObject({ artifactType: 'structural_features', qualityStatus: 'pending', piiStatus: 'none_detected' })

    state.selectQueue = [[{
      id: 77,
      artifactHash: 'bounded-crawl-artifact',
      sourceId: 1,
      sourceAllowedUse: 'training_candidate',
      artifactUse: 'training_candidate',
      qualityStatus: persistedArtifact.qualityStatus,
    }]]

    await expect(createOwnerPublicDatasetBuild({ ownerUserId: 1, datasetName: 'blocked crawl candidate', datasetVersion: 'v1', intendedUse: 'training', featureContractVersion: 'seo-geo-feature-v1', labelTaxonomyVersion: 'seo-geo-v1', splitVersion: 'split-v1', artifactIds: [77], reviewNote: 'must be reviewed first' }))
      .rejects.toMatchObject({ statusCode: 422, statusMessage: 'Every dataset artifact must pass human quality review.' })
  })
})

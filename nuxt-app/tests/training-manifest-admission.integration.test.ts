import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SEO_GEO_LABEL_TAXONOMY_VERSION } from '../server/public-intelligence/seoGeoTaxonomy'

type SelectResult = unknown[]
let selectResults: SelectResult[] = []

function chainFor(result: SelectResult) {
  const chain: Record<string, unknown> = {}
  for (const method of ['from', 'innerJoin', 'leftJoin', 'where', 'groupBy', 'orderBy']) chain[method] = () => chain
  chain.limit = async () => result
  chain.then = (resolve: (value: SelectResult) => unknown) => Promise.resolve(result).then(resolve)
  return chain
}

const database = {
  select: () => chainFor(selectResults.shift() || []),
  update: () => ({ set: () => ({ where: async () => [] }) }),
}

vi.mock('../server/audit/repository', () => ({ requireAuditDatabase: () => database }))
vi.stubGlobal('createError', (input: { statusCode: number, statusMessage: string }) => Object.assign(new Error(input.statusMessage), input))

const { approveOwnerPublicDatasetBuild } = await import('../server/public-intelligence/repository')

function structuralCrawlMembers() {
  return Array.from({ length: 101 }, (_, index) => ({
    artifactId: index + 1,
    sourceUrl: `https://developers.google.com/search/docs/page-${index + 1}`,
    sourceSpanHash: `crawl-span-${index + 1}`,
    fieldData: {},
    artifactType: 'structural_features',
    qualityStatus: 'passed',
    piiStatus: 'none_detected',
    memberStatus: 'included',
    sourceUse: 'training_candidate',
    sourceReviewStatus: 'approved',
    sourceRemovedAt: null,
    artifactRemovedAt: null,
  }))
}

describe('Training manifest admission for bounded crawl artifacts', () => {
  beforeEach(() => {
    selectResults = [
      [{ id: 9, intendedUse: 'training', status: 'ready_for_review', labelTaxonomyVersion: SEO_GEO_LABEL_TAXONOMY_VERSION }],
      structuralCrawlMembers(),
    ]
  })

  it('rejects 101 policy-cleared crawl artifacts until each record is replaced with a human annotation', async () => {
    await expect(approveOwnerPublicDatasetBuild({ ownerUserId: 1, datasetBuildId: 9, reviewNote: 'owner review' }))
      .rejects.toMatchObject({ statusCode: 422, statusMessage: 'Every training member must be an active, quality-passed, PII-cleared human annotation from an approved training source.' })
  })
})

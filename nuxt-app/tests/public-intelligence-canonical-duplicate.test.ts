import { beforeEach, describe, expect, it, vi } from 'vitest'

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
}

vi.mock('../server/audit/repository', () => ({ requireAuditDatabase: () => database }))

const { createOwnerPublicArtifact } = await import('../server/public-intelligence/repository')

describe('human annotation canonical-source protection', () => {
  beforeEach(() => {
    selectResults = [
      [{ id: 1, allowedUse: 'training_candidate', reviewStatus: 'approved', piiStatus: 'none_detected' }],
      [{ id: 999, sourceUrl: 'https://developers.google.com/search/docs/appearance/title-link?hl=en' }],
    ]
  })

  it('returns a governed 422 for a Google documentation language variant instead of throwing an undefined-helper error', async () => {
    await expect(createOwnerPublicArtifact({
      ownerUserId: 1,
      sourceId: 1,
      sourceUrl: 'https://developers.google.com/search/docs/appearance/title-link?hl=zh-tw',
      canonicalUrl: null,
      artifactType: 'human_annotation',
      artifactText: null,
      sourceLocator: 'human:canonical-duplicate-regression',
      sourceSpanHash: 'a'.repeat(64),
      fieldData: { primaryJourneyStage: 'discovery' },
      language: 'zh-Hant',
      extractionMethod: 'human_annotation',
      requestedUse: 'training_candidate',
      retentionUntil: null,
    })).rejects.toMatchObject({
      statusCode: 422,
      statusMessage: expect.stringContaining('An active human annotation already exists for this source document'),
    })
  })
})

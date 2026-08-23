import { beforeEach, describe, expect, it, vi } from 'vitest'
import { requireAuditDatabase } from '../server/audit/repository'
import { resolveApprovedEvidenceSnapshot } from '../server/seo-geo-core/repository'

vi.mock('../server/audit/repository', () => ({ requireAuditDatabase: vi.fn() }))

function queryReturning<T>(rows: T[]) {
  const query: any = {
    from: () => query,
    innerJoin: () => query,
    leftJoin: () => query,
    where: () => query,
    orderBy: () => query,
    limit: () => query,
    then: (resolve: (value: T[]) => unknown, reject: (reason: unknown) => unknown) => Promise.resolve(rows).then(resolve, reject),
  }
  return query
}

const approvedRows = [
  {
    approvalId: 11,
    approvalPurpose: 'recommendation',
    sourceId: 81,
    artifactId: 901,
    sourceName: 'Approved source',
    sourceUrl: 'https://example.com/',
    fallbackSourceUrl: 'https://example.com/',
    artifactType: 'derived_excerpt',
    artifactText: 'Reviewed source excerpt.',
    artifactLocator: 'https://example.com/#excerpt',
    artifactHash: 'approved-hash',
    fieldData: {},
  },
  {
    approvalId: 12,
    approvalPurpose: 'content_draft',
    sourceId: 81,
    artifactId: 901,
    sourceName: 'Approved source',
    sourceUrl: 'https://example.com/',
    fallbackSourceUrl: 'https://example.com/',
    artifactType: 'derived_excerpt',
    artifactText: 'Reviewed source excerpt.',
    artifactLocator: 'https://example.com/#excerpt',
    artifactHash: 'approved-hash',
    fieldData: {},
  },
]

describe('SEO/GEO evidence binding', () => {
  beforeEach(() => {
    vi.mocked(requireAuditDatabase).mockReturnValue({ select: () => queryReturning(approvedRows) } as any)
  })

  it('requires both requested purposes and returns canonical server evidence context', async () => {
    const snapshot = await resolveApprovedEvidenceSnapshot(7, [{ sourceId: 81, artifactId: 901, artifactHash: 'approved-hash', reason: 'client label is not trusted' }], ['recommendation', 'content_draft'], { requireArtifact: true })
    expect(snapshot.refs).toEqual([{ sourceId: 81, artifactId: 901, locator: 'https://example.com/#excerpt', artifactHash: 'approved-hash', reason: 'Evidence approval #11 已由 owner 明確核准用於 recommendation/content_draft' }])
    expect(snapshot.context).toContain('Reviewed source excerpt.')
    expect(snapshot.hash).toHaveLength(64)
    const sameSnapshot = await resolveApprovedEvidenceSnapshot(7, [{ sourceId: 81, artifactId: 901, artifactHash: 'approved-hash', reason: 'same canonical snapshot' }], 'content_draft', { requireArtifact: true })
    expect(sameSnapshot.hash).toBe(snapshot.hash)
  })

  it('fails closed when one required purpose is not approved', async () => {
    vi.mocked(requireAuditDatabase).mockReturnValue({ select: () => queryReturning([approvedRows[1]]) } as any)
    await expect(resolveApprovedEvidenceSnapshot(7, [{ sourceId: 81, artifactId: 901, reason: 'test' }], ['recommendation', 'content_draft'], { requireArtifact: true })).rejects.toMatchObject({ statusCode: 422 })
  })

  it('fails closed for stale hashes and source-only approvals in content generation', async () => {
    await expect(resolveApprovedEvidenceSnapshot(7, [{ sourceId: 81, artifactId: 901, artifactHash: 'stale-hash', reason: 'test' }], 'content_draft', { requireArtifact: true })).rejects.toMatchObject({ statusCode: 409 })
    vi.mocked(requireAuditDatabase).mockReturnValue({ select: () => queryReturning([{ ...approvedRows[1], artifactId: null, artifactHash: null, artifactType: null, artifactText: null }]) } as any)
    await expect(resolveApprovedEvidenceSnapshot(7, [{ sourceId: 81, reason: 'test' }], 'content_draft', { requireArtifact: true })).rejects.toMatchObject({ statusCode: 422 })
  })
})

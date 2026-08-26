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

const FRESH_APPROVED_AT = '2026-08-25T04:00:00.000Z'
const STALE_APPROVED_AT = '2026-08-01T04:00:00.000Z'
const baseRow = {
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
  approvedAt: FRESH_APPROVED_AT,
}

const approvedRows = [baseRow, { ...baseRow, approvalId: 12, approvalPurpose: 'content_draft' }]

function setRows(rows: unknown[]) {
  vi.mocked(requireAuditDatabase).mockReturnValue({ select: () => queryReturning(rows) } as any)
}

describe('SEO/GEO evidence binding', () => {
  beforeEach(() => setRows(approvedRows))

  it('requires recommendation and content_draft approvals and returns the server-resolved canonical snapshot', async () => {
    const snapshot = await resolveApprovedEvidenceSnapshot(7, [{ sourceId: 81, artifactId: 901, artifactHash: 'approved-hash', reason: 'client label is not trusted' }], ['recommendation', 'content_draft'], { requireArtifact: true, now: new Date('2026-08-26T04:00:00.000Z') })
    expect(snapshot.refs).toEqual([{ sourceId: 81, artifactId: 901, locator: 'https://example.com/#excerpt', artifactHash: 'approved-hash', approvedAt: FRESH_APPROVED_AT, reason: 'Evidence approval #11 已由 owner 明確核准用於 recommendation/content_draft' }])
    expect(snapshot.approvalTimestamps).toEqual([FRESH_APPROVED_AT])
    expect(snapshot.freshnessBasis).toBe(FRESH_APPROVED_AT)
    expect(snapshot.context).toContain('Reviewed source excerpt.')
    expect(snapshot.hash).toHaveLength(64)
    const sameSnapshot = await resolveApprovedEvidenceSnapshot(7, [{ sourceId: 81, artifactId: 901, artifactHash: 'approved-hash', reason: 'same canonical snapshot' }], 'content_draft', { requireArtifact: true, now: new Date('2026-08-26T04:00:00.000Z') })
    expect(sameSnapshot.hash).toBe(snapshot.hash)
  })

  it('requires content_draft purpose at the publication authority boundary', async () => {
    setRows([approvedRows[0]])
    await expect(resolveApprovedEvidenceSnapshot(7, [{ sourceId: 81, artifactId: 901, reason: 'recommendation-only approval is insufficient' }], 'content_draft', { requireArtifact: true })).rejects.toMatchObject({ statusCode: 422 })
    await expect(resolveApprovedEvidenceSnapshot(7, [{ sourceId: 81, artifactId: 901, reason: 'both purposes required' }], ['recommendation', 'content_draft'], { requireArtifact: true })).rejects.toMatchObject({ statusCode: 422 })
  })

  it('fails closed for no approval, wrong owner scope, revoked source, and removed source', async () => {
    for (const label of ['no approval', 'wrong owner', 'revoked approval', 'removed source']) {
      setRows([])
      await expect(resolveApprovedEvidenceSnapshot(7, [{ sourceId: 81, artifactId: 901, reason: label }], 'content_draft', { requireArtifact: true })).rejects.toMatchObject({ statusCode: 422 })
    }
  })

  it('fails closed for changed artifact hashes and source-only approval in content generation', async () => {
    await expect(resolveApprovedEvidenceSnapshot(7, [{ sourceId: 81, artifactId: 901, artifactHash: 'stale-hash', reason: 'changed artifact' }], 'content_draft', { requireArtifact: true })).rejects.toMatchObject({ statusCode: 409 })
    setRows([{ ...approvedRows[1], artifactId: null, artifactHash: null, artifactType: null, artifactText: null }])
    await expect(resolveApprovedEvidenceSnapshot(7, [{ sourceId: 81, reason: 'source-only approval' }], 'content_draft', { requireArtifact: true })).rejects.toMatchObject({ statusCode: 422 })
  })

  it('fails closed for missing, invalid, and future approval timestamps', async () => {
    for (const approvedAt of [undefined, 'not-a-date', '2026-08-27T00:00:00.000Z']) {
      setRows([{ ...approvedRows[1], approvedAt }])
      await expect(resolveApprovedEvidenceSnapshot(7, [{ sourceId: 81, artifactId: 901, reason: 'timestamp validation' }], 'content_draft', { requireArtifact: true, now: new Date('2026-08-26T04:00:00.000Z') })).rejects.toMatchObject({ statusCode: 409 })
    }
  })

  it('uses the oldest approvedAt as freshness basis for mixed fresh/stale evidence', async () => {
    const sourceTwo = { ...baseRow, approvalId: 21, sourceId: 82, approvalPurpose: 'content_draft', approvedAt: STALE_APPROVED_AT, artifactHash: 'approved-hash-2', artifactLocator: 'https://example.com/#second' }
    setRows([...approvedRows, sourceTwo, { ...sourceTwo, approvalId: 22, approvalPurpose: 'recommendation' }])
    const snapshot = await resolveApprovedEvidenceSnapshot(7, [{ sourceId: 81, artifactId: 901, artifactHash: 'approved-hash', reason: 'fresh source' }, { sourceId: 82, artifactId: 901, artifactHash: 'approved-hash-2', reason: 'stale source' }], ['recommendation', 'content_draft'], { requireArtifact: true, now: new Date('2026-08-26T04:00:00.000Z') })
    expect(snapshot.approvalTimestamps.sort()).toEqual([FRESH_APPROVED_AT, STALE_APPROVED_AT].sort())
    expect(snapshot.freshnessBasis).toBe(STALE_APPROVED_AT)
    expect(snapshot.refs.every(ref => ref.approvedAt)).toBe(true)
  })
})

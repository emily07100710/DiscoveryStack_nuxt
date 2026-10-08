import { createError, createEvent, defineEventHandler, type H3Event } from 'h3'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  owner: vi.fn(),
  privateHeaders: vi.fn(),
  readBody: vi.fn(),
  routerParam: vi.fn(),
  reviewDataset: vi.fn(),
  summarizeDecision: vi.fn(),
  mutation: vi.fn(),
}))

vi.mock('h3', async importOriginal => {
  const actual = await importOriginal<typeof import('h3')>()
  return { ...actual, getRouterParam: mocks.routerParam }
})
vi.mock('../server/api/geo-outcome-model/_helpers', () => ({
  requireGeoOutcomeOwner: mocks.owner,
  setGeoOutcomePrivateApiHeaders: mocks.privateHeaders,
  readGeoBody: mocks.readBody,
  strictKeys(body: Record<string, unknown>, allowed: string[]) {
    for (const key of Object.keys(body)) if (!allowed.includes(key)) throw createError({ statusCode: 422, statusMessage: `Unknown request field: ${key}.` })
  },
  requiredIdempotency(body: Record<string, unknown>) {
    if (typeof body.idempotencyKey !== 'string' || body.idempotencyKey.length < 8) throw createError({ statusCode: 422, statusMessage: 'A bounded idempotencyKey is required.' })
    return body.idempotencyKey
  },
  routeError(error: unknown): never {
    if (error && typeof error === 'object' && 'statusCode' in error) throw error
    throw createError({ statusCode: 422, statusMessage: error instanceof Error ? error.message : 'Rejected.' })
  },
  withMutationIdempotency: mocks.mutation,
}))
vi.mock('../server/geo-outcome-model', () => ({ reviewDataset: mocks.reviewDataset, summarizeDatasetDecision: mocks.summarizeDecision }))
vi.stubGlobal('defineEventHandler', defineEventHandler)
vi.stubGlobal('createError', createError)

const transaction = { transaction: true }
function event(): H3Event { const request = createEvent({ url: '/api/geo-outcome-model/datasets/manifest-1/review' } as never, {} as never); request.node.req.method = 'POST'; return request }
async function loadHandler() { return (await import('../server/api/geo-outcome-model/datasets/[id]/review.post')).default }

beforeEach(() => {
  vi.resetModules()
  mocks.owner.mockReset().mockResolvedValue({ ownerUserId: 41, openId: 'opaque-owner' })
  mocks.privateHeaders.mockReset()
  mocks.readBody.mockReset()
  mocks.routerParam.mockReset().mockReturnValue('manifest-1')
  mocks.reviewDataset.mockReset().mockResolvedValue({ manifest: { manifestId: 'manifest-1', status: 'approved' }, decision: { decisionId: 'decision-1' } })
  mocks.summarizeDecision.mockReset().mockImplementation((decision: Record<string, unknown>) => {
    const authority = decision.knowledgeAuthority as Record<string, unknown> | null | undefined
    return { ...decision, knowledgeAuthority: authority ? { mode: authority.mode, authorityFingerprint: authority.authorityFingerprint, activePinCount: (authority.heads as Array<{ operation: string }>).filter(head => head.operation === 'bind').length } : null }
  })
  mocks.mutation.mockReset().mockImplementation(async (_owner, _route, _key, _input, action) => action(transaction))
})

describe('GEO Knowledge authority dataset review route behavior', () => {
  it('requires owner auth before reading the request body', async () => {
    mocks.owner.mockRejectedValueOnce(createError({ statusCode: 401, statusMessage: 'Owner required.' }))
    const handler = await loadHandler()
    const request = event()
    await expect(handler(request)).rejects.toMatchObject({ statusCode: 401 })
    expect(mocks.privateHeaders).toHaveBeenCalledWith(request)
    expect(mocks.owner).toHaveBeenCalledOnce()
    expect(mocks.readBody).not.toHaveBeenCalled()
    expect(mocks.reviewDataset).not.toHaveBeenCalled()
  })

  it.each(['declared_none_v1', 'pinned_v1'] as const)('accepts explicit %s only with acknowledgment and passes it as server-derived options', async knowledgeMode => {
    mocks.readBody.mockResolvedValue({ idempotencyKey: 'dataset-review-0001', decision: 'approve', reason: 'Owner reviewed declaration.', knowledgeMode, knowledgeConfirmed: true })
    const handler = await loadHandler()
    await expect(handler(event())).resolves.toEqual({ status: 'success', manifest: { manifestId: 'manifest-1', status: 'approved' }, datasetDecision: { decisionId: 'decision-1', knowledgeAuthority: null }, receiptIsCurrentAuthority: false, automaticallyApproved: false })
    expect(mocks.mutation).toHaveBeenCalledWith(41, 'datasets/manifest-1/review', 'dataset-review-0001', { decision: 'approve', reason: 'Owner reviewed declaration.', knowledgeMode, knowledgeConfirmed: true }, expect.any(Function))
    expect(mocks.reviewDataset).toHaveBeenCalledOnce()
    expect(mocks.reviewDataset).toHaveBeenCalledWith(41, 'manifest-1', 'approve', 41, 'Owner reviewed declaration.', transaction, { knowledgeMode })
  })

  it.each([
    [{ decision: 'approve', knowledgeMode: 'declared_none_v1', knowledgeConfirmed: false }, 'Confirm the displayed Knowledge dependency declaration before approval.'],
    [{ decision: 'approve', knowledgeMode: 'future_mode', knowledgeConfirmed: true }, 'An explicit Knowledge dependency declaration is required.'],
    [{ decision: 'approve', knowledgeConfirmed: true }, 'An explicit Knowledge dependency declaration is required.'],
    [{ decision: 'approve', knowledgeMode: 'pinned_v1' }, 'Confirm the displayed Knowledge dependency declaration before approval.'],
  ] as const)('rejects incomplete or unsupported approval declarations before mutation', async (values, expected) => {
    mocks.readBody.mockResolvedValue({ idempotencyKey: 'dataset-review-0001', reason: 'Review.', ...values })
    const handler = await loadHandler()
    await expect(handler(event())).rejects.toMatchObject({ statusCode: 422, statusMessage: expected })
    expect(mocks.mutation).not.toHaveBeenCalled()
    expect(mocks.reviewDataset).not.toHaveBeenCalled()
  })

  it('rejects unknown caller authority, including pins, hashes, owner, and version', async () => {
    for (const field of ['pins', 'authorityFingerprint', 'ownerUserId', 'version']) {
      vi.resetModules()
      mocks.readBody.mockReset().mockResolvedValue({ idempotencyKey: 'dataset-review-0001', decision: 'approve', reason: 'Review.', knowledgeMode: 'pinned_v1', knowledgeConfirmed: true, [field]: 'caller-value' })
      const handler = await loadHandler()
      await expect(handler(event())).rejects.toMatchObject({ statusCode: 422, statusMessage: `Unknown request field: ${field}.` })
      expect(mocks.mutation).not.toHaveBeenCalled()
    }
  })

  it('revokes without Knowledge fields and fingerprints only the actual revoke command', async () => {
    mocks.readBody.mockResolvedValue({ idempotencyKey: 'dataset-review-0001', decision: 'revoke', reason: 'Owner revoked.' })
    mocks.reviewDataset.mockResolvedValueOnce({ manifest: { manifestId: 'manifest-1', status: 'revoked' }, decision: { decisionId: 'decision-2' } })
    const handler = await loadHandler()
    await expect(handler(event())).resolves.toMatchObject({ status: 'success', manifest: { status: 'revoked' } })
    expect(mocks.mutation).toHaveBeenCalledWith(41, 'datasets/manifest-1/review', 'dataset-review-0001', { decision: 'revoke', reason: 'Owner revoked.' }, expect.any(Function))
    expect(mocks.reviewDataset).toHaveBeenCalledOnce()
    expect(mocks.reviewDataset).toHaveBeenCalledWith(41, 'manifest-1', 'revoke', 41, 'Owner revoked.', transaction, undefined)
  })

  it('rejects Knowledge fields on revoke rather than making them invisible to idempotency', async () => {
    mocks.readBody.mockResolvedValue({ idempotencyKey: 'dataset-review-0001', decision: 'revoke', reason: 'Owner revoked.', knowledgeMode: 'declared_none_v1' })
    const handler = await loadHandler()
    await expect(handler(event())).rejects.toMatchObject({ statusCode: 422, statusMessage: 'Knowledge declaration fields are only valid for dataset approval.' })
    expect(mocks.mutation).not.toHaveBeenCalled()
  })

  it('returns a bounded decision summary and labels historical idempotent receipts as not current authority', async () => {
    const rawDecision = {
      decisionId: 'geo-dataset-decision-cccccccccccccccccccc', ownerUserId: 41, manifestId: 'manifest-1', manifestFingerprint: 'a'.repeat(64),
      previousStatus: 'ready_for_review', newStatus: 'approved', reviewerUserId: 41, reason: 'Owner approved pins.', createdAt: '2026-10-08T00:00:00.000Z',
      knowledgeAuthority: {
        schemaVersion: 'geo-dataset-knowledge-authority-v1', ownerUserId: 41, manifestId: 'manifest-1', manifestFingerprint: 'a'.repeat(64),
        nativeDatasetId: 903, heads: [{ subjectKind: 'entity', subjectId: 808, operation: 'bind', sequenceNumber: 1 }],
        mode: 'pinned_v1', authorityFingerprint: 'b'.repeat(64),
      },
    }
    mocks.readBody.mockResolvedValue({ idempotencyKey: 'dataset-review-0001', decision: 'approve', reason: 'Owner approved pins.', knowledgeMode: 'pinned_v1', knowledgeConfirmed: true })
    mocks.reviewDataset.mockResolvedValueOnce({ manifest: { manifestId: 'manifest-1', manifestFingerprint: rawDecision.manifestFingerprint, status: 'approved' }, decision: rawDecision })
    const handler = await loadHandler()
    const result = await handler(event()) as Record<string, unknown>
    expect(mocks.summarizeDecision).toHaveBeenCalledWith(rawDecision)
    expect(result).toMatchObject({ receiptIsCurrentAuthority: false, automaticallyApproved: false })
    expect(result.datasetDecision).toMatchObject({ decisionId: rawDecision.decisionId, knowledgeAuthority: { mode: 'pinned_v1', authorityFingerprint: 'b'.repeat(64), activePinCount: 1 } })
    const serialized = JSON.stringify(result)
    expect(serialized).not.toContain('heads')
    expect(serialized).not.toContain('nativeDatasetId')
    expect(serialized).not.toContain('subjectId')
  })
})

import { describe, expect, it, vi } from 'vitest'
import { executeFirstPartyPublication, normalizeFirstPartyDraftReceipt } from '../server/first-party-publishing'
import { makePublication, makeSignedTarget, FIXTURE_NOW, response, sha256 } from './fixtures/first-party-publishing/fixtures'

const secret = 'synthetic-only-signed-api-secret-000000000000'
const nonce = 'synthetic-nonce-00000001'
const target = () => makeSignedTarget({ framework: 'nextjs', targetOrigin: 'https://doalignment.test', allowedLanguages: ['zh-hant'] })
const receipt = (overrides: Record<string, unknown> = {}) => ({
  status: 'draft_received', published: false, receiptScope: 'draft_ingest_outcome', receiptIsCurrentState: false,
  publicationId: 'deliverable-001', contentHash: sha256('這是一段可重現的第一方網站內容。\n\nIt is deterministic and source-bound.'),
  postId: '9b131e17-a5c2-45e1-a40f-44b6084de9b1', postVersion: 1, replayed: false,
  ...overrides,
})

function run(payload: unknown, status = 202, destination = target()) {
  const fetchImpl = vi.fn(async () => response(status, payload))
  const serverCredentialResolver = vi.fn(async () => ({ ok: true as const, value: secret }))
  const result = executeFirstPartyPublication({ target: destination, publication: makePublication(), now: FIXTURE_NOW, mode: 'execute', fetchImpl, serverCredentialResolver, nonceProvider: () => nonce })
  return { result, fetchImpl, serverCredentialResolver }
}

describe('first-party signed API draft receipt', () => {
  it('normalizes exactly the bounded nine-field receipt and safely rejects hostile getters/proxies', () => {
    expect(normalizeFirstPartyDraftReceipt(receipt())).toEqual(receipt())
    expect(normalizeFirstPartyDraftReceipt({ ...receipt(), extra: true })).toBeNull()
    expect(normalizeFirstPartyDraftReceipt({ ...receipt(), published: true })).toBeNull()
    expect(normalizeFirstPartyDraftReceipt(new Proxy({}, { ownKeys: () => { throw new Error('fixture') } }))).toBeNull()
    const withGetter = { ...receipt(), get status() { throw new Error('fixture') } }
    expect(normalizeFirstPartyDraftReceipt(withGetter)).toBeNull()
  })

  it('returns a distinct draft_received outcome only for matching Next.js HTTP 202 receipts', async () => {
    const { result, fetchImpl } = run(receipt())
    await expect(result).resolves.toMatchObject({ status: 'draft_received', receipt: receipt(), artifactFingerprint: expect.any(String), idempotencyKey: expect.any(String) })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['wrong publication', receipt({ publicationId: 'other-publication' })],
    ['wrong content hash', receipt({ contentHash: '0'.repeat(64) })],
    ['wrong version', receipt({ postVersion: 2 })],
    ['published contradiction', receipt({ published: true })],
    ['current-state contradiction', receipt({ receiptIsCurrentState: true })],
    ['legacy revision mixed in', { ...receipt(), remoteRevision: 'revision-1' }],
    ['unknown field', { ...receipt(), currentStatus: 'published' }],
  ])('blocks %s without mapping it to delivery', async (_name, payload) => {
    const { result } = run(payload)
    await expect(result).resolves.toMatchObject({ status: 'blocked' })
  })

  it('blocks draft markers on the wrong status or framework', async () => {
    await expect(run(receipt(), 200).result).resolves.toMatchObject({ status: 'blocked' })
    await expect(run(receipt(), 202, makeSignedTarget({ framework: 'nuxt' })).result).resolves.toMatchObject({ status: 'blocked' })
  })

  it('preserves matching legacy delivered receipts with remoteRevision', async () => {
    const { result } = run({ publicationId: 'deliverable-001', contentHash: receipt().contentHash, remoteRevision: 'revision-legacy-001' }, 200)
    await expect(result).resolves.toMatchObject({ status: 'delivered', publicationId: 'deliverable-001', remoteRevision: 'revision-legacy-001' })
  })

  it('preserves replay metadata, and dry_run makes zero transport or credential calls', async () => {
    const replay = run(receipt({ replayed: true }))
    await expect(replay.result).resolves.toMatchObject({ status: 'draft_received', receipt: { replayed: true } })
    const fetchImpl = vi.fn()
    const serverCredentialResolver = vi.fn()
    const dryRun = await executeFirstPartyPublication({ target: target(), publication: makePublication(), now: FIXTURE_NOW, mode: 'dry_run', fetchImpl, serverCredentialResolver, nonceProvider: () => nonce })
    expect(dryRun.status).toBe('dry_run')
    expect(fetchImpl).not.toHaveBeenCalled()
    expect(serverCredentialResolver).not.toHaveBeenCalled()
  })
})

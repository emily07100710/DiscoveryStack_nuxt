import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'

const calls = vi.hoisted(() => ({ auth: vi.fn(), owner: vi.fn(), list: vi.fn(), factory: vi.fn(), readiness: vi.fn(), headers: vi.fn() }))
vi.mock('../server/utils/auth', () => ({ requireOwner: calls.auth }))
vi.mock('../server/audit/repository', () => ({ getOwnerDatabaseUserId: calls.owner }))
vi.mock('../server/managed-sites/email-outbox/repository', () => ({ createManagedSiteEmailOutboxRepository: calls.factory }))
vi.mock('../server/managed-sites/email-outbox/configuration', () => ({ managedSiteEmailOutboxReadinessFromEnv: calls.readiness }))
vi.mock('h3', async () => { const original = await vi.importActual<typeof import('h3')>('h3'); return { ...original, setResponseHeaders: calls.headers } })
let handler: (event: unknown) => Promise<any>
beforeAll(async () => {
  vi.stubGlobal('defineEventHandler', (value: unknown) => value)
  handler = (await import('../server/api/managed-sites/email-outbox/index.get')).default as unknown as typeof handler
})
afterAll(() => { vi.unstubAllGlobals() })
beforeEach(() => {
  vi.clearAllMocks()
  calls.auth.mockResolvedValue({ openId: 'fixture-owner' })
  calls.owner.mockResolvedValue(7)
  calls.factory.mockReturnValue({ listSafeMetadata: calls.list })
  calls.list.mockResolvedValue([])
  calls.readiness.mockReturnValue({ configured: false, enabled: false })
})
describe('owner mail status inspection', () => {
  it('authenticates before owner storage queries and ignores client owner/limit hints', async () => {
    const result = await handler({ query: { ownerUserId: 999, limit: 999 } })
    expect(calls.auth).toHaveBeenCalledTimes(1)
    expect(calls.owner).toHaveBeenCalledExactlyOnceWith('fixture-owner')
    expect(calls.list).toHaveBeenCalledExactlyOnceWith({ ownerUserId: 7, limit: 50 })
    expect(result).toMatchObject({ items: [], limit: 50, prePurchaseChallengesExcluded: true, inboxDeliveryVerified: false })
    expect(calls.headers).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ 'cache-control': 'private, no-store, max-age=0', 'referrer-policy': 'no-referrer' }))
  })
  it('refuses storage work for a missing owner session', async () => {
    calls.auth.mockRejectedValueOnce(new Error('owner-session-required'))
    await expect(handler({})).rejects.toThrow('owner-session-required')
    for (const call of [calls.owner, calls.factory, calls.list, calls.readiness]) expect(call).not.toHaveBeenCalled()
  })
  it('projects fields explicitly, even when a repository accidentally adds private fields', async () => {
    calls.list.mockResolvedValue([{ id: 'safe-id', purpose: 'member_invitation', status: 'accepted', createdAt: new Date(), updatedAt: new Date(), nextAttemptAt: new Date(), expiresAt: new Date(), attemptCount: 1, lastErrorCode: null, encryptedPayload: 'private-ciphertext', idempotencyKey: 'private-key', context: { token: 'bearer' }, to: 'private@example.test', providerReceiptId: 'private-receipt', payloadFingerprint: 'private-fingerprint' }])
    const result = await handler({})
    expect(result.items).toHaveLength(1)
    const output = JSON.stringify(result)
    for (const forbidden of ['private-ciphertext', 'private-key', 'bearer', 'private@example', 'private-receipt', 'private-fingerprint', 'encryptedPayload', 'idempotencyKey', 'providerReceiptId']) expect(output).not.toContain(forbidden)
  })
  it('does not expose storage exceptions or fabricate an empty successful queue', async () => {
    calls.list.mockRejectedValueOnce(new Error('mysql://private-token@host/db'))
    await expect(handler({})).rejects.toMatchObject({ statusCode: 503, statusMessage: '郵件紀錄暫時無法讀取，請確認資料庫更新與設定。' })
  })
  it('keeps the UI read-only, private and honest about provider acceptance', () => {
    const source = readFileSync(new URL('../pages/audit-lab/email-delivery.vue', import.meta.url), 'utf8')
    expect(source).toContain("definePageMeta({ layout: 'owner' })")
    expect(source).toContain('/api/managed-sites/email-outbox')
    expect(source).toContain('尚不代表客戶實際收到郵件')
    expect(source).toContain('不是全平台總數')
    expect(source).not.toContain('$fetch')
    expect(source).not.toContain('method:')
  })
})

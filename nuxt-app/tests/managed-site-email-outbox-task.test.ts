import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const calls = vi.hoisted(() => ({ config: vi.fn(() => ({ ownerOpenId: 'fixture-owner' })), owner: vi.fn(async () => 7), readiness: vi.fn(() => ({ configured: true })), processOne: vi.fn(), runtime: vi.fn(), cleanup: vi.fn(async () => 2), repository: vi.fn() }))
vi.mock('../server/audit/repository', () => ({ resolveControlledOwnerDatabaseUserId: calls.owner }))
vi.mock('../server/managed-sites/email-outbox/configuration', () => ({ managedSiteEmailOutboxReadinessFromEnv: calls.readiness }))
vi.mock('../server/managed-sites/email-outbox/runtime', () => ({ getManagedSiteEmailOutboxRuntime: calls.runtime }))
vi.mock('../server/managed-sites/email-outbox/repository', () => ({ createManagedSiteEmailOutboxRepository: calls.repository }))
let task: typeof import('../server/tasks/managed-site-email-outbox-tick').default
beforeAll(async () => {
  vi.stubGlobal('defineTask', (value: unknown) => value)
  vi.stubGlobal('useRuntimeConfig', calls.config)
  task = (await import('../server/tasks/managed-site-email-outbox-tick')).default
})
beforeEach(() => {
  vi.clearAllMocks()
  vi.stubEnv('NUXT_MANAGED_SITE_EMAIL_OUTBOX_RETENTION_ENABLED', 'false')
  calls.readiness.mockReturnValue({ configured: true })
  calls.owner.mockResolvedValue(7)
  calls.runtime.mockReturnValue({ processOne: calls.processOne })
  calls.repository.mockReturnValue({ cancelExpired: calls.cleanup })
  calls.processOne.mockResolvedValue(null)
})
afterEach(() => { vi.unstubAllEnvs() })
const event = { name: 'email-task-test', context: {}, payload: { enabled: true, ownerUserId: 999, maxItems: 999, itemId: 'client-chosen', NUXT_MANAGED_SITE_EMAIL_OUTBOX_ENABLED: 'true' } }

describe('platform email scheduled execution', () => {
  it.each([undefined, '', 'false', 'TRUE', '1', 'yes', ' true '])('does zero I/O unless server flag is exact true (%j)', async flag => {
    vi.stubEnv('NUXT_MANAGED_SITE_EMAIL_OUTBOX_ENABLED', flag)
    expect(await task.run(event)).toEqual({ result: { status: 'disabled', processed: 0 } })
    for (const call of [calls.config, calls.owner, calls.readiness, calls.runtime, calls.repository, calls.processOne, calls.cleanup]) expect(call).not.toHaveBeenCalled()
  })
  it('does not open storage or runtime when transport/encryption settings are missing', async () => {
    vi.stubEnv('NUXT_MANAGED_SITE_EMAIL_OUTBOX_ENABLED', 'true')
    calls.readiness.mockReturnValue({ configured: false })
    expect(await task.run(event)).toEqual({ result: { status: 'unconfigured', processed: 0 } })
    for (const call of [calls.config, calls.owner, calls.runtime, calls.repository, calls.processOne]) expect(call).not.toHaveBeenCalled()
  })
  it('processes at most three individual claims with server-owned identity and safe counts only', async () => {
    vi.stubEnv('NUXT_MANAGED_SITE_EMAIL_OUTBOX_ENABLED', 'true')
    calls.processOne.mockResolvedValue({ accepted: true, itemId: 'server-item', receiptId: 'private-provider-receipt' })
    const result = await task.run(event)
    expect(calls.owner).toHaveBeenCalledExactlyOnceWith('fixture-owner')
    expect(calls.processOne).toHaveBeenCalledTimes(3)
    expect(calls.processOne.mock.calls).toEqual([[], [], []])
    expect(result.result).toMatchObject({ status: 'processed', processed: 3, accepted: 3, inboxDeliveryVerified: false })
    expect(JSON.stringify(result)).not.toContain('private-provider-receipt')
    expect(JSON.stringify(result)).not.toContain('server-item')
  })
  it('records pending/cancelled/manual outcomes without claiming delivery', async () => {
    vi.stubEnv('NUXT_MANAGED_SITE_EMAIL_OUTBOX_ENABLED', 'true')
    calls.processOne.mockResolvedValueOnce({ accepted: false, itemId: 'a', status: 'queued', code: 'provider_unavailable' }).mockResolvedValueOnce({ accepted: false, itemId: 'b', status: 'cancelled', code: 'authority_stale' }).mockResolvedValueOnce({ accepted: false, itemId: 'c', status: 'manual_required', code: 'attempt_limit' })
    expect((await task.run(event)).result).toMatchObject({ processed: 3, accepted: 0, queued: 1, cancelled: 1, manualRequired: 1 })
  })
  it('cleans expired ciphertext with delivery disabled and never constructs a provider runtime', async () => {
    vi.stubEnv('NUXT_MANAGED_SITE_EMAIL_OUTBOX_ENABLED', 'false')
    vi.stubEnv('NUXT_MANAGED_SITE_EMAIL_OUTBOX_RETENTION_ENABLED', 'true')
    expect((await task.run(event)).result).toEqual({ status: 'retention_only', processed: 0, expiredCleaned: 2 })
    expect(calls.cleanup).toHaveBeenCalledExactlyOnceWith({ now: expect.any(Date), limit: 50 })
    for (const call of [calls.readiness, calls.runtime, calls.processOne]) expect(call).not.toHaveBeenCalled()
  })
  it('fails closed before provider work if controlled owner resolution fails', async () => {
    vi.stubEnv('NUXT_MANAGED_SITE_EMAIL_OUTBOX_ENABLED', 'true')
    calls.owner.mockRejectedValueOnce(new Error('private-token-and-email'))
    const result = await task.run(event)
    expect(result.result).toMatchObject({ status: 'deferred', processed: 0, reasonCode: 'EMAIL_OUTBOX_DEFERRED' })
    expect(JSON.stringify(result)).not.toContain('private-token-and-email')
    expect(calls.runtime).not.toHaveBeenCalled()
  })
  it('stops before acquiring another item when the tick budget has elapsed', async () => {
    vi.stubEnv('NUXT_MANAGED_SITE_EMAIL_OUTBOX_ENABLED', 'true')
    const date = vi.spyOn(Date, 'now').mockReturnValueOnce(1000).mockReturnValueOnce(1000).mockReturnValue(47000)
    calls.processOne.mockResolvedValue({ accepted: false, itemId: 'pending-item', status: 'queued', code: 'provider_unavailable' })
    try { expect((await task.run(event)).result).toMatchObject({ processed: 1, queued: 1 }); expect(calls.processOne).toHaveBeenCalledTimes(1) } finally { date.mockRestore() }
  })
})

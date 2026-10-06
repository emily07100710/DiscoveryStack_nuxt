import { describe, expect, it, vi } from 'vitest'
import type { ManagedSiteEmailOutboxClaim, ManagedSiteEmailOutboxInsert, ManagedSiteEmailOutboxItem, ManagedSiteEmailOutboxRepository } from '../server/managed-sites/email-outbox/types'
import { createManagedSiteEmailOutboxService } from '../server/managed-sites/email-outbox/service'
import { decryptPayload, fingerprint, privateFingerprint } from '../server/managed-sites/email-outbox/crypto'

const UUID = '123e4567-e89b-42d3-a456-426614174000'
const SECRET = 'independent-test-encryption-secret-32-bytes-minimum'
const CONFIG = 'a'.repeat(64)
const NOW = new Date('2026-10-07T00:00:00.000Z')
const context = () => ({ purpose: 'member_invitation' as const, ownerUserId: 7, projectId: 11, authority: { invitationId: 19, tokenHash: 'b'.repeat(64) }, expiresAt: new Date(NOW.getTime() + 60_000) })
const message = (to = 'member@example.com') => ({ to, subject: 'Invitation', text: 'Private invitation token', idempotencyKey: 'invite:19' })

function sharedRepository() {
  const rows = new Map<string, ManagedSiteEmailOutboxItem>()
  const byKey = new Map<string, string>()
  let renewHook: () => Promise<void> = async () => {}
  const repo: ManagedSiteEmailOutboxRepository = {
    async insertOrGet(input: ManagedSiteEmailOutboxInsert) {
      const key = `${input.purpose}:${input.idempotencyKey}`
      const existingId = byKey.get(key)
      if (existingId) return rows.get(existingId)!
      const row: ManagedSiteEmailOutboxItem = { ...input, status: 'queued', attemptCount: 0, firstAttemptAt: null, leaseToken: null, leaseExpiresAt: null, safeCode: null, providerReceiptId: null, acceptedAt: null, createdAt: NOW, updatedAt: NOW }
      rows.set(input.id, row); byKey.set(key, input.id)
      return row
    },
    async getById(id) { return rows.get(id) || null },
    async listSafeMetadata() { return [] },
    async cancelExpired() { return 0 },
    async claimOne(input) {
      const row = [...rows.values()].find(row => (!input.id || input.id === row.id) && ((row.status === 'queued' && row.nextAttemptAt <= input.now || row.status === 'reconcile_pending' && row.nextAttemptAt <= input.now && (!row.leaseToken || row.leaseExpiresAt! <= input.now)) || row.status === 'processing' && row.leaseExpiresAt! <= input.now) && (row.status === 'reconcile_pending' || row.attemptCount < input.maxAttempts))
      if (!row) return null
      row.status = 'processing'; row.leaseToken = input.leaseToken; row.leaseExpiresAt = input.leaseExpiresAt
      return { item: row, leaseToken: input.leaseToken } satisfies ManagedSiteEmailOutboxClaim
    },
    async beginAttempt(input) { const row = rows.get(input.id); if (!row || row.leaseToken !== input.leaseToken || row.status !== 'processing') return null; row.attemptCount++; row.firstAttemptAt ||= input.now; return row },
    async renew(input) { await renewHook(); const row = rows.get(input.id); if (!row || !['processing', 'reconcile_pending'].includes(row.status) || row.leaseToken !== input.leaseToken || row.leaseExpiresAt! <= input.now) return false; row.leaseExpiresAt = input.leaseExpiresAt; return true },
    async accepted(input) { const row = rows.get(input.id); if (!row || row.status !== 'processing' || row.leaseToken !== input.leaseToken) return false; row.status = 'reconcile_pending'; row.providerReceiptId = input.providerReceiptId; row.acceptedAt = input.now; return true },
    async reconciliationComplete(input) { const row = rows.get(input.id); if (!row || !['processing', 'reconcile_pending'].includes(row.status) || row.leaseToken !== input.leaseToken) return false; row.status = 'accepted'; row.encryptedPayload = null; row.leaseToken = null; row.leaseExpiresAt = null; return true },
    async retry(input) { const row = rows.get(input.id); if (!row || row.leaseToken !== input.leaseToken) return false; row.status = row.acceptedAt ? 'reconcile_pending' : 'queued'; row.nextAttemptAt = input.nextAttemptAt; row.safeCode = input.safeCode; row.leaseToken = null; row.leaseExpiresAt = null; return true },
    async finish(input) { const row = rows.get(input.id); if (!row || row.leaseToken !== input.leaseToken) return false; row.status = input.status; row.encryptedPayload = null; row.safeCode = input.safeCode; row.leaseToken = null; row.leaseExpiresAt = null; return true },
  }
  return { repo, rows, setRenewHook(hook: () => Promise<void>) { renewHook = hook } }
}

function service(input: { repo: ManagedSiteEmailOutboxRepository; send?: () => Promise<{ delivered: true; providerMessageId: string }>; resolve?: () => Promise<{ current: boolean; afterAccept?: (receiptId: string) => Promise<void> }>; enabled?: boolean; secret?: string; clock?: () => Date } ) {
  const send = vi.fn(input.send || (async () => ({ delivered: true as const, providerMessageId: UUID })))
  const resolveAuthority = vi.fn(input.resolve || (async () => ({ current: true })))
  const instance = createManagedSiteEmailOutboxService({ repository: input.repo, encryptionSecret: input.secret ?? SECRET, providerConfigurationFingerprint: CONFIG, transport: { configured: true, send }, resolveAuthority, clock: input.clock || (() => new Date(NOW)), executionEnabled: input.enabled ?? true })
  return { instance, send, resolveAuthority }
}

describe('managed-site email outbox core', () => {
  it('stores only encrypted private payload and sends only after an explicit post-commit attempt', async () => {
    const shared = sharedRepository()
    const first = service({ repo: shared.repo, enabled: false })
    const staged = await first.instance.enqueueOnly({ idempotencyKey: 'invite:19', context: context(), message: message() })
    expect(staged).toMatchObject({ accepted: false, status: 'queued', code: 'outbox_disabled' })
    const row = shared.rows.get(staged.itemId!)!
    expect(row.encryptedPayload).toMatch(/^v1\./u)
    expect(JSON.stringify(row)).not.toContain('member@example.com')
    expect(JSON.stringify(row)).not.toContain('Private invitation token')
    expect(first.send).not.toHaveBeenCalled()

    const afterRestart = service({ repo: shared.repo })
    await expect(afterRestart.instance.attempt(row.id)).resolves.toEqual({ accepted: true, itemId: row.id, receiptId: UUID })
    expect(afterRestart.send).toHaveBeenCalledTimes(1)
    expect(shared.rows.get(row.id)?.encryptedPayload).toBeNull()
  })

  it('returns the original item for exact replay and fails closed on payload or authority collisions', async () => {
    const shared = sharedRepository()
    const current = service({ repo: shared.repo })
    const first = await current.instance.enqueueOnly({ idempotencyKey: 'invite:19', context: context(), message: message() })
    const replay = await current.instance.enqueueOnly({ idempotencyKey: 'invite:19', context: context(), message: message() })
    const changedPayload = await current.instance.enqueueOnly({ idempotencyKey: 'invite:19', context: context(), message: message('other@example.com') })
    const changedAuthority = await current.instance.enqueueOnly({ idempotencyKey: 'invite:19', context: { ...context(), authority: { invitationId: 19, tokenHash: 'c'.repeat(64) } }, message: message() })
    expect(replay.itemId).toBe(first.itemId)
    expect(changedPayload).toMatchObject({ accepted: false, status: 'manual_required', code: 'outbox_collision' })
    expect(changedAuthority).toMatchObject({ accepted: false, status: 'manual_required', code: 'outbox_collision' })
  })

  it('does not invoke a provider with missing encryption configuration or stale authority', async () => {
    const unavailable = sharedRepository()
    const noSecret = service({ repo: unavailable.repo, secret: '' })
    expect(await noSecret.instance.enqueueAndAttempt({ idempotencyKey: 'invite:19', context: context(), message: message() })).toMatchObject({ accepted: false, status: 'queued', code: 'outbox_unconfigured' })
    expect(noSecret.send).not.toHaveBeenCalled()

    const stale = sharedRepository()
    const denied = service({ repo: stale.repo, resolve: async () => ({ current: false }) })
    const queued = await denied.instance.enqueueOnly({ idempotencyKey: 'invite:19', context: context(), message: message() })
    expect(await denied.instance.attempt(queued.itemId!)).toMatchObject({ accepted: false, status: 'cancelled', code: 'authority_stale' })
    expect(denied.send).not.toHaveBeenCalled()
  })

  it('uses a durable accepted receipt to retry only the idempotent reconciliation callback', async () => {
    const shared = sharedRepository()
    let callbacks = 0
    const first = service({ repo: shared.repo, resolve: async () => ({ current: true, afterAccept: async receiptId => { expect(receiptId).toBe(UUID); callbacks++; if (callbacks === 1) throw new Error('temporary reconciliation error') } }) })
    const queued = await first.instance.enqueueOnly({ idempotencyKey: 'invite:19', context: context(), message: message() })
    expect(await first.instance.attempt(queued.itemId!)).toMatchObject({ accepted: false, status: 'queued' })
    expect(shared.rows.get(queued.itemId!)?.status).toBe('reconcile_pending')
    shared.rows.get(queued.itemId!)!.nextAttemptAt = NOW
    const restarted = service({ repo: shared.repo, resolve: async () => ({ current: true, afterAccept: async receiptId => { expect(receiptId).toBe(UUID); callbacks++ } }) })
    await expect(restarted.instance.attempt(queued.itemId!)).resolves.toEqual({ accepted: true, itemId: queued.itemId, receiptId: UUID })
    expect(first.send).toHaveBeenCalledTimes(1)
    expect(restarted.send).not.toHaveBeenCalled()
    expect(callbacks).toBe(2)
  })

  it('rejects ciphertext tampering and a wrong encryption key', async () => {
    const shared = sharedRepository()
    const current = service({ repo: shared.repo })
    const queued = await current.instance.enqueueOnly({ idempotencyKey: 'invite:19', context: context(), message: message() })
    const row = shared.rows.get(queued.itemId!)!
    const input = { secret: SECRET, encryptedPayload: row.encryptedPayload!, id: row.id, ownerUserId: row.ownerUserId, projectId: row.projectId, purpose: row.purpose, authorityFingerprint: row.authorityFingerprint, payloadFingerprint: row.payloadFingerprint, contextFingerprint: row.contextFingerprint, providerConfigurationFingerprint: row.providerConfigurationFingerprint }
    expect(() => decryptPayload({ ...input, secret: 'wrong-secret-that-is-definitely-long-enough' })).toThrow()
    expect(() => decryptPayload({ ...input, providerConfigurationFingerprint: 'e'.repeat(64) })).toThrow()
    expect(() => decryptPayload({ ...input, encryptedPayload: `${input.encryptedPayload.slice(0, -2)}aa` })).toThrow()
    expect(() => decryptPayload({ ...input, encryptedPayload: `v1.${'A'.repeat(350 * 1024)}` })).toThrow()
  })

  it('uses a keyed private-payload fingerprint so low-entropy verification content cannot be recovered offline', async () => {
    const sample = { code: '120643', to: 'member@example.com' }
    expect(privateFingerprint(sample, SECRET)).not.toBe(fingerprint(sample))
    expect(privateFingerprint(sample, SECRET)).not.toBe(privateFingerprint(sample, 'a-different-independent-secret-with-sufficient-length'))
  })

  it('round trips the full 64 KiB quote-heavy text allowed by transport validation', async () => {
    const shared = sharedRepository()
    const current = service({ repo: shared.repo, enabled: false })
    const text = '"'.repeat(64 * 1024)
    const queued = await current.instance.enqueueOnly({ idempotencyKey: 'invite:19', context: context(), message: { ...message(), text } })
    expect(queued).toMatchObject({ accepted: false, status: 'queued' })
    const row = shared.rows.get(queued.itemId!)!
    expect(row.encryptedPayload!.length).toBeLessThanOrEqual(350 * 1024)
    const payload = decryptPayload({ secret: SECRET, encryptedPayload: row.encryptedPayload!, id: row.id, ownerUserId: row.ownerUserId, projectId: row.projectId, purpose: row.purpose, authorityFingerprint: row.authorityFingerprint, payloadFingerprint: row.payloadFingerprint, contextFingerprint: row.contextFingerprint, providerConfigurationFingerprint: row.providerConfigurationFingerprint })
    expect(Buffer.byteLength(payload.message.text, 'utf8')).toBe(64 * 1024)
    expect(payload.message.text).toBe(text)
  })

  it('allows only one overlapping worker to claim and send an item', async () => {
    const shared = sharedRepository()
    let release!: (value: { delivered: true; providerMessageId: string }) => void
    const pending = new Promise<{ delivered: true; providerMessageId: string }>(resolve => { release = resolve })
    const worker = service({ repo: shared.repo, send: () => pending })
    const queued = await worker.instance.enqueueOnly({ idempotencyKey: 'invite:19', context: context(), message: message() })
    const one = worker.instance.attempt(queued.itemId!)
    await vi.waitFor(() => expect(worker.send).toHaveBeenCalledTimes(1))
    const two = await worker.instance.attempt(queued.itemId!)
    expect(two).toMatchObject({ accepted: false, status: 'queued' })
    release({ delivered: true, providerMessageId: UUID })
    await expect(one).resolves.toMatchObject({ accepted: true, receiptId: UUID })
    expect(worker.send).toHaveBeenCalledTimes(1)
  })

  it('prevents a slow stale authority resolver from sending after another worker reclaims the lease', async () => {
    const shared = sharedRepository()
    let now = new Date(NOW)
    let releaseResolver!: () => void
    const resolverGate = new Promise<void>(resolve => { releaseResolver = resolve })
    let calls = 0
    const staleWorker = service({ repo: shared.repo, clock: () => new Date(now), resolve: async () => { calls++; if (calls === 2) await resolverGate; return { current: true } } })
    const queued = await staleWorker.instance.enqueueOnly({ idempotencyKey: 'invite:19', context: { ...context(), expiresAt: new Date(NOW.getTime() + 10 * 60_000) }, message: message() })
    const staleAttempt = staleWorker.instance.attempt(queued.itemId!)
    await vi.waitFor(() => expect(calls).toBe(2))

    now = new Date(NOW.getTime() + 61_000)
    const currentWorker = service({ repo: shared.repo, clock: () => new Date(now) })
    await expect(currentWorker.instance.attempt(queued.itemId!)).resolves.toMatchObject({ accepted: true, receiptId: UUID })
    releaseResolver()
    await expect(staleAttempt).resolves.toMatchObject({ accepted: false, status: 'queued' })
    expect(staleWorker.send).not.toHaveBeenCalled()
    expect(currentWorker.send).toHaveBeenCalledTimes(1)
  })

  it('rechecks source expiry and the 23-hour key window after the last async authority check', async () => {
    const expired = sharedRepository()
    let now = new Date(NOW)
    let calls = 0
    const authorityCheck = service({ repo: expired.repo, clock: () => now, resolve: async () => { calls++; if (calls === 2) now = new Date(NOW.getTime() + 2_000); return { current: true } } })
    const staged = await authorityCheck.instance.enqueueOnly({ idempotencyKey: 'invite:19', context: { ...context(), expiresAt: new Date(NOW.getTime() + 2_000) }, message: message() })
    expect(await authorityCheck.instance.attempt(staged.itemId!)).toMatchObject({ accepted: false, status: 'cancelled', code: 'outbox_expired' })
    expect(authorityCheck.send).not.toHaveBeenCalled()

    const window = sharedRepository()
    now = new Date(NOW)
    calls = 0
    const lastCheck = service({ repo: window.repo, clock: () => now, resolve: async () => { calls++; if (calls === 2) now = new Date(NOW.getTime() + 1_000); return { current: true } } })
    const due = await lastCheck.instance.enqueueOnly({ idempotencyKey: 'invite:19', context: { ...context(), expiresAt: new Date(NOW.getTime() + 25 * 60 * 60 * 1000) }, message: message() })
    const windowRow = window.rows.get(due.itemId!)!
    windowRow.firstAttemptAt = new Date(NOW.getTime() - 23 * 60 * 60 * 1000 + 1_000)
    windowRow.attemptCount = 1
    expect(await lastCheck.instance.attempt(due.itemId!)).toMatchObject({ accepted: false, status: 'manual_required', code: 'retry_window_expired' })
    expect(lastCheck.send).not.toHaveBeenCalled()
  })

  it('turns authority resolver failures into safe retries without calling the provider', async () => {
    const shared = sharedRepository()
    const failing = service({ repo: shared.repo, resolve: async () => { throw new Error('private authority lookup detail') } })
    const queued = await failing.instance.enqueueOnly({ idempotencyKey: 'invite:19', context: context(), message: message() })
    expect(await failing.instance.attempt(queued.itemId!)).toMatchObject({ accepted: false, status: 'queued', code: 'provider_unavailable' })
    expect(failing.send).not.toHaveBeenCalled()
    expect(JSON.stringify(shared.rows.get(queued.itemId!))).not.toContain('private authority lookup detail')
  })

  it('does not run an after-accept callback after the source expires during provider acceptance', async () => {
    const shared = sharedRepository()
    let now = new Date(NOW)
    let callbacks = 0
    const flow = service({
      repo: shared.repo,
      clock: () => now,
      send: async () => { now = new Date(NOW.getTime() + 1_000); return { delivered: true as const, providerMessageId: UUID } },
      resolve: async () => ({ current: true, afterAccept: async () => { callbacks++ } }),
    })
    const queued = await flow.instance.enqueueOnly({ idempotencyKey: 'invite:19', context: { ...context(), expiresAt: new Date(NOW.getTime() + 1_000) }, message: message() })
    expect(await flow.instance.attempt(queued.itemId!)).toMatchObject({ accepted: false, status: 'manual_required', code: 'outbox_expired' })
    expect(flow.send).toHaveBeenCalledTimes(1)
    expect(callbacks).toBe(0)
    expect(shared.rows.get(queued.itemId!)?.providerReceiptId).toBe(UUID)
  })

  it('checks authority after lease renewal before sending when authority is revoked during renewal', async () => {
    const shared = sharedRepository()
    let current = true
    const flow = service({ repo: shared.repo, resolve: async () => ({ current }) })
    const queued = await flow.instance.enqueueOnly({ idempotencyKey: 'invite:19', context: { ...context(), expiresAt: new Date(NOW.getTime() + 10 * 60_000) }, message: message() })
    shared.setRenewHook(async () => { current = false })

    expect(await flow.instance.attempt(queued.itemId!)).toMatchObject({ accepted: false, status: 'cancelled', code: 'authority_stale' })
    expect(flow.send).not.toHaveBeenCalled()
  })

  it('checks authority after lease renewal before reconcile-only callbacks when authority is revoked during renewal', async () => {
    const shared = sharedRepository()
    let callbacks = 0
    const first = service({ repo: shared.repo, resolve: async () => ({ current: true, afterAccept: async () => { callbacks++; throw new Error('retry reconciliation') } }) })
    const queued = await first.instance.enqueueOnly({ idempotencyKey: 'invite:19', context: { ...context(), expiresAt: new Date(NOW.getTime() + 10 * 60_000) }, message: message() })
    expect(await first.instance.attempt(queued.itemId!)).toMatchObject({ accepted: false, status: 'queued' })
    shared.rows.get(queued.itemId!)!.nextAttemptAt = NOW

    let current = true
    const restarted = service({ repo: shared.repo, resolve: async () => ({ current, afterAccept: async () => { callbacks++ } }) })
    shared.setRenewHook(async () => { current = false })
    expect(await restarted.instance.attempt(queued.itemId!)).toMatchObject({ accepted: false, status: 'manual_required', code: 'authority_stale' })
    expect(callbacks).toBe(1)
    expect(restarted.send).not.toHaveBeenCalled()
  })

  it('checks authority after the post-accept renewal before the callback when authority is revoked during that renewal', async () => {
    const shared = sharedRepository()
    let renewals = 0
    let current = true
    let callbacks = 0
    const flow = service({ repo: shared.repo, resolve: async () => ({ current, afterAccept: async () => { callbacks++ } }) })
    const queued = await flow.instance.enqueueOnly({ idempotencyKey: 'invite:19', context: { ...context(), expiresAt: new Date(NOW.getTime() + 10 * 60_000) }, message: message() })
    shared.setRenewHook(async () => { renewals++; if (renewals === 2) current = false })

    expect(await flow.instance.attempt(queued.itemId!)).toMatchObject({ accepted: false, status: 'manual_required', code: 'authority_stale' })
    expect(flow.send).toHaveBeenCalledTimes(1)
    expect(callbacks).toBe(0)
    expect(shared.rows.get(queued.itemId!)?.providerReceiptId).toBe(UUID)
  })

  it('does not reconcile an accepted receipt after the final callback authority lookup outlives its lease', async () => {
    const shared = sharedRepository()
    let callbacks = 0
    const initial = service({ repo: shared.repo, resolve: async () => ({ current: true, afterAccept: async () => { callbacks++; throw new Error('retry reconciliation') } }) })
    const queued = await initial.instance.enqueueOnly({ idempotencyKey: 'invite:19', context: { ...context(), expiresAt: new Date(NOW.getTime() + 10 * 60_000) }, message: message() })
    expect(await initial.instance.attempt(queued.itemId!)).toMatchObject({ accepted: false, status: 'queued' })
    shared.rows.get(queued.itemId!)!.nextAttemptAt = NOW

    let now = new Date(NOW)
    let calls = 0
    const restarted = service({
      repo: shared.repo,
      clock: () => new Date(now),
      resolve: async () => { calls++; if (calls === 2) now = new Date(NOW.getTime() + 60_001); return { current: true, afterAccept: async () => { callbacks++ } } },
    })
    expect(await restarted.instance.attempt(queued.itemId!)).toMatchObject({ accepted: false, status: 'queued', code: 'outbox_busy' })
    expect(callbacks).toBe(1)
    expect(restarted.send).not.toHaveBeenCalled()
    expect(shared.rows.get(queued.itemId!)?.status).toBe('processing')
  })

  it('does not start transport when the final authority check leaves less than its full timeout in the renewed lease', async () => {
    const shared = sharedRepository()
    let now = new Date(NOW)
    let calls = 0
    const flow = service({
      repo: shared.repo,
      clock: () => new Date(now),
      resolve: async () => { calls++; if (calls === 2) now = new Date(NOW.getTime() + 31_000); return { current: true } },
    })
    const queued = await flow.instance.enqueueOnly({ idempotencyKey: 'invite:19', context: { ...context(), expiresAt: new Date(NOW.getTime() + 10 * 60_000) }, message: message() })

    expect(await flow.instance.attempt(queued.itemId!)).toMatchObject({ accepted: false, status: 'queued', code: 'outbox_busy' })
    expect(flow.send).not.toHaveBeenCalled()
  })
})

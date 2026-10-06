import { randomUUID, timingSafeEqual } from 'node:crypto'
import { decryptPayload, encryptPayload, privateFingerprint, validateContext, validateMessage } from './crypto'
import type { ManagedSiteEmailOutboxContext, ManagedSiteEmailOutboxItem, ManagedSiteEmailOutboxResult, ManagedSiteEmailSafeCode, ManagedSiteEmailOutboxServiceDependencies } from './types'

const MAX_ATTEMPTS = 6
const LEASE_MS = 60_000
// The strict raw transport has a 30 second hard timeout. Do not start a
// request unless the lease still covers its entire maximum duration.
const TRANSPORT_TIMEOUT_RESERVE_MS = 30_000
const IDEMPOTENCY_WINDOW_MS = 23 * 60 * 60 * 1000
const BASE_RETRY_MS = 30_000

function equalHash(left: string, right: string): boolean {
  const a = Buffer.from(left, 'hex'), b = Buffer.from(right, 'hex')
  return a.length === b.length && timingSafeEqual(a, b)
}

function stableContext(context: ManagedSiteEmailOutboxContext): Record<string, unknown> {
  return { purpose: context.purpose, ownerUserId: context.ownerUserId, projectId: context.projectId, authority: context.authority, expiresAt: context.expiresAt }
}

function failure(item: ManagedSiteEmailOutboxItem | null, status: 'queued' | 'manual_required' | 'cancelled', code: ManagedSiteEmailSafeCode): ManagedSiteEmailOutboxResult {
  return { accepted: false, itemId: item?.id ?? null, status, code }
}

function resultForItem(item: ManagedSiteEmailOutboxItem): ManagedSiteEmailOutboxResult | null {
  if (item.status === 'accepted' && item.providerReceiptId) return { accepted: true, itemId: item.id, receiptId: item.providerReceiptId }
  if (item.status === 'cancelled' || item.status === 'manual_required') return failure(item, item.status, item.safeCode || (item.status === 'cancelled' ? 'authority_stale' : 'retry_window_expired'))
  return null
}

function encryptedInput(item: ManagedSiteEmailOutboxItem, secret: string) {
  if (!item.encryptedPayload) throw new Error('missing private payload')
  return decryptPayload({ secret, encryptedPayload: item.encryptedPayload, id: item.id, ownerUserId: item.ownerUserId, projectId: item.projectId, purpose: item.purpose, authorityFingerprint: item.authorityFingerprint, payloadFingerprint: item.payloadFingerprint, contextFingerprint: item.contextFingerprint, providerConfigurationFingerprint: item.providerConfigurationFingerprint })
}

export function createManagedSiteEmailOutboxService(dependencies: ManagedSiteEmailOutboxServiceDependencies) {
  const clock = dependencies.clock || (() => new Date())
  const configured = dependencies.executionEnabled === true && dependencies.transport.configured === true && typeof dependencies.encryptionSecret === 'string' && Buffer.byteLength(dependencies.encryptionSecret, 'utf8') >= 32 && /^[a-f0-9]{64}$/iu.test(dependencies.providerConfigurationFingerprint)

  async function processClaim(item: ManagedSiteEmailOutboxItem, leaseToken: string): Promise<ManagedSiteEmailOutboxResult> {
    const now = clock()
    const reconcile = item.acceptedAt !== null && item.providerReceiptId !== null
    if (!dependencies.encryptionSecret) return failure(item, 'manual_required', 'outbox_unconfigured')
    if (item.providerConfigurationFingerprint !== dependencies.providerConfigurationFingerprint) {
      await dependencies.repository.finish({ id: item.id, leaseToken, status: 'manual_required', now, safeCode: 'outbox_unconfigured' })
      return failure(item, 'manual_required', 'outbox_unconfigured')
    }
    if (item.expiresAt <= now) {
      const status = reconcile ? 'manual_required' : 'cancelled'
      await dependencies.repository.finish({ id: item.id, leaseToken, status, now, safeCode: 'outbox_expired' })
      return failure(item, status, 'outbox_expired')
    }
    if (!reconcile && item.firstAttemptAt && item.firstAttemptAt.getTime() + IDEMPOTENCY_WINDOW_MS <= now.getTime()) {
      await dependencies.repository.finish({ id: item.id, leaseToken, status: 'manual_required', now, safeCode: 'retry_window_expired' })
      return failure(item, 'manual_required', 'retry_window_expired')
    }
    if (item.attemptCount >= MAX_ATTEMPTS) {
      await dependencies.repository.finish({ id: item.id, leaseToken, status: 'manual_required', now, safeCode: 'attempt_limit' })
      return failure(item, 'manual_required', 'attempt_limit')
    }
    let payload: ReturnType<typeof encryptedInput>
    try { payload = encryptedInput(item, dependencies.encryptionSecret) } catch {
      await dependencies.repository.finish({ id: item.id, leaseToken, status: 'manual_required', now, safeCode: 'invalid_input' })
      return failure(item, 'manual_required', 'invalid_input')
    }
    if (payload.message.idempotencyKey !== item.idempotencyKey) {
      await dependencies.repository.finish({ id: item.id, leaseToken, status: 'manual_required', now, safeCode: 'invalid_input' })
      return failure(item, 'manual_required', 'invalid_input')
    }

    const attempt = await dependencies.repository.beginAttempt({ id: item.id, leaseToken, now })
    if (!attempt) return failure(item, 'queued', 'outbox_busy')
    const defer = async (): Promise<ManagedSiteEmailOutboxResult> => {
      const deferredAt = clock()
      const current = await dependencies.repository.getById(item.id)
      if (!current) return failure(item, 'queued', 'outbox_storage_unavailable')
      if (current.expiresAt <= deferredAt && !current.acceptedAt) {
        await dependencies.repository.finish({ id: item.id, leaseToken, status: 'cancelled', now: deferredAt, safeCode: 'outbox_expired' })
        return failure(item, 'cancelled', 'outbox_expired')
      }
      if (current.attemptCount >= MAX_ATTEMPTS) {
        await dependencies.repository.finish({ id: item.id, leaseToken, status: 'manual_required', now: deferredAt, safeCode: 'attempt_limit' })
        return failure(item, 'manual_required', 'attempt_limit')
      }
      if (!current.acceptedAt && current.firstAttemptAt && current.firstAttemptAt.getTime() + IDEMPOTENCY_WINDOW_MS <= deferredAt.getTime()) {
        await dependencies.repository.finish({ id: item.id, leaseToken, status: 'manual_required', now: deferredAt, safeCode: 'retry_window_expired' })
        return failure(item, 'manual_required', 'retry_window_expired')
      }
      const delay = Math.min(BASE_RETRY_MS * 2 ** Math.max(0, current.attemptCount - 1), 30 * 60_000)
      await dependencies.repository.retry({ id: item.id, leaseToken, now: deferredAt, nextAttemptAt: new Date(deferredAt.getTime() + delay), safeCode: 'provider_unavailable' })
      return failure(item, 'queued', 'provider_unavailable')
    }
    const renewForSideEffect = async (): Promise<Date | null> => {
      const renewedAt = clock()
      const leaseDeadline = new Date(renewedAt.getTime() + LEASE_MS)
      if (!await dependencies.repository.renew({ id: item.id, leaseToken, now: renewedAt, leaseExpiresAt: leaseDeadline })) return null
      return clock() < leaseDeadline ? leaseDeadline : null
    }
    let before
    try { before = await dependencies.resolveAuthority(payload.context, payload.message) } catch {
      return defer()
    }
    if (!before.current) {
      const status = reconcile ? 'manual_required' : 'cancelled'
      await dependencies.repository.finish({ id: item.id, leaseToken, status, now: clock(), safeCode: 'authority_stale' })
      return failure(item, status, 'authority_stale')
    }
    if (reconcile) {
      if (!attempt.providerReceiptId) {
        await dependencies.repository.finish({ id: item.id, leaseToken, status: 'manual_required', now: clock(), safeCode: 'invalid_input' })
        return failure(item, 'manual_required', 'invalid_input')
      }
      // Renew first, then make the final authority read. No asynchronous work
      // may occur between that read and the source reconciliation callback.
      const callbackLeaseDeadline = await renewForSideEffect()
      if (!callbackLeaseDeadline) return failure(item, 'queued', 'outbox_busy')
      let stillCurrent
      try { stillCurrent = await dependencies.resolveAuthority(payload.context, payload.message) } catch {
        return defer()
      }
      const callbackAt = clock()
      if (callbackAt >= callbackLeaseDeadline) return failure(item, 'queued', 'outbox_busy')
      if (!stillCurrent.current || payload.context.expiresAt <= callbackAt) {
        const code = !stillCurrent.current ? 'authority_stale' : 'outbox_expired'
        await dependencies.repository.finish({ id: item.id, leaseToken, status: 'manual_required', now: callbackAt, safeCode: code })
        return failure(item, 'manual_required', code)
      }
      try { await stillCurrent.afterAccept?.(attempt.providerReceiptId) } catch {
        const retryAt = new Date(clock().getTime() + BASE_RETRY_MS)
        await dependencies.repository.retry({ id: item.id, leaseToken, now: clock(), nextAttemptAt: retryAt, safeCode: 'provider_unavailable' })
        return failure(item, 'queued', 'provider_unavailable')
      }
      const saved = await dependencies.repository.reconciliationComplete({ id: item.id, leaseToken, now: clock() })
      return saved ? { accepted: true, itemId: item.id, receiptId: attempt.providerReceiptId } : failure(item, 'queued', 'outbox_busy')
    }

    // Lease renewal must precede the last fresh authority read. This closes
    // the revocation window that otherwise exists while renewing in storage.
    const sendLeaseDeadline = await renewForSideEffect()
    if (!sendLeaseDeadline) return failure(item, 'queued', 'outbox_busy')
    let finalAuthority
    try { finalAuthority = await dependencies.resolveAuthority(payload.context, payload.message) } catch {
      return defer()
    }
    const sendAt = clock()
    if (sendAt >= sendLeaseDeadline || sendLeaseDeadline.getTime() - sendAt.getTime() < TRANSPORT_TIMEOUT_RESERVE_MS) return failure(item, 'queued', 'outbox_busy')
    if (!finalAuthority.current || payload.context.expiresAt <= sendAt || (attempt.firstAttemptAt && attempt.firstAttemptAt.getTime() + IDEMPOTENCY_WINDOW_MS <= sendAt.getTime())) {
      const code = !finalAuthority.current ? 'authority_stale' : payload.context.expiresAt <= sendAt ? 'outbox_expired' : 'retry_window_expired'
      const status = code === 'retry_window_expired' ? 'manual_required' : 'cancelled'
      await dependencies.repository.finish({ id: item.id, leaseToken, status, now: sendAt, safeCode: code })
      return failure(item, status, code)
    }
    let receiptId: string
    try {
      const sent = await dependencies.transport.send({ to: payload.message.to, subject: payload.message.subject, text: payload.message.text, replyTo: payload.message.replyTo, idempotencyKey: item.idempotencyKey })
      receiptId = sent.providerMessageId
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(receiptId)) throw new Error('invalid provider receipt')
    } catch {
      const after = clock()
      const current = await dependencies.repository.getById(item.id)
      if (!current || current.firstAttemptAt && current.firstAttemptAt.getTime() + IDEMPOTENCY_WINDOW_MS <= after.getTime() || current.attemptCount >= MAX_ATTEMPTS) {
        const code = current && current.attemptCount >= MAX_ATTEMPTS ? 'attempt_limit' : 'retry_window_expired'
        await dependencies.repository.finish({ id: item.id, leaseToken, status: 'manual_required', now: after, safeCode: code })
        return failure(item, 'manual_required', code)
      }
      const delay = Math.min(BASE_RETRY_MS * 2 ** Math.max(0, current.attemptCount - 1), 30 * 60_000)
      await dependencies.repository.retry({ id: item.id, leaseToken, now: after, nextAttemptAt: new Date(after.getTime() + delay), safeCode: 'provider_unavailable' })
      return failure(item, 'queued', 'provider_unavailable')
    }
    const savedReceipt = await dependencies.repository.accepted({ id: item.id, leaseToken, now: clock(), providerReceiptId: receiptId })
    if (!savedReceipt) return failure(item, 'queued', 'outbox_busy')
    // A provider acceptance is durable before purpose-specific reconciliation. A crash retries only this callback, never sends a new key.
    const accepted = await dependencies.repository.getById(item.id)
    if (!accepted) return failure(item, 'queued', 'outbox_storage_unavailable')
    const acceptedLeaseDeadline = await renewForSideEffect()
    if (!acceptedLeaseDeadline) return failure(item, 'queued', 'outbox_busy')
    let currentAuthority
    try { currentAuthority = await dependencies.resolveAuthority(payload.context, payload.message) } catch {
      return defer()
    }
    const acceptedAt = clock()
    if (acceptedAt >= acceptedLeaseDeadline) return failure(item, 'queued', 'outbox_busy')
    if (!currentAuthority.current || payload.context.expiresAt <= acceptedAt) {
      const code = !currentAuthority.current ? 'authority_stale' : 'outbox_expired'
      await dependencies.repository.finish({ id: item.id, leaseToken, status: 'manual_required', now: acceptedAt, safeCode: code })
      return failure(item, 'manual_required', code)
    }
    try { await currentAuthority.afterAccept?.(receiptId) } catch {
      return defer()
    }
    const complete = await dependencies.repository.reconciliationComplete({ id: item.id, leaseToken, now: clock() })
    return complete ? { accepted: true, itemId: item.id, receiptId } : failure(item, 'queued', 'outbox_busy')
  }

  async function processOne(id?: string): Promise<ManagedSiteEmailOutboxResult | null> {
    await cleanupExpired()
    if (!configured) return failure(null, 'queued', dependencies.executionEnabled !== true ? 'outbox_disabled' : 'outbox_unconfigured')
    const now = clock()
    const claim = await dependencies.repository.claimOne({ now, leaseToken: randomUUID(), leaseExpiresAt: new Date(now.getTime() + LEASE_MS), maxAttempts: MAX_ATTEMPTS, ...(id ? { id } : {}) })
    if (!claim) return null
    return processClaim(claim.item, claim.leaseToken)
  }

  async function cleanupExpired(): Promise<number> {
    try { return await dependencies.repository.cancelExpired({ now: clock(), limit: 50 }) } catch { return 0 }
  }

  async function enqueueOnly(input: { idempotencyKey: string; context: ManagedSiteEmailOutboxContext; message: Omit<Parameters<ManagedSiteEmailOutboxServiceDependencies['transport']['send']>[0], 'idempotencyKey'> & { idempotencyKey?: string } }): Promise<ManagedSiteEmailOutboxResult> {
    let persisting = false
    try {
      if (!input || !input.context || !input.message) throw new Error('invalid input')
      validateContext(input.context)
      if (!/^[A-Za-z0-9][A-Za-z0-9._:/#-]{0,127}$/u.test(input.idempotencyKey) || (input.message.idempotencyKey !== undefined && input.message.idempotencyKey !== input.idempotencyKey)) throw new Error('invalid input')
      const message = { ...input.message, idempotencyKey: input.idempotencyKey }
      validateMessage(message)
      if (input.context.expiresAt <= clock()) return failure(null, 'cancelled', 'outbox_expired')
      if (!/^[a-f0-9]{64}$/iu.test(dependencies.providerConfigurationFingerprint)) return failure(null, 'queued', 'outbox_unconfigured')
      if (!dependencies.encryptionSecret || Buffer.byteLength(dependencies.encryptionSecret, 'utf8') < 32) return failure(null, 'queued', 'outbox_unconfigured')
      const id = randomUUID()
      const authorityFingerprint = privateFingerprint(input.context.authority, dependencies.encryptionSecret)
      const contextFingerprint = privateFingerprint({ purpose: input.context.purpose, ownerUserId: input.context.ownerUserId, projectId: input.context.projectId, authority: input.context.authority }, dependencies.encryptionSecret)
      const payloadFingerprint = privateFingerprint({ context: stableContext(input.context), message }, dependencies.encryptionSecret)
      const encryptedPayload = encryptPayload({ secret: dependencies.encryptionSecret, id, ownerUserId: input.context.ownerUserId, projectId: input.context.projectId, purpose: input.context.purpose, authorityFingerprint, payloadFingerprint, contextFingerprint, providerConfigurationFingerprint: dependencies.providerConfigurationFingerprint, payload: { context: input.context, message } })
      persisting = true
      const row = await dependencies.repository.insertOrGet({ id, ownerUserId: input.context.ownerUserId, projectId: input.context.projectId, purpose: input.context.purpose, idempotencyKey: input.idempotencyKey, authorityFingerprint, payloadFingerprint, contextFingerprint, providerConfigurationFingerprint: dependencies.providerConfigurationFingerprint, encryptedPayload, nextAttemptAt: clock(), expiresAt: input.context.expiresAt })
      if (!equalHash(row.authorityFingerprint, authorityFingerprint) || !equalHash(row.payloadFingerprint, payloadFingerprint) || !equalHash(row.contextFingerprint, contextFingerprint) || row.ownerUserId !== input.context.ownerUserId || row.projectId !== input.context.projectId || row.providerConfigurationFingerprint !== dependencies.providerConfigurationFingerprint) return failure(row, 'manual_required', 'outbox_collision')
      const existing = resultForItem(row)
      if (existing) return existing
      return failure(row, 'queued', dependencies.executionEnabled !== true ? 'outbox_disabled' : 'outbox_busy')
    } catch {
      return failure(null, 'queued', persisting ? 'outbox_storage_unavailable' : 'invalid_input')
    }
  }

  return {
    enqueueOnly,
    async enqueueAndAttempt(input: Parameters<typeof enqueueOnly>[0]): Promise<ManagedSiteEmailOutboxResult> {
      const saved = await enqueueOnly(input)
      if (saved.accepted || !saved.itemId || saved.status !== 'queued') return saved
      if (!configured) return failure(await dependencies.repository.getById(saved.itemId), 'queued', dependencies.executionEnabled !== true ? 'outbox_disabled' : 'outbox_unconfigured')
      return await processOne(saved.itemId) || failure(await dependencies.repository.getById(saved.itemId), 'queued', 'outbox_busy')
    },
    async attempt(itemId: string): Promise<ManagedSiteEmailOutboxResult> {
      const result = await processOne(itemId)
      if (result) return result
      const current = await dependencies.repository.getById(itemId)
      return current ? resultForItem(current) || failure(current, 'queued', 'outbox_busy') : failure(null, 'cancelled', 'invalid_input')
    },
    processOne,
    cleanupExpired,
  }
}

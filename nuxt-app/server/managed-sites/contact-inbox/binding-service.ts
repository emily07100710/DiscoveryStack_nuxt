import { createHash, randomInt, timingSafeEqual } from 'node:crypto'
import { createError } from 'h3'
import type { ManagedSiteContactInboxBinding, ManagedSiteFunnelSession } from '../../database/schema'
import { getManagedSiteContactInboxBindingRepository, type ManagedSiteContactInboxBindingRepository } from './binding-repository'
import { managedSiteEmailTransportFromEnv, type ManagedSiteEmailTransport } from './email-transport'
import { createManagedSiteEmailOutboxRuntime, attemptManagedSiteEmailOutboxItem } from '../email-outbox/runtime'
import type { ManagedSiteEmailOutboxRepository } from '../email-outbox/types'

const BINDABLE_SESSION_STATUSES = ['active', 'building', 'checkout_pending', 'converted'] as const
const CODE_EXPIRY_MS = 10 * 60 * 1000
const RESEND_INTERVAL_MS = 60 * 1000
const SEND_WINDOW_MS = 60 * 60 * 1000
const MAX_SENDS_PER_WINDOW = 5
const MAX_ATTEMPTS = 5

export type ManagedSiteContactInboxProjection = {
  status: 'unbound' | 'pending' | 'bound' | 'locked'
  maskedEmail: string | null
  resendAvailableAt: string | null
  transportConfigured: boolean
}

export type ManagedSiteContactInboxBindingDependencies = {
  repository: ManagedSiteContactInboxBindingRepository
  transport: ManagedSiteEmailTransport
  pepper: string
  clock: () => Date
  durableOutbox?: boolean
}

let testDependencies: ManagedSiteContactInboxBindingDependencies | null = null

export function setManagedSiteContactInboxBindingDependenciesForTests(dependencies: ManagedSiteContactInboxBindingDependencies | null): void {
  if (process.env.NODE_ENV !== 'test') throw createError({ statusCode: 403, statusMessage: 'Managed-site inbox binding dependency injection is test-only.' })
  testDependencies = dependencies
}

function runtimeDependencies(): ManagedSiteContactInboxBindingDependencies {
  if (process.env.NODE_ENV === 'test' && testDependencies) return testDependencies
  let transport: ManagedSiteEmailTransport
  try { transport = managedSiteEmailTransportFromEnv() } catch { transport = { configured: false, async send(): Promise<never> { throw new Error('email transport unavailable') } } }
  return {
    repository: getManagedSiteContactInboxBindingRepository(),
    transport,
    pepper: process.env.NUXT_MANAGED_SITE_EMAIL_CODE_PEPPER || '',
    clock: () => new Date(),
    durableOutbox: true,
  }
}

function usable(dependencies: Pick<ManagedSiteContactInboxBindingDependencies, 'transport' | 'pepper'>): boolean {
  return dependencies.transport.configured && Boolean(dependencies.pepper)
}

function nowFrom(dependencies: ManagedSiteContactInboxBindingDependencies): Date {
  const now = dependencies.clock()
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw createError({ statusCode: 500, statusMessage: '收信信箱綁定時間無效。' })
  return now
}

function assertBindableSession(session: ManagedSiteFunnelSession): void {
  if (!(BINDABLE_SESSION_STATUSES as readonly string[]).includes(session.status)) throw createError({ statusCode: 409, statusMessage: '目前的訂購工作階段無法綁定收信信箱。' })
}

function validatedEmail(value: unknown): string {
  if (typeof value !== 'string' || !value || value !== value.trim() || Buffer.byteLength(value, 'utf8') > 320 || /[\u0000-\u001f\u007f-\u009f]/u.test(value)) {
    throw createError({ statusCode: 422, statusMessage: '請輸入一個有效且可收信的 Email。' })
  }
  const match = /^([A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*)@([A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+)$/u.exec(value)
  if (!match || match[1]!.length > 64 || match[2]!.split('.').some(label => label.length > 63)) throw createError({ statusCode: 422, statusMessage: '請輸入一個有效且可收信的 Email。' })
  return `${match[1]}@${match[2]!.toLowerCase()}`
}

function maskEmail(email: string): string {
  const at = email.lastIndexOf('@')
  const local = email.slice(0, at)
  return `${local.slice(0, local.length === 1 ? 1 : 2)}***${email.slice(at)}`
}

function codeHash(pepper: string, sessionId: number, code: string): string {
  return createHash('sha256').update(`${pepper}:${sessionId}:${code}`).digest('hex')
}

function latestWithSentAt(rows: ManagedSiteContactInboxBinding[]): ManagedSiteContactInboxBinding | null {
  return rows.sort((left, right) => rateAnchor(right) - rateAnchor(left) || right.id - left.id)[0] || null
}

function rateAnchor(row: ManagedSiteContactInboxBinding): number {
  return Math.max(row.createdAt.getTime(), row.lastSentAt?.getTime() || 0)
}

function resendAvailableAt(row: ManagedSiteContactInboxBinding | null): string | null {
  return row ? new Date((row.lastSentAt?.getTime() || row.createdAt.getTime()) + RESEND_INTERVAL_MS).toISOString() : null
}

function throwRateLimit(availableAt: Date): never {
  throw createError({ statusCode: 429, statusMessage: `寄送驗證碼太頻繁，最早可於 ${availableAt.toISOString()} 再次寄送。` })
}

function assertRateAvailable(rows: ManagedSiteContactInboxBinding[], now: Date): void {
  const latestSend = latestWithSentAt(rows)
  if (latestSend && rateAnchor(latestSend) + RESEND_INTERVAL_MS > now.getTime()) throwRateLimit(new Date(rateAnchor(latestSend) + RESEND_INTERVAL_MS))
  const windowStart = now.getTime() - SEND_WINDOW_MS
  const windowRows = rows.filter(row => rateAnchor(row) > windowStart).sort((left, right) => rateAnchor(left) - rateAnchor(right))
  const sendsInWindow = windowRows.reduce((sum, row) => sum + Math.max(row.sendCount, 1), 0)
  if (sendsInWindow >= MAX_SENDS_PER_WINDOW) throwRateLimit(new Date(rateAnchor(windowRows[0]!) + SEND_WINDOW_MS))
}

function deliveryError(error: unknown): never {
  if ((error as any)?.statusCode === 503) throw error
  if ((error as any)?.statusCode === 502) throw error
  if ((error as any)?.statusCode === 429) throw error
  throw createError({ statusCode: 502, statusMessage: '寄信服務暫時無法送出驗證碼，請稍後再試。' })
}

export async function startManagedSiteContactInboxBinding(
  input: { session: ManagedSiteFunnelSession; email: unknown },
  dependencies: ManagedSiteContactInboxBindingDependencies = runtimeDependencies(),
) {
  assertBindableSession(input.session)
  const email = validatedEmail(input.email)
  if (!usable(dependencies)) throw createError({ statusCode: 503, statusMessage: '寄信服務尚未開通，暫時無法寄出驗證碼。' })
  const rawNow = nowFrom(dependencies)
  const now = dependencies.durableOutbox ? new Date(Math.floor(rawNow.getTime() / 1000) * 1000) : rawNow
  const rows = await dependencies.repository.listForSession(input.session.id)
  assertRateAvailable(rows, now)

  const code = randomInt(0, 1_000_000).toString().padStart(6, '0')
  const expiresAt = new Date(now.getTime() + CODE_EXPIRY_MS)
  const verificationHash = codeHash(dependencies.pepper, input.session.id, code)
  try {
    if (dependencies.durableOutbox) {
      const transaction = dependencies.repository.transactionWithEmailOutbox
      if (!transaction) throw new Error('durable email storage unavailable')
      let bindingId: number | null = null, itemId: string | null = null
      await transaction.call(dependencies.repository, async (repository, outboxRepository: ManagedSiteEmailOutboxRepository) => {
        if (!repository.lockSessionForEmailIssuance) throw new Error('durable session serialization unavailable')
        await repository.lockSessionForEmailIssuance(input.session.id)
        assertRateAvailable(await repository.listForSession(input.session.id), now)
        await repository.supersedeStatus(input.session.id, 'pending')
        const binding = await repository.insertBinding({
          funnelSessionId: input.session.id, projectId: input.session.projectId, email, status: 'pending', codeHash: verificationHash, codeExpiresAt: expiresAt,
          attemptCount: 0, sendCount: 0, lastSentAt: null, boundAt: null,
        })
        bindingId = binding.id
        const result = await createManagedSiteEmailOutboxRuntime(outboxRepository).enqueueOnly({
          idempotencyKey: `managed-site-inbox-code:${input.session.id}:${binding.id}:${verificationHash.slice(0, 48)}`,
          context: { purpose: 'inbox_verification', ownerUserId: null, projectId: input.session.projectId, authority: { funnelSessionId: input.session.id, bindingId: binding.id, codeHash: verificationHash }, expiresAt },
          message: { to: email, subject: 'DiscoveryStack 收信信箱驗證碼', text: `你的 DiscoveryStack 收信信箱驗證碼是：${code}\n\n此驗證碼將於 10 分鐘後失效。DiscoveryStack 的任何人都不會向你索取這組驗證碼，請勿轉交他人。` },
        })
        if (!result.itemId || (!result.accepted && result.status !== 'queued')) throw new Error('encrypted email could not be durably queued')
        itemId = result.itemId
      })
      if (!bindingId || !itemId) throw new Error('email outbox transaction did not complete')
      const result = await attemptManagedSiteEmailOutboxItem(itemId)
      if (!result.accepted) {
        if (result.status === 'queued') throw createError({ statusCode: 503, statusMessage: '驗證碼已安全排入寄送佇列，請稍後再試。' })
        throw new Error('email outbox did not accept delivery')
      }
      return { status: 'pending' as const, maskedEmail: maskEmail(email), expiresAt: expiresAt.toISOString(), resendAvailableAt: new Date(now.getTime() + RESEND_INTERVAL_MS).toISOString() }
    }

    await dependencies.transport.send({
      to: email,
      subject: 'DiscoveryStack 收信信箱驗證碼',
      text: `你的 DiscoveryStack 收信信箱驗證碼是：${code}\n\n此驗證碼將於 10 分鐘後失效。DiscoveryStack 的任何人都不會向你索取這組驗證碼，請勿轉交他人。`,
      idempotencyKey: `managed-site-inbox-code:${input.session.id}:${verificationHash.slice(0, 48)}`,
    })
  } catch (error) { deliveryError(error) }

  await dependencies.repository.transaction(async repository => {
    await repository.supersedeStatus(input.session.id, 'pending')
    await repository.insertBinding({
      funnelSessionId: input.session.id,
      projectId: input.session.projectId,
      email,
      status: 'pending',
      codeHash: verificationHash,
      codeExpiresAt: expiresAt,
      attemptCount: 0,
      sendCount: 1,
      lastSentAt: now,
      boundAt: null,
    })
  })
  return { status: 'pending' as const, maskedEmail: maskEmail(email), expiresAt: expiresAt.toISOString(), resendAvailableAt: new Date(now.getTime() + RESEND_INTERVAL_MS).toISOString() }
}

export async function confirmManagedSiteContactInboxBinding(
  input: { session: ManagedSiteFunnelSession; code: unknown },
  dependencies: ManagedSiteContactInboxBindingDependencies = runtimeDependencies(),
) {
  assertBindableSession(input.session)
  if (typeof input.code !== 'string' || !/^\d{6}$/u.test(input.code)) throw createError({ statusCode: 422, statusMessage: '請輸入 6 位數驗證碼。' })
  if (!usable(dependencies)) throw createError({ statusCode: 503, statusMessage: '寄信服務尚未開通，暫時無法確認綁定。' })
  const now = nowFrom(dependencies)
  const rows = await dependencies.repository.listForSession(input.session.id)
  const pending = rows.find(row => row.status === 'pending')
  if (!pending || !pending.codeHash || !pending.codeExpiresAt || pending.codeExpiresAt.getTime() <= now.getTime()) throw createError({ statusCode: 409, statusMessage: '驗證碼不存在或已失效，請重新寄送驗證碼。' })
  const actual = Buffer.from(pending.codeHash, 'hex')
  const expected = Buffer.from(codeHash(dependencies.pepper, input.session.id, input.code), 'hex')
  const matches = actual.length === expected.length && timingSafeEqual(actual, expected)
  if (!matches) {
    const attemptCount = pending.attemptCount + 1
    const locked = attemptCount >= MAX_ATTEMPTS
    const updated = await dependencies.repository.updateBinding(pending.id, 'pending', { attemptCount, ...(locked ? { status: 'locked', codeHash: null, codeExpiresAt: null } : {}) })
    if (!updated) throw createError({ statusCode: 409, statusMessage: '驗證狀態已變更，請重新寄送驗證碼。' })
    throw createError({ statusCode: 409, statusMessage: locked ? '驗證次數過多，請重新寄送驗證碼。' : '驗證碼不正確，請再試一次。' })
  }

  const bound = await dependencies.repository.transaction(async repository => {
    await repository.supersedeStatus(input.session.id, 'bound', pending.id)
    const updated = await repository.updateBinding(pending.id, 'pending', { status: 'bound', boundAt: now, codeHash: null, codeExpiresAt: null })
    if (!updated) throw createError({ statusCode: 409, statusMessage: '驗證狀態已變更，請重新寄送驗證碼。' })
    return updated
  })
  return { status: 'bound' as const, maskedEmail: maskEmail(bound.email) }
}

export async function managedSiteContactInboxProjection(
  sessionId: number,
  dependencies: ManagedSiteContactInboxBindingDependencies = runtimeDependencies(),
): Promise<ManagedSiteContactInboxProjection> {
  const rows = await dependencies.repository.listForSession(sessionId)
  const bound = rows.filter(row => row.status === 'bound').sort((left, right) => (right.boundAt?.getTime() || 0) - (left.boundAt?.getTime() || 0) || right.id - left.id)[0]
  if (bound) return { status: 'bound', maskedEmail: maskEmail(bound.email), resendAvailableAt: null, transportConfigured: usable(dependencies) }
  const pending = rows.find(row => row.status === 'pending')
  if (pending) return { status: 'pending', maskedEmail: maskEmail(pending.email), resendAvailableAt: resendAvailableAt(pending), transportConfigured: usable(dependencies) }
  const locked = rows.find(row => row.status === 'locked')
  if (locked) return { status: 'locked', maskedEmail: maskEmail(locked.email), resendAvailableAt: resendAvailableAt(locked), transportConfigured: usable(dependencies) }
  return { status: 'unbound', maskedEmail: null, resendAvailableAt: null, transportConfigured: usable(dependencies) }
}

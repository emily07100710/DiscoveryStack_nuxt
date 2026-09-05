import { createHash, randomInt, timingSafeEqual } from 'node:crypto'
import { createError } from 'h3'
import type { ManagedSiteContactInboxBinding, ManagedSiteFunnelSession } from '../../database/schema'
import { getManagedSiteContactInboxBindingRepository, type ManagedSiteContactInboxBindingRepository } from './binding-repository'
import { managedSiteEmailTransportFromEnv, type ManagedSiteEmailTransport } from './email-transport'

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
}

let testDependencies: ManagedSiteContactInboxBindingDependencies | null = null

export function setManagedSiteContactInboxBindingDependenciesForTests(dependencies: ManagedSiteContactInboxBindingDependencies | null): void {
  if (process.env.NODE_ENV !== 'test') throw createError({ statusCode: 403, statusMessage: 'Managed-site inbox binding dependency injection is test-only.' })
  testDependencies = dependencies
}

function runtimeDependencies(): ManagedSiteContactInboxBindingDependencies {
  if (process.env.NODE_ENV === 'test' && testDependencies) return testDependencies
  return {
    repository: getManagedSiteContactInboxBindingRepository(),
    transport: managedSiteEmailTransportFromEnv(),
    pepper: process.env.NUXT_MANAGED_SITE_EMAIL_CODE_PEPPER || '',
    clock: () => new Date(),
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
  return rows.filter(row => row.lastSentAt).sort((left, right) => right.lastSentAt!.getTime() - left.lastSentAt!.getTime() || right.id - left.id)[0] || null
}

function resendAvailableAt(row: ManagedSiteContactInboxBinding | null): string | null {
  return row?.lastSentAt ? new Date(row.lastSentAt.getTime() + RESEND_INTERVAL_MS).toISOString() : null
}

function throwRateLimit(availableAt: Date): never {
  throw createError({ statusCode: 429, statusMessage: `寄送驗證碼太頻繁，最早可於 ${availableAt.toISOString()} 再次寄送。` })
}

function deliveryError(error: unknown): never {
  if ((error as any)?.statusCode === 503) throw error
  if ((error as any)?.statusCode === 502) throw error
  throw createError({ statusCode: 502, statusMessage: '寄信服務暫時無法送出驗證碼，請稍後再試。' })
}

export async function startManagedSiteContactInboxBinding(
  input: { session: ManagedSiteFunnelSession; email: unknown },
  dependencies: ManagedSiteContactInboxBindingDependencies = runtimeDependencies(),
) {
  assertBindableSession(input.session)
  const email = validatedEmail(input.email)
  if (!usable(dependencies)) throw createError({ statusCode: 503, statusMessage: '寄信服務尚未開通，暫時無法寄出驗證碼。' })
  const now = nowFrom(dependencies)
  const rows = await dependencies.repository.listForSession(input.session.id)
  const latestSend = latestWithSentAt(rows)
  if (latestSend?.lastSentAt && latestSend.lastSentAt.getTime() + RESEND_INTERVAL_MS > now.getTime()) throwRateLimit(new Date(latestSend.lastSentAt.getTime() + RESEND_INTERVAL_MS))
  const windowStart = now.getTime() - SEND_WINDOW_MS
  const sendsInWindow = rows.filter(row => row.lastSentAt && row.lastSentAt.getTime() > windowStart).reduce((sum, row) => sum + row.sendCount, 0)
  if (sendsInWindow >= MAX_SENDS_PER_WINDOW) {
    const windowRows = rows.filter(row => row.lastSentAt && row.lastSentAt.getTime() > windowStart).sort((left, right) => left.lastSentAt!.getTime() - right.lastSentAt!.getTime())
    throwRateLimit(new Date(windowRows[0]!.lastSentAt!.getTime() + SEND_WINDOW_MS))
  }

  const code = randomInt(0, 1_000_000).toString().padStart(6, '0')
  const expiresAt = new Date(now.getTime() + CODE_EXPIRY_MS)
  try {
    await dependencies.transport.send({
      to: email,
      subject: 'DiscoveryStack 收信信箱驗證碼',
      text: `你的 DiscoveryStack 收信信箱驗證碼是：${code}\n\n此驗證碼將於 10 分鐘後失效。DiscoveryStack 的任何人都不會向你索取這組驗證碼，請勿轉交他人。`,
    })
  } catch (error) { deliveryError(error) }

  await dependencies.repository.transaction(async repository => {
    await repository.supersedeStatus(input.session.id, 'pending')
    await repository.insertBinding({
      funnelSessionId: input.session.id,
      projectId: input.session.projectId,
      email,
      status: 'pending',
      codeHash: codeHash(dependencies.pepper, input.session.id, code),
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

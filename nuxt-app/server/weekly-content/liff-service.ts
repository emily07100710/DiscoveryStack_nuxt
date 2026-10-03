import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import { createError, getRequestHeader, setResponseHeaders, type H3Event } from 'h3'
import { z, ZodError } from 'zod'
import { readBoundedRequestBody } from '../utils/bounded-request-body'
import { createWeeklyContentRepository, type WeeklyContentRepository } from './repository'
import { claimLineBindingInvite } from './service'
import { verifyWeeklyLiffIdentity, type VerifiedWeeklyLiffIdentity } from './liff-identity'
import type { ContentOperationClientRow } from '../content-operations/types'
import type { LineBindingInvitation, WeeklyConfig } from './types'
export const WEEKLY_LIFF_CONNECT_PATH = '/weekly-content/connect'
export const WEEKLY_LIFF_HEADERS = { 'cache-control': 'private, no-store, max-age=0', 'x-robots-tag': 'noindex, nofollow, noarchive', 'referrer-policy': 'no-referrer' }
export const WEEKLY_LIFF_ID_PATTERN = /^[0-9]{8,15}-[A-Za-z0-9]{4,32}$/
export type WeeklyLiffConfiguration = { enabled: false } | { enabled: true; liffId: string; channelId: string; origin: string; tokenKey: string }
export type WeeklyLiffCompany = { displayName: string; canonicalSiteOrigin: string }
export type WeeklyLiffContext = { mode: 'bindings'; companies: WeeklyLiffCompany[] } | { mode: 'invitation'; company: WeeklyLiffCompany; expiresAt: string; confirmationToken: string }
export type WeeklyLiffDependencies = { configuration: WeeklyLiffConfiguration; repository: () => WeeklyContentRepository; fetchImpl?: typeof fetch; now?: Date }
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const fail = (code: string, statusCode = 409): never => { throw createError({ statusCode, statusMessage: code }) }
function httpsOrigin(raw: string): string | null {
  try { const url = new URL(raw); if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash || url.port && url.port !== '443') return null; return url.origin } catch { return null }
}
export function weeklyLiffConfiguration(env: Record<string, string | undefined> = process.env): WeeklyLiffConfiguration {
  if (env.NUXT_WEEKLY_CONTENT_APPROVAL_ENABLED !== 'true' || env.NUXT_WEEKLY_CONTENT_LIFF_ENABLED !== 'true') return { enabled: false }
  const liffId = env.NUXT_WEEKLY_CONTENT_LIFF_ID || '', channelId = env.NUXT_WEEKLY_CONTENT_LINE_LOGIN_CHANNEL_ID || '', tokenKey = env.NUXT_WEEKLY_CONTENT_TOKEN_KEY || ''
  const origin = httpsOrigin(env.NUXT_WEEKLY_CONTENT_REVIEW_ORIGIN || '')
  if (!WEEKLY_LIFF_ID_PATTERN.test(liffId) || !/^[0-9]{8,15}$/.test(channelId) || Buffer.byteLength(tokenKey) < 32 || Buffer.byteLength(tokenKey) > 512 || !origin) return { enabled: false }
  return { enabled: true, liffId, channelId, tokenKey, origin }
}
export function projectWeeklyLiffConfiguration(configuration: WeeklyLiffConfiguration) {
  if (!configuration.enabled) return { enabled: false as const }
  return { enabled: true as const, liffId: configuration.liffId, origin: configuration.origin, connectPath: WEEKLY_LIFF_CONNECT_PATH, scopes: ['openid'] as const }
}
function enabled(configuration: WeeklyLiffConfiguration) {
  if (!configuration.enabled) return fail('LIFF_CONNECT_DISABLED', 503)
  return configuration
}
const token = z.string().max(8192).regex(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/)
const invitation = z.string().regex(/^wli_[A-Za-z0-9_-]{32}$/)
export const weeklyLiffContextInput = z.object({ idToken: token, invitationToken: invitation.optional() }).strict()
export const weeklyLiffConfirmInput = z.object({ idToken: token, invitationToken: invitation, confirmationToken: z.string().regex(/^[A-Za-z0-9_-]{43}$/), consent: z.literal(true) }).strict()
function company(client: ContentOperationClientRow): WeeklyLiffCompany {
  const canonicalSiteOrigin = httpsOrigin(client.canonicalSiteOrigin)
  if (!canonicalSiteOrigin || !client.displayName || client.displayName.length > 160) return fail('LIFF_COMPANY_NOT_AVAILABLE', 404)
  return { displayName: client.displayName, canonicalSiteOrigin }
}
type InvitationContext = { invite: LineBindingInvitation; client: ContentOperationClientRow; config: WeeklyConfig; company: WeeklyLiffCompany }
async function invitationContext(repo: WeeklyContentRepository, raw: string, identity: VerifiedWeeklyLiffIdentity, getNow: () => Date, lock = false): Promise<InvitationContext> {
  const first = await repo.findInvitation(hash(raw))
  if (!first) return fail('LIFF_INVITATION_NOT_AVAILABLE', 404)
  const client = await repo.findClient(first.ownerUserId, first.clientId, lock)
  const invite = lock ? await repo.findInvitation(hash(raw), true) : first
  const config = await repo.getConfig(first.ownerUserId, first.clientId, lock)
  const binding = await repo.getBinding(first.ownerUserId, first.clientId, lock)
  const now = getNow()
  if (identity.expiresAtSeconds <= Math.floor(now.getTime() / 1000)) return fail('LINE_IDENTITY_INVALID', 401)
  if (!invite || !client || client.status !== 'active' || client.requireCustomerApproval !== true || config?.status !== 'active' || invite.expiresAt.getTime() <= now.getTime()) return fail('LIFF_INVITATION_NOT_AVAILABLE', 409)
  const fingerprint = hash(JSON.stringify({ owner: invite.ownerUserId, client: invite.clientId, recipient: identity.lineUserId }))
  if (binding?.status === 'active' && binding.lineUserId !== identity.lineUserId || invite.consumedAt && (invite.bindingFingerprint !== fingerprint || binding?.status !== 'active' || binding.bindingFingerprint !== fingerprint)) return fail('LIFF_INVITATION_NOT_AVAILABLE', 409)
  return { invite, client, config, company: company(client) }
}
function confirmation(context: InvitationContext, identity: VerifiedWeeklyLiffIdentity, key: string) {
  return createHmac('sha256', key).update(JSON.stringify({ purpose: 'weekly-liff-confirm-v1', invitationHash: context.invite.tokenHash, invitationExpiresAt: context.invite.expiresAt.toISOString(), owner: context.client.ownerUserId, client: context.client.id, company: context.company, configurationFingerprint: context.config.configurationFingerprint, channel: identity.channelId, recipient: identity.lineUserId })).digest('base64url')
}
export function productionWeeklyLiffDependencies(): WeeklyLiffDependencies { return { configuration: weeklyLiffConfiguration(), repository: createWeeklyContentRepository } }
export async function getWeeklyLiffConnectContext(raw: unknown, deps: WeeklyLiffDependencies): Promise<WeeklyLiffContext> {
  const config = enabled(deps.configuration), input = weeklyLiffContextInput.parse(raw)
  const identity = await verifyWeeklyLiffIdentity(input.idToken, { channelId: config.channelId, fetchImpl: deps.fetchImpl, now: deps.now })
  const repo = deps.repository()
  if (!input.invitationToken) {
    const rows = await repo.listActiveBindingsForLineUser(identity.lineUserId, 20)
    if (identity.expiresAtSeconds <= Math.floor((deps.now || new Date()).getTime() / 1000)) return fail('LINE_IDENTITY_INVALID', 401)
    return { mode: 'bindings', companies: rows.filter(row => row.binding.lineUserId === identity.lineUserId && row.binding.status === 'active' && row.client.status === 'active' && row.client.requireCustomerApproval === true && row.config.status === 'active' && row.binding.ownerUserId === row.client.ownerUserId && row.binding.clientId === row.client.id && row.config.ownerUserId === row.client.ownerUserId && row.config.clientId === row.client.id).map(row => company(row.client)) }
  }
  const current = await invitationContext(repo, input.invitationToken, identity, () => deps.now || new Date())
  return { mode: 'invitation', company: current.company, expiresAt: current.invite.expiresAt.toISOString(), confirmationToken: confirmation(current, identity, config.tokenKey) }
}
export async function confirmWeeklyLiffConnection(raw: unknown, deps: WeeklyLiffDependencies) {
  const config = enabled(deps.configuration), input = weeklyLiffConfirmInput.parse(raw)
  const identity = await verifyWeeklyLiffIdentity(input.idToken, { channelId: config.channelId, fetchImpl: deps.fetchImpl, now: deps.now })
  return deps.repository().transaction(async repo => {
    const current = await invitationContext(repo, input.invitationToken, identity, () => deps.now || new Date(), true)
    const expected = confirmation(current, identity, config.tokenKey)
    if (!timingSafeEqual(Buffer.from(expected), Buffer.from(input.confirmationToken))) return fail('LIFF_COMPANY_CONFIRMATION_CHANGED')
    // Existing core claim stays in this transaction (including its durable inbox and same-user replay).
    const transactionRepository: WeeklyContentRepository = { ...repo, transaction: async work => work(repo) }
    const event = { namespace: 'weekly-liff-bind-v1', channel: identity.channelId, recipient: identity.lineUserId, invitationHash: current.invite.tokenHash }
    const eventFingerprint = hash(JSON.stringify(event))
    const result = await claimLineBindingInvite({ invitationToken: input.invitationToken, lineUserId: identity.lineUserId, webhookEventId: `weekly-liff-bind-v1:${eventFingerprint}`, semanticFingerprint: eventFingerprint }, { repository: transactionRepository, featureEnabled: true, tokenKey: config.tokenKey, now: deps.now })
    return { status: result.status === 'bound' ? 'bound' as const : 'replayed' as const, company: current.company }
  })
}
export async function weeklyLiffHttpInput(event: H3Event, confirm = false) {
  setResponseHeaders(event, WEEKLY_LIFF_HEADERS)
  const dependencies = productionWeeklyLiffDependencies(), config = enabled(dependencies.configuration)
  if (getRequestHeader(event, 'origin') !== config.origin || !/^application\/json(?:;|$)/i.test(getRequestHeader(event, 'content-type') || '')) return fail('LIFF_CONNECT_ORIGIN_REQUIRED', 403)
  const raw = await readBoundedRequestBody(event, { maxBytes: 12 * 1024, oversizedMessage: '連結資料過大。', invalidMessage: '連結資料不正確。', invalidStatusCode: 422 })
  return { dependencies, input: confirm ? weeklyLiffConfirmInput.parse(raw) : weeklyLiffContextInput.parse(raw) }
}
export function weeklyLiffPublicError(cause: unknown): never {
  const rawStatus = Number((cause as { statusCode?: unknown })?.statusCode)
  const original = cause instanceof ZodError || rawStatus === 400 ? 422 : rawStatus
  const statusCode = [401, 403, 404, 409, 413, 422, 503].includes(original) ? original : 503
  const messages: Record<number, string> = { 401: 'LINE 登入已失效，請重新登入。', 403: '請從搜尋王的客戶連結頁操作。', 404: '找不到有效邀約，請向服務人員索取。', 409: '邀約或公司資料已改變，請重新核對。', 413: '連結資料過大。', 422: '請檢查邀約碼並重新操作。', 503: 'LINE 客戶連結尚未設定完成，請稍後重試。' }
  throw createError({ statusCode, statusMessage: messages[statusCode] })
}

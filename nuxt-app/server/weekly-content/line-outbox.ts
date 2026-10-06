import { createHash, randomUUID } from 'node:crypto'
import { createError } from 'h3'
import type { WeeklyContentDependencies } from './service'
import { deriveReviewTokens } from './service'
import { weeklyRequestMatchesCurrent } from './publication-guard'
import { buildWeeklyLineReviewMessage, buildWeeklyLineRetryKey, sendWeeklyLinePush, isWeeklyLineAccessToken, normalizeWeeklyLinePublicOrigin, WEEKLY_LINE_USER_ID } from './line-transport'

export type WeeklyLineOutboxDependencies = WeeklyContentDependencies & { botUserId: string; publicOrigin: string; channelAccessToken: string; brand?: string; fetchImpl?: typeof fetch }
export type WeeklyLineOutboxResult = { status: 'disabled' | 'not_configured' | 'completed'; claimed: number; sent: number; deduplicated: number; retryWaiting: number; failed: number; cancelled: number; leaseLost: number }
const DAY_MS = 24 * 60 * 60 * 1000
// LINE retry keys expire after 24h. Conservatively start this window at outbox creation;
// never send an uncertain old request as a new message after provider deduplication expires.
export async function runWeeklyLineOutbox(input: { ownerUserId: number; clientId?: number; maxMessages?: number }, dependencies: WeeklyLineOutboxDependencies): Promise<WeeklyLineOutboxResult> {
  const result: WeeklyLineOutboxResult = { status: 'disabled', claimed: 0, sent: 0, deduplicated: 0, retryWaiting: 0, failed: 0, cancelled: 0, leaseLost: 0 }
  if (!dependencies.featureEnabled) return result
  if (!isWeeklyLineAccessToken(dependencies.channelAccessToken) || !WEEKLY_LINE_USER_ID.test(dependencies.botUserId) || Buffer.byteLength(dependencies.tokenKey || '') < 32) return { ...result, status: 'not_configured' }
  let origin: string
  try { origin = normalizeWeeklyLinePublicOrigin(dependencies.publicOrigin) } catch { return { ...result, status: 'not_configured' } }
  if (!Number.isSafeInteger(input.ownerUserId) || input.ownerUserId < 1) throw createError({ statusCode: 422, statusMessage: 'Weekly notification owner is invalid.' })
  if (input.clientId !== undefined && (!Number.isSafeInteger(input.clientId) || input.clientId < 1)) throw createError({ statusCode: 422, statusMessage: 'Weekly notification client is invalid.' })
  const maximum = Number.isSafeInteger(input.maxMessages) && input.maxMessages! > 0 ? Math.min(10, input.maxMessages!) : 10
  const now = dependencies.now || new Date()
  if (!Number.isFinite(now.getTime())) throw createError({ statusCode: 422, statusMessage: 'Weekly notification clock is invalid.' })
  try {
  const repository = dependencies.repository
  const leaseToken = randomUUID()
  result.status = 'completed'
  const rows = input.clientId === undefined
    ? await repository.claimOutbox(input.ownerUserId, maximum, leaseToken, now)
    : await repository.claimOutbox(input.ownerUserId, maximum, leaseToken, now, input.clientId)
  if (rows.length > maximum) throw createError({ statusCode: 503, statusMessage: 'Weekly notification storage returned an invalid claim.' })
  result.claimed = rows.length
  for (const row of rows) {
    if (row.ownerUserId !== input.ownerUserId || (input.clientId !== undefined && row.clientId !== input.clientId) || row.status !== 'processing' || row.leaseToken !== leaseToken || !row.leaseExpiresAt || row.leaseExpiresAt.getTime() <= now.getTime() + 10_000) { result.leaseLost++; continue }
    const finish = async (state: 'sent' | 'retry_wait' | 'failed' | 'cancelled', fields: { providerMessageId?: string; retryEligibleAt?: Date; errorCode?: string } = {}) => {
      const changed = await repository.finishOutbox(row.id, leaseToken, dependencies.now || new Date(), { status: state, ...fields })
      if (!changed) { result.leaseLost++; return false }
      if (state === 'sent') result.sent++
      else if (state === 'retry_wait') result.retryWaiting++
      else if (state === 'failed') result.failed++
      else result.cancelled++
      return true
    }
    const age = now.getTime() - row.createdAt.getTime()
    if (!Number.isFinite(age) || age < 0 || age >= DAY_MS || !Number.isSafeInteger(row.attemptNumber) || row.attemptNumber < 1 || row.attemptNumber > 6) { await finish('failed', { errorCode: 'line_retry_window_exhausted' }); continue }
    const request = await repository.getRequestByRowId(row.requestRowId)
    if (!request || request.id !== row.requestRowId || request.ownerUserId !== row.ownerUserId || request.clientId !== row.clientId || request.bindingId !== row.bindingId || request.status !== 'pending') { await finish('cancelled', { errorCode: 'line_review_no_longer_pending' }); continue }
    const [config, binding, draft] = await Promise.all([repository.getConfig(row.ownerUserId, row.clientId), repository.getBinding(row.ownerUserId, row.clientId), repository.getDraft(row.ownerUserId, row.clientId, request.entryId)])
    if (!config || config.ownerUserId !== row.ownerUserId || config.clientId !== row.clientId || !binding || !WEEKLY_LINE_USER_ID.test(binding.lineUserId) || !draft || !weeklyRequestMatchesCurrent(request, config, binding, draft, now) || draft.entryStatus !== 'ready_to_publish' || draft.machineAuthorizationValid !== true) { await finish('cancelled', { errorCode: 'line_review_identity_changed' }); continue }
    let message
    try {
      const tokens = deriveReviewTokens(request, dependencies.tokenKey)
      message = buildWeeklyLineReviewMessage({ requestId: request.requestId, readToken: tokens.readToken, actionToken: tokens.actionToken, title: draft.title, expiresAt: request.expiresAt, publicOrigin: origin, brand: dependencies.brand })
    } catch { await finish('failed', { errorCode: 'line_review_token_or_message_invalid' }); continue }
    const payload = JSON.stringify({ to: binding.lineUserId, messages: [message] })
    const fingerprint = createHash('sha256').update(JSON.stringify([dependencies.botUserId, payload])).digest('hex')
    // A restart/configuration change may not reuse one UUID with different content or recipient.
    if (!await repository.reserveOutboxPayload(row.id, leaseToken, fingerprint, now)) { await finish('cancelled', { errorCode: 'line_notification_payload_changed' }); continue }
    const sendNow = dependencies.now || new Date()
    if (sendNow.getTime() + 10_000 >= row.createdAt.getTime() + DAY_MS || row.leaseExpiresAt.getTime() <= sendNow.getTime() + 10_000 || !weeklyRequestMatchesCurrent(request, config, binding, draft, sendNow)) { await finish('failed', { errorCode: 'line_retry_window_or_lease_expired' }); continue }
    const retryKey = buildWeeklyLineRetryKey({ id: row.id, ownerUserId: row.ownerUserId, clientId: row.clientId, requestId: request.requestId, bindingId: row.bindingId })
    const pushed = await sendWeeklyLinePush({ lineUserId: binding.lineUserId, message, retryKey }, { channelAccessToken: dependencies.channelAccessToken, fetchImpl: dependencies.fetchImpl })
    if (pushed.accepted) {
      if (await finish('sent', { providerMessageId: pushed.providerMessageId }) && pushed.duplicate) result.deduplicated++
    } else {
      const retryAt = new Date((dependencies.now || new Date()).getTime() + Math.min(60_000 * 2 ** (row.attemptNumber - 1), 30 * 60_000))
      const retry = pushed.retryable && row.attemptNumber < 6 && retryAt.getTime() < row.createdAt.getTime() + DAY_MS
      await finish(retry ? 'retry_wait' : 'failed', { errorCode: pushed.errorCode, ...(retry ? { retryEligibleAt: retryAt } : {}) })
    }
  }
  return result
  } catch { throw createError({ statusCode: 503, statusMessage: 'Weekly notification processing is temporarily unavailable.' }) }
}

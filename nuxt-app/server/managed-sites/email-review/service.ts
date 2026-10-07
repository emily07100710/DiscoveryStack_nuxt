import { createError } from 'h3'
import { parseEmailManualReviewCommand, validateEmailManualReviewRecord } from './model'
import type { EmailManualReviewRepository } from './types'

const STORAGE_UNAVAILABLE = '郵件人工結案暫時無法儲存，請稍後重試。'

export async function closeEmailManualReview(
  ownerUserId: number,
  input: unknown,
  dependencies: { enabled: boolean; getRepository: () => EmailManualReviewRepository; clock?: () => Date },
) {
  if (dependencies.enabled !== true) throw createError({ statusCode: 503, statusMessage: '郵件人工結案功能尚未開通。' })
  if (!Number.isSafeInteger(ownerUserId) || ownerUserId <= 0) throw createError({ statusCode: 403, statusMessage: '郵件人工結案權限無效。' })

  const command = parseEmailManualReviewCommand(input)
  const closedAt = (dependencies.clock || (() => new Date()))()
  if (!(closedAt instanceof Date) || !Number.isFinite(closedAt.getTime()) || closedAt.getUTCFullYear() < 1000 || closedAt.getUTCFullYear() > 9999) {
    throw createError({ statusCode: 503, statusMessage: STORAGE_UNAVAILABLE })
  }

  let result
  try {
    const repository = dependencies.getRepository()
    result = await repository.close({ ownerUserId, command, closedAt })
  } catch {
    throw createError({ statusCode: 503, statusMessage: STORAGE_UNAVAILABLE })
  }

  if (!result || typeof result !== 'object') throw createError({ statusCode: 503, statusMessage: STORAGE_UNAVAILABLE })
  if (result.status === 'not_found') throw createError({ statusCode: 404, statusMessage: '找不到這筆郵件紀錄。' })
  if (result.status === 'not_eligible') throw createError({ statusCode: 409, statusMessage: '這筆郵件目前不符合人工結案條件。' })
  if (result.status === 'conflict') throw createError({ statusCode: 409, statusMessage: '郵件紀錄已變更或結案命令不一致，請重新載入。' })
  if ((result.status !== 'recorded' && result.status !== 'replayed') || !validateEmailManualReviewRecord(result.record)) {
    throw createError({ statusCode: 503, statusMessage: STORAGE_UNAVAILABLE })
  }

  const record = result.record
  if (record.ownerUserId !== ownerUserId || record.outboxId !== command.itemId || record.outboxVersion !== command.expectedVersion || record.requestId !== command.requestId || record.reason !== command.reason) {
    throw createError({ statusCode: 503, statusMessage: STORAGE_UNAVAILABLE })
  }
  if (record.closedAt.getTime() > closedAt.getTime() || result.status === 'recorded' && record.closedAt.getTime() !== closedAt.getTime()) {
    throw createError({ statusCode: 503, statusMessage: STORAGE_UNAVAILABLE })
  }

  return {
    itemId: record.outboxId,
    status: 'closed_no_resend' as const,
    replayed: result.status === 'replayed',
    reason: record.reason,
    closedAt: record.closedAt.toISOString(),
    outboxStatusUnchanged: true as const,
    resendAuthorized: false as const,
    inboxDeliveryVerified: false as const,
  }
}

import { createError, setResponseHeaders } from 'h3'
import { requireOwner } from '../../../utils/auth'
import { getOwnerDatabaseUserId } from '../../../audit/repository'
import { createManagedSiteEmailOutboxRepository } from '../../../managed-sites/email-outbox/repository'
import { managedSiteEmailOutboxReadinessFromEnv } from '../../../managed-sites/email-outbox/configuration'

export default defineEventHandler(async event => {
  setResponseHeaders(event, { 'cache-control': 'private, no-store, max-age=0', 'x-robots-tag': 'noindex, nofollow, noarchive', 'referrer-policy': 'no-referrer' })
  const owner = await requireOwner(event)
  const ownerUserId = await getOwnerDatabaseUserId(owner.openId)
  try {
    const rows = await createManagedSiteEmailOutboxRepository().listSafeMetadata({ ownerUserId, limit: 50 })
    // A second explicit projection prevents a future repository field from leaking into HTTP.
    const items = rows.map(row => ({ id: row.id, purpose: row.purpose, status: row.status, createdAt: row.createdAt, updatedAt: row.updatedAt, nextAttemptAt: row.nextAttemptAt, expiresAt: row.expiresAt, attemptCount: row.attemptCount, lastErrorCode: row.lastErrorCode }))
    const readiness = managedSiteEmailOutboxReadinessFromEnv()
    return { items, limit: 50, prePurchaseChallengesExcluded: true, configurationReady: readiness.configured, executionEnabled: readiness.enabled, inboxDeliveryVerified: false as const }
  } catch {
    throw createError({ statusCode: 503, statusMessage: '郵件紀錄暫時無法讀取，請確認資料庫更新與設定。' })
  }
})

import { createError, setResponseHeaders } from 'h3'
import { requireOwner } from '../../../utils/auth'
import { getOwnerDatabaseUserId } from '../../../audit/repository'
import { createManagedSiteEmailOutboxRepository } from '../../../managed-sites/email-outbox/repository'
import { managedSiteEmailOutboxReadinessFromEnv } from '../../../managed-sites/email-outbox/configuration'
import { managedSiteEmailEventsReadinessFromEnv } from '../../../managed-sites/email-events/configuration'
import { createEmailProviderEventsRepository } from '../../../managed-sites/email-events/repository'
import { projectEmailProviderObservation } from '../../../managed-sites/email-events/projection'
import { createEmailManualReviewRepository } from '../../../managed-sites/email-review/repository'
import { projectEmailManualReview } from '../../../managed-sites/email-review/model'

export default defineEventHandler(async event => {
  setResponseHeaders(event, { 'cache-control': 'private, no-store, max-age=0', 'x-robots-tag': 'noindex, nofollow, noarchive', 'referrer-policy': 'no-referrer' })
  const owner = await requireOwner(event)
  const ownerUserId = await getOwnerDatabaseUserId(owner.openId)
  try {
    const rows = await createManagedSiteEmailOutboxRepository().listSafeMetadata({ ownerUserId, limit: 50 })
    const eventReadiness = managedSiteEmailEventsReadinessFromEnv()
    // Keep the default-off path compatible with an unapplied additive event migration.
    const observations = eventReadiness.enabled && eventReadiness.configured && rows.length
      ? await createEmailProviderEventsRepository().listOwnerFacts({ ownerUserId, outboxIds: rows.map(row => row.id) }) : []
    const factsById = new Map(observations.map(observation => [observation.outboxId, observation.facts]))
    const manualReviewEnabled = process.env.NUXT_MANAGED_SITE_EMAIL_REVIEW_ENABLED === 'true'
    const manualIds = rows.filter(row => row.status === 'manual_required').map(row => row.id)
    const reviews = manualReviewEnabled && manualIds.length
      ? await createEmailManualReviewRepository().listOwnerReviews({ ownerUserId, outboxIds: manualIds }) : []
    const reviewsById = new Map(reviews.map(review => [review.outboxId, review]))
    // A second explicit projection prevents a future repository field from leaking into HTTP.
    const items = rows.map(row => ({ id: row.id, purpose: row.purpose, status: row.status, createdAt: row.createdAt, updatedAt: row.updatedAt, nextAttemptAt: row.nextAttemptAt, expiresAt: row.expiresAt, attemptCount: row.attemptCount, lastErrorCode: row.lastErrorCode, ...projectEmailProviderObservation(factsById.get(row.id) || null), ...projectEmailManualReview({ enabled: manualReviewEnabled, ownerUserId, snapshot: row, record: reviewsById.get(row.id) || null }) }))
    const readiness = managedSiteEmailOutboxReadinessFromEnv()
    return { items, limit: 50, prePurchaseChallengesExcluded: true, configurationReady: readiness.configured, executionEnabled: readiness.enabled, providerEventsConfigured: eventReadiness.configured, providerEventsEnabled: eventReadiness.enabled, manualReviewEnabled, inboxDeliveryVerified: false as const }
  } catch {
    throw createError({ statusCode: 503, statusMessage: '郵件紀錄暫時無法讀取，請確認資料庫更新與設定。' })
  }
})

import { resolveControlledOwnerDatabaseUserId } from '../audit/repository'
import { managedSiteEmailOutboxReadinessFromEnv } from '../managed-sites/email-outbox/configuration'
import { getManagedSiteEmailOutboxRuntime } from '../managed-sites/email-outbox/runtime'
import { createManagedSiteEmailOutboxRepository } from '../managed-sites/email-outbox/repository'

const MAX_ITEMS = 3
const TICK_BUDGET_MS = 45_000

export default defineTask({
  meta: { name: 'managed-sites:email-outbox-tick', description: 'Process at most three current-authority encrypted transactional emails; disabled by default and never claims inbox delivery.' },
  async run(): Promise<{ result: Record<string, unknown> }> {
    // Task payloads cannot enable delivery or choose an owner, recipient, item or retry policy.
    const enabled = process.env.NUXT_MANAGED_SITE_EMAIL_OUTBOX_ENABLED === 'true'
    const retentionEnabled = process.env.NUXT_MANAGED_SITE_EMAIL_OUTBOX_RETENTION_ENABLED === 'true'
    if (!enabled && !retentionEnabled) return { result: { status: 'disabled', processed: 0 } }
    const configured = enabled && managedSiteEmailOutboxReadinessFromEnv().configured
    if (!configured && !retentionEnabled) return { result: { status: 'unconfigured', processed: 0 } }
    const counts = { processed: 0, accepted: 0, queued: 0, cancelled: 0, manualRequired: 0 }
    let expiredCleaned = 0
    try {
      const config = useRuntimeConfig()
      await resolveControlledOwnerDatabaseUserId(String(config.ownerOpenId || process.env.OWNER_OPEN_ID || ''))
      if (retentionEnabled) expiredCleaned = await createManagedSiteEmailOutboxRepository().cancelExpired({ now: new Date(), limit: 50 })
      if (!enabled) return { result: { status: 'retention_only', processed: 0, expiredCleaned } }
      if (!configured) return { result: { status: 'unconfigured', processed: 0, expiredCleaned } }
      const runtime = getManagedSiteEmailOutboxRuntime()
      const startedAt = Date.now()
      while (counts.processed < MAX_ITEMS && Date.now() - startedAt < TICK_BUDGET_MS) {
        const outcome = await runtime.processOne()
        if (!outcome || !outcome.itemId) break
        counts.processed++
        if (outcome.accepted) counts.accepted++
        else if (outcome.status === 'queued') counts.queued++
        else if (outcome.status === 'cancelled') counts.cancelled++
        else counts.manualRequired++
      }
      return { result: { status: 'processed', ...counts, expiredCleaned, inboxDeliveryVerified: false } }
    } catch {
      // Never expose DB/provider exceptions, addresses, link tokens, ciphertext or raw receipts.
      return { result: { status: 'deferred', ...counts, expiredCleaned, reasonCode: 'EMAIL_OUTBOX_DEFERRED' } }
    }
  },
})

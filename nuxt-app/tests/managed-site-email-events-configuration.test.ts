import { describe, expect, it } from 'vitest'
import { managedSiteEmailEventsReadinessFromEnv } from '../server/managed-sites/email-events/configuration'

const SIGNING_SECRET = `whsec_${Buffer.alloc(32, 0x51).toString('base64')}`
const ENCRYPTION_SECRET = 'synthetic-outbox-encryption-key-32-bytes'
const ENV = {
  NUXT_MANAGED_SITE_EMAIL_API_KEY: 're_synthetic_key_not_used',
  NUXT_MANAGED_SITE_EMAIL_FROM: 'DiscoveryStack <no-reply@example.test>',
  DISCOVERYSTACK_MANAGED_SITE_ALLOWED_PROVIDER_ORIGINS: 'https://api.resend.com',
  NUXT_MANAGED_SITE_EMAIL_OUTBOX_ENCRYPTION_KEY: ENCRYPTION_SECRET,
  NUXT_MANAGED_SITE_EMAIL_EVENTS_WEBHOOK_SECRET: SIGNING_SECRET,
}

describe('email provider event readiness', () => {
  it('defaults observation off while validating the configured official Resend endpoint', () => {
    expect(managedSiteEmailEventsReadinessFromEnv(ENV)).toEqual({
      enabled: false,
      configured: true,
      status: 'configured',
      providerObservationOnly: true,
      inboxDeliveryVerified: false,
    })
  })

  it('uses an independent event-observation switch regardless of transactional sending switch', () => {
    const eventsOnSendingOff = managedSiteEmailEventsReadinessFromEnv({ ...ENV, NUXT_MANAGED_SITE_EMAIL_EVENTS_ENABLED: 'true' })
    expect(eventsOnSendingOff).toMatchObject({ enabled: true, configured: true, providerObservationOnly: true, inboxDeliveryVerified: false })

    const eventsOffSendingOn = managedSiteEmailEventsReadinessFromEnv({ ...ENV, NUXT_MANAGED_SITE_EMAIL_OUTBOX_ENABLED: 'true' })
    expect(eventsOffSendingOn).toMatchObject({ enabled: false, configured: true, providerObservationOnly: true, inboxDeliveryVerified: false })
  })

  it('requires a canonical configured webhook secret without returning secret values', () => {
    const missing = managedSiteEmailEventsReadinessFromEnv({ ...ENV, NUXT_MANAGED_SITE_EMAIL_EVENTS_ENABLED: 'true', NUXT_MANAGED_SITE_EMAIL_EVENTS_WEBHOOK_SECRET: undefined })
    const malformed = managedSiteEmailEventsReadinessFromEnv({ ...ENV, NUXT_MANAGED_SITE_EMAIL_EVENTS_ENABLED: 'true', NUXT_MANAGED_SITE_EMAIL_EVENTS_WEBHOOK_SECRET: 'whsec_not-canonical' })
    expect(missing).toMatchObject({ enabled: true, configured: false, status: 'not_configured' })
    expect(malformed).toMatchObject({ enabled: true, configured: false, status: 'not_configured' })
    const serialized = JSON.stringify(managedSiteEmailEventsReadinessFromEnv({ ...ENV, NUXT_MANAGED_SITE_EMAIL_EVENTS_ENABLED: 'true' }))
    for (const secret of [SIGNING_SECRET, ENCRYPTION_SECRET, ENV.NUXT_MANAGED_SITE_EMAIL_API_KEY, ENV.NUXT_MANAGED_SITE_EMAIL_FROM]) expect(serialized).not.toContain(secret)
  })

  it('defaults the send endpoint to official Resend and refuses another configured provider endpoint', () => {
    const explicitOfficial = managedSiteEmailEventsReadinessFromEnv({ ...ENV, NUXT_MANAGED_SITE_EMAIL_ENDPOINT: 'https://api.resend.com/emails' })
    expect(explicitOfficial).toMatchObject({ configured: true, status: 'configured' })

    const alternateAllowed = managedSiteEmailEventsReadinessFromEnv({
      ...ENV,
      NUXT_MANAGED_SITE_EMAIL_ENDPOINT: 'https://relay.example.test/emails',
      DISCOVERYSTACK_MANAGED_SITE_ALLOWED_PROVIDER_ORIGINS: 'https://relay.example.test',
    })
    expect(alternateAllowed).toMatchObject({ enabled: false, configured: false, status: 'not_configured' })
  })

  it('does not report event readiness when the existing transactional outbox is incomplete', () => {
    expect(managedSiteEmailEventsReadinessFromEnv({ ...ENV, NUXT_MANAGED_SITE_EMAIL_API_KEY: undefined })).toMatchObject({
      enabled: false,
      configured: false,
      status: 'not_configured',
      providerObservationOnly: true,
      inboxDeliveryVerified: false,
    })
  })
})

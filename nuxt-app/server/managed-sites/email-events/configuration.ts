import { managedSiteEmailOutboxReadinessFromEnv } from '../email-outbox/configuration'
import { isResendWebhookSecret } from './protocol'

type Environment = Record<string, string | undefined>
/** No configured values, database/transport work, provider acceptance or inbox delivery claims. */
export function managedSiteEmailEventsReadinessFromEnv(environment: Environment = process.env) {
  const outbox = managedSiteEmailOutboxReadinessFromEnv(environment)
  const enabled = environment.NUXT_MANAGED_SITE_EMAIL_EVENTS_ENABLED === 'true'
  const signingConfigured = isResendWebhookSecret(environment.NUXT_MANAGED_SITE_EMAIL_EVENTS_WEBHOOK_SECRET)
  const officialResend = (environment.NUXT_MANAGED_SITE_EMAIL_ENDPOINT || 'https://api.resend.com/emails') === 'https://api.resend.com/emails'
  const configured = outbox.configured && signingConfigured && officialResend
  return { enabled, configured, status: configured ? 'configured' as const : 'not_configured' as const, providerObservationOnly: true as const, inboxDeliveryVerified: false as const }
}

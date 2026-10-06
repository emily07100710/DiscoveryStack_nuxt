import { managedSiteEmailReadinessFromEnv } from '../contact-inbox/email-transport'

type Environment = Record<string, string | undefined>

/** Configuration only: no values, DB, provider calls, receipt or delivery claims. */
export function managedSiteEmailOutboxReadinessFromEnv(environment: Environment = process.env) {
  const email = managedSiteEmailReadinessFromEnv(environment)
  const key = environment.NUXT_MANAGED_SITE_EMAIL_OUTBOX_ENCRYPTION_KEY || ''
  const keyBytes = Buffer.byteLength(key, 'utf8')
  const encryptionConfigured = keyBytes >= 32 && keyBytes <= 4096
  const enabled = environment.NUXT_MANAGED_SITE_EMAIL_OUTBOX_ENABLED === 'true'
  const missing = [...email.missing, ...(!key ? ['NUXT_MANAGED_SITE_EMAIL_OUTBOX_ENCRYPTION_KEY'] : [])]
  const issues = [...email.issues, ...(key && !encryptionConfigured ? ['NUXT_MANAGED_SITE_EMAIL_OUTBOX_ENCRYPTION_KEY 長度無效'] : [])]
  const configured = email.configured && encryptionConfigured
  return {
    configured,
    enabled,
    status: configured ? 'configured' as const : issues.length ? 'invalid' as const : 'missing' as const,
    missing,
    issues,
    storageVerified: false as const,
    providerAcceptanceVerified: false as const,
    inboxDeliveryVerified: false as const,
  }
}

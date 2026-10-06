import { createHash } from 'node:crypto'
import { createError } from 'h3'
import { getDatabase } from '../../database'
import { stableFingerprint } from '../../seo-geo-core/repository'
import { managedSiteEmailReadinessFromEnv, managedSiteEmailTransportFromEnv, type ManagedSiteEmailTransport } from '../contact-inbox/email-transport'
import { createManagedSiteEmailOutboxRepository } from './repository'
import { createManagedSiteEmailOutboxService } from './service'
import type { ManagedSiteEmailAuthorityResolver, ManagedSiteEmailOutboxRepository, ManagedSiteEmailOutboxServiceDependencies } from './types'
import { createManagedSiteEmailAuthorityResolver, type ManagedSiteEmailAuthorityDependencies } from './authority'

type ServiceOptions = Pick<ManagedSiteEmailOutboxServiceDependencies, 'repository' | 'encryptionSecret' | 'providerConfigurationFingerprint' | 'transport' | 'resolveAuthority' | 'clock' | 'executionEnabled'>
export type ManagedSiteEmailOutboxRuntimeOptions = Partial<ServiceOptions> & { repository?: ManagedSiteEmailOutboxRepository; authorityDependencies?: ManagedSiteEmailAuthorityDependencies }

let testRuntimeOptions: ManagedSiteEmailOutboxRuntimeOptions | null = null

/** A test-only injection seam; production callers always resolve environment and shared DB authority here. */
export function setManagedSiteEmailOutboxRuntimeForTests(options: ManagedSiteEmailOutboxRuntimeOptions | null): void {
  if (process.env.NODE_ENV !== 'test') throw createError({ statusCode: 403, statusMessage: 'Managed-site email outbox runtime injection is test-only.' })
  testRuntimeOptions = options
}

function emailConfigurationFingerprint(): string {
  const environment = process.env
  const endpoint = environment.NUXT_MANAGED_SITE_EMAIL_ENDPOINT || 'https://api.resend.com/emails'
  const from = environment.NUXT_MANAGED_SITE_EMAIL_FROM || ''
  const allowlist = (environment.DISCOVERYSTACK_MANAGED_SITE_ALLOWED_PROVIDER_ORIGINS || '').split(',').map(value => value.trim()).filter(Boolean).sort()
  const apiKeyFingerprint = createHash('sha256').update(environment.NUXT_MANAGED_SITE_EMAIL_API_KEY || '').digest('hex')
  const encryptionKeyFingerprint = createHash('sha256').update(environment.NUXT_MANAGED_SITE_EMAIL_OUTBOX_ENCRYPTION_KEY || '').digest('hex')
  const pepperFingerprint = createHash('sha256').update(environment.NUXT_MANAGED_SITE_EMAIL_CODE_PEPPER || '').digest('hex')
  return stableFingerprint({ endpoint, from, allowlist, privateOrigin: environment.NUXT_DISCOVERYSTACK_PRIVATE_ORIGIN || '', timeout: environment.NUXT_MANAGED_SITE_EMAIL_TIMEOUT_MS || '10000', apiKeyFingerprint, encryptionKeyFingerprint, pepperFingerprint })
}

function environmentOptions(repository: ManagedSiteEmailOutboxRepository): ServiceOptions {
  const readiness = managedSiteEmailReadinessFromEnv()
  let transport: ManagedSiteEmailTransport
  try { transport = managedSiteEmailTransportFromEnv() } catch { transport = { configured: false, async send() { throw new Error('email transport unavailable') } } }
  return {
    repository,
    encryptionSecret: process.env.NUXT_MANAGED_SITE_EMAIL_OUTBOX_ENCRYPTION_KEY,
    providerConfigurationFingerprint: emailConfigurationFingerprint(),
    transport,
    resolveAuthority: createManagedSiteEmailAuthorityResolver({ codePepper: process.env.NUXT_MANAGED_SITE_EMAIL_CODE_PEPPER, portalOrigin: process.env.NUXT_DISCOVERYSTACK_PRIVATE_ORIGIN, nodeEnv: process.env.NODE_ENV }),
    executionEnabled: readiness.configured && process.env.NUXT_MANAGED_SITE_EMAIL_OUTBOX_ENABLED === 'true',
  }
}

function optionsFor(repository: ManagedSiteEmailOutboxRepository, overrides: ManagedSiteEmailOutboxRuntimeOptions = {}) {
  const env = environmentOptions(repository)
  const authority = overrides.resolveAuthority || (overrides.authorityDependencies
    ? createManagedSiteEmailAuthorityResolver({ codePepper: process.env.NUXT_MANAGED_SITE_EMAIL_CODE_PEPPER, portalOrigin: process.env.NUXT_DISCOVERYSTACK_PRIVATE_ORIGIN, nodeEnv: process.env.NODE_ENV, ...overrides.authorityDependencies })
    : env.resolveAuthority)
  return { ...env, ...overrides, repository, resolveAuthority: authority }
}

/** Build a lease-backed outbox service against either shared storage or a caller's active SQL transaction. */
export function createManagedSiteEmailOutboxRuntime(repository: ManagedSiteEmailOutboxRepository, overrides: ManagedSiteEmailOutboxRuntimeOptions = {}) {
  if (process.env.NODE_ENV === 'test' && testRuntimeOptions) return createManagedSiteEmailOutboxService(optionsFor(repository, { ...testRuntimeOptions, ...overrides, repository }))
  return createManagedSiteEmailOutboxService(optionsFor(repository, overrides))
}

/** Production singleton factory; tests may replace it only through the guarded setter above. */
export function getManagedSiteEmailOutboxRuntime() {
  if (process.env.NODE_ENV === 'test' && testRuntimeOptions) {
    const repository = testRuntimeOptions.repository || createManagedSiteEmailOutboxRepository()
    return createManagedSiteEmailOutboxRuntime(repository, testRuntimeOptions)
  }
  const repository = createManagedSiteEmailOutboxRepository()
  return createManagedSiteEmailOutboxRuntime(repository)
}

/** The post-commit attempt must use shared storage, never the source transaction connection. */
export async function attemptManagedSiteEmailOutboxItem(itemId: string) {
  if (process.env.NODE_ENV === 'test' && testRuntimeOptions) return getManagedSiteEmailOutboxRuntime().attempt(itemId)
  const database = getDatabase()
  if (!database) return { accepted: false as const, itemId, status: 'queued' as const, code: 'outbox_storage_unavailable' as const }
  return getManagedSiteEmailOutboxRuntime().attempt(itemId)
}

/** Construct a service over an existing SQL transaction repository for atomic source+outbox inserts. */
export function createManagedSiteEmailOutboxTransactionRuntime(transaction: unknown, overrides: ManagedSiteEmailOutboxRuntimeOptions = {}) {
  const repository = createManagedSiteEmailOutboxRepository(transaction as NonNullable<ReturnType<typeof getDatabase>>)
  return createManagedSiteEmailOutboxRuntime(repository, overrides)
}

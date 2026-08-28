import { createError } from 'h3'
import { getDrizzleMediaVaultRepository, getMediaStorageConnection } from '../media-vault/repository-drizzle'
import { createLocalDevMediaStorage, createS3MediaStorage } from '../media-vault/storage'
import { createUnavailableProductionScanner, inspectMediaBytes } from '../media-vault/validation'
import type { MediaImageProcessor, MediaStoragePort, MediaTenantScope } from '../media-vault/types'
import { getDrizzlePageEditorRepository } from './repository-drizzle'
import { and, desc, eq, inArray } from 'drizzle-orm'
import { getDatabase } from '../../database'
import { contentOperationPublicationTargets, managedSiteProjects, managedSiteReleaseProjections } from '../../database/schema'
import { createSharpMediaImageProcessor } from '../media-vault/sharp-processor'
import { createHttpMediaSecurityScanner } from '../media-vault/scanner'
import type { MediaSecurityScanner } from '../media-vault/types'
import { stableFingerprint } from '../../seo-geo-core/repository'

const unavailableProcessor: MediaImageProcessor = { async inspect(bytes) { return inspectMediaBytes(bytes) }, async produceVariants() { throw createError({ statusCode: 503, statusMessage: 'Production image codec/metadata scrubber is not configured; media remains quarantined.' }) } }
export async function resolveMediaStorage(scope: MediaTenantScope): Promise<MediaStoragePort> {
  const row = await getMediaStorageConnection(scope); const configuration = row.configuration as Record<string, unknown>
  if (row.providerKey === 'local_dev') { if (process.env.NODE_ENV === 'production' || typeof configuration.root !== 'string') throw createError({ statusCode: 503, statusMessage: 'Local media storage is unavailable in production.' }); return createLocalDevMediaStorage(configuration.root) }
  if (row.providerKey === 's3_compatible') return createS3MediaStorage({ configuration: { bucket: String(configuration.bucket || ''), region: String(configuration.region || ''), prefix: String(configuration.prefix || ''), ...(configuration.endpoint ? { endpoint: String(configuration.endpoint) } : {}), ...(configuration.publicCdnOrigin ? { publicCdnOrigin: String(configuration.publicCdnOrigin) } : {}), credentialReference: row.credentialReference || '' } })
  throw createError({ statusCode: 503, statusMessage: 'Test-only media storage cannot resolve in the production editor runtime.' })
}
async function resolveMediaScanner(scope: MediaTenantScope): Promise<MediaSecurityScanner> { const endpoint = process.env.NUXT_MEDIA_SCANNER_ENDPOINT; const credentialReference = process.env.NUXT_MEDIA_SCANNER_CREDENTIAL_REF; if (!endpoint || !credentialReference) return createUnavailableProductionScanner('quarantine'); const row = await getMediaStorageConnection(scope); const expected = stableFingerprint({ endpoint, credentialReference }); if (row.scannerAuthorityFingerprint !== expected || !row.scannerHealthReceiptFingerprint || !row.scannerVerifiedAt) return createUnavailableProductionScanner('quarantine'); return createHttpMediaSecurityScanner({ endpoint, credentialReference }) }
export async function resolveEditorRuntime(scope: MediaTenantScope) { const storage = await resolveMediaStorage(scope); let processor: MediaImageProcessor = unavailableProcessor; try { processor = createSharpMediaImageProcessor() } catch { /* resolver remains fail closed when native codec is unavailable */ } return { mediaRepository: getDrizzleMediaVaultRepository(), pageRepository: getDrizzlePageEditorRepository(), storage, scanner: await resolveMediaScanner(scope), processor } }
export async function resolvePagePublicationAuthority(scope: MediaTenantScope) {
  const database = getDatabase(); if (!database) throw createError({ statusCode: 503, statusMessage: 'Publication authority database is unavailable.' })
  const [project] = await database.select({ clientId: managedSiteProjects.contentOperationClientId }).from(managedSiteProjects).where(and(eq(managedSiteProjects.ownerUserId, scope.ownerUserId), eq(managedSiteProjects.id, scope.projectId))).limit(1); if (!project?.clientId) throw createError({ statusCode: 409, statusMessage: 'Managed site is not linked to canonical Content Operations publication authority.' })
  const [release] = await database.select({ id: managedSiteReleaseProjections.id }).from(managedSiteReleaseProjections).where(and(eq(managedSiteReleaseProjections.ownerUserId, scope.ownerUserId), eq(managedSiteReleaseProjections.projectId, scope.projectId), inArray(managedSiteReleaseProjections.status, ['approved', 'payment_verified', 'deployment_pending', 'live_verified', 'geo_active']))).orderBy(desc(managedSiteReleaseProjections.updatedAt)).limit(1); if (!release) throw createError({ statusCode: 409, statusMessage: 'No governed managed-site release is approved for page publication.' })
  const targets = await database.select({ id: contentOperationPublicationTargets.id }).from(contentOperationPublicationTargets).where(and(eq(contentOperationPublicationTargets.ownerUserId, scope.ownerUserId), eq(contentOperationPublicationTargets.clientId, project.clientId), eq(contentOperationPublicationTargets.status, 'active'), inArray(contentOperationPublicationTargets.framework, ['astro', 'nuxt']), inArray(contentOperationPublicationTargets.transport, ['first_party_git', 'first_party_signed_api']))).orderBy(desc(contentOperationPublicationTargets.updatedAt)).limit(20); if (!targets.length) throw createError({ statusCode: 409, statusMessage: 'No active first-party publication target is configured for this managed site.' })
  return { clientId: project.clientId, releaseReference: `release:${release.id}`, publicationTargetReferences: targets.map(target => `target:${target.id}`) }
}

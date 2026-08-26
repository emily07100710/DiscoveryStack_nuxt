import { createError } from 'h3'
import { parseSiteSpecSnapshot } from './site-spec'
import type { ManagedSiteModuleKey } from './modules-types'
import type { ManagedSiteRepository } from './types'

function conflict(message: string): never { throw createError({ statusCode: 409, statusMessage: message }) }

const SITE_SPEC_ENTITLEMENT_KEYS = new Set<ManagedSiteModuleKey>([
  'bounded_ai_assistant',
  'shopify_commerce',
  'line_assisted_integration',
  'google_booking_assisted_integration',
  'pwa_reference_only',
])

export async function assertPaidManagedSiteProject(ownerUserId: number, projectId: number, repository: ManagedSiteRepository) {
  const project = await repository.findProject(ownerUserId, projectId)
  if (!project) throw createError({ statusCode: 404, statusMessage: 'Managed site project was not found.' })
  if (project.status !== 'active') conflict('Managed site integration requires an active paid project.')
  const versionId = project.activeVersionId
  if (!versionId) conflict('Managed site integration requires an active validated SiteSpec.')
  const version = await repository.findVersion(ownerUserId, versionId)
  if (!version || version.projectId !== projectId || version.lifecycleStatus !== 'active') conflict('Managed site integration requires an active validated SiteSpec.')
  const spec = parseSiteSpecSnapshot(version.siteSpecSnapshot)
  const subscription = await repository.findSubscription(ownerUserId, projectId)
  if (!subscription || subscription.ownerUserId !== ownerUserId || subscription.projectId !== projectId || subscription.status !== 'active') conflict('Managed site integration requires an active paid subscription.')
  return { project, version, spec, subscription }
}

export async function assertPaidManagedSiteModuleEntitlement(ownerUserId: number, projectId: number, moduleKey: ManagedSiteModuleKey, repository: ManagedSiteRepository) {
  const authority = await assertPaidManagedSiteProject(ownerUserId, projectId, repository)
  if (SITE_SPEC_ENTITLEMENT_KEYS.has(moduleKey) && !authority.spec.selectedModules.includes(moduleKey as typeof authority.spec.selectedModules[number])) conflict('The requested managed-site integration is not entitled by the active SiteSpec.')
  return authority
}

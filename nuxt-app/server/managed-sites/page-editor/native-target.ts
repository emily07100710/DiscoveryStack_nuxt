import { stableFingerprint } from '../../content-operations/normalization'

export const MANAGED_SITE_CLOUDFLARE_TARGET_PREFIX = 'managed-site-cloudflare' as const
export const MANAGED_SITE_CLOUDFLARE_CONTENT_ROOT = 'managed-site-pages' as const
export const MANAGED_SITE_CLOUDFLARE_CONTENT_TYPES = ['article', 'faq', 'managed_page', 'service_page'] as const

export function managedSiteCloudflareTargetKey(projectId: number): string {
  return `${MANAGED_SITE_CLOUDFLARE_TARGET_PREFIX}:${projectId}`
}

/** Mirrors Content Operations' canonical target identity without importing a funnel service. */
export function managedSiteCloudflareTargetId(ownerUserId: number, clientId: number, projectId: number): string {
  return `target-${stableFingerprint({ ownerUserId, clientId, idempotencyKey: managedSiteCloudflareTargetKey(projectId) }).slice(0, 32)}`
}

type NativeTargetProjection = {
  ownerUserId?: unknown
  clientId?: unknown
  targetId?: unknown
  idempotencyKey?: unknown
  framework?: unknown
  transport?: unknown
  targetOrigin?: unknown
  contentRoot?: unknown
  endpointPath?: unknown
  credentialReference?: unknown
  allowedContentTypes?: unknown
  status?: unknown
  executionEnabled?: unknown
}

/** Fail-closed recognition for the reserved in-process Cloudflare publication path. */
export function isManagedSiteCloudflareTarget(input: {
  target: NativeTargetProjection
  ownerUserId: number
  clientId: number
  projectId: number
  canonicalOrigin: string
  endpointPath: string
}): boolean {
  try {
    const key = managedSiteCloudflareTargetKey(input.projectId)
    const allowed = Array.isArray(input.target.allowedContentTypes) ? input.target.allowedContentTypes : []
    return input.target.ownerUserId === input.ownerUserId
      && input.target.clientId === input.clientId
      && input.target.targetId === managedSiteCloudflareTargetId(input.ownerUserId, input.clientId, input.projectId)
      && input.target.idempotencyKey === key
      && input.target.credentialReference === key
      && input.target.framework === 'astro'
      && input.target.transport === 'first_party_signed_api'
      && input.target.targetOrigin === input.canonicalOrigin
      && input.target.contentRoot === MANAGED_SITE_CLOUDFLARE_CONTENT_ROOT
      && input.target.endpointPath === input.endpointPath
      && input.target.status === 'active'
      && input.target.executionEnabled === true
      && allowed.length === MANAGED_SITE_CLOUDFLARE_CONTENT_TYPES.length
      && MANAGED_SITE_CLOUDFLARE_CONTENT_TYPES.every(contentType => allowed.includes(contentType))
  } catch {
    return false
  }
}

import { describe, expect, it } from 'vitest'
import { isManagedSiteCloudflareTarget, MANAGED_SITE_CLOUDFLARE_CONTENT_TYPES, managedSiteCloudflareTargetId, managedSiteCloudflareTargetKey } from '../server/managed-sites/page-editor/native-target'
import { SIGNED_API_ENDPOINT_PATH } from '../server/first-party-publishing/target-guard'

const scope = { ownerUserId: 1, clientId: 4, projectId: 7, canonicalOrigin: 'https://synthetic-client.taipei', endpointPath: SIGNED_API_ENDPOINT_PATH }
const key = managedSiteCloudflareTargetKey(scope.projectId)
function target() { return { ownerUserId: 1, clientId: 4, targetId: managedSiteCloudflareTargetId(1, 4, 7), idempotencyKey: key, framework: 'astro', transport: 'first_party_signed_api', targetOrigin: scope.canonicalOrigin, contentRoot: 'managed-site-pages', endpointPath: SIGNED_API_ENDPOINT_PATH, credentialReference: key, allowedContentTypes: [...MANAGED_SITE_CLOUDFLARE_CONTENT_TYPES], status: 'active', executionEnabled: true } }

describe('reserved native Managed Site publication target', () => {
  it('recognizes only the canonical server-created target for the exact owner/client/project', () => {
    expect(isManagedSiteCloudflareTarget({ ...scope, target: target() })).toBe(true)
    expect(managedSiteCloudflareTargetId(1, 4, 7)).not.toBe(managedSiteCloudflareTargetId(2, 4, 7))
    expect(managedSiteCloudflareTargetId(1, 4, 7)).not.toBe(managedSiteCloudflareTargetId(1, 5, 7))
    expect(managedSiteCloudflareTargetId(1, 4, 7)).not.toBe(managedSiteCloudflareTargetId(1, 4, 8))
  })
  it.each([
    { ownerUserId: 2 }, { clientId: 5 }, { targetId: 'target-arbitrary' }, { idempotencyKey: 'arbitrary' },
    { credentialReference: 'vault:foreign' }, { framework: 'nuxt' }, { transport: 'first_party_git' },
    { targetOrigin: 'https://foreign.taipei' }, { contentRoot: 'another-root' }, { endpointPath: '/arbitrary' },
    { status: 'paused' }, { executionEnabled: false }, { allowedContentTypes: ['managed_page'] },
    { allowedContentTypes: [...MANAGED_SITE_CLOUDFLARE_CONTENT_TYPES, 'raw_html'] },
  ])('rejects a drifted or forged reserved target %j', patch => {
    expect(isManagedSiteCloudflareTarget({ ...scope, target: { ...target(), ...patch } })).toBe(false)
  })
})

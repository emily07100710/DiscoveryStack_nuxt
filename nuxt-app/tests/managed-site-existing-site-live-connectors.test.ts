import { describe, expect, it } from 'vitest'
import { buildSiteSpec } from '../server/managed-sites/site-spec'
import { createManagedSiteProject, createManagedSiteVersion } from '../server/managed-sites/service'
import { stableFingerprint } from '../server/seo-geo-core/repository'
import { configureManagedSiteProvider } from '../server/managed-sites/live-connectors/provider-registry'
import { activateManagedSiteGeoOperations, createExistingSiteRelease, createMockExistingSiteOwnershipAdapter, verifyExistingSiteOwnership } from '../server/managed-sites/live-connectors/deployment-orchestrator'
import { canonicalizeManagedDomain } from '../server/managed-sites/live-connectors/domain-connectors'
import { createManagedSiteMemoryRepository } from './fixtures/managed-site/repository'
import { createLiveConnectorMemoryRepository } from './fixtures/managed-site/live-connectors-repository'

async function projectFor(ownerUserId: number, key: string, website: string, managed: ReturnType<typeof createManagedSiteMemoryRepository>) {
  const actor = { ownerUserId, actorUserId: ownerUserId, authority: 'owner_session' as const, role: 'owner' as const, principal: `owner-${ownerUserId}@managed.invalid` }
  const spec = buildSiteSpec({ draftIdentity: key, brandName: `Existing ${key}`, audience: 'Existing-site buyers', brief: 'An existing customer site requiring ownership verification.', businessGoals: ['improve_search_ai_understanding'], siteType: 'brand_blog', selectedModules: ['managed_content_admin', 'geo_content_subscription', 'geo_measurement_dashboard'], styleReferences: [] }, new Date('2026-08-27T00:00:00.000Z'))
  const project = await createManagedSiteProject(ownerUserId, actor, { canonicalClientIdentity: `Existing ${key}`, canonicalWebsiteIdentity: website, siteType: 'brand_blog', idempotencyKey: `${key}-project` }, managed.repository)
  const version = await createManagedSiteVersion(ownerUserId, project.project.id, actor, { siteSpecSnapshot: spec, designTokenSnapshot: spec.designTokens, selectedModuleSnapshot: spec.selectedModules, contentFingerprint: stableFingerprint(spec), createdByAuthority: 'owner_session', lifecycleStatus: 'active' }, managed.repository)
  await managed.repository.insertSubscription({ ownerUserId, projectId: project.project.id, planKey: 'basic', status: 'active', subscriptionReference: `verified-payment:${key}`, gracePeriodEndsAt: null, termEndsAt: new Date('2027-08-27T00:00:00.000Z'), idempotencyKey: `${key}-subscription`, stateFingerprint: stableFingerprint({ projectId: project.project.id, status: 'active' }) } as any)
  await managed.repository.updateProject(ownerUserId, project.project.id, { status: 'active', activeVersionId: version.version.id } as any)
  return { project: (await managed.repository.findProject(ownerUserId, project.project.id))!, version: version.version }
}

describe('managed-site existing-site path and tenant isolation', () => {
  it('requires verified ownership before canonical GEO activation and blocks cross-owner/project domain attacks', async () => {
    const managed = createManagedSiteMemoryRepository()
    const live = createLiveConnectorMemoryRepository()
    await configureManagedSiteProvider(1, { capability: 'dns_tls', providerKey: 'mock-dns-tls', readinessStatus: 'mock', credentialReference: null, transportConfiguration: {}, idempotencyKey: 'owner1-dns-config' }, live.repository)
    await configureManagedSiteProvider(2, { capability: 'dns_tls', providerKey: 'mock-dns-tls', readinessStatus: 'mock', credentialReference: null, transportConfiguration: {}, idempotencyKey: 'owner2-dns-config' }, live.repository)
    const first = await projectFor(1, 'existing-one', 'https://existing-one.acme.taipei', managed)
    const second = await projectFor(1, 'existing-two', 'https://existing-one.acme.taipei/alternate', managed)
    const otherOwner = await projectFor(2, 'existing-other-owner', 'https://other-owner.acme.taipei', managed)
    const release = await createExistingSiteRelease(1, { projectId: first.project.id, canonicalDomain: 'existing-one.acme.taipei', targetKey: 'existing-primary', idempotencyKey: 'existing-release-001' }, { repository: live.repository, managedRepository: managed.repository })
    await expect(activateManagedSiteGeoOperations(1, { releaseId: release.release.id, timeZone: 'Asia/Taipei', cadenceDays: 7, monthlyBudgetUnits: 10, idempotencyKey: 'geo-before-ownership' }, { repository: live.repository, managedRepository: managed.repository, activate: (async () => ({ client: { id: 1 } })) as any })).rejects.toMatchObject({ statusCode: 409 })
    const verified = await verifyExistingSiteOwnership(1, { releaseId: release.release.id, challengeReference: 'dns-challenge-existing-one', executionMode: 'mocked', idempotencyKey: 'ownership-verify-001' }, createMockExistingSiteOwnershipAdapter(), { repository: live.repository, clock: () => new Date('2026-08-27T00:00:00.000Z') })
    expect(verified.release?.status).toBe('live_verified')
    await expect(verifyExistingSiteOwnership(2, { releaseId: release.release.id, challengeReference: 'cross-owner-challenge', executionMode: 'mocked', idempotencyKey: 'cross-owner-verify' }, createMockExistingSiteOwnershipAdapter(), { repository: live.repository })).rejects.toMatchObject({ statusCode: 409 })
    const conflicting = await createExistingSiteRelease(1, { projectId: second.project.id, canonicalDomain: 'existing-one.acme.taipei', targetKey: 'existing-conflict', idempotencyKey: 'existing-release-conflict' }, { repository: live.repository, managedRepository: managed.repository })
    await expect(verifyExistingSiteOwnership(1, { releaseId: conflicting.release.id, challengeReference: 'dns-challenge-conflict', executionMode: 'mocked', idempotencyKey: 'ownership-conflict' }, createMockExistingSiteOwnershipAdapter(), { repository: live.repository })).rejects.toMatchObject({ statusCode: 409 })
    const otherRelease = await createExistingSiteRelease(2, { projectId: otherOwner.project.id, canonicalDomain: 'other-owner.acme.taipei', targetKey: 'other-owner-primary', idempotencyKey: 'other-owner-release' }, { repository: live.repository, managedRepository: managed.repository })
    await expect(activateManagedSiteGeoOperations(1, { releaseId: otherRelease.release.id, timeZone: 'Asia/Taipei', cadenceDays: 7, monthlyBudgetUnits: 10, idempotencyKey: 'cross-owner-activation' }, { repository: live.repository, managedRepository: managed.repository, activate: (async () => ({ client: { id: 2 } })) as any })).rejects.toMatchObject({ statusCode: 409 })
    const activated = await activateManagedSiteGeoOperations(1, { releaseId: release.release.id, timeZone: 'Asia/Taipei', cadenceDays: 7, monthlyBudgetUnits: 10, idempotencyKey: 'geo-after-ownership' }, { repository: live.repository, managedRepository: managed.repository, clock: () => new Date('2026-08-27T00:01:00.000Z'), activate: (async (owner: number, projectId: number, _input: unknown, managedRepository: any) => { await managedRepository.updateProject(owner, projectId, { contentOperationClientId: 601 } as any); return { client: { id: 601 }, linked: true, reused: true, notDuplicated: true } }) as any })
    expect(activated.release?.status).toBe('geo_active')
    expect(activated.receipt.metadata).toMatchObject({ measurementStartsAfterVerifiedLiveSite: true, reusedCanonicalContentOperations: true })
  })

  it('canonicalizes IDNA and rejects public suffixes, credentials, IPs, special-use, and mixed-script homographs', () => {
    expect(canonicalizeManagedDomain('例子.台灣').canonicalDomain).toBe('xn--fsqu00a.xn--kpry57d')
    expect(() => canonicalizeManagedDomain('co.uk')).toThrow()
    expect(() => canonicalizeManagedDomain('https://user:pass@example.com')).toThrow()
    expect(() => canonicalizeManagedDomain('127.0.0.1')).toThrow()
    expect(() => canonicalizeManagedDomain('localhost')).toThrow()
    expect(() => canonicalizeManagedDomain('pаypal.com')).toThrow() // Cyrillic "a" mixed with Latin.
  })
})

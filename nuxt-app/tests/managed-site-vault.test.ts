import { describe, expect, it } from 'vitest'
import { createManagedSiteMemoryRepository } from './fixtures/managed-site/repository'
import {
  acceptManagedSiteInvitation,
  createManagedSiteProject,
  createManagedSiteVersion,
  exportManagedSiteCustomerData,
  getManagedSiteCustomerProjection,
  getManagedSiteCustomerSession,
  inviteManagedSiteMember,
  listManagedSiteAuditEvents,
  listManagedSiteMembers,
  revokeManagedSiteMember,
  setManagedSiteSubscriptionStatus,
  updateManagedSiteMemberRole,
} from '../server/managed-sites/service'
import { stableFingerprint } from '../server/seo-geo-core/repository'
import { buildSiteSpec } from '../server/managed-sites/site-spec'

const ownerActor = (ownerUserId: number) => ({ ownerUserId, actorUserId: ownerUserId, authority: 'owner_session' as const, role: 'owner' as const, principal: `owner-${ownerUserId}@acme.taipei` })

async function makeProject(ownerUserId = 1) {
  const test = createManagedSiteMemoryRepository()
  const result = await createManagedSiteProject(ownerUserId, ownerActor(ownerUserId), { canonicalClientIdentity: `client-${ownerUserId}`, canonicalWebsiteIdentity: `https://client-${ownerUserId}.acme.taipei`, siteType: 'brand_blog', idempotencyKey: `project-key-${ownerUserId}` }, test.repository)
  return { ...test, project: result.project }
}

describe('managed site project vault', () => {
  it('creates an owner-scoped project and replays idempotently without a duplicate membership', async () => {
    const test = createManagedSiteMemoryRepository()
    const first = await createManagedSiteProject(1, ownerActor(1), { canonicalClientIdentity: 'acme', canonicalWebsiteIdentity: 'https://acme.acme.taipei', siteType: 'one_page', idempotencyKey: 'project-acme-1' }, test.repository)
    const replay = await createManagedSiteProject(1, ownerActor(1), { canonicalClientIdentity: 'acme', canonicalWebsiteIdentity: 'https://acme.acme.taipei', siteType: 'one_page', idempotencyKey: 'project-acme-1' }, test.repository)
    expect(first.replayed).toBe(false)
    expect(replay.replayed).toBe(true)
    expect(test.state.projects).toHaveLength(1)
    expect(test.state.memberships.filter(row => row.projectId === first.project.id)).toHaveLength(1)
    expect(test.state.audits.map(row => row.action)).toEqual(['managed_site_project_created', 'managed_site_owner_membership_created'])
  })

  it('isolates owners and rejects access to another owner project', async () => {
    const test = createManagedSiteMemoryRepository()
    const first = await createManagedSiteProject(1, ownerActor(1), { canonicalClientIdentity: 'client-one', canonicalWebsiteIdentity: 'https://client-one.acme.taipei', siteType: 'brand_blog', idempotencyKey: 'project-one-1' }, test.repository)
    const second = await createManagedSiteProject(2, ownerActor(2), { canonicalClientIdentity: 'client-two', canonicalWebsiteIdentity: 'https://client-two.acme.taipei', siteType: 'brand_blog', idempotencyKey: 'project-two-1' }, test.repository)
    await expect(listManagedSiteMembers(1, second.project.id, ownerActor(1), test.repository)).rejects.toMatchObject({ statusCode: 404 })
    expect(test.state.projects).toHaveLength(2)
    expect(first.project.ownerUserId).not.toBe(second.project.ownerUserId)
  })

  it('creates immutable version lineage and never includes source code in customer export', async () => {
    const test = await makeProject(1)
    const siteSpec = buildSiteSpec({ draftIdentity: 'vault-version-001', brandName: 'Vault Client', audience: 'Taiwan customers', brief: 'A canonical version fixture.', businessGoals: ['increase_inquiries'], siteType: 'brand_blog', selectedModules: ['managed_content_admin', 'geo_content_subscription'], styleReferences: [] }, new Date('2026-08-27T00:00:00.000Z'))
    const versionResult = await createManagedSiteVersion(1, test.project.id, ownerActor(1), { siteSpecSnapshot: siteSpec, designTokenSnapshot: siteSpec.designTokens, selectedModuleSnapshot: siteSpec.selectedModules, contentFingerprint: stableFingerprint({ content: 'owned' }), createdByAuthority: 'owner_session', lifecycleStatus: 'preview' }, test.repository)
    const invitation = await inviteManagedSiteMember(1, test.project.id, ownerActor(1), { email: 'editor@acme.taipei', role: 'editor', idempotencyKey: 'invite-editor-1' }, test.repository)
    const accepted = await acceptManagedSiteInvitation(invitation.invitationToken!, test.repository)
    const projection = await getManagedSiteCustomerProjection(accepted.sessionToken, test.repository)
    const exported = await exportManagedSiteCustomerData(accepted.sessionToken, test.repository)
    expect(versionResult.version?.version).toBe(1)
    expect(projection.membership.role).toBe('editor')
    expect(projection.versions[0]?.lifecycleStatus).toBe('preview')
    expect(projection.capabilities.sourceCodeExport).toBe(false)
    expect(exported.sourceCode).toBeNull()
    expect(exported.secrets).toBeNull()
    expect(exported.otherTenants).toBeNull()
    expect(exported.versions).toEqual([siteSpec])
  })

  it('uses fixed roles, prevents owner downgrade, and records changes and revocation', async () => {
    const test = await makeProject(1)
    const invitation = await inviteManagedSiteMember(1, test.project.id, ownerActor(1), { email: 'reviewer@acme.taipei', role: 'reviewer', idempotencyKey: 'invite-reviewer-1' }, test.repository)
    const memberId = test.state.memberships.find(row => row.principalEmail === 'reviewer@acme.taipei')!.id
    const changed = await updateManagedSiteMemberRole(1, test.project.id, memberId, ownerActor(1), { role: 'analyst', idempotencyKey: 'role-change-reviewer-1' }, test.repository)
    const revoked = await revokeManagedSiteMember(1, test.project.id, memberId, ownerActor(1), 'revoke-reviewer-1', test.repository)
    expect(changed.membership.role).toBe('analyst')
    expect(revoked.membership.status).toBe('revoked')
    await expect(updateManagedSiteMemberRole(1, test.project.id, test.state.memberships.find(row => row.role === 'owner')!.id, ownerActor(1), { role: 'editor', idempotencyKey: 'owner-downgrade-1' }, test.repository)).rejects.toMatchObject({ statusCode: 403 })
    expect(test.state.audits.map(row => row.action)).toContain('managed_site_membership_role_changed')
    expect(test.state.audits.map(row => row.action)).toContain('managed_site_membership_revoked')
    expect(invitation.invitationToken).toBeTruthy()
  })

  it('fails closed for expired invitations and invitation replay', async () => {
    const test = await makeProject(1)
    const invitation = await inviteManagedSiteMember(1, test.project.id, ownerActor(1), { email: 'admin@acme.taipei', role: 'administrator', idempotencyKey: 'invite-admin-1' }, test.repository)
    const accepted = await acceptManagedSiteInvitation(invitation.invitationToken!, test.repository)
    expect(accepted.project.id).toBe(test.project.id)
    await expect(acceptManagedSiteInvitation(invitation.invitationToken!, test.repository)).rejects.toMatchObject({ statusCode: 404 })
    const expired = await inviteManagedSiteMember(1, test.project.id, ownerActor(1), { email: 'expired@acme.taipei', role: 'analyst', idempotencyKey: 'invite-expired-1' }, test.repository)
    const row = test.state.invitations.find(item => item.id === expired.invitation.id)!
    row.expiresAt = new Date(Date.now() - 1)
    await expect(acceptManagedSiteInvitation(expired.invitationToken!, test.repository)).rejects.toMatchObject({ statusCode: 404 })
  })

  it('keeps audit and subscription lifecycle owner-scoped and never deletes data on suspension', async () => {
    const test = await makeProject(1)
    const subscription = await test.repository.insertSubscription({ ownerUserId: 1, projectId: test.project.id, planKey: 'geo-growth', status: 'active', subscriptionReference: null, gracePeriodEndsAt: null, termEndsAt: null, idempotencyKey: 'subscription-1', stateFingerprint: stableFingerprint({ projectId: test.project.id, status: 'active' }) })
    const result = await setManagedSiteSubscriptionStatus(1, test.project.id, ownerActor(1), 'past_due', test.repository)
    expect(result.subscription.status).toBe('past_due')
    const suspended = await setManagedSiteSubscriptionStatus(1, test.project.id, ownerActor(1), 'grace_period', test.repository)
    expect(suspended.subscription.status).toBe('grace_period')
    expect(test.state.projects).toHaveLength(1)
    expect(test.state.versions).toHaveLength(0)
    expect(subscription.id).toBeGreaterThan(0)
    expect(await listManagedSiteAuditEvents(1, test.project.id, ownerActor(1), test.repository)).toHaveLength(4)
    await expect(listManagedSiteAuditEvents(2, test.project.id, ownerActor(2), test.repository)).rejects.toMatchObject({ statusCode: 404 })
  })
})


describe('managed site customer authorization races', () => {
  it('creates exactly one session when the same invitation is accepted concurrently', async () => {
    const test = await makeProject(1)
    const invitation = await inviteManagedSiteMember(1, test.project.id, ownerActor(1), { email: 'race@acme.taipei', role: 'editor', idempotencyKey: 'invite-race-001' }, test.repository)
    const results = await Promise.allSettled([
      acceptManagedSiteInvitation(invitation.invitationToken!, test.repository),
      acceptManagedSiteInvitation(invitation.invitationToken!, test.repository),
    ])
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1)
    expect(test.state.sessions).toHaveLength(1)
    expect(test.state.invitations.filter(row => row.status === 'accepted')).toHaveLength(1)
    expect(test.state.memberships.filter(row => row.principalEmail === 'race@acme.taipei' && row.acceptedAt)).toHaveLength(1)
  })
})


describe('managed site lifecycle invalidation', () => {
  it('revokes an accepted customer session immediately after a role change', async () => {
    const test = await makeProject(1)
    const invitation = await inviteManagedSiteMember(1, test.project.id, ownerActor(1), { email: 'session-role@acme.taipei', role: 'editor', idempotencyKey: 'invite-session-role-001' }, test.repository)
    const accepted = await acceptManagedSiteInvitation(invitation.invitationToken!, test.repository)
    expect(await getManagedSiteCustomerSession(accepted.sessionToken, test.repository)).not.toBeNull()
    const membershipId = test.state.memberships.find(row => row.principalEmail === 'session-role@acme.taipei')!.id
    await updateManagedSiteMemberRole(1, test.project.id, membershipId, ownerActor(1), { role: 'analyst', idempotencyKey: 'role-session-role-001' }, test.repository)
    expect(test.state.sessions[0]?.revokedAt).toBeInstanceOf(Date)
    expect(await getManagedSiteCustomerSession(accepted.sessionToken, test.repository)).toBeNull()
  })

  it('maps terminated subscription to suspended project state and revokes customer sessions', async () => {
    const test = await makeProject(1)
    const subscription = await test.repository.insertSubscription({ ownerUserId: 1, projectId: test.project.id, planKey: 'geo-growth', status: 'active', subscriptionReference: null, gracePeriodEndsAt: null, termEndsAt: null, idempotencyKey: 'subscription-termination-001', stateFingerprint: stableFingerprint({ projectId: test.project.id, status: 'active' }) })
    const invitation = await inviteManagedSiteMember(1, test.project.id, ownerActor(1), { email: 'session-termination@acme.taipei', role: 'editor', idempotencyKey: 'invite-session-termination-001' }, test.repository)
    const accepted = await acceptManagedSiteInvitation(invitation.invitationToken!, test.repository)
    const result = await setManagedSiteSubscriptionStatus(1, test.project.id, ownerActor(1), 'terminated', test.repository)
    expect(result.subscription.status).toBe('terminated')
    expect(test.state.projects.find(row => row.id === test.project.id)?.status).toBe('suspended')
    expect(test.state.sessions[0]?.revokedAt).toBeInstanceOf(Date)
    expect(await getManagedSiteCustomerSession(accepted.sessionToken, test.repository)).toBeNull()
    expect(subscription.id).toBeGreaterThan(0)
  })
})


describe('managed site version authority', () => {
  it('rejects mismatched design/module snapshots and stale SiteSpec fingerprints', async () => {
    const test = await makeProject(1)
    const siteSpec = buildSiteSpec({ draftIdentity: 'version-authority-001', brandName: 'Version Client', audience: 'Taiwan customers', brief: 'Version authority fixture.', businessGoals: ['increase_inquiries'], siteType: 'brand_blog', selectedModules: ['managed_content_admin'], styleReferences: [] }, new Date('2026-08-27T00:00:00.000Z'))
    await expect(createManagedSiteVersion(1, test.project.id, ownerActor(1), { siteSpecSnapshot: siteSpec, designTokenSnapshot: { wrong: true }, selectedModuleSnapshot: siteSpec.selectedModules, contentFingerprint: 'a'.repeat(64), createdByAuthority: 'owner_session', lifecycleStatus: 'preview' }, test.repository)).rejects.toMatchObject({ statusCode: 409 })
    await expect(createManagedSiteVersion(1, test.project.id, ownerActor(1), { siteSpecSnapshot: { ...siteSpec, deterministicFingerprint: 'b'.repeat(64) }, designTokenSnapshot: siteSpec.designTokens, selectedModuleSnapshot: siteSpec.selectedModules, contentFingerprint: 'a'.repeat(64), createdByAuthority: 'owner_session', lifecycleStatus: 'preview' }, test.repository)).rejects.toMatchObject({ statusCode: 422 })
    await expect(createManagedSiteVersion(2, test.project.id, ownerActor(1), { siteSpecSnapshot: siteSpec, designTokenSnapshot: siteSpec.designTokens, selectedModuleSnapshot: siteSpec.selectedModules, contentFingerprint: 'a'.repeat(64), createdByAuthority: 'owner_session', lifecycleStatus: 'preview' }, test.repository)).rejects.toMatchObject({ statusCode: 404 })
  })

  it('supersedes the prior active version and only active lifecycle updates project authority', async () => {
    const test = await makeProject(1)
    const firstSpec = buildSiteSpec({ draftIdentity: 'version-active-001', brandName: 'Active Client', audience: 'Taiwan customers', brief: 'First active fixture.', businessGoals: ['increase_inquiries'], siteType: 'brand_blog', selectedModules: ['managed_content_admin'], styleReferences: [] }, new Date('2026-08-27T00:00:00.000Z'))
    const first = await createManagedSiteVersion(1, test.project.id, ownerActor(1), { siteSpecSnapshot: firstSpec, designTokenSnapshot: firstSpec.designTokens, selectedModuleSnapshot: firstSpec.selectedModules, contentFingerprint: 'c'.repeat(64), createdByAuthority: 'owner_session', lifecycleStatus: 'active' }, test.repository)
    const secondSpec = buildSiteSpec({ draftIdentity: 'version-active-002', brandName: 'Active Client', audience: 'Taiwan customers', brief: 'Second preview fixture.', businessGoals: ['increase_inquiries'], siteType: 'brand_blog', selectedModules: ['managed_content_admin'], styleReferences: [] }, new Date('2026-08-27T00:00:00.000Z'))
    const second = await createManagedSiteVersion(1, test.project.id, ownerActor(1), { siteSpecSnapshot: secondSpec, designTokenSnapshot: secondSpec.designTokens, selectedModuleSnapshot: secondSpec.selectedModules, contentFingerprint: 'd'.repeat(64), createdByAuthority: 'owner_session', lifecycleStatus: 'preview' }, test.repository)
    expect(test.state.projects.find(project => project.id === test.project.id)?.activeVersionId).toBe(first.version!.id)
    expect(test.state.versions.find(version => version.id === first.version!.id)?.lifecycleStatus).toBe('active')
    expect(second.version?.lifecycleStatus).toBe('preview')
    const thirdSpec = buildSiteSpec({ draftIdentity: 'version-active-003', brandName: 'Active Client', audience: 'Taiwan customers', brief: 'Third active fixture.', businessGoals: ['increase_inquiries'], siteType: 'brand_blog', selectedModules: ['managed_content_admin'], styleReferences: [] }, new Date('2026-08-27T00:00:00.000Z'))
    const third = await createManagedSiteVersion(1, test.project.id, ownerActor(1), { siteSpecSnapshot: thirdSpec, designTokenSnapshot: thirdSpec.designTokens, selectedModuleSnapshot: thirdSpec.selectedModules, contentFingerprint: 'e'.repeat(64), createdByAuthority: 'owner_session', lifecycleStatus: 'active' }, test.repository)
    expect(test.state.projects.find(project => project.id === test.project.id)?.activeVersionId).toBe(third.version!.id)
    expect(test.state.versions.find(version => version.id === first.version!.id)?.lifecycleStatus).toBe('superseded')
    expect(test.state.versions.filter(version => version.lifecycleStatus === 'active')).toHaveLength(1)
  })
})

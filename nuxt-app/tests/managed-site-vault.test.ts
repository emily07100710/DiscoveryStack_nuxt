import { describe, expect, it } from 'vitest'
import { createManagedSiteMemoryRepository } from './fixtures/managed-site/repository'
import {
  acceptManagedSiteInvitation,
  createManagedSiteProject,
  createManagedSiteVersion,
  exportManagedSiteCustomerData,
  getManagedSiteCustomerProjection,
  inviteManagedSiteMember,
  listManagedSiteAuditEvents,
  listManagedSiteMembers,
  revokeManagedSiteMember,
  setManagedSiteSubscriptionStatus,
  updateManagedSiteMemberRole,
} from '../server/managed-sites/service'
import { stableFingerprint } from '../server/seo-geo-core/repository'

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
    const versionResult = await createManagedSiteVersion(1, test.project.id, ownerActor(1), { siteSpecSnapshot: { schemaVersion: 'site-spec-v1', pages: ['home'] }, designTokenSnapshot: { colorPrimary: '#123456' }, selectedModuleSnapshot: { managed_content_admin: true }, contentFingerprint: stableFingerprint({ content: 'owned' }), createdByAuthority: 'owner_session', lifecycleStatus: 'preview' }, test.repository)
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
    expect(exported.versions).toEqual([{ schemaVersion: 'site-spec-v1', pages: ['home'] }])
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

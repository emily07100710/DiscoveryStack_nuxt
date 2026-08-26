import { randomBytes } from 'node:crypto'
import { createError } from 'h3'
import { stableFingerprint } from '../seo-geo-core/repository'
import { getManagedSiteRepository } from './repository'
import {
  eventFingerprint,
  normalizeRecipientEmail,
  parseManagedSiteMemberInput,
  parseManagedSiteProjectInput,
  parseManagedSiteRoleUpdate,
  tokenHash,
} from './normalization'
import {
  MANAGED_SITE_CATALOG_VERSION,
  MANAGED_SITE_INVITATION_TTL_MS,
  MANAGED_SITE_ROLES,
  MANAGED_SITE_SESSION_TTL_MS,
  MANAGED_SITE_TYPES,
  roleAllows,
  type ManagedSiteActor,
  type ManagedSiteCustomerProjection,
  type ManagedSiteDataExport,
  type ManagedSiteMemberInput,
  type ManagedSiteProjectInput,
  type ManagedSiteProjectProjection,
  type ManagedSiteRepository,
  type ManagedSiteRole,
  type ManagedSiteRoleUpdate,
  type ManagedSiteSubscriptionStatus,
} from './types'

function now(): Date {
  return new Date()
}

function ensureActorRole(actor: ManagedSiteActor, permission: string) {
  if (!actor.role || !roleAllows(actor.role, permission)) throw createError({ statusCode: 403, statusMessage: 'This managed site action is not permitted.' })
}

function projectNotFound(): never {
  throw createError({ statusCode: 404, statusMessage: 'Managed site project was not found.' })
}

function memberNotFound(): never {
  throw createError({ statusCode: 404, statusMessage: 'Managed site member was not found.' })
}

function invitationNotFound(): never {
  throw createError({ statusCode: 404, statusMessage: 'Managed site invitation is invalid or expired.' })
}

function normalizeProject(input: ManagedSiteProjectInput) {
  const parsed = parseManagedSiteProjectInput(input)
  if (!(MANAGED_SITE_TYPES as readonly string[]).includes(parsed.siteType)) throw createError({ statusCode: 422, statusMessage: 'Managed site type is not available in V1.' })
  return parsed
}

function projectProjection(project: any, versions: any[], memberships: any[], subscription: any): ManagedSiteProjectProjection {
  return {
    id: project.id,
    ownerUserId: project.ownerUserId,
    canonicalClientIdentity: project.canonicalClientIdentity,
    canonicalWebsiteIdentity: project.canonicalWebsiteIdentity,
    contentOperationClientId: project.contentOperationClientId,
    status: project.status,
    siteType: project.siteType,
    activeVersionId: project.activeVersionId,
    catalogVersion: project.catalogVersion,
    subscriptionReference: project.subscriptionReference,
    projectFingerprint: project.projectFingerprint,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
    membershipCount: memberships.filter(item => item.status === 'active').length,
    activeVersion: versions.find(item => item.id === project.activeVersionId) || null,
    subscription: subscription || null,
  }
}

async function appendAudit(repository: ManagedSiteRepository, input: {
  ownerUserId: number
  projectId: number
  actorUserId?: number | null
  authority: ManagedSiteActor['authority']
  action: string
  beforeFingerprint?: string | null
  afterFingerprint?: string | null
  idempotencyKey: string
  metadata?: Record<string, unknown>
}) {
  const beforeFingerprint = input.beforeFingerprint || null
  const afterFingerprint = input.afterFingerprint || null
  return repository.insertAuditEvent({
    ownerUserId: input.ownerUserId,
    projectId: input.projectId,
    actorUserId: input.actorUserId ?? null,
    authority: input.authority,
    action: input.action,
    beforeFingerprint,
    afterFingerprint,
    eventFingerprint: eventFingerprint(input.ownerUserId, input.projectId, input.action, input.idempotencyKey, beforeFingerprint, afterFingerprint),
    metadata: input.metadata || {},
  })
}

export async function createManagedSiteProject(ownerUserId: number, actor: ManagedSiteActor, input: unknown, repository = getManagedSiteRepository()): Promise<{ project: ManagedSiteProjectProjection; ownerMembership: unknown; replayed: boolean }> {
  ensureActorRole(actor, 'project:write')
  const parsed = normalizeProject(input as ManagedSiteProjectInput)
  const fingerprint = stableFingerprint({ ownerUserId, ...parsed, catalogVersion: MANAGED_SITE_CATALOG_VERSION })
  const existingByIdempotency = await repository.findProjectByIdempotency(ownerUserId, parsed.idempotencyKey)
  if (existingByIdempotency && existingByIdempotency.projectFingerprint !== fingerprint) throw createError({ statusCode: 409, statusMessage: 'Project idempotency key is already associated with a different request.' })
  const existing = existingByIdempotency || await repository.findProjectByFingerprint(ownerUserId, fingerprint)
  if (existing) {
    const [versions, memberships, subscription] = await Promise.all([
      repository.listVersions(ownerUserId, existing.id),
      repository.listMemberships(ownerUserId, existing.id),
      repository.findSubscription(ownerUserId, existing.id),
    ])
    return { project: projectProjection(existing, versions, memberships, subscription), ownerMembership: memberships.find(item => item.role === 'owner') || null, replayed: true }
  }
  const duplicateClient = await repository.findProjectByClientIdentity(ownerUserId, parsed.canonicalClientIdentity)
  if (duplicateClient) throw createError({ statusCode: 409, statusMessage: 'A managed site project already exists for this client identity.' })
  return repository.transaction(async (transaction) => {
    const createdAt = now()
    const project = await transaction.insertProject({
      ownerUserId,
      canonicalClientIdentity: parsed.canonicalClientIdentity,
      canonicalWebsiteIdentity: parsed.canonicalWebsiteIdentity,
      contentOperationClientId: null,
      status: 'draft',
      siteType: parsed.siteType,
      activeVersionId: null,
      catalogVersion: MANAGED_SITE_CATALOG_VERSION,
       subscriptionReference: null,
       projectFingerprint: fingerprint,
       creationIdempotencyKey: parsed.idempotencyKey,
       createdAt,
    } as any)
    const membership = await transaction.insertMembership({
      ownerUserId,
      projectId: project.id,
      principalEmail: actor.principal || `owner-${ownerUserId}@internal.invalid`,
      userId: actor.actorUserId ?? null,
      role: 'owner',
      status: 'active',
      invitedAt: createdAt,
      acceptedAt: createdAt,
      revokedAt: null,
      updatedAt: createdAt,
    } as any)
    await appendAudit(transaction, {
      ownerUserId,
      projectId: project.id,
      actorUserId: actor.actorUserId ?? null,
      authority: actor.authority,
      action: 'managed_site_project_created',
      beforeFingerprint: null,
      afterFingerprint: project.projectFingerprint,
      idempotencyKey: parsed.idempotencyKey,
      metadata: { siteType: project.siteType, catalogVersion: project.catalogVersion },
    })
    await appendAudit(transaction, {
      ownerUserId,
      projectId: project.id,
      actorUserId: actor.actorUserId ?? null,
      authority: actor.authority,
      action: 'managed_site_owner_membership_created',
      beforeFingerprint: null,
      afterFingerprint: stableFingerprint({ projectId: project.id, membershipId: membership.id, role: membership.role }),
      idempotencyKey: `${parsed.idempotencyKey}:owner-membership`,
      metadata: { membershipId: membership.id, role: membership.role },
    })
    const [versions, memberships, subscription] = await Promise.all([
      transaction.listVersions(ownerUserId, project.id),
      transaction.listMemberships(ownerUserId, project.id),
      transaction.findSubscription(ownerUserId, project.id),
    ])
    return { project: projectProjection(project, versions, memberships, subscription), ownerMembership: membership, replayed: false }
  })
}

export async function listOwnerManagedSites(ownerUserId: number, repository = getManagedSiteRepository()): Promise<ManagedSiteProjectProjection[]> {
  const projects = await repository.listProjects(ownerUserId)
  return Promise.all(projects.map(async project => {
    const [versions, memberships, subscription] = await Promise.all([
      repository.listVersions(ownerUserId, project.id),
      repository.listMemberships(ownerUserId, project.id),
      repository.findSubscription(ownerUserId, project.id),
    ])
    return projectProjection(project, versions, memberships, subscription)
  }))
}

export async function getOwnerManagedSite(ownerUserId: number, projectId: number, repository = getManagedSiteRepository()): Promise<ManagedSiteProjectProjection> {
  const project = await repository.findProject(ownerUserId, projectId)
  if (!project) projectNotFound()
  const [versions, memberships, subscription] = await Promise.all([
    repository.listVersions(ownerUserId, project.id),
    repository.listMemberships(ownerUserId, project.id),
    repository.findSubscription(ownerUserId, project.id),
  ])
  return projectProjection(project, versions, memberships, subscription)
}

export async function createManagedSiteVersion(ownerUserId: number, projectId: number, actor: ManagedSiteActor, input: { siteSpecSnapshot: unknown; designTokenSnapshot: unknown; selectedModuleSnapshot: unknown; contentFingerprint: string; createdByAuthority: string; lifecycleStatus?: 'draft' | 'preview' | 'active' | 'superseded' | 'archived' }, repository = getManagedSiteRepository()) {
  ensureActorRole(actor, 'project:write')
  const project = await repository.findProject(ownerUserId, projectId)
  if (!project) projectNotFound()
  const versions = await repository.listVersions(ownerUserId, projectId)
  const nextVersion = (versions[0]?.version || 0) + 1
  const snapshot = { siteSpecSnapshot: input.siteSpecSnapshot, designTokenSnapshot: input.designTokenSnapshot, selectedModuleSnapshot: input.selectedModuleSnapshot }
  const fingerprint = stableFingerprint({ projectId, version: nextVersion, snapshot, contentFingerprint: input.contentFingerprint })
  if (versions.some(version => version.versionFingerprint === fingerprint)) return { version: versions.find(version => version.versionFingerprint === fingerprint), replayed: true }
  return repository.transaction(async transaction => {
    const createdAt = now()
    const version = await transaction.insertVersion({
      ownerUserId,
      projectId,
      version: nextVersion,
      siteSpecSnapshot: input.siteSpecSnapshot,
      designTokenSnapshot: input.designTokenSnapshot,
      selectedModuleSnapshot: input.selectedModuleSnapshot,
      contentFingerprint: input.contentFingerprint,
      parentVersionId: versions[0]?.id || null,
      lifecycleStatus: input.lifecycleStatus || 'draft',
      createdByAuthority: input.createdByAuthority,
      versionFingerprint: fingerprint,
      createdAt,
    } as any)
    await transaction.updateProject(ownerUserId, projectId, { activeVersionId: version.id, updatedAt: createdAt } as any)
    await appendAudit(transaction, {
      ownerUserId,
      projectId,
      actorUserId: actor.actorUserId ?? null,
      authority: actor.authority,
      action: 'managed_site_version_created',
      beforeFingerprint: versions[0]?.versionFingerprint || null,
      afterFingerprint: version.versionFingerprint,
      idempotencyKey: `version:${fingerprint}`,
      metadata: { versionId: version.id, version: version.version, lifecycleStatus: version.lifecycleStatus },
    })
    return { version, replayed: false }
  })
}

export async function inviteManagedSiteMember(ownerUserId: number, projectId: number, actor: ManagedSiteActor, input: unknown, repository = getManagedSiteRepository()) {
  ensureActorRole(actor, 'members:manage')
  const parsed = parseManagedSiteMemberInput(input)
  const project = await repository.findProject(ownerUserId, projectId)
  if (!project) projectNotFound()
  const existingMembership = await repository.findMembershipByEmail(ownerUserId, projectId, parsed.email)
  if (existingMembership?.role === 'owner') throw createError({ statusCode: 409, statusMessage: 'The project owner cannot be invited as another role.' })
  const invitations = await repository.listInvitations(ownerUserId, projectId)
  const replay = invitations.find(invitation => invitation.recipientEmail === parsed.email && invitation.status === 'pending' && invitation.expiresAt.getTime() > Date.now())
  if (replay) return { invitation: { id: replay.id, projectId: replay.projectId, recipientEmail: replay.recipientEmail, role: replay.role, status: replay.status, expiresAt: replay.expiresAt }, invitationToken: null, replayed: true }
  const createdAt = now()
  const expiresAt = new Date(createdAt.getTime() + MANAGED_SITE_INVITATION_TTL_MS)
  const rawToken = randomBytes(32).toString('base64url')
  return repository.transaction(async transaction => {
    const membership = existingMembership && existingMembership.status === 'revoked'
      ? await transaction.updateMembership(ownerUserId, existingMembership.id, { role: parsed.role, status: 'active', invitedAt: createdAt, acceptedAt: null, revokedAt: null, updatedAt: createdAt } as any)
      : existingMembership || await transaction.insertMembership({ ownerUserId, projectId, principalEmail: parsed.email, userId: null, role: parsed.role, status: 'active', invitedAt: createdAt, acceptedAt: null, revokedAt: null, updatedAt: createdAt } as any)
    if (!membership) memberNotFound()
    const invitation = await transaction.insertInvitation({ ownerUserId, projectId, membershipId: membership.id, recipientEmail: parsed.email, role: parsed.role, tokenHash: tokenHash(rawToken), status: 'pending', expiresAt, acceptedAt: null, revokedAt: null } as any)
    await appendAudit(transaction, {
      ownerUserId,
      projectId,
      actorUserId: actor.actorUserId ?? null,
      authority: actor.authority,
      action: 'managed_site_invitation_created',
      beforeFingerprint: null,
      afterFingerprint: stableFingerprint({ invitationId: invitation.id, membershipId: membership.id, role: membership.role }),
      idempotencyKey: parsed.idempotencyKey,
      metadata: { invitationId: invitation.id, membershipId: membership.id, role: membership.role },
    })
    return { invitation: { id: invitation.id, projectId: invitation.projectId, recipientEmail: invitation.recipientEmail, role: invitation.role, status: invitation.status, expiresAt: invitation.expiresAt }, invitationToken: rawToken, replayed: false }
  })
}

export async function listManagedSiteMembers(ownerUserId: number, projectId: number, actor: ManagedSiteActor, repository = getManagedSiteRepository()) {
  ensureActorRole(actor, 'project:read')
  const project = await repository.findProject(ownerUserId, projectId)
  if (!project) projectNotFound()
  return repository.listMemberships(ownerUserId, projectId)
}

export async function updateManagedSiteMemberRole(ownerUserId: number, projectId: number, membershipId: number, actor: ManagedSiteActor, input: unknown, repository = getManagedSiteRepository()) {
  ensureActorRole(actor, 'members:manage')
  const parsed = parseManagedSiteRoleUpdate(input)
  const project = await repository.findProject(ownerUserId, projectId)
  if (!project) projectNotFound()
  const membership = await repository.findMembership(ownerUserId, membershipId)
  if (!membership || membership.projectId !== projectId) memberNotFound()
  if (membership.role === 'owner') throw createError({ statusCode: 403, statusMessage: 'The project owner role cannot be changed.' })
  const updated = await repository.transaction(async transaction => {
    const changedAt = now()
    const next = await transaction.updateMembership(ownerUserId, membershipId, { role: parsed.role, updatedAt: changedAt } as any)
    if (!next) memberNotFound()
    await appendAudit(transaction, {
      ownerUserId,
      projectId,
      actorUserId: actor.actorUserId ?? null,
      authority: actor.authority,
      action: 'managed_site_membership_role_changed',
      beforeFingerprint: stableFingerprint({ membershipId, role: membership.role, status: membership.status }),
      afterFingerprint: stableFingerprint({ membershipId, role: next.role, status: next.status }),
      idempotencyKey: parsed.idempotencyKey,
      metadata: { membershipId, previousRole: membership.role, role: next.role },
    })
    return next
  })
  return { membership: updated, replayed: updated.role === membership.role }
}

export async function revokeManagedSiteMember(ownerUserId: number, projectId: number, membershipId: number, actor: ManagedSiteActor, idempotencyKey: string, repository = getManagedSiteRepository()) {
  ensureActorRole(actor, 'members:manage')
  if (!idempotencyKey || idempotencyKey.length > 128) throw createError({ statusCode: 422, statusMessage: 'Idempotency key is invalid.' })
  const project = await repository.findProject(ownerUserId, projectId)
  if (!project) projectNotFound()
  const membership = await repository.findMembership(ownerUserId, membershipId)
  if (!membership || membership.projectId !== projectId) memberNotFound()
  if (membership.role === 'owner') throw createError({ statusCode: 403, statusMessage: 'The project owner cannot be revoked.' })
  return repository.transaction(async transaction => {
    const changedAt = now()
    const updated = await transaction.updateMembership(ownerUserId, membershipId, { status: 'revoked', revokedAt: changedAt, updatedAt: changedAt } as any)
    if (!updated) memberNotFound()
    await appendAudit(transaction, {
      ownerUserId,
      projectId,
      actorUserId: actor.actorUserId ?? null,
      authority: actor.authority,
      action: 'managed_site_membership_revoked',
      beforeFingerprint: stableFingerprint({ membershipId, role: membership.role, status: membership.status }),
      afterFingerprint: stableFingerprint({ membershipId, role: updated.role, status: updated.status }),
      idempotencyKey,
      metadata: { membershipId, role: updated.role },
    })
    return { membership: updated, replayed: membership.status === 'revoked' }
  })
}

export async function acceptManagedSiteInvitation(rawToken: string, repository = getManagedSiteRepository()) {
  if (typeof rawToken !== 'string' || rawToken.trim().length < 32 || rawToken.length > 256) invitationNotFound()
  const invitation = await repository.findInvitationByTokenHash(tokenHash(rawToken))
  if (!invitation || invitation.status !== 'pending' || invitation.expiresAt.getTime() <= Date.now()) invitationNotFound()
  const membership = await repository.findMembership(invitation.ownerUserId, invitation.membershipId)
  const project = await repository.findProject(invitation.ownerUserId, invitation.projectId)
  if (!membership || !project || membership.projectId !== project.id || membership.status !== 'active') invitationNotFound()
  const sessionToken = randomBytes(32).toString('base64url')
  const sessionCreatedAt = now()
  const session = await repository.transaction(async transaction => {
    const acceptedAt = now()
    const updatedInvitation = await transaction.updateInvitation(invitation.ownerUserId, invitation.id, { status: 'accepted', acceptedAt } as any)
    const updatedMembership = await transaction.updateMembership(invitation.ownerUserId, membership.id, { acceptedAt, updatedAt: acceptedAt } as any)
    if (!updatedInvitation || !updatedMembership) invitationNotFound()
    const created = await transaction.insertSession({ ownerUserId: invitation.ownerUserId, projectId: invitation.projectId, membershipId: invitation.membershipId, sessionHash: tokenHash(sessionToken), expiresAt: new Date(sessionCreatedAt.getTime() + MANAGED_SITE_SESSION_TTL_MS), revokedAt: null, lastSeenAt: sessionCreatedAt } as any)
    await appendAudit(transaction, { ownerUserId: invitation.ownerUserId, projectId: invitation.projectId, actorUserId: membership.userId, authority: 'customer_session', action: 'managed_site_invitation_accepted', beforeFingerprint: stableFingerprint({ invitationId: invitation.id, status: invitation.status }), afterFingerprint: stableFingerprint({ invitationId: invitation.id, status: 'accepted', sessionId: created.id }), idempotencyKey: `accept:${invitation.id}:${created.id}`, metadata: { invitationId: invitation.id, membershipId: membership.id, sessionId: created.id } })
    return created
  })
  return { sessionToken, session, project: { id: project.id, status: project.status, siteType: project.siteType, canonicalClientIdentity: project.canonicalClientIdentity } }
}

export async function getManagedSiteCustomerSession(rawSessionToken: string, repository = getManagedSiteRepository()) {
  if (typeof rawSessionToken !== 'string' || rawSessionToken.length < 32 || rawSessionToken.length > 256) return null
  const session = await repository.findSessionByHash(tokenHash(rawSessionToken))
  if (!session || session.revokedAt || session.expiresAt.getTime() <= Date.now()) return null
  const membership = await repository.findMembership(session.ownerUserId, session.membershipId)
  const project = await repository.findProject(session.ownerUserId, session.projectId)
  if (!membership || !project || membership.projectId !== project.id || membership.status !== 'active') return null
  await repository.updateSession(session.sessionHash, { lastSeenAt: now() })
  return { session, membership, project }
}

export async function revokeManagedSiteSession(rawSessionToken: string, repository = getManagedSiteRepository()) {
  if (typeof rawSessionToken !== 'string' || rawSessionToken.length < 32 || rawSessionToken.length > 256) return false
  const updated = await repository.updateSession(tokenHash(rawSessionToken), { revokedAt: now() })
  return Boolean(updated)
}

export async function getManagedSiteCustomerProjection(rawSessionToken: string, repository = getManagedSiteRepository()): Promise<ManagedSiteCustomerProjection> {
  const access = await getManagedSiteCustomerSession(rawSessionToken, repository)
  if (!access) throw createError({ statusCode: 401, statusMessage: 'Managed site customer access requires a valid invitation session.' })
  const [versions, assets, subscription] = await Promise.all([
    repository.listVersions(access.project.ownerUserId, access.project.id),
    repository.listAssets(access.project.ownerUserId, access.project.id),
    repository.findSubscription(access.project.ownerUserId, access.project.id),
  ])
  return {
    project: {
      id: access.project.id,
      canonicalClientIdentity: access.project.canonicalClientIdentity,
      canonicalWebsiteIdentity: access.project.canonicalWebsiteIdentity,
      status: access.project.status,
      siteType: access.project.siteType,
      activeVersionId: access.project.activeVersionId,
      catalogVersion: access.project.catalogVersion,
      createdAt: access.project.createdAt,
      updatedAt: access.project.updatedAt,
    },
    membership: {
      id: access.membership.id,
      role: access.membership.role,
      status: access.membership.status,
      principalEmail: access.membership.principalEmail,
      acceptedAt: access.membership.acceptedAt,
      invitedAt: access.membership.invitedAt,
      revokedAt: access.membership.revokedAt,
    },
    versions: versions.map(version => ({ id: version.id, version: version.version, lifecycleStatus: version.lifecycleStatus, contentFingerprint: version.contentFingerprint, versionFingerprint: version.versionFingerprint, createdByAuthority: version.createdByAuthority, createdAt: version.createdAt })),
    assets: assets.map(asset => ({ id: asset.id, assetHash: asset.assetHash, mimeType: asset.mimeType, byteSize: asset.byteSize, purpose: asset.purpose, createdAt: asset.createdAt })),
    subscription: subscription ? { planKey: subscription.planKey, status: subscription.status, gracePeriodEndsAt: subscription.gracePeriodEndsAt, termEndsAt: subscription.termEndsAt, createdAt: subscription.createdAt, updatedAt: subscription.updatedAt } : null,
    capabilities: { sourceCodeExport: false, customerDataExport: true, domainOwnership: 'customer', platformSourceAccess: false },
  }
}

export async function exportManagedSiteCustomerData(rawSessionToken: string, repository = getManagedSiteRepository()): Promise<ManagedSiteDataExport> {
  const access = await getManagedSiteCustomerSession(rawSessionToken, repository)
  if (!access) throw createError({ statusCode: 401, statusMessage: 'Managed site customer access requires a valid invitation session.' })
  const projection = await getManagedSiteCustomerProjection(rawSessionToken, repository)
  const versions = await repository.listVersions(access.project.ownerUserId, access.project.id)
  return {
    exportVersion: 'managed-site-customer-export-v1',
    project: projection.project,
    membership: projection.membership,
    versions: versions.map(version => version.siteSpecSnapshot),
    assets: projection.assets,
    subscription: projection.subscription,
    sourceCode: null,
    secrets: null,
    otherTenants: null,
  }
}

const SUBSCRIPTION_TRANSITIONS: Record<ManagedSiteSubscriptionStatus, readonly ManagedSiteSubscriptionStatus[]> = {
  active: ['past_due', 'suspended', 'terminated'],
  past_due: ['active', 'grace_period', 'suspended', 'terminated'],
  grace_period: ['active', 'suspended', 'terminated'],
  suspended: ['active', 'terminated'],
  terminated: [],
}

export async function setManagedSiteSubscriptionStatus(ownerUserId: number, projectId: number, actor: ManagedSiteActor, status: ManagedSiteSubscriptionStatus, repository = getManagedSiteRepository()) {
  ensureActorRole(actor, 'billing:manage')
  const project = await repository.findProject(ownerUserId, projectId)
  if (!project) projectNotFound()
  const subscription = await repository.findSubscription(ownerUserId, projectId)
  if (!subscription) throw createError({ statusCode: 404, statusMessage: 'Managed site subscription was not found.' })
  if (subscription.status === status) return { subscription, replayed: true }
  if (!SUBSCRIPTION_TRANSITIONS[subscription.status].includes(status)) throw createError({ statusCode: 409, statusMessage: 'Managed site subscription transition is not allowed.' })
  return repository.transaction(async transaction => {
    const changedAt = now()
    const next = await transaction.updateSubscription(ownerUserId, projectId, { status, stateFingerprint: stableFingerprint({ projectId, status, changedAt: changedAt.toISOString() }), updatedAt: changedAt } as any)
    if (!next) throw createError({ statusCode: 404, statusMessage: 'Managed site subscription was not found.' })
    await transaction.updateProject(ownerUserId, projectId, { status: status === 'suspended' || status === 'terminated' ? status : project.status, updatedAt: changedAt } as any)
    await appendAudit(transaction, { ownerUserId, projectId, actorUserId: actor.actorUserId ?? null, authority: actor.authority, action: 'managed_site_subscription_status_changed', beforeFingerprint: subscription.stateFingerprint, afterFingerprint: next.stateFingerprint, idempotencyKey: `subscription:${projectId}:${status}:${changedAt.getTime()}`, metadata: { previousStatus: subscription.status, status, dataDeletion: false } })
    return { subscription: next, replayed: false }
  })
}

export async function listManagedSiteAuditEvents(ownerUserId: number, projectId: number, actor: ManagedSiteActor, repository = getManagedSiteRepository()) {
  ensureActorRole(actor, 'project:read')
  const project = await repository.findProject(ownerUserId, projectId)
  if (!project) projectNotFound()
  return repository.listAuditEvents(ownerUserId, projectId)
}

export { normalizeRecipientEmail, parseManagedSiteMemberInput, parseManagedSiteProjectInput, parseManagedSiteRoleUpdate }

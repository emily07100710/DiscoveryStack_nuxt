import type {
  ManagedSiteAsset,
  ManagedSiteAuditEvent,
  ManagedSiteInvitation,
  ManagedSiteMembership,
  ManagedSiteProject,
  ManagedSiteSession,
  ManagedSiteSubscription,
  ManagedSiteVersion,
} from '../database/schema'

export const MANAGED_SITE_CATALOG_VERSION = 'managed-site-catalog-v1'
export const MANAGED_SITE_SESSION_COOKIE = '__Host-discoverystack-managed-site-session'
export const MANAGED_SITE_SESSION_TTL_MS = 1000 * 60 * 60 * 8
export const MANAGED_SITE_INVITATION_TTL_MS = 1000 * 60 * 60 * 72

export const MANAGED_SITE_ROLES = ['owner', 'administrator', 'editor', 'reviewer', 'analyst'] as const
export type ManagedSiteRole = typeof MANAGED_SITE_ROLES[number]

export const MANAGED_SITE_TYPES = ['one_page', 'brand_blog', 'simple_commerce'] as const
export type ManagedSiteType = typeof MANAGED_SITE_TYPES[number]

export const MANAGED_SITE_PROJECT_STATUSES = [
  'draft',
  'quoted',
  'awaiting_customer_authorization',
  'payment_pending',
  'payment_verified',
  'domain_intent_created',
  'domain_purchase_pending',
  'domain_registered',
  'dns_pending',
  'dns_verified',
  'build_pending',
  'building',
  'deployment_failed',
  'deployed',
  'tls_pending',
  'active',
  'retry_wait',
  'blocked',
  'suspended',
] as const
export type ManagedSiteProjectStatus = typeof MANAGED_SITE_PROJECT_STATUSES[number]

export const MANAGED_SITE_SUBSCRIPTION_STATUSES = ['active', 'past_due', 'grace_period', 'suspended', 'terminated'] as const
export type ManagedSiteSubscriptionStatus = typeof MANAGED_SITE_SUBSCRIPTION_STATUSES[number]

export type ManagedSiteActor = {
  ownerUserId: number
  actorUserId?: number | null
  authority: 'owner_session' | 'customer_session' | 'system_test'
  role?: ManagedSiteRole
  principal?: string
}

export type ManagedSiteProjectInput = {
  canonicalClientIdentity: string
  canonicalWebsiteIdentity: string
  siteType: ManagedSiteType
  idempotencyKey: string
}

export type ManagedSiteMemberInput = {
  email: string
  role: Exclude<ManagedSiteRole, 'owner'>
  idempotencyKey: string
}

export type ManagedSiteRoleUpdate = {
  role: Exclude<ManagedSiteRole, 'owner'>
  idempotencyKey: string
}

export type ManagedSiteRepository = {
  transaction<T>(work: (repository: ManagedSiteRepository) => Promise<T>): Promise<T>
  findProject(ownerUserId: number, projectId: number): Promise<ManagedSiteProject | null>
  findProjectByClientIdentity(ownerUserId: number, canonicalClientIdentity: string): Promise<ManagedSiteProject | null>
  findProjectByFingerprint(ownerUserId: number, projectFingerprint: string): Promise<ManagedSiteProject | null>
  listProjects(ownerUserId: number): Promise<ManagedSiteProject[]>
  insertProject(input: Omit<ManagedSiteProject, 'id' | 'createdAt' | 'updatedAt'>): Promise<ManagedSiteProject>
  updateProject(ownerUserId: number, projectId: number, patch: Partial<Omit<ManagedSiteProject, 'id' | 'ownerUserId' | 'createdAt' | 'updatedAt'>>): Promise<ManagedSiteProject | null>
  findVersion(ownerUserId: number, versionId: number): Promise<ManagedSiteVersion | null>
  listVersions(ownerUserId: number, projectId: number): Promise<ManagedSiteVersion[]>
  insertVersion(input: Omit<ManagedSiteVersion, 'id' | 'createdAt'>): Promise<ManagedSiteVersion>
  findMembership(ownerUserId: number, membershipId: number): Promise<ManagedSiteMembership | null>
  findMembershipByEmail(ownerUserId: number, projectId: number, principalEmail: string): Promise<ManagedSiteMembership | null>
  listMemberships(ownerUserId: number, projectId: number): Promise<ManagedSiteMembership[]>
  insertMembership(input: Omit<ManagedSiteMembership, 'id' | 'createdAt' | 'updatedAt'>): Promise<ManagedSiteMembership>
  updateMembership(ownerUserId: number, membershipId: number, patch: Partial<Omit<ManagedSiteMembership, 'id' | 'ownerUserId' | 'projectId' | 'createdAt' | 'updatedAt'>>): Promise<ManagedSiteMembership | null>
  findInvitationByTokenHash(tokenHash: string): Promise<ManagedSiteInvitation | null>
  findInvitation(ownerUserId: number, invitationId: number): Promise<ManagedSiteInvitation | null>
  listInvitations(ownerUserId: number, projectId: number): Promise<ManagedSiteInvitation[]>
  insertInvitation(input: Omit<ManagedSiteInvitation, 'id' | 'createdAt'>): Promise<ManagedSiteInvitation>
  updateInvitation(ownerUserId: number, invitationId: number, patch: Partial<Omit<ManagedSiteInvitation, 'id' | 'ownerUserId' | 'projectId' | 'createdAt'>>): Promise<ManagedSiteInvitation | null>
  insertAsset(input: Omit<ManagedSiteAsset, 'id' | 'createdAt'>): Promise<ManagedSiteAsset>
  listAssets(ownerUserId: number, projectId: number): Promise<ManagedSiteAsset[]>
  findAuditEventByFingerprint(ownerUserId: number, eventFingerprint: string): Promise<ManagedSiteAuditEvent | null>
  insertAuditEvent(input: Omit<ManagedSiteAuditEvent, 'id' | 'occurredAt'>): Promise<ManagedSiteAuditEvent>
  listAuditEvents(ownerUserId: number, projectId: number): Promise<ManagedSiteAuditEvent[]>
  findSubscription(ownerUserId: number, projectId: number): Promise<ManagedSiteSubscription | null>
  insertSubscription(input: Omit<ManagedSiteSubscription, 'id' | 'createdAt' | 'updatedAt'>): Promise<ManagedSiteSubscription>
  updateSubscription(ownerUserId: number, projectId: number, patch: Partial<Omit<ManagedSiteSubscription, 'id' | 'ownerUserId' | 'projectId' | 'createdAt' | 'updatedAt'>>): Promise<ManagedSiteSubscription | null>
  findSessionByHash(sessionHash: string): Promise<ManagedSiteSession | null>
  insertSession(input: Omit<ManagedSiteSession, 'id' | 'createdAt'>): Promise<ManagedSiteSession>
  updateSession(sessionHash: string, patch: Partial<Pick<ManagedSiteSession, 'lastSeenAt' | 'revokedAt'>>): Promise<ManagedSiteSession | null>
}

export type ManagedSiteProjectProjection = {
  id: number
  ownerUserId: number
  canonicalClientIdentity: string
  canonicalWebsiteIdentity: string
  contentOperationClientId: number | null
  status: ManagedSiteProjectStatus
  siteType: ManagedSiteType
  activeVersionId: number | null
  catalogVersion: string
  subscriptionReference: string | null
  projectFingerprint: string
  createdAt: Date
  updatedAt: Date
  membershipCount: number
  activeVersion: ManagedSiteVersion | null
  subscription: ManagedSiteSubscription | null
}

export type ManagedSiteCustomerProjection = {
  project: Pick<ManagedSiteProject, 'id' | 'canonicalClientIdentity' | 'canonicalWebsiteIdentity' | 'status' | 'siteType' | 'activeVersionId' | 'catalogVersion' | 'createdAt' | 'updatedAt'>
  membership: Pick<ManagedSiteMembership, 'id' | 'role' | 'status' | 'principalEmail' | 'acceptedAt' | 'invitedAt' | 'revokedAt'>
  versions: Array<Pick<ManagedSiteVersion, 'id' | 'version' | 'lifecycleStatus' | 'contentFingerprint' | 'versionFingerprint' | 'createdByAuthority' | 'createdAt'>>
  assets: Array<Pick<ManagedSiteAsset, 'id' | 'assetHash' | 'mimeType' | 'byteSize' | 'purpose' | 'createdAt'>>
  subscription: Pick<ManagedSiteSubscription, 'planKey' | 'status' | 'gracePeriodEndsAt' | 'termEndsAt' | 'createdAt' | 'updatedAt'> | null
  capabilities: {
    sourceCodeExport: false
    customerDataExport: true
    domainOwnership: 'customer'
    platformSourceAccess: false
  }
}

export type ManagedSiteDataExport = {
  exportVersion: 'managed-site-customer-export-v1'
  project: ManagedSiteCustomerProjection['project']
  membership: ManagedSiteCustomerProjection['membership']
  versions: Array<ManagedSiteVersion['siteSpecSnapshot'] | Record<string, unknown>>
  assets: ManagedSiteCustomerProjection['assets']
  subscription: ManagedSiteCustomerProjection['subscription']
  sourceCode: null
  secrets: null
  otherTenants: null
}

export const MANAGED_SITE_ROLE_PERMISSIONS: Record<ManagedSiteRole, readonly string[]> = {
  owner: ['project:read', 'project:write', 'content:read', 'content:write', 'content:review', 'billing:manage', 'domain:manage', 'members:manage', 'data:export'],
  administrator: ['project:read', 'project:write', 'content:read', 'content:write', 'content:review', 'members:manage', 'data:export'],
  editor: ['project:read', 'content:read', 'content:write'],
  reviewer: ['project:read', 'content:read', 'content:review'],
  analyst: ['project:read', 'content:read'],
}

export function roleAllows(role: ManagedSiteRole, permission: string): boolean {
  return MANAGED_SITE_ROLE_PERMISSIONS[role].includes(permission)
}

import type { ManagedSiteDomainIntent, ManagedSiteProvisioningEvent, ManagedSiteProvisioningPlan, ManagedSiteProvisioningStep } from '../database/schema'

export const PROVISIONING_STEPS = ['domain_intent', 'domain_registration', 'dns_configuration', 'tls_verification', 'deployment'] as const
export type ProvisioningStepKey = typeof PROVISIONING_STEPS[number]
export type ProvisioningPlatform = 'vercel' | 'cloudflare_pages' | 'manual_export'
export type ProvisioningMode = 'preview_only' | 'customer_authorized' | 'owner_authorized'
export type ProvisioningExecutionMode = 'dry_run' | 'mocked' | 'external'

export type DomainIntentInput = {
  projectId: number
  draftOrderId?: number | null
  mode: 'customer_owned' | 'new_registration' | 'assisted'
  requestedDomain: string
  providerKey?: string | null
  idempotencyKey: string
}

export type ProvisioningPlanInput = {
  projectId: number
  versionId: number
  domainIntentId: number
  platform: ProvisioningPlatform
  deploymentMode?: ProvisioningMode
  idempotencyKey: string
}

export type ProvisioningRepository = {
  transaction<T>(work: (repository: ProvisioningRepository) => Promise<T>): Promise<T>
  findDomainIntentById(id: number): Promise<ManagedSiteDomainIntent | null>
  findDomainIntentByProject(projectId: number): Promise<ManagedSiteDomainIntent | null>
  findDomainIntentByIdempotency(idempotencyKey: string): Promise<ManagedSiteDomainIntent | null>
  insertDomainIntent(input: Omit<ManagedSiteDomainIntent, 'id' | 'createdAt' | 'updatedAt'>): Promise<ManagedSiteDomainIntent>
  updateDomainIntent(id: number, patch: Partial<Omit<ManagedSiteDomainIntent, 'id' | 'createdAt' | 'updatedAt'>>): Promise<ManagedSiteDomainIntent | null>
  findPlanById(id: number): Promise<ManagedSiteProvisioningPlan | null>
  findPlanByFingerprint(fingerprint: string): Promise<ManagedSiteProvisioningPlan | null>
  findPlanByIdempotency(idempotencyKey: string): Promise<ManagedSiteProvisioningPlan | null>
  insertPlan(input: Omit<ManagedSiteProvisioningPlan, 'id' | 'createdAt' | 'updatedAt'>): Promise<ManagedSiteProvisioningPlan>
  updatePlan(id: number, patch: Partial<Omit<ManagedSiteProvisioningPlan, 'id' | 'createdAt' | 'updatedAt'>>): Promise<ManagedSiteProvisioningPlan | null>
  findStep(planId: number, stepKey: ProvisioningStepKey): Promise<ManagedSiteProvisioningStep | null>
  listSteps(planId: number): Promise<ManagedSiteProvisioningStep[]>
  insertStep(input: Omit<ManagedSiteProvisioningStep, 'id' | 'createdAt' | 'updatedAt'>): Promise<ManagedSiteProvisioningStep>
  updateStep(id: number, patch: Partial<Omit<ManagedSiteProvisioningStep, 'id' | 'createdAt' | 'updatedAt'>>): Promise<ManagedSiteProvisioningStep | null>
  findEventByFingerprint(ownerUserId: number, fingerprint: string): Promise<ManagedSiteProvisioningEvent | null>
  insertEvent(input: Omit<ManagedSiteProvisioningEvent, 'id' | 'occurredAt'>): Promise<ManagedSiteProvisioningEvent>
  listEvents(ownerUserId: number, planId: number): Promise<ManagedSiteProvisioningEvent[]>
}

export type DomainAvailabilityResult = { status: 'available' | 'unavailable' | 'unknown'; normalizedDomain: string; providerKey: string | null; externalCalls: false; limitation: string }
export type DomainRegistrationResult = { status: 'planned' | 'blocked' | 'registered'; normalizedDomain: string; providerKey: string | null; externalReference: string | null; externalCalls: false; limitation: string }
export type DnsConfigurationResult = { status: 'planned' | 'blocked' | 'configured'; normalizedDomain: string; records: Array<{ type: 'A' | 'CNAME' | 'TXT'; name: string; value: string }>; externalCalls: false; limitation: string }
export type TlsVerificationResult = { status: 'planned' | 'blocked' | 'verified'; normalizedDomain: string; certificateReference: string | null; externalCalls: false; limitation: string }
export type DeploymentResult = { status: 'planned' | 'blocked' | 'deployed'; platform: ProvisioningPlatform; deployedUrl: string | null; externalReference: string | null; externalCalls: false; limitation: string }

export type ProvisioningAdapters = {
  checkDomainAvailability(input: { normalizedDomain: string; providerKey: string | null }): Promise<DomainAvailabilityResult>
  registerDomain(input: { normalizedDomain: string; providerKey: string | null }): Promise<DomainRegistrationResult>
  configureDns(input: { normalizedDomain: string; platform: ProvisioningPlatform }): Promise<DnsConfigurationResult>
  verifyTls(input: { normalizedDomain: string; platform: ProvisioningPlatform }): Promise<TlsVerificationResult>
  deploySite(input: { normalizedDomain: string; platform: ProvisioningPlatform; projectId: number; versionId: number }): Promise<DeploymentResult>
}

export type ProvisioningCapability = {
  providerKey: string
  configured: false
  enabled: false
  execution: 'not_available'
  externalCalls: false
  message: string
}

export type ProvisioningWorkspace = {
  domain: ProvisioningCapability
  dns: ProvisioningCapability
  tls: ProvisioningCapability
  deployment: ProvisioningCapability
  platforms: Array<{ platform: ProvisioningPlatform; capability: ProvisioningCapability }>
  truthfulBoundary: string[]
}

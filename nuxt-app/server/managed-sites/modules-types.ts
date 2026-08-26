import type { ManagedSiteIntegration } from '../database/schema'

export const MANAGED_SITE_MODULE_KEYS = ['bounded_ai_assistant', 'shopify_commerce', 'line_assisted_integration', 'google_booking_assisted_integration', 'payment', 'invoice', 'membership', 'pwa_reference_only'] as const
export type ManagedSiteModuleKey = typeof MANAGED_SITE_MODULE_KEYS[number]
export type IntegrationStatus = ManagedSiteIntegration['status']

export type ManagedSiteIntegrationIntentInput = {
  projectId: number
  moduleKey: ManagedSiteModuleKey
  providerKey?: string | null
  redactedConfig?: Record<string, unknown>
  idempotencyKey: string
}

export type ShopifyIntegrationIntent = ManagedSiteIntegrationIntentInput & {
  moduleKey: 'shopify_commerce'
  redactedConfig?: { shopDomain?: string; storefrontMode?: 'storefront_api'; checkoutMode?: 'shopify_hosted'; adminMode?: 'admin_graphql_api' }
}

export type BoundedAssistantRequest = {
  projectId: number
  question: string
  contextKeys?: string[]
  maxAnswerCharacters?: number
}

export type BoundedAssistantKnowledge = {
  citationId: string
  knowledgeKey: string
  evidenceHash: string
  tenantScope: string
}

export type BoundedAssistantCitation = {
  citationId: string
  evidenceHash: string
}

export type BoundedAssistantResponse = {
  status: 'answered' | 'blocked' | 'needs_authorization'
  answer: string | null
  citations: BoundedAssistantCitation[]
  knowledgeSnapshotHash: string | null
  providerConfigured: boolean
  externalCalls: false
  limitation: string | null
}

export type BoundedAssistantAdapter = {
  answer(input: { projectId: number; question: string; contextKeys: string[]; knowledge: BoundedAssistantKnowledge[]; knowledgeSnapshotHash: string; maxAnswerCharacters: number }): Promise<BoundedAssistantResponse>
}

export type IntegrationRepository = {
  transaction<T>(work: (repository: IntegrationRepository) => Promise<T>): Promise<T>
  findById(id: number): Promise<ManagedSiteIntegration | null>
  findByProjectModule(projectId: number, moduleKey: ManagedSiteModuleKey): Promise<ManagedSiteIntegration | null>
  findByShopDomain(shopDomain: string): Promise<ManagedSiteIntegration | null>
  findByIdempotency(ownerUserId: number, idempotencyKey: string): Promise<ManagedSiteIntegration | null>
  findByFingerprint(intentFingerprint: string): Promise<ManagedSiteIntegration | null>
  insert(input: Omit<ManagedSiteIntegration, 'id' | 'createdAt' | 'updatedAt'>): Promise<ManagedSiteIntegration>
  update(id: number, patch: Partial<Omit<ManagedSiteIntegration, 'id' | 'ownerUserId' | 'projectId' | 'moduleKey' | 'createdAt' | 'updatedAt'>>): Promise<ManagedSiteIntegration | null>
  listByProject(ownerUserId: number, projectId: number): Promise<ManagedSiteIntegration[]>
}

export type ModuleCapability = {
  moduleKey: ManagedSiteModuleKey
  providerKey: string
  status: 'standard' | 'requires_authorization' | 'not_configured'
  configured: false
  externalCalls: false
  customerAction: string | null
  limitation: string
}

export type ManagedSiteModuleWorkspace = {
  modules: ModuleCapability[]
  canonicalContentOperations: { linked: boolean; clientId: number | null; reuseOnly: true; message: string }
  truthfulBoundary: string[]
}

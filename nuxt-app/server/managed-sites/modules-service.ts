import { createError } from 'h3'
import { stableFingerprint } from '../seo-geo-core/repository'
import { createOwnerContentClient } from '../content-operations/service'
import { createContentOperationsRepository, type ContentOperationsRepository } from '../content-operations/repository'
import { getIntegrationRepository } from './modules-repository'
import { getManagedSiteRepository } from './repository'
import { MANAGED_SITE_MODULE_KEYS, type BoundedAssistantAdapter, type BoundedAssistantRequest, type BoundedAssistantResponse, type IntegrationRepository, type ManagedSiteIntegrationIntentInput, type ManagedSiteModuleKey, type ManagedSiteModuleWorkspace, type ModuleCapability, type ShopifyIntegrationIntent } from './modules-types'
import type { ManagedSiteRepository } from './types'

function invalid(message: string): never { throw createError({ statusCode: 422, statusMessage: message }) }
function notFound(message: string): never { throw createError({ statusCode: 404, statusMessage: message }) }
function conflict(message: string): never { throw createError({ statusCode: 409, statusMessage: message }) }

const MODULE_SPECS: Record<ManagedSiteModuleKey, { providerKey: string; authorizationMode: 'none' | 'customer_oauth' | 'customer_api_key' | 'owner_configured' | 'manual_assistance'; requiredScopes: string[]; status: ModuleCapability['status']; customerAction: string | null; limitation: string }> = {
  bounded_ai_assistant: { providerKey: 'llm-neutral', authorizationMode: 'owner_configured', requiredScopes: [], status: 'not_configured', customerAction: null, limitation: 'AI assistant provider is not configured; production answers fail closed and tests must inject a bounded mock.' },
  shopify_commerce: { providerKey: 'shopify-neutral', authorizationMode: 'customer_oauth', requiredScopes: ['read_products', 'read_inventory', 'read_orders'], status: 'requires_authorization', customerAction: '客戶需登入 Shopify 並同意必要權限；本 V1 不會建立商店、付款或金流。', limitation: 'Storefront API、Admin GraphQL API、OAuth and checkout are contract-only until customer authorization and Shopify credentials exist.' },
  line_assisted_integration: { providerKey: 'line-neutral', authorizationMode: 'customer_api_key', requiredScopes: [], status: 'requires_authorization', customerAction: '客戶需授權 LINE channel；本 V1 不會寄送訊息。', limitation: 'LINE integration is an intent only; no token exchange or message send is executed.' },
  google_booking_assisted_integration: { providerKey: 'google-booking-neutral', authorizationMode: 'customer_oauth', requiredScopes: [], status: 'requires_authorization', customerAction: '客戶需授權 Google Booking／Calendar；本 V1 不會建立預約。', limitation: 'Google booking is an intent only; no calendar or booking write is executed.' },
  payment: { providerKey: 'payment-neutral', authorizationMode: 'customer_api_key', requiredScopes: [], status: 'requires_authorization', customerAction: '客戶需選擇並授權付款服務；本 V1 不會扣款。', limitation: 'Payment is represented by the existing verified-event contract; no provider checkout is executed.' },
  invoice: { providerKey: 'invoice-neutral', authorizationMode: 'customer_api_key', requiredScopes: [], status: 'requires_authorization', customerAction: '客戶需授權發票服務；本 V1 不會開立發票。', limitation: 'Invoice generation is not executed without a customer-authorized provider.' },
  membership: { providerKey: 'membership-neutral', authorizationMode: 'owner_configured', requiredScopes: [], status: 'not_configured', customerAction: null, limitation: 'Membership is a bounded module contract; complex identity and enterprise SSO are outside V1.' },
  pwa_reference_only: { providerKey: 'site-runtime-neutral', authorizationMode: 'none', requiredScopes: [], status: 'standard', customerAction: null, limitation: 'PWA is represented as an allowlisted reference-only module; no arbitrary runtime code is generated.' },
}

function redactConfig(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const output: Record<string, unknown> = {}
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (/(secret|token|password|credential|private|access|authorization|api[-_]?key)/i.test(key)) continue
    if (typeof raw === 'string') output[key] = raw.trim().slice(0, 512)
    else if (typeof raw === 'boolean' || typeof raw === 'number') output[key] = raw
    else if (Array.isArray(raw) && raw.every(item => typeof item === 'string')) output[key] = raw.slice(0, 20).map(item => item.slice(0, 160))
  }
  return output
}

function normalizeShopifyConfig(input: ManagedSiteIntegrationIntentInput): Record<string, unknown> {
  const config = redactConfig(input.redactedConfig)
  if (input.moduleKey === 'shopify_commerce') {
    const shopDomain = typeof config.shopDomain === 'string' ? config.shopDomain.toLowerCase().replace(/\.$/, '') : ''
    if (shopDomain && (!shopDomain.includes('.') || shopDomain.includes('/') || shopDomain.includes('://') || shopDomain.includes(':'))) invalid('Shopify shopDomain must be a hostname without protocol, path, port, or credentials.')
    return { shopDomain: shopDomain || null, storefrontMode: 'storefront_api', checkoutMode: 'shopify_hosted', adminMode: 'admin_graphql_api' }
  }
  return config
}

function validateModuleKey(value: unknown): ManagedSiteModuleKey {
  if (typeof value !== 'string' || !(MANAGED_SITE_MODULE_KEYS as readonly string[]).includes(value)) invalid('Managed site module is not available in V1.')
  return value as ManagedSiteModuleKey
}

function moduleProjection(row: any): ModuleCapability {
  const spec = MODULE_SPECS[row.moduleKey as ManagedSiteModuleKey]
  return { moduleKey: row.moduleKey, providerKey: row.providerKey, status: row.status === 'active' || row.status === 'mock_verified' ? 'standard' : spec.status === 'standard' ? 'standard' : row.status === 'awaiting_authorization' ? 'requires_authorization' : 'not_configured', configured: false, externalCalls: false, customerAction: spec.customerAction, limitation: spec.limitation }
}

export const FAIL_CLOSED_ASSISTANT_ADAPTER: BoundedAssistantAdapter = {
  async answer() { return { status: 'blocked', answer: null, citations: [], providerConfigured: false, externalCalls: false, limitation: 'Bounded assistant provider is not configured; no AI response was generated.' } },
}

function validateAssistantResponse(response: BoundedAssistantResponse, maxAnswerCharacters: number): BoundedAssistantResponse {
  if (!['answered', 'blocked', 'needs_authorization'].includes(response.status) || response.providerConfigured !== true && response.status === 'answered') invalid('Bounded assistant response failed closed validation.')
  if (response.externalCalls !== false) invalid('Bounded assistant response declared an external call in a mocked boundary.')
  if (response.answer !== null && (typeof response.answer !== 'string' || response.answer.length > maxAnswerCharacters || /<script\b|javascript:/i.test(response.answer))) invalid('Bounded assistant response contains unsafe or oversized content.')
  if (!Array.isArray(response.citations) || response.citations.length > 20 || response.citations.some(citation => typeof citation !== 'string' || citation.length > 500)) invalid('Bounded assistant citations are malformed.')
  return response
}

export async function createManagedSiteIntegrationIntent(ownerUserId: number, input: ManagedSiteIntegrationIntentInput, repository = getIntegrationRepository(), managedRepository: ManagedSiteRepository = getManagedSiteRepository(), clock: () => Date = () => new Date()) {
  const moduleKey = validateModuleKey(input.moduleKey)
  const project = await managedRepository.findProject(ownerUserId, input.projectId)
  if (!project) notFound('Managed site project was not found.')
  const spec = MODULE_SPECS[moduleKey]
  const providerKey = typeof input.providerKey === 'string' && input.providerKey.trim() ? input.providerKey.trim().slice(0, 96) : spec.providerKey
  const redactedConfig = normalizeShopifyConfig({ ...input, moduleKey, providerKey })
  const intentFingerprint = stableFingerprint({ ownerUserId, projectId: input.projectId, moduleKey, providerKey, redactedConfig })
  const replay = await repository.findByIdempotency(ownerUserId, input.idempotencyKey)
  if (replay) {
    if (replay.intentFingerprint !== intentFingerprint) conflict('Integration idempotency key was already used for a different configuration.')
    return { integration: replay, replayed: true, externalCalls: false, providerConfigured: false, capability: moduleProjection(replay) }
  }
  const existing = await repository.findByProjectModule(input.projectId, moduleKey)
  if (existing) {
    if (existing.intentFingerprint !== intentFingerprint) conflict('This project already has a different intent for the selected module.')
    return { integration: existing, replayed: true, externalCalls: false, providerConfigured: false, capability: moduleProjection(existing) }
  }
  const createdAt = clock()
  const integration = await repository.insert({ ownerUserId, projectId: input.projectId, moduleKey, providerKey, status: spec.status === 'requires_authorization' ? 'awaiting_authorization' : 'not_configured', authorizationMode: spec.authorizationMode, requiredScopes: spec.requiredScopes, redactedConfig, intentFingerprint, idempotencyKey: input.idempotencyKey, externalReference: null, createdAt, updatedAt: createdAt } as any)
  return { integration, replayed: false, externalCalls: false, providerConfigured: false, capability: moduleProjection(integration) }
}

export async function createShopifyIntegrationIntent(ownerUserId: number, input: ShopifyIntegrationIntent, repository = getIntegrationRepository(), managedRepository: ManagedSiteRepository = getManagedSiteRepository(), clock: () => Date = () => new Date()) {
  const result = await createManagedSiteIntegrationIntent(ownerUserId, input, repository, managedRepository, clock)
  return { ...result, shopify: { oauth: { status: 'awaiting_customer_authorization', authorizationUrl: null, externalCalls: false }, storefront: { status: 'contract_only', products: false, cart: false, checkout: 'shopify_hosted_after_authorization', externalCalls: false }, admin: { status: 'contract_only', scopes: result.integration.requiredScopes, sync: false, externalCalls: false }, claims: { shopCreated: false, paymentConfigured: false, checkoutVerified: false } } }
}

export async function getManagedSiteModuleWorkspace(ownerUserId: number, projectId: number, repository = getIntegrationRepository(), managedRepository: ManagedSiteRepository = getManagedSiteRepository(), operationsRepository: ContentOperationsRepository = createContentOperationsRepository()): Promise<ManagedSiteModuleWorkspace> {
  const project = await managedRepository.findProject(ownerUserId, projectId)
  if (!project) notFound('Managed site project was not found.')
  const integrations = await repository.listByProject(ownerUserId, projectId)
  const modules = MANAGED_SITE_MODULE_KEYS.map(moduleKey => integrations.find(item => item.moduleKey === moduleKey) ? moduleProjection(integrations.find(item => item.moduleKey === moduleKey)) : { moduleKey, providerKey: MODULE_SPECS[moduleKey].providerKey, status: MODULE_SPECS[moduleKey].status, configured: false as const, externalCalls: false as const, customerAction: MODULE_SPECS[moduleKey].customerAction, limitation: MODULE_SPECS[moduleKey].limitation })
  let linked = false
  if (project.contentOperationClientId !== null) linked = Boolean(await operationsRepository.findClient(ownerUserId, project.contentOperationClientId))
  return { modules, canonicalContentOperations: { linked, clientId: linked ? project.contentOperationClientId : null, reuseOnly: true, message: linked ? '已連接既有 Content Operations；網站平台不建立第二套 GEO／內容引擎。' : '尚未連接既有 Content Operations；可由 owner 授權後建立 canonical client。' }, truthfulBoundary: ['Shopify、LINE、Google Booking、金流與發票只建立受控 integration intent。', '沒有真實 credential 時不交換 token、不寫入第三方、不宣稱已啟用。', 'GEO 內容生成、Content Calendar、Publication Routing、Measurement 與 Outcome Learning 由既有 Content Operations 重用。'] }
}

export async function linkManagedSiteContentOperations(ownerUserId: number, projectId: number, input: { displayName: string; canonicalSiteOrigin: string; framework: 'astro' | 'nuxt'; publicationTransport: 'first_party_git' | 'first_party_signed_api'; timeZone: string; defaultCadenceDays: 3 | 7 | 15 | 30; defaultPublishLocalTime: string; monthlyBudgetUnits: number; idempotencyKey: string }, managedRepository: ManagedSiteRepository = getManagedSiteRepository(), operationsRepository: ContentOperationsRepository = createContentOperationsRepository()) {
  const project = await managedRepository.findProject(ownerUserId, projectId)
  if (!project) notFound('Managed site project was not found.')
  if (project.contentOperationClientId !== null) {
    const client = await operationsRepository.findClient(ownerUserId, project.contentOperationClientId)
    if (!client) conflict('Managed site points to a missing Content Operations client.')
    return { project, client, linked: true, reused: true, notDuplicated: true }
  }
  const client = await createOwnerContentClient(ownerUserId, input, operationsRepository)
  const updated = await managedRepository.updateProject(ownerUserId, projectId, { contentOperationClientId: client.id })
  if (!updated) notFound('Managed site project was not found.')
  return { project: updated, client, linked: true, reused: true, notDuplicated: true }
}

export async function runManagedSiteAssistant(ownerUserId: number, input: BoundedAssistantRequest, adapter: BoundedAssistantAdapter = FAIL_CLOSED_ASSISTANT_ADAPTER, managedRepository: ManagedSiteRepository = getManagedSiteRepository()): Promise<BoundedAssistantResponse> {
  const project = await managedRepository.findProject(ownerUserId, input.projectId)
  if (!project) notFound('Managed site project was not found.')
  if (typeof input.question !== 'string' || !input.question.trim() || input.question.trim().length > 2000) invalid('Assistant question is invalid.')
  const contextKeys = Array.isArray(input.contextKeys) ? [...new Set(input.contextKeys.filter(item => typeof item === 'string').map(item => item.trim()).filter(Boolean))].slice(0, 20) : []
  const maxAnswerCharacters = Number.isSafeInteger(input.maxAnswerCharacters) ? Math.min(6000, Math.max(300, input.maxAnswerCharacters!)) : 2000
  const response = await adapter.answer({ projectId: project.id, question: input.question.trim(), contextKeys, maxAnswerCharacters })
  return validateAssistantResponse(response, maxAnswerCharacters)
}

export function getCanonicalGeoReuseContract() {
  return { contentOperationsClientFactory: 'createOwnerContentClient', calendarFactory: 'createCalendarFromProductionPlan', scheduledCadenceDays: [3, 7, 15, 30], productionRunner: 'runOwnerContentEntryWorkflow', publicationRunner: 'runContentOperationsExecutionTick', measurement: 'getOwnerContentOperationsWorkspace', outcomeLearning: 'buildOwnerContentLearningDataset', notDuplicated: true as const }
}

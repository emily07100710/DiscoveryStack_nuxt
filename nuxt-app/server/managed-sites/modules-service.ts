import { createError } from 'h3'
import { stableFingerprint } from '../seo-geo-core/repository'
import { createOwnerContentClient } from '../content-operations/service'
import { createContentOperationsRepository, type ContentOperationsRepository } from '../content-operations/repository'
import { getOwnerContentOperationsWorkspace } from '../content-operations/service'
import { getIntegrationRepository } from './modules-repository'
import { getManagedSiteRepository } from './repository'
import { assertPaidManagedSiteModuleEntitlement, assertPaidManagedSiteProject } from './module-authority'
import { normalizeShopifyShopDomain } from './shopify-service'
import { MANAGED_SITE_MODULE_KEYS, type BoundedAssistantAdapter, type BoundedAssistantKnowledge, type BoundedAssistantRequest, type BoundedAssistantResponse, type IntegrationRepository, type ManagedSiteIntegrationIntentInput, type ManagedSiteModuleKey, type ManagedSiteModuleWorkspace, type ModuleCapability, type ShopifyIntegrationIntent } from './modules-types'
import type { ManagedSiteRepository } from './types'

function invalid(message: string): never { throw createError({ statusCode: 422, statusMessage: message }) }
function notFound(message: string): never { throw createError({ statusCode: 404, statusMessage: message }) }
function conflict(message: string): never { throw createError({ statusCode: 409, statusMessage: message }) }

const ASSISTANT_MAX_KNOWLEDGE_ITEMS = 20
const ASSISTANT_MAX_EXCERPT_CHARACTERS = 1800
const ASSISTANT_MAX_TOTAL_KNOWLEDGE_CHARACTERS = 12_000
const ASSISTANT_EVIDENCE_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000

function safeText(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null
  const normalized = value.replace(/[\r\n\t]+/gu, ' ').replace(/\s{2,}/gu, ' ').trim()
  return normalized ? normalized.slice(0, max) : null
}

function isFreshEvidence(snapshot: unknown, now: Date): boolean {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) return false
  const evidence = snapshot as { hash?: unknown; freshnessBasis?: unknown; revokedAt?: unknown; removedAt?: unknown; status?: unknown; refs?: unknown[] }
  if (evidence.revokedAt || evidence.removedAt || ['revoked', 'removed', 'stale', 'rejected'].includes(String(evidence.status || '').toLowerCase())) return false
  const basis = typeof evidence.freshnessBasis === 'string' ? new Date(evidence.freshnessBasis) : null
  if (!basis || !Number.isFinite(basis.getTime()) || basis.getTime() > now.getTime() || now.getTime() - basis.getTime() > ASSISTANT_EVIDENCE_MAX_AGE_MS) return false
  if (Array.isArray(evidence.refs) && evidence.refs.some(ref => ref && typeof ref === 'object' && ['revoked', 'removed', 'stale', 'rejected'].includes(String((ref as { status?: unknown }).status || '').toLowerCase()))) return false
  return true
}

function hasVerifiedPublicationReceipt(attempt: Record<string, unknown>, entry: Record<string, unknown>): boolean {
  if (attempt.status !== 'delivered' || typeof attempt.receiptFingerprint !== 'string' || !/^[a-f0-9]{64}$/iu.test(attempt.receiptFingerprint)) return false
  if (!Array.isArray(attempt.receiptLedger) || attempt.receiptLedger.length < 1) return false
  return attempt.receiptLedger.some(receipt => {
    if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) return false
    const candidate = receipt as { status?: unknown; contentHash?: unknown; evidenceSnapshotHash?: unknown }
    return candidate.status === 'delivered' && candidate.contentHash === entry.contentHash && candidate.evidenceSnapshotHash === entry.evidenceSnapshotHash
  })
}

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
    const shopDomain = typeof config.shopDomain === 'string' && config.shopDomain.trim() ? normalizeShopifyShopDomain(config.shopDomain) : null
    return { shopDomain, storefrontMode: 'storefront_api', checkoutMode: 'shopify_hosted', adminMode: 'admin_graphql_api' }
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
  async answer() { return { status: 'blocked', answer: null, citations: [], knowledgeSnapshotHash: null, providerConfigured: false, externalCalls: false, limitation: 'Bounded assistant provider is not configured; no AI response was generated.' } },
}

function validateAssistantResponse(response: BoundedAssistantResponse, maxAnswerCharacters: number, knowledgeSnapshotHash: string, knowledge: BoundedAssistantKnowledge[]): BoundedAssistantResponse {
  if (!['answered', 'blocked', 'needs_authorization'].includes(response.status) || response.providerConfigured !== true && response.status === 'answered') invalid('Bounded assistant response failed closed validation.')
  if (response.externalCalls !== false) invalid('Bounded assistant response declared an external call in a mocked boundary.')
  if (response.answer !== null && (typeof response.answer !== 'string' || response.answer.length > maxAnswerCharacters || /<script\b|javascript:/i.test(response.answer))) invalid('Bounded assistant response contains unsafe or oversized content.')
  if (response.status !== 'answered' && response.answer !== null) invalid('Blocked assistant responses cannot contain an answer.')
  if (!Array.isArray(response.citations) || response.citations.length > ASSISTANT_MAX_KNOWLEDGE_ITEMS || response.citations.some(citation => !citation || typeof citation !== 'object' || typeof citation.citationId !== 'string' || typeof citation.evidenceHash !== 'string' || typeof citation.contentHash !== 'string' || typeof citation.sourceLocator !== 'string')) invalid('Bounded assistant citations are malformed.')
  const byId = new Map(knowledge.map(item => [item.citationId, item]))
  const citations = response.citations as Array<{ citationId: string; evidenceHash: string; contentHash: string; sourceLocator: string }>
  if (new Set(citations.map(citation => citation.citationId)).size !== citations.length || citations.some(citation => {
    const item = byId.get(citation.citationId)
    return !item || item.evidenceHash !== citation.evidenceHash || item.contentHash !== citation.contentHash || item.sourceLocator !== citation.sourceLocator
  })) invalid('Bounded assistant citation is outside the server-resolved knowledge snapshot.')
  if (response.status === 'answered' && response.knowledgeSnapshotHash !== knowledgeSnapshotHash) invalid('Bounded assistant knowledge snapshot hash does not match the server-resolved tenant knowledge.')
  if (response.status !== 'answered' && response.knowledgeSnapshotHash !== null && response.knowledgeSnapshotHash !== knowledgeSnapshotHash) invalid('Bounded assistant blocked response carries an invalid knowledge snapshot hash.')
  return response
}

async function resolveAssistantKnowledge(ownerUserId: number, projectId: number, requestedContextKeys: unknown, managedRepository: ManagedSiteRepository, operationsRepository: ContentOperationsRepository) {
  const authority = await assertPaidManagedSiteModuleEntitlement(ownerUserId, projectId, 'bounded_ai_assistant', managedRepository)
  if (authority.project.contentOperationClientId === null) return { knowledge: [] as BoundedAssistantKnowledge[], knowledgeSnapshotHash: stableFingerprint([]) }
  const workspace = await getOwnerContentOperationsWorkspace(ownerUserId, operationsRepository)
  const calendars = workspace.calendars.filter(calendar => calendar.ownerUserId === ownerUserId && calendar.clientId === authority.project.contentOperationClientId)
  const calendarIds = new Set(calendars.map(calendar => calendar.id))
  const tenantScope = `owner:${ownerUserId}:project:${projectId}:client:${authority.project.contentOperationClientId}`
  const now = new Date()
  const candidates: BoundedAssistantKnowledge[] = []
  for (const entry of workspace.entries.filter(candidate => candidate.ownerUserId === ownerUserId && calendarIds.has(candidate.calendarId) && ['delivered', 'completed'].includes(candidate.status))) {
    let publication: Awaited<ReturnType<ContentOperationsRepository['resolveDeliveredPublication']>>
    try { publication = await operationsRepository.resolveDeliveredPublication(ownerUserId, entry.id) } catch { continue }
    if (!publication) continue
    const publishedEntry = publication.entry as Record<string, unknown>
    const job = publication.job as Record<string, unknown>
    const deliverable = publication.deliverable as Record<string, unknown>
    const riskGate = publication.riskGate as Record<string, unknown> | undefined
    const attempt = publication.publicationAttempt as Record<string, unknown> | undefined
    const run = publication.publicationRun as Record<string, unknown> | undefined
    const review = publication.review as Record<string, unknown> | null | undefined
    const draft = publication.draft as Record<string, unknown>
    if (!['delivered', 'completed'].includes(String(publishedEntry.status)) || !['delivered', 'completed'].includes(String(job.status || 'delivered')) || !run || run.ownerUserId !== ownerUserId || run.entryId !== entry.id || run.stage !== 'publication' || run.state !== 'succeeded' || !attempt || attempt.ownerUserId !== ownerUserId || attempt.entryId !== entry.id || attempt.evidenceSnapshotHash !== publishedEntry.evidenceSnapshotHash || attempt.contentHash !== publishedEntry.contentHash || !riskGate || riskGate.status !== 'passed' || riskGate.evidenceSnapshotHash !== publishedEntry.evidenceSnapshotHash || deliverable.ownerUserId !== ownerUserId || deliverable.evidenceSnapshotHash !== publishedEntry.evidenceSnapshotHash || job.ownerUserId !== ownerUserId || job.evidenceSnapshotHash !== publishedEntry.evidenceSnapshotHash || typeof publishedEntry.contentHash !== 'string' || !/^[a-f0-9]{64}$/iu.test(publishedEntry.contentHash) || !publishedEntry.contentHash || draft.contentHash !== publishedEntry.contentHash || !hasVerifiedPublicationReceipt(attempt, publishedEntry)) continue
    const governedAutopilot = typeof publication.authorityReference === 'string' && /^ref-autopilot-[A-Za-z0-9._:-]+$/u.test(publication.authorityReference)
    if (!governedAutopilot && (!review || review.reviewerUserId !== ownerUserId || review.decision !== 'approved_for_delivery' || review.evidenceSnapshotHash !== publishedEntry.evidenceSnapshotHash)) continue
    let context: Awaited<ReturnType<ContentOperationsRepository['resolveCanonicalContext']>>
    try { context = await operationsRepository.resolveCanonicalContext(ownerUserId, Number((publication.deliverable as Record<string, unknown>).planId), Number((publication.deliverable as Record<string, unknown>).id)) } catch { continue }
    const evidenceSnapshot = (context as { evidenceSnapshot?: unknown }).evidenceSnapshot
    if (!isFreshEvidence(evidenceSnapshot, now) || (evidenceSnapshot as { hash?: unknown } | undefined)?.hash !== publishedEntry.evidenceSnapshotHash) continue
    const title = safeText(draft.title, 300)
    const body = safeText(draft.body, ASSISTANT_MAX_EXCERPT_CHARACTERS)
    if (!body || typeof attempt.receiptFingerprint !== 'string' || !/^[a-f0-9]{64}$/iu.test(attempt.receiptFingerprint)) continue
    const publicationIdentity = publication.publicationIdentity
    const targetOrigin = safeText((publication.publicationTarget as Record<string, unknown> | null | undefined)?.targetOrigin, 2048)
    const path = safeText(publicationIdentity?.path, 512)
    const sourceLocator = targetOrigin && path ? `${targetOrigin.replace(/\/$/u, '')}${path.startsWith('/') ? path : `/${path}`}` : `content-entry:${entry.id}`
    const excerpt = [title, body].filter(Boolean).join(' — ').slice(0, ASSISTANT_MAX_EXCERPT_CHARACTERS)
    candidates.push({ citationId: `content-entry:${entry.id}`, knowledgeKey: `calendar:${entry.calendarId}:entry:${entry.id}`, evidenceHash: String(publishedEntry.evidenceSnapshotHash), contentHash: String(publishedEntry.contentHash), publicationReceiptFingerprint: attempt.receiptFingerprint, sourceLocator, excerpt, tenantScope })
    if (candidates.length >= ASSISTANT_MAX_KNOWLEDGE_ITEMS) break
  }
  const requested = Array.isArray(requestedContextKeys) ? [...new Set(requestedContextKeys.filter(item => typeof item === 'string').map(item => item.trim()).filter(Boolean))].slice(0, ASSISTANT_MAX_KNOWLEDGE_ITEMS) : []
  const selected = requested.length ? candidates.filter(item => requested.includes(item.citationId) || requested.includes(item.knowledgeKey)) : candidates
  let totalCharacters = 0
  const knowledge = selected.filter(item => {
    if (totalCharacters + item.excerpt.length > ASSISTANT_MAX_TOTAL_KNOWLEDGE_CHARACTERS) return false
    totalCharacters += item.excerpt.length
    return true
  })
  return { knowledge, knowledgeSnapshotHash: stableFingerprint(knowledge) }
}

export async function createManagedSiteIntegrationIntent(ownerUserId: number, input: ManagedSiteIntegrationIntentInput, repository = getIntegrationRepository(), managedRepository: ManagedSiteRepository = getManagedSiteRepository(), clock: () => Date = () => new Date()) {
  const moduleKey = validateModuleKey(input.moduleKey)
  await assertPaidManagedSiteModuleEntitlement(ownerUserId, input.projectId, moduleKey, managedRepository)
  const spec = MODULE_SPECS[moduleKey]
  const providerKey = typeof input.providerKey === 'string' && input.providerKey.trim() ? input.providerKey.trim().slice(0, 96) : spec.providerKey
  const redactedConfig = normalizeShopifyConfig({ ...input, moduleKey, providerKey })
  const shopDomain = moduleKey === 'shopify_commerce' && typeof redactedConfig.shopDomain === 'string' ? redactedConfig.shopDomain : null
  const intentFingerprint = stableFingerprint({ ownerUserId, projectId: input.projectId, moduleKey, providerKey, redactedConfig })
  const replay = await repository.findByIdempotency(ownerUserId, input.idempotencyKey)
  if (replay) {
    if (replay.intentFingerprint !== intentFingerprint) conflict('Integration idempotency key was already used for a different configuration.')
    return { integration: replay, replayed: true, externalCalls: false, providerConfigured: false, capability: moduleProjection(replay) }
  }
  const existing = await repository.findByProjectModule(ownerUserId, input.projectId, moduleKey)
  if (existing) {
    if (existing.intentFingerprint !== intentFingerprint) conflict('This project already has a different intent for the selected module.')
    return { integration: existing, replayed: true, externalCalls: false, providerConfigured: false, capability: moduleProjection(existing) }
  }
    const createdAt = clock()
  const integration = await repository.insert({ ownerUserId, projectId: input.projectId, moduleKey, providerKey, status: spec.status === 'requires_authorization' ? 'awaiting_authorization' : 'not_configured', authorizationMode: spec.authorizationMode, requiredScopes: spec.requiredScopes, redactedConfig, shopDomain, intentFingerprint, idempotencyKey: input.idempotencyKey, externalReference: null, createdAt, updatedAt: createdAt } as any)

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
  const authority = await assertPaidManagedSiteProject(ownerUserId, projectId, managedRepository)
  const project = authority.project
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

export async function runManagedSiteAssistant(ownerUserId: number, input: BoundedAssistantRequest, adapter: BoundedAssistantAdapter = FAIL_CLOSED_ASSISTANT_ADAPTER, managedRepository: ManagedSiteRepository = getManagedSiteRepository(), operationsRepository: ContentOperationsRepository = createContentOperationsRepository()): Promise<BoundedAssistantResponse> {
  const project = await managedRepository.findProject(ownerUserId, input.projectId)
  if (!project) notFound('Managed site project was not found.')
  if (typeof input.question !== 'string' || !input.question.trim() || input.question.trim().length > 2000) invalid('Assistant question is invalid.')
  const resolved = await resolveAssistantKnowledge(ownerUserId, project.id, input.contextKeys, managedRepository, operationsRepository)
  if (!resolved.knowledge.length) return { status: 'needs_authorization', answer: null, citations: [], knowledgeSnapshotHash: null, providerConfigured: false, externalCalls: false, limitation: 'No owner-approved tenant knowledge is available for this managed-site assistant.' }
  const maxAnswerCharacters = Number.isSafeInteger(input.maxAnswerCharacters) ? Math.min(6000, Math.max(300, input.maxAnswerCharacters!)) : 2000
  const response = await adapter.answer({ projectId: project.id, question: input.question.trim(), contextKeys: resolved.knowledge.map(item => item.knowledgeKey), knowledge: resolved.knowledge, knowledgeSnapshotHash: resolved.knowledgeSnapshotHash, maxAnswerCharacters })
  return validateAssistantResponse(response, maxAnswerCharacters, resolved.knowledgeSnapshotHash, resolved.knowledge)
}

export function getCanonicalGeoReuseContract() {
  return { contentOperationsClientFactory: 'createOwnerContentClient', calendarFactory: 'createCalendarFromProductionPlan', scheduledCadenceDays: [3, 7, 15, 30], productionRunner: 'runOwnerContentEntryWorkflow', publicationRunner: 'runContentOperationsExecutionTick', measurement: 'getOwnerContentOperationsWorkspace', outcomeLearning: 'buildOwnerContentLearningDataset', notDuplicated: true as const }
}

import { stableFingerprint } from '../seo-geo-core/repository'
import { createError } from 'h3'
import { getManagedSiteRepository } from './repository'
import { getProvisioningRepository } from './provisioning-repository'
import { MANAGED_SITE_SESSION_TTL_MS } from './types'
import { PROVISIONING_STEPS, type DomainAvailabilityResult, type DomainIntentInput, type ProvisioningAdapters, type ProvisioningCapability, type ProvisioningExecutionMode, type ProvisioningMode, type ProvisioningPlatform, type ProvisioningPlanInput, type ProvisioningRepository, type ProvisioningStepKey, type ProvisioningWorkspace } from './provisioning-types'
import type { ManagedSiteRepository } from './types'

function invalid(message: string): never { throw createError({ statusCode: 422, statusMessage: message }) }
function notFound(message: string): never { throw createError({ statusCode: 404, statusMessage: message }) }
function conflict(message: string): never { throw createError({ statusCode: 409, statusMessage: message }) }

function stringField(value: unknown, label: string, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max) invalid(`${label} is invalid.`)
  return value.trim()
}

export function normalizeDomain(value: unknown): string {
  const candidate = stringField(value, 'Domain', 253).toLowerCase().replace(/\.$/, '')
  if (candidate.includes('://') || candidate.includes('/') || candidate.includes('@') || candidate.includes(':') || candidate.includes('..') || !candidate.includes('.') || !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/.test(candidate)) invalid('Domain must be a normalized public DNS name without protocol, path, port, credentials, or wildcard.')
  return candidate
}

export const FAIL_CLOSED_PROVISIONING_ADAPTERS: ProvisioningAdapters = {
  async checkDomainAvailability(input): Promise<DomainAvailabilityResult> { return { status: 'unknown', normalizedDomain: input.normalizedDomain, providerKey: input.providerKey, externalCalls: false, limitation: 'No registrar credential is configured; availability is not claimed.' } },
  async registerDomain(input) { return { status: 'blocked', normalizedDomain: input.normalizedDomain, providerKey: input.providerKey, externalReference: null, externalCalls: false, limitation: 'Domain registration is disabled until a customer-authorized registrar provider is configured.' } },
  async configureDns(input) { return { status: 'blocked', normalizedDomain: input.normalizedDomain, records: [], externalCalls: false, limitation: `DNS configuration for ${input.platform} is disabled until customer authorization and provider configuration.` } },
  async verifyTls(input) { return { status: 'blocked', normalizedDomain: input.normalizedDomain, certificateReference: null, externalCalls: false, limitation: `TLS verification for ${input.platform} is disabled until a deployment provider is configured.` } },
  async deploySite(input) { return { status: 'blocked', platform: input.platform, deployedUrl: null, externalReference: null, externalCalls: false, limitation: `Deployment to ${input.platform} is disabled until a customer-authorized provider is configured.` } },
}

function capability(providerKey: string, message: string): ProvisioningCapability {
  return { providerKey, configured: false, enabled: false, execution: 'not_available', externalCalls: false, message }
}

export function getProvisioningWorkspace(): ProvisioningWorkspace {
  const domain = capability('registrar-neutral', '尚未連線／需要客戶授權與 owner server-side registrar 設定。')
  const dns = capability('dns-neutral', '尚未連線／需要客戶授權與 owner server-side DNS 設定。')
  const tls = capability('tls-neutral', '尚未連線／需要部署平台設定後才可驗證。')
  const deployment = capability('deployment-neutral', '尚未連線／需要 Vercel、Cloudflare Pages 或其他受控 provider 設定。')
  return { domain, dns, tls, deployment, platforms: (['vercel', 'cloudflare_pages', 'manual_export'] as ProvisioningPlatform[]).map(platform => ({ platform, capability: { ...deployment, providerKey: platform } })), truthfulBoundary: ['本 V1 只建立 provisioning intent、計畫、步驟與 receipts。', '不會真的購買網域、寫 DNS、取得 TLS、部署網站或宣稱已上線。', '沒有真實 credential 時，production adapter fail closed；測試只能注入 mock。'] }
}

function modeFor(input: unknown): DomainIntentInput['mode'] {
  if (input === 'customer_owned' || input === 'new_registration' || input === 'assisted') return input
  invalid('Domain ownership mode is invalid.')
}

function platformFor(input: unknown): ProvisioningPlatform {
  if (input === 'vercel' || input === 'cloudflare_pages' || input === 'manual_export') return input
  invalid('Deployment platform is invalid.')
}

function provisioningMode(input: unknown): ProvisioningMode {
  if (input === undefined) return 'preview_only'
  if (input === 'preview_only' || input === 'customer_authorized' || input === 'owner_authorized') return input
  invalid('Provisioning mode is invalid.')
}

export async function createManagedSiteDomainIntent(ownerUserId: number, input: DomainIntentInput, repository = getProvisioningRepository(), managedRepository: ManagedSiteRepository = getManagedSiteRepository(), clock: () => Date = () => new Date()) {
  const mode = modeFor(input.mode)
  const normalizedDomain = normalizeDomain(input.requestedDomain)
  const project = await managedRepository.findProject(ownerUserId, input.projectId)
  if (!project) notFound('Managed site project was not found.')
  const fingerprint = stableFingerprint({ projectId: input.projectId, normalizedDomain, mode, providerKey: input.providerKey || null })
  const replay = await repository.findDomainIntentByIdempotency(input.idempotencyKey)
  if (replay) {
    if (replay.configurationFingerprint !== fingerprint) conflict('Domain intent idempotency key was already used for a different configuration.')
    return { intent: replay, replayed: true, execution: { externalCalls: false, providerConfigured: false } }
  }
  const existing = await repository.findDomainIntentByProject(input.projectId)
  if (existing) {
    if (existing.configurationFingerprint !== fingerprint) conflict('This managed site project already has a different domain intent.')
    return { intent: existing, replayed: true, execution: { externalCalls: false, providerConfigured: false } }
  }
  const createdAt = clock()
  const intent = await repository.insertDomainIntent({ ownerUserId, projectId: input.projectId, draftOrderId: input.draftOrderId ?? null, mode, requestedDomain: stringField(input.requestedDomain, 'Domain', 253), normalizedDomain, ownershipStatus: mode === 'customer_owned' ? 'needs_customer_action' : 'unknown', purchaseStatus: mode === 'customer_owned' ? 'not_requested' : 'intent_created', dnsStatus: mode === 'customer_owned' ? 'pending_customer' : 'not_requested', providerKey: input.providerKey || null, providerReference: null, configurationFingerprint: fingerprint, idempotencyKey: input.idempotencyKey, createdAt, updatedAt: createdAt } as any)
  return { intent, replayed: false, execution: { externalCalls: false, providerConfigured: false } }
}

export async function createManagedSiteProvisioningPlan(ownerUserId: number, input: ProvisioningPlanInput, repository = getProvisioningRepository(), managedRepository: ManagedSiteRepository = getManagedSiteRepository(), clock: () => Date = () => new Date()) {
  const platform = platformFor(input.platform)
  const deploymentMode = provisioningMode(input.deploymentMode)
  const project = await managedRepository.findProject(ownerUserId, input.projectId)
  const version = await managedRepository.findVersion(ownerUserId, input.versionId)
  const domainIntent = await repository.findDomainIntentById(input.domainIntentId)
  if (!project || !version || version.projectId !== input.projectId || !domainIntent || domainIntent.projectId !== input.projectId || domainIntent.ownerUserId !== ownerUserId) notFound('Managed site provisioning lineage was not found.')
  const intentFingerprint = stableFingerprint({ ownerUserId, projectId: input.projectId, versionId: input.versionId, domainIntentId: input.domainIntentId, platform, deploymentMode })
  const replay = await repository.findPlanByIdempotency(input.idempotencyKey)
  if (replay) {
    if (replay.intentFingerprint !== intentFingerprint) conflict('Provisioning plan idempotency key was already used for a different configuration.')
    return { plan: replay, steps: await repository.listSteps(replay.id), replayed: true }
  }
  const existing = await repository.findPlanByFingerprint(intentFingerprint)
  if (existing) return { plan: existing, steps: await repository.listSteps(existing.id), replayed: true }
  const createdAt = clock()
  const plan = await repository.transaction(async transaction => {
    const created = await transaction.insertPlan({ ownerUserId, projectId: input.projectId, versionId: input.versionId, domainIntentId: input.domainIntentId, platform, deploymentMode, status: deploymentMode === 'preview_only' ? 'draft' : 'awaiting_authorization', domainStatus: 'not_started', dnsStatus: 'not_started', tlsStatus: 'not_started', deploymentStatus: 'not_started', intentFingerprint, idempotencyKey: input.idempotencyKey, providerProjectReference: null, providerDeploymentReference: null, deployedUrl: null, tlsCertificateReference: null, createdAt, updatedAt: createdAt } as any)
    const steps = []
    for (const [ordinal, stepKey] of PROVISIONING_STEPS.entries()) steps.push(await transaction.insertStep({ ownerUserId, projectId: input.projectId, planId: created.id, stepKey, ordinal: ordinal + 1, status: 'pending', providerKey: stepKey === 'domain_registration' ? domainIntent.providerKey : platform, attemptNumber: 0, inputFingerprint: stableFingerprint({ planId: created.id, stepKey, domain: domainIntent.normalizedDomain, platform, versionId: input.versionId }), outputFingerprint: null, errorCode: null, errorSummary: null, externalReference: null, completedAt: null, createdAt, updatedAt: createdAt } as any))
    return { plan: created, steps }
  })
  return { ...plan, replayed: false }
}

function eventInput(ownerUserId: number, plan: any, step: any, eventType: string, executionMode: ProvisioningExecutionMode, status: 'planned' | 'blocked' | 'succeeded' | 'failed', providerKey: string | null, metadata: Record<string, unknown>) {
  const receiptFingerprint = stableFingerprint({ ownerUserId, planId: plan.id, stepId: step.id, eventType, executionMode, status, metadata })
  return { ownerUserId, projectId: plan.projectId, planId: plan.id, stepId: step.id, eventType, executionMode, status, providerKey, externalReference: null, receiptFingerprint, metadata }
}

export async function executeManagedSiteProvisioningPlan(ownerUserId: number, planId: number, executionMode: ProvisioningExecutionMode = 'dry_run', adapters: ProvisioningAdapters = FAIL_CLOSED_PROVISIONING_ADAPTERS, repository = getProvisioningRepository(), managedRepository: ManagedSiteRepository = getManagedSiteRepository(), clock: () => Date = () => new Date()) {
  if (!['dry_run', 'mocked', 'external'].includes(executionMode)) invalid('Provisioning execution mode is invalid.')
  const plan = await repository.findPlanById(planId)
  if (!plan || plan.ownerUserId !== ownerUserId) notFound('Managed site provisioning plan was not found.')
  const project = await managedRepository.findProject(ownerUserId, plan.projectId)
  const domainIntent = await repository.findDomainIntentById(plan.domainIntentId)
  if (!project || !domainIntent || domainIntent.projectId !== project.id) notFound('Managed site provisioning lineage was not found.')
  if (executionMode === 'external') throw createError({ statusCode: 403, statusMessage: 'External provisioning is disabled in this V1 environment.' })
  const steps = await repository.listSteps(plan.id)
  const results: Array<Record<string, unknown>> = []
  let blocked = false
  let domainStatus: any = 'not_started'
  let dnsStatus: any = 'not_started'
  let tlsStatus: any = 'not_started'
  let deploymentStatus: any = 'not_started'
  for (const step of steps) {
    if (step.status === 'succeeded') { results.push({ stepKey: step.stepKey, status: step.status, replayed: true }); continue }
    let result: any
    let status: 'succeeded' | 'blocked' = 'blocked'
    let eventType = `provisioning_${step.stepKey}`
    if (step.stepKey === 'domain_intent') {
      result = { status: 'planned', normalizedDomain: domainIntent.normalizedDomain, externalCalls: false, limitation: 'Intent recorded only; domain ownership and registration are not verified.' }
      status = 'succeeded'; domainStatus = domainIntent.mode === 'customer_owned' ? 'awaiting_customer' : 'not_started'
    } else if (step.stepKey === 'domain_registration') {
      if (domainIntent.mode === 'customer_owned') { result = { status: 'planned', normalizedDomain: domainIntent.normalizedDomain, externalCalls: false, limitation: 'Customer-owned domain registration is not requested; customer DNS authorization remains pending.' }; status = 'succeeded'; domainStatus = 'awaiting_customer' } else { result = await adapters.registerDomain({ normalizedDomain: domainIntent.normalizedDomain, providerKey: domainIntent.providerKey }); status = result.status === 'registered' ? 'succeeded' : 'blocked'; domainStatus = status === 'succeeded' ? 'provider_pending' : 'blocked' }
    } else if (step.stepKey === 'dns_configuration') {
      result = await adapters.configureDns({ normalizedDomain: domainIntent.normalizedDomain, platform: plan.platform }); status = result.status === 'configured' ? 'succeeded' : 'blocked'; dnsStatus = status === 'succeeded' ? 'provider_pending' : 'blocked'
    } else if (step.stepKey === 'tls_verification') {
      result = await adapters.verifyTls({ normalizedDomain: domainIntent.normalizedDomain, platform: plan.platform }); status = result.status === 'verified' ? 'succeeded' : 'blocked'; tlsStatus = status === 'succeeded' ? 'verified' : 'blocked'
    } else {
      result = await adapters.deploySite({ normalizedDomain: domainIntent.normalizedDomain, platform: plan.platform, projectId: plan.projectId, versionId: plan.versionId }); status = result.status === 'deployed' ? 'succeeded' : 'blocked'; deploymentStatus = status === 'succeeded' ? 'built' : 'blocked'
    }
    if (status === 'blocked') blocked = true
    const changedAt = clock()
    const updatedStep = await repository.updateStep(step.id, { status, attemptNumber: step.attemptNumber + 1, outputFingerprint: stableFingerprint(result), errorCode: status === 'blocked' ? 'PROVIDER_NOT_CONFIGURED' : null, errorSummary: status === 'blocked' ? String(result.limitation || 'Provisioning provider is unavailable.') : null, externalReference: result.externalReference || null, completedAt: status === 'succeeded' ? changedAt : null, updatedAt: changedAt } as any)
    await repository.insertEvent(eventInput(ownerUserId, plan, step, eventType, executionMode, status, step.providerKey, { stepKey: step.stepKey, normalizedDomain: domainIntent.normalizedDomain, providerConfigured: false, externalCalls: false, result: { status: result.status, limitation: result.limitation || null } }) as any)
    results.push({ stepKey: step.stepKey, status, providerConfigured: false, externalCalls: false, limitation: result.limitation, stepId: updatedStep?.id || step.id })
  }
  const finalStatus = blocked ? 'blocked' : 'succeeded'
  const updatedPlan = await repository.updatePlan(plan.id, { status: finalStatus, domainStatus, dnsStatus, tlsStatus, deploymentStatus, updatedAt: clock() } as any)
  return { plan: updatedPlan, steps: await repository.listSteps(plan.id), events: await repository.listEvents(ownerUserId, plan.id), results, externalCalls: false, providerConfigured: false, executionMode }
}

export async function getManagedSiteProvisioningWorkspace(ownerUserId: number, projectId: number, managedRepository: ManagedSiteRepository = getManagedSiteRepository()) {
  const project = await managedRepository.findProject(ownerUserId, projectId)
  if (!project) notFound('Managed site project was not found.')
  return getProvisioningWorkspace()
}

export { MANAGED_SITE_SESSION_TTL_MS }

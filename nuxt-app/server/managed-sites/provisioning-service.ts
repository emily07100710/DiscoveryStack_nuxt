import { stableFingerprint } from '../seo-geo-core/repository'
import { normalizePublicHttpsOrigin } from '../content-operations/normalization'
import { createError } from 'h3'
import { randomBytes } from 'node:crypto'
import { getManagedSiteRepository } from './repository'
import { getProvisioningRepository } from './provisioning-repository'
import { MANAGED_SITE_SESSION_TTL_MS } from './types'
import { PROVISIONING_STEPS, type DomainAvailabilityResult, type DomainIntentInput, type ProvisioningAdapters, type ProvisioningCapability, type ProvisioningExecutionMode, type ProvisioningMode, type ProvisioningPlatform, type ProvisioningPlanInput, type ProvisioningRepository, type ProvisioningStepKey, type ProvisioningWorkspace } from './provisioning-types'
import type { ManagedSiteRepository } from './types'
import type { PreviewRepository } from './ordering-types'
import { getPreviewRepository } from './ordering-repository'
import { parseSiteSpecSnapshot } from './site-spec'

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
  if (/(^|\.)((local(host)?|internal|onion|test|invalid|example))$/u.test(candidate)) invalid('Domain must not use a local, special-use, or documentation suffix.')
  const origin = normalizePublicHttpsOrigin(`https://${candidate}`)
  return new URL(origin).hostname.toLowerCase()
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

const PROVISIONING_LEASE_MS = 30_000
const PROVISIONING_MAX_ATTEMPTS = 3

function validDate(value: Date, label: string): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) invalid(`${label} is invalid.`)
  return value
}

function retryAt(attemptNumber: number, now: Date): Date | null {
  if (attemptNumber >= PROVISIONING_MAX_ATTEMPTS) return null
  return new Date(now.getTime() + (attemptNumber === 1 ? 5 : 30) * 60 * 1000)
}

async function assertPaidProvisioningLineage(ownerUserId: number, project: NonNullable<Awaited<ReturnType<ManagedSiteRepository['findProject']>>>, version: NonNullable<Awaited<ReturnType<ManagedSiteRepository['findVersion']>>>, domainIntent: NonNullable<Awaited<ReturnType<ProvisioningRepository['findDomainIntentById']>>>, managedRepository: ManagedSiteRepository, orderingRepository: PreviewRepository) {
  if (project.status === 'suspended' || project.status !== 'active') conflict('Provisioning requires an active managed-site project.')
  if (project.activeVersionId !== version.id || version.lifecycleStatus !== 'active') conflict('Provisioning requires the active validated site version.')
  const siteSpec = parseSiteSpecSnapshot(version.siteSpecSnapshot)
  const expectedVersionFingerprint = stableFingerprint({ projectId: version.projectId, version: version.version, snapshot: { siteSpecSnapshot: version.siteSpecSnapshot, designTokenSnapshot: version.designTokenSnapshot, selectedModuleSnapshot: version.selectedModuleSnapshot }, contentFingerprint: version.contentFingerprint })
  if (version.versionFingerprint !== expectedVersionFingerprint) conflict('Provisioning version fingerprint or SiteSpec lineage is invalid.')
  const subscription = await managedRepository.findSubscription(ownerUserId, project.id)
  if (!subscription || subscription.status !== 'active' || subscription.projectId !== project.id || subscription.ownerUserId !== ownerUserId) conflict('Provisioning requires an active paid subscription.')
  if (!domainIntent.draftOrderId) conflict('Provisioning requires a paid draft order lineage.')
  const order = await orderingRepository.findDraftOrderById(domainIntent.draftOrderId)
  if (!order || order.ownerUserId !== ownerUserId || order.projectId !== project.id || order.status !== 'payment_verified') conflict('Provisioning order is not a verified paid order for this project.')
  const preview = await orderingRepository.findPreviewById(order.previewId)
  const quote = await orderingRepository.findQuoteById(order.quoteId)
  const payment = await orderingRepository.findVerifiedPaymentEventByDraftOrder(order.id)
  const subscriptionIntent = await orderingRepository.findSubscriptionIntentByQuote(order.quoteId)
  if (!preview || preview.ownerUserId !== ownerUserId || !quote || quote.ownerUserId !== ownerUserId || quote.previewId !== preview.id || quote.projectId !== project.id || quote.status !== 'locked' || !payment || payment.ownerUserId !== ownerUserId || payment.previewId !== preview.id || payment.quoteId !== quote.id || payment.amountMinor !== quote.totalMinor || payment.currency !== quote.currency || payment.providerReference !== order.paymentIntentReference || !subscriptionIntent || subscriptionIntent.ownerUserId !== ownerUserId || subscriptionIntent.projectId !== project.id || subscriptionIntent.quoteId !== quote.id || subscriptionIntent.planKey !== subscription.planKey || subscriptionIntent.status !== 'entitled') conflict('Provisioning payment, quote, subscription, and project lineage is incomplete or mismatched.')
  return { project, version, domainIntent, order, quote, payment, subscription, subscriptionIntent, siteSpec }
}

function receiptExternalReference(result: any, stepKey: ProvisioningStepKey): string | null {
  if (stepKey === 'domain_registration') return typeof result.externalReference === 'string' && result.externalReference.length > 0 ? result.externalReference : null
  if (stepKey === 'tls_verification') return typeof result.certificateReference === 'string' && result.certificateReference.length > 0 ? result.certificateReference : null
  if (stepKey === 'deployment') return typeof result.externalReference === 'string' && result.externalReference.length > 0 ? result.externalReference : null
  return null
}

function validateProviderReceipt(stepKey: ProvisioningStepKey, result: any, normalizedDomain: string, platform: ProvisioningPlatform): void {
  if (!result || result.externalCalls !== false) conflict('Provisioning provider receipt is not permitted to claim an external call in V1.')
  if (stepKey === 'domain_registration' && (result.status !== 'registered' || !receiptExternalReference(result, stepKey))) conflict('Domain registration receipt is incomplete.')
  if (stepKey === 'dns_configuration' && (result.status !== 'configured' || !Array.isArray(result.records) || result.records.length < 1)) conflict('DNS configuration receipt is incomplete.')
  if (stepKey === 'tls_verification' && (result.status !== 'verified' || !receiptExternalReference(result, stepKey))) conflict('TLS verification receipt is incomplete.')
  if (stepKey === 'deployment') {
    if (result.status !== 'deployed' || !receiptExternalReference(result, stepKey) || typeof result.deployedUrl !== 'string') conflict('Deployment receipt is incomplete.')
    if (normalizePublicHttpsOrigin(result.deployedUrl) !== `https://${normalizedDomain}`) conflict('Deployment receipt URL does not match the requested domain.')
    if (result.platform !== platform) conflict('Deployment receipt platform does not match the provisioning plan.')
  }
}

export async function createManagedSiteDomainIntent(ownerUserId: number, input: DomainIntentInput, repository = getProvisioningRepository(), managedRepository: ManagedSiteRepository = getManagedSiteRepository(), clock: () => Date = () => new Date()) {
  const mode = modeFor(input.mode)
  const normalizedDomain = normalizeDomain(input.requestedDomain)
  const project = await managedRepository.findProject(ownerUserId, input.projectId)
  if (!project) notFound('Managed site project was not found.')
  if (project.status === 'suspended') conflict('Suspended managed-site projects cannot create new domain work.')
  const fingerprint = stableFingerprint({ projectId: input.projectId, normalizedDomain, mode, providerKey: input.providerKey || null })
  const replay = await repository.findDomainIntentByIdempotency(ownerUserId, input.idempotencyKey)
  if (replay) {
    if (replay.configurationFingerprint !== fingerprint) conflict('Domain intent idempotency key was already used for a different configuration.')
    return { intent: replay, replayed: true, execution: { externalCalls: false, providerConfigured: false } }
  }
  const existing = await repository.findDomainIntentByProject(ownerUserId, input.projectId)
  if (existing) {
    if (existing.configurationFingerprint !== fingerprint) conflict('This managed site project already has a different domain intent.')
    return { intent: existing, replayed: true, execution: { externalCalls: false, providerConfigured: false } }
  }
  const createdAt = clock()
  const intent = await repository.insertDomainIntent({ ownerUserId, projectId: input.projectId, draftOrderId: input.draftOrderId ?? null, mode, requestedDomain: stringField(input.requestedDomain, 'Domain', 253), normalizedDomain, ownershipStatus: mode === 'customer_owned' ? 'needs_customer_action' : 'unknown', purchaseStatus: mode === 'customer_owned' ? 'not_requested' : 'intent_created', dnsStatus: mode === 'customer_owned' ? 'pending_customer' : 'not_requested', providerKey: input.providerKey || null, providerReference: null, configurationFingerprint: fingerprint, idempotencyKey: input.idempotencyKey, createdAt, updatedAt: createdAt } as any)
  return { intent, replayed: false, execution: { externalCalls: false, providerConfigured: false } }
}

export async function createManagedSiteProvisioningPlan(ownerUserId: number, input: ProvisioningPlanInput, repository = getProvisioningRepository(), managedRepository: ManagedSiteRepository = getManagedSiteRepository(), clock: () => Date = () => new Date(), orderingRepository?: PreviewRepository) {
  const platform = platformFor(input.platform)
  const deploymentMode = provisioningMode(input.deploymentMode)
  const project = await managedRepository.findProject(ownerUserId, input.projectId)
  const version = await managedRepository.findVersion(ownerUserId, input.versionId)
  const domainIntent = await repository.findDomainIntentById(input.domainIntentId)
  if (!project || !version || version.projectId !== input.projectId || !domainIntent || domainIntent.projectId !== input.projectId || domainIntent.ownerUserId !== ownerUserId) notFound('Managed site provisioning lineage was not found.')
  if (project.status === 'suspended') conflict('Suspended managed-site projects cannot create new provisioning work.')
  if (deploymentMode !== 'preview_only') await assertPaidProvisioningLineage(ownerUserId, project, version, domainIntent, managedRepository, orderingRepository || getPreviewRepository())
  const intentFingerprint = stableFingerprint({ ownerUserId, projectId: input.projectId, versionId: input.versionId, domainIntentId: input.domainIntentId, platform, deploymentMode })
  const replay = await repository.findPlanByIdempotency(ownerUserId, input.idempotencyKey)
  if (replay) {
    if (replay.intentFingerprint !== intentFingerprint) conflict('Provisioning plan idempotency key was already used for a different configuration.')
    return { plan: replay, steps: await repository.listSteps(replay.id), replayed: true }
  }
  const existing = await repository.findPlanByFingerprint(ownerUserId, intentFingerprint)
  if (existing) return { plan: existing, steps: await repository.listSteps(existing.id), replayed: true }
  const createdAt = validDate(clock(), 'Provisioning clock')
  const plan = await repository.transaction(async transaction => {
    const created = await transaction.insertPlan({ ownerUserId, projectId: input.projectId, versionId: input.versionId, domainIntentId: input.domainIntentId, platform, deploymentMode, status: deploymentMode === 'preview_only' ? 'draft' : 'awaiting_authorization', domainStatus: 'not_started', dnsStatus: 'not_started', tlsStatus: 'not_started', deploymentStatus: 'not_started', intentFingerprint, idempotencyKey: input.idempotencyKey, providerProjectReference: null, providerDeploymentReference: null, deployedUrl: null, tlsCertificateReference: null, leaseOwner: null, leaseExpiresAt: null, retryEligibleAt: null, createdAt, updatedAt: createdAt } as any)
    const steps = []
    for (const [ordinal, stepKey] of PROVISIONING_STEPS.entries()) steps.push(await transaction.insertStep({ ownerUserId, projectId: input.projectId, planId: created.id, stepKey, ordinal: ordinal + 1, status: 'pending', providerKey: stepKey === 'domain_registration' ? domainIntent.providerKey : platform, attemptNumber: 0, inputFingerprint: stableFingerprint({ planId: created.id, stepKey, domain: domainIntent.normalizedDomain, platform, versionId: input.versionId }), outputFingerprint: null, errorCode: null, errorSummary: null, externalReference: null, completedAt: null, createdAt, updatedAt: createdAt } as any))
    return { plan: created, steps }
  })
  return { ...plan, replayed: false }
}

function eventInput(ownerUserId: number, plan: any, step: any, eventType: string, executionMode: ProvisioningExecutionMode, status: 'planned' | 'blocked' | 'succeeded' | 'failed', providerKey: string | null, externalReference: string | null, metadata: Record<string, unknown>) {
  const receiptFingerprint = stableFingerprint({
    ownerUserId,
    planId: plan.id,
    stepId: step.id,
    eventType,
    executionMode,
    status,
    providerKey,
    receipt: {
      domain: metadata.normalizedDomain ?? null,
      platform: metadata.platform ?? null,
      stepKey: metadata.stepKey ?? null,
      attemptNumber: metadata.attemptNumber ?? null,
      externalReference,
      deployedUrl: metadata.deployedUrl ?? null,
      certificateReference: metadata.certificateReference ?? null,
    },
  })
  return { ownerUserId, projectId: plan.projectId, planId: plan.id, stepId: step.id, eventType, executionMode, status, providerKey, externalReference, receiptFingerprint, metadata }
}

function retryable(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const candidate = error as { retryable?: unknown; statusCode?: unknown; code?: unknown }
  if (candidate.retryable === true) return true
  if (candidate.statusCode === 429 || (typeof candidate.statusCode === 'number' && candidate.statusCode >= 500)) return true
  return ['ETIMEDOUT', 'ECONNRESET', 'ENETUNREACH', 'EAI_AGAIN', 'TIMEOUT', 'NETWORK_ERROR'].includes(String(candidate.code || '').toUpperCase())
}

function safeErrorSummary(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error)
  return raw.replace(/[\\r\\n\\t]+/gu, ' ').slice(0, 480) || 'Provisioning provider operation failed.'
}

export async function executeManagedSiteProvisioningPlan(ownerUserId: number, planId: number, executionMode: ProvisioningExecutionMode = 'dry_run', adapters: ProvisioningAdapters = FAIL_CLOSED_PROVISIONING_ADAPTERS, repository = getProvisioningRepository(), managedRepository: ManagedSiteRepository = getManagedSiteRepository(), clock: () => Date = () => new Date(), orderingRepository?: PreviewRepository) {
  if (!['dry_run', 'mocked', 'external'].includes(executionMode)) invalid('Provisioning execution mode is invalid.')
  const initialPlan = await repository.findPlanById(planId)
  if (!initialPlan || initialPlan.ownerUserId !== ownerUserId) notFound('Managed site provisioning plan was not found.')
  if (executionMode === 'external') throw createError({ statusCode: 403, statusMessage: 'External provisioning is disabled in this V1 environment.' })
  const initialProject = await managedRepository.findProject(ownerUserId, initialPlan.projectId)
  if (!initialProject) notFound('Managed site provisioning lineage was not found.')
  if (initialProject.status === 'suspended') conflict('Suspended managed-site projects cannot execute provisioning work.')
  if (executionMode === 'dry_run') {
    const domainIntent = await repository.findDomainIntentById(initialPlan.domainIntentId)
    if (!domainIntent) notFound('Managed site provisioning lineage was not found.')
    const steps = await repository.listSteps(initialPlan.id)
    const events = await repository.transaction(async transaction => {
      for (const step of steps) {
        await transaction.insertEvent(eventInput(ownerUserId, initialPlan, step, `provisioning_${step.stepKey}`, 'dry_run', 'planned', step.providerKey, null, {
          sequence: step.ordinal,
          attemptNumber: step.attemptNumber,
          stepKey: step.stepKey,
          normalizedDomain: domainIntent.normalizedDomain,
          platform: initialPlan.platform,
          providerConfigured: false,
          externalCalls: false,
          deployedUrl: null,
          certificateReference: null,
          stepStatus: step.status,
          limitation: 'Dry-run only; no adapter was invoked and no provider success is claimed.',
        }) as any)
      }
      return transaction.listEvents(ownerUserId, initialPlan.id)
    })
    return { plan: initialPlan, steps, events, results: steps.map(step => ({ stepKey: step.stepKey, status: 'planned' as const, providerConfigured: false, externalCalls: false, limitation: 'Dry-run only; no adapter was invoked and no provider success is claimed.', stepId: step.id })), externalCalls: false, providerConfigured: false, executionMode }
  }
  const nowDate = validDate(clock(), 'Provisioning clock')
  const leaseOwner = `provisioning:${randomBytes(24).toString('base64url')}`
  const plan = await repository.transaction(transaction => transaction.acquirePlanLease(ownerUserId, planId, leaseOwner, nowDate, PROVISIONING_LEASE_MS))
  if (!plan) conflict('Provisioning plan is already leased, terminal, or not yet retry-eligible.')
  const release = async (patch: Record<string, unknown>) => repository.releasePlanLease(ownerUserId, planId, leaseOwner, { ...patch, updatedAt: validDate(clock(), 'Provisioning clock') } as any)
  try {
    const project = await managedRepository.findProject(ownerUserId, plan.projectId)
    const version = await managedRepository.findVersion(ownerUserId, plan.versionId)
    const domainIntent = await repository.findDomainIntentById(plan.domainIntentId)
    if (!project || !version || !domainIntent || domainIntent.projectId !== project.id || version.projectId !== project.id) notFound('Managed site provisioning lineage was not found.')
    if (project.status === 'suspended') conflict('Suspended managed-site projects cannot execute provisioning work.')
    await assertPaidProvisioningLineage(ownerUserId, project, version, domainIntent, managedRepository, orderingRepository || getPreviewRepository())
    const steps = await repository.listSteps(plan.id)
    const results: Array<Record<string, unknown>> = []
    let hasRetryWait = false
    let maxRetryAttempt = 0
    let hasFailure = false
    let domainStatus: any = plan.domainStatus
    let dnsStatus: any = plan.dnsStatus
    let tlsStatus: any = plan.tlsStatus
    let deploymentStatus: any = plan.deploymentStatus
    let providerProjectReference: string | null = plan.providerProjectReference
    let providerDeploymentReference: string | null = plan.providerDeploymentReference
    let deployedUrl: string | null = plan.deployedUrl
    let tlsCertificateReference: string | null = plan.tlsCertificateReference
    for (const step of steps) {
      const stepKey = PROVISIONING_STEPS.find(candidate => candidate === step.stepKey)
      if (!stepKey) conflict('Provisioning step key is not allowlisted.')
      if (step.status === 'succeeded') {
        if (stepKey === 'domain_intent') domainStatus = domainIntent.mode === 'customer_owned' ? 'awaiting_customer' : domainStatus
        if (stepKey === 'domain_registration') { domainStatus = domainStatus === 'not_started' ? 'provider_pending' : domainStatus; providerProjectReference = providerProjectReference || step.externalReference }
        if (stepKey === 'dns_configuration') dnsStatus = dnsStatus === 'not_started' ? 'provider_pending' : dnsStatus
        if (stepKey === 'tls_verification') { tlsStatus = tlsStatus === 'not_started' ? 'verified' : tlsStatus; tlsCertificateReference = tlsCertificateReference || step.externalReference }
        if (stepKey === 'deployment') { deploymentStatus = deploymentStatus === 'not_started' ? 'built' : deploymentStatus; providerDeploymentReference = providerDeploymentReference || step.externalReference }
        results.push({ stepKey, status: step.status, replayed: true, externalCalls: false, providerConfigured: false, externalReference: step.externalReference, deployedUrl: stepKey === 'deployment' ? deployedUrl : null }); continue
      }
      const canRetryStep = step.status === 'retry_wait' || (step.status === 'failed' && step.errorCode === 'RETRYABLE_PROVIDER_FAILURE')
      const dependencyRecheck = step.status === 'blocked' && step.errorCode === 'DEPENDENCY_BLOCKED'
      if (step.status !== 'pending' && !canRetryStep && !dependencyRecheck) {
        if (step.status === 'retry_wait') {
          hasRetryWait = true
          maxRetryAttempt = Math.max(maxRetryAttempt, step.attemptNumber)
        }
        if (step.status === 'failed') hasFailure = true
        results.push({ stepKey, status: step.status, replayed: true, externalCalls: false, providerConfigured: false, limitation: step.errorSummary || 'Persisted provisioning step state was not retryable.', stepId: step.id, externalReference: step.externalReference, deployedUrl: stepKey === 'deployment' ? deployedUrl : null })
        continue
      }
      const changedAt = validDate(clock(), 'Provisioning clock')
      let result: any
      let stepStatus: 'succeeded' | 'blocked' | 'retry_wait' | 'failed' = 'blocked'
      let errorCode: string | null = null
      let errorSummary: string | null = null
      const dependencyBlocked = results.some(item => item.status === 'blocked' || item.status === 'retry_wait' || item.status === 'failed')
      if (dependencyBlocked) {
        result = { status: 'blocked', normalizedDomain: domainIntent.normalizedDomain, externalCalls: false, limitation: 'Step dependency is blocked; downstream adapters were not invoked.' }
        stepStatus = 'blocked'
        errorCode = 'DEPENDENCY_BLOCKED'
        errorSummary = result.limitation
      } else {
        try {
          if (stepKey === 'domain_intent') {
            result = { status: 'planned', normalizedDomain: domainIntent.normalizedDomain, externalCalls: false, limitation: 'Intent recorded only; domain ownership and registration are not verified.' }
            stepStatus = 'succeeded'
            domainStatus = domainIntent.mode === 'customer_owned' ? 'awaiting_customer' : 'not_started'
          } else if (stepKey === 'domain_registration') {
            if (domainIntent.mode === 'customer_owned') {
              result = { status: 'planned', normalizedDomain: domainIntent.normalizedDomain, externalCalls: false, limitation: 'Customer-owned domain registration is not requested; customer DNS authorization remains pending.' }
              stepStatus = 'succeeded'
              domainStatus = 'awaiting_customer'
            } else {
              const availability = await adapters.checkDomainAvailability({ normalizedDomain: domainIntent.normalizedDomain, providerKey: domainIntent.providerKey })
              if (availability.externalCalls !== false || availability.status !== 'available' || availability.normalizedDomain !== domainIntent.normalizedDomain) {
                result = { status: 'blocked', normalizedDomain: domainIntent.normalizedDomain, externalCalls: false, limitation: 'Domain availability was not verified by an injected provider-safe mock.' }
                errorCode = 'DOMAIN_AVAILABILITY_NOT_VERIFIED'
                errorSummary = result.limitation
              } else {
                result = await adapters.registerDomain({ normalizedDomain: domainIntent.normalizedDomain, providerKey: domainIntent.providerKey })
                validateProviderReceipt(stepKey, result, domainIntent.normalizedDomain, plan.platform)
                stepStatus = 'succeeded'
                domainStatus = 'provider_pending'
                providerProjectReference = receiptExternalReference(result, stepKey)
              }
            }
          } else if (stepKey === 'dns_configuration') {
            if (domainIntent.mode === 'customer_owned' && !['customer_confirmed', 'provider_verified'].includes(domainIntent.ownershipStatus)) {
              result = { status: 'blocked', normalizedDomain: domainIntent.normalizedDomain, externalCalls: false, limitation: 'Customer-owned domain authorization has not been confirmed; DNS adapter was not invoked.' }
              errorCode = 'CUSTOMER_DOMAIN_AUTHORIZATION_REQUIRED'
              errorSummary = result.limitation
            } else {
              result = await adapters.configureDns({ normalizedDomain: domainIntent.normalizedDomain, platform: plan.platform })
              validateProviderReceipt(stepKey, result, domainIntent.normalizedDomain, plan.platform)
              stepStatus = 'succeeded'
              dnsStatus = 'provider_pending'
            }
          } else if (stepKey === 'tls_verification') {
            result = await adapters.verifyTls({ normalizedDomain: domainIntent.normalizedDomain, platform: plan.platform })
            validateProviderReceipt(stepKey, result, domainIntent.normalizedDomain, plan.platform)
            stepStatus = 'succeeded'
            tlsStatus = 'verified'
            tlsCertificateReference = receiptExternalReference(result, stepKey)
          } else {
            result = await adapters.deploySite({ normalizedDomain: domainIntent.normalizedDomain, platform: plan.platform, projectId: plan.projectId, versionId: plan.versionId })
            validateProviderReceipt(stepKey, result, domainIntent.normalizedDomain, plan.platform)
            stepStatus = 'succeeded'
            deploymentStatus = 'built'
            providerDeploymentReference = receiptExternalReference(result, stepKey)
            deployedUrl = normalizePublicHttpsOrigin(result.deployedUrl)

          }
        } catch (error) {
          result = { status: 'blocked', normalizedDomain: domainIntent.normalizedDomain, externalCalls: false, limitation: safeErrorSummary(error) }
          if (retryable(error) && step.attemptNumber + 1 < PROVISIONING_MAX_ATTEMPTS) {
            stepStatus = 'retry_wait'
            hasRetryWait = true
            errorCode = 'RETRYABLE_PROVIDER_FAILURE'
            errorSummary = result.limitation
          } else {
            stepStatus = 'failed'
            hasFailure = true
            errorCode = errorCode || 'PROVISIONING_RECEIPT_OR_PROVIDER_FAILURE'
            errorSummary = errorSummary || result.limitation
          }
        }
      }
      if (stepStatus === 'blocked') {
        if (errorCode === null) errorCode = 'PROVISIONING_BLOCKED'
        if (errorSummary === null) errorSummary = typeof result?.limitation === 'string' ? result.limitation : 'Provisioning step is blocked.'
      }
      if (stepStatus === 'retry_wait') {
        hasRetryWait = true
        maxRetryAttempt = Math.max(maxRetryAttempt, step.attemptNumber + 1)
      }
      if (stepStatus === 'failed') hasFailure = true
      const outputFingerprint = stableFingerprint({ result: { status: result?.status, normalizedDomain: result?.normalizedDomain, platform: result?.platform, externalCalls: result?.externalCalls, externalReference: receiptExternalReference(result, stepKey), deployedUrl: stepKey === 'deployment' && typeof result?.deployedUrl === 'string' ? normalizePublicHttpsOrigin(result.deployedUrl) : null, certificateReference: stepKey === 'tls_verification' ? receiptExternalReference(result, stepKey) : null, limitation: result?.limitation }, stepStatus, errorCode, errorSummary })
      const attemptNumber = step.attemptNumber + 1
      const updatedStep = await repository.updateStep(step.id, { status: stepStatus, attemptNumber, outputFingerprint, errorCode, errorSummary, externalReference: receiptExternalReference(result, stepKey), completedAt: stepStatus === 'succeeded' ? changedAt : null, updatedAt: changedAt } as any)
      const eventStatus = stepStatus === 'succeeded' ? 'succeeded' : stepStatus === 'failed' ? 'failed' : 'blocked'
      await repository.insertEvent(eventInput(ownerUserId, plan, step, `provisioning_${stepKey}`, executionMode, eventStatus, step.providerKey, receiptExternalReference(result, stepKey), { sequence: step.ordinal, attemptNumber, stepKey: stepKey, normalizedDomain: domainIntent.normalizedDomain, platform: plan.platform, providerConfigured: false, externalCalls: false, stepStatus, errorCode, externalReference: receiptExternalReference(result, stepKey), deployedUrl: stepKey === 'deployment' && typeof result?.deployedUrl === 'string' ? normalizePublicHttpsOrigin(result.deployedUrl) : null, certificateReference: stepKey === 'tls_verification' ? receiptExternalReference(result, stepKey) : null, result: { status: result?.status, limitation: typeof result?.limitation === 'string' ? result.limitation.slice(0, 480) : null } }) as any)
      results.push({ stepKey: stepKey, status: stepStatus, providerConfigured: false, externalCalls: false, limitation: result?.limitation, stepId: updatedStep?.id || step.id, externalReference: receiptExternalReference(result, stepKey), deployedUrl: stepKey === 'deployment' && typeof result?.deployedUrl === 'string' ? normalizePublicHttpsOrigin(result.deployedUrl) : null })
    }
          const finalStatus = hasFailure ? 'failed' : hasRetryWait ? 'retry_wait' : results.some(item => item.status === 'blocked') ? 'blocked' : 'succeeded'

    const updatedPlan = await release({ status: finalStatus, domainStatus, dnsStatus, tlsStatus, deploymentStatus, providerProjectReference, providerDeploymentReference, deployedUrl, tlsCertificateReference, retryEligibleAt: finalStatus === 'retry_wait' ? retryAt(maxRetryAttempt || 1, nowDate) : null })
    if (!updatedPlan) conflict('Provisioning plan lease was lost before the receipt was committed.')
    return { plan: updatedPlan, steps: await repository.listSteps(plan.id), events: await repository.listEvents(ownerUserId, plan.id), results, externalCalls: false, providerConfigured: false, executionMode }
  } catch (error) {
    await release({ status: 'blocked', retryEligibleAt: null, errorCode: 'PROVISIONING_LINEAGE_OR_RUNTIME_BLOCKED' } as any).catch(() => null)
    throw error
  }
}

export async function getManagedSiteProvisioningWorkspace(ownerUserId: number, projectId: number, managedRepository: ManagedSiteRepository = getManagedSiteRepository()) {
  const project = await managedRepository.findProject(ownerUserId, projectId)
  if (!project) notFound('Managed site project was not found.')
  return getProvisioningWorkspace()
}

export { MANAGED_SITE_SESSION_TTL_MS }

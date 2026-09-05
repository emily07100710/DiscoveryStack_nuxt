import type {
  ManagedSiteConnectorAttempt,
  ManagedSiteConnectorReceipt,
  ManagedSiteDomainClaim,
  ManagedSiteGateResult,
  ManagedSiteGenerationCandidate,
  ManagedSiteModuleFulfilment,
  ManagedSiteProviderConfiguration,
  ManagedSitePrePurchaseBinding,
  ManagedSitePaymentWebhookInbox,
  ManagedSiteReleaseProjection,
} from '../../../server/database/schema'
import type { ManagedSiteLiveConnectorRepository } from '../../../server/managed-sites/live-connectors/types'

type State = {
  configurations: ManagedSiteProviderConfiguration[]
  candidates: ManagedSiteGenerationCandidate[]
  releases: ManagedSiteReleaseProjection[]
  attempts: ManagedSiteConnectorAttempt[]
  receipts: ManagedSiteConnectorReceipt[]
  bindings: ManagedSitePrePurchaseBinding[]
  gates: ManagedSiteGateResult[]
  domainClaims: ManagedSiteDomainClaim[]
  paymentWebhookInbox: ManagedSitePaymentWebhookInbox[]
  moduleFulfilments: ManagedSiteModuleFulfilment[]
  nextId: number
}

function copy<T>(value: T): T { return structuredClone(value) }

export function createLiveConnectorMemoryRepository() {
  const state: State = { configurations: [], candidates: [], releases: [], attempts: [], receipts: [], bindings: [], gates: [], domainClaims: [], paymentWebhookInbox: [], moduleFulfilments: [], nextId: 1 }
  let queue = Promise.resolve()
  const insert = <T extends { id: number }>(rows: T[], input: Omit<T, 'id'>): T => { const row = { ...input, id: state.nextId++ } as T; rows.push(row); return row }
  const make = (): ManagedSiteLiveConnectorRepository => ({
    async transaction(work) {
      const previous = queue
      let release!: () => void
      queue = new Promise(resolve => { release = resolve })
      await previous
      const snapshot = copy(state)
      try { return await work(make()) } catch (error) { Object.assign(state, snapshot); throw error } finally { release() }
    },
    async findProviderConfiguration(ownerUserId, capability) { return state.configurations.find(row => row.ownerUserId === ownerUserId && row.capability === capability) || null },
    async listProviderConfigurations(ownerUserId) { return state.configurations.filter(row => row.ownerUserId === ownerUserId) },
    async findProviderConfigurationByFingerprint(ownerUserId, fingerprint) { return state.configurations.find(row => row.ownerUserId === ownerUserId && row.configurationFingerprint === fingerprint) || null },
    async insertProviderConfiguration(input) { const now = new Date(); return insert(state.configurations, { ...input, createdAt: now, updatedAt: now } as Omit<ManagedSiteProviderConfiguration, 'id'>) },
    async updateProviderConfiguration(ownerUserId, id, patch) { const row = state.configurations.find(item => item.ownerUserId === ownerUserId && item.id === id); if (!row) return null; Object.assign(row, patch, { updatedAt: new Date() }); return row },
    async verifyProviderConfigurationCas(ownerUserId, id, expectedFingerprint, patch) { const row = state.configurations.find(item => item.ownerUserId === ownerUserId && item.id === id && item.configurationFingerprint === expectedFingerprint && item.readinessStatus === 'configured'); if (!row) return null; Object.assign(row, patch, { updatedAt: new Date() }); return row },
    async findModuleFulfilment(ownerUserId, draftOrderId, moduleKey) { return state.moduleFulfilments.find(row => row.ownerUserId === ownerUserId && row.draftOrderId === draftOrderId && row.moduleKey === moduleKey) || null },
    async insertModuleFulfilment(input) { const existing = state.moduleFulfilments.find(row => row.draftOrderId === input.draftOrderId && row.moduleKey === input.moduleKey); if (existing) { if (existing.ownerUserId === input.ownerUserId && existing.quoteId === input.quoteId && existing.mode === input.mode) return existing; throw Object.assign(new Error('module fulfilment collision'), { statusCode: 409 }) } const now = new Date(); return insert(state.moduleFulfilments, { ...input, createdAt: now, updatedAt: now } as Omit<ManagedSiteModuleFulfilment, 'id'>) },
    async listModuleFulfilmentsByDraftOrder(ownerUserId, draftOrderId) { return state.moduleFulfilments.filter(row => row.ownerUserId === ownerUserId && row.draftOrderId === draftOrderId).sort((left, right) => left.id - right.id) },
    async listPendingManualModuleFulfilments(ownerUserId) { return state.moduleFulfilments.filter(row => row.ownerUserId === ownerUserId && row.status === 'pending_manual_setup').sort((left, right) => left.id - right.id) },
    async closePendingManualModuleFulfilment(ownerUserId, draftOrderId, moduleKey, completedAt) { const row = state.moduleFulfilments.find(item => item.ownerUserId === ownerUserId && item.draftOrderId === draftOrderId && item.moduleKey === moduleKey && item.status === 'pending_manual_setup'); if (!row) return null; Object.assign(row, { status: 'manual_setup_completed', customerVisibleStatus: '客服已完成設定', ownerActionRequired: false, completedAt, updatedAt: completedAt }); return row },
    async findPrePurchaseBinding(ownerUserId, projectId) { return state.bindings.find(row => row.ownerUserId === ownerUserId && row.projectId === projectId) || null },
    async findPrePurchaseBindingByIdempotency(ownerUserId, key) { return state.bindings.find(row => row.ownerUserId === ownerUserId && row.idempotencyKey === key) || null },
    async insertPrePurchaseBinding(input) { if (state.bindings.some(row => row.projectId === input.projectId || row.draftOrderId === input.draftOrderId || row.ownerUserId === input.ownerUserId && (row.idempotencyKey === input.idempotencyKey || row.requestFingerprint === input.requestFingerprint))) throw Object.assign(new Error('prepurchase collision'), { statusCode: 409 }); return insert(state.bindings, { ...input, createdAt: new Date() } as Omit<ManagedSitePrePurchaseBinding, 'id'>) },
    async findGenerationCandidate(ownerUserId, candidateId) { return state.candidates.find(row => row.ownerUserId === ownerUserId && row.id === candidateId) || null },
    async findGenerationCandidateByIdempotency(ownerUserId, key) { return state.candidates.find(row => row.ownerUserId === ownerUserId && row.idempotencyKey === key) || null },
    async findGenerationCandidateByRequest(ownerUserId, fingerprint) { return state.candidates.find(row => row.ownerUserId === ownerUserId && row.requestFingerprint === fingerprint) || null },
    async insertGenerationCandidate(input) { if (state.candidates.some(row => row.ownerUserId === input.ownerUserId && (row.idempotencyKey === input.idempotencyKey || row.requestFingerprint === input.requestFingerprint) || row.providerKey === input.providerKey && row.providerRequestId === input.providerRequestId)) throw Object.assign(new Error('candidate collision'), { statusCode: 409 }); return insert(state.candidates, { ...input, createdAt: new Date() } as Omit<ManagedSiteGenerationCandidate, 'id'>) },
    async listGenerationCandidates(ownerUserId, projectId) { return state.candidates.filter(row => row.ownerUserId === ownerUserId && row.projectId === projectId) },
    async findRelease(ownerUserId, releaseId) { return state.releases.find(row => row.ownerUserId === ownerUserId && row.id === releaseId) || null },
    async findReleaseByIdempotency(ownerUserId, key) { return state.releases.find(row => row.ownerUserId === ownerUserId && row.idempotencyKey === key) || null },
    async insertRelease(input) { if (state.releases.some(row => row.ownerUserId === input.ownerUserId && row.idempotencyKey === input.idempotencyKey || row.projectId === input.projectId && row.targetKey === input.targetKey && row.contentHash === input.contentHash)) throw Object.assign(new Error('release collision'), { statusCode: 409 }); const now = new Date(); return insert(state.releases, { ...input, createdAt: now, updatedAt: now } as Omit<ManagedSiteReleaseProjection, 'id'>) },
    async transitionRelease(ownerUserId, releaseId, expectedStatus, expectedFingerprint, patch) { const row = state.releases.find(item => item.ownerUserId === ownerUserId && item.id === releaseId && item.status === expectedStatus && item.projectionFingerprint === expectedFingerprint); if (!row) return null; Object.assign(row, patch, { updatedAt: new Date() }); return row },
    async listReleases(ownerUserId, projectId) { return state.releases.filter(row => row.ownerUserId === ownerUserId && row.projectId === projectId) },
    async insertGateResult(input) { const existing = state.gates.find(row => row.releaseId === input.releaseId && row.gateType === input.gateType && row.inputFingerprint === input.inputFingerprint); if (existing) { if (existing.receiptFingerprint !== input.receiptFingerprint) throw Object.assign(new Error('gate collision'), { statusCode: 409 }); return existing } return insert(state.gates, input as Omit<ManagedSiteGateResult, 'id'>) },
    async listGateResults(ownerUserId, releaseId) { return state.gates.filter(row => row.ownerUserId === ownerUserId && row.releaseId === releaseId) },
    async findDomainClaim(canonicalDomain) { return state.domainClaims.find(row => row.activeCanonicalDomainKey === canonicalDomain) || null },
    async findDomainClaimByRelease(ownerUserId, releaseId) { return state.domainClaims.find(row => row.ownerUserId === ownerUserId && row.releaseId === releaseId) || null },
    async findDomainClaimByIdempotency(ownerUserId, key) { return state.domainClaims.find(row => row.ownerUserId === ownerUserId && row.idempotencyKey === key) || null },
    async insertDomainClaim(input) { const activeCanonicalDomainKey = input.status === 'released' ? null : input.canonicalDomain; const existing = state.domainClaims.find(row => activeCanonicalDomainKey !== null && row.activeCanonicalDomainKey === activeCanonicalDomainKey || row.releaseId === input.releaseId || row.ownerUserId === input.ownerUserId && row.idempotencyKey === input.idempotencyKey); if (existing) { if (existing.ownerUserId === input.ownerUserId && existing.idempotencyKey === input.idempotencyKey && existing.requestFingerprint === input.requestFingerprint) return existing; throw Object.assign(new Error('domain claim collision'), { statusCode: 409 }) } const now = new Date(); return insert(state.domainClaims, { ...input, activeCanonicalDomainKey, createdAt: now, updatedAt: now } as Omit<ManagedSiteDomainClaim, 'id'>) },
    async transitionDomainClaim(ownerUserId, claimId, expectedStatus, expectedFingerprint, patch) { const row = state.domainClaims.find(item => item.ownerUserId === ownerUserId && item.id === claimId && item.status === expectedStatus && item.projectionFingerprint === expectedFingerprint); if (!row) return null; Object.assign(row, patch, { activeCanonicalDomainKey: patch.status === 'released' ? null : row.canonicalDomain, updatedAt: new Date() }); return row },
    async findPaymentWebhookInbox(providerKey, providerEventId) { return state.paymentWebhookInbox.find(row => row.providerKey === providerKey && row.providerEventId === providerEventId) || null },
    async insertPaymentWebhookInbox(input) { const existing = state.paymentWebhookInbox.find(row => row.providerKey === input.providerKey && row.providerEventId === input.providerEventId); if (existing) { if (existing.eventFingerprint !== input.eventFingerprint) throw Object.assign(new Error('payment inbox collision'), { statusCode: 409 }); return existing } return insert(state.paymentWebhookInbox, input as Omit<ManagedSitePaymentWebhookInbox, 'id'>) },
    async transitionPaymentWebhookInbox(inboxId, expectedStatus, expectedFingerprint, patch) { const row = state.paymentWebhookInbox.find(item => item.id === inboxId && item.processingStatus === expectedStatus && item.processingFingerprint === expectedFingerprint); if (!row) return null; Object.assign(row, patch); return row },
    async findAttempt(ownerUserId, attemptId) { return state.attempts.find(row => row.ownerUserId === ownerUserId && row.id === attemptId) || null },
    async findAttemptByIdempotency(ownerUserId, key) { return state.attempts.find(row => row.ownerUserId === ownerUserId && row.idempotencyKey === key) || null },
    async insertAttempt(input) { if (state.attempts.some(row => row.ownerUserId === input.ownerUserId && (row.idempotencyKey === input.idempotencyKey || row.requestFingerprint === input.requestFingerprint))) throw Object.assign(new Error('attempt collision'), { statusCode: 409 }); const now = new Date(); return insert(state.attempts, { ...input, createdAt: now, updatedAt: now } as Omit<ManagedSiteConnectorAttempt, 'id'>) },
    async updateAttempt(ownerUserId, attemptId, patch) { const row = state.attempts.find(item => item.ownerUserId === ownerUserId && item.id === attemptId); if (!row) return null; Object.assign(row, patch, { updatedAt: new Date() }); return row },
    async acquireAttemptLease(ownerUserId, attemptId, leaseOwner, now, leaseMs) {
      const row = state.attempts.find(item => item.ownerUserId === ownerUserId && item.id === attemptId)
      if (!row) return null
      const eligible = row.status === 'queued' || row.status === 'retry_wait' && (!row.retryEligibleAt || row.retryEligibleAt.getTime() <= now.getTime()) || row.status === 'processing' && (!row.leaseExpiresAt || row.leaseExpiresAt.getTime() < now.getTime())
      if (!eligible) return null
      Object.assign(row, { status: 'processing', leaseOwner, leaseExpiresAt: new Date(now.getTime() + leaseMs), retryEligibleAt: null, updatedAt: now })
      return row
    },
    async releaseAttemptLease(ownerUserId, attemptId, leaseOwner, patch) { const row = state.attempts.find(item => item.ownerUserId === ownerUserId && item.id === attemptId && item.status === 'processing' && item.leaseOwner === leaseOwner); if (!row) return null; Object.assign(row, patch, { leaseOwner: null, leaseExpiresAt: null, updatedAt: new Date() }); return row },
    async listAttempts(ownerUserId, projectId) { return state.attempts.filter(row => row.ownerUserId === ownerUserId && row.projectId === projectId) },
    async listEligibleRetryAttempts(now, limit, ownerUserId) { return state.attempts.filter(row => row.status === 'retry_wait' && Boolean(row.retryEligibleAt && row.retryEligibleAt.getTime() <= now.getTime()) && (!ownerUserId || row.ownerUserId === ownerUserId)).sort((left, right) => (left.retryEligibleAt?.getTime() || 0) - (right.retryEligibleAt?.getTime() || 0) || left.id - right.id).slice(0, Math.min(Math.max(limit, 1), 50)) },
    async findReceiptByProviderEvent(providerKey, providerEventId) { return state.receipts.find(row => row.providerKey === providerKey && row.providerEventId === providerEventId) || null },
    async findPaymentReceiptsByProviderObjectIds(providerKey, providerObjectIds) {
      const ids = new Set(providerObjectIds)
      return state.receipts.filter(row => {
        if (row.capability !== 'payment' || row.providerKey !== providerKey || !['verified', 'ignored_out_of_order'].includes(row.receiptStatus)) return false
        const metadata = row.metadata && typeof row.metadata === 'object' && !Array.isArray(row.metadata) ? row.metadata as Record<string, unknown> : {}
        return Boolean(row.externalReference && ids.has(row.externalReference)) || ['stripeCheckoutSessionId', 'stripePaymentIntentId', 'stripeChargeId', 'stripeInvoiceId', 'stripeSubscriptionId'].some(key => typeof metadata[key] === 'string' && ids.has(metadata[key] as string))
      }).slice(0, 20)
    },
    async findVerifiedDomainReceipt(canonicalDomain) { return state.receipts.find(row => row.canonicalDomain === canonicalDomain && row.receiptStatus === 'verified' && ['domain_registered', 'existing_site_ownership_verified'].includes(row.receiptType)) || null },
    async findReceiptByFingerprint(ownerUserId, fingerprint) { return state.receipts.find(row => row.ownerUserId === ownerUserId && row.receiptFingerprint === fingerprint) || null },
    async findOwnershipChallengeByReference(projectId, canonicalDomain, challengeReference) { return state.receipts.find(row => row.projectId === projectId && row.canonicalDomain === canonicalDomain && row.externalReference === challengeReference && row.receiptType === 'existing_site_challenge_created' && row.receiptStatus === 'verified') || null },
    async insertReceipt(input) { const existing = state.receipts.find(row => row.providerKey === input.providerKey && row.providerEventId === input.providerEventId); if (existing) { if (existing.receiptFingerprint !== input.receiptFingerprint) throw Object.assign(new Error('provider event collision'), { statusCode: 409 }); return existing } return insert(state.receipts, input as Omit<ManagedSiteConnectorReceipt, 'id'>) },
    async listReceipts(ownerUserId, projectId) { return state.receipts.filter(row => row.ownerUserId === ownerUserId && row.projectId === projectId) },
    async listReceiptsByDraftOrder(ownerUserId, draftOrderId) { return state.receipts.filter(row => row.ownerUserId === ownerUserId && row.draftOrderId === draftOrderId) },
  })
  return { repository: make(), state }
}

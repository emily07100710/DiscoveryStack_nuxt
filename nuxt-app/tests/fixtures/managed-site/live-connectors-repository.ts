import type {
  ManagedSiteConnectorAttempt,
  ManagedSiteConnectorReceipt,
  ManagedSiteDomainClaim,
  ManagedSiteGateResult,
  ManagedSiteGenerationCandidate,
  ManagedSiteProviderConfiguration,
  ManagedSitePrePurchaseBinding,
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
  nextId: number
}

function copy<T>(value: T): T { return structuredClone(value) }

export function createLiveConnectorMemoryRepository() {
  const state: State = { configurations: [], candidates: [], releases: [], attempts: [], receipts: [], bindings: [], gates: [], domainClaims: [], nextId: 1 }
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
    async findDomainClaim(canonicalDomain) { return state.domainClaims.find(row => row.canonicalDomain === canonicalDomain) || null },
    async findDomainClaimByIdempotency(ownerUserId, key) { return state.domainClaims.find(row => row.ownerUserId === ownerUserId && row.idempotencyKey === key) || null },
    async insertDomainClaim(input) { const existing = state.domainClaims.find(row => row.canonicalDomain === input.canonicalDomain || row.releaseId === input.releaseId || row.ownerUserId === input.ownerUserId && row.idempotencyKey === input.idempotencyKey); if (existing) { if (existing.ownerUserId === input.ownerUserId && existing.idempotencyKey === input.idempotencyKey && existing.requestFingerprint === input.requestFingerprint) return existing; throw Object.assign(new Error('domain claim collision'), { statusCode: 409 }) } const now = new Date(); return insert(state.domainClaims, { ...input, createdAt: now, updatedAt: now } as Omit<ManagedSiteDomainClaim, 'id'>) },
    async transitionDomainClaim(ownerUserId, claimId, expectedStatus, expectedFingerprint, patch) { const row = state.domainClaims.find(item => item.ownerUserId === ownerUserId && item.id === claimId && item.status === expectedStatus && item.projectionFingerprint === expectedFingerprint); if (!row) return null; Object.assign(row, patch, { updatedAt: new Date() }); return row },
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
    async findReceiptByProviderEvent(providerKey, providerEventId) { return state.receipts.find(row => row.providerKey === providerKey && row.providerEventId === providerEventId) || null },
    async findVerifiedDomainReceipt(canonicalDomain) { return state.receipts.find(row => row.canonicalDomain === canonicalDomain && row.receiptStatus === 'verified' && ['domain_registered', 'existing_site_ownership_verified'].includes(row.receiptType)) || null },
    async findReceiptByFingerprint(ownerUserId, fingerprint) { return state.receipts.find(row => row.ownerUserId === ownerUserId && row.receiptFingerprint === fingerprint) || null },
    async insertReceipt(input) { const existing = state.receipts.find(row => row.providerKey === input.providerKey && row.providerEventId === input.providerEventId); if (existing) { if (existing.receiptFingerprint !== input.receiptFingerprint) throw Object.assign(new Error('provider event collision'), { statusCode: 409 }); return existing } return insert(state.receipts, input as Omit<ManagedSiteConnectorReceipt, 'id'>) },
    async listReceipts(ownerUserId, projectId) { return state.receipts.filter(row => row.ownerUserId === ownerUserId && row.projectId === projectId) },
    async listReceiptsByDraftOrder(ownerUserId, draftOrderId) { return state.receipts.filter(row => row.ownerUserId === ownerUserId && row.draftOrderId === draftOrderId) },
  })
  return { repository: make(), state }
}

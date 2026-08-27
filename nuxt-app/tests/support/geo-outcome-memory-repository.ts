import { fingerprint } from '../../server/geo-outcome-model/canonical'
import { observationIdentity } from '../../server/geo-outcome-model/observation-contract'
import { projectAuthoritativeEvidenceBinding } from '../../server/geo-outcome-model/evidence-resolver'
import type { AuthoritativeEvidenceSource, DatasetDecision, DatasetManifest, DatasetMember, GeoOutcomeRepositoryPort, MemoryGeoOutcomeRepository, MemoryGeoOutcomeState, ModelArtifact, ModelDecision, MutationClaim, MutationClaimResult, ObservationGovernanceAction, ObservationVerificationDecision, OutcomeObservation, TrainingRun, TrainingRunClaimResult } from '../../server/geo-outcome-model/types'

function clone<T>(value: T): T { return structuredClone(value) }
function assertOwner(expected: number, actual: number) { if (expected !== actual) throw new Error('Owner scope mismatch.') }
function claimKey(ownerUserId: number, routeIdentity: string, idempotencyKey: string) { return `${ownerUserId}:${routeIdentity}:${idempotencyKey}` }

export class InMemoryGeoOutcomeRepository implements MemoryGeoOutcomeRepository {
  private state: MemoryGeoOutcomeState
  private lock: Promise<void> = Promise.resolve()
  constructor(initial?: MemoryGeoOutcomeState) {
    this.state = initial ? { ...clone(initial), datasetDecisions: clone(initial.datasetDecisions || []), evidenceBindings: clone(initial.evidenceBindings || []), authoritativeEvidenceSources: clone(initial.authoritativeEvidenceSources || []) } : { observations: [], datasets: [], datasetMembers: {}, trainingRuns: [], artifacts: [], datasetDecisions: [], decisions: [], verificationDecisions: [], evidenceBindings: [], authoritativeEvidenceSources: [], claims: [] }
  }
  exportState(): MemoryGeoOutcomeState { return clone(this.state) }
  seedAuthoritativeEvidence(source: AuthoritativeEvidenceSource): void { this.state.authoritativeEvidenceSources.push(clone(source)) }

  private projectGovernance(observation: OutcomeObservation): OutcomeObservation {
    if (observation.verificationAuthority === 'consumer_surface_server') return clone(observation)
    const facts = this.state.verificationDecisions.filter(item => item.ownerUserId === observation.ownerUserId && item.observationFingerprint === observation.observationFingerprint)
    const revoked = facts.some(item => item.factType === 'revocation' && item.factStatus === 'revoked')
    const evidence = facts.some(item => item.factType === 'evidence_verification' && item.factStatus === 'approved')
    const consent = facts.some(item => item.factType === 'consent_review' && item.factStatus === 'approved')
    const pii = facts.some(item => item.factType === 'pii_review' && item.factStatus === 'approved')
    const reviewFingerprint = facts.length ? fingerprint(facts.map(item => item.decisionFingerprint).sort()) : null
    return { ...observation, verificationStatus: revoked ? 'revoked' : evidence && consent && pii ? 'verified' : 'unverified', consentStatus: revoked ? 'revoked' : consent ? 'approved' : 'unknown', piiStatus: revoked ? 'unknown' : pii ? 'clean' : 'unknown', verificationAuthority: evidence && consent && pii ? 'owner_review' : 'intake', reviewFingerprint }
  }
  async listObservations(ownerUserId: number) { return clone(this.state.observations.filter(o => o.ownerUserId === ownerUserId).map(o => this.projectGovernance(o))) }
  async getObservation(ownerUserId: number, observationFingerprint: string) { const row = this.state.observations.find(o => o.ownerUserId === ownerUserId && o.observationFingerprint === observationFingerprint); return row ? clone(this.projectGovernance(row)) : null }
  async saveObservationTransactional(ownerUserId: number, observation: OutcomeObservation) {
    assertOwner(ownerUserId, observation.ownerUserId)
    return this.withLock(async () => {
      const existing = this.state.observations.find(o => o.ownerUserId === ownerUserId && o.observationFingerprint === observation.observationFingerprint)
      if (existing) return clone(existing)
      if (this.state.observations.some(o => o.ownerUserId === ownerUserId && observationIdentity(o) === observationIdentity(observation))) throw new Error('Duplicate candidate identity collision.')
      this.state.observations.push(clone(observation)); this.state.observations.sort((a, b) => a.observationFingerprint < b.observationFingerprint ? -1 : a.observationFingerprint > b.observationFingerprint ? 1 : 0)
      return clone(observation)
    })
  }
  async bindAuthoritativeEvidenceTransactional(ownerUserId: number, observationFingerprint: string, sourceRecordId: number) {
    return this.withLock(async () => {
      const observation = this.state.observations.find(item => item.ownerUserId === ownerUserId && item.observationFingerprint === observationFingerprint)
      if (!observation) throw new Error('Observation not found.')
      const source = this.state.authoritativeEvidenceSources.find(item => item.ownerUserId === ownerUserId && item.sourceRecordId === sourceRecordId)
      if (!source) throw new Error('Authoritative LLM visibility evidence was not found for this owner.')
      const binding = projectAuthoritativeEvidenceBinding(ownerUserId, observation, source)
      const existing = this.state.evidenceBindings.find(item => item.ownerUserId === ownerUserId && item.observationFingerprint === observationFingerprint && item.sourceKind === binding.sourceKind && item.sourceRecordId === sourceRecordId)
      if (existing) { if (fingerprint({ ...existing, createdAt: null }) !== fingerprint({ ...binding, createdAt: null })) throw new Error('Authoritative evidence binding collision.'); return clone(existing) }
      this.state.evidenceBindings.push(clone(binding))
      return clone(binding)
    })
  }
  async verifyObservationTransactional(ownerUserId: number, observationFingerprint: string, reviewerUserId: number, action: ObservationGovernanceAction, reason: string, evidenceLocatorHash: string | null = null) {
    return this.withLock(async () => {
      const index = this.state.observations.findIndex(o => o.ownerUserId === ownerUserId && o.observationFingerprint === observationFingerprint)
      if (index < 0) throw new Error('Observation not found.')
      const current = this.state.observations[index]
      if (!current) throw new Error('Observation not found.')
      if (this.state.verificationDecisions.some(item => item.ownerUserId === ownerUserId && item.observationFingerprint === observationFingerprint && item.factType === 'revocation')) throw new Error('Observation version is terminally revoked.')
      const factType = action === 'verify_evidence' ? 'evidence_verification' : action === 'approve_consent' ? 'consent_review' : action === 'approve_pii' ? 'pii_review' : 'revocation'
      if (this.state.verificationDecisions.some(item => item.ownerUserId === ownerUserId && item.observationFingerprint === observationFingerprint && item.factType === factType)) throw new Error('Duplicate governance fact.')
      if (action === 'verify_evidence') {
        if (!evidenceLocatorHash || !current.evidenceLocatorHashes.includes(evidenceLocatorHash)) throw new Error('Evidence locator is not approved for this observation.')
        const resolved = this.state.evidenceBindings.find(item => item.ownerUserId === ownerUserId && item.observationFingerprint === observationFingerprint && item.evidenceLocatorHash === evidenceLocatorHash && item.purpose === 'geo_outcome_verification' && item.sourceKind === 'llm_visibility_observation' && item.sourceResponseHash === current.evidenceSnapshotHash)
        if (!resolved) throw new Error('Evidence locator has not been bound from authoritative owner-scoped consumer-surface evidence.')
      } else if (evidenceLocatorHash !== null) throw new Error('Only evidence verification may include an evidence locator.')
      const before = this.projectGovernance(current)
      const factStatus = action === 'revoke' ? 'revoked' : 'approved'
      const decisionFingerprint = fingerprint({ ownerUserId, observationFingerprint, reviewerUserId, factType, factStatus, reason, evidenceLocatorHash })
      const ledger: ObservationVerificationDecision = { decisionId: `geo-governance-${decisionFingerprint.slice(0, 20)}`, ownerUserId, observationFingerprint, reviewerUserId, previousVerificationStatus: before.verificationStatus, newVerificationStatus: action === 'verify_evidence' ? 'verified' : action === 'revoke' ? 'revoked' : before.verificationStatus, evidenceLocatorHash, factType, factStatus, reason, decisionFingerprint, consentStatus: action === 'approve_consent' ? 'approved' : action === 'revoke' ? 'revoked' : before.consentStatus, piiStatus: action === 'approve_pii' ? 'clean' : before.piiStatus, createdAt: new Date().toISOString() }
      this.state.verificationDecisions.push(clone(ledger))
      const updated = this.projectGovernance(current)
      return { observation: clone(updated), verificationDecision: clone(ledger) }
    })
  }

  async listDatasets(ownerUserId: number) { return clone(this.state.datasets.filter(d => d.ownerUserId === ownerUserId)) }
  async getDataset(ownerUserId: number, manifestId: string) { return clone(this.state.datasets.find(d => d.ownerUserId === ownerUserId && d.manifestId === manifestId) || null) }
  async getDatasetMembers(ownerUserId: number, manifestId: string) { const dataset = this.state.datasets.find(d => d.ownerUserId === ownerUserId && d.manifestId === manifestId); if (!dataset) return []; return clone(this.state.datasetMembers[manifestId] || []) }
  async saveDatasetTransactional(ownerUserId: number, manifest: DatasetManifest, members: DatasetMember[]) {
    assertOwner(ownerUserId, manifest.ownerUserId); members.forEach(member => assertOwner(ownerUserId, member.observation.ownerUserId))
    return this.withLock(async () => {
      const existing = this.state.datasets.find(d => d.ownerUserId === ownerUserId && d.manifestFingerprint === manifest.manifestFingerprint)
      if (existing) return clone(existing)
      if (this.state.datasets.some(d => d.ownerUserId === ownerUserId && d.manifestId === manifest.manifestId)) throw new Error('Dataset manifest collision.')
      this.state.datasets.push(clone(manifest)); this.state.datasetMembers[manifest.manifestId] = clone(members); return clone(manifest)
    })
  }
  async transitionDatasetWithDecision(ownerUserId: number, manifestId: string, status: DatasetManifest['status'], reviewerUserId: number, reason: string) {
    return this.withLock(async () => {
      const index = this.state.datasets.findIndex(d => d.ownerUserId === ownerUserId && d.manifestId === manifestId)
      if (index < 0) throw new Error('Dataset manifest not found.')
      const current = this.state.datasets[index]!; if (current.status === 'revoked' || current.status === 'archived') throw new Error('Dataset is terminal and cannot be modified.')
      if (status === 'approved' && current.status !== 'ready_for_review') throw new Error('Only ready_for_review datasets may be approved.')
      if (status !== 'approved' && status !== 'revoked') throw new Error('Dataset review may only approve or revoke.')
      const decisionFingerprint = fingerprint({ ownerUserId, manifestId, previousStatus: current.status, newStatus: status, reviewerUserId, reason, manifestFingerprint: current.manifestFingerprint })
      const decision: DatasetDecision = { decisionId: `geo-dataset-decision-${decisionFingerprint.slice(0, 20)}`, ownerUserId, manifestId, previousStatus: current.status, newStatus: status, reviewerUserId, reason, manifestFingerprint: current.manifestFingerprint, createdAt: new Date().toISOString() }
      if (this.state.datasetDecisions.some(item => item.decisionId === decision.decisionId)) throw new Error('Duplicate or stale dataset decision.')
      const updated = { ...current, status }; this.state.datasets.splice(index, 1, updated); this.state.datasetDecisions.push(clone(decision)); return { manifest: clone(updated), decision: clone(decision) }
    })
  }
  async listDatasetDecisions(ownerUserId: number) { return clone(this.state.datasetDecisions.filter(item => item.ownerUserId === ownerUserId)) }

  async createTrainingRun(ownerUserId: number, run: TrainingRun) { assertOwner(ownerUserId, run.ownerUserId); return this.withLock(async () => { if (this.state.trainingRuns.some(r => r.ownerUserId === ownerUserId && r.trainingRunId === run.trainingRunId)) throw new Error('Training run collision.'); this.state.trainingRuns.push(clone(run)); return clone(run) }) }
  async getTrainingRun(ownerUserId: number, trainingRunId: string) { return clone(this.state.trainingRuns.find(r => r.ownerUserId === ownerUserId && r.trainingRunId === trainingRunId) || null) }
  async claimTrainingRun(ownerUserId: number, trainingRunId: string, leaseOwner: string, leaseExpiresAt: string): Promise<TrainingRunClaimResult> {
    return this.withLock(async () => {
      const index = this.state.trainingRuns.findIndex(r => r.ownerUserId === ownerUserId && r.trainingRunId === trainingRunId)
      if (index < 0) throw new Error('Training run not found.')
      const current = this.state.trainingRuns[index]!
      if (current.status === 'completed') return { outcome: 'replay', run: clone(current) }
      const nowTime = Date.now(); const expires = current.leaseExpiresAt ? new Date(current.leaseExpiresAt).getTime() : 0
      if (current.status === 'running' && expires > nowTime) return { outcome: 'in_progress', run: clone(current) }
      if (current.status !== 'queued' && !(current.status === 'running' && expires <= nowTime)) return { outcome: 'collision', run: clone(current) }
      const outcome = current.status === 'running' ? 'stale_recovered' : 'claimed'
      const updated: TrainingRun = { ...current, status: 'running', startedAt: current.startedAt || new Date().toISOString(), leaseOwner, leaseExpiresAt, version: current.version + 1 }
      this.state.trainingRuns.splice(index, 1, clone(updated))
      return { outcome, run: clone(updated) }
    })
  }
  async transitionTrainingRun(ownerUserId: number, trainingRunId: string, patch: Partial<TrainingRun>) { return this.withLock(async () => { const index = this.state.trainingRuns.findIndex(r => r.ownerUserId === ownerUserId && r.trainingRunId === trainingRunId); if (index < 0) throw new Error('Training run not found.'); const updated = { ...this.state.trainingRuns[index]!, ...patch, version: this.state.trainingRuns[index]!.version + 1 }; this.state.trainingRuns.splice(index, 1, clone(updated)); return clone(updated) }) }
  async listTrainingRuns(ownerUserId: number) { return clone(this.state.trainingRuns.filter(r => r.ownerUserId === ownerUserId)) }

  async saveArtifactTransactional(ownerUserId: number, artifact: ModelArtifact) { assertOwner(ownerUserId, artifact.ownerUserId); return this.withLock(async () => { const existing = this.state.artifacts.find(a => a.ownerUserId === ownerUserId && a.artifactHash === artifact.artifactHash); if (existing) return clone(existing); if (this.state.artifacts.some(a => a.ownerUserId === ownerUserId && a.artifactId === artifact.artifactId)) throw new Error('Artifact collision.'); this.state.artifacts.push(clone(artifact)); return clone(artifact) }) }
  async getArtifact(ownerUserId: number, artifactId: string) { return clone(this.state.artifacts.find(a => a.ownerUserId === ownerUserId && a.artifactId === artifactId) || null) }
  async listArtifacts(ownerUserId: number) { return clone(this.state.artifacts.filter(a => a.ownerUserId === ownerUserId)) }
  async markArtifactShadowFailed(ownerUserId: number, artifactId: string) {
    return this.withLock(async () => {
      const index = this.state.artifacts.findIndex(artifact => artifact.ownerUserId === ownerUserId && artifact.artifactId === artifactId)
      if (index < 0) throw new Error('Model artifact not found.')
      const current = this.state.artifacts[index]!
      if (current.status === 'revoked') return clone(current)
      if (current.status !== 'approved_for_shadow' && current.status !== 'shadow_failed') throw new Error('Only an approved shadow artifact may be marked shadow_failed.')
      const updated = { ...current, status: 'shadow_failed' as const }
      this.state.artifacts.splice(index, 1, clone(updated))
      return clone(updated)
    })
  }
  async transitionArtifactWithDecision(ownerUserId: number, artifactId: string, nextStatus: ModelArtifact['status'], reviewerUserId: number, reason: string, datasetManifestHash: string, rollbackArtifactHash: string | null = null) {
    return this.withLock(async () => {
      const index = this.state.artifacts.findIndex(a => a.ownerUserId === ownerUserId && a.artifactId === artifactId); if (index < 0) throw new Error('Model artifact not found.')
      const current = this.state.artifacts[index]!; if (current.status === 'revoked') throw new Error('Revoked models cannot be restored.')
      if (nextStatus === 'approved_for_shadow' && current.status !== 'ready_for_owner_review') throw new Error('Only ready_for_owner_review artifacts may be approved.')
      const decision: ModelDecision = { decisionId: `geo-decision-${fingerprint({ ownerUserId, artifactId, previousStatus: current.status, newStatus: nextStatus, reason, artifactHash: current.artifactHash }).slice(0, 20)}`, ownerUserId, modelArtifactId: artifactId, previousStatus: current.status, newStatus: nextStatus, reviewerUserId, reason, artifactHash: current.artifactHash, datasetManifestHash, createdAt: new Date().toISOString() }
      if (this.state.decisions.some(d => d.decisionId === decision.decisionId)) throw new Error('Duplicate or stale decision.')
      const updated = { ...current, status: nextStatus, revokedAt: nextStatus === 'revoked' ? new Date().toISOString() : null }
      this.state.artifacts.splice(index, 1, updated); this.state.decisions.push(clone(decision)); return { artifact: clone(updated), decision: clone(decision) }
    })
  }
  async listDecisions(ownerUserId: number) { return clone(this.state.decisions.filter(d => d.ownerUserId === ownerUserId)) }

  async claimMutation(ownerUserId: number, routeIdentity: string, idempotencyKey: string, inputFingerprint: string): Promise<MutationClaimResult> {
    return this.withLock(async () => {
      const existing = this.state.claims.find(c => claimKey(c.ownerUserId, c.routeIdentity, c.idempotencyKey) === claimKey(ownerUserId, routeIdentity, idempotencyKey))
      if (existing) { if (existing.inputFingerprint !== inputFingerprint) return { outcome: 'collision', claim: clone(existing) }; if (existing.state === 'completed') return { outcome: 'replay', claim: clone(existing) }; if (existing.state === 'failed') { const recovered = { ...existing, state: 'claimed' as const, responseProjection: null, responseFingerprint: null, version: existing.version + 1 }; this.state.claims.splice(this.state.claims.indexOf(existing), 1, recovered); return { outcome: 'claimed', claim: clone(recovered) } } return { outcome: 'in_progress', claim: clone(existing) } }
      const claim: MutationClaim = { ownerUserId, routeIdentity, idempotencyKey, inputFingerprint, state: 'claimed', responseProjection: null, responseFingerprint: null, version: 0 }; this.state.claims.push(clone(claim)); return { outcome: 'claimed', claim: clone(claim) }
    })
  }
  async completeMutation(ownerUserId: number, routeIdentity: string, idempotencyKey: string, inputFingerprint: string, responseProjection: unknown) { return this.updateClaim(ownerUserId, routeIdentity, idempotencyKey, inputFingerprint, { state: 'completed', responseProjection, responseFingerprint: fingerprint(responseProjection) }) }
  async failMutation(ownerUserId: number, routeIdentity: string, idempotencyKey: string, inputFingerprint: string, responseProjection: unknown) { return this.updateClaim(ownerUserId, routeIdentity, idempotencyKey, inputFingerprint, { state: 'failed', responseProjection }) }
  private async updateClaim(ownerUserId: number, routeIdentity: string, idempotencyKey: string, inputFingerprint: string, patch: Partial<MutationClaim>) { return this.withLock(async () => { const index = this.state.claims.findIndex(c => claimKey(c.ownerUserId, c.routeIdentity, c.idempotencyKey) === claimKey(ownerUserId, routeIdentity, idempotencyKey)); if (index < 0) throw new Error('Mutation claim not found.'); const current = this.state.claims[index]!; if (current.inputFingerprint !== inputFingerprint) throw new Error('Idempotency collision.'); const updated = { ...current, ...patch, version: current.version + 1 }; this.state.claims.splice(index, 1, updated); return clone(updated) }) }

  async transaction<T>(work: (repository: GeoOutcomeRepositoryPort) => Promise<T>): Promise<T> { const snapshot = clone(this.state); try { return await work(this) } catch (error) { this.state = snapshot; throw error } }
  private async withLock<T>(work: () => Promise<T>): Promise<T> { const previous = this.lock; let release!: () => void; this.lock = new Promise<void>(resolve => { release = resolve }); await previous; try { return await work() } finally { release() } }
}

export function createMemoryGeoOutcomeRepository(initial?: MemoryGeoOutcomeState): MemoryGeoOutcomeRepository { return new InMemoryGeoOutcomeRepository(initial) }

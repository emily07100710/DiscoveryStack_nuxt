import { fingerprint } from './canonical'
import type {
  MemoryModelOpsState,
  ModelOpsCycle,
  ModelOpsCycleClaimResult,
  ModelOpsEvent,
  ModelOpsPolicy,
  ModelOpsRepositoryPort,
  ModelOpsRollbackDecision,
  ModelOpsShadowEvaluation,
} from './modelops-types'

const clone = <T>(value: T): T => structuredClone(value)
const assertOwner = (expected: number, actual: number) => { if (expected !== actual) throw new Error('Owner scope mismatch.') }
const now = () => Date.now()

export class InMemoryModelOpsRepository implements ModelOpsRepositoryPort {
  private state: MemoryModelOpsState
  private lock: Promise<void> = Promise.resolve()

  constructor(initial?: MemoryModelOpsState) {
    this.state = clone(initial || { policies: [], cycles: [], events: [], shadowEvaluations: [], rollbackDecisions: [] })
  }

  exportState(): MemoryModelOpsState { return clone(this.state) }

  async listPolicies(ownerUserId: number) { return clone(this.state.policies.filter(item => item.ownerUserId === ownerUserId)) }
  async listEnabledOwnerUserIds(limit: number) { if (!Number.isSafeInteger(limit) || limit < 1 || limit > 25) throw new Error('Scheduler owner limit is bounded to 1-25.'); const owners = [...new Set(this.state.policies.filter(item => item.status === 'enabled' && (!item.expiresAt || new Date(item.expiresAt).getTime() > now())).map(item => item.ownerUserId))].sort((a, b) => a - b); return owners.slice(0, limit) }
  async getPolicy(ownerUserId: number, policyId: string) { return clone(this.state.policies.find(item => item.ownerUserId === ownerUserId && item.policyId === policyId) || null) }
  async savePolicy(ownerUserId: number, policy: ModelOpsPolicy) {
    assertOwner(ownerUserId, policy.ownerUserId)
    return this.withLock(async () => {
      const samePolicyId = this.state.policies.find(item => item.ownerUserId === ownerUserId && item.policyId === policy.policyId)
      if (samePolicyId) { if (samePolicyId.configurationFingerprint !== policy.configurationFingerprint) throw new Error('Policy idempotency collision.'); return clone(samePolicyId) }
      const sameFingerprint = this.state.policies.find(item => item.ownerUserId === ownerUserId && item.configurationFingerprint === policy.configurationFingerprint && item.status !== 'revoked')
      if (sameFingerprint) return clone(sameFingerprint)
      if (this.state.policies.some(item => item.ownerUserId === ownerUserId && item.policyId === policy.policyId)) throw new Error('Policy collision.')
      this.state.policies.push(clone(policy))
      return clone(policy)
    })
  }
  async updatePolicy(ownerUserId: number, policyId: string, patch: Partial<ModelOpsPolicy>) {
    return this.withLock(async () => {
      const index = this.state.policies.findIndex(item => item.ownerUserId === ownerUserId && item.policyId === policyId)
      if (index < 0) throw new Error('Policy not found.')
      const current = this.state.policies[index]!
      if (current.status === 'revoked') throw new Error('Revoked policy is terminal; create a new policy version.')
      if (patch.ownerUserId !== undefined && patch.ownerUserId !== ownerUserId) throw new Error('Owner scope mismatch.')
      if (patch.status === 'enabled' && (!patch.authorizedByOwnerUserId || !patch.authorizedAt)) throw new Error('Enabling a policy requires server-derived owner authorization.')
      if (patch.status === 'enabled' && patch.expiresAt && new Date(patch.expiresAt).getTime() <= now()) throw new Error('Cannot enable an expired policy.')
      const updated: ModelOpsPolicy = { ...current, ...clone(patch), ownerUserId, updatedAt: new Date().toISOString() }
      if (patch.status === 'revoked') updated.revokedAt = patch.revokedAt || new Date().toISOString()
      this.state.policies.splice(index, 1, clone(updated))
      return clone(updated)
    })
  }

  async listCycles(ownerUserId: number) { return clone(this.state.cycles.filter(item => item.ownerUserId === ownerUserId)) }
  async getCycle(ownerUserId: number, cycleId: string) { return clone(this.state.cycles.find(item => item.ownerUserId === ownerUserId && item.cycleId === cycleId) || null) }
  async saveCycle(ownerUserId: number, cycle: ModelOpsCycle) {
    assertOwner(ownerUserId, cycle.ownerUserId)
    return this.withLock(async () => {
      const sameInput = this.state.cycles.find(item => item.ownerUserId === ownerUserId && item.inputFingerprint === cycle.inputFingerprint)
      if (sameInput) return clone(sameInput)
      if (this.state.cycles.some(item => item.ownerUserId === ownerUserId && item.cycleId === cycle.cycleId)) throw new Error('Cycle collision.')
      if (this.state.cycles.some(item => item.ownerUserId === ownerUserId && item.idempotencyKey === cycle.idempotencyKey)) throw new Error('Cycle idempotency collision.')
      this.state.cycles.push(clone(cycle))
      return clone(cycle)
    })
  }
  async claimCycle(ownerUserId: number, cycleId: string, leaseOwner: string, leaseExpiresAt: string): Promise<ModelOpsCycleClaimResult> {
    return this.withLock(async () => {
      const index = this.state.cycles.findIndex(item => item.ownerUserId === ownerUserId && item.cycleId === cycleId)
      if (index < 0) throw new Error('Cycle not found.')
      const current = this.state.cycles[index]!
      if (current.status === 'completed' || current.status === 'insufficient_data' || current.status === 'blocked') return { outcome: 'replay', cycle: clone(current) }
      const expires = current.leaseExpiresAt ? new Date(current.leaseExpiresAt).getTime() : 0
      if (current.status === 'running' && expires > now()) return { outcome: 'in_progress', cycle: clone(current) }
      if (current.status === 'failed') return { outcome: 'collision', cycle: clone(current) }
      const stale = current.status === 'running' && expires <= now()
      const updated: ModelOpsCycle = { ...current, status: 'running', startedAt: current.startedAt || new Date().toISOString(), leaseOwner, leaseExpiresAt, attempt: current.attempt + 1, updatedAt: new Date().toISOString() }
      this.state.cycles.splice(index, 1, clone(updated))
      return { outcome: stale ? 'stale_recovered' : 'claimed', cycle: clone(updated) }
    })
  }
  async updateCycle(ownerUserId: number, cycleId: string, patch: Partial<ModelOpsCycle>) {
    return this.withLock(async () => {
      const index = this.state.cycles.findIndex(item => item.ownerUserId === ownerUserId && item.cycleId === cycleId)
      if (index < 0) throw new Error('Cycle not found.')
      if (patch.ownerUserId !== undefined && patch.ownerUserId !== ownerUserId) throw new Error('Owner scope mismatch.')
      const current = this.state.cycles[index]!
      const updated: ModelOpsCycle = { ...current, ...clone(patch), ownerUserId, updatedAt: new Date().toISOString() }
      this.state.cycles.splice(index, 1, clone(updated))
      return clone(updated)
    })
  }

  async appendEvent(ownerUserId: number, event: ModelOpsEvent) {
    assertOwner(ownerUserId, event.ownerUserId)
    return this.withLock(async () => {
      const existing = this.state.events.find(item => item.ownerUserId === ownerUserId && item.eventId === event.eventId)
      if (existing) {
        if (existing.eventFingerprint !== event.eventFingerprint) throw new Error('Event collision.')
        return clone(existing)
      }
      if (this.state.events.some(item => item.ownerUserId === ownerUserId && item.eventFingerprint === event.eventFingerprint)) return clone(this.state.events.find(item => item.ownerUserId === ownerUserId && item.eventFingerprint === event.eventFingerprint)!)
      this.state.events.push(clone(event))
      return clone(event)
    })
  }
  async listEvents(ownerUserId: number, cycleId?: string) { return clone(this.state.events.filter(item => item.ownerUserId === ownerUserId && (!cycleId || item.cycleId === cycleId)).sort((a, b) => a.createdAt.localeCompare(b.createdAt))) }

  async saveShadowEvaluation(ownerUserId: number, evaluation: ModelOpsShadowEvaluation) {
    assertOwner(ownerUserId, evaluation.ownerUserId)
    return this.withLock(async () => {
      const existing = this.state.shadowEvaluations.find(item => item.ownerUserId === ownerUserId && item.evaluationFingerprint === evaluation.evaluationFingerprint)
      if (existing) return clone(existing)
      if (this.state.shadowEvaluations.some(item => item.ownerUserId === ownerUserId && item.evaluationId === evaluation.evaluationId)) throw new Error('Shadow evaluation collision.')
      this.state.shadowEvaluations.push(clone(evaluation))
      return clone(evaluation)
    })
  }
  async listShadowEvaluations(ownerUserId: number, artifactId?: string) { return clone(this.state.shadowEvaluations.filter(item => item.ownerUserId === ownerUserId && (!artifactId || item.artifactId === artifactId))) }

  async appendRollbackDecision(ownerUserId: number, decision: ModelOpsRollbackDecision) {
    assertOwner(ownerUserId, decision.ownerUserId)
    return this.withLock(async () => {
      const existing = this.state.rollbackDecisions.find(item => item.ownerUserId === ownerUserId && item.decisionId === decision.decisionId)
      if (existing) return clone(existing)
      this.state.rollbackDecisions.push(clone(decision))
      return clone(decision)
    })
  }
  async listRollbackDecisions(ownerUserId: number) { return clone(this.state.rollbackDecisions.filter(item => item.ownerUserId === ownerUserId)) }

  async transaction<T>(work: (repository: ModelOpsRepositoryPort) => Promise<T>): Promise<T> {
    const snapshot = clone(this.state)
    try { return await work(this) } catch (error) { this.state = snapshot; throw error }
  }

  private async withLock<T>(work: () => Promise<T>): Promise<T> {
    const previous = this.lock
    let release!: () => void
    this.lock = new Promise<void>(resolve => { release = resolve })
    await previous
    try { return await work() } finally { release() }
  }
}

export function createMemoryModelOpsRepository(initial?: MemoryModelOpsState): InMemoryModelOpsRepository { return new InMemoryModelOpsRepository(initial) }
export function eventFingerprint(input: unknown): string { return fingerprint(input) }

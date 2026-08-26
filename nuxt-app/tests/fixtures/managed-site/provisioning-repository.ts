import type { ManagedSiteDomainIntent, ManagedSiteProvisioningEvent, ManagedSiteProvisioningPlan, ManagedSiteProvisioningStep } from '../../../server/database/schema'
import type { ProvisioningRepository, ProvisioningStepKey } from '../../../server/managed-sites/provisioning-types'

type State = { intents: ManagedSiteDomainIntent[]; plans: ManagedSiteProvisioningPlan[]; steps: ManagedSiteProvisioningStep[]; events: ManagedSiteProvisioningEvent[]; nextId: number }

function clone<T>(rows: T[]): T[] { return rows.map(row => ({ ...(row as any) })) }

export function createProvisioningMemoryRepository() {
  const state: State = { intents: [], plans: [], steps: [], events: [], nextId: 1 }
  const snapshot = (): State => ({ intents: clone(state.intents), plans: clone(state.plans), steps: clone(state.steps), events: clone(state.events), nextId: state.nextId })
  const insert = <T extends { id: number }>(rows: T[], input: Omit<T, 'id'>): T => { const row = { ...input, id: state.nextId++ } as T; rows.push(row); return row }
  const make = (): ProvisioningRepository => ({
    async transaction(work) { const saved = snapshot(); try { return await work(make()) } catch (error) { Object.assign(state, saved); throw error } },
    async findDomainIntentById(id) { return state.intents.find(row => row.id === id) || null },
    async findDomainIntentByProject(projectId) { return state.intents.find(row => row.projectId === projectId) || null },
    async findDomainIntentByIdempotency(key) { return state.intents.find(row => row.idempotencyKey === key) || null },
    async insertDomainIntent(input) { return insert(state.intents, input as Omit<ManagedSiteDomainIntent, 'id'>) },
    async updateDomainIntent(id, patch) { const row = state.intents.find(item => item.id === id); if (!row) return null; Object.assign(row, patch); return row },
    async findPlanById(id) { return state.plans.find(row => row.id === id) || null },
    async findPlanByFingerprint(fingerprint) { return state.plans.find(row => row.intentFingerprint === fingerprint) || null },
    async findPlanByIdempotency(key) { return state.plans.find(row => row.idempotencyKey === key) || null },
    async insertPlan(input) { return insert(state.plans, input as Omit<ManagedSiteProvisioningPlan, 'id'>) },
    async updatePlan(id, patch) { const row = state.plans.find(item => item.id === id); if (!row) return null; Object.assign(row, patch); return row },
    async findStep(planId, stepKey: ProvisioningStepKey) { return state.steps.find(row => row.planId === planId && row.stepKey === stepKey) || null },
    async listSteps(planId) { return state.steps.filter(row => row.planId === planId).sort((a, b) => a.ordinal - b.ordinal) },
    async insertStep(input) { return insert(state.steps, input as Omit<ManagedSiteProvisioningStep, 'id'>) },
    async updateStep(id, patch) { const row = state.steps.find(item => item.id === id); if (!row) return null; Object.assign(row, patch); return row },
    async findEventByFingerprint(ownerUserId, fingerprint) { return state.events.find(row => row.ownerUserId === ownerUserId && row.receiptFingerprint === fingerprint) || null },
    async insertEvent(input) { return state.events.find(row => row.ownerUserId === input.ownerUserId && row.receiptFingerprint === input.receiptFingerprint) || insert(state.events, { ...input, occurredAt: new Date() } as Omit<ManagedSiteProvisioningEvent, 'id'>) },
    async listEvents(ownerUserId, planId) { return state.events.filter(row => row.ownerUserId === ownerUserId && row.planId === planId).sort((a, b) => b.occurredAt.getTime() - a.occurredAt.getTime()) },
  })
  return { repository: make(), state }
}

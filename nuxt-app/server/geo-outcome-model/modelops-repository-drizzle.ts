import { and, asc, eq, gt, ne, sql } from 'drizzle-orm'
import { getDatabase } from '../database'
import { geoOutcomeModelopsAdvisoryAssignments, geoOutcomeModelopsCycles, geoOutcomeModelopsEvents, geoOutcomeModelopsPolicies, geoOutcomeModelopsRollbackDecisions, geoOutcomeModelopsShadowEvaluations } from '../database/schema'
import { fingerprint } from './canonical'
import type { ModelFamily } from './constants'
import type { ModelOpsAdvisoryAssignment, ModelOpsCycle, ModelOpsCycleClaimResult, ModelOpsEvent, ModelOpsLeaseFence, ModelOpsPolicy, ModelOpsRepositoryPort, ModelOpsRollbackDecision, ModelOpsShadowEvaluation } from './modelops-types'

function iso(value: Date | string | null | undefined): string | null { if (value === null || value === undefined) return null; const date = new Date(value); if (!Number.isFinite(date.getTime())) throw new Error('Corrupt durable ModelOps timestamp.'); return date.toISOString() }
function strings(value: unknown, label: string): string[] { if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) throw new Error(`Corrupt durable ${label}.`); const max = /observation fingerprints/iu.test(label) ? 10_000 : /reason|limitation|family/iu.test(label) ? 128 : 256; if (value.length > max) throw new Error(`Corrupt durable ${label}: bounded array exceeded.`); return [...value] }
function record(value: unknown, label: string): Record<string, unknown> { if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Corrupt durable ${label}.`); const entries = Object.entries(value as Record<string, unknown>); if (entries.length > 128) throw new Error(`Corrupt durable ${label}: bounded record exceeded.`); if (entries.some(([key]) => key.length > 128 || /(token|secret|credential|prompt|raw.?response|body)/iu.test(key))) throw new Error(`Corrupt durable ${label}: sensitive key.`); return Object.fromEntries(entries) }
function affectedRows(result: unknown): number { const first = Array.isArray(result) ? result[0] : result; if (!first || typeof first !== 'object' || !('affectedRows' in first) || typeof first.affectedRows !== 'number') throw new Error('Database did not return an affected-row count.'); return first.affectedRows }
function jsonValue(value: unknown): unknown { const copy = structuredClone(value); const serialized = JSON.stringify(copy); if (serialized === undefined || serialized.length > 2_000_000) throw new Error('ModelOps JSON payload exceeds the bounded durable limit.'); return copy }
function modelFamilies(value: unknown): ModelFamily[] { const values = strings(value, 'allowed model families'); const allowed: readonly ModelFamily[] = ['regularized_logistic_baseline_v1', 'pairwise_logistic_ranker_v1']; if (!values.length || values.some(item => !allowed.includes(item as ModelFamily))) throw new Error('Corrupt durable allowed model families.'); return values as ModelFamily[] }
function requiredString(value: unknown, label: string): string { if (typeof value !== 'string' || !value.trim()) throw new Error(`Corrupt durable ${label}.`); return value }

export type ModelOpsDrizzleDatabase = NonNullable<ReturnType<typeof getDatabase>> | Parameters<Parameters<NonNullable<ReturnType<typeof getDatabase>>['transaction']>[0]>[0]

export class DrizzleModelOpsRepository implements ModelOpsRepositoryPort {
  private readonly db: ModelOpsDrizzleDatabase
  private readonly clock: () => Date
  private readonly insideTransaction: boolean
  constructor(database: ModelOpsDrizzleDatabase | null = getDatabase(), clock: () => Date = () => new Date(), insideTransaction = false) { if (!database) throw new Error('ModelOps database is not configured.'); this.db = database; this.clock = clock; this.insideTransaction = insideTransaction }

  private policy(row: typeof geoOutcomeModelopsPolicies.$inferSelect): ModelOpsPolicy {
    return { policyId: row.policyId, ownerUserId: row.ownerUserId, status: row.status, cadence: row.cadence, minimumNewVerifiedCandidates: row.minimumNewVerifiedCandidates, minimumNewQueryGroups: row.minimumNewQueryGroups, minimumNewWebsites: row.minimumNewWebsites, minimumObservationSpanDays: row.minimumObservationSpanDays, allowedModelFamilies: modelFamilies(row.allowedModelFamilies), maximumTrainingRunsPerCycle: row.maximumTrainingRunsPerCycle, cooldownHours: row.cooldownHours, shadowEvaluationEnabled: row.shadowEvaluationEnabled, autonomousExecutionEnabled: row.autonomousExecutionEnabled === true, authorizedByOwnerUserId: row.authorizedByOwnerUserId, authorizedAt: iso(row.authorizedAt), expiresAt: iso(row.expiresAt), configurationFingerprint: row.configurationFingerprint, createdAt: iso(row.createdAt)!, updatedAt: iso(row.updatedAt)!, revokedAt: iso(row.revokedAt) }
  }
  private cycle(row: typeof geoOutcomeModelopsCycles.$inferSelect): ModelOpsCycle {
    return { cycleId: row.cycleId, ownerUserId: row.ownerUserId, policyId: row.policyId, policyFingerprint: row.policyFingerprint, trigger: row.trigger, status: row.status, readinessSnapshotFingerprint: row.readinessSnapshotFingerprint, eligibleObservationFingerprints: strings(row.eligibleObservationFingerprints, 'eligible observation fingerprints'), previousApprovedDatasetFingerprint: row.previousApprovedDatasetFingerprint, generatedDatasetFingerprint: row.generatedDatasetFingerprint, trainingRunId: row.trainingRunId, modelArtifactId: row.modelArtifactId, artifactHash: row.artifactHash, shadowEvaluationFingerprint: row.shadowEvaluationFingerprint, reasonCodes: strings(row.reasonCodes, 'reason codes'), limitations: strings(row.limitations, 'limitations'), errorClass: row.errorClass, startedAt: iso(row.startedAt), completedAt: iso(row.completedAt), attempt: row.attempt, leaseOwner: row.leaseOwner, leaseExpiresAt: iso(row.leaseExpiresAt), leaseVersion: row.leaseVersion, idempotencyKey: row.idempotencyKey, inputFingerprint: row.inputFingerprint, createdAt: iso(row.createdAt)!, updatedAt: iso(row.updatedAt)! }
  }
  private event(row: typeof geoOutcomeModelopsEvents.$inferSelect): ModelOpsEvent { return { eventId: row.eventId, ownerUserId: row.ownerUserId, cycleId: row.cycleId, eventType: row.eventType, eventPayload: record(row.eventPayload, 'event payload'), eventFingerprint: row.eventFingerprint, createdAt: iso(row.createdAt)! } }
  private shadow(row: typeof geoOutcomeModelopsShadowEvaluations.$inferSelect): ModelOpsShadowEvaluation { return { evaluationId: row.evaluationId, ownerUserId: row.ownerUserId, artifactId: row.artifactId, artifactHash: row.artifactHash, evaluationWindowStart: iso(row.evaluationWindowStart)!, evaluationWindowEnd: iso(row.evaluationWindowEnd)!, observationFingerprints: strings(row.observationFingerprints, 'shadow observation fingerprints'), candidateCount: row.candidateCount, positiveCount: row.positiveCount, negativeCount: row.negativeCount, queryGroupCount: row.queryGroupCount, websiteCount: row.websiteCount, engineCounts: record(row.engineCounts, 'shadow engine counts') as Record<string, number>, binaryMetrics: record(row.binaryMetrics, 'shadow binary metrics'), rankingMetrics: record(row.rankingMetrics, 'shadow ranking metrics'), calibrationDiagnostics: record(row.calibrationDiagnostics, 'calibration diagnostics'), driftDiagnostics: record(row.driftDiagnostics, 'drift diagnostics'), status: row.status, reasonCodes: strings(row.reasonCodes, 'shadow reason codes'), evaluationFingerprint: row.evaluationFingerprint, createdAt: iso(row.createdAt)! } }
  private rollback(row: typeof geoOutcomeModelopsRollbackDecisions.$inferSelect): ModelOpsRollbackDecision { return { decisionId: row.decisionId, ownerUserId: row.ownerUserId, artifactId: row.artifactId, fromArtifactHash: row.fromArtifactHash, rollbackArtifactHash: row.rollbackArtifactHash, reviewerUserId: row.reviewerUserId, reason: row.reason, decisionStatus: row.decisionStatus, createdAt: iso(row.createdAt)! } }
  private advisory(row: typeof geoOutcomeModelopsAdvisoryAssignments.$inferSelect): ModelOpsAdvisoryAssignment { if (row.productionActivation !== false) throw new Error('Corrupt durable advisory production activation state.'); return { assignmentId: row.assignmentId, ownerUserId: row.ownerUserId, policyId: row.policyId, policyFingerprint: row.policyFingerprint, currentArtifactHash: row.currentArtifactHash, candidateArtifactHash: row.candidateArtifactHash, shadowEvaluationFingerprint: row.shadowEvaluationFingerprint, cycleId: requiredString(row.cycleId, 'advisory cycle id'), candidateArtifactId: requiredString(row.candidateArtifactId, 'advisory candidate artifact id'), datasetFingerprint: requiredString(row.datasetFingerprint, 'advisory dataset fingerprint'), splitFingerprint: requiredString(row.splitFingerprint, 'advisory split fingerprint'), metricsFingerprint: requiredString(row.metricsFingerprint, 'advisory metrics fingerprint'), reasonCodes: strings(row.reasonCodes, 'advisory reason codes'), productionActivation: false, status: row.status, activeScopeKey: row.activeScopeKey, version: row.version, rollbackFromAssignmentId: row.rollbackFromAssignmentId, assignmentFingerprint: row.assignmentFingerprint, createdAt: iso(row.createdAt)!, rolledBackAt: iso(row.rolledBackAt) } }

  async listPolicies(ownerUserId: number) { const rows = await this.db.select().from(geoOutcomeModelopsPolicies).where(eq(geoOutcomeModelopsPolicies.ownerUserId, ownerUserId)).orderBy(asc(geoOutcomeModelopsPolicies.updatedAt)); return rows.map(row => this.policy(row)) }
  async listEnabledOwnerUserIds(limit: number) { if (!Number.isSafeInteger(limit) || limit < 1 || limit > 25) throw new Error('Scheduler owner limit is bounded to 1-25.'); const rows = await this.db.select({ ownerUserId: geoOutcomeModelopsPolicies.ownerUserId, expiresAt: geoOutcomeModelopsPolicies.expiresAt }).from(geoOutcomeModelopsPolicies).where(eq(geoOutcomeModelopsPolicies.status, 'enabled')).orderBy(asc(geoOutcomeModelopsPolicies.ownerUserId), asc(geoOutcomeModelopsPolicies.updatedAt)); const owners: number[] = []; for (const row of rows) { if (row.expiresAt && new Date(row.expiresAt).getTime() <= Date.now()) continue; if (!owners.includes(row.ownerUserId)) owners.push(row.ownerUserId); if (owners.length >= limit) break } return owners }
  async getPolicy(ownerUserId: number, policyId: string) { const [row] = await this.db.select().from(geoOutcomeModelopsPolicies).where(and(eq(geoOutcomeModelopsPolicies.ownerUserId, ownerUserId), eq(geoOutcomeModelopsPolicies.policyId, policyId))).limit(1); return row ? this.policy(row) : null }
  async savePolicy(ownerUserId: number, policy: ModelOpsPolicy) {
    if (policy.ownerUserId !== ownerUserId) throw new Error('Owner scope mismatch.')
    const [samePolicyId] = await this.db.select().from(geoOutcomeModelopsPolicies).where(and(eq(geoOutcomeModelopsPolicies.ownerUserId, ownerUserId), eq(geoOutcomeModelopsPolicies.policyId, policy.policyId))).limit(1)
    if (samePolicyId) { if (samePolicyId.configurationFingerprint !== policy.configurationFingerprint) throw new Error('Policy idempotency collision.'); return this.policy(samePolicyId) }
    const [same] = await this.db.select().from(geoOutcomeModelopsPolicies).where(and(eq(geoOutcomeModelopsPolicies.ownerUserId, ownerUserId), eq(geoOutcomeModelopsPolicies.configurationFingerprint, policy.configurationFingerprint), ne(geoOutcomeModelopsPolicies.status, 'revoked'))).limit(1)
    if (same) return this.policy(same)
    await this.db.insert(geoOutcomeModelopsPolicies).values({ ...policy, authorizedAt: policy.authorizedAt ? new Date(policy.authorizedAt) : null, expiresAt: policy.expiresAt ? new Date(policy.expiresAt) : null, createdAt: new Date(policy.createdAt), updatedAt: new Date(policy.updatedAt), revokedAt: policy.revokedAt ? new Date(policy.revokedAt) : null })
    const saved = await this.getPolicy(ownerUserId, policy.policyId); if (!saved) throw new Error('Policy was not persisted.'); return saved
  }
  async updatePolicy(ownerUserId: number, policyId: string, patch: Partial<ModelOpsPolicy>) {
    const current = await this.getPolicy(ownerUserId, policyId); if (!current) throw new Error('Policy not found.')
    if (current.status === 'revoked') throw new Error('Revoked policy is terminal; create a new policy version.')
    if (patch.ownerUserId !== undefined && patch.ownerUserId !== ownerUserId) throw new Error('Owner scope mismatch.')
    if (patch.status === 'enabled' && (!patch.authorizedByOwnerUserId || !patch.authorizedAt)) throw new Error('Enabling a policy requires server-derived owner authorization.')
    if (patch.status === 'enabled' && patch.expiresAt && new Date(patch.expiresAt).getTime() <= Date.now()) throw new Error('Cannot enable an expired policy.')
    const values: Record<string, unknown> = { updatedAt: new Date() }
    for (const key of ['status', 'cadence', 'minimumNewVerifiedCandidates', 'minimumNewQueryGroups', 'minimumNewWebsites', 'minimumObservationSpanDays', 'maximumTrainingRunsPerCycle', 'cooldownHours', 'shadowEvaluationEnabled', 'autonomousExecutionEnabled', 'authorizedByOwnerUserId', 'configurationFingerprint', 'revokedAt'] as const) if (patch[key] !== undefined) values[key] = patch[key]
    for (const key of ['authorizedAt', 'expiresAt'] as const) if (patch[key] !== undefined) values[key] = patch[key] ? new Date(patch[key]!) : null
    if (patch.allowedModelFamilies !== undefined) values.allowedModelFamilies = jsonValue(patch.allowedModelFamilies)
    await this.db.update(geoOutcomeModelopsPolicies).set(values as never).where(and(eq(geoOutcomeModelopsPolicies.ownerUserId, ownerUserId), eq(geoOutcomeModelopsPolicies.policyId, policyId)))
    const updated = await this.getPolicy(ownerUserId, policyId); if (!updated) throw new Error('Policy update was not persisted.'); return updated
  }

  async listCycles(ownerUserId: number) { const rows = await this.db.select().from(geoOutcomeModelopsCycles).where(eq(geoOutcomeModelopsCycles.ownerUserId, ownerUserId)).orderBy(asc(geoOutcomeModelopsCycles.createdAt)); return rows.map(row => this.cycle(row)) }
  async getCycle(ownerUserId: number, cycleId: string) { const [row] = await this.db.select().from(geoOutcomeModelopsCycles).where(and(eq(geoOutcomeModelopsCycles.ownerUserId, ownerUserId), eq(geoOutcomeModelopsCycles.cycleId, cycleId))).limit(1); return row ? this.cycle(row) : null }
  async saveCycle(ownerUserId: number, cycle: ModelOpsCycle) {
    if (cycle.ownerUserId !== ownerUserId) throw new Error('Owner scope mismatch.')
    const [same] = await this.db.select().from(geoOutcomeModelopsCycles).where(and(eq(geoOutcomeModelopsCycles.ownerUserId, ownerUserId), eq(geoOutcomeModelopsCycles.inputFingerprint, cycle.inputFingerprint))).limit(1)
    if (same) return this.cycle(same)
    await this.db.insert(geoOutcomeModelopsCycles).values({ ...cycle, eligibleObservationFingerprints: jsonValue(cycle.eligibleObservationFingerprints), reasonCodes: jsonValue(cycle.reasonCodes), limitations: jsonValue(cycle.limitations), startedAt: cycle.startedAt ? new Date(cycle.startedAt) : null, completedAt: cycle.completedAt ? new Date(cycle.completedAt) : null, leaseExpiresAt: cycle.leaseExpiresAt ? new Date(cycle.leaseExpiresAt) : null, createdAt: new Date(cycle.createdAt), updatedAt: new Date(cycle.updatedAt) })
    const saved = await this.getCycle(ownerUserId, cycle.cycleId); if (!saved) throw new Error('Cycle was not persisted.'); return saved
  }
  async claimCycle(ownerUserId: number, cycleId: string, leaseOwner: string, leaseExpiresAt: string): Promise<ModelOpsCycleClaimResult> {
    const current = await this.getCycle(ownerUserId, cycleId); if (!current) throw new Error('Cycle not found.')
    if (current.status === 'completed' || current.status === 'insufficient_data' || current.status === 'blocked') return { outcome: 'replay', cycle: current }
    const expires = current.leaseExpiresAt ? new Date(current.leaseExpiresAt).getTime() : 0
    const observedAt = this.clock()
    if (current.status === 'running' && expires > observedAt.getTime()) return { outcome: 'in_progress', cycle: current }
    if (current.status === 'failed') return { outcome: 'collision', cycle: current }
    const stale = current.status === 'running'
    const result = await this.db.update(geoOutcomeModelopsCycles).set({ status: 'running', startedAt: current.startedAt ? new Date(current.startedAt) : observedAt, leaseOwner, leaseExpiresAt: new Date(leaseExpiresAt), attempt: current.attempt + 1, leaseVersion: current.leaseVersion + 1, updatedAt: observedAt }).where(and(eq(geoOutcomeModelopsCycles.ownerUserId, ownerUserId), eq(geoOutcomeModelopsCycles.cycleId, cycleId), eq(geoOutcomeModelopsCycles.status, current.status), eq(geoOutcomeModelopsCycles.attempt, current.attempt), eq(geoOutcomeModelopsCycles.leaseVersion, current.leaseVersion)))
    if (affectedRows(result) === 1) return { outcome: stale ? 'stale_recovered' : 'claimed', cycle: (await this.getCycle(ownerUserId, cycleId))! }
    const after = await this.getCycle(ownerUserId, cycleId); if (!after) throw new Error('Cycle disappeared after compare-and-swap.')
    if (after.status === 'running') return { outcome: 'in_progress', cycle: after }
    if (after.status === 'completed' || after.status === 'blocked' || after.status === 'insufficient_data') return { outcome: 'replay', cycle: after }
    return { outcome: 'collision', cycle: after }
  }
  async assertCycleFence(ownerUserId: number, cycleId: string, fence: ModelOpsLeaseFence) {
    const observedAt = this.clock()
    if (this.insideTransaction) await this.db.execute(sql`SELECT ${geoOutcomeModelopsCycles.cycleId} FROM ${geoOutcomeModelopsCycles} WHERE ${geoOutcomeModelopsCycles.ownerUserId} = ${ownerUserId} AND ${geoOutcomeModelopsCycles.cycleId} = ${cycleId} FOR UPDATE`)
    const [row] = await this.db.select().from(geoOutcomeModelopsCycles).where(and(eq(geoOutcomeModelopsCycles.ownerUserId, ownerUserId), eq(geoOutcomeModelopsCycles.cycleId, cycleId), eq(geoOutcomeModelopsCycles.leaseOwner, fence.leaseOwner), eq(geoOutcomeModelopsCycles.leaseVersion, fence.leaseVersion), eq(geoOutcomeModelopsCycles.attempt, fence.attempt), gt(geoOutcomeModelopsCycles.leaseExpiresAt, observedAt))).limit(1)
    if (!row) throw new Error('ModelOps cycle lease fence is stale or expired.')
    return this.cycle(row)
  }
  async updateCycle(ownerUserId: number, cycleId: string, patch: Partial<ModelOpsCycle>, fence?: ModelOpsLeaseFence) {
    if (patch.ownerUserId !== undefined && patch.ownerUserId !== ownerUserId) throw new Error('Owner scope mismatch.')
    if (!fence) throw new Error('ModelOps cycle update requires a lease fence.')
    if (patch.attempt !== undefined || patch.leaseVersion !== undefined) throw new Error('ModelOps attempt and lease version are claim-owned fields.')
    const observedAt = this.clock()
    const values: Record<string, unknown> = { updatedAt: observedAt }
    for (const key of ['policyId', 'policyFingerprint', 'status', 'readinessSnapshotFingerprint', 'previousApprovedDatasetFingerprint', 'generatedDatasetFingerprint', 'trainingRunId', 'modelArtifactId', 'artifactHash', 'shadowEvaluationFingerprint', 'errorClass', 'idempotencyKey', 'inputFingerprint'] as const) if (patch[key] !== undefined) values[key] = patch[key]
    for (const key of ['eligibleObservationFingerprints', 'reasonCodes', 'limitations'] as const) if (patch[key] !== undefined) values[key] = jsonValue(patch[key])
    for (const key of ['startedAt', 'completedAt'] as const) if (patch[key] !== undefined) values[key] = patch[key] ? new Date(patch[key]!) : null
    const result = await this.db.update(geoOutcomeModelopsCycles).set(values as never).where(and(eq(geoOutcomeModelopsCycles.ownerUserId, ownerUserId), eq(geoOutcomeModelopsCycles.cycleId, cycleId), eq(geoOutcomeModelopsCycles.status, 'running'), eq(geoOutcomeModelopsCycles.leaseOwner, fence.leaseOwner), eq(geoOutcomeModelopsCycles.leaseVersion, fence.leaseVersion), eq(geoOutcomeModelopsCycles.attempt, fence.attempt), gt(geoOutcomeModelopsCycles.leaseExpiresAt, observedAt)))
    if (affectedRows(result) !== 1) throw new Error('ModelOps cycle lease fence is stale or expired.')
    const updated = await this.getCycle(ownerUserId, cycleId); if (!updated) throw new Error('Cycle update was not persisted.'); return updated
  }

  async appendEvent(ownerUserId: number, event: ModelOpsEvent, fence?: ModelOpsLeaseFence) {
    if (event.ownerUserId !== ownerUserId) throw new Error('Owner scope mismatch.')
    const cycle = await this.getCycle(ownerUserId, event.cycleId)
    if (cycle) {
      if (!fence) throw new Error('ModelOps cycle event requires a lease fence.')
      if (!this.insideTransaction) return this.transaction(transaction => transaction.appendEvent(ownerUserId, event, fence))
      await this.assertCycleFence(ownerUserId, event.cycleId, fence)
    }
    const [same] = await this.db.select().from(geoOutcomeModelopsEvents).where(and(eq(geoOutcomeModelopsEvents.ownerUserId, ownerUserId), eq(geoOutcomeModelopsEvents.eventFingerprint, event.eventFingerprint))).limit(1)
    if (same) return this.event(same)
    await this.db.insert(geoOutcomeModelopsEvents).values({ ...event, eventPayload: jsonValue(event.eventPayload), createdAt: new Date(event.createdAt) })
    const [saved] = await this.db.select().from(geoOutcomeModelopsEvents).where(and(eq(geoOutcomeModelopsEvents.ownerUserId, ownerUserId), eq(geoOutcomeModelopsEvents.eventId, event.eventId))).limit(1); if (!saved) throw new Error('Event was not persisted.'); return this.event(saved)
  }
  async listEvents(ownerUserId: number, cycleId?: string) { const rows = await this.db.select().from(geoOutcomeModelopsEvents).where(cycleId ? and(eq(geoOutcomeModelopsEvents.ownerUserId, ownerUserId), eq(geoOutcomeModelopsEvents.cycleId, cycleId)) : eq(geoOutcomeModelopsEvents.ownerUserId, ownerUserId)).orderBy(asc(geoOutcomeModelopsEvents.createdAt)); return rows.map(row => this.event(row)) }

  async saveShadowEvaluation(ownerUserId: number, evaluation: ModelOpsShadowEvaluation) {
    if (evaluation.ownerUserId !== ownerUserId) throw new Error('Owner scope mismatch.')
    const [same] = await this.db.select().from(geoOutcomeModelopsShadowEvaluations).where(and(eq(geoOutcomeModelopsShadowEvaluations.ownerUserId, ownerUserId), eq(geoOutcomeModelopsShadowEvaluations.evaluationFingerprint, evaluation.evaluationFingerprint))).limit(1)
    if (same) return this.shadow(same)
    await this.db.insert(geoOutcomeModelopsShadowEvaluations).values({ ...evaluation, observationFingerprints: jsonValue(evaluation.observationFingerprints), engineCounts: jsonValue(evaluation.engineCounts), binaryMetrics: jsonValue(evaluation.binaryMetrics), rankingMetrics: jsonValue(evaluation.rankingMetrics), calibrationDiagnostics: jsonValue(evaluation.calibrationDiagnostics), driftDiagnostics: jsonValue(evaluation.driftDiagnostics), reasonCodes: jsonValue(evaluation.reasonCodes), evaluationWindowStart: new Date(evaluation.evaluationWindowStart), evaluationWindowEnd: new Date(evaluation.evaluationWindowEnd), createdAt: new Date(evaluation.createdAt) })
    const [saved] = await this.db.select().from(geoOutcomeModelopsShadowEvaluations).where(and(eq(geoOutcomeModelopsShadowEvaluations.ownerUserId, ownerUserId), eq(geoOutcomeModelopsShadowEvaluations.evaluationId, evaluation.evaluationId))).limit(1); if (!saved) throw new Error('Shadow evaluation was not persisted.'); return this.shadow(saved)
  }
  async listShadowEvaluations(ownerUserId: number, artifactId?: string) { const rows = await this.db.select().from(geoOutcomeModelopsShadowEvaluations).where(artifactId ? and(eq(geoOutcomeModelopsShadowEvaluations.ownerUserId, ownerUserId), eq(geoOutcomeModelopsShadowEvaluations.artifactId, artifactId)) : eq(geoOutcomeModelopsShadowEvaluations.ownerUserId, ownerUserId)).orderBy(asc(geoOutcomeModelopsShadowEvaluations.createdAt)); return rows.map(row => this.shadow(row)) }

  async appendRollbackDecision(ownerUserId: number, decision: ModelOpsRollbackDecision) {
    if (decision.ownerUserId !== ownerUserId) throw new Error('Owner scope mismatch.')
    const [same] = await this.db.select().from(geoOutcomeModelopsRollbackDecisions).where(and(eq(geoOutcomeModelopsRollbackDecisions.ownerUserId, ownerUserId), eq(geoOutcomeModelopsRollbackDecisions.decisionId, decision.decisionId))).limit(1)
    if (same) return this.rollback(same)
    await this.db.insert(geoOutcomeModelopsRollbackDecisions).values({ ...decision, createdAt: new Date(decision.createdAt) })
    const [saved] = await this.db.select().from(geoOutcomeModelopsRollbackDecisions).where(and(eq(geoOutcomeModelopsRollbackDecisions.ownerUserId, ownerUserId), eq(geoOutcomeModelopsRollbackDecisions.decisionId, decision.decisionId))).limit(1); if (!saved) throw new Error('Rollback decision was not persisted.'); return this.rollback(saved)
  }
  async listRollbackDecisions(ownerUserId: number) { const rows = await this.db.select().from(geoOutcomeModelopsRollbackDecisions).where(eq(geoOutcomeModelopsRollbackDecisions.ownerUserId, ownerUserId)).orderBy(asc(geoOutcomeModelopsRollbackDecisions.createdAt)); return rows.map(row => this.rollback(row)) }

  async listAdvisoryAssignments(ownerUserId: number) { const rows = await this.db.select().from(geoOutcomeModelopsAdvisoryAssignments).where(eq(geoOutcomeModelopsAdvisoryAssignments.ownerUserId, ownerUserId)).orderBy(asc(geoOutcomeModelopsAdvisoryAssignments.createdAt)); return rows.map(row => this.advisory(row)) }
  async saveAdvisoryAssignment(ownerUserId: number, assignment: ModelOpsAdvisoryAssignment) {
    if (assignment.ownerUserId !== ownerUserId || assignment.status !== 'advisory' || assignment.activeScopeKey === null) throw new Error('Only an owner-scoped advisory assignment can be created.')
    const [replay] = await this.db.select().from(geoOutcomeModelopsAdvisoryAssignments).where(and(eq(geoOutcomeModelopsAdvisoryAssignments.ownerUserId, ownerUserId), eq(geoOutcomeModelopsAdvisoryAssignments.assignmentFingerprint, assignment.assignmentFingerprint))).limit(1)
    if (replay) return this.advisory(replay)
    await this.db.insert(geoOutcomeModelopsAdvisoryAssignments).values({ ...assignment, reasonCodes: jsonValue(assignment.reasonCodes), productionActivation: false, createdAt: new Date(assignment.createdAt), rolledBackAt: null })
    const [saved] = await this.db.select().from(geoOutcomeModelopsAdvisoryAssignments).where(and(eq(geoOutcomeModelopsAdvisoryAssignments.ownerUserId, ownerUserId), eq(geoOutcomeModelopsAdvisoryAssignments.assignmentId, assignment.assignmentId))).limit(1)
    if (!saved) throw new Error('Advisory assignment was not persisted.')
    return this.advisory(saved)
  }
  async compareAndSwapAdvisoryAssignment(ownerUserId: number, assignmentId: string, expectedVersion: number, patch: Partial<ModelOpsAdvisoryAssignment>) {
    if (patch.status !== 'rolled_back' || patch.activeScopeKey !== null || patch.version !== expectedVersion + 1 || !patch.rollbackFromAssignmentId) throw new Error('Advisory assignment CAS transition is invalid.')
    const result = await this.db.update(geoOutcomeModelopsAdvisoryAssignments).set({ status: 'rolled_back', activeScopeKey: null, version: patch.version, rollbackFromAssignmentId: patch.rollbackFromAssignmentId, reasonCodes: jsonValue(patch.reasonCodes || []), productionActivation: false, rolledBackAt: patch.rolledBackAt ? new Date(patch.rolledBackAt) : new Date() }).where(and(eq(geoOutcomeModelopsAdvisoryAssignments.ownerUserId, ownerUserId), eq(geoOutcomeModelopsAdvisoryAssignments.assignmentId, assignmentId), eq(geoOutcomeModelopsAdvisoryAssignments.status, 'advisory'), eq(geoOutcomeModelopsAdvisoryAssignments.version, expectedVersion)))
    if (affectedRows(result) !== 1) return null
    const [row] = await this.db.select().from(geoOutcomeModelopsAdvisoryAssignments).where(and(eq(geoOutcomeModelopsAdvisoryAssignments.ownerUserId, ownerUserId), eq(geoOutcomeModelopsAdvisoryAssignments.assignmentId, assignmentId))).limit(1)
    return row ? this.advisory(row) : null
  }

  async transaction<T>(work: (repository: ModelOpsRepositoryPort) => Promise<T>): Promise<T> { return this.db.transaction(async tx => work(new DrizzleModelOpsRepository(tx, this.clock, true))) }
}

export function getProductionModelOpsRepository(): ModelOpsRepositoryPort { return new DrizzleModelOpsRepository() }
export function modelOpsInputFingerprint(input: unknown): string { return fingerprint(input) }

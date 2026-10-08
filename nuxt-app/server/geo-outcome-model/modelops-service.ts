import { buildCitationSelectionDataset, getDatasetReadiness } from './dataset-builder'
import { evaluateModel } from './evaluator'
import { verifyArtifactHash } from './release-gate'
import { fingerprint } from './canonical'
import { canBePrimaryCitationTruth } from './observation-contract'
import { getWorkspace, createTrainingRun, executeTrainingRun, reviewModel, resolveApprovedFallbackForArtifact, trainingInputFingerprint } from './service'
import { splitFingerprint } from './split-policy'
import { isFallbackOnlyArtifact } from './artifact'
import { scoreWithParameters } from './trainer'
import { assignModelOpsAdvisory, rollbackModelOpsAdvisory } from './modelops-advisory'
import { approvalReference, assertDatasetKnowledgeAuthorityCurrent } from './knowledge-authority'
import type { DatasetManifest, DatasetMember, EvaluationBundle, GeoOutcomeRepositoryPort, ModelArtifact, ModelArtifactSummary, TrainingRun } from './types'
import type { ModelFamily } from './constants'
import type { TrainedParameters } from './trainer'
import type { ModelOpsCycle, ModelOpsCycleClaimResult, ModelOpsCycleResult, ModelOpsEvent, ModelOpsLeaseFence, ModelOpsPolicy, ModelOpsPolicyConfig, ModelOpsRepositoryPort, ModelOpsRollbackDecision, ModelOpsShadowEvaluation, ModelOpsWorkspace } from './modelops-types'

const MODEL_FAMILIES: ModelFamily[] = ['regularized_logistic_baseline_v1', 'pairwise_logistic_ranker_v1']
const DEFAULT_POLICY: ModelOpsPolicyConfig = {
  cadence: 'weekly',
  minimumNewVerifiedCandidates: 200,
  minimumNewQueryGroups: 30,
  minimumNewWebsites: 5,
  minimumObservationSpanDays: 14,
  allowedModelFamilies: ['regularized_logistic_baseline_v1'],
  maximumTrainingRunsPerCycle: 1,
  cooldownHours: 168,
  shadowEvaluationEnabled: true,
  autonomousExecutionEnabled: false,
  expiresAt: null,
}
const LIMITS = { candidates: 10_000, queryGroups: 5_000, websites: 1_000, spanDays: 3_650, runs: 5, cooldownHours: 8_760 } as const
const now = () => new Date().toISOString()
const clone = <T>(value: T): T => structuredClone(value)
type OutcomeObservations = Awaited<ReturnType<GeoOutcomeRepositoryPort['listObservations']>>

function boundedInt(value: unknown, field: string, minimum: number, maximum: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > maximum) throw new Error(`${field} must be a bounded integer.`)
  return value
}
function boundedReason(value: unknown, field = 'reason'): string { if (typeof value !== 'string' || value.trim().length < 8 || value.length > 500) throw new Error(`${field} must be 8-500 characters.`); return value.trim() }
function parseFamilyList(value: unknown): ModelFamily[] { if (!Array.isArray(value) || value.length < 1 || value.length > MODEL_FAMILIES.length || value.some(item => typeof item !== 'string' || !MODEL_FAMILIES.includes(item as ModelFamily))) throw new Error('allowedModelFamilies is invalid.'); const list = [...new Set(value as ModelFamily[])]; if (!list.length) throw new Error('At least one allowed model family is required.'); return list }
function asPolicyConfig(input: unknown): ModelOpsPolicyConfig {
  const value = (input && typeof input === 'object' && !Array.isArray(input) ? input : {}) as Record<string, unknown>
  const config: ModelOpsPolicyConfig = {
    cadence: value.cadence === undefined ? DEFAULT_POLICY.cadence : value.cadence as ModelOpsPolicyConfig['cadence'],
    minimumNewVerifiedCandidates: value.minimumNewVerifiedCandidates === undefined ? DEFAULT_POLICY.minimumNewVerifiedCandidates : boundedInt(value.minimumNewVerifiedCandidates, 'minimumNewVerifiedCandidates', 1, LIMITS.candidates),
    minimumNewQueryGroups: value.minimumNewQueryGroups === undefined ? DEFAULT_POLICY.minimumNewQueryGroups : boundedInt(value.minimumNewQueryGroups, 'minimumNewQueryGroups', 1, LIMITS.queryGroups),
    minimumNewWebsites: value.minimumNewWebsites === undefined ? DEFAULT_POLICY.minimumNewWebsites : boundedInt(value.minimumNewWebsites, 'minimumNewWebsites', 1, LIMITS.websites),
    minimumObservationSpanDays: value.minimumObservationSpanDays === undefined ? DEFAULT_POLICY.minimumObservationSpanDays : boundedInt(value.minimumObservationSpanDays, 'minimumObservationSpanDays', 1, LIMITS.spanDays),
    allowedModelFamilies: value.allowedModelFamilies === undefined ? [...DEFAULT_POLICY.allowedModelFamilies] : parseFamilyList(value.allowedModelFamilies),
    maximumTrainingRunsPerCycle: value.maximumTrainingRunsPerCycle === undefined ? DEFAULT_POLICY.maximumTrainingRunsPerCycle : boundedInt(value.maximumTrainingRunsPerCycle, 'maximumTrainingRunsPerCycle', 1, LIMITS.runs),
    cooldownHours: value.cooldownHours === undefined ? DEFAULT_POLICY.cooldownHours : boundedInt(value.cooldownHours, 'cooldownHours', 0, LIMITS.cooldownHours),
    shadowEvaluationEnabled: value.shadowEvaluationEnabled === undefined ? DEFAULT_POLICY.shadowEvaluationEnabled : value.shadowEvaluationEnabled === true,
    autonomousExecutionEnabled: value.autonomousExecutionEnabled === undefined ? DEFAULT_POLICY.autonomousExecutionEnabled : value.autonomousExecutionEnabled === true,
    expiresAt: value.expiresAt === undefined || value.expiresAt === null ? null : new Date(String(value.expiresAt)).toISOString(),
  }
  if (!['weekly', 'biweekly', 'monthly'].includes(config.cadence)) throw new Error('cadence is invalid.')
  if (config.expiresAt && new Date(config.expiresAt).getTime() <= Date.now()) throw new Error('expiresAt must be in the future.')
  return config
}
function policyFingerprint(config: ModelOpsPolicyConfig): string { return fingerprint(config) }
function assertOwner(ownerUserId: number) { if (!Number.isSafeInteger(ownerUserId) || ownerUserId <= 0) throw new Error('ownerUserId must be server-derived.') }
function sortObservations<T extends { observationFingerprint: string }>(items: readonly T[]): T[] { return [...items].sort((a, b) => a.observationFingerprint < b.observationFingerprint ? -1 : a.observationFingerprint > b.observationFingerprint ? 1 : 0) }
function primaryObservations(observations: ReadonlyArray<OutcomeObservations[number]>): OutcomeObservations { return sortObservations(observations.filter(canBePrimaryCitationTruth)) }
function observationSpanDays(observations: ReadonlyArray<OutcomeObservations[number]>): number | null { const timestamps = observations.map(item => new Date(item.runTimestamp).getTime()).filter(Number.isFinite); return timestamps.length > 1 ? Math.floor((Math.max(...timestamps) - Math.min(...timestamps)) / 86_400_000) : timestamps.length ? 0 : null }
function summary(observations: ReadonlyArray<OutcomeObservations[number]>) { return { candidates: observations.length, queryGroups: new Set(observations.map(item => `${item.runIdentity}:${item.normalizedQueryHash}:${item.engine}:${item.interface}`)).size, websites: new Set(observations.map(item => item.websiteIdentityHash)).size, engines: new Set(observations.map(item => `${item.engine}:${item.interface}`)).size, positives: observations.filter(item => item.citationStatus === 'cited').length, hardNegatives: observations.filter(item => item.citationStatus === 'not_cited').length, observationSpanDays: observationSpanDays(observations) } }
function policyUsable(policy: ModelOpsPolicy, trigger: ModelOpsCycle['trigger'], at = new Date()): boolean { if (policy.status === 'revoked') return false; if (policy.expiresAt && new Date(policy.expiresAt).getTime() <= at.getTime()) return false; return trigger === 'owner_manual' || trigger === 'dry_run' || policy.status === 'enabled' }
function policyForTrigger(policies: readonly ModelOpsPolicy[], trigger: ModelOpsCycle['trigger'], at: Date): ModelOpsPolicy | null {
  const ordered = [...policies].sort((a, b) => a.updatedAt.localeCompare(b.updatedAt))
  if (trigger !== 'scheduled') return ordered.at(-1) || null
  const enabled = ordered.filter(policy => policy.status === 'enabled' && (!policy.expiresAt || new Date(policy.expiresAt).getTime() > at.getTime()))
  if (enabled.length > 1) throw new Error('Multiple enabled ModelOps policies require owner resolution.')
  return enabled[0] || null
}
function splitFor(dataset: DatasetManifest) { return { train: dataset.trainFingerprints, validation: dataset.validationFingerprints, test: dataset.testFingerprints, siteHoldout: dataset.siteHoldoutFingerprints, queryHoldout: dataset.queryHoldoutFingerprints, temporalHoldout: dataset.temporalHoldoutFingerprints } }
function event(ownerUserId: number, cycleId: string, eventType: string, payload: Record<string, unknown>): ModelOpsEvent { const redactedPayload = Object.fromEntries(Object.entries(payload).filter(([key]) => !/(token|secret|credential|prompt|response|url|body|stack)/iu.test(key))); const eventFingerprint = fingerprint({ ownerUserId, cycleId, eventType, payload: redactedPayload }); return { eventId: `geo-modelops-event-${eventFingerprint.slice(0, 20)}`, ownerUserId, cycleId, eventType, eventPayload: redactedPayload, eventFingerprint, createdAt: now() } }
async function append(repo: ModelOpsRepositoryPort, ownerUserId: number, cycleId: string, eventType: string, payload: Record<string, unknown>) { await repo.appendEvent(ownerUserId, event(ownerUserId, cycleId, eventType, payload)) }
function fencedRepository(repository: ModelOpsRepositoryPort, fence: ModelOpsLeaseFence): ModelOpsRepositoryPort {
  return new Proxy(repository, {
    get(target, property, receiver) {
      if (property === 'updateCycle') return (ownerUserId: number, cycleId: string, patch: Partial<ModelOpsCycle>) => target.updateCycle(ownerUserId, cycleId, patch, fence)
      if (property === 'appendEvent') return (ownerUserId: number, value: ModelOpsEvent) => target.appendEvent(ownerUserId, value, fence)
      const member = Reflect.get(target, property, receiver)
      return typeof member === 'function' ? member.bind(target) : member
    },
  })
}

export function parseModelOpsPolicyConfig(input: unknown): ModelOpsPolicyConfig { return asPolicyConfig(input) }
export async function createModelOpsPolicy(ownerUserId: number, input: unknown, idempotencyKey: string, repository: ModelOpsRepositoryPort): Promise<ModelOpsPolicy> {
  assertOwner(ownerUserId); if (!/^[A-Za-z0-9._:-]{8,128}$/u.test(idempotencyKey)) throw new Error('A bounded idempotencyKey is required.')
  const config = asPolicyConfig(input); const policyId = `geo-modelops-policy-${fingerprint({ ownerUserId, idempotencyKey }).slice(0, 24)}`; const timestamp = now()
  return repository.transaction(async transaction => {
    const policy = await transaction.savePolicy(ownerUserId, { ...config, policyId, ownerUserId, status: 'paused', authorizedByOwnerUserId: null, authorizedAt: null, configurationFingerprint: policyFingerprint(config), createdAt: timestamp, updatedAt: timestamp, revokedAt: null })
    await transaction.appendEvent(ownerUserId, event(ownerUserId, policyId, 'policy_created', { policyId, status: policy.status, defaultPaused: true }))
    return policy
  })
}
export async function changeModelOpsPolicy(ownerUserId: number, policyId: string, action: 'enable' | 'pause' | 'revoke', repository: ModelOpsRepositoryPort, reason = 'Owner-authorized ModelOps policy transition.') : Promise<ModelOpsPolicy> {
  assertOwner(ownerUserId); if (!/^[A-Za-z0-9._:-]{8,160}$/u.test(policyId)) throw new Error('policyId is invalid.'); const cleanReason = boundedReason(reason)
  const current = await repository.getPolicy(ownerUserId, policyId); if (!current) throw new Error('Policy not found.')
  if (action === 'enable' && current.expiresAt && new Date(current.expiresAt).getTime() <= Date.now()) throw new Error('Cannot enable an expired policy.')
  return repository.transaction(async transaction => {
    const updated = action === 'enable'
      ? await transaction.updatePolicy(ownerUserId, policyId, { status: 'enabled', authorizedByOwnerUserId: ownerUserId, authorizedAt: now() })
      : action === 'pause'
        ? await transaction.updatePolicy(ownerUserId, policyId, { status: 'paused' })
        : await transaction.updatePolicy(ownerUserId, policyId, { status: 'revoked', revokedAt: now() })
    const auditFingerprint = fingerprint({ ownerUserId, policyId, action, reason: cleanReason, configurationFingerprint: updated.configurationFingerprint, status: updated.status, authorizedAt: updated.authorizedAt, revokedAt: updated.revokedAt })
    await transaction.appendEvent(ownerUserId, { eventId: `geo-outcome-modelops-policy-event-${auditFingerprint.slice(0, 24)}`, ownerUserId, cycleId: policyId, eventType: `policy_${action}`, eventPayload: { policyId, action, status: updated.status, configurationFingerprint: updated.configurationFingerprint, reason: cleanReason }, eventFingerprint: auditFingerprint, createdAt: now() })
    return updated
  })
}

async function latestApprovedDataset(ownerUserId: number, outcomeRepository: GeoOutcomeRepositoryPort): Promise<DatasetManifest | null> {
  const datasets = await outcomeRepository.listDatasets(ownerUserId); const decisions = await outcomeRepository.listDatasetDecisions(ownerUserId)
  const candidates = datasets.filter(dataset => dataset.status === 'approved' && decisions.some(decision => decision.manifestId === dataset.manifestId && decision.manifestFingerprint === dataset.manifestFingerprint && decision.newStatus === 'approved')).sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  for (const dataset of candidates) {
    try { await assertDatasetKnowledgeAuthorityCurrent(ownerUserId, dataset, outcomeRepository); return dataset } catch { /* stale or undeclared approvals are not ModelOps inputs */ }
  }
  return null
}

async function assertPolicyShadowCandidateCurrent(ownerUserId: number, artifact: ModelArtifact, dataset: DatasetManifest, expectedStatus: ModelArtifact['status'], outcomeRepository: GeoOutcomeRepositoryPort): Promise<ModelArtifact> {
  const latestArtifact = await outcomeRepository.getArtifact(ownerUserId, artifact.artifactId)
  if (!latestArtifact || latestArtifact.ownerUserId !== ownerUserId || latestArtifact.artifactHash !== artifact.artifactHash || latestArtifact.status !== expectedStatus || !verifyArtifactHash(latestArtifact)) throw new Error('Policy shadow candidate changed before admission could be finalized.')
  const latestDataset = await outcomeRepository.getDataset(ownerUserId, dataset.manifestId)
  if (!latestDataset || latestDataset.status !== 'approved' || latestDataset.manifestFingerprint !== dataset.manifestFingerprint || latestArtifact.datasetManifestFingerprint !== latestDataset.manifestFingerprint) throw new Error('Policy shadow dataset changed before admission could be finalized.')
  await assertDatasetKnowledgeAuthorityCurrent(ownerUserId, latestDataset, outcomeRepository, approvalReference(latestArtifact))
  const fallback = await resolveApprovedFallbackForArtifact(ownerUserId, latestArtifact, outcomeRepository)
  if (!fallback || fallback.artifactHash !== latestArtifact.rollbackArtifactHash) throw new Error('Policy shadow fallback authority changed before admission could be finalized.')
  if (expectedStatus === 'approved_for_shadow') {
    const decision = (await outcomeRepository.listDecisions(ownerUserId)).filter(item => item.modelArtifactId === latestArtifact.artifactId && item.artifactHash === latestArtifact.artifactHash && item.datasetManifestHash === latestArtifact.datasetManifestFingerprint).at(-1)
    if (decision?.newStatus !== 'approved_for_shadow' || (decision.reviewerUserId !== null && decision.reviewerUserId !== ownerUserId)) throw new Error('Policy shadow model decision changed before admission could be finalized.')
  }
  return latestArtifact
}

async function finalizePolicyShadow(ownerUserId: number, cycle: ModelOpsCycle, policy: ModelOpsPolicy, dataset: DatasetManifest, trainingRun: TrainingRun, artifact: ModelArtifact, outcomeRepository: GeoOutcomeRepositoryPort, modelOpsRepository: ModelOpsRepositoryPort, at: Date): Promise<{ cycle: ModelOpsCycle; artifact: ModelArtifact; shadowEvaluation: ModelOpsShadowEvaluation | null }> {
  if (!policy.autonomousExecutionEnabled || !policy.shadowEvaluationEnabled) return { cycle, artifact, shadowEvaluation: null }
  if (!artifact.rollbackArtifactHash) {
    const blocked = await modelOpsRepository.updateCycle(ownerUserId, cycle.cycleId, { status: 'blocked', reasonCodes: ['rollback_fallback_missing'], errorClass: 'shadow_admission_gate', completedAt: at.toISOString(), leaseOwner: null, leaseExpiresAt: null })
    await append(modelOpsRepository, ownerUserId, cycle.cycleId, 'shadow_admission_blocked', { artifactId: artifact.artifactId, reasonCode: 'rollback_fallback_missing', productionActivation: false })
    return { cycle: blocked, artifact, shadowEvaluation: null }
  }
  if (artifact.status === 'ready_for_owner_review') {
    await assertPolicyShadowCandidateCurrent(ownerUserId, artifact, dataset, 'ready_for_owner_review', outcomeRepository)
    const transition = await outcomeRepository.transitionArtifactWithDecision(ownerUserId, artifact.artifactId, 'approved_for_shadow', null, 'Owner-authorized ModelOps policy admitted this experimental artifact to shadow evaluation; no production activation is implied.', dataset.manifestFingerprint, artifact.rollbackArtifactHash)
    artifact = await assertPolicyShadowCandidateCurrent(ownerUserId, transition.artifact, dataset, 'approved_for_shadow', outcomeRepository)
    await append(modelOpsRepository, ownerUserId, cycle.cycleId, 'artifact_admitted_to_shadow_by_policy', { artifactId: artifact.artifactId, artifactHash: artifact.artifactHash, decisionId: transition.decision.decisionId, reviewerUserId: null, productionActivation: false })
  }
  if (artifact.status !== 'approved_for_shadow') {
    const blocked = await modelOpsRepository.updateCycle(ownerUserId, cycle.cycleId, { status: 'blocked', reasonCodes: ['shadow_admission_blocked'], errorClass: 'shadow_admission_gate', completedAt: at.toISOString(), leaseOwner: null, leaseExpiresAt: null })
    return { cycle: blocked, artifact, shadowEvaluation: null }
  }
  const shadowEvaluation = await evaluateModelOpsShadow(ownerUserId, artifact.artifactId, outcomeRepository, modelOpsRepository, at)
  cycle = await modelOpsRepository.updateCycle(ownerUserId, cycle.cycleId, { modelArtifactId: artifact.artifactId, artifactHash: artifact.artifactHash, shadowEvaluationFingerprint: shadowEvaluation.evaluationFingerprint })
  const degraded = shadowEvaluation.status === 'needs_owner_attention'
  const activeCandidateAssignment = (await modelOpsRepository.listAdvisoryAssignments(ownerUserId)).find(item => item.status === 'advisory' && item.candidateArtifactHash === artifact.artifactHash)
  if (degraded && activeCandidateAssignment) {
    await rollbackModelOpsAdvisory({ ownerUserId, assignmentId: activeCandidateAssignment.assignmentId, expectedVersion: activeCandidateAssignment.version, reasonCodes: ['shadow_degradation_stop', ...shadowEvaluation.reasonCodes], now: at }, modelOpsRepository)
    await append(modelOpsRepository, ownerUserId, cycle.cycleId, 'advisory_automatic_rollback', { assignmentId: activeCandidateAssignment.assignmentId, candidateArtifactHash: artifact.artifactHash, reasonCodes: shadowEvaluation.reasonCodes, productionActivation: false })
  }
  if (shadowEvaluation.status === 'completed') {
    const current = (await outcomeRepository.listArtifacts(ownerUserId)).filter(item => item.artifactHash !== artifact.artifactHash && item.status === 'approved_for_shadow' && item.taskType === artifact.taskType && item.modelFamily === artifact.modelFamily && item.featureCatalogVersion === artifact.featureCatalogVersion && item.labelContractVersion === artifact.labelContractVersion).at(-1)
    if (current) {
      const assignment = await assignModelOpsAdvisory({ ownerUserId, policyId: policy.policyId, cycleId: cycle.cycleId, candidateArtifactId: artifact.artifactId, currentArtifactHash: current.artifactHash, now: at }, outcomeRepository, modelOpsRepository)
      await append(modelOpsRepository, ownerUserId, cycle.cycleId, 'advisory_assignment_created', { assignmentId: assignment.assignmentId, currentArtifactHash: current.artifactHash, candidateArtifactHash: artifact.artifactHash, productionActivation: false })
    } else {
      await append(modelOpsRepository, ownerUserId, cycle.cycleId, 'advisory_assignment_blocked', { reasonCode: 'compatible_current_artifact_missing', candidateArtifactHash: artifact.artifactHash, productionActivation: false })
    }
  }
  const updated = await modelOpsRepository.updateCycle(ownerUserId, cycle.cycleId, { status: degraded ? 'blocked' : 'completed', shadowEvaluationFingerprint: shadowEvaluation.evaluationFingerprint, reasonCodes: degraded ? ['shadow_degradation_stop'] : [`shadow_${shadowEvaluation.status}`], completedAt: at.toISOString(), leaseOwner: null, leaseExpiresAt: null, errorClass: degraded ? 'shadow_degradation' : null })
  await append(modelOpsRepository, ownerUserId, cycle.cycleId, degraded ? 'shadow_degradation_stop' : 'shadow_evaluation_recorded', { artifactId: artifact.artifactId, artifactHash: artifact.artifactHash, evaluationId: shadowEvaluation.evaluationId, status: shadowEvaluation.status, productionActivation: false, rollbackRequired: degraded })
  return { cycle: updated, artifact, shadowEvaluation }
}

export interface ModelOpsDryRunPlan { mode: 'dry_run'; ownerUserId: number; policyId: string | null; policyStatus: ModelOpsPolicy['status'] | 'missing'; wouldCreateCycle: boolean; wouldCreateDataset: boolean; wouldCreateTrainingRun: boolean; readiness: ReturnType<typeof getDatasetReadiness>; newVerifiedCandidates: number; newQueryGroups: number; newWebsites: number; observationSpanDays: number | null; reasonCodes: string[]; limitations: string[] }
export async function dryRunModelOpsCycle(ownerUserId: number, trigger: 'owner_manual' | 'scheduled' | 'dry_run', outcomeRepository: GeoOutcomeRepositoryPort, modelOpsRepository: ModelOpsRepositoryPort, at = new Date()): Promise<ModelOpsDryRunPlan> {
  assertOwner(ownerUserId); const policy = (await modelOpsRepository.listPolicies(ownerUserId)).sort((a, b) => a.updatedAt.localeCompare(b.updatedAt)).at(-1) || null; const observations = primaryObservations(await outcomeRepository.listObservations(ownerUserId)); const previous = await latestApprovedDataset(ownerUserId, outcomeRepository); const previousSet = new Set(previous?.sourceObservationFingerprints || []); const fresh = observations.filter(item => !previousSet.has(item.observationFingerprint)); const counts = summary(fresh); const readiness = getDatasetReadiness(counts); const reasonCodes: string[] = []
  if (!policy) reasonCodes.push('policy_missing'); else if (policy.status === 'paused') reasonCodes.push('policy_paused'); else if (policy.status === 'revoked') reasonCodes.push('policy_revoked'); else if (policy.expiresAt && new Date(policy.expiresAt).getTime() <= at.getTime()) reasonCodes.push('policy_expired')
  if (policy && counts.candidates < policy.minimumNewVerifiedCandidates) reasonCodes.push('insufficient_new_verified_candidates')
  if (policy && counts.queryGroups < policy.minimumNewQueryGroups) reasonCodes.push('insufficient_new_query_groups')
  if (policy && counts.websites < policy.minimumNewWebsites) reasonCodes.push('insufficient_new_websites')
  if (policy && (counts.observationSpanDays === null || counts.observationSpanDays < policy.minimumObservationSpanDays)) reasonCodes.push('insufficient_observation_span')
  const cycles = await modelOpsRepository.listCycles(ownerUserId)
  const lastCycle = cycles.sort((a, b) => a.createdAt.localeCompare(b.createdAt)).at(-1)
  const cooldownActive = Boolean(policy && lastCycle && policy.cooldownHours > 0 && new Date(lastCycle.createdAt).getTime() + policy.cooldownHours * 3_600_000 > at.getTime())
  if (cooldownActive) reasonCodes.push('cooldown_active')
  const thresholdReady = Boolean(policy && policyUsable(policy, trigger, at) && !cooldownActive && counts.candidates >= policy.minimumNewVerifiedCandidates && counts.queryGroups >= policy.minimumNewQueryGroups && counts.websites >= policy.minimumNewWebsites && (counts.observationSpanDays === null || counts.observationSpanDays < policy.minimumObservationSpanDays ? false : true))
  const dataset = thresholdReady && fresh.length ? buildCitationSelectionDataset(observations, ownerUserId).manifest : null
  if (dataset && dataset.status === 'gate_blocked') reasonCodes.push('dataset_gate_blocked')
  if (dataset?.status === 'ready_for_review') reasonCodes.push('needs_owner_review')
  return { mode: 'dry_run', ownerUserId, policyId: policy?.policyId || null, policyStatus: policy?.status || 'missing', wouldCreateCycle: Boolean(policy && policyUsable(policy, trigger, at) && !cooldownActive), wouldCreateDataset: Boolean(thresholdReady && dataset), wouldCreateTrainingRun: Boolean(thresholdReady && dataset?.status === 'approved'), readiness, newVerifiedCandidates: counts.candidates, newQueryGroups: counts.queryGroups, newWebsites: counts.websites, observationSpanDays: counts.observationSpanDays, reasonCodes: [...new Set(reasonCodes)], limitations: ['Dry-run performs no dataset, cycle, training, artifact, shadow, or decision writes.', 'Only durable verified consumer-surface evidence can enter the primary outcome dataset.', 'Provider API, GSC, GA4, heuristic and external datasets remain secondary or unverified.'] }
}

function cadenceBucket(date: Date, cadence: ModelOpsPolicy['cadence']): string { const day = Math.floor(date.getTime() / 86_400_000); const size = cadence === 'weekly' ? 7 : cadence === 'biweekly' ? 14 : 30; return `${Math.floor(day / size)}` }
export async function createModelOpsCycle(ownerUserId: number, trigger: ModelOpsCycle['trigger'], idempotencyKey: string, outcomeRepository: GeoOutcomeRepositoryPort, modelOpsRepository: ModelOpsRepositoryPort, at = new Date()): Promise<ModelOpsCycle> {
  assertOwner(ownerUserId); const policies = await modelOpsRepository.listPolicies(ownerUserId); const policy = policyForTrigger(policies, trigger, at); if (!policy) throw new Error('ModelOps policy is not configured or enabled for this trigger.')
  if (!policyUsable(policy, trigger, at)) throw new Error(policy.status === 'enabled' ? 'ModelOps policy is expired.' : 'ModelOps policy is paused or revoked.')
  if (!/^[A-Za-z0-9._:-]{8,128}$/u.test(idempotencyKey)) throw new Error('A bounded idempotencyKey is required.')
  const latestCycle = (await modelOpsRepository.listCycles(ownerUserId)).sort((a, b) => a.createdAt.localeCompare(b.createdAt)).at(-1)
  if (trigger === 'scheduled' && latestCycle && policy.cooldownHours > 0 && new Date(latestCycle.createdAt).getTime() + policy.cooldownHours * 3_600_000 > at.getTime()) throw new Error('ModelOps policy cooldown is active.')
  const observations = primaryObservations(await outcomeRepository.listObservations(ownerUserId)); const previous = await latestApprovedDataset(ownerUserId, outcomeRepository); const previousSet = new Set(previous?.sourceObservationFingerprints || []); const fresh = observations.filter(item => !previousSet.has(item.observationFingerprint)); const snapshot = fingerprint({ ownerUserId, policyFingerprint: policy.configurationFingerprint, trigger, idempotencyKey, eligible: fresh.map(item => item.observationFingerprint).sort(), cadenceBucket: cadenceBucket(at, policy.cadence) }); const timestamp = at.toISOString(); const cycle: ModelOpsCycle = { cycleId: `geo-modelops-cycle-${snapshot.slice(0, 24)}`, ownerUserId, policyId: policy.policyId, policyFingerprint: policy.configurationFingerprint, trigger, status: 'planned', readinessSnapshotFingerprint: fingerprint({ summary: summary(fresh), eligible: fresh.map(item => item.observationFingerprint).sort() }), eligibleObservationFingerprints: fresh.map(item => item.observationFingerprint), previousApprovedDatasetFingerprint: previous?.manifestFingerprint || null, generatedDatasetFingerprint: null, trainingRunId: null, modelArtifactId: null, artifactHash: null, shadowEvaluationFingerprint: null, reasonCodes: [], limitations: ['Owner policy may create a governed dataset decision; it is not a verified outcome or production model approval.', 'No production_active status exists in V1.', 'All model scores remain experimental and are not verified outcomes.'], errorClass: null, startedAt: null, completedAt: null, attempt: 0, leaseOwner: null, leaseExpiresAt: null, leaseVersion: 0, idempotencyKey, inputFingerprint: snapshot, createdAt: timestamp, updatedAt: timestamp }
  return modelOpsRepository.saveCycle(ownerUserId, cycle)
}

function isRetryable(error: unknown): boolean { const message = error instanceof Error ? error.message.toLowerCase() : ''; return /(timeout|deadlock|connection|temporarily unavailable|retryable)/u.test(message) }

async function executeApprovedDatasetIfNeeded(ownerUserId: number, cycle: ModelOpsCycle, policy: ModelOpsPolicy, outcomeRepository: GeoOutcomeRepositoryPort, modelOpsRepository: ModelOpsRepositoryPort, at: Date): Promise<ModelOpsCycleResult | null> {
  const dataset = await latestApprovedDataset(ownerUserId, outcomeRepository)
  if (!dataset) return null
  const authority = await assertDatasetKnowledgeAuthorityCurrent(ownerUserId, dataset, outcomeRepository)
  cycle = await modelOpsRepository.updateCycle(ownerUserId, cycle.cycleId, { generatedDatasetFingerprint: dataset.manifestFingerprint })
  if (policy.maximumTrainingRunsPerCycle < 1) throw new Error('Policy maximumTrainingRunsPerCycle must be at least 1.')
  const family = policy.allowedModelFamilies[0]!
  let trainingRun = await createTrainingRun(ownerUserId, { datasetManifestId: dataset.manifestId, modelFamily: family }, outcomeRepository)
  await assertDatasetKnowledgeAuthorityCurrent(ownerUserId, dataset, outcomeRepository, authority.reference)
  await append(modelOpsRepository, ownerUserId, cycle.cycleId, 'training_run_reserved_for_fallback_snapshot', { trainingRunId: trainingRun.trainingRunId, modelFamily: family })
  cycle = await modelOpsRepository.updateCycle(ownerUserId, cycle.cycleId, { trainingRunId: trainingRun.trainingRunId })
  if (trainingRun.status === 'queued' || trainingRun.status === 'running') { trainingRun = await executeTrainingRun(ownerUserId, trainingRun.trainingRunId, outcomeRepository); await assertDatasetKnowledgeAuthorityCurrent(ownerUserId, dataset, outcomeRepository, authority.reference) }
  if (trainingRun.status === 'failed') {
    cycle = await modelOpsRepository.updateCycle(ownerUserId, cycle.cycleId, { status: 'failed', reasonCodes: ['training_failed'], errorClass: 'training_failed', completedAt: at.toISOString(), leaseOwner: null, leaseExpiresAt: null })
    await append(modelOpsRepository, ownerUserId, cycle.cycleId, 'training_failed', { trainingRunId: trainingRun.trainingRunId })
    return { cycle, dataset, trainingRun, artifact: null, shadowEvaluation: null }
  }
  if (trainingRun.status === 'blocked') {
    cycle = await modelOpsRepository.updateCycle(ownerUserId, cycle.cycleId, { status: 'blocked', reasonCodes: ['training_blocked'], errorClass: 'training_gate_blocked', completedAt: at.toISOString(), leaseOwner: null, leaseExpiresAt: null })
    await append(modelOpsRepository, ownerUserId, cycle.cycleId, 'training_blocked', { trainingRunId: trainingRun.trainingRunId })
    return { cycle, dataset, trainingRun, artifact: null, shadowEvaluation: null }
  }
  const artifact = trainingRun.artifactId ? await outcomeRepository.getArtifact(ownerUserId, trainingRun.artifactId) : null
  if (trainingRun.status !== 'completed' || !artifact) throw new Error('Completed training run has no durable artifact.')
  await assertDatasetKnowledgeAuthorityCurrent(ownerUserId, dataset, outcomeRepository, approvalReference(artifact))
  if (policy.autonomousExecutionEnabled) {
    const shadow = await finalizePolicyShadow(ownerUserId, cycle, policy, dataset, trainingRun, artifact, outcomeRepository, modelOpsRepository, at)
    return { cycle: shadow.cycle, dataset, trainingRun, artifact: shadow.artifact, shadowEvaluation: shadow.shadowEvaluation }
  }
  cycle = await modelOpsRepository.updateCycle(ownerUserId, cycle.cycleId, { status: 'completed', modelArtifactId: artifact.artifactId, artifactHash: artifact.artifactHash, reasonCodes: ['artifact_ready_for_owner_shadow_review'], completedAt: at.toISOString(), leaseOwner: null, leaseExpiresAt: null })
  await append(modelOpsRepository, ownerUserId, cycle.cycleId, 'artifact_ready_for_owner_review', { artifactId: artifact.artifactId, artifactHash: artifact.artifactHash })
  return { cycle, dataset, trainingRun, artifact, shadowEvaluation: null }
}

export async function executeModelOpsCycle(ownerUserId: number, cycleId: string, outcomeRepository: GeoOutcomeRepositoryPort, modelOpsRepository: ModelOpsRepositoryPort, leaseOwner = `geo-modelops-worker-${process.pid}`, at = new Date()): Promise<ModelOpsCycleResult> {
  assertOwner(ownerUserId); const claimed: ModelOpsCycleClaimResult = await modelOpsRepository.claimCycle(ownerUserId, cycleId, leaseOwner, new Date(at.getTime() + 300_000).toISOString()); if (claimed.outcome !== 'claimed' && claimed.outcome !== 'stale_recovered') return { cycle: claimed.cycle, dataset: null, trainingRun: null, artifact: null, shadowEvaluation: null }
  modelOpsRepository = fencedRepository(modelOpsRepository, { leaseOwner, leaseVersion: claimed.cycle.leaseVersion, attempt: claimed.cycle.attempt })
  let cycle = claimed.cycle; let dataset: DatasetManifest | null = null; let trainingRun: TrainingRun | null = null; let artifact: ModelArtifact | null = null
  try {
    await append(modelOpsRepository, ownerUserId, cycle.cycleId, 'cycle_started', { trigger: cycle.trigger, attempt: cycle.attempt })
    const policy = await modelOpsRepository.getPolicy(ownerUserId, cycle.policyId); if (!policy || !policyUsable(policy, cycle.trigger, at)) { cycle = await modelOpsRepository.updateCycle(ownerUserId, cycle.cycleId, { status: 'blocked', reasonCodes: ['policy_unavailable_or_expired'], completedAt: at.toISOString(), leaseOwner: null, leaseExpiresAt: null, errorClass: 'policy_gate' }); await append(modelOpsRepository, ownerUserId, cycle.cycleId, 'cycle_blocked', { errorClass: 'policy_gate' }); return { cycle, dataset, trainingRun, artifact, shadowEvaluation: null } }
    const approvedTrainingResult = await executeApprovedDatasetIfNeeded(ownerUserId, cycle, policy, outcomeRepository, modelOpsRepository, at)
    if (approvedTrainingResult) return approvedTrainingResult
    const observations = primaryObservations(await outcomeRepository.listObservations(ownerUserId)); const previous = await latestApprovedDataset(ownerUserId, outcomeRepository); const previousSet = new Set(previous?.sourceObservationFingerprints || []); const fresh = observations.filter(item => !previousSet.has(item.observationFingerprint)); const counts = summary(fresh)
    if (counts.candidates < policy.minimumNewVerifiedCandidates || counts.queryGroups < policy.minimumNewQueryGroups || counts.websites < policy.minimumNewWebsites || counts.observationSpanDays === null || counts.observationSpanDays < policy.minimumObservationSpanDays) { cycle = await modelOpsRepository.updateCycle(ownerUserId, cycle.cycleId, { status: 'insufficient_data', reasonCodes: ['insufficient_data'], completedAt: at.toISOString(), leaseOwner: null, leaseExpiresAt: null }); await append(modelOpsRepository, ownerUserId, cycle.cycleId, 'readiness_insufficient_data', counts); return { cycle, dataset, trainingRun, artifact, shadowEvaluation: null } }
    if (!fresh.length) { cycle = await modelOpsRepository.updateCycle(ownerUserId, cycle.cycleId, { status: 'insufficient_data', reasonCodes: ['no_new_verified_candidates'], completedAt: at.toISOString(), leaseOwner: null, leaseExpiresAt: null }); await append(modelOpsRepository, ownerUserId, cycle.cycleId, 'readiness_no_new_data', {}); return { cycle, dataset, trainingRun, artifact, shadowEvaluation: null } }
    const built = buildCitationSelectionDataset(observations, ownerUserId); if (!built.members.length) { cycle = await modelOpsRepository.updateCycle(ownerUserId, cycle.cycleId, { status: 'insufficient_data', reasonCodes: ['insufficient_label_pairs'], completedAt: at.toISOString(), leaseOwner: null, leaseExpiresAt: null }); await append(modelOpsRepository, ownerUserId, cycle.cycleId, 'dataset_not_created', { reason: 'insufficient_label_pairs' }); return { cycle, dataset, trainingRun, artifact, shadowEvaluation: null } }
    dataset = await outcomeRepository.saveDatasetTransactional(ownerUserId, built.manifest, built.members)
    const needsOwnerReview = dataset.status === 'ready_for_review'
    const datasetReasonCodes = dataset.status === 'gate_blocked' ? ['dataset_candidate_gate_blocked'] : needsOwnerReview ? ['needs_owner_review'] : ['dataset_candidate_not_approved']
    cycle = await modelOpsRepository.updateCycle(ownerUserId, cycle.cycleId, { generatedDatasetFingerprint: dataset.manifestFingerprint, reasonCodes: datasetReasonCodes })
    await append(modelOpsRepository, ownerUserId, cycle.cycleId, 'dataset_candidate_created', { datasetFingerprint: dataset.manifestFingerprint, status: dataset.status, memberCount: built.members.length, autonomousExecutionEnabled: policy.autonomousExecutionEnabled })
    if (dataset.status !== 'approved') { cycle = await modelOpsRepository.updateCycle(ownerUserId, cycle.cycleId, { status: dataset.status === 'gate_blocked' || needsOwnerReview ? 'blocked' : 'completed', reasonCodes: datasetReasonCodes, completedAt: at.toISOString(), leaseOwner: null, leaseExpiresAt: null, errorClass: needsOwnerReview ? 'dataset_authority_review' : null }); if (needsOwnerReview) await append(modelOpsRepository, ownerUserId, cycle.cycleId, 'dataset_needs_owner_review', { manifestFingerprint: dataset.manifestFingerprint, reviewerUserId: null }); return { cycle, dataset, trainingRun, artifact, shadowEvaluation: null } }
    const family = policy.allowedModelFamilies[0]!; if (policy.maximumTrainingRunsPerCycle < 1) { cycle = await modelOpsRepository.updateCycle(ownerUserId, cycle.cycleId, { status: 'blocked', reasonCodes: ['training_run_limit_zero'], completedAt: at.toISOString(), leaseOwner: null, leaseExpiresAt: null }); return { cycle, dataset, trainingRun, artifact, shadowEvaluation: null } }
    trainingRun = await createTrainingRun(ownerUserId, { datasetManifestId: dataset.manifestId, modelFamily: family }, outcomeRepository); cycle = await modelOpsRepository.updateCycle(ownerUserId, cycle.cycleId, { trainingRunId: trainingRun.trainingRunId }); await append(modelOpsRepository, ownerUserId, cycle.cycleId, 'training_run_queued', { trainingRunId: trainingRun.trainingRunId, modelFamily: family })
    trainingRun = await executeTrainingRun(ownerUserId, trainingRun.trainingRunId, outcomeRepository); if (trainingRun.status === 'failed') { cycle = await modelOpsRepository.updateCycle(ownerUserId, cycle.cycleId, { status: 'failed', errorClass: 'training_failed', reasonCodes: ['training_failed'], completedAt: at.toISOString(), leaseOwner: null, leaseExpiresAt: null }); await append(modelOpsRepository, ownerUserId, cycle.cycleId, 'training_failed', { trainingRunId: trainingRun.trainingRunId }); return { cycle, dataset, trainingRun, artifact, shadowEvaluation: null } }
    if (trainingRun.status === 'blocked') { cycle = await modelOpsRepository.updateCycle(ownerUserId, cycle.cycleId, { status: 'blocked', errorClass: 'training_gate_blocked', reasonCodes: ['training_gate_blocked'], completedAt: at.toISOString(), leaseOwner: null, leaseExpiresAt: null }); await append(modelOpsRepository, ownerUserId, cycle.cycleId, 'training_blocked', { trainingRunId: trainingRun.trainingRunId }); return { cycle, dataset, trainingRun, artifact, shadowEvaluation: null } }
    if (trainingRun.artifactId) artifact = await outcomeRepository.getArtifact(ownerUserId, trainingRun.artifactId)
    if (!artifact) throw new Error('Completed training run has no durable artifact.')
    if (policy.autonomousExecutionEnabled) {
      const shadow = await finalizePolicyShadow(ownerUserId, cycle, policy, dataset, trainingRun, artifact, outcomeRepository, modelOpsRepository, at)
      return { cycle: shadow.cycle, dataset, trainingRun, artifact: shadow.artifact, shadowEvaluation: shadow.shadowEvaluation }
    }
    cycle = await modelOpsRepository.updateCycle(ownerUserId, cycle.cycleId, { status: 'completed', modelArtifactId: artifact.artifactId, artifactHash: artifact.artifactHash, reasonCodes: ['artifact_ready_for_owner_shadow_review'], completedAt: at.toISOString(), leaseOwner: null, leaseExpiresAt: null }); await append(modelOpsRepository, ownerUserId, cycle.cycleId, 'artifact_ready_for_owner_review', { artifactId: artifact.artifactId, artifactHash: artifact.artifactHash }); return { cycle, dataset, trainingRun, artifact, shadowEvaluation: null }
  } catch (error) {
    const retry = isRetryable(error) && cycle.attempt < 3; cycle = await modelOpsRepository.updateCycle(ownerUserId, cycle.cycleId, { status: retry ? 'retry_wait' : 'failed', errorClass: retry ? 'retryable_database_failure' : 'permanent_failure', reasonCodes: [retry ? 'retry_wait' : 'permanent_failure'], completedAt: retry ? null : at.toISOString(), leaseOwner: null, leaseExpiresAt: null }); await append(modelOpsRepository, ownerUserId, cycle.cycleId, retry ? 'cycle_retry_wait' : 'cycle_failed', { errorClass: retry ? 'retryable_database_failure' : 'permanent_failure' }); return { cycle, dataset, trainingRun, artifact, shadowEvaluation: null }
  }
}

function metricObject(bundle: EvaluationBundle) { return { test: bundle.test, temporalHoldout: bundle.temporalHoldout, rankingTest: bundle.rankingTest, rankingTemporalHoldout: bundle.rankingTemporalHoldout } }
function distribution(observations: ReadonlyArray<OutcomeObservations[number]>) { const counts: Record<string, number> = {}; for (const item of observations) { const key = `${item.engine}:${item.interface}`; counts[key] = (counts[key] || 0) + 1 } return counts }
function predictedClassCounts(artifact: ModelArtifact, members: readonly DatasetMember[]) { const parameters: Pick<TrainedParameters, 'coefficients' | 'intercept' | 'normalizationStatistics'> = { coefficients: artifact.coefficients, intercept: artifact.intercept, normalizationStatistics: artifact.normalizationStatistics }; let positive = 0; let negative = 0; for (const member of members) { const predicted = scoreWithParameters(parameters, member.featureVector.values.map(value => value.value)) >= 0.5; if (predicted) positive++; else negative++ } return { positive, negative } }
function artifactSummary(artifact: ModelArtifact): ModelArtifactSummary { const fallbackOnly = isFallbackOnlyArtifact(artifact); return { artifactId: artifact.artifactId, modelFamily: artifact.modelFamily, taskType: artifact.taskType, modelVersion: artifact.modelVersion, role: fallbackOnly ? 'fallback' : 'candidate', fallbackOnly, productionActivation: false, status: artifact.status, artifactHash: artifact.artifactHash, datasetManifestHash: artifact.datasetManifestFingerprint, trainingRowCount: artifact.trainingRowCount, metrics: artifact.evaluationMetrics, limitations: artifact.limitations, rollbackArtifactHash: artifact.rollbackArtifactHash, revokedAt: artifact.revokedAt } }
function shadowTestF1(evaluation: ModelOpsShadowEvaluation | null): number | null {
  const test = evaluation?.binaryMetrics.test
  if (!test || typeof test !== 'object' || Array.isArray(test)) return null
  const value = (test as Record<string, unknown>).f1
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}
function shadowObservationSnapshot(observations: OutcomeObservations): string { return fingerprint([...observations].sort((left, right) => left.observationFingerprint.localeCompare(right.observationFingerprint))) }
async function assertCurrentShadowAuthority(ownerUserId: number, artifact: ModelArtifact, dataset: DatasetManifest, trainingSnapshot: string, expectedShadowObservations: OutcomeObservations, outcomeRepository: GeoOutcomeRepositoryPort) {
  const latestArtifact = await outcomeRepository.getArtifact(ownerUserId, artifact.artifactId)
  const latestDataset = latestArtifact ? (await outcomeRepository.listDatasets(ownerUserId)).find(item => item.manifestFingerprint === latestArtifact.datasetManifestFingerprint) : null
  if (!latestArtifact || latestArtifact.artifactHash !== artifact.artifactHash || (latestArtifact.status !== 'approved_for_shadow' && latestArtifact.status !== 'shadow_failed') || !latestDataset || latestDataset.manifestFingerprint !== dataset.manifestFingerprint || latestDataset.status !== 'approved') throw new Error('Shadow authority changed before evaluation was finalized.')
  await assertDatasetKnowledgeAuthorityCurrent(ownerUserId, latestDataset, outcomeRepository, approvalReference(latestArtifact))
  const [modelDecisions, datasetDecisions, members] = await Promise.all([outcomeRepository.listDecisions(ownerUserId), outcomeRepository.listDatasetDecisions(ownerUserId), outcomeRepository.getDatasetMembers(ownerUserId, latestDataset.manifestId)])
  const modelDecision = modelDecisions.filter(item => item.modelArtifactId === latestArtifact.artifactId && item.artifactHash === latestArtifact.artifactHash && item.datasetManifestHash === latestArtifact.datasetManifestFingerprint).at(-1)
  const datasetDecision = datasetDecisions.filter(item => item.manifestId === latestDataset.manifestId && item.manifestFingerprint === latestDataset.manifestFingerprint).at(-1)
  const currentSplit = splitFingerprint({ train: latestDataset.trainFingerprints, validation: latestDataset.validationFingerprints, test: latestDataset.testFingerprints, siteHoldout: latestDataset.siteHoldoutFingerprints, queryHoldout: latestDataset.queryHoldoutFingerprints, temporalHoldout: latestDataset.temporalHoldoutFingerprints })
  const trainingFingerprints = new Set(latestDataset.sourceObservationFingerprints)
  const currentShadowObservations = primaryObservations(await outcomeRepository.listObservations(ownerUserId)).filter(item => !trainingFingerprints.has(item.observationFingerprint) && new Date(item.runTimestamp).getTime() > new Date(latestDataset.observationEnd || 0).getTime())
  if (!modelDecision || modelDecision.newStatus !== 'approved_for_shadow' || (modelDecision.reviewerUserId !== null && modelDecision.reviewerUserId !== ownerUserId) || !datasetDecision || datasetDecision.newStatus !== 'approved' || datasetDecision.reviewerUserId !== ownerUserId || currentSplit !== latestArtifact.splitManifestFingerprint || trainingInputFingerprint(latestDataset, members) !== trainingSnapshot || members.some(member => !canBePrimaryCitationTruth(member.observation)) || shadowObservationSnapshot(currentShadowObservations) !== shadowObservationSnapshot(expectedShadowObservations) || !await resolveApprovedFallbackForArtifact(ownerUserId, latestArtifact, outcomeRepository)) throw new Error('Shadow dataset, fallback, observations, or owner authorization changed before evaluation was finalized.')
}
export async function evaluateModelOpsShadow(ownerUserId: number, artifactId: string, outcomeRepository: GeoOutcomeRepositoryPort, modelOpsRepository: ModelOpsRepositoryPort, at = new Date()): Promise<ModelOpsShadowEvaluation> {
  assertOwner(ownerUserId)
  const artifact = await outcomeRepository.getArtifact(ownerUserId, artifactId)
  if (!artifact) throw new Error('Model artifact not found.')
  if (isFallbackOnlyArtifact(artifact)) throw new Error('Train-only prior artifacts are fallback-only and cannot enter shadow evaluation.')
  if (!verifyArtifactHash(artifact)) throw new Error('Artifact hash mismatch.')
  if (artifact.status !== 'approved_for_shadow' && artifact.status !== 'shadow_failed') throw new Error('Only approved or recoverable shadow artifacts may be evaluated.')
  if (!await resolveApprovedFallbackForArtifact(ownerUserId, artifact, outcomeRepository)) throw new Error('Candidate fallback authority is no longer current.')
  const datasets = await outcomeRepository.listDatasets(ownerUserId)
  const dataset = datasets.find(item => item.manifestFingerprint === artifact.datasetManifestFingerprint)
  if (!dataset || dataset.status !== 'approved') throw new Error('Artifact dataset is not currently approved.')
  const authority = await assertDatasetKnowledgeAuthorityCurrent(ownerUserId, dataset, outcomeRepository, approvalReference(artifact))
  const trainingMembers = await outcomeRepository.getDatasetMembers(ownerUserId, dataset.manifestId)
  await assertDatasetKnowledgeAuthorityCurrent(ownerUserId, dataset, outcomeRepository, authority.reference)
  const trainingSnapshot = trainingInputFingerprint(dataset, trainingMembers)
  const artifactSplit = splitFingerprint({ train: dataset.trainFingerprints, validation: dataset.validationFingerprints, test: dataset.testFingerprints, siteHoldout: dataset.siteHoldoutFingerprints, queryHoldout: dataset.queryHoldoutFingerprints, temporalHoldout: dataset.temporalHoldoutFingerprints })
  if (artifactSplit !== artifact.splitManifestFingerprint || trainingMembers.some(member => !canBePrimaryCitationTruth(member.observation))) throw new Error('Shadow training dataset split or governance is no longer current.')
  const trainingSet = new Set(dataset.sourceObservationFingerprints)
  const observations = primaryObservations(await outcomeRepository.listObservations(ownerUserId)).filter(item => !trainingSet.has(item.observationFingerprint) && new Date(item.runTimestamp).getTime() > new Date(dataset.observationEnd || 0).getTime())
  const built = buildCitationSelectionDataset(observations, ownerUserId)
  const shadowMembers = built.members
  const observationFingerprints = shadowMembers.map(item => item.observationFingerprint).sort()
  await assertCurrentShadowAuthority(ownerUserId, artifact, dataset, trainingSnapshot, observations, outcomeRepository)
  const priorEvaluations = await modelOpsRepository.listShadowEvaluations(ownerUserId, artifactId)
  const lastEvaluation = priorEvaluations.at(-1) || null
  await assertCurrentShadowAuthority(ownerUserId, artifact, dataset, trainingSnapshot, observations, outcomeRepository)
  const priorMatchesCurrent = lastEvaluation?.artifactHash === artifact.artifactHash && lastEvaluation.status === 'needs_owner_attention' && lastEvaluation.observationFingerprints.length === observationFingerprints.length && lastEvaluation.observationFingerprints.every((item, index) => item === observationFingerprints[index])
  if (priorMatchesCurrent) {
    await append(modelOpsRepository, ownerUserId, `shadow-${artifactId}`, 'shadow_evaluation_completed', { evaluationId: lastEvaluation.evaluationId, status: lastEvaluation.status, reasonCodes: lastEvaluation.reasonCodes })
    await assertCurrentShadowAuthority(ownerUserId, artifact, dataset, trainingSnapshot, observations, outcomeRepository)
    await outcomeRepository.markArtifactShadowFailed(ownerUserId, artifactId)
    await assertCurrentShadowAuthority(ownerUserId, artifact, dataset, trainingSnapshot, observations, outcomeRepository)
    return lastEvaluation
  }
  if (artifact.status === 'shadow_failed') throw new Error('Shadow-failed artifact has no currently authorized recoverable evaluation ledger.')
  const split = built.split || { train: [], validation: [], test: [], siteHoldout: [], queryHoldout: [], temporalHoldout: [] }; const parameters: TrainedParameters = { coefficients: artifact.coefficients, intercept: artifact.intercept, normalizationStatistics: artifact.normalizationStatistics, trainingRowCount: artifact.trainingRowCount, featureKeys: artifact.coefficients.map((_, index) => `feature_${index}`), trainingConfiguration: artifact.trainingConfiguration }; const metrics = evaluateModel(parameters, shadowMembers, split, dataset.taskType); const counts = summary(observations); const predictionCounts = predictedClassCounts(artifact, shadowMembers); const prior = lastEvaluation; const priorF1 = shadowTestF1(prior); const currentF1 = typeof metrics.test.f1 === 'number' && Number.isFinite(metrics.test.f1) ? metrics.test.f1 : null; const metricsRegressed = priorF1 !== null && currentF1 !== null && currentF1 < priorF1 - 0.2; const severe = shadowMembers.length > 0 && (predictionCounts.positive === 0 || predictionCounts.negative === 0 || metricsRegressed); const readiness = getDatasetReadiness(counts); const status: ModelOpsShadowEvaluation['status'] = severe ? 'needs_owner_attention' : !shadowMembers.length || !readiness.ready ? 'insufficient_data' : 'completed'; const evaluationWindowStart = observations.length ? observations.map(item => item.runTimestamp).sort()[0]! : (dataset.observationEnd || at.toISOString()); const evaluationWindowEnd = observations.length ? observations.map(item => item.runTimestamp).sort().at(-1)! : at.toISOString(); const reasonCodes = [...(!shadowMembers.length ? ['no_new_shadow_candidates'] : []), ...(!readiness.ready ? ['insufficient_data'] : []), ...(predictionCounts.positive === 0 || predictionCounts.negative === 0 ? ['zero_prediction_class'] : []), ...(metricsRegressed ? ['metrics_regression_or_drift'] : [])]; const payload = { ownerUserId, artifactId, artifactHash: artifact.artifactHash, evaluationWindowStart, evaluationWindowEnd, observationFingerprints, candidateCount: shadowMembers.length, positiveCount: shadowMembers.filter(item => item.label === 1).length, negativeCount: shadowMembers.filter(item => item.label === 0).length, queryGroupCount: counts.queryGroups, websiteCount: counts.websites, engineCounts: distribution(observations), binaryMetrics: metricObject(metrics), rankingMetrics: { validation: metrics.rankingValidation, test: metrics.rankingTest, temporalHoldout: metrics.rankingTemporalHoldout }, calibrationDiagnostics: { testBrierScore: metrics.test.brierScore, testExpectedCalibrationError: metrics.test.expectedCalibrationError, zeroDenominatorValuesAreNull: true }, driftDiagnostics: { currentEngineCounts: distribution(observations), baselineEngineCounts: dataset.engineCounts, predictionClassCounts: predictionCounts, trainingObservationOverlap: shadowMembers.some(item => trainingSet.has(item.observationFingerprint)), previousTestF1: priorF1, currentTestF1: currentF1 }, status, reasonCodes: [...new Set(reasonCodes)] }; const evaluationFingerprint = fingerprint(payload); const evaluation: ModelOpsShadowEvaluation = { ...payload, evaluationId: `geo-modelops-shadow-${evaluationFingerprint.slice(0, 24)}`, evaluationFingerprint, createdAt: at.toISOString() }; await assertCurrentShadowAuthority(ownerUserId, artifact, dataset, trainingSnapshot, observations, outcomeRepository); const saved = await modelOpsRepository.saveShadowEvaluation(ownerUserId, evaluation); await assertCurrentShadowAuthority(ownerUserId, artifact, dataset, trainingSnapshot, observations, outcomeRepository); await append(modelOpsRepository, ownerUserId, `shadow-${artifactId}`, 'shadow_evaluation_completed', { evaluationId: saved.evaluationId, status: saved.status, reasonCodes: saved.reasonCodes }); await assertCurrentShadowAuthority(ownerUserId, artifact, dataset, trainingSnapshot, observations, outcomeRepository); if (severe) await outcomeRepository.markArtifactShadowFailed(ownerUserId, artifactId); await assertCurrentShadowAuthority(ownerUserId, artifact, dataset, trainingSnapshot, observations, outcomeRepository); return saved
}

export async function rollbackModelOpsArtifact(ownerUserId: number, artifactId: string, rollbackArtifactHash: string, reason: string, outcomeRepository: GeoOutcomeRepositoryPort, modelOpsRepository: ModelOpsRepositoryPort, reviewerUserId = ownerUserId): Promise<{ decision: ModelOpsRollbackDecision, revokedArtifact: Awaited<ReturnType<typeof reviewModel>>['artifact'] }> {
  assertOwner(ownerUserId); if (!/^[a-f0-9]{64}$/u.test(rollbackArtifactHash)) throw new Error('rollbackArtifactHash must be a SHA-256 hash.'); const cleanReason = boundedReason(reason); if (reviewerUserId !== ownerUserId) throw new Error('Rollback reviewer must be the server-derived owner.')
  const current = await outcomeRepository.getArtifact(ownerUserId, artifactId); if (!current) throw new Error('Model artifact not found.'); if (current.status !== 'approved_for_shadow' && current.status !== 'shadow_failed' && current.status !== 'revoked') throw new Error('Only a shadow artifact requiring rollback may be rolled back.')
  const target = (await outcomeRepository.listArtifacts(ownerUserId)).find(item => item.artifactHash === rollbackArtifactHash && item.status === 'approved_for_shadow' && item.taskType === current.taskType && item.modelFamily === current.modelFamily && item.featureCatalogVersion === current.featureCatalogVersion && item.labelContractVersion === current.labelContractVersion); if (!target) throw new Error('Compatible rollback artifact was not found.')
  const decisionFingerprint = fingerprint({ ownerUserId, artifactId, fromArtifactHash: current.artifactHash, rollbackArtifactHash, reviewerUserId, reason: cleanReason }); const decision: ModelOpsRollbackDecision = { decisionId: `geo-modelops-rollback-${decisionFingerprint.slice(0, 24)}`, ownerUserId, artifactId, fromArtifactHash: current.artifactHash, rollbackArtifactHash, reviewerUserId, reason: cleanReason, decisionStatus: 'approved', createdAt: now() }; const saved = await modelOpsRepository.appendRollbackDecision(ownerUserId, decision)
  const advisory = (await modelOpsRepository.listAdvisoryAssignments(ownerUserId)).find(item => item.status === 'advisory' && item.candidateArtifactHash === current.artifactHash)
  if (advisory) await rollbackModelOpsAdvisory({ ownerUserId, assignmentId: advisory.assignmentId, expectedVersion: advisory.version, reasonCodes: ['artifact_revoked', 'owner_rollback_lineage'], now: new Date() }, modelOpsRepository)
  if (current.status === 'revoked') { await append(modelOpsRepository, ownerUserId, `rollback-${artifactId}`, 'owner_rollback_approved', { decisionId: saved.decisionId, rollbackArtifactHash }); return { decision: saved, revokedArtifact: artifactSummary(current) } }
  const revokedArtifact = await reviewModel(ownerUserId, artifactId, 'revoke', reviewerUserId, cleanReason, outcomeRepository); await append(modelOpsRepository, ownerUserId, `rollback-${artifactId}`, 'owner_rollback_approved', { decisionId: saved.decisionId, rollbackArtifactHash }); return { decision: saved, revokedArtifact: revokedArtifact.artifact }
}

export async function getModelOpsWorkspace(ownerUserId: number, outcomeRepository: GeoOutcomeRepositoryPort, modelOpsRepository: ModelOpsRepositoryPort): Promise<ModelOpsWorkspace> {
  assertOwner(ownerUserId); const outcome = await getWorkspace(ownerUserId, outcomeRepository); const policies = await modelOpsRepository.listPolicies(ownerUserId); return { ownerUserId, policy: policies.sort((a, b) => a.updatedAt.localeCompare(b.updatedAt)).at(-1) || null, cycles: await modelOpsRepository.listCycles(ownerUserId), events: await modelOpsRepository.listEvents(ownerUserId), shadowEvaluations: await modelOpsRepository.listShadowEvaluations(ownerUserId), rollbackDecisions: await modelOpsRepository.listRollbackDecisions(ownerUserId), advisoryAssignments: await modelOpsRepository.listAdvisoryAssignments(ownerUserId), outcome: { readiness: outcome.readiness, datasets: outcome.datasets, trainingRuns: outcome.trainingRuns, models: outcome.models, datasetDecisions: outcome.datasetDecisions, modelDecisions: outcome.decisions } }
}

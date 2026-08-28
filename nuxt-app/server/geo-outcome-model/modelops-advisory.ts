import { fingerprint } from './canonical'
import type { ModelOpsAdvisoryAssignment, ModelOpsRepositoryPort } from './modelops-types'

const sha = (value: string, label: string) => { if (!/^[a-f0-9]{64}$/u.test(value)) throw new Error(`${label} must be a SHA-256 hash.`); return value }

export async function assignModelOpsAdvisory(input: { ownerUserId: number; policyId: string; currentArtifactHash: string; candidateArtifactHash: string; now?: Date }, repository: ModelOpsRepositoryPort): Promise<ModelOpsAdvisoryAssignment> {
  const at = input.now || new Date()
  const currentArtifactHash = sha(input.currentArtifactHash, 'currentArtifactHash')
  const candidateArtifactHash = sha(input.candidateArtifactHash, 'candidateArtifactHash')
  if (currentArtifactHash === candidateArtifactHash) throw new Error('Candidate and current artifacts must differ.')
  const policy = await repository.getPolicy(input.ownerUserId, input.policyId)
  if (!policy || policy.status !== 'enabled' || !policy.autonomousExecutionEnabled || !policy.authorizedByOwnerUserId || policy.authorizedByOwnerUserId !== input.ownerUserId || (policy.expiresAt && Date.parse(policy.expiresAt) <= at.getTime())) throw new Error('Owner ModelOps policy does not authorize advisory assignment.')
  const evaluation = (await repository.listShadowEvaluations(input.ownerUserId)).filter(item => item.artifactHash === candidateArtifactHash).sort((a, b) => a.createdAt.localeCompare(b.createdAt)).at(-1)
  if (!evaluation || evaluation.status !== 'completed' || evaluation.reasonCodes.some(code => /degrad|drift|zero_prediction|insufficient/iu.test(code))) throw new Error('Candidate shadow evaluation is missing, incomplete, or degraded; advisory assignment stopped.')
  const base = { contractVersion: 'modelops-advisory-assignment-v1', ownerUserId: input.ownerUserId, policyId: policy.policyId, policyFingerprint: policy.configurationFingerprint, currentArtifactHash, candidateArtifactHash, shadowEvaluationFingerprint: evaluation.evaluationFingerprint, status: 'advisory' as const }
  const assignmentFingerprint = fingerprint(base)
  return repository.saveAdvisoryAssignment(input.ownerUserId, { ...base, assignmentId: `geo-modelops-advisory-${assignmentFingerprint.slice(0, 24)}`, activeScopeKey: `owner-${input.ownerUserId}:advisory`, version: 1, rollbackFromAssignmentId: null, assignmentFingerprint, createdAt: at.toISOString(), rolledBackAt: null })
}

export async function rollbackModelOpsAdvisory(input: { ownerUserId: number; assignmentId: string; expectedVersion: number; now?: Date }, repository: ModelOpsRepositoryPort): Promise<ModelOpsAdvisoryAssignment> {
  const current = (await repository.listAdvisoryAssignments(input.ownerUserId)).find(item => item.assignmentId === input.assignmentId)
  if (!current || current.status !== 'advisory') throw new Error('Active advisory assignment was not found.')
  const rolledBack = await repository.compareAndSwapAdvisoryAssignment(input.ownerUserId, input.assignmentId, input.expectedVersion, { status: 'rolled_back', activeScopeKey: null, version: input.expectedVersion + 1, rollbackFromAssignmentId: current.assignmentId, rolledBackAt: (input.now || new Date()).toISOString() })
  if (!rolledBack) throw new Error('Advisory rollback compare-and-swap collision.')
  return rolledBack
}

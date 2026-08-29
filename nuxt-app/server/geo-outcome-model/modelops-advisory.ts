import { fingerprint } from './canonical'
import type { GeoOutcomeRepositoryPort } from './types'
import type { ModelOpsAdvisoryAssignment, ModelOpsRepositoryPort } from './modelops-types'

const sha = (value: string, label: string) => { if (!/^[a-f0-9]{64}$/u.test(value)) throw new Error(`${label} must be a SHA-256 hash.`); return value }
const splitFor = (dataset: Awaited<ReturnType<GeoOutcomeRepositoryPort['listDatasets']>>[number]) => ({ train: dataset.trainFingerprints, validation: dataset.validationFingerprints, test: dataset.testFingerprints, siteHoldout: dataset.siteHoldoutFingerprints, queryHoldout: dataset.queryHoldoutFingerprints, temporalHoldout: dataset.temporalHoldoutFingerprints })

export async function assignModelOpsAdvisory(input: { ownerUserId: number; policyId: string; cycleId: string; candidateArtifactId: string; currentArtifactHash: string; now?: Date }, outcomeRepository: GeoOutcomeRepositoryPort, repository: ModelOpsRepositoryPort): Promise<ModelOpsAdvisoryAssignment> {
  const at = input.now || new Date()
  const currentArtifactHash = sha(input.currentArtifactHash, 'currentArtifactHash')
  if (!input.cycleId.trim() || !input.candidateArtifactId.trim()) throw new Error('Advisory cycle and artifact lineage are required.')
  const policy = await repository.getPolicy(input.ownerUserId, input.policyId)
  if (!policy || policy.status !== 'enabled' || !policy.autonomousExecutionEnabled || !policy.authorizedByOwnerUserId || policy.authorizedByOwnerUserId !== input.ownerUserId || (policy.expiresAt && Date.parse(policy.expiresAt) <= at.getTime())) throw new Error('Owner ModelOps policy does not authorize advisory assignment.')

  const cycle = await repository.getCycle(input.ownerUserId, input.cycleId)
  if (!cycle || cycle.policyId !== policy.policyId || cycle.policyFingerprint !== policy.configurationFingerprint || cycle.status !== 'running' || cycle.modelArtifactId !== input.candidateArtifactId || !cycle.artifactHash || !cycle.generatedDatasetFingerprint || !cycle.shadowEvaluationFingerprint) throw new Error('Durable cycle lineage does not authorize advisory assignment.')
  const candidate = await outcomeRepository.getArtifact(input.ownerUserId, input.candidateArtifactId)
  if (!candidate || candidate.artifactHash !== cycle.artifactHash || candidate.status !== 'approved_for_shadow') throw new Error('Durable candidate artifact lineage is missing or inconsistent.')
  const candidateArtifactHash = sha(candidate.artifactHash, 'candidateArtifactHash')
  if (currentArtifactHash === candidateArtifactHash) throw new Error('Candidate and current artifacts must differ.')
  const current = (await outcomeRepository.listArtifacts(input.ownerUserId)).find(item => item.artifactHash === currentArtifactHash)
  if (!current || current.status !== 'approved_for_shadow' || current.taskType !== candidate.taskType || current.modelFamily !== candidate.modelFamily || current.featureCatalogVersion !== candidate.featureCatalogVersion || current.labelContractVersion !== candidate.labelContractVersion) throw new Error('Durable compatible current artifact was not found.')

  const dataset = (await outcomeRepository.listDatasets(input.ownerUserId)).find(item => item.manifestFingerprint === candidate.datasetManifestFingerprint)
  if (!dataset || dataset.manifestFingerprint !== cycle.generatedDatasetFingerprint) throw new Error('Durable candidate dataset lineage is missing or inconsistent.')
  const members = await outcomeRepository.getDatasetMembers(input.ownerUserId, dataset.manifestId)
  const durableRowCount = dataset.trainRowCount + dataset.validationRowCount + dataset.testRowCount + dataset.siteHoldoutRowCount + dataset.queryHoldoutRowCount + dataset.temporalHoldoutRowCount
  if (members.length !== durableRowCount) throw new Error('Durable dataset member count is inconsistent.')
  const datasetFingerprint = sha(dataset.manifestFingerprint, 'datasetFingerprint')
  const splitFingerprint = fingerprint(splitFor(dataset))

  const evaluation = (await repository.listShadowEvaluations(input.ownerUserId, candidate.artifactId)).filter(item => item.artifactHash === candidateArtifactHash && item.evaluationFingerprint === cycle.shadowEvaluationFingerprint).sort((a, b) => a.createdAt.localeCompare(b.createdAt)).at(-1)
  if (!evaluation || evaluation.status !== 'completed' || evaluation.reasonCodes.some(code => /degrad|drift|zero_prediction|insufficient/iu.test(code))) throw new Error('Candidate shadow evaluation is missing, incomplete, or degraded; advisory assignment stopped.')
  const metricsFingerprint = fingerprint({ binaryMetrics: evaluation.binaryMetrics, rankingMetrics: evaluation.rankingMetrics, calibrationDiagnostics: evaluation.calibrationDiagnostics, driftDiagnostics: evaluation.driftDiagnostics })
  const base = { contractVersion: 'modelops-advisory-assignment-v3', ownerUserId: input.ownerUserId, policyId: policy.policyId, policyFingerprint: policy.configurationFingerprint, cycleId: cycle.cycleId, candidateArtifactId: candidate.artifactId, currentArtifactHash, candidateArtifactHash, datasetFingerprint, splitFingerprint, metricsFingerprint, shadowEvaluationFingerprint: evaluation.evaluationFingerprint, reasonCodes: ['shadow_completed', 'advisory_only'], productionActivation: false as const, status: 'advisory' as const }
  const assignmentFingerprint = fingerprint(base)
  return repository.saveAdvisoryAssignment(input.ownerUserId, { ...base, assignmentId: `geo-modelops-advisory-${assignmentFingerprint.slice(0, 24)}`, activeScopeKey: `owner-${input.ownerUserId}:advisory`, version: 1, rollbackFromAssignmentId: null, assignmentFingerprint, createdAt: at.toISOString(), rolledBackAt: null })
}

export async function rollbackModelOpsAdvisory(input: { ownerUserId: number; assignmentId: string; expectedVersion: number; reasonCodes?: string[]; now?: Date }, repository: ModelOpsRepositoryPort): Promise<ModelOpsAdvisoryAssignment> {
  const current = (await repository.listAdvisoryAssignments(input.ownerUserId)).find(item => item.assignmentId === input.assignmentId)
  if (!current || current.status !== 'advisory') throw new Error('Active advisory assignment was not found.')
  const rolledBack = await repository.compareAndSwapAdvisoryAssignment(input.ownerUserId, input.assignmentId, input.expectedVersion, { status: 'rolled_back', activeScopeKey: null, version: input.expectedVersion + 1, rollbackFromAssignmentId: current.assignmentId, reasonCodes: [...new Set(input.reasonCodes?.length ? input.reasonCodes : ['automatic_advisory_rollback'])], productionActivation: false, rolledBackAt: (input.now || new Date()).toISOString() })
  if (!rolledBack) throw new Error('Advisory rollback compare-and-swap collision.')
  return rolledBack
}

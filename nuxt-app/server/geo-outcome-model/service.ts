import { fingerprint } from './canonical'
import { buildCitationSelectionDataset, getDatasetReadiness, getShadowReadiness } from './dataset-builder'
import { deriveFeatureVector } from './feature-catalog'
import { createModelArtifact, summarizeArtifact } from './artifact'
import { evaluateModel } from './evaluator'
import { assertObservationIsUsable, canBePrimaryCitationTruth, normalizeManualObservation } from './observation-contract'
import { DrizzleGeoOutcomeRepository } from './repository-drizzle'
import { evaluatePromotionGate, verifyArtifactHash } from './release-gate'
import { assertDisjointComplete, splitFingerprint } from './split-policy'
import { parseModelFamily, parseTrainingConfig, scoreWithParameters, standardizedFeatureContributions, trainDeterministicBaseline } from './trainer'
import { GEO_OUTCOME_FEATURE_CATALOG_VERSION, GEO_OUTCOME_LABEL_CONTRACT_VERSION, GEO_OUTCOME_TRAIN_PRIOR_VERSION, type TaskType } from './constants'
import { buildTrainOnlyPriorArtifact, isExactTrainOnlyPriorArtifact } from './bootstrap-baseline'
import type { DatasetDecision, DatasetManifest, DatasetMember, ExperimentalPrediction, GeoOutcomeRepositoryPort, ModelArtifact, ModelArtifactSummary, ModelDecision, ObservationGovernanceAction, OutcomeObservation, TrainingConfig, TrainingRun, WorkspaceSummary } from './types'

const DEFAULT_CONFIG: TrainingConfig = { epochs: 80, learningRate: 0.12, l2: 0.01, seed: 0, featureCatalogVersion: 'geo-outcome-feature-catalog-v1' }
const now = () => new Date().toISOString()
export function getProductionGeoOutcomeRepository(): GeoOutcomeRepositoryPort { return new DrizzleGeoOutcomeRepository() }
function repoOrProduction(repository?: GeoOutcomeRepositoryPort): GeoOutcomeRepositoryPort { return repository || getProductionGeoOutcomeRepository() }
function splitFor(dataset: DatasetManifest) { return { train: dataset.trainFingerprints, validation: dataset.validationFingerprints, test: dataset.testFingerprints, siteHoldout: dataset.siteHoldoutFingerprints, queryHoldout: dataset.queryHoldoutFingerprints, temporalHoldout: dataset.temporalHoldoutFingerprints } }
function metricsAreComplete(artifact: ModelArtifact): boolean { return artifact.evaluationMetrics.test.status === 'ok' && artifact.evaluationMetrics.temporalHoldout.status === 'ok' }
function exactSet(left: readonly string[], right: readonly string[]): boolean { return left.length === right.length && new Set(left).size === left.length && left.every(value => right.includes(value)) }
export async function recordManualObservation(ownerUserId: number, input: unknown, repository?: GeoOutcomeRepositoryPort): Promise<OutcomeObservation> { const repo = repoOrProduction(repository); const observation = normalizeManualObservation(input, ownerUserId); assertObservationIsUsable(observation); return repo.saveObservationTransactional(ownerUserId, observation) }
export async function verifyObservation(ownerUserId: number, observationFingerprint: string, reviewerUserId: number, action: Exclude<ObservationGovernanceAction, 'verify_evidence'>, reason: string, repository?: GeoOutcomeRepositoryPort) { if (!reason || reason.length > 500) throw new Error('Governance review reason is required and bounded.'); return repoOrProduction(repository).verifyObservationTransactional(ownerUserId, observationFingerprint, reviewerUserId, action, reason) }

export async function bindAndVerifyObservationEvidence(ownerUserId: number, observationFingerprint: string, reviewerUserId: number, sourceRecordId: number, reason: string, repository?: GeoOutcomeRepositoryPort) {
  if (!Number.isSafeInteger(sourceRecordId) || sourceRecordId <= 0) throw new Error('sourceRecordId must identify an authoritative LLM visibility observation.')
  if (!reason || reason.length > 500) throw new Error('Governance review reason is required and bounded.')
  const repo = repoOrProduction(repository)
  return repo.transaction(async transaction => {
    const binding = await transaction.bindAuthoritativeEvidenceTransactional(ownerUserId, observationFingerprint, sourceRecordId)
    const verified = await transaction.verifyObservationTransactional(ownerUserId, observationFingerprint, reviewerUserId, 'verify_evidence', reason, binding.evidenceLocatorHash)
    return { ...verified, evidenceBinding: binding }
  })
}

export async function buildDataset(ownerUserId: number, taskType: TaskType = 'citation_selection', repository?: GeoOutcomeRepositoryPort): Promise<{ manifest: DatasetManifest, memberCount: number }> {
  if (taskType !== 'citation_selection') throw new Error('Structural auxiliary datasets require an approved structural adapter and cannot be created from citation observations.')
  const repo = repoOrProduction(repository)
  const result = buildCitationSelectionDataset(await repo.listObservations(ownerUserId), ownerUserId)
  const manifest = await repo.saveDatasetTransactional(ownerUserId, result.manifest, result.members)
  // Report committed metadata and lifecycle state, including an immutable replay,
  // rather than the pure builder's pre-persistence timestamp/status placeholders.
  return { manifest, memberCount: result.members.length }
}
export async function reviewDataset(ownerUserId: number, manifestId: string, decision: 'approve' | 'revoke', reviewerUserId: number, reason: string, repository?: GeoOutcomeRepositoryPort): Promise<{ manifest: DatasetManifest, decision: DatasetDecision }> { if (!Number.isSafeInteger(reviewerUserId) || reviewerUserId <= 0) throw new Error('reviewerUserId must be server-derived.'); if (!reason || reason.length > 500) throw new Error('Owner review reason is required and bounded.'); const repo = repoOrProduction(repository); const current = await repo.getDataset(ownerUserId, manifestId); if (!current) throw new Error('Dataset manifest not found.'); return repo.transitionDatasetWithDecision(ownerUserId, manifestId, decision === 'approve' ? 'approved' : 'revoked', reviewerUserId, reason) }

function latestDatasetDecision(decisions: DatasetDecision[], manifest: DatasetManifest): DatasetDecision | null { return decisions.filter(item => item.manifestId === manifest.manifestId && item.manifestFingerprint === manifest.manifestFingerprint).at(-1) || null }
function hasDurableDatasetApproval(decisions: DatasetDecision[], manifest: DatasetManifest): boolean { return manifest.status === 'approved' && latestDatasetDecision(decisions, manifest)?.newStatus === 'approved' }
function uniqueMembers(members: DatasetMember[]): DatasetMember[] { return [...new Map(members.map(member => [member.observationFingerprint, member])).values()] }
function hasCurrentDatasetApproval(decisions: DatasetDecision[], manifest: DatasetManifest, ownerUserId: number): boolean { const decision = latestDatasetDecision(decisions, manifest); return manifest.ownerUserId === ownerUserId && manifest.status === 'approved' && decision?.newStatus === 'approved' && (decision.reviewerUserId === null || decision.reviewerUserId === ownerUserId) }
function hasDurableOwnerDatasetApproval(decisions: DatasetDecision[], manifest: DatasetManifest, ownerUserId: number): boolean { const decision = latestDatasetDecision(decisions, manifest); return hasCurrentDatasetApproval(decisions, manifest, ownerUserId) && decision?.reviewerUserId === ownerUserId }
function latestModelApproval(decisions: ModelDecision[], artifact: ModelArtifact): ModelDecision | null { return decisions.filter(item => item.modelArtifactId === artifact.artifactId && item.artifactHash === artifact.artifactHash && item.datasetManifestHash === artifact.datasetManifestFingerprint).at(-1) || null }
function hasCurrentModelApproval(decisions: ModelDecision[], artifact: ModelArtifact, ownerUserId: number): boolean { const decision = latestModelApproval(decisions, artifact); return artifact.ownerUserId === ownerUserId && artifact.status === 'approved_for_shadow' && decision?.newStatus === 'approved_for_shadow' && (decision.reviewerUserId === null || decision.reviewerUserId === ownerUserId) }
function hasDurableModelApproval(decisions: ModelDecision[], artifact: ModelArtifact, ownerUserId: number): boolean { return hasCurrentModelApproval(decisions, artifact, ownerUserId) && latestModelApproval(decisions, artifact)?.reviewerUserId === ownerUserId }

async function isCurrentlyApprovedFallback(ownerUserId: number, artifact: ModelArtifact, repo: GeoOutcomeRepositoryPort, artifacts: ModelArtifact[], datasets: DatasetManifest[], datasetDecisions: DatasetDecision[], modelDecisions: ModelDecision[], ancestors = new Set<string>()): Promise<boolean> {
  if (ancestors.size >= artifacts.length || ancestors.has(artifact.artifactHash) || artifact.ownerUserId !== ownerUserId || artifact.status !== 'approved_for_shadow' || !verifyArtifactHash(artifact) || !hasCurrentModelApproval(modelDecisions, artifact, ownerUserId)) return false
  const dataset = datasets.find(item => item.manifestFingerprint === artifact.datasetManifestFingerprint)
  if (!dataset || !hasCurrentDatasetApproval(datasetDecisions, dataset, ownerUserId)) return false
  const members = await repo.getDatasetMembers(ownerUserId, dataset.manifestId)
  if (members.some(member => !canBePrimaryCitationTruth(member.observation))) return false
  if (artifact.modelVersion === GEO_OUTCOME_TRAIN_PRIOR_VERSION) {
    if (!hasDurableModelApproval(modelDecisions, artifact, ownerUserId) || !isExactTrainOnlyPriorArtifact(artifact, dataset, members)) return false
    const observationSpanDays = dataset.observationStart && dataset.observationEnd ? Math.floor((new Date(dataset.observationEnd).getTime() - new Date(dataset.observationStart).getTime()) / 86_400_000) : null
    return evaluatePromotionGate({ dataset, members, artifact, ownerApproved: true, rollbackArtifact: null, target: 'shadow', shadowReadiness: getShadowReadiness({ candidates: dataset.sourceObservationFingerprints.length, queryGroups: dataset.queryGroupCount, websites: dataset.websiteCount, engines: Object.keys(dataset.engineCounts).length, positives: dataset.positiveCount, hardNegatives: dataset.hardNegativeCount, observationSpanDays, temporalHoldoutCount: dataset.temporalHoldoutRowCount, hasPrimaryEvidence: Boolean(dataset.sourceBasisCounts.manual_verified_primary || dataset.sourceBasisCounts.consumer_surface_observed) }) }).status === 'pass'
  }
  const rollback = artifacts.find(item => item.artifactHash === artifact.rollbackArtifactHash)
  if (!rollback || rollback.artifactHash === artifact.artifactHash || rollback.ownerUserId !== ownerUserId || rollback.taskType !== artifact.taskType || rollback.modelFamily !== artifact.modelFamily || rollback.featureCatalogVersion !== artifact.featureCatalogVersion || rollback.labelContractVersion !== artifact.labelContractVersion) return false
  const nextAncestors = new Set(ancestors).add(artifact.artifactHash)
  if (!await isCurrentlyApprovedFallback(ownerUserId, rollback, repo, artifacts, datasets, datasetDecisions, modelDecisions, nextAncestors)) return false
  const observationSpanDays = dataset.observationStart && dataset.observationEnd ? Math.floor((new Date(dataset.observationEnd).getTime() - new Date(dataset.observationStart).getTime()) / 86_400_000) : null
  const gate = evaluatePromotionGate({ dataset, members, artifact, ownerApproved: true, rollbackArtifact: rollback, target: 'shadow', shadowReadiness: getShadowReadiness({ candidates: dataset.sourceObservationFingerprints.length, queryGroups: dataset.queryGroupCount, websites: dataset.websiteCount, engines: Object.keys(dataset.engineCounts).length, positives: dataset.positiveCount, hardNegatives: dataset.hardNegativeCount, observationSpanDays, temporalHoldoutCount: dataset.temporalHoldoutRowCount, hasPrimaryEvidence: Boolean(dataset.sourceBasisCounts.manual_verified_primary || dataset.sourceBasisCounts.consumer_surface_observed) }) })
  return gate.status === 'pass'
}

async function approvedCompatibleFallback(ownerUserId: number, taskType: TaskType, modelFamily: ModelArtifact['modelFamily'], repo: GeoOutcomeRepositoryPort): Promise<ModelArtifact | null> {
  const [artifacts, datasets, datasetDecisions, modelDecisions] = await Promise.all([repo.listArtifacts(ownerUserId), repo.listDatasets(ownerUserId), repo.listDatasetDecisions(ownerUserId), repo.listDecisions(ownerUserId)])
  const candidates = artifacts.filter(item => item.status === 'approved_for_shadow' && item.taskType === taskType && item.modelFamily === modelFamily && item.featureCatalogVersion === GEO_OUTCOME_FEATURE_CATALOG_VERSION && item.labelContractVersion === GEO_OUTCOME_LABEL_CONTRACT_VERSION).sort((left, right) => (latestModelApproval(modelDecisions, right)?.createdAt || '').localeCompare(latestModelApproval(modelDecisions, left)?.createdAt || ''))
  for (const artifact of candidates) if (await isCurrentlyApprovedFallback(ownerUserId, artifact, repo, artifacts, datasets, datasetDecisions, modelDecisions)) return artifact
  return null
}

export async function resolveApprovedFallbackForArtifact(ownerUserId: number, artifact: ModelArtifact, repository: GeoOutcomeRepositoryPort): Promise<ModelArtifact | null> {
  if (!artifact.rollbackArtifactHash || artifact.rollbackArtifactHash === artifact.artifactHash) return null
  const artifacts = await repository.listArtifacts(ownerUserId)
  const fallback = artifacts.find(item => item.artifactHash === artifact.rollbackArtifactHash)
  if (!fallback || fallback.ownerUserId !== ownerUserId || fallback.taskType !== artifact.taskType || fallback.modelFamily !== artifact.modelFamily || fallback.featureCatalogVersion !== artifact.featureCatalogVersion || fallback.labelContractVersion !== artifact.labelContractVersion) return null
  const [datasets, datasetDecisions, modelDecisions] = await Promise.all([repository.listDatasets(ownerUserId), repository.listDatasetDecisions(ownerUserId), repository.listDecisions(ownerUserId)])
  return await isCurrentlyApprovedFallback(ownerUserId, fallback, repository, artifacts, datasets, datasetDecisions, modelDecisions) ? fallback : null
}

async function resolveReservedFallback(ownerUserId: number, dataset: DatasetManifest, modelFamily: ModelArtifact['modelFamily'], artifactHash: string | null, repository: GeoOutcomeRepositoryPort): Promise<ModelArtifact | null> {
  if (!artifactHash) return null
  const artifacts = await repository.listArtifacts(ownerUserId)
  const fallback = artifacts.find(item => item.artifactHash === artifactHash)
  if (!fallback || fallback.ownerUserId !== ownerUserId || fallback.taskType !== dataset.taskType || fallback.modelFamily !== modelFamily || fallback.featureCatalogVersion !== GEO_OUTCOME_FEATURE_CATALOG_VERSION || fallback.labelContractVersion !== GEO_OUTCOME_LABEL_CONTRACT_VERSION) return null
  const [datasets, datasetDecisions, modelDecisions] = await Promise.all([repository.listDatasets(ownerUserId), repository.listDatasetDecisions(ownerUserId), repository.listDecisions(ownerUserId)])
  return await isCurrentlyApprovedFallback(ownerUserId, fallback, repository, artifacts, datasets, datasetDecisions, modelDecisions) ? fallback : null
}

export function trainingInputFingerprint(dataset: DatasetManifest, members: DatasetMember[]): string {
  return fingerprint({
    manifestFingerprint: dataset.manifestFingerprint,
    splitFingerprint: splitFingerprint(splitFor(dataset)),
    members: [...members].sort((left, right) => left.observationFingerprint < right.observationFingerprint ? -1 : left.observationFingerprint > right.observationFingerprint ? 1 : 0).map(member => ({ observationFingerprint: member.observationFingerprint, splitAssignment: member.splitAssignment, label: member.label, hardNegative: member.hardNegative, consentStatus: member.consentStatus, piiStatus: member.piiStatus, reviewFingerprint: member.reviewFingerprint, featureVector: member.featureVector, observation: member.observation })),
  })
}

export async function createTrainingRun(ownerUserId: number, input: { datasetManifestId: string, modelFamily: unknown, config?: unknown }, repository?: GeoOutcomeRepositoryPort): Promise<TrainingRun> { const modelFamily = parseModelFamily(input.modelFamily); const config = input.config === undefined ? DEFAULT_CONFIG : parseTrainingConfig(input.config); const repo = repoOrProduction(repository); const dataset = await repo.getDataset(ownerUserId, input.datasetManifestId); if (!dataset) throw new Error('Dataset manifest not found.'); const rollbackArtifact = await approvedCompatibleFallback(ownerUserId, dataset.taskType, modelFamily, repo); const rollbackArtifactHash = rollbackArtifact?.artifactHash || null; const runFingerprint = fingerprint({ ownerUserId, datasetManifestId: input.datasetManifestId, modelFamily, config, rollbackArtifactHash }); const run: TrainingRun = { trainingRunId: `geo-training-${runFingerprint.slice(0, 20)}`, ownerUserId, datasetManifestId: input.datasetManifestId, modelFamily, status: 'queued', config, rollbackArtifactHash, artifactId: null, artifactHash: null, metrics: null, reason: null, createdAt: now(), startedAt: null, completedAt: null, leaseOwner: null, leaseExpiresAt: null, version: 0 }; return repo.createTrainingRun(ownerUserId, run) }

export async function executeTrainingRun(ownerUserId: number, trainingRunId: string, repository?: GeoOutcomeRepositoryPort): Promise<TrainingRun> {
  const repo = repoOrProduction(repository); const run = await repo.getTrainingRun(ownerUserId, trainingRunId); if (!run) throw new Error('Training run not found.'); if (run.status === 'completed' || run.status === 'blocked' || run.status === 'failed') return run
  const claim = await repo.claimTrainingRun(ownerUserId, trainingRunId, `geo-worker-${process.pid}`, new Date(Date.now() + 300_000).toISOString())
  if (claim.outcome === 'replay' || claim.outcome === 'in_progress' || claim.outcome === 'collision') return claim.run
  const running = claim.run
  const dataset = await repo.getDataset(ownerUserId, running.datasetManifestId); if (!dataset) throw new Error('Dataset manifest not found.')
  const datasetDecisions = await repo.listDatasetDecisions(ownerUserId)
  if (!hasCurrentDatasetApproval(datasetDecisions, dataset, ownerUserId)) return repo.transitionTrainingRun(ownerUserId, trainingRunId, { status: 'blocked', reason: 'Dataset manifest requires current durable approval before training.', completedAt: now(), leaseOwner: null, leaseExpiresAt: null, version: running.version })
  const members = await repo.getDatasetMembers(ownerUserId, dataset.manifestId); const split = splitFor(dataset)
  if (members.some(member => !canBePrimaryCitationTruth(member.observation))) return repo.transitionTrainingRun(ownerUserId, trainingRunId, { status: 'blocked', reason: 'Dataset governance facts were revoked, stale, or incomplete at training time.', completedAt: now(), leaseOwner: null, leaseExpiresAt: null, version: running.version })
  try { assertDisjointComplete(split, members) } catch (error) { return repo.transitionTrainingRun(ownerUserId, trainingRunId, { status: 'blocked', reason: error instanceof Error ? error.message : 'gate_blocked: invalid split.', completedAt: now(), leaseOwner: null, leaseExpiresAt: null, version: running.version }) }
  if (!dataset.readiness.ready || !dataset.trainRowCount || !dataset.validationRowCount || !dataset.testRowCount || !dataset.siteHoldoutRowCount || !dataset.queryHoldoutRowCount || !dataset.temporalHoldoutRowCount) return repo.transitionTrainingRun(ownerUserId, trainingRunId, { status: 'blocked', reason: 'Dataset manifest is gate_blocked or has incomplete leakage-safe splits.', completedAt: now(), leaseOwner: null, leaseExpiresAt: null, version: running.version })
  const trainRows = members.filter(member => member.splitAssignment === 'train'); if (!exactSet(trainRows.map(member => member.observationFingerprint), dataset.trainFingerprints) || trainRows.length !== dataset.trainRowCount) return repo.transitionTrainingRun(ownerUserId, trainingRunId, { status: 'blocked', reason: 'Training split rows do not exactly match durable manifest.', completedAt: now(), leaseOwner: null, leaseExpiresAt: null, version: running.version })
  const trainingSnapshotFingerprint = trainingInputFingerprint(dataset, members)
  try {
    if (running.rollbackArtifactHash === undefined) throw new Error('Legacy training reservation has no immutable rollback snapshot; create a new training run.')
    const reservedRollbackArtifactHash: string | null = running.rollbackArtifactHash
    const rollbackArtifact = await resolveReservedFallback(ownerUserId, dataset, running.modelFamily, reservedRollbackArtifactHash, repo)
    if ((reservedRollbackArtifactHash && !rollbackArtifact) || (rollbackArtifact?.artifactHash || null) !== reservedRollbackArtifactHash) throw new Error('Reserved fallback authority is no longer current.')
    const parameters = trainDeterministicBaseline(running.modelFamily, trainRows, running.config); if (parameters.trainingRowCount !== dataset.trainRowCount) throw new Error('trainingRowCount must equal train split row count.')
    const metrics = evaluateModel(parameters, members, split, dataset.taskType); const artifact = createModelArtifact({ ownerUserId, taskType: dataset.taskType, modelFamily: running.modelFamily, datasetManifestFingerprint: dataset.manifestFingerprint, splitManifestFingerprint: splitFingerprint(split), parameters, evaluationMetrics: metrics, rollbackArtifactHash: reservedRollbackArtifactHash })
    if (artifact.trainingRowCount !== dataset.trainRowCount) throw new Error('Artifact trainingRowCount mismatch.')
    return await repo.transaction(async (transaction) => {
      const currentDataset = await transaction.getDataset(ownerUserId, dataset.manifestId)
      if (!currentDataset || !hasCurrentDatasetApproval(await transaction.listDatasetDecisions(ownerUserId), currentDataset, ownerUserId) || currentDataset.manifestFingerprint !== dataset.manifestFingerprint || splitFingerprint(splitFor(currentDataset)) !== splitFingerprint(split)) throw new Error('Dataset approval or split changed before artifact persistence.')
      const currentMembers = await transaction.getDatasetMembers(ownerUserId, dataset.manifestId)
      if (currentMembers.some(member => !canBePrimaryCitationTruth(member.observation)) || trainingInputFingerprint(currentDataset, currentMembers) !== trainingSnapshotFingerprint) throw new Error('Dataset members, features, or governance changed before artifact persistence.')
      const currentFallback = await resolveReservedFallback(ownerUserId, currentDataset, running.modelFamily, reservedRollbackArtifactHash, transaction)
      if ((reservedRollbackArtifactHash && !currentFallback) || (currentFallback?.artifactHash || null) !== reservedRollbackArtifactHash || artifact.rollbackArtifactHash !== reservedRollbackArtifactHash) throw new Error('Reserved fallback authority changed before immutable artifact persistence.')
      await transaction.saveArtifactTransactional(ownerUserId, artifact)
      return transaction.transitionTrainingRun(ownerUserId, trainingRunId, { status: 'completed', artifactId: artifact.artifactId, artifactHash: artifact.artifactHash, metrics, completedAt: now(), leaseOwner: null, leaseExpiresAt: null, reason: null, version: running.version })
    })
  } catch (error) { return repo.transitionTrainingRun(ownerUserId, trainingRunId, { status: 'failed', reason: error instanceof Error ? error.message : 'Training failed.', completedAt: now(), leaseOwner: null, leaseExpiresAt: null, version: running.version }) }
}

export async function reviewModel(ownerUserId: number, artifactId: string, decision: 'approve_for_shadow' | 'revoke', reviewerUserId: number, reason: string, repository?: GeoOutcomeRepositoryPort): Promise<{ artifact: ModelArtifactSummary, gate: ReturnType<typeof evaluatePromotionGate>, ledger: ModelDecision }> {
  if (!Number.isSafeInteger(reviewerUserId) || reviewerUserId !== ownerUserId) throw new Error('reviewerUserId must be the server-derived owner.')
  if (!reason || reason.length > 500) throw new Error('Owner review reason is required and bounded.')
  const repo = repoOrProduction(repository)
  if (decision === 'revoke') return repo.transaction(async transaction => {
    const artifact = await transaction.getArtifact(ownerUserId, artifactId)
    if (!artifact) throw new Error('Model artifact not found.')
    const transitioned = await transaction.transitionArtifactWithDecision(ownerUserId, artifactId, 'revoked', reviewerUserId, reason, artifact.datasetManifestFingerprint, null)
    return { artifact: summarizeArtifact(transitioned.artifact), gate: { status: 'blocked', reasonCodes: ['owner_revoked'], explanation: ['Owner revocation is recorded even when dataset lineage is no longer eligible.'] }, ledger: transitioned.decision }
  })
  return repo.transaction(async transaction => {
    const artifact = await transaction.getArtifact(ownerUserId, artifactId)
    if (!artifact) throw new Error('Model artifact not found.')
    if (artifact.modelVersion === GEO_OUTCOME_TRAIN_PRIOR_VERSION) throw new Error('Train-only prior artifacts require the explicit owner bootstrap review path.')
    const dataset = (await transaction.listDatasets(ownerUserId)).find(item => item.manifestFingerprint === artifact.datasetManifestFingerprint)
    if (!dataset || !hasCurrentDatasetApproval(await transaction.listDatasetDecisions(ownerUserId), dataset, ownerUserId)) throw new Error('Lineage dataset lacks current durable approval.')
    const members = await transaction.getDatasetMembers(ownerUserId, dataset.manifestId)
    if (members.some(member => !canBePrimaryCitationTruth(member.observation))) throw new Error('Lineage dataset governance has been revoked or is incomplete.')
    const rollbackArtifact = decision === 'approve_for_shadow' ? await resolveApprovedFallbackForArtifact(ownerUserId, artifact, transaction) : null
    const observationSpanDays = dataset.observationStart && dataset.observationEnd ? Math.floor((new Date(dataset.observationEnd).getTime() - new Date(dataset.observationStart).getTime()) / 86_400_000) : null
    const gate = evaluatePromotionGate({ dataset, members, artifact, ownerApproved: decision === 'approve_for_shadow', rollbackArtifact, target: 'shadow', shadowReadiness: getShadowReadiness({ candidates: dataset.sourceObservationFingerprints.length, queryGroups: dataset.queryGroupCount, websites: dataset.websiteCount, engines: Object.keys(dataset.engineCounts).length, positives: dataset.positiveCount, hardNegatives: dataset.hardNegativeCount, observationSpanDays, temporalHoldoutCount: dataset.temporalHoldoutRowCount, hasPrimaryEvidence: Boolean(dataset.sourceBasisCounts.manual_verified_primary || dataset.sourceBasisCounts.consumer_surface_observed) }) })
    if (decision === 'approve_for_shadow' && gate.status !== 'pass') throw new Error(`gate_blocked: ${gate.reasonCodes.join(',')} ${gate.explanation.join(' | ')}`)
    const nextStatus = decision === 'approve_for_shadow' ? 'approved_for_shadow' : 'revoked'
    const transitioned = await transaction.transitionArtifactWithDecision(ownerUserId, artifactId, nextStatus, reviewerUserId, reason, dataset.manifestFingerprint, rollbackArtifact?.artifactHash || null)
    return { artifact: summarizeArtifact(transitioned.artifact), gate, ledger: transitioned.decision }
  })
}

export async function createBootstrapFallback(ownerUserId: number, manifestId: string, modelFamily: unknown, repository?: GeoOutcomeRepositoryPort): Promise<ModelArtifactSummary> {
  if (!Number.isSafeInteger(ownerUserId) || ownerUserId <= 0) throw new Error('ownerUserId must be server-derived.')
  const family = parseModelFamily(modelFamily)
  const repo = repoOrProduction(repository)
  return repo.transaction(async transaction => {
    const dataset = await transaction.getDataset(ownerUserId, manifestId)
    if (!dataset || !hasCurrentDatasetApproval(await transaction.listDatasetDecisions(ownerUserId), dataset, ownerUserId)) throw new Error('Bootstrap fallback requires a currently durably approved dataset.')
    const members = await transaction.getDatasetMembers(ownerUserId, manifestId)
    if (members.some(member => !canBePrimaryCitationTruth(member.observation))) throw new Error('Bootstrap fallback dataset governance is revoked or incomplete.')
    const artifact = buildTrainOnlyPriorArtifact(ownerUserId, dataset, members, family)
    const existing = (await transaction.listArtifacts(ownerUserId)).find(item => item.artifactHash === artifact.artifactHash)
    return summarizeArtifact(existing || await transaction.saveArtifactTransactional(ownerUserId, artifact))
  })
}

export async function approveBootstrapFallback(ownerUserId: number, artifactId: string, reviewerUserId: number, reason: string, repository?: GeoOutcomeRepositoryPort): Promise<{ artifact: ModelArtifactSummary, gate: ReturnType<typeof evaluatePromotionGate>, ledger: ModelDecision }> {
  if (!Number.isSafeInteger(ownerUserId) || reviewerUserId !== ownerUserId) throw new Error('reviewerUserId must be the server-derived owner.')
  if (typeof reason !== 'string' || reason.trim().length < 8 || reason.length > 500) throw new Error('Owner bootstrap review reason must be 8-500 characters.')
  const repo = repoOrProduction(repository)
  return repo.transaction(async transaction => {
    const artifact = await transaction.getArtifact(ownerUserId, artifactId)
    if (!artifact || artifact.modelVersion !== GEO_OUTCOME_TRAIN_PRIOR_VERSION) throw new Error('A fixed train-only prior artifact is required.')
    const priorDecision = latestModelApproval(await transaction.listDecisions(ownerUserId), artifact)
    if (artifact.status === 'approved_for_shadow' && priorDecision?.newStatus === 'approved_for_shadow' && priorDecision.reviewerUserId === ownerUserId && priorDecision.reason === reason.trim()) {
      const approvedDataset = (await transaction.listDatasets(ownerUserId)).find(item => item.manifestFingerprint === artifact.datasetManifestFingerprint)
      if (!approvedDataset || !hasCurrentDatasetApproval(await transaction.listDatasetDecisions(ownerUserId), approvedDataset, ownerUserId)) throw new Error('Bootstrap fallback approval replay is no longer authoritative.')
      const approvedMembers = await transaction.getDatasetMembers(ownerUserId, approvedDataset.manifestId)
      if (approvedMembers.some(member => !canBePrimaryCitationTruth(member.observation)) || !isExactTrainOnlyPriorArtifact(artifact, approvedDataset, approvedMembers)) throw new Error('Bootstrap fallback approval replay lineage changed.')
      const replaySpan = approvedDataset.observationStart && approvedDataset.observationEnd ? Math.floor((new Date(approvedDataset.observationEnd).getTime() - new Date(approvedDataset.observationStart).getTime()) / 86_400_000) : null
      const replayGate = evaluatePromotionGate({ dataset: approvedDataset, members: approvedMembers, artifact, ownerApproved: true, rollbackArtifact: null, target: 'shadow', shadowReadiness: getShadowReadiness({ candidates: approvedDataset.sourceObservationFingerprints.length, queryGroups: approvedDataset.queryGroupCount, websites: approvedDataset.websiteCount, engines: Object.keys(approvedDataset.engineCounts).length, positives: approvedDataset.positiveCount, hardNegatives: approvedDataset.hardNegativeCount, observationSpanDays: replaySpan, temporalHoldoutCount: approvedDataset.temporalHoldoutRowCount, hasPrimaryEvidence: Boolean(approvedDataset.sourceBasisCounts.manual_verified_primary || approvedDataset.sourceBasisCounts.consumer_surface_observed) }) })
      if (replayGate.status !== 'pass') throw new Error('Bootstrap fallback approval replay no longer passes the release gate.')
      return { artifact: summarizeArtifact(artifact), gate: replayGate, ledger: priorDecision }
    }
    if (artifact.status !== 'ready_for_owner_review') throw new Error('Bootstrap fallback is not awaiting its first owner review.')
    const dataset = (await transaction.listDatasets(ownerUserId)).find(item => item.manifestFingerprint === artifact.datasetManifestFingerprint)
    if (!dataset || !hasCurrentDatasetApproval(await transaction.listDatasetDecisions(ownerUserId), dataset, ownerUserId)) throw new Error('Bootstrap fallback dataset lacks current durable approval.')
    const members = await transaction.getDatasetMembers(ownerUserId, dataset.manifestId)
    if (members.some(member => !canBePrimaryCitationTruth(member.observation)) || !isExactTrainOnlyPriorArtifact(artifact, dataset, members)) throw new Error('Bootstrap fallback artifact or dataset governance lineage changed.')
    const observationSpanDays = dataset.observationStart && dataset.observationEnd ? Math.floor((new Date(dataset.observationEnd).getTime() - new Date(dataset.observationStart).getTime()) / 86_400_000) : null
    const gate = evaluatePromotionGate({ dataset, members, artifact, ownerApproved: true, rollbackArtifact: null, target: 'shadow', shadowReadiness: getShadowReadiness({ candidates: dataset.sourceObservationFingerprints.length, queryGroups: dataset.queryGroupCount, websites: dataset.websiteCount, engines: Object.keys(dataset.engineCounts).length, positives: dataset.positiveCount, hardNegatives: dataset.hardNegativeCount, observationSpanDays, temporalHoldoutCount: dataset.temporalHoldoutRowCount, hasPrimaryEvidence: Boolean(dataset.sourceBasisCounts.manual_verified_primary || dataset.sourceBasisCounts.consumer_surface_observed) }) })
    if (gate.status !== 'pass') throw new Error(`gate_blocked: ${gate.reasonCodes.join(',')} ${gate.explanation.join(' | ')}`)
    const transitioned = await transaction.transitionArtifactWithDecision(ownerUserId, artifactId, 'approved_for_shadow', reviewerUserId, reason.trim(), dataset.manifestFingerprint, null)
    return { artifact: summarizeArtifact(transitioned.artifact), gate, ledger: transitioned.decision }
  })
}

export async function predict(ownerUserId: number, artifactId: string, observationInput: unknown, repository?: GeoOutcomeRepositoryPort, options: { allowTrustedFixture?: boolean } = {}): Promise<ExperimentalPrediction> {
  const repo = repoOrProduction(repository)
  const artifact = await repo.getArtifact(ownerUserId, artifactId)
  if (!artifact) throw new Error('Model artifact not found.')
  if (artifact.modelVersion === GEO_OUTCOME_TRAIN_PRIOR_VERSION) throw new Error('Train-only prior artifacts are fallback-only and cannot make predictions.')
  if (artifact.status !== 'approved_for_shadow' || !metricsAreComplete(artifact)) throw new Error('Model is not approved for shadow prediction with complete holdout metrics.')
  const decisions = await repo.listDecisions(ownerUserId)
  if (!hasCurrentModelApproval(decisions, artifact, ownerUserId)) throw new Error('Model lacks a current durable approval decision.')
  const dataset = (await repo.listDatasets(ownerUserId)).find(item => item.manifestFingerprint === artifact.datasetManifestFingerprint)
  if (!dataset || !hasCurrentDatasetApproval(await repo.listDatasetDecisions(ownerUserId), dataset, ownerUserId)) throw new Error('Prediction dataset approval is no longer current.')
  const members = await repo.getDatasetMembers(ownerUserId, dataset.manifestId)
  if (members.some(member => !canBePrimaryCitationTruth(member.observation)) || splitFingerprint(splitFor(dataset)) !== artifact.splitManifestFingerprint || members.length !== dataset.sourceObservationFingerprints.length) throw new Error('Prediction dataset governance or split snapshot is no longer current.')
  const predictionSnapshotFingerprint = trainingInputFingerprint(dataset, members)
  if (!await resolveApprovedFallbackForArtifact(ownerUserId, artifact, repo)) throw new Error('Candidate fallback authority is no longer current.')
  const observation = normalizeManualObservation(observationInput, ownerUserId, options.allowTrustedFixture ? { mode: 'trusted_test', consentStatus: 'approved', piiStatus: 'clean', verificationAuthority: 'consumer_surface_server', reviewFingerprint: fingerprint({ ownerUserId, predictionInput: observationInput }) } : { mode: 'intake' })
  const featureVector = deriveFeatureVector(observation)
  const values = featureVector.values.map(value => value.value)
  const parameters = { coefficients: artifact.coefficients, intercept: artifact.intercept, normalizationStatistics: artifact.normalizationStatistics }
  const score = scoreWithParameters(parameters, values)
  const observations = await repo.listObservations(ownerUserId)
  const sameSet = observations.filter(item => item.runIdentity === observation.runIdentity && item.normalizedQueryHash === observation.normalizedQueryHash && item.engine === observation.engine && item.model === observation.model && item.modelVersion === observation.modelVersion && item.interface === observation.interface && item.locale === observation.locale && item.region === observation.region && item.observationWindow.start === observation.observationWindow.start && item.observationWindow.end === observation.observationWindow.end)
  const candidates = [...sameSet.filter(item => item.candidatePageIdentityHash !== observation.candidatePageIdentityHash), observation].map(item => ({ candidatePageIdentityHash: item.candidatePageIdentityHash, score: scoreWithParameters(parameters, deriveFeatureVector(item).values.map(value => value.value)) })).sort((a, b) => b.score - a.score || (a.candidatePageIdentityHash < b.candidatePageIdentityHash ? -1 : a.candidatePageIdentityHash > b.candidatePageIdentityHash ? 1 : 0))
  const rankingPosition = candidates.findIndex(item => item.candidatePageIdentityHash === observation.candidatePageIdentityHash) + 1
  const latestArtifact = await repo.getArtifact(ownerUserId, artifactId)
  const latestDataset = latestArtifact ? (await repo.listDatasets(ownerUserId)).find(item => item.manifestFingerprint === latestArtifact.datasetManifestFingerprint) : null
  const latestMembers = latestDataset ? await repo.getDatasetMembers(ownerUserId, latestDataset.manifestId) : []
  if (!latestArtifact || latestArtifact.artifactHash !== artifact.artifactHash || latestArtifact.status !== 'approved_for_shadow' || !hasCurrentModelApproval(await repo.listDecisions(ownerUserId), latestArtifact, ownerUserId) || !latestDataset || !hasCurrentDatasetApproval(await repo.listDatasetDecisions(ownerUserId), latestDataset, ownerUserId) || latestMembers.some(member => !canBePrimaryCitationTruth(member.observation)) || splitFingerprint(splitFor(latestDataset)) !== latestArtifact.splitManifestFingerprint || trainingInputFingerprint(latestDataset, latestMembers) !== predictionSnapshotFingerprint || !await resolveApprovedFallbackForArtifact(ownerUserId, latestArtifact, repo)) throw new Error('Prediction authority changed before the response was finalized.')
  return { predictionIsVerifiedOutcome: false, modelArtifactHash: artifact.artifactHash, datasetManifestHash: artifact.datasetManifestFingerprint, taskType: artifact.taskType, experimentalScore: score, rankingPosition: rankingPosition > 0 ? rankingPosition : null, featureContributions: standardizedFeatureContributions({ coefficients: artifact.coefficients, normalizationStatistics: artifact.normalizationStatistics }, values, featureVector.values.map(value => value.key)), missingFeatureList: featureVector.values.filter(value => value.missing).map(value => value.key), limitations: ['This is an experimental model score, not an observed citation result.', 'No citation, ranking, traffic, conversion, ROI, or production claim may be inferred.', 'Prediction lineage is limited to the artifact and dataset hashes returned above.'] }
}

export async function getWorkspace(ownerUserId: number, repository?: GeoOutcomeRepositoryPort): Promise<WorkspaceSummary> {
  const repo = repoOrProduction(repository); const observations = await repo.listObservations(ownerUserId); const datasets = await repo.listDatasets(ownerUserId); const datasetDecisions = await repo.listDatasetDecisions(ownerUserId); const trainingRuns = await repo.listTrainingRuns(ownerUserId); const artifacts = await repo.listArtifacts(ownerUserId); const decisions = await repo.listDecisions(ownerUserId)
  const eligibleDevelopmentDatasets = datasets.filter(dataset => dataset.status === 'ready_for_review' || hasDurableDatasetApproval(datasetDecisions, dataset))
  const approvedShadowDatasets = datasets.filter(dataset => hasDurableDatasetApproval(datasetDecisions, dataset))
  const developmentMembers = uniqueMembers((await Promise.all(eligibleDevelopmentDatasets.map(dataset => repo.getDatasetMembers(ownerUserId, dataset.manifestId)))).flat())
  const shadowMembers = uniqueMembers((await Promise.all(approvedShadowDatasets.map(dataset => repo.getDatasetMembers(ownerUserId, dataset.manifestId)))).flat())
  const positives = observations.filter(item => item.citationStatus === 'cited' && item.verificationStatus === 'verified' && item.interface === 'consumer_surface' && item.consentStatus === 'approved' && item.piiStatus === 'clean'); const timestamps = observations.map(item => new Date(item.runTimestamp).getTime()).filter(Number.isFinite); const spanDays = timestamps.length > 1 ? Math.floor((Math.max(...timestamps) - Math.min(...timestamps)) / 86_400_000) : timestamps.length ? 0 : null
  const readinessFor = (members: DatasetMember[]) => ({ candidates: members.length, queryGroups: new Set(members.map(item => item.queryGroupKey)).size, websites: new Set(members.map(item => item.websiteIdentityHash)).size, engines: new Set(members.map(item => `${item.observation.engine}:${item.observation.interface}`)).size, positives: members.filter(item => item.label === 1).length, hardNegatives: members.filter(item => item.hardNegative).length, observationSpanDays: spanDays })
  const development = getDatasetReadiness(readinessFor(developmentMembers)); const shadow = getShadowReadiness({ ...readinessFor(shadowMembers), temporalHoldoutCount: shadowMembers.filter(item => item.splitAssignment === 'temporalHoldout').length, hasPrimaryEvidence: shadowMembers.some(item => canBePrimaryCitationTruth(item.observation)) }); return { ownerUserId, inventory: { structuralAuxiliaryCount: 0, outcomeObservationsCount: observations.length, verifiedPrimaryCount: observations.filter(item => item.verificationStatus === 'verified' && item.verificationAuthority !== 'intake').length, providerSecondaryCount: observations.filter(item => item.labelBasis === 'provider_api_secondary_only').length, positiveCount: developmentMembers.filter(item => item.label === 1).length, hardNegativeCount: developmentMembers.filter(item => item.hardNegative).length, websiteCount: new Set(observations.map(item => item.websiteIdentityHash)).size, queryCount: new Set(observations.map(item => item.normalizedQueryHash)).size, engineCount: new Set(observations.map(item => `${item.engine}:${item.interface}`)).size, observationSpanDays: spanDays, externalDatasetStatus: 'unverified_external_dataset', externalDatasetCount: null, structuralAuxiliaryReady: false, citationOutcomeReady: development.ready }, readiness: { development, shadow }, datasets, trainingRuns, models: artifacts.map(summarizeArtifact), datasetDecisions, decisions }
}

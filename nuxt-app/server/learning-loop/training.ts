import { z } from 'zod'
import { approveBootstrapFallback, createBootstrapFallback, createTrainingRun, executeTrainingRun, getProductionGeoOutcomeRepository } from '../geo-outcome-model/service'
import { summarizeArtifact } from '../geo-outcome-model/artifact'
import { canBePrimaryCitationTruth } from '../geo-outcome-model/observation-contract'
import { fingerprint } from '../geo-outcome-model/canonical'
import { verifyArtifactHash } from '../geo-outcome-model/release-gate'
import type { GeoOutcomeRepositoryPort } from '../geo-outcome-model/types'
import { learningError } from './authority'

const inputSchema = z.object({ datasetManifestId: z.string().regex(/^geo-dataset-[a-f0-9]{20,64}$/), modelFamily: z.enum(['regularized_logistic_baseline_v1', 'pairwise_logistic_ranker_v1']) }).strict()
const fallbackReviewSchema = z.object({ artifactId: z.string().regex(/^geo-model-[a-f0-9]{20}$/), reason: z.string().trim().min(10).max(500) }).strict()

/** Separate fallback creation and owner review; no client-authored weights or role switches. */
export async function createLearningCitationFallback(ownerUserId: number, input: unknown, repository?: GeoOutcomeRepositoryPort) {
  const parsed = inputSchema.safeParse(input)
  if (!parsed.success) learningError('INVALID_FALLBACK_INPUT', '請選擇已核准的資料集與相容模型種類。', 422)
  return { artifact: await createBootstrapFallback(ownerUserId, parsed.data.datasetManifestId, parsed.data.modelFamily, repository), productionActivation: false as const }
}

export async function reviewLearningCitationFallback(ownerUserId: number, input: unknown, repository?: GeoOutcomeRepositoryPort) {
  const parsed = fallbackReviewSchema.safeParse(input)
  if (!parsed.success) learningError('INVALID_FALLBACK_REVIEW', '請核對回退基準並記錄核准理由。', 422)
  return { ...await approveBootstrapFallback(ownerUserId, parsed.data.artifactId, ownerUserId, parsed.data.reason, repository), productionActivation: false as const }
}

/** A convenient stage, not a second training engine or an automatic approval path. */
export async function trainApprovedLearningDataset(ownerUserId: number, input: unknown, repository?: GeoOutcomeRepositoryPort) {
  const parsed = inputSchema.safeParse(input)
  if (!parsed.success) learningError('INVALID_TRAINING_INPUT', '請選擇有效的資料集與模型。', 422)
  const repo = repository || getProductionGeoOutcomeRepository(), { datasetManifestId, modelFamily } = parsed.data
  const dataset = await repo.getDataset(ownerUserId, datasetManifestId)
  const decision = (await repo.listDatasetDecisions(ownerUserId)).filter(row => row.manifestId === datasetManifestId && row.manifestFingerprint === dataset?.manifestFingerprint).at(-1)
  if (!dataset || dataset.status !== 'approved' || decision?.newStatus !== 'approved' || !dataset.readiness.ready) learningError('OWNER_APPROVED_READY_DATASET_REQUIRED')
  const members = await repo.getDatasetMembers(ownerUserId, datasetManifestId)
  if (!members.length || members.some(member => !canBePrimaryCitationTruth(member.observation))) learningError('CURRENT_DATASET_GOVERNANCE_REQUIRED')
  const reserved = await createTrainingRun(ownerUserId, { datasetManifestId, modelFamily }, repo)
  const run = await executeTrainingRun(ownerUserId, reserved.trainingRunId, repo)
  // Historical completed runs are not proof that a model is still usable after a revocation.
  const currentDataset = await repo.getDataset(ownerUserId, datasetManifestId), currentMembers = await repo.getDatasetMembers(ownerUserId, datasetManifestId)
  const latest = (await repo.listDatasetDecisions(ownerUserId)).filter(row => row.manifestId === datasetManifestId && row.manifestFingerprint === dataset.manifestFingerprint).at(-1)
  const current = currentDataset?.status === 'approved' && currentDataset.manifestFingerprint === dataset.manifestFingerprint && latest?.newStatus === 'approved' && fingerprint(currentMembers) === fingerprint(members) && currentMembers.every(member => canBePrimaryCitationTruth(member.observation))
  const artifact = current && run.artifactId ? await repo.getArtifact(ownerUserId, run.artifactId) : null
  const validArtifact = artifact && artifact.datasetManifestFingerprint === dataset.manifestFingerprint && artifact.artifactHash === run.artifactHash && verifyArtifactHash(artifact) ? artifact : null
  return { status: run.status, trainingRun: { trainingRunId: run.trainingRunId, datasetManifestId, modelFamily: run.modelFamily, status: run.status, artifactHash: run.artifactHash, metrics: run.metrics, reason: run.reason }, artifact: validArtifact ? summarizeArtifact(validArtifact) : null, currentLineageValid: Boolean(current && validArtifact), productionActivation: false as const, limitations: ['train_partition_fit_only', 'site_query_temporal_holdout_evaluated', 'owner_shadow_review_required', 'not_verified_customer_outcome'] }
}

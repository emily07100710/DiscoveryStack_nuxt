import { canonicalJson, fingerprint, sha256Hex } from './canonical'
import { GEO_OUTCOME_ARTIFACT_SCHEMA_VERSION, GEO_OUTCOME_FEATURE_CATALOG_VERSION, GEO_OUTCOME_LABEL_CONTRACT_VERSION } from './constants'
import { assertDisjointComplete } from './split-policy'
import { isExactTrainOnlyPriorArtifact } from './bootstrap-baseline'
import type { DatasetManifest, DatasetMember, DatasetReadiness, ModelArtifact } from './types'
import { approvalReference } from './knowledge-authority'

export interface PromotionGateInput { dataset: DatasetManifest; members: DatasetMember[]; artifact: ModelArtifact; ownerApproved: boolean; rollbackArtifact: ModelArtifact | null; target: 'shadow' | 'production'; shadowReadiness?: DatasetReadiness }
export interface PromotionGateResult { status: 'pass' | 'blocked'; reasonCodes: string[]; explanation: string[] }

export function verifyArtifactHash(artifact: ModelArtifact): boolean {
  let reference
  try { reference = artifact.datasetDecisionId !== undefined || artifact.knowledgeAuthorityFingerprint !== undefined ? approvalReference(artifact) : null } catch { return false }
  const payload = { artifactSchemaVersion: artifact.artifactSchemaVersion, taskType: artifact.taskType, modelFamily: artifact.modelFamily, modelVersion: artifact.modelVersion, featureCatalogVersion: artifact.featureCatalogVersion, labelContractVersion: artifact.labelContractVersion, datasetManifestFingerprint: artifact.datasetManifestFingerprint, splitManifestFingerprint: artifact.splitManifestFingerprint, coefficients: artifact.coefficients, intercept: artifact.intercept, normalizationStatistics: artifact.normalizationStatistics, trainingConfiguration: artifact.trainingConfiguration, trainingRowCount: artifact.trainingRowCount, evaluationMetrics: artifact.evaluationMetrics, limitations: artifact.limitations, rollbackArtifactHash: artifact.rollbackArtifactHash, ...(reference || {}) }
  return fingerprint(payload) === artifact.artifactFingerprint && artifact.artifactId === `geo-model-${artifact.artifactFingerprint.slice(0, 20)}` && sha256Hex(canonicalJson({ ...payload, artifactFingerprint: artifact.artifactFingerprint })) === artifact.artifactHash
}
function isValidRollback(current: ModelArtifact, rollback: ModelArtifact | null): boolean {
  if (!rollback) return false
  try { approvalReference(rollback) } catch { return false }
  return current.rollbackArtifactHash === rollback.artifactHash && rollback.ownerUserId === current.ownerUserId && rollback.artifactHash !== current.artifactHash && rollback.status === 'approved_for_shadow' && rollback.revokedAt === null && rollback.taskType === current.taskType && rollback.modelFamily === current.modelFamily && rollback.featureCatalogVersion === current.featureCatalogVersion && rollback.labelContractVersion === current.labelContractVersion && verifyArtifactHash(rollback)
}

export function evaluatePromotionGate(input: PromotionGateInput): PromotionGateResult {
  const reasonCodes: string[] = []; const explanation: string[] = []
  try { approvalReference(input.artifact) } catch { reasonCodes.push('dataset_knowledge_approval_reference_required'); explanation.push('Artifact 必須綁定明確的 owner 知識依賴核准；舊產物只能保留歷史紀錄。') }
  if (input.dataset.status !== 'approved') { reasonCodes.push('dataset_not_approved'); explanation.push('Dataset manifest 尚未經 owner review 核准。') }
  if (input.target === 'shadow' && input.shadowReadiness && !input.shadowReadiness.ready) { reasonCodes.push('shadow_readiness_insufficient'); explanation.push(...input.shadowReadiness.missing) }
  if (input.artifact.artifactSchemaVersion !== GEO_OUTCOME_ARTIFACT_SCHEMA_VERSION || input.artifact.featureCatalogVersion !== GEO_OUTCOME_FEATURE_CATALOG_VERSION || input.artifact.labelContractVersion !== GEO_OUTCOME_LABEL_CONTRACT_VERSION) { reasonCodes.push('feature_contract_mismatch'); explanation.push('Artifact 與目前 feature/label contract 版本不一致。') }
  if (!verifyArtifactHash(input.artifact)) { reasonCodes.push('artifact_hash_mismatch'); explanation.push('Artifact hash 無法由 immutable payload 重算一致。') }
  if (input.artifact.evaluationMetrics.test.status === 'insufficient_data' || input.artifact.evaluationMetrics.temporalHoldout.status === 'insufficient_data') { reasonCodes.push('incomplete_holdout_metrics'); explanation.push('test 或 temporal holdout metrics 尚未具備足夠資料。') }
  if (input.artifact.trainingRowCount !== input.dataset.trainRowCount) { reasonCodes.push('training_rows_do_not_match_train_split'); explanation.push('Artifact trainingRowCount 必須精確等於 manifest train row count。') }
  try { assertDisjointComplete({ train: input.dataset.trainFingerprints, validation: input.dataset.validationFingerprints, test: input.dataset.testFingerprints, siteHoldout: input.dataset.siteHoldoutFingerprints, queryHoldout: input.dataset.queryHoldoutFingerprints, temporalHoldout: input.dataset.temporalHoldoutFingerprints }, input.members) } catch (error) { reasonCodes.push('cross_split_leakage'); explanation.push(error instanceof Error ? error.message : 'Cross-split leakage check failed.') }
  const governanceBlocked = input.members.some(member => member.consentStatus !== 'approved' || member.piiStatus !== 'clean' || !member.reviewFingerprint || member.observation.verificationStatus !== 'verified')
  if (governanceBlocked) { reasonCodes.push('governance_provenance_incomplete'); explanation.push('Every dataset member must have approved consent, clean PII, verified status and review fingerprint.') }
  const verifiedBootstrapFallback = input.artifact.rollbackArtifactHash === null && input.artifact.modelVersion === 'geo-outcome-train-prior-v1' && isExactTrainOnlyPriorArtifact(input.artifact, input.dataset, input.members)
  if (!verifiedBootstrapFallback && !isValidRollback(input.artifact, input.rollbackArtifact)) { reasonCodes.push('rollback_artifact_missing_or_invalid'); explanation.push('Rollback artifact must be same owner, different, approved_for_shadow, contract-compatible, non-revoked and hash-valid; the only bootstrap exception is the exact fixed train-only prior artifact.') }
  if (!input.ownerApproved) { reasonCodes.push('owner_explicit_review_required'); explanation.push('需要 owner explicit review，測試通過不等於核准。') }
  if (input.target === 'production') { reasonCodes.push('production_promotion_disabled_v1'); explanation.push('V1 不允許 production_active；shadow validation 完成前不可進 production。') }
  return { status: reasonCodes.length ? 'blocked' : 'pass', reasonCodes, explanation }
}

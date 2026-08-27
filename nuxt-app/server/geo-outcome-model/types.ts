import type { CitationStatus, DatasetStatus, Engine, InterfaceName, LabelBasis, ModelFamily, ModelStatus, ObservableStatus, RetrievalStatus, TaskType, VerificationStatus } from './constants'

export type Nullable<T> = T | null

export interface ObservationWindow {
  start: string
  end: string
}

export interface ContentFeatureInput {
  contentType: 'article' | 'faq' | 'product' | 'landing_page' | 'documentation' | 'other'
  locale: string
  pageAgeBucket: 'unknown' | '0_7d' | '8_30d' | '31_90d' | '91_365d' | '365d_plus'
  contentLengthBucket: 'unknown' | 'xs' | 's' | 'm' | 'l' | 'xl'
  headingHierarchy: 'unknown' | 'none' | 'flat' | 'structured'
  directAnswerPresence: 'unknown' | 'absent' | 'present'
  faqStructure: 'unknown' | 'absent' | 'present'
  structuredDataPresence: 'unknown' | 'absent' | 'present'
  citationMarkerCount: number | null
  approvedAuthoritySourceCount: number | null
  evidenceUtilizationRatio: number | null
  entityCoverage: number | null
  selectedAutoGeoRuleHashes: string[]
  appliedAutoGeoRuleHashes: string[]
  canonicalFlag: 'unknown' | 'valid' | 'invalid'
  indexabilityFlag: 'unknown' | 'indexable' | 'not_indexable'
  internalLinkDepthBucket: 'unknown' | '0' | '1' | '2' | '3_plus'
  contentFreshnessBucket: 'unknown' | 'stale' | 'recent' | 'fresh'
  queryPageLexicalOverlap: number | null
  topicClusterEqual: 'unknown' | 'no' | 'yes'
  verifiedPublicationAgeDays: number | null
  priorObservationCount: number | null
}

export type SplitName = 'train' | 'validation' | 'test' | 'siteHoldout' | 'queryHoldout' | 'temporalHoldout'
export type ConsentStatus = 'approved' | 'revoked' | 'unknown'
export type PiiStatus = 'clean' | 'contains_pii' | 'unknown'

export interface OutcomeObservation {
  schemaVersion: string
  ownerUserId: number
  projectId: number | null
  clientId: string | null
  websiteIdentityHash: string
  queryIdentityHash: string
  normalizedQueryHash: string
  candidatePageIdentityHash: string
  canonicalPageHash: string
  contentHash: string
  evidenceSnapshotHash: string
  publicationReceiptFingerprint: string | null
  engine: Engine
  model: string
  modelVersion: string | null
  interface: InterfaceName
  locale: string
  region: string | null
  runIdentity: string
  runTimestamp: string
  observationWindow: ObservationWindow
  observableStatus: ObservableStatus
  retrievalStatus: RetrievalStatus
  citationStatus: CitationStatus
  citationPosition: number | null
  mentionStatus: 'mentioned' | 'not_mentioned' | 'unknown'
  recommendationStatus: 'recommended' | 'not_recommended' | 'unknown'
  labelBasis: LabelBasis
  verificationStatus: VerificationStatus
  consentStatus: ConsentStatus
  piiStatus: PiiStatus
  verificationAuthority: 'intake' | 'owner_review' | 'consumer_surface_server' | 'none'
  intakeFingerprint: string
  reviewFingerprint: string | null
  candidateAuthorityFingerprint: string | null
  candidateSetFingerprint: string | null
  evidenceLocatorHashes: string[]
  appliedRuleHashes: string[]
  contentFeatureVector: ContentFeatureInput
  observationFingerprint: string
}

export interface FeatureValue {
  key: string
  value: number
  missing: boolean
}

export interface FeatureDefinition {
  key: string
  description: string
  kind: 'numeric' | 'categorical'
  bounded: string
}

export interface FeatureVector {
  catalogVersion: string
  values: FeatureValue[]
}

export interface DatasetMember {
  observationFingerprint: string
  websiteIdentityHash: string
  normalizedQueryHash: string
  runIdentity: string
  queryGroupKey: string
  label: 0 | 1
  hardNegative: boolean
  splitAssignment?: SplitName
  consentStatus?: ConsentStatus
  piiStatus?: PiiStatus
  reviewFingerprint?: string | null
  featureVector: FeatureVector
  observation: OutcomeObservation
}

export interface SplitAssignment {
  train: string[]
  validation: string[]
  test: string[]
  siteHoldout: string[]
  queryHoldout: string[]
  temporalHoldout: string[]
}

export interface DatasetReadiness {
  ready: boolean
  status: 'ready' | 'insufficient_data' | 'gate_blocked'
  missing: string[]
}

export interface DatasetManifest {
  manifestId: string
  schemaVersion: string
  taskType: TaskType
  featureCatalogVersion: string
  labelContractVersion: string
  hardNegativePolicyVersion: string
  sourceObservationFingerprints: string[]
  sourceBasisCounts: Record<string, number>
  engineCounts: Record<string, number>
  localeCounts: Record<string, number>
  websiteCount: number
  queryGroupCount: number
  positiveCount: number
  hardNegativeCount: number
  observationStart: string | null
  observationEnd: string | null
  splitPolicyVersion: string
  trainFingerprints: string[]
  validationFingerprints: string[]
  testFingerprints: string[]
  temporalHoldoutFingerprints: string[]
  siteHoldoutFingerprints: string[]
  queryHoldoutFingerprints: string[]
  trainRowCount: number
  validationRowCount: number
  testRowCount: number
  siteHoldoutRowCount: number
  queryHoldoutRowCount: number
  temporalHoldoutRowCount: number
  manifestFingerprint: string
  limitations: string[]
  readiness: DatasetReadiness
  status: DatasetStatus
  ownerUserId: number
  createdAt: string
}

export interface TrainingConfig {
  epochs: number
  learningRate: number
  l2: number
  seed: number
  featureCatalogVersion: string
}

export interface BinaryMetrics {
  status: 'ok' | 'insufficient_data'
  positiveCount: number
  negativeCount: number
  rocAuc: number | null
  prAuc: number | null
  logLoss: number | null
  brierScore: number | null
  expectedCalibrationError: number | null
  precision: number | null
  recall: number | null
  f1: number | null
  confusionMatrix: { truePositive: number, falsePositive: number, trueNegative: number, falseNegative: number }
  numerators: Record<string, number | null>
  denominators: Record<string, number | null>
}

export interface RankingMetrics {
  status: 'ok' | 'insufficient_data'
  queryGroupCount: number
  mrr: number | null
  ndcgAt5: number | null
  ndcgAt10: number | null
  precisionAt1: number | null
  precisionAt3: number | null
  recallAt5: number | null
  numerators: Record<string, number | null>
  denominators: Record<string, number | null>
}

export interface EvaluationBundle {
  validation: BinaryMetrics
  test: BinaryMetrics
  siteHoldout: BinaryMetrics
  queryHoldout: BinaryMetrics
  temporalHoldout: BinaryMetrics
  rankingValidation: RankingMetrics
  rankingTest: RankingMetrics
  rankingTemporalHoldout: RankingMetrics
  evaluationScope: 'structural_auxiliary' | 'citation_selection'
}

export interface ModelArtifact {
  artifactId: string
  artifactSchemaVersion: string
  taskType: TaskType
  modelFamily: ModelFamily
  modelVersion: string
  featureCatalogVersion: string
  labelContractVersion: string
  datasetManifestFingerprint: string
  splitManifestFingerprint: string
  coefficients: number[]
  intercept: number
  normalizationStatistics: { mean: number[], standardDeviation: number[] }
  trainingConfiguration: TrainingConfig
  trainingRowCount: number
  evaluationMetrics: EvaluationBundle
  limitations: string[]
  artifactFingerprint: string
  artifactHash: string
  rollbackArtifactHash: string | null
  ownerUserId: number
  status: ModelStatus
  revokedAt: string | null
}

export interface ModelDecision {
  decisionId: string
  ownerUserId: number
  modelArtifactId: string
  previousStatus: ModelStatus
  newStatus: ModelStatus
  reviewerUserId: number | null
  reason: string
  artifactHash: string
  datasetManifestHash: string
  createdAt: string
}

export interface DatasetDecision {
  decisionId: string
  ownerUserId: number
  manifestId: string
  previousStatus: DatasetStatus
  newStatus: DatasetStatus
  reviewerUserId: number
  reason: string
  manifestFingerprint: string
  createdAt: string
}

export interface ExperimentalPrediction {
  predictionIsVerifiedOutcome: false
  modelArtifactHash: string
  datasetManifestHash: string
  taskType: TaskType
  experimentalScore: number
  rankingPosition: number | null
  featureContributions: Array<{ key: string, contribution: number, missing: boolean }>
  missingFeatureList: string[]
  limitations: string[]
}

export interface WorkspaceSummary {
  ownerUserId: number
  inventory: {
    structuralAuxiliaryCount: number
    outcomeObservationsCount: number
    verifiedPrimaryCount: number
    providerSecondaryCount: number
    positiveCount: number
    hardNegativeCount: number
    websiteCount: number
    queryCount: number
    engineCount: number
    observationSpanDays: number | null
    externalDatasetStatus: 'unverified_external_dataset'
    externalDatasetCount: number | null
    structuralAuxiliaryReady: boolean
    citationOutcomeReady: boolean
  }
  readiness: { development: DatasetReadiness, shadow: DatasetReadiness }
  datasets: DatasetManifest[]
  trainingRuns: TrainingRun[]
  models: ModelArtifactSummary[]
  datasetDecisions: DatasetDecision[]
  decisions: ModelDecision[]
}

export interface MutationClaim {
  ownerUserId: number
  routeIdentity: string
  idempotencyKey: string
  inputFingerprint: string
  state: 'claimed' | 'completed' | 'failed'
  responseProjection: unknown | null
  responseFingerprint: string | null
  version: number
}

export interface MutationClaimResult {
  outcome: 'claimed' | 'replay' | 'in_progress' | 'collision'
  claim: MutationClaim
}

export type ObservationGovernanceFactType = 'evidence_verification' | 'consent_review' | 'pii_review' | 'revocation'
export type ObservationGovernanceAction = 'verify_evidence' | 'approve_consent' | 'approve_pii' | 'revoke'

export interface ObservationVerificationDecision {
  decisionId: string
  ownerUserId: number
  observationFingerprint: string
  reviewerUserId: number
  previousVerificationStatus: VerificationStatus
  newVerificationStatus: VerificationStatus
  evidenceLocatorHash: string | null
  factType: ObservationGovernanceFactType
  factStatus: 'approved' | 'rejected' | 'revoked'
  reason: string
  decisionFingerprint: string
  consentStatus: ConsentStatus
  piiStatus: PiiStatus
  createdAt: string
}

export interface EvidenceBinding {
  ownerUserId: number
  observationFingerprint: string
  evidenceLocatorHash: string
  purpose: 'geo_outcome_verification'
  sourceKind: 'llm_visibility_observation'
  sourceRecordId: number
  sourceProjectId: number
  sourceQueryId: number
  sourceRunId: number
  sourceResponseHash: string
  sourceCitationSetFingerprint: string
  candidateAuthorityId: number
  candidateAuthorityFingerprint: string
  candidateSetFingerprint: string
  canonicalCandidateUrlHash: string
  serverDerivedCitationStatus: 'cited' | 'not_cited'
  serverDerivedCitationPosition: number | null
  evidenceBindingFingerprint: string
  sourceObservedAt: string
  createdAt: string
}

export interface TrainingRunClaimResult {
  outcome: 'claimed' | 'replay' | 'in_progress' | 'stale_recovered' | 'collision'
  run: TrainingRun
}

export interface TrainingRun {
  trainingRunId: string
  ownerUserId: number
  datasetManifestId: string
  modelFamily: ModelFamily
  status: 'queued' | 'running' | 'completed' | 'blocked' | 'failed'
  config: TrainingConfig
  artifactId: string | null
  artifactHash: string | null
  metrics: EvaluationBundle | null
  reason: string | null
  createdAt: string
  startedAt: string | null
  completedAt: string | null
  leaseOwner: string | null
  leaseExpiresAt: string | null
  version: number
}

export interface ModelArtifactSummary {
  artifactId: string
  modelFamily: ModelFamily
  taskType: TaskType
  modelVersion: string
  status: ModelStatus
  artifactHash: string
  datasetManifestHash: string
  trainingRowCount: number
  metrics: EvaluationBundle
  limitations: string[]
  rollbackArtifactHash: string | null
  revokedAt: string | null
}

export interface GeoOutcomeRepositoryPort {
  listObservations(ownerUserId: number): Promise<OutcomeObservation[]>
  getObservation(ownerUserId: number, observationFingerprint: string): Promise<OutcomeObservation | null>
  saveObservationTransactional(ownerUserId: number, observation: OutcomeObservation): Promise<OutcomeObservation>
  verifyObservationTransactional(ownerUserId: number, observationFingerprint: string, reviewerUserId: number, action: ObservationGovernanceAction, reason: string, evidenceLocatorHash?: string): Promise<{ observation: OutcomeObservation, verificationDecision: ObservationVerificationDecision }>
  bindAuthoritativeEvidenceTransactional(ownerUserId: number, observationFingerprint: string, sourceRecordId: number): Promise<EvidenceBinding>
  listDatasets(ownerUserId: number): Promise<DatasetManifest[]>
  getDataset(ownerUserId: number, manifestId: string): Promise<DatasetManifest | null>
  getDatasetMembers(ownerUserId: number, manifestId: string): Promise<DatasetMember[]>
  saveDatasetTransactional(ownerUserId: number, manifest: DatasetManifest, members: DatasetMember[]): Promise<DatasetManifest>
  transitionDatasetWithDecision(ownerUserId: number, manifestId: string, status: DatasetStatus, reviewerUserId: number, reason: string): Promise<{ manifest: DatasetManifest, decision: DatasetDecision }>
  listDatasetDecisions(ownerUserId: number): Promise<DatasetDecision[]>
  createTrainingRun(ownerUserId: number, run: TrainingRun): Promise<TrainingRun>
  getTrainingRun(ownerUserId: number, trainingRunId: string): Promise<TrainingRun | null>
  claimTrainingRun(ownerUserId: number, trainingRunId: string, leaseOwner: string, leaseExpiresAt: string): Promise<TrainingRunClaimResult>
  transitionTrainingRun(ownerUserId: number, trainingRunId: string, patch: Partial<TrainingRun>): Promise<TrainingRun>
  listTrainingRuns(ownerUserId: number): Promise<TrainingRun[]>
  saveArtifactTransactional(ownerUserId: number, artifact: ModelArtifact): Promise<ModelArtifact>
  getArtifact(ownerUserId: number, artifactId: string): Promise<ModelArtifact | null>
  listArtifacts(ownerUserId: number): Promise<ModelArtifact[]>
  markArtifactShadowFailed(ownerUserId: number, artifactId: string): Promise<ModelArtifact>
  transitionArtifactWithDecision(ownerUserId: number, artifactId: string, nextStatus: ModelStatus, reviewerUserId: number, reason: string, datasetManifestHash: string, rollbackArtifactHash?: string | null): Promise<{ artifact: ModelArtifact, decision: ModelDecision }>
  listDecisions(ownerUserId: number): Promise<ModelDecision[]>
  claimMutation(ownerUserId: number, routeIdentity: string, idempotencyKey: string, inputFingerprint: string): Promise<MutationClaimResult>
  completeMutation(ownerUserId: number, routeIdentity: string, idempotencyKey: string, inputFingerprint: string, responseProjection: unknown): Promise<MutationClaim>
  failMutation(ownerUserId: number, routeIdentity: string, idempotencyKey: string, inputFingerprint: string, responseProjection: unknown): Promise<MutationClaim>
  transaction<T>(work: (repository: GeoOutcomeRepositoryPort) => Promise<T>): Promise<T>
}

/** Explicitly injected in-memory adapter for tests only; production code uses the Drizzle adapter. */
export interface MemoryGeoOutcomeRepository extends GeoOutcomeRepositoryPort {
  exportState(): MemoryGeoOutcomeState
  seedAuthoritativeEvidence(source: AuthoritativeEvidenceSource): void
}

export interface AuthoritativeEvidenceSource {
  sourceRecordId: number
  ownerUserId: number
  projectId: number
  queryId: number
  runId: number
  projectStatus: 'active' | 'archived'
  queryActive: boolean
  observationMode: 'manual_verified' | 'provider_api_observation'
  runStatus: 'queued' | 'completed' | 'blocked' | 'failed'
  verifiedByOwner: boolean
  provider: string
  modelLabel: string
  locale: string
  requestFingerprint: string
  promptHash: string
  responseHash: string
  evidenceLocator: string
  observedAt: string
  sourceCitationSetFingerprint?: string
  canonicalCandidateUrlHash?: string
  canonicalPageHash?: string
  candidatePageIdentityHash?: string
  websiteIdentityHash?: string
  contentHash?: string
  publicationReceiptFingerprint?: string | null
  candidateAuthorityId?: number
  candidateAuthorityFingerprint?: string
  candidateSetFingerprint?: string
  serverDerivedCitationStatus?: 'cited' | 'not_cited'
  serverDerivedCitationPosition?: number | null
}

export interface MemoryGeoOutcomeState {
  observations: OutcomeObservation[]
  datasets: DatasetManifest[]
  datasetMembers: Record<string, DatasetMember[]>
  trainingRuns: TrainingRun[]
  artifacts: ModelArtifact[]
  datasetDecisions: DatasetDecision[]
  decisions: ModelDecision[]
  verificationDecisions: ObservationVerificationDecision[]
  evidenceBindings: EvidenceBinding[]
  authoritativeEvidenceSources: AuthoritativeEvidenceSource[]
  claims: MutationClaim[]
}

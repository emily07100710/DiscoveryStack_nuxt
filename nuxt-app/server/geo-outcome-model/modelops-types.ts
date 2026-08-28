import type { ModelFamily } from './constants'
import type { GeoOutcomeRepositoryPort, DatasetDecision, DatasetManifest, ModelArtifact, ModelArtifactSummary, ModelDecision, TrainingRun } from './types'

export type ModelOpsPolicyStatus = 'enabled' | 'paused' | 'revoked'
export type ModelOpsCadence = 'weekly' | 'biweekly' | 'monthly'
export type ModelOpsTrigger = 'scheduled' | 'owner_manual' | 'dry_run'
export type ModelOpsCycleStatus = 'planned' | 'running' | 'completed' | 'blocked' | 'insufficient_data' | 'failed' | 'retry_wait'
export type ModelOpsShadowStatus = 'completed' | 'insufficient_data' | 'blocked' | 'needs_owner_attention'

export interface ModelOpsPolicyConfig {
  cadence: ModelOpsCadence
  minimumNewVerifiedCandidates: number
  minimumNewQueryGroups: number
  minimumNewWebsites: number
  minimumObservationSpanDays: number
  allowedModelFamilies: ModelFamily[]
  maximumTrainingRunsPerCycle: number
  cooldownHours: number
  shadowEvaluationEnabled: boolean
  /** One-time owner policy may run dataset approval and shadow preparation; never activates production. */
  autonomousExecutionEnabled: boolean
  expiresAt: string | null
}

export interface ModelOpsPolicy extends ModelOpsPolicyConfig {
  policyId: string
  ownerUserId: number
  status: ModelOpsPolicyStatus
  authorizedByOwnerUserId: number | null
  authorizedAt: string | null
  configurationFingerprint: string
  createdAt: string
  updatedAt: string
  revokedAt: string | null
}

export interface ModelOpsCycle {
  cycleId: string
  ownerUserId: number
  policyId: string
  policyFingerprint: string
  trigger: ModelOpsTrigger
  status: ModelOpsCycleStatus
  readinessSnapshotFingerprint: string
  eligibleObservationFingerprints: string[]
  previousApprovedDatasetFingerprint: string | null
  generatedDatasetFingerprint: string | null
  trainingRunId: string | null
  modelArtifactId: string | null
  artifactHash: string | null
  shadowEvaluationFingerprint: string | null
  reasonCodes: string[]
  limitations: string[]
  errorClass: string | null
  startedAt: string | null
  completedAt: string | null
  attempt: number
  leaseOwner: string | null
  leaseExpiresAt: string | null
  idempotencyKey: string
  inputFingerprint: string
  createdAt: string
  updatedAt: string
}

export interface ModelOpsEvent {
  eventId: string
  ownerUserId: number
  cycleId: string
  eventType: string
  eventPayload: Record<string, unknown>
  eventFingerprint: string
  createdAt: string
}

export interface ModelOpsShadowEvaluation {
  evaluationId: string
  ownerUserId: number
  artifactId: string
  artifactHash: string
  evaluationWindowStart: string
  evaluationWindowEnd: string
  observationFingerprints: string[]
  candidateCount: number
  positiveCount: number
  negativeCount: number
  queryGroupCount: number
  websiteCount: number
  engineCounts: Record<string, number>
  binaryMetrics: Record<string, unknown>
  rankingMetrics: Record<string, unknown>
  calibrationDiagnostics: Record<string, unknown>
  driftDiagnostics: Record<string, unknown>
  status: ModelOpsShadowStatus
  reasonCodes: string[]
  evaluationFingerprint: string
  createdAt: string
}

export interface ModelOpsRollbackDecision {
  decisionId: string
  ownerUserId: number
  artifactId: string
  fromArtifactHash: string
  rollbackArtifactHash: string
  reviewerUserId: number
  reason: string
  decisionStatus: 'approved' | 'rejected'
  createdAt: string
}

export interface ModelOpsAdvisoryAssignment {
  assignmentId: string
  ownerUserId: number
  policyId: string
  policyFingerprint: string
  currentArtifactHash: string
  candidateArtifactHash: string
  shadowEvaluationFingerprint: string
  cycleId: string
  candidateArtifactId: string
  datasetFingerprint: string
  splitFingerprint: string
  metricsFingerprint: string
  reasonCodes: string[]
  productionActivation: false
  status: 'advisory' | 'rolled_back'
  activeScopeKey: string | null
  version: number
  rollbackFromAssignmentId: string | null
  assignmentFingerprint: string
  createdAt: string
  rolledBackAt: string | null
}

export interface ModelOpsCycleClaimResult {
  outcome: 'claimed' | 'replay' | 'in_progress' | 'stale_recovered' | 'collision'
  cycle: ModelOpsCycle
}

export interface ModelOpsWorkspace {
  ownerUserId: number
  policy: ModelOpsPolicy | null
  cycles: ModelOpsCycle[]
  events: ModelOpsEvent[]
  shadowEvaluations: ModelOpsShadowEvaluation[]
  rollbackDecisions: ModelOpsRollbackDecision[]
  advisoryAssignments: ModelOpsAdvisoryAssignment[]
  outcome: {
    readiness: { development: DatasetManifest['readiness'], shadow: DatasetManifest['readiness'] }
    datasets: DatasetManifest[]
    trainingRuns: TrainingRun[]
    models: ModelArtifactSummary[]
    datasetDecisions: DatasetDecision[]
    modelDecisions: ModelDecision[]
  }
}

export interface ModelOpsRepositoryPort {
  listPolicies(ownerUserId: number): Promise<ModelOpsPolicy[]>
  listEnabledOwnerUserIds(limit: number): Promise<number[]>
  getPolicy(ownerUserId: number, policyId: string): Promise<ModelOpsPolicy | null>
  savePolicy(ownerUserId: number, policy: ModelOpsPolicy): Promise<ModelOpsPolicy>
  updatePolicy(ownerUserId: number, policyId: string, patch: Partial<ModelOpsPolicy>): Promise<ModelOpsPolicy>
  listCycles(ownerUserId: number): Promise<ModelOpsCycle[]>
  getCycle(ownerUserId: number, cycleId: string): Promise<ModelOpsCycle | null>
  saveCycle(ownerUserId: number, cycle: ModelOpsCycle): Promise<ModelOpsCycle>
  claimCycle(ownerUserId: number, cycleId: string, leaseOwner: string, leaseExpiresAt: string): Promise<ModelOpsCycleClaimResult>
  updateCycle(ownerUserId: number, cycleId: string, patch: Partial<ModelOpsCycle>): Promise<ModelOpsCycle>
  appendEvent(ownerUserId: number, event: ModelOpsEvent): Promise<ModelOpsEvent>
  listEvents(ownerUserId: number, cycleId?: string): Promise<ModelOpsEvent[]>
  saveShadowEvaluation(ownerUserId: number, evaluation: ModelOpsShadowEvaluation): Promise<ModelOpsShadowEvaluation>
  listShadowEvaluations(ownerUserId: number, artifactId?: string): Promise<ModelOpsShadowEvaluation[]>
  appendRollbackDecision(ownerUserId: number, decision: ModelOpsRollbackDecision): Promise<ModelOpsRollbackDecision>
  listRollbackDecisions(ownerUserId: number): Promise<ModelOpsRollbackDecision[]>
  listAdvisoryAssignments(ownerUserId: number): Promise<ModelOpsAdvisoryAssignment[]>
  saveAdvisoryAssignment(ownerUserId: number, assignment: ModelOpsAdvisoryAssignment): Promise<ModelOpsAdvisoryAssignment>
  compareAndSwapAdvisoryAssignment(ownerUserId: number, assignmentId: string, expectedVersion: number, patch: Partial<ModelOpsAdvisoryAssignment>): Promise<ModelOpsAdvisoryAssignment | null>
  transaction<T>(work: (repository: ModelOpsRepositoryPort) => Promise<T>): Promise<T>
}

export interface MemoryModelOpsState {
  policies: ModelOpsPolicy[]
  cycles: ModelOpsCycle[]
  events: ModelOpsEvent[]
  shadowEvaluations: ModelOpsShadowEvaluation[]
  rollbackDecisions: ModelOpsRollbackDecision[]
  advisoryAssignments?: ModelOpsAdvisoryAssignment[]
}

export interface ModelOpsDependencies {
  outcomeRepository: GeoOutcomeRepositoryPort
  modelOpsRepository: ModelOpsRepositoryPort
}

export interface ModelOpsCycleResult {
  cycle: ModelOpsCycle
  dataset: DatasetManifest | null
  trainingRun: TrainingRun | null
  artifact: ModelArtifact | null
  shadowEvaluation: ModelOpsShadowEvaluation | null
}

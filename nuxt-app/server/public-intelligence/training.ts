import { and, desc, eq, isNull } from 'drizzle-orm'
import { auditTrainingExamples, auditWorkspaces, publicIntelligenceTrainingRuns } from '../database/schema'
import { requireAuditDatabase } from '../audit/repository'
import { getHuggingFaceJob, getHuggingFaceJobLogs, isHuggingFaceConfigured, parseTrainingResult, startHuggingFaceTraining } from './huggingface-jobs'
import { getOwnerProviderCredentials } from './provider-repository'

export const TRAINING_MODEL_VERSION = 'distilbert-multilingual-finetune-v1'
export const TRAINING_FEATURE_CONTRACT_VERSION = 'audit-training-v1'
export const TRAINING_LABEL_TAXONOMY_VERSION = 'journey-friction-v1'
export const TRAINING_SPLIT_VERSION = 'deterministic-id-v1'

const JOURNEY_STAGES = ['discovery', 'understanding', 'response', 'progression', 'conversion'] as const
type JourneyStage = typeof JOURNEY_STAGES[number]
type Split = 'train' | 'validation' | 'test'

type TrainingExample = {
  id: number
  labelStage: JourneyStage
  dataSplit: 'unassigned' | Split | 'holdout'
  featureVector: unknown
}

type PreparedExample = TrainingExample & { split: Split }

type TrainingRunRow = {
  id: number
  status: 'queued' | 'running' | 'completed' | 'blocked' | 'failed'
  remoteJobId: string | null
  remoteJobUrl: string | null
  modelRepoId: string | null
  [key: string]: unknown
}

function stableBucket(id: number) {
  let hash = 2166136261
  for (const character of `${TRAINING_SPLIT_VERSION}:${id}`) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619)
  return (hash >>> 0) / 4294967296
}

function assignSplit(example: TrainingExample, index: number, total: number): Split {
  if (example.dataSplit === 'train' || example.dataSplit === 'validation' || example.dataSplit === 'test') return example.dataSplit
  if (total < 5) return index === 0 ? 'train' : index === total - 1 ? 'test' : 'validation'
  const bucket = stableBucket(example.id)
  if (bucket < 0.7) return 'train'
  if (bucket < 0.85) return 'validation'
  return 'test'
}

function prepareExamples(rows: TrainingExample[]) {
  const ordered = [...rows].sort((left, right) => left.id - right.id)
  return ordered.map((example, index) => ({ ...example, split: assignSplit(example, index, ordered.length) }))
}

function labelCounts(rows: PreparedExample[]) {
  return Object.fromEntries(JOURNEY_STAGES.map(stage => [stage, rows.filter(row => row.labelStage === stage).length]))
}

function eligibilityMessage(mode: 'development' | 'production', rows: PreparedExample[]) {
  const counts = labelCounts(rows)
  const minimum = mode === 'production' ? 150 : 5
  const minimumPerStage = mode === 'production' ? 20 : 1
  const missing = JOURNEY_STAGES.filter(stage => (counts[stage] || 0) < minimumPerStage)
  if (rows.length < minimum) return `Need at least ${minimum} quality-passed, consented examples for a ${mode} run; found ${rows.length}.`
  if (missing.length) return `Need at least ${minimumPerStage} example per journey stage; missing ${missing.join(', ')}.`
  return null
}

function splitCounts(rows: PreparedExample[]) {
  return { train: rows.filter(row => row.split === 'train').length, validation: rows.filter(row => row.split === 'validation').length, test: rows.filter(row => row.split === 'test').length }
}

async function selectTrainingRuns(ownerUserId: number) {
  return requireAuditDatabase().select({
    id: publicIntelligenceTrainingRuns.id,
    mode: publicIntelligenceTrainingRuns.mode,
    provider: publicIntelligenceTrainingRuns.provider,
    modelFamily: publicIntelligenceTrainingRuns.modelFamily,
    modelVersion: publicIntelligenceTrainingRuns.modelVersion,
    featureContractVersion: publicIntelligenceTrainingRuns.featureContractVersion,
    labelTaxonomyVersion: publicIntelligenceTrainingRuns.labelTaxonomyVersion,
    splitVersion: publicIntelligenceTrainingRuns.splitVersion,
    status: publicIntelligenceTrainingRuns.status,
    exampleCount: publicIntelligenceTrainingRuns.exampleCount,
    trainCount: publicIntelligenceTrainingRuns.trainCount,
    validationCount: publicIntelligenceTrainingRuns.validationCount,
    testCount: publicIntelligenceTrainingRuns.testCount,
    labelCounts: publicIntelligenceTrainingRuns.labelCounts,
    metrics: publicIntelligenceTrainingRuns.metrics,
    modelArtifact: publicIntelligenceTrainingRuns.modelArtifact,
    remoteJobId: publicIntelligenceTrainingRuns.remoteJobId,
    remoteJobUrl: publicIntelligenceTrainingRuns.remoteJobUrl,
    baseModelId: publicIntelligenceTrainingRuns.baseModelId,
    modelRepoId: publicIntelligenceTrainingRuns.modelRepoId,
    datasetDigest: publicIntelligenceTrainingRuns.datasetDigest,
    errorCode: publicIntelligenceTrainingRuns.errorCode,
    createdAt: publicIntelligenceTrainingRuns.createdAt,
    completedAt: publicIntelligenceTrainingRuns.completedAt,
  }).from(publicIntelligenceTrainingRuns)
    .where(eq(publicIntelligenceTrainingRuns.ownerUserId, ownerUserId))
    .orderBy(desc(publicIntelligenceTrainingRuns.createdAt))
}

async function refreshHuggingFaceTrainingRun(run: TrainingRunRow, ownerUserId: number) {
  if (!run.remoteJobId || !(await isHuggingFaceConfigured(ownerUserId))) return
  const runtime = useRuntimeConfig()
  const stored = await getOwnerProviderCredentials(ownerUserId)
  const namespace = String(stored.huggingFaceNamespace || runtime.huggingFaceNamespace || '').trim()
  if (!namespace) return
  try {
    const job = await getHuggingFaceJob(namespace, run.remoteJobId, ownerUserId)
    const stage = String(job.status?.stage || '').toUpperCase()
    const nextStatus = stage === 'COMPLETED' ? 'completed' : ['ERROR', 'CANCELED', 'DELETED'].includes(stage) ? 'failed' : stage === 'RUNNING' ? 'running' : 'queued'
    const patch: Record<string, unknown> = { status: nextStatus }
    if (nextStatus === 'completed' || nextStatus === 'failed') patch.completedAt = new Date()
    if (nextStatus === 'failed') {
      patch.errorCode = 'huggingface_job_failed'
      patch.errorDetail = 'The remote Hugging Face job did not complete successfully.'
    }
    if (nextStatus === 'completed') {
      const logs = await getHuggingFaceJobLogs(namespace, run.remoteJobId, ownerUserId)
      const result = parseTrainingResult(logs)
      if (result) {
        patch.metrics = result.metrics || null
        patch.modelArtifact = { provider: 'huggingface_jobs', engine: result.engine, labels: result.labels, modelRepo: result.modelRepo, baseModel: result.baseModel, splitCounts: result.splitCounts, exampleCount: result.exampleCount }
        if (result.modelRepo) patch.modelRepoId = result.modelRepo
      }
    }
    await requireAuditDatabase().update(publicIntelligenceTrainingRuns).set(patch).where(eq(publicIntelligenceTrainingRuns.id, run.id))
  } catch {
    // Status refresh is best-effort; the ledger remains the source of truth and never exposes provider details from the exception.
  }
}

export async function listOwnerTrainingRuns(ownerUserId: number) {
  const rows = await selectTrainingRuns(ownerUserId)
  const pending = rows.filter(row => row.status === 'queued' || row.status === 'running') as unknown as TrainingRunRow[]
  await Promise.all(pending.map(run => refreshHuggingFaceTrainingRun(run, ownerUserId)))
  return pending.length ? selectTrainingRuns(ownerUserId) : rows
}

export async function runSupervisedTraining(input: { ownerUserId: number, mode: 'development' | 'production' }) {
  const database = requireAuditDatabase()
  const sourceRows = await database.select({
    id: auditTrainingExamples.id,
    labelStage: auditTrainingExamples.labelStage,
    dataSplit: auditTrainingExamples.dataSplit,
    featureVector: auditTrainingExamples.featureVector,
  }).from(auditTrainingExamples)
    .innerJoin(auditWorkspaces, eq(auditTrainingExamples.workspaceId, auditWorkspaces.id))
    .where(and(eq(auditWorkspaces.ownerUserId, input.ownerUserId), isNull(auditWorkspaces.deletedAt), eq(auditTrainingExamples.trainingConsent, true), isNull(auditTrainingExamples.consentRevokedAt), eq(auditTrainingExamples.qualityCheckStatus, 'passed')))
  const rows = prepareExamples(sourceRows as TrainingExample[])
  const counts = labelCounts(rows)
  const split = splitCounts(rows)
  const blockedReason = eligibilityMessage(input.mode, rows)
  const runResult = await database.insert(publicIntelligenceTrainingRuns).values({
    ownerUserId: input.ownerUserId,
    mode: input.mode,
    provider: 'huggingface_jobs',
    modelFamily: 'huggingface_transformers',
    modelVersion: TRAINING_MODEL_VERSION,
    featureContractVersion: TRAINING_FEATURE_CONTRACT_VERSION,
    labelTaxonomyVersion: TRAINING_LABEL_TAXONOMY_VERSION,
    splitVersion: TRAINING_SPLIT_VERSION,
    status: blockedReason ? 'blocked' : 'queued',
    exampleCount: rows.length,
    trainCount: split.train,
    validationCount: split.validation,
    testCount: split.test,
    labelCounts: counts,
    errorCode: blockedReason ? 'training_gate_not_met' : null,
    errorDetail: blockedReason,
    startedAt: blockedReason ? null : new Date(),
    completedAt: blockedReason ? new Date() : null,
  })
  const runId = Number(runResult[0].insertId)
  if (blockedReason) return { runId, status: 'blocked' as const, provider: 'huggingface_jobs' as const, message: blockedReason, counts, split }
  try {
    const remote = await startHuggingFaceTraining({ ownerUserId: input.ownerUserId, runId, mode: input.mode, records: rows.map(row => ({ id: row.id, label: row.labelStage, split: row.split, featureVector: row.featureVector })) })
    await database.update(publicIntelligenceTrainingRuns).set({ status: 'running', remoteJobId: remote.jobId, remoteJobUrl: remote.jobUrl, baseModelId: remote.baseModelId, modelRepoId: remote.modelRepo, datasetDigest: remote.datasetDigest, modelArtifact: { provider: 'huggingface_jobs', engine: 'transformers.Trainer', hardware: remote.flavor, modelRepo: remote.modelRepo, baseModel: remote.baseModelId } }).where(eq(publicIntelligenceTrainingRuns.id, runId))
    return { runId, status: 'running' as const, provider: 'huggingface_jobs' as const, remoteJobId: remote.jobId, remoteJobUrl: remote.jobUrl, modelRepoId: remote.modelRepo, baseModelId: remote.baseModelId, datasetDigest: remote.datasetDigest, counts, split, message: 'Hugging Face Transformers training job started. Refresh the ledger to see status and metrics.' }
  } catch (error: unknown) {
    const code = error instanceof Error && error.message.includes('huggingface_') ? error.message.split(':')[0] : 'huggingface_job_submit_failed'
    await database.update(publicIntelligenceTrainingRuns).set({ status: 'failed', errorCode: code, errorDetail: 'The remote training job could not be submitted. No model is claimed as trained.', completedAt: new Date() }).where(eq(publicIntelligenceTrainingRuns.id, runId))
    return { runId, status: 'failed' as const, provider: 'huggingface_jobs' as const, message: 'Hugging Face training was not started. Check the server token, namespace and Jobs permission.' }
  }
}

export function trainingReadiness(rows: { labelStage: string }[]) {
  const counts = Object.fromEntries(JOURNEY_STAGES.map(stage => [stage, rows.filter(row => row.labelStage === stage).length]))
  return { exampleCount: rows.length, labelCounts: counts, developmentReady: rows.length >= 5 && JOURNEY_STAGES.every(stage => (counts[stage] || 0) >= 1), productionReady: rows.length >= 150 && JOURNEY_STAGES.every(stage => (counts[stage] || 0) >= 20) }
}

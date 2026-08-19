import { and, desc, eq, isNull } from 'drizzle-orm'
import { auditTrainingExamples, auditWorkspaces, publicIntelligenceArtifacts, publicIntelligenceDatasetBuilds, publicIntelligenceDatasetMembers, publicIntelligenceSources, publicIntelligenceTrainingRuns } from '../database/schema'
import { PUBLIC_MANIFEST_MINIMUM_CANDIDATES, PUBLIC_MANIFEST_MINIMUM_PER_STAGE } from '../audit/baselines'
import { requireAuditDatabase } from '../audit/repository'
import { getHuggingFaceJob, getHuggingFaceJobLogs, isHuggingFaceConfigured, parseTrainingResult, startHuggingFaceTraining } from './huggingface-jobs'
import { getOwnerProviderCredentials } from './provider-repository'
import { buildSeoGeoTrainingText, JOURNEY_STAGES, SEO_GEO_LABEL_TAXONOMY_VERSION, seoGeoMultilabelSchema, toSeoGeoTrainingTargets, type SeoGeoTrainingTargets } from './seoGeoTaxonomy'

export const TRAINING_MODEL_VERSION = 'distilbert-multilingual-seo-geo-v2'
export const TRAINING_FEATURE_CONTRACT_VERSION = 'public-intelligence-v1'
export const TRAINING_LABEL_TAXONOMY_VERSION = SEO_GEO_LABEL_TAXONOMY_VERSION
export const TRAINING_SPLIT_VERSION = 'deterministic-id-v1'

type JourneyStage = typeof JOURNEY_STAGES[number]
type Split = 'train' | 'validation' | 'test'

type TrainingExample = {
  id: number
  labelStage: JourneyStage
  dataSplit: 'unassigned' | Split | 'holdout'
  featureVector: unknown
  targets: SeoGeoTrainingTargets
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
  const minimum = mode === 'production' ? 150 : PUBLIC_MANIFEST_MINIMUM_CANDIDATES
  const minimumPerStage = mode === 'production' ? 20 : PUBLIC_MANIFEST_MINIMUM_PER_STAGE
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
        patch.modelArtifact = { provider: 'huggingface_jobs', engine: result.engine, taskHeads: result.taskHeads || null, taxonomyVersion: result.taxonomyVersion || null, modelRepo: result.modelRepo, baseModel: result.baseModel, splitCounts: result.splitCounts, exampleCount: result.exampleCount }
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

async function selectApprovedPublicTrainingDataset(input: { ownerUserId: number, datasetBuildId: number }) {
  const database = requireAuditDatabase()
  const [dataset] = await database.select({ id: publicIntelligenceDatasetBuilds.id, datasetName: publicIntelligenceDatasetBuilds.datasetName, datasetVersion: publicIntelligenceDatasetBuilds.datasetVersion, featureContractVersion: publicIntelligenceDatasetBuilds.featureContractVersion, labelTaxonomyVersion: publicIntelligenceDatasetBuilds.labelTaxonomyVersion, splitVersion: publicIntelligenceDatasetBuilds.splitVersion, manifestHash: publicIntelligenceDatasetBuilds.manifestHash, status: publicIntelligenceDatasetBuilds.status, intendedUse: publicIntelligenceDatasetBuilds.intendedUse }).from(publicIntelligenceDatasetBuilds).where(and(eq(publicIntelligenceDatasetBuilds.id, input.datasetBuildId), eq(publicIntelligenceDatasetBuilds.ownerUserId, input.ownerUserId))).limit(1)
  if (!dataset || dataset.status !== 'approved' || dataset.intendedUse !== 'training') throw createError({ statusCode: 422, statusMessage: 'Choose an owner-approved public training manifest before submitting Hugging Face training.' })
  if (dataset.labelTaxonomyVersion !== SEO_GEO_LABEL_TAXONOMY_VERSION) throw createError({ statusCode: 422, statusMessage: 'The selected manifest does not use the active SEO/GEO multi-label taxonomy.' })
  const members = await database.select({ id: publicIntelligenceArtifacts.id, dataSplit: publicIntelligenceDatasetMembers.dataSplit, fieldData: publicIntelligenceArtifacts.fieldData, artifactText: publicIntelligenceArtifacts.artifactText, language: publicIntelligenceArtifacts.language, qualityStatus: publicIntelligenceArtifacts.qualityStatus, piiStatus: publicIntelligenceArtifacts.piiStatus, sourceUse: publicIntelligenceSources.allowedUse, sourceReviewStatus: publicIntelligenceSources.reviewStatus, memberStatus: publicIntelligenceDatasetMembers.memberStatus, sourceRemovedAt: publicIntelligenceSources.removedAt, artifactRemovedAt: publicIntelligenceArtifacts.removedAt }).from(publicIntelligenceDatasetMembers).innerJoin(publicIntelligenceArtifacts, eq(publicIntelligenceDatasetMembers.artifactId, publicIntelligenceArtifacts.id)).innerJoin(publicIntelligenceSources, eq(publicIntelligenceArtifacts.sourceId, publicIntelligenceSources.id)).where(eq(publicIntelligenceDatasetMembers.datasetBuildId, dataset.id))
  const rows: TrainingExample[] = []
  for (const member of members) {
    if (member.memberStatus !== 'included' || member.qualityStatus !== 'passed' || member.piiStatus !== 'none_detected' || member.sourceUse !== 'training_candidate' || member.sourceReviewStatus !== 'approved' || member.sourceRemovedAt || member.artifactRemovedAt) continue
    const parsed = seoGeoMultilabelSchema.safeParse(member.fieldData)
    if (!parsed.success) continue
    const trainingText = buildSeoGeoTrainingText({ artifactText: member.artifactText, language: member.language })
    if (!trainingText) continue
    rows.push({ id: member.id, labelStage: parsed.data.primaryJourneyStage, dataSplit: member.dataSplit, targets: toSeoGeoTrainingTargets(parsed.data), featureVector: { task: 'seo_geo_multitask', taxonomyVersion: parsed.data.annotationVersion, trainingText } })
  }
  return { dataset, rows: prepareExamples(rows) }
}

export async function runSupervisedTraining(input: { ownerUserId: number, mode: 'development' | 'production', datasetBuildId: number }) {
  const database = requireAuditDatabase()
  const { dataset, rows } = await selectApprovedPublicTrainingDataset(input)
  const counts = labelCounts(rows)
  const split = splitCounts(rows)
  const blockedReason = eligibilityMessage(input.mode, rows)
  const runResult = await database.insert(publicIntelligenceTrainingRuns).values({
    ownerUserId: input.ownerUserId,
    datasetBuildId: dataset.id,
    mode: input.mode,
    provider: 'huggingface_jobs',
    modelFamily: 'huggingface_transformers',
    modelVersion: TRAINING_MODEL_VERSION,
    featureContractVersion: dataset.featureContractVersion || TRAINING_FEATURE_CONTRACT_VERSION,
    labelTaxonomyVersion: dataset.labelTaxonomyVersion || TRAINING_LABEL_TAXONOMY_VERSION,
    splitVersion: dataset.splitVersion || TRAINING_SPLIT_VERSION,
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
  if (blockedReason) return { runId, datasetBuildId: dataset.id, status: 'blocked' as const, provider: 'huggingface_jobs' as const, message: blockedReason, counts, split }
  try {
    const remote = await startHuggingFaceTraining({ ownerUserId: input.ownerUserId, runId, mode: input.mode, records: rows.map(row => ({ id: row.id, label: row.labelStage, targets: row.targets, split: row.split, featureVector: row.featureVector })) })
    await database.update(publicIntelligenceTrainingRuns).set({ status: 'running', remoteJobId: remote.jobId, remoteJobUrl: remote.jobUrl, baseModelId: remote.baseModelId, modelRepoId: remote.modelRepo, datasetDigest: remote.datasetDigest, modelArtifact: { provider: 'huggingface_jobs', engine: 'shared_encoder_multitask', hardware: remote.flavor, modelRepo: remote.modelRepo, baseModel: remote.baseModelId, labelTaxonomyVersion: SEO_GEO_LABEL_TAXONOMY_VERSION, taskHeads: ['journeyStage', 'searchIntents', 'contentTypes', 'audienceRoles', 'geoSignals', 'citationReadiness', 'technicalSeoSignals', 'frictionSignals', 'actionPriority'] } }).where(eq(publicIntelligenceTrainingRuns.id, runId))
    return { runId, datasetBuildId: dataset.id, status: 'running' as const, provider: 'huggingface_jobs' as const, remoteJobId: remote.jobId, remoteJobUrl: remote.jobUrl, modelRepoId: remote.modelRepo, baseModelId: remote.baseModelId, datasetDigest: remote.datasetDigest, counts, split, message: 'Hugging Face shared-encoder multi-task SEO/GEO training started from the approved public manifest. Refresh the ledger to see per-head status and metrics.' }
  } catch (error: unknown) {
    const code = error instanceof Error && error.message.includes('huggingface_') ? error.message.split(':')[0] : 'huggingface_job_submit_failed'
    await database.update(publicIntelligenceTrainingRuns).set({ status: 'failed', errorCode: code, errorDetail: 'The remote training job could not be submitted. No model is claimed as trained.', completedAt: new Date() }).where(eq(publicIntelligenceTrainingRuns.id, runId))
    return { runId, datasetBuildId: dataset.id, status: 'failed' as const, provider: 'huggingface_jobs' as const, message: 'Hugging Face training was not started. Check the server token, namespace and Jobs permission.' }
  }
}

export function trainingReadiness(rows: { labelStage: string }[]) {
  const counts = Object.fromEntries(JOURNEY_STAGES.map(stage => [stage, rows.filter(row => row.labelStage === stage).length]))
  return { exampleCount: rows.length, labelCounts: counts, developmentReady: rows.length >= PUBLIC_MANIFEST_MINIMUM_CANDIDATES && JOURNEY_STAGES.every(stage => (counts[stage] || 0) >= PUBLIC_MANIFEST_MINIMUM_PER_STAGE), productionReady: rows.length >= 150 && JOURNEY_STAGES.every(stage => (counts[stage] || 0) >= 20) }
}

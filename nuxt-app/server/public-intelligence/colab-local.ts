import { createHash } from 'node:crypto'
import { publicIntelligenceTrainingRuns } from '../database/schema'
import { requireAuditDatabase } from '../audit/repository'
import { TRAINING_FEATURE_CONTRACT_VERSION, TRAINING_LABEL_TAXONOMY_VERSION, TRAINING_MODEL_VERSION, TRAINING_SPLIT_VERSION, selectApprovedPublicTrainingDataset, trainingReadiness } from './training'

const TASK_HEADS = ['journeyStage', 'searchIntents', 'contentTypes', 'audienceRoles', 'geoSignals', 'citationReadiness', 'technicalSeoSignals', 'frictionSignals', 'actionPriority'] as const

type ColabSnapshotRow = {
  id: number
  trainingText: string
  split: 'train' | 'validation' | 'test'
  targets: Record<string, string | string[]>
  manifestHash: string
}

type ColabTrainingResult = {
  manifestHash: string
  datasetDigest: string
  checkpointSha256: string
  artifactStorage: 'owner_browser_download' | 'owner_controlled_google_drive'
  baseModelId: string
  modelVersion: string
  metrics: Record<string, unknown>
  smokeTest: { nonTrainingExampleCount: number, passed: boolean, taskHeads: string[] }
  startedAt: string
  completedAt: string
}

function digestRows(rows: ColabSnapshotRow[]) {
  return createHash('sha256').update(rows.map(row => JSON.stringify(row)).join('\n')).digest('hex')
}

function assertDevelopmentReady(rows: { labelStage: string }[]) {
  const readiness = trainingReadiness(rows)
  if (!readiness.developmentReady) throw createError({ statusCode: 422, statusMessage: 'The approved manifest does not meet the 101-example and 10-per-stage development gate.' })
  return readiness
}

export async function createColabLocalSnapshot(input: { ownerUserId: number, datasetBuildId: number }) {
  const { dataset, rows } = await selectApprovedPublicTrainingDataset(input)
  const readiness = assertDevelopmentReady(rows)
  if (rows.length !== 101) throw createError({ statusCode: 422, statusMessage: 'This controlled Colab route is restricted to the approved 101-member manifest.' })
  const snapshot = rows.map<ColabSnapshotRow>(row => ({
    id: row.id,
    trainingText: String((row.featureVector as { trainingText?: string }).trainingText || ''),
    split: row.split,
    targets: row.targets,
    manifestHash: dataset.manifestHash,
  }))
  if (snapshot.some(row => !row.trainingText)) throw createError({ statusCode: 422, statusMessage: 'The immutable manifest contains an empty training representation.' })
  const datasetDigest = digestRows(snapshot)
  return { dataset, snapshot, datasetDigest, readiness }
}

export function toColabJsonl(snapshot: ColabSnapshotRow[]) {
  return `${snapshot.map(row => JSON.stringify(row)).join('\n')}\n`
}

export async function registerGoogleColabLocalRun(input: { ownerUserId: number, datasetBuildId: number, result: ColabTrainingResult }) {
  const { dataset, snapshot, datasetDigest, readiness } = await createColabLocalSnapshot(input)
  if (input.result.manifestHash !== dataset.manifestHash || input.result.datasetDigest !== datasetDigest) throw createError({ statusCode: 422, statusMessage: 'The Colab result does not match the frozen immutable manifest snapshot.' })
  if (!/^[a-f0-9]{64}$/i.test(input.result.checkpointSha256)) throw createError({ statusCode: 422, statusMessage: 'Provide a SHA-256 checkpoint digest for the owner-controlled training artifact.' })
  if (input.result.baseModelId !== 'distilbert-base-multilingual-cased') throw createError({ statusCode: 422, statusMessage: 'The Colab result uses an unapproved base model identifier.' })
  if (!input.result.smokeTest?.passed || input.result.smokeTest.nonTrainingExampleCount !== 5 || TASK_HEADS.some(task => !input.result.smokeTest.taskHeads.includes(task))) throw createError({ statusCode: 422, statusMessage: 'The result must record a passed five-example non-training inference smoke test across every task head.' })
  const startedAt = new Date(input.result.startedAt)
  const completedAt = new Date(input.result.completedAt)
  if (Number.isNaN(startedAt.valueOf()) || Number.isNaN(completedAt.valueOf()) || completedAt < startedAt) throw createError({ statusCode: 422, statusMessage: 'The Colab timestamps are invalid.' })
  const inserted = await requireAuditDatabase().insert(publicIntelligenceTrainingRuns).values({
    ownerUserId: input.ownerUserId,
    datasetBuildId: dataset.id,
    mode: 'development',
    provider: 'google_colab_local',
    modelFamily: 'huggingface_transformers',
    modelVersion: input.result.modelVersion || TRAINING_MODEL_VERSION,
    featureContractVersion: dataset.featureContractVersion || TRAINING_FEATURE_CONTRACT_VERSION,
    labelTaxonomyVersion: dataset.labelTaxonomyVersion || TRAINING_LABEL_TAXONOMY_VERSION,
    splitVersion: dataset.splitVersion || TRAINING_SPLIT_VERSION,
    status: 'completed',
    exampleCount: snapshot.length,
    trainCount: snapshot.filter(row => row.split === 'train').length,
    validationCount: snapshot.filter(row => row.split === 'validation').length,
    testCount: snapshot.filter(row => row.split === 'test').length,
    labelCounts: readiness.labelCounts,
    metrics: input.result.metrics,
    baseModelId: input.result.baseModelId,
    datasetDigest,
    modelArtifact: {
      provider: 'google_colab_local',
      storage: input.result.artifactStorage,
      checkpointSha256: input.result.checkpointSha256.toLowerCase(),
      taskHeads: TASK_HEADS,
      smokeTest: input.result.smokeTest,
      modelIsDevelopmentOnly: true,
      productionGate: { minimumExamples: 150, minimumPerJourneyStage: 20, passed: false },
    },
    startedAt,
    completedAt,
  })
  return { runId: Number(inserted[0].insertId), provider: 'google_colab_local' as const, status: 'completed' as const, manifestHash: dataset.manifestHash, datasetDigest }
}

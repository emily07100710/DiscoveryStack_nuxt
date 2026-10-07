import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { fingerprint } from '../geo-outcome-model/canonical'
import { buildOutcomeDatasetManifest } from '../outcome-learning/engine'
import { outcomeSha256 } from '../outcome-learning/normalization'
import type { LearningOutcomeModel } from '../database/schema'
import type { ContentOperationsRepository } from '../content-operations/repository'
import { learningError } from './authority'
import type { LearningLoopRepository } from './types'
import { buildGovernedContentOutcomeRelease } from './outcome-release'
import { DrizzleOutcomeModelRepository, type OutcomeModelRepository } from './effect-repository'
import { trainContentEffectModel, summarizeContentEffectArtifact, verifyContentEffectArtifact } from './effect-trainer'
import { buildEffectPublicationMetadata } from './effect-publication-metadata'
import { buildEffectLiveActionMetadata, validateEffectLiveActionMetadata } from './effect-live-action-metadata'
import type { LiveActionRepository } from './live-action-repository'

export type EffectModelDependencies = {
  models?: OutcomeModelRepository
  repository?: LearningLoopRepository
  operations?: ContentOperationsRepository
  liveActions?: LiveActionRepository
  release?: typeof buildGovernedContentOutcomeRelease
  trainer?: (input: Parameters<typeof trainContentEffectModel>[0]) => ReturnType<typeof trainContentEffectModel> | Promise<ReturnType<typeof trainContentEffectModel>>
  now?: () => Date
  enabled?: boolean
}
type Release = Awaited<ReturnType<typeof buildGovernedContentOutcomeRelease>>
const hash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
const sorted = (values: string[]) => [...values].sort()
const enabled = (deps: EffectModelDependencies) => deps.enabled ?? process.env.NUXT_LEARNING_EFFECT_TRAINING_ENABLED === 'true'
const at = (deps: EffectModelDependencies) => (deps.now || (() => new Date()))()
const freshRelease = (owner: number, deps: EffectModelDependencies) => (deps.release || buildGovernedContentOutcomeRelease)(owner, { repository: deps.repository, operations: deps.operations, now: () => at(deps), includeLiveActions: true, liveActions: deps.liveActions })
const usesLiveActions = (lineage: unknown): boolean => Array.isArray(lineage) && lineage.length > 0 && lineage.every(item => item && typeof item === 'object' && !Array.isArray(item) && hash(item.liveActionReleaseFingerprint))

/** Only server-reloaded release members. New eligible records do not invalidate an approved immutable subset. */
function projectRelease(release: Release, selected?: unknown, includeLiveActions = false) {
  const metadataEntries = release.publicationMetadataEntries || []
  const actionEntries = release.liveActionMetadataEntries || []
  const all = release.dataset.eligibleCandidates.filter(candidate => metadataEntries.some(row => row.candidateFingerprint === candidate.candidateFingerprint) && (!includeLiveActions || actionEntries.filter(row => row.candidateFingerprint === candidate.candidateFingerprint).length === 1))
  const keys = selected === undefined ? all.map(candidate => candidate.candidateFingerprint) : selected
  if (!Array.isArray(keys) || keys.length > 500 || keys.some(key => !hash(key)) || new Set(keys).size !== keys.length) return null
  const candidateFingerprints = sorted(keys as string[])
  const candidates = candidateFingerprints.map(key => all.find(candidate => candidate.candidateFingerprint === key))
  if (candidates.some(candidate => !candidate)) return null
  const lineage = candidateFingerprints.map(key => release.admittedLineage.filter(item => item.candidateFingerprint === key))
  if (lineage.some(rows => rows.length !== 1 || !hash(rows[0]?.lineageFingerprint))) return null
  const candidateLineage = lineage.map(rows => ({ ...rows[0]!, ...(includeLiveActions ? { liveActionReleaseFingerprint: actionEntries.find(item => item.candidateFingerprint === rows[0]!.candidateFingerprint)!.actionReleaseFingerprint } : {}) }))
  const metadata = candidateFingerprints.map(key => metadataEntries.filter(row => row.candidateFingerprint === key))
  if (metadata.some(rows => rows.length !== 1)) return null
  const publicationMetadata = buildEffectPublicationMetadata(metadata.map(rows => rows[0]!))
  if (!publicationMetadata) return null
  const actionMetadata = includeLiveActions ? buildEffectLiveActionMetadata(candidateFingerprints.map(key => actionEntries.find(item => item.candidateFingerprint === key)!)) : null
  const liveActionMetadata = actionMetadata ? validateEffectLiveActionMetadata(actionMetadata, candidates as typeof all, publicationMetadata) : null
  if (includeLiveActions && !liveActionMetadata) return null
  const manifest = buildOutcomeDatasetManifest({ candidates })
  const datasetDigest = outcomeSha256({ manifestFingerprint: manifest.manifestFingerprint, candidateFingerprints, policy: 'secondary_hash_only_dataset_review_v1' })
  const lineageFingerprint = fingerprint({ contract: includeLiveActions ? 'content-effect-live-action-release-v3' : 'content-effect-timed-release-v2', releaseContract: release.contractVersion, taskType: 'content_effect_direction', candidateLineage, publicationMetadataFingerprint: publicationMetadata.sidecarFingerprint, ...(liveActionMetadata ? { liveActionMetadataFingerprint: liveActionMetadata.sidecarFingerprint } : {}) })
  return { candidates: candidates as typeof all, candidateFingerprints, candidateLineage, publicationMetadata, liveActionMetadata, manifest, datasetDigest, lineageFingerprint, ready: manifest.status === 'ready_for_dataset_review' }
}
function reviewFingerprint(row: Pick<LearningOutcomeModel, 'ownerUserId' | 'datasetDigest' | 'lineageFingerprint' | 'candidateFingerprints' | 'candidateLineage' | 'approvedAt' | 'reviewReasonHash'>) {
  return fingerprint({ contract: usesLiveActions(row.candidateLineage) ? 'content-effect-live-action-owner-review-v3' : 'content-effect-owner-review-v2', ownerUserId: row.ownerUserId, datasetDigest: row.datasetDigest, lineageFingerprint: row.lineageFingerprint, candidateFingerprints: row.candidateFingerprints, candidateLineage: row.candidateLineage, approvedAt: row.approvedAt.toISOString(), reviewReasonHash: row.reviewReasonHash, piiReviewConfirmed: true, observationalOnlyAcknowledged: true })
}
function currentProjection(owner: number, row: LearningOutcomeModel, release: Release) {
  if (row.ownerUserId !== owner || row.revokedAt || row.status === 'revoked' || !Number.isFinite(row.approvedAt.getTime()) || !hash(row.reviewReasonHash) || row.dataReviewFingerprint !== reviewFingerprint(row)) return null
  const projection = projectRelease(release, row.candidateFingerprints, usesLiveActions(row.candidateLineage))
  return projection?.ready && projection.candidateFingerprints.length === row.candidateCount && projection.datasetDigest === row.datasetDigest && projection.lineageFingerprint === row.lineageFingerprint && fingerprint(projection.candidateLineage) === fingerprint(row.candidateLineage) ? projection : null
}
function dto(row: LearningOutcomeModel, usable: boolean, projection?: NonNullable<ReturnType<typeof projectRelease>>) {
  const artifact = row.artifact as { schema?: string; artifactHash?: string; datasetDigest?: string; lineageFingerprint?: string; publicationMetadataFingerprint?: string; liveActionMetadataFingerprint?: string } | null
  const actionMode = usesLiveActions(row.candidateLineage)
  const verified = usable && projection && row.status === 'completed' && verifyContentEffectArtifact(row.artifact)
    && artifact?.artifactHash === row.artifactHash && artifact.datasetDigest === row.datasetDigest && artifact.lineageFingerprint === row.lineageFingerprint
    && artifact.publicationMetadataFingerprint === projection.publicationMetadata.sidecarFingerprint
    && (actionMode ? artifact.schema === 'discoverystack.content-effect-logistic.v3' && artifact.liveActionMetadataFingerprint === projection.liveActionMetadata?.sidecarFingerprint : artifact.schema === 'discoverystack.content-effect-logistic.v2')
  return { id: row.id, status: row.status, inputMode: usesLiveActions(row.candidateLineage) ? 'reviewed_live_actions' as const : 'outcome_only' as const, datasetDigest: row.datasetDigest, lineageFingerprint: row.lineageFingerprint, candidateCount: row.candidateCount, approvedAt: row.approvedAt.toISOString(), currentLineageValid: usable, artifact: verified ? summarizeContentEffectArtifact(row.artifact as Parameters<typeof summarizeContentEffectArtifact>[0]) : null, reasonCode: row.reasonCode, productionActivation: false as const, automaticDraftModification: false as const }
}

export async function getContentEffectModelWorkspace(ownerUserId: number, deps: EffectModelDependencies = {}) {
  const repository = deps.models || new DrizzleOutcomeModelRepository(), rows = await repository.list(ownerUserId)
  const release = await freshRelease(ownerUserId, deps), projection = projectRelease(release)
  const actionProjection = projectRelease(release, undefined, true)
  // Listing is not a current-use authority: a concurrent revocation erases the stored artifact.
  const models = [] as ReturnType<typeof dto>[]
  for (const listed of rows) {
    const current = await repository.get(ownerUserId, listed.id)
    if (current?.ownerUserId === ownerUserId) {
      const projected = currentProjection(ownerUserId, current, release)
      models.push(dto(current, Boolean(projected), projected || undefined))
    }
  }
  const summary = (value: NonNullable<ReturnType<typeof projectRelease>>) => ({ datasetDigest: value.datasetDigest, lineageFingerprint: value.lineageFingerprint, candidateCount: value.candidateFingerprints.length, publicationMetadataFingerprint: value.publicationMetadata.sidecarFingerprint, trainingAsOf: value.publicationMetadata.trainingAsOf, status: value.manifest.status, reasonCodes: value.manifest.reasonCodes, binaryTarget: 'gsc_positive_vs_negative', ...(value.liveActionMetadata ? { liveActionMetadataFingerprint: value.liveActionMetadata.sidecarFingerprint } : {}) })
  return { enabled: enabled(deps), taskType: 'content_effect_direction' as const, release: projection ? summary(projection) : null, actionRelease: actionProjection ? summary(actionProjection) : null, metadataBlocked: release.metadataBlocked || [], liveActionBlocked: release.liveActionBlocked || [], models, limitations: ['owner_review_before_training', 'offline_experimental_not_causal', 'temporal_holdout_requires_unique_publications_and_pre_cutoff_labels', 'no_production_model_activation'] }
}

const reviewInput = z.object({ datasetDigest: z.string().regex(/^[a-f0-9]{64}$/), lineageFingerprint: z.string().regex(/^[a-f0-9]{64}$/), includeLiveActions: z.boolean().optional(), piiReviewConfirmed: z.literal(true), observationalOnlyAcknowledged: z.literal(true), reviewReason: z.string().trim().min(10).max(500) }).strict()
/** A durable approval reserves this exact server-owned candidate set; it does not fit a model. */
export async function approveContentEffectTraining(ownerUserId: number, input: unknown, deps: EffectModelDependencies = {}) {
  const parsed = reviewInput.safeParse(input)
  if (!parsed.success) learningError('INVALID_EFFECT_DATA_REVIEW', '請核對資料、個資與方向性限制，並記錄核准理由。', 422)
  const release = await freshRelease(ownerUserId, deps), projection = projectRelease(release, undefined, parsed.data.includeLiveActions === true)
  if (!projection?.ready) learningError('EFFECT_DATASET_NOT_READY', '目前合格成效資料不足，尚不能核准訓練。')
  if (parsed.data.datasetDigest !== projection.datasetDigest || parsed.data.lineageFingerprint !== projection.lineageFingerprint) learningError('EFFECT_RELEASE_CHANGED', '資料或同意已變動，請更新後重新核對。')
  const models = deps.models || new DrizzleOutcomeModelRepository(), now = new Date(Math.floor(at(deps).getTime() / 1000) * 1000)
  const body = { ownerUserId, datasetDigest: projection.datasetDigest, lineageFingerprint: projection.lineageFingerprint, reviewReasonHash: fingerprint(parsed.data.reviewReason), candidateCount: projection.candidateFingerprints.length, candidateFingerprints: projection.candidateFingerprints, candidateLineage: projection.candidateLineage, approvedAt: now }
  const existing = await models.findRelease(ownerUserId, body.datasetDigest, body.lineageFingerprint)
  const row = existing || await models.reserve({ ...body, dataReviewFingerprint: reviewFingerprint(body), status: 'queued', artifact: null, artifactHash: null, metrics: null, reasonCode: null, leaseToken: null, leaseVersion: 0, leaseExpiresAt: null, completedAt: null, revokedAt: null })
  const currentRelease = await freshRelease(ownerUserId, deps), currentRow = await models.get(ownerUserId, row.id)
  if (!currentRow || !currentProjection(ownerUserId, currentRow, currentRelease)) learningError('EFFECT_APPROVAL_LINEAGE_CHANGED', '核准期間資料或同意已變動，此紀錄不能訓練。')
  return { model: dto(currentRow, true), replayed: Boolean(existing), trainingPerformed: false as const }
}

const executeInput = z.object({ modelId: z.number().int().positive() }).strict()
/** One bounded CPU fit, protected by a durable lease and a current release check before and after fitting. */
export async function executeContentEffectTraining(ownerUserId: number, input: unknown, deps: EffectModelDependencies = {}) {
  if (!enabled(deps)) learningError('EFFECT_TRAINING_DISABLED', '成效模型訓練尚未由管理員開通。', 503)
  const parsed = executeInput.safeParse(input)
  if (!parsed.success) learningError('INVALID_EFFECT_TRAINING_INPUT', '請選擇已核准的成效訓練紀錄。', 422)
  const models = deps.models || new DrizzleOutcomeModelRepository(), initialRow = await models.get(ownerUserId, parsed.data.modelId)
  if (!initialRow || initialRow.ownerUserId !== ownerUserId) learningError('EFFECT_MODEL_NOT_FOUND', '找不到這份成效訓練紀錄。', 404)
  const release = await freshRelease(ownerUserId, deps), row = await models.get(ownerUserId, initialRow.id)
  const projection = row ? currentProjection(ownerUserId, row, release) : null
  if (!projection) learningError('CURRENT_EFFECT_LINEAGE_REQUIRED', '資料、權利或同意已變動，不能使用歷史核准繼續訓練。')
  if (!row) learningError('EFFECT_MODEL_NOT_FOUND', undefined, 404)
  if (row.status === 'completed' || row.status === 'blocked') return { model: dto(row, true, projection), replayed: true, productionActivation: false as const }
  const claimAt = at(deps)
  const claimed = await models.claim(ownerUserId, row.id, row.leaseVersion, randomUUID(), claimAt, new Date(claimAt.getTime() + 300000))
  if (!claimed?.leaseToken) {
    const busyRelease = await freshRelease(ownerUserId, deps), busyRow = await models.get(ownerUserId, row.id)
    const busyProjection = busyRow ? currentProjection(ownerUserId, busyRow, busyRelease) : null
    if (!busyRow || !busyProjection) learningError('CURRENT_EFFECT_LINEAGE_REQUIRED')
    return { model: dto(busyRow, true, busyProjection), status: 'busy', replayed: true, productionActivation: false as const }
  }
  const lease = { ownerUserId, id: row.id, leaseToken: claimed.leaseToken, leaseVersion: claimed.leaseVersion }
  try {
    // A DB claim may wait. Re-read both data authority and the exact lease before spending CPU.
    const beforeFitRelease = await freshRelease(ownerUserId, deps), beforeFitRow = await models.get(ownerUserId, row.id)
    const beforeFit = beforeFitRow ? currentProjection(ownerUserId, beforeFitRow, beforeFitRelease) : null
    if (!beforeFit) { await models.revoke(ownerUserId, row.id, claimed.leaseVersion, at(deps), 'LINEAGE_CHANGED_BEFORE_TRAINING'); learningError('CURRENT_EFFECT_LINEAGE_REQUIRED') }
    if (beforeFitRow?.status !== 'training' || beforeFitRow.leaseToken !== lease.leaseToken || beforeFitRow.leaseVersion !== lease.leaseVersion || !beforeFitRow.leaseExpiresAt || beforeFitRow.leaseExpiresAt <= at(deps)) learningError('EFFECT_TRAINING_LEASE_LOST')
    const result = await (deps.trainer || trainContentEffectModel)({ candidates: beforeFit.candidates, publicationMetadata: beforeFit.publicationMetadata, ...(beforeFit.liveActionMetadata ? { liveActionMetadata: beforeFit.liveActionMetadata } : {}), datasetDigest: beforeFit.datasetDigest, lineageFingerprint: beforeFit.lineageFingerprint, deadlineMs: 5000 })
    const current = currentProjection(ownerUserId, claimed, await freshRelease(ownerUserId, deps))
    if (!current) { await models.revoke(ownerUserId, row.id, claimed.leaseVersion, at(deps), 'LINEAGE_CHANGED_DURING_TRAINING'); learningError('CURRENT_EFFECT_LINEAGE_REQUIRED') }
    const correctActionVersion = result.artifact && (beforeFit.liveActionMetadata ? result.artifact.schema === 'discoverystack.content-effect-logistic.v3' && 'liveActionMetadataFingerprint' in result.artifact && result.artifact.liveActionMetadataFingerprint === beforeFit.liveActionMetadata.sidecarFingerprint : result.artifact.schema === 'discoverystack.content-effect-logistic.v2')
    const artifact = result.status === 'completed' && result.artifact && correctActionVersion && verifyContentEffectArtifact(result.artifact) && result.artifact.datasetDigest === projection.datasetDigest && result.artifact.lineageFingerprint === projection.lineageFingerprint && result.artifact.publicationMetadataFingerprint === beforeFit.publicationMetadata.sidecarFingerprint ? result.artifact : null
    const saved = await models.finalize(lease, at(deps), { status: artifact ? 'completed' : 'blocked', artifact, artifactHash: artifact?.artifactHash || null, metrics: artifact?.metrics || null, reasonCode: artifact ? null : result.reasonCodes[0] || 'EFFECT_ARTIFACT_INVALID' })
    if (!saved) learningError('EFFECT_TRAINING_LEASE_LOST')
    // Releasing a response is also a use: never display a historical artifact after authority drift.
    const responseRelease = await freshRelease(ownerUserId, deps), responseRow = await models.get(ownerUserId, row.id)
    const responseProjection = responseRow ? currentProjection(ownerUserId, responseRow, responseRelease) : null
    if (!responseRow || !responseProjection) { await models.revoke(ownerUserId, row.id, saved.leaseVersion, at(deps), 'LINEAGE_CHANGED_BEFORE_RESPONSE'); learningError('CURRENT_EFFECT_LINEAGE_REQUIRED') }
    return { model: dto(responseRow, true, responseProjection), reasonCodes: result.reasonCodes, counts: result.counts, replayed: false, productionActivation: false as const }
  } catch (error) {
    await models.finalize(lease, at(deps), { status: 'blocked', artifact: null, artifactHash: null, metrics: null, reasonCode: 'EFFECT_TRAINING_FAILED' })
    throw error
  }
}

export async function revokeContentEffectModel(ownerUserId: number, id: number, deps: EffectModelDependencies = {}) {
  const models = deps.models || new DrizzleOutcomeModelRepository(), row = await models.get(ownerUserId, id)
  if (!row || row.ownerUserId !== ownerUserId) learningError('EFFECT_MODEL_NOT_FOUND', undefined, 404)
  if (!row.revokedAt) await models.revoke(ownerUserId, row.id, row.leaseVersion, at(deps), 'OWNER_REVOKED')
  const current = await models.get(ownerUserId, id)
  return { model: current ? dto(current, false) : null, productionActivation: false as const }
}

/** Retention/revocation cleanup also runs when new training is paused. No raw content or external model is touched. */
export async function cleanInvalidContentEffectModels(ownerUserId: number, deps: EffectModelDependencies = {}) {
  const models = deps.models || new DrizzleOutcomeModelRepository(), count = await models.countLive(ownerUserId)
  const pages = Math.max(1, Math.ceil(count / 100)), offset = (Math.floor(at(deps).getTime() / 300000) % pages) * 100
  const rows = await models.listLive(ownerUserId, offset)
  if (!rows.length) return { checked: 0, revoked: 0 }
  let revoked = 0
  for (const listed of rows) {
    const release = await freshRelease(ownerUserId, deps), row = await models.get(ownerUserId, listed.id)
    if (row && !row.revokedAt && !currentProjection(ownerUserId, row, release)) revoked += Number(await models.revoke(ownerUserId, row.id, row.leaseVersion, at(deps), 'CURRENT_LEARNING_LINEAGE_INVALID'))
  }
  return { checked: rows.length, revoked }
}

export async function runContentEffectTrainingTick(ownerUserId: number, deps: EffectModelDependencies = {}) {
  if (!enabled(deps)) return { status: 'disabled', trained: 0 }
  const models = deps.models || new DrizzleOutcomeModelRepository()
  const row = await models.nextPending(ownerUserId, at(deps))
  if (!row) return { status: 'no_reviewed_training_work', trained: 0 }
  const result = await executeContentEffectTraining(ownerUserId, { modelId: row.id }, { ...deps, models })
  return { status: result.model.status, trained: result.model.status === 'completed' && !result.replayed ? 1 : 0, modelId: row.id, productionActivation: false as const }
}

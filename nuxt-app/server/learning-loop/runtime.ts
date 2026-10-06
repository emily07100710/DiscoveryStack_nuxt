import { z } from 'zod'
import { createContentOperationsRepository, type ContentOperationsRepository } from '../content-operations/repository'
import { runWeeklyContentTick } from '../weekly-content/runtime'
import { reconcileLearningPublications, type PublicationBridgeDependencies } from './publication-bridge'
import { collectAuthorizedLearningEvidence, type LearningLoopDependencies } from './service'
import { learningError, resolveLearningAuthority } from './authority'
import { DrizzleLearningLoopRepository } from './repository'
import { buildGovernedContentOutcomeRelease } from './outcome-release'

export type LearningRuntimeDependencies = LearningLoopDependencies & {
  enabled?: boolean
  operations?: ContentOperationsRepository
  weekly?: typeof runWeeklyContentTick
  reconcile?: typeof reconcileLearningPublications
  bridge?: PublicationBridgeDependencies
}
const clientCycleSchema = z.object({ clientId: z.number().int().positive() }).strict()

/** One selected customer only. Customer approval is recorded in a webhook; publishing is worker-owned. */
export async function runLearningClientCycle(ownerUserId: number, input: unknown, deps: LearningRuntimeDependencies = {}) {
  if (!(deps.enabled ?? process.env.NUXT_LEARNING_LOOP_ENABLED === 'true')) learningError('LEARNING_LOOP_DISABLED', '閉環排程尚未由管理員開通。', 503)
  const result = clientCycleSchema.safeParse(input)
  if (!result.success) learningError('INVALID_CLIENT_CYCLE', '請選擇有效客戶。', 422)
  const repository = deps.repository || new DrizzleLearningLoopRepository(), clientId = result.data.clientId
  const client = await repository.getClient(ownerUserId, clientId)
  if (!client || client.status !== 'active') learningError('CURRENT_CLIENT_REQUIRED')
  const operations = deps.operations || createContentOperationsRepository()
  const weekly = await (deps.weekly || runWeeklyContentTick)({ ownerUserId, clientId, maxClients: 1 })
  const publicationRecovery = await (deps.reconcile || reconcileLearningPublications)(ownerUserId, operations, deps.bridge, clientId)
  return { status: 'completed', clientId, weekly, publicationRecovery, limitations: ['one_client_only', 'line_approval_records_no_publication_inside_webhook', 'only_current_exact_draft_may_publish', 'no_automatic_model_activation'] }
}

/** No unattended crawl without a current recorded grant, and at most one bounded collection per tick. */
export async function runLearningAcquisitionTick(ownerUserId: number, deps: LearningRuntimeDependencies = {}) {
  if (!(deps.enabled ?? process.env.NUXT_LEARNING_LOOP_ENABLED === 'true')) return { status: 'disabled', collected: 0 }
  if (!(deps.crawlEnabled ?? process.env.NUXT_LEARNING_CRAWL_ENABLED === 'true')) return { status: 'crawl_disabled', collected: 0 }
  const repository = deps.repository || new DrizzleLearningLoopRepository(), now = (deps.now || (() => new Date()))()
  const eligible = []
  for (const grant of await repository.listAuthorizations(ownerUserId)) {
    const scope = await repository.getScope(ownerUserId, grant.id)
    if (resolveLearningAuthority(scope, { ownerUserId, clientId: grant.clientId, sourceId: grant.sourceId }, now)) eligible.push(grant)
  }
  if (!eligible.length) return { status: 'consent_required', collected: 0 }
  const offset = Math.floor(now.getTime() / 300000) % eligible.length
  for (let step = 0; step < eligible.length; step += 1) {
    const grant = eligible[(offset + step) % eligible.length]!
    const idempotencyKey = `daily:${grant.id}:${now.toISOString().slice(0, 10)}`
    const existing = await repository.findCollection(ownerUserId, idempotencyKey)
    if (existing && (existing.status !== 'collecting' || (existing.leaseExpiresAt && existing.leaseExpiresAt > now))) continue
    const result = await collectAuthorizedLearningEvidence(ownerUserId, { authorizationId: grant.id, idempotencyKey }, { ...deps, repository })
    return { status: result.collection.status, collected: result.collection.status === 'completed' ? 1 : 0, collectionId: result.collection.id, reviewStatus: result.collection.reviewStatus }
  }
  return { status: 'daily_acquisition_complete', collected: 0 }
}

export async function getLearningRuntimeReadiness(ownerUserId: number, deps: LearningRuntimeDependencies = {}) {
  const repository = deps.repository || new DrizzleLearningLoopRepository(), now = (deps.now || (() => new Date()))()
  const [clients, grants] = await Promise.all([repository.listClients(ownerUserId), repository.listAuthorizations(ownerUserId)])
  const valid = []
  for (const grant of grants) if (resolveLearningAuthority(await repository.getScope(ownerUserId, grant.id), { ownerUserId, clientId: grant.clientId, sourceId: grant.sourceId }, now)) valid.push(grant)
  return { enabled: deps.enabled ?? process.env.NUXT_LEARNING_LOOP_ENABLED === 'true', activeClients: clients.filter(client => client.status === 'active').length, currentLearningAuthorizations: valid.length, customerApprovalRequired: true, automaticModelActivation: false }
}

export { buildGovernedContentOutcomeRelease }

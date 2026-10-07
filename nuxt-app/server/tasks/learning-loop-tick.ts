import { resolveControlledOwnerDatabaseUserId } from '../audit/repository'
import { runLearningAcquisitionTick } from '../learning-loop/runtime'
import { reconcileLearningPublications } from '../learning-loop/publication-bridge'
import { createContentOperationsRepository } from '../content-operations/repository'
import { expireLearningEvidenceCollections } from '../learning-loop/service'
import { cleanInvalidContentEffectModels, runContentEffectTrainingTick } from '../learning-loop/effect-service'
import { cleanInvalidLivePublicationActions, runLivePublicationActionRecovery } from '../learning-loop/live-action-service'

export default defineTask({
  meta: { name: 'learning-loop:tick', description: 'Collect one consented structural source, recover delivered measurement registration, and train one owner-reviewed observational dataset; never auto-approve data or activate a model.' },
  async run(): Promise<{ result: Record<string, unknown> }> {
    const loopEnabled = process.env.NUXT_LEARNING_LOOP_ENABLED === 'true'
    if (!loopEnabled && process.env.NUXT_LEARNING_RETENTION_ENABLED !== 'true') return { result: { status: 'disabled' } }
    const config = useRuntimeConfig()
    const ownerUserId = await resolveControlledOwnerDatabaseUserId(String(config.ownerOpenId || process.env.OWNER_OPEN_ID || ''))
    const retention = await expireLearningEvidenceCollections(ownerUserId)
    let modelRetention
    try { modelRetention = await cleanInvalidContentEffectModels(ownerUserId) } catch { modelRetention = { status: 'deferred', reasonCode: 'MODEL_RETENTION_DEFERRED' } }
    let actionRetention
    if (process.env.NUXT_LEARNING_RETENTION_ENABLED === 'true') {
      try { actionRetention = await cleanInvalidLivePublicationActions(ownerUserId) } catch { actionRetention = { status: 'deferred', reasonCode: 'LIVE_ACTION_RETENTION_DEFERRED' } }
    } else actionRetention = { status: 'disabled' }
    if (!loopEnabled) return { result: { status: 'retention_only', retention, modelRetention, actionRetention } }
    // Recovery is independent of crawl failure. Both use bounded, owner-scoped durable ledgers.
    let recovery
    try { recovery = await reconcileLearningPublications(ownerUserId, createContentOperationsRepository()) } catch { recovery = { status: 'deferred', reasonCode: 'PUBLICATION_RECOVERY_DEFERRED' } }
    let actionRecovery
    try { actionRecovery = await runLivePublicationActionRecovery(ownerUserId) } catch { actionRecovery = { status: 'deferred', reasonCode: 'LIVE_ACTION_RECOVERY_DEFERRED' } }
    let acquisition
    try { acquisition = await runLearningAcquisitionTick(ownerUserId) } catch { acquisition = { status: 'deferred', reasonCode: 'ACQUISITION_DEFERRED' } }
    let training
    try { training = await runContentEffectTrainingTick(ownerUserId) } catch { training = { status: 'deferred', reasonCode: 'EFFECT_TRAINING_DEFERRED' } }
    return { result: { retention, modelRetention, actionRetention, recovery, actionRecovery, acquisition, training, productionModelActivation: false } }
  },
})

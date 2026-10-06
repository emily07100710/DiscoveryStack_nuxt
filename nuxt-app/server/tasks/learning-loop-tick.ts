import { resolveControlledOwnerDatabaseUserId } from '../audit/repository'
import { runLearningAcquisitionTick } from '../learning-loop/runtime'
import { reconcileLearningPublications } from '../learning-loop/publication-bridge'
import { createContentOperationsRepository } from '../content-operations/repository'
import { expireLearningEvidenceCollections } from '../learning-loop/service'
import { cleanInvalidContentEffectModels, runContentEffectTrainingTick } from '../learning-loop/effect-service'

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
    if (!loopEnabled) return { result: { status: 'retention_only', retention, modelRetention } }
    // Recovery is independent of crawl failure. Both use bounded, owner-scoped durable ledgers.
    let recovery
    try { recovery = await reconcileLearningPublications(ownerUserId, createContentOperationsRepository()) } catch { recovery = { status: 'deferred', reasonCode: 'PUBLICATION_RECOVERY_DEFERRED' } }
    let acquisition
    try { acquisition = await runLearningAcquisitionTick(ownerUserId) } catch { acquisition = { status: 'deferred', reasonCode: 'ACQUISITION_DEFERRED' } }
    let training
    try { training = await runContentEffectTrainingTick(ownerUserId) } catch { training = { status: 'deferred', reasonCode: 'EFFECT_TRAINING_DEFERRED' } }
    return { result: { retention, modelRetention, recovery, acquisition, training, productionModelActivation: false } }
  },
})

import { resolveControlledOwnerDatabaseUserId } from '../../audit/repository'
import { collectModelImprovementCandidates, maybeStartApprovedAutomaticTraining, prepareRetrainingManifestIfReady } from '../../model-improvement/pipeline'

export default defineTask({
  meta: {
    name: 'model-improvement:collect',
    description: 'Collect consented public-homepage structural candidates and prepare governed retraining.',
  },
  async run({ payload }) {
    const config = useRuntimeConfig()
    const ownerUserId = await resolveControlledOwnerDatabaseUserId(String(config.ownerOpenId || process.env.OWNER_OPEN_ID || ''))
    const trigger = payload?.trigger === 'owner_manual' ? 'owner_manual' : 'scheduled'
    const collection = await collectModelImprovementCandidates({ ownerUserId, trigger })
    const manifest = await prepareRetrainingManifestIfReady(ownerUserId)
    const training = await maybeStartApprovedAutomaticTraining(ownerUserId)
    return { result: { collection, manifest, training } }
  },
})

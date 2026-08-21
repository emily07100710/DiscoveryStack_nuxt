import { getOwnerDatabaseUserId } from '../../../audit/repository'
import { maybeStartApprovedAutomaticTraining, prepareRetrainingManifestIfReady } from '../../../model-improvement/pipeline'
import { requireOwner } from '../../../utils/auth'

export default defineEventHandler(async (event) => {
  setHeader(event, 'cache-control', 'private, no-store, max-age=0')
  const owner = await requireOwner(event)
  const ownerUserId = await getOwnerDatabaseUserId(owner.openId)
  const manifest = await prepareRetrainingManifestIfReady(ownerUserId)
  const training = await maybeStartApprovedAutomaticTraining(ownerUserId)
  return { manifest, training }
})

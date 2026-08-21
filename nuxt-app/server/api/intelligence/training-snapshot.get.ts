import { getOwnerDatabaseUserId } from '../../audit/repository'
import { createColabLocalSnapshot, toColabJsonl } from '../../public-intelligence/colab-local'
import { requireOwner } from '../../utils/auth'

export default defineEventHandler(async event => {
  const owner = await requireOwner(event)
  const datasetBuildId = Number(getQuery(event).datasetBuildId || 1)
  if (!Number.isInteger(datasetBuildId) || datasetBuildId < 1) throw createError({ statusCode: 422, statusMessage: 'Choose a valid immutable dataset manifest.' })
  const prepared = await createColabLocalSnapshot({ ownerUserId: await getOwnerDatabaseUserId(owner.openId), datasetBuildId })
  setResponseHeader(event, 'content-type', 'application/x-ndjson; charset=utf-8')
  setResponseHeader(event, 'content-disposition', `attachment; filename="discoverystack-manifest-${prepared.dataset.id}-${prepared.dataset.manifestHash.slice(0, 12)}.jsonl"`)
  setResponseHeader(event, 'cache-control', 'no-store, private')
  return toColabJsonl(prepared.snapshot)
})

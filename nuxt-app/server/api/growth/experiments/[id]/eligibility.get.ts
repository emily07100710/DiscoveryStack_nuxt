import { getPairedTrainingEligibility } from '../../../../growth/ledger'
import { requireOwner } from '../../../../utils/auth'

export default defineEventHandler(async (event) => {
  await requireOwner(event)
  const experimentId = Number(event.context.params?.id)
  if (!Number.isInteger(experimentId) || experimentId < 1) throw createError({ statusCode: 422, statusMessage: 'A valid experiment reference is required.' })
  return getPairedTrainingEligibility(experimentId)
})

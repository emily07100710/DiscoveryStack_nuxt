import { getOwnerDatabaseUserId } from '../../audit/repository'
import { listOwnerStrategyRecommendations } from '../../seo-geo-core/repository'
import { requireOwner } from '../../utils/auth'

export default defineEventHandler(async event => {
  const owner = await requireOwner(event)
  const diagnosisIdValue = getQuery(event).diagnosisId
  const diagnosisId = diagnosisIdValue ? Number(diagnosisIdValue) : undefined
  if (diagnosisId !== undefined && (!Number.isInteger(diagnosisId) || diagnosisId <= 0)) throw createError({ statusCode: 422, statusMessage: 'Invalid Diagnosis ID.' })
  return listOwnerStrategyRecommendations(await getOwnerDatabaseUserId(owner.openId), diagnosisId)
})

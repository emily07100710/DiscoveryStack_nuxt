import { z } from 'zod'
import { getOwnerDatabaseUserId } from '../../audit/repository'
import { createStrategyRecommendations } from '../../seo-geo-core/repository'
import { requireOwner } from '../../utils/auth'

const inputSchema = z.object({ diagnosisId: z.number().int().positive() })

export default defineEventHandler(async event => {
  const owner = await requireOwner(event)
  const parsed = inputSchema.safeParse(await readBody(event))
  if (!parsed.success) throw createError({ statusCode: 422, statusMessage: 'Provide a valid Diagnosis ID.', data: parsed.error.flatten().fieldErrors })
  return createStrategyRecommendations({ ownerUserId: await getOwnerDatabaseUserId(owner.openId), diagnosisId: parsed.data.diagnosisId })
})

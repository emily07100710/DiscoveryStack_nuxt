import { z } from 'zod'
import { getOwnerDatabaseUserId } from '../../audit/repository'
import { getProductionPlanDetail, createProductionPlan } from '../../seo-geo-core/repository'
import { requireOwner } from '../../utils/auth'

const inputSchema = z.object({
  diagnosisId: z.number().int().positive().optional(),
  strategyRecommendationIds: z.array(z.number().int().positive()).min(1).max(10),
  title: z.string().trim().min(3).max(300),
  language: z.enum(['en', 'zh-hant']),
  idempotencyKey: z.string().trim().min(12).max(128),
})

export default defineEventHandler(async event => {
  const owner = await requireOwner(event)
  const parsed = inputSchema.safeParse(await readBody(event))
  if (!parsed.success) throw createError({ statusCode: 422, statusMessage: 'Review the Production Plan fields.', data: parsed.error.flatten().fieldErrors })
  const ownerUserId = await getOwnerDatabaseUserId(owner.openId)
  const created = await createProductionPlan({ ownerUserId, ...parsed.data })
  return { ...created, detail: await getProductionPlanDetail(ownerUserId, created.plan.id) }
})

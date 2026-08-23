import { z } from 'zod'
import { getOwnerDatabaseUserId } from '../../audit/repository'
import { createContentBrief } from '../../seo-geo-core/repository'
import { requireOwner } from '../../utils/auth'

const evidenceSchema = z.object({ sourceId: z.number().int().positive().optional(), artifactId: z.number().int().positive().optional(), locator: z.string().max(2048).optional(), artifactHash: z.string().max(256).optional(), reason: z.string().trim().min(2).max(1000) })
const inputSchema = z.object({ diagnosisId: z.number().int().positive().optional(), strategyRecommendationId: z.number().int().positive().optional(), productionPlanId: z.number().int().positive().optional(), productionDeliverableId: z.number().int().positive().optional(), ruleIds: z.array(z.string().trim().min(1).max(160)).max(40).optional(), provenance: z.record(z.string(), z.unknown()).optional(), title: z.string().trim().min(3).max(180), audience: z.string().trim().min(2).max(500), contentType: z.enum(['article', 'service_page', 'faq', 'landing_page', 'brief']), language: z.enum(['en', 'zh-hant']), goals: z.array(z.string().trim().min(2).max(500)).min(1).max(12), constraints: z.array(z.string().trim().min(2).max(1000)).min(1).max(20), evidenceRefs: z.array(evidenceSchema).min(1).max(40) })

export default defineEventHandler(async event => {
  const owner = await requireOwner(event)
  const parsed = inputSchema.safeParse(await readBody(event))
  if (!parsed.success) throw createError({ statusCode: 422, statusMessage: 'Review the Content Brief fields.', data: parsed.error.flatten().fieldErrors })
  const { diagnosisId, ...brief } = parsed.data
  return createContentBrief({ ownerUserId: await getOwnerDatabaseUserId(owner.openId), diagnosisId, brief })
})

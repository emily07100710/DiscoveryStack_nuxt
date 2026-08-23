import { z } from 'zod'
import { getOwnerDatabaseUserId } from '../../audit/repository'
import { createContentBrief } from '../../seo-geo-core/repository'
import { requireOwner } from '../../utils/auth'

const evidenceSchema = z.object({ sourceId: z.number().int().positive().optional(), artifactId: z.number().int().positive().optional(), locator: z.string().max(2048).optional(), artifactHash: z.string().max(256).optional(), reason: z.string().trim().min(2).max(1000) })
const inputSchema = z.object({ title: z.string().trim().min(3).max(180), audience: z.string().trim().min(2).max(500), contentType: z.enum(['article', 'service_page', 'faq', 'landing_page', 'brief']), language: z.enum(['en', 'zh-hant']), goals: z.array(z.string().trim().min(2).max(500)).min(1).max(12), constraints: z.array(z.string().trim().min(2).max(1000)).min(1).max(20), evidenceRefs: z.array(evidenceSchema).min(1).max(40) }).strict()

export default defineEventHandler(async event => {
  const owner = await requireOwner(event)
  const rawBody = await readBody(event) as Record<string, unknown>
  const forbiddenCanonicalFields = ['diagnosisId', 'strategyRecommendationId', 'productionPlanId', 'productionDeliverableId', 'ruleIds', 'provenance']
  if (forbiddenCanonicalFields.some(field => Object.prototype.hasOwnProperty.call(rawBody || {}, field))) throw createError({ statusCode: 422, statusMessage: 'Canonical diagnosis, strategy, plan, deliverable, rule IDs, and provenance are server-owned. Use the guided Production Plan flow.' })
  const parsed = inputSchema.safeParse(rawBody)
  if (!parsed.success) throw createError({ statusCode: 422, statusMessage: 'Review the standalone Content Brief fields.', data: parsed.error.flatten().fieldErrors })
  return createContentBrief({ ownerUserId: await getOwnerDatabaseUserId(owner.openId), brief: parsed.data })
})

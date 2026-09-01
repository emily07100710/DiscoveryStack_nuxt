import { z } from 'zod'
import { getOwnerDatabaseUserId } from '../../audit/repository'
import { composeContentStructuredData } from '../../knowledge'
import { getProductionPlanDetail, prepareDeliveryPreview } from '../../seo-geo-core/repository'
import { requireOwner } from '../../utils/auth'

const inputSchema = z.object({ jobId: z.number().int().positive(), draftId: z.number().int().positive(), targetId: z.number().int().positive(), idempotencyKey: z.string().trim().min(12).max(128) })

export default defineEventHandler(async event => {
  const owner = await requireOwner(event)
  const parsed = inputSchema.safeParse(await readBody(event))
  if (!parsed.success) throw createError({ statusCode: 422, statusMessage: 'Review the delivery preview fields.', data: parsed.error.flatten().fieldErrors })
  const ownerUserId = await getOwnerDatabaseUserId(owner.openId)
  const preview = await prepareDeliveryPreview({ ownerUserId, ...parsed.data })
  const plan = preview.planId ? await getProductionPlanDetail(ownerUserId, preview.planId) : undefined
  let structuredData: { jsonLd: readonly Readonly<Record<string, unknown>>[], gaps: readonly { type: 'missing_author' | 'missing_publisher', briefId?: number }[] } | null = null
  try {
    const origin = new URL(preview.targetOrigin)
    if (origin.protocol === 'https:' && !origin.username && !origin.password) {
      structuredData = await composeContentStructuredData({ ownerUserId, draftId: parsed.data.draftId, siteOrigin: origin.origin })
    }
  } catch {
    structuredData = null
  }
  return { mode: 'preview_only', preview, plan, warning: 'No WordPress, CMS, or generic HTTP request was sent. Publishing remains disabled in V1.', structuredData }
})

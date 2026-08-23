import { z } from 'zod'
import { getOwnerDatabaseUserId } from '../../audit/repository'
import { createContentJob } from '../../seo-geo-core/repository'
import { requireOwner } from '../../utils/auth'

const inputSchema = z.object({
  briefId: z.number().int().positive(),
  operation: z.enum(['autogeo_recommendation', 'content_draft', 'risk_scan', 'delivery_preview', 'delivery_publish']),
  providerMode: z.enum(['reference_rules', 'autogeo_bailian_qwen', 'autogeo_api', 'manual']),
  idempotencyKey: z.string().trim().min(12).max(128),
})

export default defineEventHandler(async event => {
  const owner = await requireOwner(event)
  const parsed = inputSchema.safeParse(await readBody(event))
  if (!parsed.success) throw createError({ statusCode: 422, statusMessage: 'Review the content job fields.', data: parsed.error.flatten().fieldErrors })
  return createContentJob({ ownerUserId: await getOwnerDatabaseUserId(owner.openId), ...parsed.data })
})

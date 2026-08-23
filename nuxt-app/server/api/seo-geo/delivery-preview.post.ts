import { z } from 'zod'
import { getOwnerDatabaseUserId } from '../../audit/repository'
import { prepareDeliveryPreview } from '../../seo-geo-core/repository'
import { requireOwner } from '../../utils/auth'

const inputSchema = z.object({ jobId: z.number().int().positive(), draftId: z.number().int().positive(), targetId: z.number().int().positive(), idempotencyKey: z.string().trim().min(12).max(180) })

export default defineEventHandler(async event => {
  const owner = await requireOwner(event)
  const parsed = inputSchema.safeParse(await readBody(event))
  if (!parsed.success) throw createError({ statusCode: 422, statusMessage: 'Review the delivery preview fields.', data: parsed.error.flatten().fieldErrors })
  const preview = await prepareDeliveryPreview({ ownerUserId: await getOwnerDatabaseUserId(owner.openId), ...parsed.data })
  return { mode: 'preview_only', preview, warning: 'No WordPress, CMS, or generic HTTP request was sent. Publishing remains disabled in V1.' }
})

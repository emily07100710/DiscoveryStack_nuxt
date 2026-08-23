import { z } from 'zod'
import { getOwnerDatabaseUserId } from '../../audit/repository'
import { runOwnerAutoGeoContentJob } from '../../seo-geo-core/service'
import { requireOwner } from '../../utils/auth'

const inputSchema = z.object({ briefId: z.number().int().positive(), idempotencyKey: z.string().trim().min(12).max(180), document: z.object({ title: z.string().trim().min(1).max(180), content: z.string().trim().min(1).max(12000), language: z.enum(['en', 'zh-hant']) }) })

export default defineEventHandler(async event => {
  const owner = await requireOwner(event)
  const parsed = inputSchema.safeParse(await readBody(event))
  if (!parsed.success) throw createError({ statusCode: 422, statusMessage: 'Review the content job fields.', data: parsed.error.flatten().fieldErrors })
  return runOwnerAutoGeoContentJob({ ownerUserId: await getOwnerDatabaseUserId(owner.openId), ...parsed.data })
})

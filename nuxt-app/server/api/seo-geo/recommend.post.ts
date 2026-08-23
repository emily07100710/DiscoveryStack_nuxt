import { z } from 'zod'
import { getOwnerDatabaseUserId } from '../../audit/repository'
import { runOwnerAutoGeoContentJob } from '../../seo-geo-core/service'
import { requireOwner } from '../../utils/auth'

const inputSchema = z.object({
  briefId: z.number().int().positive(),
  jobId: z.number().int().positive().optional(),
  title: z.string().trim().min(3).max(180),
  content: z.string().trim().min(40).max(12_000),
  language: z.enum(['en', 'zh-hant']),
  idempotencyKey: z.string().trim().min(12).max(128),
})

export default defineEventHandler(async event => {
  const owner = await requireOwner(event)
  const parsed = inputSchema.safeParse(await readBody(event))
  if (!parsed.success) throw createError({ statusCode: 422, statusMessage: 'Review the AutoGEO recommendation fields.', data: parsed.error.flatten().fieldErrors })
  const { briefId, jobId, idempotencyKey, ...document } = parsed.data
  return runOwnerAutoGeoContentJob({ ownerUserId: await getOwnerDatabaseUserId(owner.openId), briefId, jobId, document, idempotencyKey })
})

import { z } from 'zod'
import { getOwnerDatabaseUserId } from '../../audit/repository'
import { createEvidenceApproval } from '../../seo-geo-core/repository'
import { requireOwner } from '../../utils/auth'

const inputSchema = z.object({ sourceId: z.number().int().positive(), artifactId: z.number().int().positive().optional(), allowedFor: z.enum(['diagnosis', 'recommendation', 'content_draft']), reviewNote: z.string().trim().min(3).max(2000) })

export default defineEventHandler(async event => {
  const owner = await requireOwner(event)
  const parsed = inputSchema.safeParse(await readBody(event))
  if (!parsed.success) throw createError({ statusCode: 422, statusMessage: 'Review the evidence approval fields.', data: parsed.error.flatten().fieldErrors })
  return createEvidenceApproval({ ownerUserId: await getOwnerDatabaseUserId(owner.openId), ...parsed.data })
})

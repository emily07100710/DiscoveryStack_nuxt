import { z } from 'zod'
import { getOwnerDatabaseUserId } from '../../audit/repository'
import { assertSafeAuditTarget } from '../../audit/targetGuard'
import { runOwnerPublicDiagnosis } from '../../seo-geo-core/service'
import { requireOwner } from '../../utils/auth'

const inputSchema = z.object({ homepageUrl: z.string().trim().min(8).max(2048), sourceId: z.number().int().positive().optional(), auditRunId: z.number().int().positive().optional() })

export default defineEventHandler(async event => {
  const owner = await requireOwner(event)
  const parsed = inputSchema.safeParse(await readBody(event))
  if (!parsed.success) throw createError({ statusCode: 422, statusMessage: 'Provide a valid public homepage URL.', data: parsed.error.flatten().fieldErrors })
  let target
  try { target = assertSafeAuditTarget(parsed.data.homepageUrl) } catch (error) { throw createError({ statusCode: 422, statusMessage: error instanceof Error ? error.message : 'Invalid public homepage URL.' }) }
  return runOwnerPublicDiagnosis({ ownerUserId: await getOwnerDatabaseUserId(owner.openId), homepageUrl: target.normalizedUrl, sourceId: parsed.data.sourceId, auditRunId: parsed.data.auditRunId })
})

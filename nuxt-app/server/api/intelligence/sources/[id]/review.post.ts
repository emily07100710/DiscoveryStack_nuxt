import { z } from 'zod'
import { getOwnerDatabaseUserId } from '../../../../audit/repository'
import { rereviewOwnerPublicSource } from '../../../../public-intelligence/repository'
import { requireOwner } from '../../../../utils/auth'

const optionalUrl = z.string().url().max(2048).nullable().optional().default(null)
const inputSchema = z.object({ requestedUse: z.enum(['research_only', 'evaluation_candidate', 'training_candidate', 'blocked']), robotsStatus: z.enum(['unreviewed', 'reviewed_allow', 'reviewed_restrict', 'unavailable', 'not_applicable']), robotsUrl: optionalUrl, termsStatus: z.enum(['unreviewed', 'allows_research', 'allows_evaluation', 'allows_training', 'prohibits_automation', 'prohibits_training', 'unknown']), termsUrl: optionalUrl, licenceReference: z.string().trim().max(500).nullable().optional().default(null), copyrightRisk: z.enum(['unreviewed', 'low', 'medium', 'high', 'blocked']), piiStatus: z.enum(['unreviewed', 'none_detected', 'possible', 'restricted']), retentionUntil: z.string().datetime().nullable().optional().default(null), policyEvidence: z.record(z.string(), z.unknown()).default({}), reviewNote: z.string().trim().max(3000).nullable().optional().default(null) })
export default defineEventHandler(async (event) => {
  const owner = await requireOwner(event)
  const sourceId = z.coerce.number().int().positive().parse(getRouterParam(event, 'id'))
  const parsed = inputSchema.safeParse(await readBody(event))
  if (!parsed.success) throw createError({ statusCode: 422, statusMessage: 'Review the re-review fields.', data: parsed.error.flatten().fieldErrors })
  return rereviewOwnerPublicSource({ ownerUserId: await getOwnerDatabaseUserId(owner.openId), sourceId, requestedUse: parsed.data.requestedUse, policy: { ...parsed.data, retentionUntil: parsed.data.retentionUntil ? new Date(parsed.data.retentionUntil) : null } })
})

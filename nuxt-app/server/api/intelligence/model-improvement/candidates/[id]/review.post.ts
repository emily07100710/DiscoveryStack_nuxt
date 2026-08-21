import { z } from 'zod'
import { getOwnerDatabaseUserId } from '../../../../../audit/repository'
import { reviewModelImprovementCandidate } from '../../../../../model-improvement/pipeline'
import { seoGeoMultilabelSchema } from '../../../../../public-intelligence/seoGeoTaxonomy'
import { requireOwner } from '../../../../../utils/auth'

const inputSchema = z.discriminatedUnion('decision', [
  z.object({ decision: z.literal('rejected'), reviewNote: z.string().trim().min(8).max(3000), rightsConfirmed: z.boolean().optional().default(false) }),
  z.object({ decision: z.literal('approved'), reviewNote: z.string().trim().min(16).max(3000), rightsConfirmed: z.literal(true), labels: seoGeoMultilabelSchema }),
])

export default defineEventHandler(async (event) => {
  setHeader(event, 'cache-control', 'private, no-store, max-age=0')
  const owner = await requireOwner(event)
  const candidateId = Number(getRouterParam(event, 'id'))
  const parsed = inputSchema.safeParse(await readBody(event))
  if (!Number.isInteger(candidateId) || candidateId < 1 || !parsed.success) throw createError({ statusCode: 422, statusMessage: 'Review the candidate decision, rights confirmation and labels.' })
  return reviewModelImprovementCandidate({ ownerUserId: await getOwnerDatabaseUserId(owner.openId), candidateId, ...parsed.data })
})

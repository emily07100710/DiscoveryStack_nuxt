import { z } from 'zod'
import { getOwnerDatabaseUserId } from '../../../../../audit/repository'
import { getProductionPlanDetail, submitProductionDraftRevision } from '../../../../../seo-geo-core/repository'
import { requireOwner } from '../../../../../utils/auth'

const inputSchema = z.object({
  title: z.string().trim().min(3).max(500),
  body: z.string().trim().min(40).max(20000),
})

export default defineEventHandler(async event => {
  const owner = await requireOwner(event)
  const parsed = inputSchema.safeParse(await readBody(event))
  if (!parsed.success) throw createError({ statusCode: 422, statusMessage: 'Revision title and body are required.' })
  const planId = Number(getRouterParam(event, 'id'))
  const deliverableId = Number(getRouterParam(event, 'deliverableId'))
  if (!Number.isInteger(planId) || !Number.isInteger(deliverableId) || planId < 1 || deliverableId < 1) throw createError({ statusCode: 422, statusMessage: 'Invalid Production Plan or deliverable.' })
  const ownerUserId = await getOwnerDatabaseUserId(owner.openId)
  await submitProductionDraftRevision({ ownerUserId, planId, deliverableId, title: parsed.data.title, body: parsed.data.body })
  setHeader(event, 'cache-control', 'no-store')
  return { detail: await getProductionPlanDetail(ownerUserId, planId), revisionSubmitted: true }
})

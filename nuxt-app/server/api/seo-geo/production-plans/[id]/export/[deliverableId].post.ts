import { z } from 'zod'
import { getOwnerDatabaseUserId } from '../../../../../audit/repository'
import { exportProductionDraft } from '../../../../../seo-geo-core/repository'
import { requireOwner } from '../../../../../utils/auth'

const inputSchema = z.object({ format: z.enum(['markdown', 'json']) })

export default defineEventHandler(async event => {
  const owner = await requireOwner(event)
  const parsed = inputSchema.safeParse(await readBody(event))
  if (!parsed.success) throw createError({ statusCode: 422, statusMessage: 'Export format must be markdown or json.' })
  const planId = Number(getRouterParam(event, 'id'))
  const deliverableId = Number(getRouterParam(event, 'deliverableId'))
  if (!Number.isInteger(planId) || !Number.isInteger(deliverableId) || planId < 1 || deliverableId < 1) throw createError({ statusCode: 422, statusMessage: 'Invalid Production Plan or deliverable.' })
  const exported = await exportProductionDraft({ ownerUserId: await getOwnerDatabaseUserId(owner.openId), planId, deliverableId, format: parsed.data.format })
  setHeader(event, 'cache-control', 'no-store')
  setHeader(event, 'content-type', exported.contentType)
  setHeader(event, 'content-disposition', `attachment; filename="${exported.filename}"`)
  return exported.body
})

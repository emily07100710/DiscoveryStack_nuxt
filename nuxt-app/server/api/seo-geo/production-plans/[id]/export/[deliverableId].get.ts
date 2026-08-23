import { getOwnerDatabaseUserId } from '../../../../../audit/repository'
import { exportProductionDraft } from '../../../../../seo-geo-core/repository'
import { requireOwner } from '../../../../../utils/auth'

export default defineEventHandler(async event => {
  const owner = await requireOwner(event)
  const planId = Number(getRouterParam(event, 'id'))
  const deliverableId = Number(getRouterParam(event, 'deliverableId'))
  const format = getQuery(event).format === 'json' ? 'json' : 'markdown'
  if (!Number.isInteger(planId) || planId < 1 || !Number.isInteger(deliverableId) || deliverableId < 1) throw createError({ statusCode: 422, statusMessage: 'Production Plan or deliverable ID is invalid.' })
  const exported = await exportProductionDraft({ ownerUserId: await getOwnerDatabaseUserId(owner.openId), planId, deliverableId, format })
  setHeader(event, 'cache-control', 'no-store')
  setHeader(event, 'content-type', exported.contentType)
  setHeader(event, 'content-disposition', `attachment; filename="${exported.filename.replace(/"/gu, '')}"`)
  return exported.body
})

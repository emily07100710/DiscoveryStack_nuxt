import { z } from 'zod'
import { getOwnerDatabaseUserId, revokeWorkspaceTrainingConsent } from '../../../../audit/repository'
import { requireOwner } from '../../../../utils/auth'

export default defineEventHandler(async (event) => {
  const owner = await requireOwner(event)
  const parsed = z.coerce.number().int().positive().safeParse(getRouterParam(event, 'id'))
  if (!parsed.success) throw createError({ statusCode: 400, statusMessage: 'Invalid workspace id.' })
  const ownerUserId = await getOwnerDatabaseUserId(owner.openId)
  return revokeWorkspaceTrainingConsent({ ownerUserId, workspaceId: parsed.data })
})

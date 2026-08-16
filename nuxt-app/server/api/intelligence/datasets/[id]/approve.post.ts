import { z } from 'zod'
import { getOwnerDatabaseUserId } from '../../../../audit/repository'
import { approveOwnerPublicDatasetBuild } from '../../../../public-intelligence/repository'
import { requireOwner } from '../../../../utils/auth'

const inputSchema = z.object({ reviewNote: z.string().trim().min(16).max(3_000) })

export default defineEventHandler(async event => {
  const owner = await requireOwner(event)
  const datasetBuildId = Number(getRouterParam(event, 'id'))
  const parsed = inputSchema.safeParse(await readBody(event))
  if (!Number.isInteger(datasetBuildId) || datasetBuildId < 1 || !parsed.success) throw createError({ statusCode: 422, statusMessage: 'Record an explicit owner review note before approving this public training manifest.' })
  return approveOwnerPublicDatasetBuild({ ownerUserId: await getOwnerDatabaseUserId(owner.openId), datasetBuildId, reviewNote: parsed.data.reviewNote })
})

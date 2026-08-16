import { z } from 'zod'
import { getOwnerDatabaseUserId } from '../../audit/repository'
import { runSupervisedTraining } from '../../public-intelligence/training'
import { requireOwner } from '../../utils/auth'

const inputSchema = z.object({ mode: z.enum(['development', 'production']).default('development') })

export default defineEventHandler(async event => {
  const owner = await requireOwner(event)
  const parsed = inputSchema.safeParse(await readBody(event))
  if (!parsed.success) throw createError({ statusCode: 422, statusMessage: 'Choose a supported training mode.' })
  return runSupervisedTraining({ ownerUserId: await getOwnerDatabaseUserId(owner.openId), mode: parsed.data.mode })
})

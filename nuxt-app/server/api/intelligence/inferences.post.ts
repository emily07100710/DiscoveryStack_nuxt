import { z } from 'zod'
import { getOwnerDatabaseUserId } from '../../audit/repository'
import { requestSupervisedPrediction, runPublicBgeSimilarity, runPublicFrictionBaseline } from '../../public-intelligence/analysis'
import { runSupervisedTraining } from '../../public-intelligence/training'
import { requireOwner } from '../../utils/auth'

const inputSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('run_friction_baseline'), ingestionJobId: z.number().int().positive() }),
  z.object({ action: z.literal('run_bge_similarity'), ingestionJobIds: z.array(z.number().int().positive()).min(2).max(3) }),
  z.object({ action: z.literal('request_supervised_prediction') }),
  z.object({ action: z.literal('run_supervised_training'), mode: z.enum(['development', 'production']).default('development') }),
])

export default defineEventHandler(async (event) => {
  const owner = await requireOwner(event)
  const parsed = inputSchema.safeParse(await readBody(event))
  if (!parsed.success) throw createError({ statusCode: 422, statusMessage: 'Choose a supported private analysis action.' })
  const ownerUserId = await getOwnerDatabaseUserId(owner.openId)
  if (parsed.data.action === 'run_friction_baseline') return runPublicFrictionBaseline({ ownerUserId, ingestionJobId: parsed.data.ingestionJobId })
  if (parsed.data.action === 'run_bge_similarity') return runPublicBgeSimilarity({ ownerUserId, ingestionJobIds: parsed.data.ingestionJobIds })
  if (parsed.data.action === 'run_supervised_training') return runSupervisedTraining({ ownerUserId, mode: parsed.data.mode })
  return requestSupervisedPrediction({ ownerUserId })
})

import { z } from 'zod'
import { getOwnerDatabaseUserId } from '../../audit/repository'
import { registerGoogleColabLocalRun } from '../../public-intelligence/colab-local'
import { requireOwner } from '../../utils/auth'

const resultSchema = z.object({
  datasetBuildId: z.number().int().positive().default(1),
  manifestHash: z.string().regex(/^[a-f0-9]{64}$/i),
  datasetDigest: z.string().regex(/^[a-f0-9]{64}$/i),
  checkpointSha256: z.string().regex(/^[a-f0-9]{64}$/i),
  artifactStorage: z.enum(['owner_browser_download', 'owner_controlled_google_drive']).default('owner_browser_download'),
  baseModelId: z.literal('distilbert-base-multilingual-cased'),
  modelVersion: z.string().trim().min(1).max(120),
  metrics: z.record(z.string(), z.unknown()),
  smokeTest: z.object({ nonTrainingExampleCount: z.literal(5), passed: z.literal(true), taskHeads: z.array(z.string()).min(9).max(9) }),
  startedAt: z.string().datetime(),
  completedAt: z.string().datetime(),
})

export default defineEventHandler(async event => {
  const owner = await requireOwner(event)
  const parsed = resultSchema.safeParse(await readBody(event))
  if (!parsed.success) throw createError({ statusCode: 422, statusMessage: 'The Google Colab result receipt is incomplete or invalid.' })
  const { datasetBuildId, ...result } = parsed.data
  return registerGoogleColabLocalRun({ ownerUserId: await getOwnerDatabaseUserId(owner.openId), datasetBuildId, result })
})

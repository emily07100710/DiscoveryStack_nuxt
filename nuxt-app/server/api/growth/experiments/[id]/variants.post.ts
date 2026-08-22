import { eq } from 'drizzle-orm'
import { getDatabase } from '../../../../database'
import { growthExperimentVariants, growthExperiments } from '../../../../database/schema'
import { requireOwner } from '../../../../utils/auth'

export default defineEventHandler(async (event) => {
  await requireOwner(event)
  const experimentId = Number(event.context.params?.id)
  const body = await readBody<{ variantType?: 'control' | 'candidate', contentHash?: string, artifactStorageKey?: string }>(event)
  if (!Number.isInteger(experimentId) || !['control', 'candidate'].includes(body?.variantType || '') || !/^[a-f0-9]{32,128}$/i.test(body?.contentHash || '')) throw createError({ statusCode: 422, statusMessage: 'A variant type and content hash are required; content text is never accepted.' })
  const database = getDatabase()
  if (!database) throw createError({ statusCode: 503, statusMessage: 'Growth research ledger is temporarily unavailable.' })
  const [experiment] = await database.select({ status: growthExperiments.status }).from(growthExperiments).where(eq(growthExperiments.id, experimentId)).limit(1)
  if (!experiment || ['revoked', 'rejected'].includes(experiment.status)) throw createError({ statusCode: 409, statusMessage: 'This experiment cannot accept variants.' })
  const result = await database.insert(growthExperimentVariants).values({ experimentId, variantType: body.variantType!, contentHash: body.contentHash!, artifactStorageKey: body.artifactStorageKey?.slice(0, 512) || null })
  return { id: Number(result[0].insertId) }
})

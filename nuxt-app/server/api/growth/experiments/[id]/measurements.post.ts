import { and, eq } from 'drizzle-orm'
import { getDatabase } from '../../../../database'
import { growthExperimentVariants, growthExperiments, growthMeasurements } from '../../../../database/schema'
import { requireOwner } from '../../../../utils/auth'

const channels = ['google_search', 'google_ai_overview', 'chatgpt', 'gemini', 'perplexity', 'manual'] as const
const metrics = ['retrieval', 'rank', 'citation', 'visibility', 'geo_score', 'geu_score', 'conversion'] as const
const provenances = ['observed', 'imported', 'human_confirmed'] as const

export default defineEventHandler(async (event) => {
  await requireOwner(event)
  const experimentId = Number(event.context.params?.id)
  const body = await readBody<{ variantId?: number, channel?: typeof channels[number], metric?: typeof metrics[number], value?: number, provenance?: typeof provenances[number], observedAt?: string, windowStart?: string, windowEnd?: string }>(event)
  const observedAt = body?.observedAt ? new Date(body.observedAt) : null
  if (!Number.isInteger(experimentId) || !Number.isInteger(body?.variantId) || !channels.includes(body?.channel as typeof channels[number]) || !metrics.includes(body?.metric as typeof metrics[number]) || !provenances.includes(body?.provenance as typeof provenances[number]) || !Number.isFinite(body?.value) || !observedAt || Number.isNaN(observedAt.valueOf())) throw createError({ statusCode: 422, statusMessage: 'A valid, observed measurement is required.' })
  const database = getDatabase()
  if (!database) throw createError({ statusCode: 503, statusMessage: 'Growth research ledger is temporarily unavailable.' })
  const [experiment] = await database.select({ id: growthExperiments.id, status: growthExperiments.status }).from(growthExperiments).where(eq(growthExperiments.id, experimentId)).limit(1)
  const [variant] = await database.select({ id: growthExperimentVariants.id }).from(growthExperimentVariants).where(and(eq(growthExperimentVariants.id, body.variantId!), eq(growthExperimentVariants.experimentId, experimentId))).limit(1)
  if (!experiment || !variant || ['revoked', 'rejected'].includes(experiment.status)) throw createError({ statusCode: 409, statusMessage: 'This experiment cannot accept measurements.' })
  const parseOptionalDate = (raw?: string) => raw ? new Date(raw) : null
  const windowStart = parseOptionalDate(body.windowStart)
  const windowEnd = parseOptionalDate(body.windowEnd)
  if ((windowStart && Number.isNaN(windowStart.valueOf())) || (windowEnd && Number.isNaN(windowEnd.valueOf()))) throw createError({ statusCode: 422, statusMessage: 'Measurement windows must be valid dates.' })
  const result = await database.insert(growthMeasurements).values({ experimentId, variantId: variant.id, channel: body.channel!, metric: body.metric!, value: String(body.value), provenance: body.provenance!, observedAt, windowStart, windowEnd })
  return { id: Number(result[0].insertId) }
})

import { eq } from 'drizzle-orm'
import { getDatabase } from '../../../../database'
import { growthResearchIntakes } from '../../../../database/schema'
import { requireOwner } from '../../../../utils/auth'

export default defineEventHandler(async (event) => {
  await requireOwner(event)
  const intakeId = Number(event.context.params?.id)
  const body = await readBody<{ status?: 'approved' | 'rejected', ownerReviewNote?: string }>(event)
  if (!Number.isInteger(intakeId) || !['approved', 'rejected'].includes(body?.status || '')) throw createError({ statusCode: 422, statusMessage: 'A valid intake review decision is required.' })
  const database = getDatabase()
  if (!database) throw createError({ statusCode: 503, statusMessage: 'Growth research ledger is temporarily unavailable.' })
  const result = await database.update(growthResearchIntakes).set({ status: body.status!, ownerReviewNote: (body.ownerReviewNote || '').slice(0, 4000) || null, reviewedAt: new Date() }).where(eq(growthResearchIntakes.id, intakeId))
  if (!result[0].affectedRows) throw createError({ statusCode: 404, statusMessage: 'Growth intake was not found.' })
  return { ok: true }
})

import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { getDatabase } from '../../database'
import { leads } from '../../database/schema'
import { requireOwner } from '../../utils/auth'

const bodySchema = z.object({ status: z.enum(['new', 'contacted', 'qualified', 'closed']) })

export default defineEventHandler(async (event) => {
  setHeader(event, 'cache-control', 'private, no-store, max-age=0')
  await requireOwner(event)
  const leadId = Number(getRouterParam(event, 'id'))
  const parsed = bodySchema.safeParse(await readBody(event))
  if (!Number.isInteger(leadId) || leadId < 1 || !parsed.success) throw createError({ statusCode: 422, statusMessage: 'Choose a valid lead and status.' })
  const database = getDatabase()
  if (!database) throw createError({ statusCode: 503, statusMessage: 'Lead administration is temporarily unavailable.' })
  await database.update(leads).set({ status: parsed.data.status }).where(eq(leads.id, leadId))
  return { updated: true, id: leadId, status: parsed.data.status }
})

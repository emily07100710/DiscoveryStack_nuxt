import { desc, eq } from 'drizzle-orm'
import { z } from 'zod'
import { getDatabase } from '../database'
import { leads } from '../database/schema'
import { requireOwner } from '../utils/auth'

const querySchema = z.object({
  status: z.enum(['new', 'contacted', 'qualified', 'closed']).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
})

export default defineEventHandler(async (event) => {
  setHeader(event, 'cache-control', 'private, no-store, max-age=0')
  await requireOwner(event)
  const database = getDatabase()
  if (!database) throw createError({ statusCode: 503, statusMessage: 'Lead administration is temporarily unavailable.' })
  const parsed = querySchema.safeParse(getQuery(event))
  if (!parsed.success) throw createError({ statusCode: 422, statusMessage: 'Choose a valid lead filter.' })
  const selection = {
    id: leads.id,
    name: leads.name,
    email: leads.email,
    company: leads.company,
    website: leads.website,
    packageInterest: leads.packageInterest,
    language: leads.language,
    message: leads.message,
    recontactConsent: leads.recontactConsent,
    modelImprovementConsent: leads.modelImprovementConsent,
    status: leads.status,
    createdAt: leads.createdAt,
  }
  const query = database.select(selection).from(leads)
  const rows = parsed.data.status
    ? await query.where(eq(leads.status, parsed.data.status)).orderBy(desc(leads.createdAt)).limit(parsed.data.limit)
    : await query.orderBy(desc(leads.createdAt)).limit(parsed.data.limit)
  return { leads: rows }
})

import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { getDatabase } from '../../database'
import { leads } from '../../database/schema'
import { getOwnerDatabaseUserId } from '../../audit/repository'
import { revokeLeadModelImprovementConsent } from '../../model-improvement/pipeline'
import { requireOwner } from '../../utils/auth'

const bodySchema = z.object({
  status: z.enum(['new', 'contacted', 'qualified', 'closed']).optional(),
  revokeModelImprovementConsent: z.literal(true).optional(),
}).refine(input => input.status || input.revokeModelImprovementConsent, { message: 'Choose a lead update.' })

export default defineEventHandler(async (event) => {
  setHeader(event, 'cache-control', 'private, no-store, max-age=0')
  const owner = await requireOwner(event)
  const leadId = Number(getRouterParam(event, 'id'))
  const parsed = bodySchema.safeParse(await readBody(event))
  if (!Number.isInteger(leadId) || leadId < 1 || !parsed.success) throw createError({ statusCode: 422, statusMessage: 'Choose a valid lead and status.' })
  const database = getDatabase()
  if (!database) throw createError({ statusCode: 503, statusMessage: 'Lead administration is temporarily unavailable.' })
  if (parsed.data.status) await database.update(leads).set({ status: parsed.data.status }).where(eq(leads.id, leadId))
  const revocation = parsed.data.revokeModelImprovementConsent
    ? await revokeLeadModelImprovementConsent({ ownerUserId: await getOwnerDatabaseUserId(owner.openId), leadId })
    : null
  return { updated: true, id: leadId, status: parsed.data.status, revocation }
})

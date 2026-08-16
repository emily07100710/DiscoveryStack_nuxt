import { storeLead } from '../utils/lead'
import { leadInputSchema } from '../utils/leadInput'

export default defineEventHandler(async (event) => {
  setHeader(event, 'cache-control', 'no-store')
  const parsed = leadInputSchema.safeParse(await readBody(event))
  if (!parsed.success) throw createError({ statusCode: 422, statusMessage: 'Please review the required fields.', data: parsed.error.flatten().fieldErrors })
  // Honeypot bots receive the same safe acknowledgement without persisting a record.
  if (parsed.data.companyFax) return { received: true, duplicate: false }
  return storeLead(event, parsed.data)
})

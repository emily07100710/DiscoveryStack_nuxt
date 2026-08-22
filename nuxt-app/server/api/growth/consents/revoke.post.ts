import { createHash } from 'node:crypto'
import { revokeGrowthResearchConsent } from '../../../growth/ledger'
import { requireOwner } from '../../../utils/auth'

export default defineEventHandler(async (event) => {
  const owner = await requireOwner(event)
  const body = await readBody<{ leadId?: number }>(event)
  if (!Number.isInteger(body?.leadId) || !body.leadId || body.leadId < 1) throw createError({ statusCode: 422, statusMessage: 'A valid lead reference is required.' })
  const requestFingerprintHash = createHash('sha256').update(`owner-revoke:${owner.openId}:${body.leadId}`).digest('hex')
  return revokeGrowthResearchConsent({ ownerUserId: 0, leadId: body.leadId, requestFingerprintHash })
})

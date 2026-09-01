import { createError, getRouterParam } from 'h3'
import { getOwnerDatabaseUserId } from '../../../audit/repository'
import { getScanStatus, listScanFindings } from '../../../site-evidence'
import { requireOwner } from '../../../utils/auth'

function scanId(event: Parameters<typeof getRouterParam>[0]): number {
  const value = getRouterParam(event, 'id')
  if (!value || !/^\d+$/u.test(value)) throw createError({ statusCode: 422, statusMessage: 'Scan id must be a positive integer.' })
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw createError({ statusCode: 422, statusMessage: 'Scan id must be a positive integer.' })
  return parsed
}

export default defineEventHandler(async event => {
  const owner = await requireOwner(event)
  const ownerUserId = await getOwnerDatabaseUserId(owner.openId)
  const id = scanId(event)
  const [scan, findings] = await Promise.all([getScanStatus(id, ownerUserId), listScanFindings(id, ownerUserId)])
  return { scan, findings }
})

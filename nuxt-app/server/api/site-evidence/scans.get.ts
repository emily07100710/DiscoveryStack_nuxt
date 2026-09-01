import { createError, getQuery } from 'h3'
import { getOwnerDatabaseUserId } from '../../audit/repository'
import { listScans } from '../../site-evidence'
import { requireOwner } from '../../utils/auth'

function optionalInteger(value: unknown, name: string): number | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || !/^\d+$/u.test(value)) throw createError({ statusCode: 422, statusMessage: `${name} must be a positive integer.` })
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw createError({ statusCode: 422, statusMessage: `${name} must be a positive integer.` })
  return parsed
}

export default defineEventHandler(async event => {
  const owner = await requireOwner(event)
  const ownerUserId = await getOwnerDatabaseUserId(owner.openId)
  const limit = optionalInteger(getQuery(event).limit, 'limit')
  return { scans: await listScans(ownerUserId, limit) }
})

import { createError, getQuery, getRouterParam } from 'h3'
import { getOwnerDatabaseUserId } from '../../../../audit/repository'
import { listScanUrls } from '../../../../site-evidence'
import { requireOwner } from '../../../../utils/auth'

function scanId(event: Parameters<typeof getRouterParam>[0]): number {
  const value = getRouterParam(event, 'id')
  if (!value || !/^\d+$/u.test(value)) throw createError({ statusCode: 422, statusMessage: 'Scan id must be a positive integer.' })
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw createError({ statusCode: 422, statusMessage: 'Scan id must be a positive integer.' })
  return parsed
}

function optionalInteger(value: unknown, name: string, minimum: number): number | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || !/^\d+$/u.test(value)) throw createError({ statusCode: 422, statusMessage: `${name} must be a non-negative integer.` })
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < minimum) throw createError({ statusCode: 422, statusMessage: `${name} must be a non-negative integer.` })
  return parsed
}

export default defineEventHandler(async event => {
  const owner = await requireOwner(event)
  const ownerUserId = await getOwnerDatabaseUserId(owner.openId)
  const query = getQuery(event)
  return listScanUrls(scanId(event), ownerUserId, { limit: optionalInteger(query.limit, 'limit', 1), offset: optionalInteger(query.offset, 'offset', 0) })
})

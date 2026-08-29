import { createError, getRequestHeader, getRequestURL, readBody, setResponseHeaders, type H3Event } from 'h3'
import { getOwnerDatabaseUserId } from '../audit/repository'
import { requireOwner } from '../utils/auth'

export function privateSystemFactoryHeaders(event: H3Event): void {
  setResponseHeaders(event, { 'cache-control': 'private, no-store, max-age=0', 'x-robots-tag': 'noindex, nofollow, noarchive', 'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff' })
}

export async function systemFactoryOwnerContext(event: H3Event, mutation = false): Promise<{ ownerUserId: number }> {
  privateSystemFactoryHeaders(event)
  if (mutation) assertSameOriginMutation(event)
  const owner = await requireOwner(event)
  return { ownerUserId: await getOwnerDatabaseUserId(owner.openId) }
}

export function assertSameOriginMutation(event: H3Event): void {
  const origin = getRequestHeader(event, 'origin') || ''
  const configured = process.env.NUXT_DISCOVERYSTACK_PRIVATE_ORIGIN || ''
  const expected = configured ? (() => { try { return new URL(configured).origin } catch { throw createError({ statusCode: 503, statusMessage: 'Private system-factory origin is not configured correctly.' }) } })() : getRequestURL(event).origin
  if (!origin || (() => { try { return new URL(origin).origin } catch { return '' } })() !== expected) throw createError({ statusCode: 403, statusMessage: 'System-factory mutation requires an exact same-origin request.' })
  const fetchSite = getRequestHeader(event, 'sec-fetch-site')
  if (fetchSite && fetchSite !== 'same-origin') throw createError({ statusCode: 403, statusMessage: 'Cross-site system-factory mutation is not allowed.' })
}

export async function strictSystemFactoryBody(event: H3Event, allowed: readonly string[]): Promise<Record<string, unknown>> {
  const body = await readBody(event)
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.getPrototypeOf(body) !== Object.prototype || Object.keys(body).some(key => !allowed.includes(key))) throw createError({ statusCode: 422, statusMessage: 'System-factory request contains missing or unknown fields.' })
  return body as Record<string, unknown>
}

export function boundedPage(value: unknown): { limit: number; offset: number } {
  const input = value && typeof value === 'object' ? value as Record<string, unknown> : {}
  const limit = Number(input.limit ?? 50); const offset = Number(input.offset ?? 0)
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 || !Number.isSafeInteger(offset) || offset < 0 || offset > 100_000) throw createError({ statusCode: 422, statusMessage: 'Pagination is outside the allowed bound.' })
  return { limit, offset }
}

export function boundedKeysetPage(value: unknown): { limit: number; cursor: { updatedAt: Date; id: number } | null } {
  const input = value && typeof value === 'object' ? value as Record<string, unknown> : {}
  const limit = Number(input.limit ?? 50); if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw createError({ statusCode: 422, statusMessage: 'Pagination is outside the allowed bound.' })
  if (input.offset !== undefined) throw createError({ statusCode: 422, statusMessage: 'System workspace pagination requires a stable cursor; offset is not accepted.' })
  if (input.cursor === undefined || input.cursor === '') return { limit, cursor: null }
  try {
    const decoded = JSON.parse(Buffer.from(String(input.cursor), 'base64url').toString('utf8')) as { updatedAt?: unknown; id?: unknown }
    const updatedAt = new Date(String(decoded.updatedAt || '')); const id = Number(decoded.id)
    if (!Number.isSafeInteger(id) || id < 1 || Number.isNaN(updatedAt.getTime()) || updatedAt.toISOString() !== decoded.updatedAt) throw new Error('invalid')
    return { limit, cursor: { updatedAt, id } }
  } catch { throw createError({ statusCode: 422, statusMessage: 'System workspace cursor is invalid.' }) }
}

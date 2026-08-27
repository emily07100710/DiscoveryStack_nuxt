import { eq } from 'drizzle-orm'
import { createError, getRequestHeader, readBody, setHeader, type H3Event } from 'h3'
import { fingerprint } from '../../geo-outcome-model/canonical'
import { MAX_REQUEST_BYTES } from '../../geo-outcome-model/constants'
import { getProductionGeoOutcomeRepository } from '../../geo-outcome-model'
import { getDatabase } from '../../database'
import { users } from '../../database/schema'
import { requireOwner } from '../../utils/auth'
import type { GeoOutcomeRepositoryPort } from '../../geo-outcome-model'

export function setGeoOutcomePrivateApiHeaders(event: H3Event) { setHeader(event, 'Cache-Control', 'private, no-store, max-age=0'); setHeader(event, 'X-Robots-Tag', 'noindex, nofollow, noarchive'); setHeader(event, 'Referrer-Policy', 'no-referrer'); setHeader(event, 'X-Content-Type-Options', 'nosniff') }
export async function requireGeoOutcomeOwner(event: H3Event): Promise<{ ownerUserId: number, openId: string }> { const session = await requireOwner(event); const database = getDatabase(); if (!database) throw createError({ statusCode: 503, statusMessage: 'GEO outcome model storage is not configured.' }); const [user] = await database.select({ id: users.id }).from(users).where(eq(users.openId, session.openId)).limit(1); if (!user) throw createError({ statusCode: 401, statusMessage: 'Owner user record is unavailable.' }); return { ownerUserId: user.id, openId: session.openId } }
export async function readGeoBody(event: H3Event): Promise<Record<string, unknown>> { const contentLength = Number(getRequestHeader(event, 'content-length') || 0); if (Number.isFinite(contentLength) && contentLength > MAX_REQUEST_BYTES) throw createError({ statusCode: 413, statusMessage: 'Request body exceeds the bounded GEO outcome limit.' }); const body = await readBody<unknown>(event); if (!body || typeof body !== 'object' || Array.isArray(body)) throw createError({ statusCode: 400, statusMessage: 'Request body must be an object.' }); return body as Record<string, unknown> }
export function strictKeys(body: Record<string, unknown>, allowed: readonly string[]) { for (const key of Object.keys(body)) if (!allowed.includes(key)) throw createError({ statusCode: 422, statusMessage: `Unknown request field: ${key}.` }) }
export function requiredIdempotency(body: Record<string, unknown>): string { if (typeof body.idempotencyKey !== 'string' || !/^[A-Za-z0-9._:-]{8,128}$/u.test(body.idempotencyKey)) throw createError({ statusCode: 422, statusMessage: 'A bounded idempotencyKey is required.' }); return body.idempotencyKey }
export async function withMutationIdempotency<T>(ownerUserId: number, route: string, idempotencyKey: string, input: unknown, action: (repository: GeoOutcomeRepositoryPort) => Promise<T> | T, repository?: GeoOutcomeRepositoryPort): Promise<T> {
  const repo = repository || getProductionGeoOutcomeRepository()
  const inputFingerprint = fingerprint(input)
  return repo.transaction(async transaction => {
    const claim = await transaction.claimMutation(ownerUserId, route, idempotencyKey, inputFingerprint)
    if (claim.outcome === 'collision') throw createError({ statusCode: 409, statusMessage: 'Idempotency collision: the key was used with a different request.' })
    if (claim.outcome === 'in_progress') throw createError({ statusCode: 409, statusMessage: 'The same mutation is already in progress.' })
    if (claim.outcome === 'replay') return claim.claim.responseProjection as T
    const response = await action(transaction)
    await transaction.completeMutation(ownerUserId, route, idempotencyKey, inputFingerprint, response)
    return response
  })
}
export function routeError(error: unknown): never { if (error && typeof error === 'object' && 'statusCode' in error) throw error; throw createError({ statusCode: 422, statusMessage: error instanceof Error ? error.message : 'GEO outcome request was rejected.' }) }

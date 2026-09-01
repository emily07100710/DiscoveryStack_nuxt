import { eq } from 'drizzle-orm'
import { createError, getRequestHeader, readBody, setHeader, type H3Event } from 'h3'
import { createKnowledgeService, DrizzleKnowledgeRepository } from '../../knowledge'
import { getDatabase } from '../../database'
import { users } from '../../database/schema'
import { requireOwner } from '../../utils/auth'
import type { KnowledgeResult } from '../../knowledge'

export const MAX_REQUEST_BYTES = 64 * 1024

export function setKnowledgePrivateApiHeaders(event: H3Event) { setHeader(event, 'Cache-Control', 'private, no-store, max-age=0'); setHeader(event, 'X-Robots-Tag', 'noindex, nofollow, noarchive'); setHeader(event, 'Referrer-Policy', 'no-referrer'); setHeader(event, 'X-Content-Type-Options', 'nosniff') }
export async function requireKnowledgeOwner(event: H3Event): Promise<{ ownerUserId: number, openId: string }> { const session = await requireOwner(event); const database = getDatabase(); if (!database) throw createError({ statusCode: 503, statusMessage: 'Knowledge storage is not configured.' }); const [user] = await database.select({ id: users.id }).from(users).where(eq(users.openId, session.openId)).limit(1); if (!user) throw createError({ statusCode: 401, statusMessage: 'Owner user record is unavailable.' }); return { ownerUserId: user.id, openId: session.openId } }
export function getKnowledgeService(ownerUserId: number) { return createKnowledgeService({ ownerUserId, repository: new DrizzleKnowledgeRepository() }) }
export async function readKnowledgeBody(event: H3Event): Promise<Record<string, unknown>> { const contentLength = Number(getRequestHeader(event, 'content-length') || 0); if (Number.isFinite(contentLength) && contentLength > MAX_REQUEST_BYTES) throw createError({ statusCode: 413, statusMessage: 'Request body exceeds the bounded knowledge limit.' }); const body = await readBody<unknown>(event); if (!body || typeof body !== 'object' || Array.isArray(body)) throw createError({ statusCode: 400, statusMessage: 'Request body must be an object.' }); return body as Record<string, unknown> }
export function strictKeys(body: Record<string, unknown>, allowed: readonly string[]) { for (const key of Object.keys(body)) if (!allowed.includes(key)) throw createError({ statusCode: 422, statusMessage: `Unknown request field: ${key}.` }) }
export function positiveId(value: string | undefined, label = 'id'): number { const id = Number(value); if (!Number.isSafeInteger(id) || id <= 0) throw createError({ statusCode: 422, statusMessage: `${label} must be a positive integer.` }); return id }
export function knowledgeValue<T>(result: KnowledgeResult<T>): T { if (result.status === 'ok') return result.value; throw createError({ statusCode: 422, statusMessage: `${result.code}: ${result.reason}` }) }
export function routeError(error: unknown): never { if (error && typeof error === 'object' && 'statusCode' in error) throw error; throw createError({ statusCode: 422, statusMessage: error instanceof Error ? error.message : 'Knowledge request was rejected.' }) }

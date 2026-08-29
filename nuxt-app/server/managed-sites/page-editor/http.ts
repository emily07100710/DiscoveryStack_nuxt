import type { H3Event } from 'h3'
import { createError, getHeader, getRequestURL, readBody, setHeader } from 'h3'
import { requireManagedSiteCustomer } from '../auth'
import { roleAllows } from '../types'
import type { MediaActor } from '../media-vault/types'
import type { PageActor } from './types'

export function setEditorPrivateHeaders(event: H3Event): void { setHeader(event, 'Cache-Control', 'private, no-store, max-age=0'); setHeader(event, 'Pragma', 'no-cache'); setHeader(event, 'Referrer-Policy', 'no-referrer'); setHeader(event, 'X-Content-Type-Options', 'nosniff'); setHeader(event, 'X-Robots-Tag', 'noindex, nofollow, noarchive') }
export function assertEditorSameOrigin(event: H3Event): void {
  const fetchSite = getHeader(event, 'sec-fetch-site'); if (fetchSite === 'cross-site') throw createError({ statusCode: 403, statusMessage: 'Cross-site editor mutation is forbidden.' })
  const origin = getHeader(event, 'origin'); const expected = getRequestURL(event).origin
  if (!origin || origin !== expected) throw createError({ statusCode: 403, statusMessage: 'Editor mutation requires an exact same-origin request.' })
}
export async function readBoundedEditorBody(event: H3Event, maxBytes = 1_000_000): Promise<unknown> { const length = Number(getHeader(event, 'content-length') || 0); if (length > maxBytes) throw createError({ statusCode: 413, statusMessage: 'Editor request body is too large.' }); const body = await readBody(event); let measured = 0; try { measured = Buffer.byteLength(JSON.stringify(body), 'utf8') } catch { throw createError({ statusCode: 422, statusMessage: 'Editor request body is not JSON-safe.' }) } if (measured > maxBytes) throw createError({ statusCode: 413, statusMessage: 'Editor request body is too large.' }); return body }
function mappedRole(role: string): PageActor['role'] { if (role === 'owner' || role === 'administrator') return 'customer_admin'; if (role === 'editor' || role === 'reviewer') return role === 'editor' ? 'editor' : 'viewer'; return 'viewer' }
export async function requireEditorActor(event: H3Event, permission: 'content:read' | 'content:write' | 'content:publish' = 'content:read'): Promise<{ access: Awaited<ReturnType<typeof requireManagedSiteCustomer>>; pageActor: PageActor; mediaActor: MediaActor }> {
  setEditorPrivateHeaders(event); const access = await requireManagedSiteCustomer(event); if (!roleAllows(access.membership.role, permission)) throw createError({ statusCode: 403, statusMessage: 'This managed-site role cannot perform the requested editor action.' }); if (permission !== 'content:read' && access.project.status === 'suspended') throw createError({ statusCode: 403, statusMessage: 'This managed site is suspended; editor mutations are disabled.' })
  const role = mappedRole(access.membership.role); const base = { ownerUserId: access.project.ownerUserId, projectId: access.project.id, actorUserId: access.membership.userId, authority: 'customer_session' as const, role }; return { access, pageActor: { ...base, canPublish: roleAllows(access.membership.role, 'content:publish') }, mediaActor: base }
}

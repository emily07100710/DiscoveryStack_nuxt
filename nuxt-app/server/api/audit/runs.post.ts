import { z } from 'zod'
import { AUDIT_ANALYZER_VERSION, defaultAuditScope } from '../../audit/types'
import { createManualAuditRun, getOwnerDatabaseUserId } from '../../audit/repository'
import { assertSafeAuditTarget } from '../../audit/targetGuard'
import { requireOwner } from '../../utils/auth'

const runInput = z.object({ workspaceId: z.number().int().positive(), targetUrl: z.string().trim().min(8).max(2048), authorizationConfirmed: z.literal(true) })

export default defineEventHandler(async (event) => {
  const owner = await requireOwner(event)
  const parsed = runInput.safeParse(await readBody(event))
  if (!parsed.success) throw createError({ statusCode: 422, statusMessage: 'Review the audit-run fields.', data: parsed.error.flatten().fieldErrors })
  let target
  try { target = assertSafeAuditTarget(parsed.data.targetUrl) } catch (error) { throw createError({ statusCode: 422, statusMessage: error instanceof Error ? error.message : 'Invalid audit target.' }) }
  const ownerUserId = await getOwnerDatabaseUserId(owner.openId)
  return createManualAuditRun({ workspaceId: parsed.data.workspaceId, ownerUserId, requestedUrl: target.normalizedUrl, scopePolicy: { ...defaultAuditScope, authorization: { confirmed: true, policyVersion: 'public-audit-consent-v1' as const } }, analyzerVersion: AUDIT_ANALYZER_VERSION })
})

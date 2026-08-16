import { completeManualAudit } from '../../audit/engine'
import { manualAuditInput } from '../../audit/manual'
import { getOwnerDatabaseUserId } from '../../audit/repository'
import { assertSafeAuditTarget } from '../../audit/targetGuard'
import { requireOwner } from '../../utils/auth'

export default defineEventHandler(async (event) => {
  const owner = await requireOwner(event)
  const parsed = manualAuditInput.safeParse(await readBody(event))
  if (!parsed.success) throw createError({ statusCode: 422, statusMessage: 'Review the manual observations.', data: parsed.error.flatten().fieldErrors })
  let target
  try { target = assertSafeAuditTarget(parsed.data.targetUrl) } catch (error) { throw createError({ statusCode: 422, statusMessage: error instanceof Error ? error.message : 'Invalid audit target.' }) }
  const ownerUserId = await getOwnerDatabaseUserId(owner.openId)
  return completeManualAudit({ ownerUserId, workspaceId: parsed.data.workspaceId, targetUrl: target.normalizedUrl, signals: parsed.data.observations.map(item => ({ key: item.key, value: item.value, evidenceNote: item.evidenceNote })) })
})

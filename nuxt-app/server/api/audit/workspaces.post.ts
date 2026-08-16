import { z } from 'zod'
import { createOwnerAuditWorkspace, getOwnerDatabaseUserId } from '../../audit/repository'
import { assertSafeAuditTarget } from '../../audit/targetGuard'
import { requireOwner } from '../../utils/auth'

const workspaceInput = z.object({
  displayName: z.string().trim().min(2).max(160),
  targetUrl: z.string().trim().min(8).max(2048),
  language: z.enum(['en', 'zh-hant']),
  publicAuditAuthorization: z.literal(true),
  trainingConsent: z.boolean(),
})

export default defineEventHandler(async (event) => {
  const owner = await requireOwner(event)
  const parsed = workspaceInput.safeParse(await readBody(event))
  if (!parsed.success) throw createError({ statusCode: 422, statusMessage: 'Review the workspace fields.', data: parsed.error.flatten().fieldErrors })
  let target
  try { target = assertSafeAuditTarget(parsed.data.targetUrl) } catch (error) { throw createError({ statusCode: 422, statusMessage: error instanceof Error ? error.message : 'Invalid audit target.' }) }
  const ownerUserId = await getOwnerDatabaseUserId(owner.openId)
  const workspace = await createOwnerAuditWorkspace({ ownerUserId, displayName: parsed.data.displayName, targetDomain: target.hostname, language: parsed.data.language, publicAuditAuthorization: true, trainingConsent: parsed.data.trainingConsent })
  return { workspace, target: { normalizedUrl: target.normalizedUrl, hostname: target.hostname }, crawlerStarted: false, notice: 'Workspace saved. No crawl has been started; add a human-reviewed public observation before creating an audit run.' }
})

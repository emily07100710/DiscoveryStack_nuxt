import { z } from 'zod'
import { getOwnerDatabaseUserId } from '../../audit/repository'
import { createOwnerPublicArtifact } from '../../public-intelligence/repository'
import { assertSafeAuditTarget } from '../../audit/targetGuard'
import { requireOwner } from '../../utils/auth'
import { publicArtifactInputSchema } from '../../public-intelligence/featureContract'

export default defineEventHandler(async (event) => {
  const owner = await requireOwner(event)
  const parsed = publicArtifactInputSchema.safeParse(await readBody(event))
  if (!parsed.success) throw createError({ statusCode: 422, statusMessage: 'Review the artifact fields.', data: parsed.error.flatten().fieldErrors })
  let safeSource
  try { safeSource = assertSafeAuditTarget(parsed.data.sourceUrl) } catch (error) { throw createError({ statusCode: 422, statusMessage: error instanceof Error ? error.message : 'Invalid artifact source URL.' }) }
  return createOwnerPublicArtifact({ ...parsed.data, ownerUserId: await getOwnerDatabaseUserId(owner.openId), sourceUrl: safeSource.normalizedUrl, retentionUntil: parsed.data.retentionUntil ? new Date(parsed.data.retentionUntil) : null })
})

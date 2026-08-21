import { z } from 'zod'
import { getOwnerDatabaseUserId } from '../../../../audit/repository'
import { reviewOwnerPublicArtifact } from '../../../../public-intelligence/repository'
import { requireOwner } from '../../../../utils/auth'

const inputSchema = z.object({
  qualityStatus: z.enum(['passed', 'needs_revision', 'rejected']),
  qualityNote: z.string().trim().max(3000).nullable().optional().default(null),
})

export default defineEventHandler(async (event) => {
  const owner = await requireOwner(event)
  const artifactId = z.coerce.number().int().positive().parse(getRouterParam(event, 'id'))
  const parsed = inputSchema.safeParse(await readBody(event))
  if (!parsed.success) throw createError({ statusCode: 422, statusMessage: 'Review the artifact quality fields.' })

  try {
    return await reviewOwnerPublicArtifact({
      ownerUserId: await getOwnerDatabaseUserId(owner.openId),
      artifactId,
      qualityStatus: parsed.data.qualityStatus,
      qualityNote: parsed.data.qualityNote,
    })
  } catch (error) {
    const failure = error as { statusCode?: number }
    if (failure.statusCode && failure.statusCode < 500) throw error
    console.error('[audit-quality-review] persistence failed', {
      artifactId,
      statusCode: failure.statusCode ?? 500,
      errorType: error instanceof Error ? error.name : typeof error,
    })
    throw createError({
      statusCode: 500,
      statusMessage: '產物品質審核暫時無法儲存；已記錄系統錯誤供修復。',
    })
  }
})

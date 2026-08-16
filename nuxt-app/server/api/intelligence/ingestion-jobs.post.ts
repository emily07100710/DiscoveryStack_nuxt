import { z } from 'zod'
import { getOwnerDatabaseUserId } from '../../audit/repository'
import { requireOwner } from '../../utils/auth'
import { ingestApprovedPublicDocument } from '../../public-intelligence/ingestion-repository'
import { crawlApprovedPublicSite } from '../../public-intelligence/crawl-repository'

const inputSchema = z.object({ mode: z.enum(['document', 'site']).default('document'), sourceId: z.number().int().positive(), requestedUrl: z.string().trim().url().max(2048), maxPages: z.number().int().min(1).max(10).optional(), maxDepth: z.number().int().min(0).max(2).optional() })

export default defineEventHandler(async (event) => {
  const owner = await requireOwner(event)
  const parsed = inputSchema.safeParse(await readBody(event))
  if (!parsed.success) throw createError({ statusCode: 422, statusMessage: 'Choose an approved Source Card and a valid public document URL.' })
  const ownerUserId = await getOwnerDatabaseUserId(owner.openId)
  if (parsed.data.mode === 'site') return crawlApprovedPublicSite({ ownerUserId, sourceId: parsed.data.sourceId, requestedUrl: parsed.data.requestedUrl, maxPages: parsed.data.maxPages, maxDepth: parsed.data.maxDepth })
  return ingestApprovedPublicDocument({ ownerUserId, sourceId: parsed.data.sourceId, requestedUrl: parsed.data.requestedUrl })
})

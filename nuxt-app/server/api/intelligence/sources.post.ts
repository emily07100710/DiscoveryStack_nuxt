import { z } from 'zod'
import { getOwnerDatabaseUserId } from '../../audit/repository'
import { createOwnerPublicSource } from '../../public-intelligence/repository'
import { assertSafeAuditTarget } from '../../audit/targetGuard'
import { requireOwner } from '../../utils/auth'

const optionalUrl = z.string().url().max(2048).nullable().optional().default(null)
const sourceInput = z.object({
  sourceType: z.enum(['website', 'api', 'dataset', 'publication', 'document']), sourceUrl: z.string().url().max(2048), canonicalUrl: optionalUrl, sourceName: z.string().trim().min(2).max(300), language: z.string().trim().max(24).nullable().optional().default(null), region: z.string().trim().max(80).nullable().optional().default(null), discoveryMethod: z.enum(['owner_research', 'public_search', 'api_catalogue', 'licensed_import']), robotsStatus: z.enum(['unreviewed', 'reviewed_allow', 'reviewed_restrict', 'unavailable', 'not_applicable']), robotsUrl: optionalUrl, termsStatus: z.enum(['unreviewed', 'allows_research', 'allows_evaluation', 'allows_training', 'prohibits_automation', 'prohibits_training', 'unknown']), termsUrl: optionalUrl, licenceReference: z.string().trim().max(500).nullable().optional().default(null), copyrightRisk: z.enum(['unreviewed', 'low', 'medium', 'high', 'blocked']), piiStatus: z.enum(['unreviewed', 'none_detected', 'possible', 'restricted']), retentionUntil: z.string().datetime().nullable().optional().default(null), policyEvidence: z.record(z.string(), z.unknown()).default({}), reviewNote: z.string().trim().max(3000).nullable().optional().default(null),
})

export default defineEventHandler(async (event) => {
  const owner = await requireOwner(event)
  const parsed = sourceInput.safeParse(await readBody(event))
  if (!parsed.success) throw createError({ statusCode: 422, statusMessage: 'Review the Source Card fields.', data: parsed.error.flatten().fieldErrors })
  let safeSource
  try { safeSource = assertSafeAuditTarget(parsed.data.sourceUrl) } catch (error) { throw createError({ statusCode: 422, statusMessage: error instanceof Error ? error.message : 'Invalid public source URL.' }) }
  const ownerUserId = await getOwnerDatabaseUserId(owner.openId)
  return createOwnerPublicSource({ ...parsed.data, ownerUserId, sourceUrl: safeSource.normalizedUrl, canonicalUrl: parsed.data.canonicalUrl, domain: safeSource.hostname, retentionUntil: parsed.data.retentionUntil ? new Date(parsed.data.retentionUntil) : null })
})

import { eq } from 'drizzle-orm'
import { getDatabase } from '../../database'
import { growthExperiments, growthResearchIntakes } from '../../database/schema'
import { requireOwner } from '../../utils/auth'

export default defineEventHandler(async (event) => {
  await requireOwner(event)
  const body = await readBody<{ intakeId?: number, sourceUrl?: string, sourceContentHash?: string, locale?: 'en' | 'zh-hant', targetEngine?: string, queryFingerprint?: string, rewriteMode?: 'manual' | 'autogeo_api' | 'autogeo_mini', modelId?: string, modelRevision?: string, ruleRevision?: string, datasetRevision?: string }>(event)
  if (!Number.isInteger(body?.intakeId) || !body.sourceUrl || !/^[a-f0-9]{32,128}$/i.test(body.sourceContentHash || '') || !/^[a-f0-9]{32,128}$/i.test(body.queryFingerprint || '') || !body.targetEngine || !['en', 'zh-hant'].includes(body.locale || '') || !['manual', 'autogeo_api', 'autogeo_mini'].includes(body.rewriteMode || '')) throw createError({ statusCode: 422, statusMessage: 'A reviewed intake and complete hash-only experiment lineage are required.' })
  const database = getDatabase()
  if (!database) throw createError({ statusCode: 503, statusMessage: 'Growth research ledger is temporarily unavailable.' })
  const [intake] = await database.select({ status: growthResearchIntakes.status }).from(growthResearchIntakes).where(eq(growthResearchIntakes.id, body.intakeId!)).limit(1)
  if (intake?.status !== 'approved') throw createError({ statusCode: 409, statusMessage: 'Experiments require an approved, non-revoked intake.' })
  const result = await database.insert(growthExperiments).values({ intakeId: body.intakeId!, sourceUrl: body.sourceUrl.slice(0, 2048), sourceContentHash: body.sourceContentHash!, locale: body.locale!, targetEngine: body.targetEngine.slice(0, 80), queryFingerprint: body.queryFingerprint!, rewriteMode: body.rewriteMode!, modelId: body.modelId?.slice(0, 240) || null, modelRevision: body.modelRevision?.slice(0, 128) || null, ruleRevision: body.ruleRevision?.slice(0, 128) || null, datasetRevision: body.datasetRevision?.slice(0, 128) || null, status: 'draft', autoPublish: false })
  return { id: Number(result[0].insertId), status: 'draft', autoPublish: false }
})

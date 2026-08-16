import { z } from 'zod'
import { cosineSimilarity, embedDeidentifiedCandidates, type BgePilotCandidate } from '../../audit/huggingface'
import { BGE_M3_PILOT_MAX_CANDIDATES } from '../../audit/baselines'
import { getOwnerDatabaseUserId, listConsentTrainingCandidates } from '../../audit/repository'
import { getDatabase } from '../../database'
import { auditEvidenceLedger } from '../../database/schema'
import { requireOwner } from '../../utils/auth'

const inputSchema = z.object({ maxCandidates: z.number().int().min(2).max(BGE_M3_PILOT_MAX_CANDIDATES).default(BGE_M3_PILOT_MAX_CANDIDATES) })

export default defineEventHandler(async (event) => {
  const owner = await requireOwner(event)
  const parsed = inputSchema.safeParse(await readBody(event))
  if (!parsed.success) throw createError({ statusCode: 422, statusMessage: 'Invalid similarity pilot request.' })
  const ownerUserId = await getOwnerDatabaseUserId(owner.openId)
  const candidates = await listConsentTrainingCandidates(ownerUserId, parsed.data.maxCandidates) as BgePilotCandidate[]
  if (candidates.length < 2) throw createError({ statusCode: 409, statusMessage: 'At least two consented, quality-checked candidates are required before the similarity pilot can run.' })
  const embeddings = await embedDeidentifiedCandidates(candidates)
  const query = candidates[0]!
  const queryEmbedding = embeddings[0]!
  const matches = candidates.slice(1).map((candidate, index) => ({ trainingExampleId: candidate.id, labelStage: candidate.labelStage, similarity: Number(cosineSimilarity(queryEmbedding, embeddings[index + 1]!).toFixed(4)) })).sort((left, right) => right.similarity - left.similarity)
  const database = getDatabase()
  if (!database) throw createError({ statusCode: 503, statusMessage: 'Private Audit Lab is temporarily unavailable.' })
  await database.insert(auditEvidenceLedger).values({ auditRunId: query.auditRunId, stage: 'classification', claimKey: 'model.bge_m3.similarity_pilot', claimValue: JSON.stringify({ model: 'BAAI/bge-m3', candidateCount: candidates.length, output: 'similarity_ranking_only' }), provenance: 'inferred', observationIds: [], confidence: 0 })
  return { status: 'completed' as const, message: 'BGE-M3 completed a similarity ranking over de-identified, consented candidates. A strategist must review every result.', matches }
})

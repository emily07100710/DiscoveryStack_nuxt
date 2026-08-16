import { BGE_M3_MODEL_ID, BGE_M3_PILOT_MAX_CANDIDATES, BGE_M3_PILOT_MIN_CANDIDATES } from './baselines'
import type { TrainingFeatureVector } from './types'

export type BgePilotCandidate = { id: number, auditRunId: number, labelStage: string, labelDecision: string, featureVector: TrainingFeatureVector }

/** The only external payload is a compact, de-identified feature contract—never URLs, page text, company names, emails or outcomes. */
export function serialiseDeidentifiedFeature(candidate: BgePilotCandidate) {
  const vector = candidate.featureVector
  const signals = Object.entries(vector.binarySignalCounts).sort(([left], [right]) => left.localeCompare(right)).map(([key, count]) => `${key}:true=${count.true},false=${count.false},other=${count.other}`).join('; ')
  const assessments = vector.assessmentSnapshot.map(assessment => `${assessment.stage}:${assessment.status}:${assessment.score}`).join('; ')
  return [`contract=${vector.contractVersion}`, `language=${vector.language}`, `observation_count=${vector.observationCount}`, `page_count=${vector.distinctPageCount}`, `signals=${signals || 'none'}`, `assessment_snapshot=${assessments || 'none'}`, `human_stage=${candidate.labelStage}`, `human_decision=${candidate.labelDecision}`].join('\n')
}

export function cosineSimilarity(left: number[], right: number[]) {
  if (!left.length || left.length !== right.length) throw new Error('BGE-M3 vectors must have the same non-zero dimension.')
  const { dot, leftMagnitude, rightMagnitude } = left.reduce((state, value, index) => {
    const other = right[index] ?? 0
    return { dot: state.dot + value * other, leftMagnitude: state.leftMagnitude + value * value, rightMagnitude: state.rightMagnitude + other * other }
  }, { dot: 0, leftMagnitude: 0, rightMagnitude: 0 })
  return leftMagnitude && rightMagnitude ? dot / Math.sqrt(leftMagnitude * rightMagnitude) : 0
}

const validVector = (value: unknown): value is number[] => Array.isArray(value) && value.every(item => typeof item === 'number' && Number.isFinite(item))

/** Server-only embedding for compact, policy-approved feature contracts. It must never receive source text, URLs, identifiers or outcomes. */
export async function embedFeatureDocuments(documents: string[]) {
  const token = process.env.HUGGINGFACE_API_TOKEN
  if (!token) throw new Error('Hugging Face inference is not configured.')
  if (documents.length < BGE_M3_PILOT_MIN_CANDIDATES || documents.length > BGE_M3_PILOT_MAX_CANDIDATES) throw new Error(`The BGE-M3 pilot requires ${BGE_M3_PILOT_MIN_CANDIDATES}–${BGE_M3_PILOT_MAX_CANDIDATES} policy-approved feature records.`)
  const response = await fetch(`https://router.huggingface.co/hf-inference/models/${BGE_M3_MODEL_ID}`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ inputs: documents, options: { wait_for_model: true } }), signal: AbortSignal.timeout(30_000) })
  if (!response.ok) throw new Error(`Hugging Face inference failed with HTTP ${response.status}.`)
  const output: unknown = await response.json()
  if (!Array.isArray(output) || output.length !== documents.length || !output.every(validVector)) throw new Error('Hugging Face returned an invalid BGE-M3 embedding response.')
  return output
}

export async function embedDeidentifiedCandidates(candidates: BgePilotCandidate[]) {
  return embedFeatureDocuments(candidates.map(serialiseDeidentifiedFeature))
}

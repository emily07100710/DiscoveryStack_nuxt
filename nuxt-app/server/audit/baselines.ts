import { journeyStages, LABEL_CONTRACT_VERSION, LABEL_TAXONOMY_VERSION, TRAINING_FEATURE_CONTRACT_VERSION } from './types'

export const BGE_M3_MODEL_ID = 'BAAI/bge-m3'
export const BGE_M3_PILOT_MIN_CANDIDATES = 2
export const BGE_M3_PILOT_MAX_CANDIDATES = 3
const minimumPerStage = 20
const minimumCandidates = 150

export function buildBaselineReadiness(input: { consentedCandidates: number, stageCounts: Record<string, number>, huggingFaceConfigured: boolean }) {
  const stageCoverage = Object.fromEntries(journeyStages.map(stage => [stage, input.stageCounts[stage] || 0]))
  const taxonomyCoverageReady = journeyStages.every(stage => (stageCoverage[stage] ?? 0) >= minimumPerStage)
  return {
    contracts: { feature: TRAINING_FEATURE_CONTRACT_VERSION, taxonomy: LABEL_TAXONOMY_VERSION, label: LABEL_CONTRACT_VERSION },
    stageCoverage,
    consentedCandidates: input.consentedCandidates,
    bgeM3: { model: BGE_M3_MODEL_ID, status: !input.huggingFaceConfigured ? 'token_not_configured' : input.consentedCandidates < BGE_M3_PILOT_MIN_CANDIDATES ? 'needs_two_consented_candidates' : 'pilot_ready', similarityOnly: true, maxCandidatesPerRun: BGE_M3_PILOT_MAX_CANDIDATES },
    supervisedLearning: { status: input.consentedCandidates < minimumCandidates || !taxonomyCoverageReady ? 'not_ready' : 'evaluation_candidate_only', minimumCandidates, minimumPerStage, requiresHumanReview: true },
  }
}

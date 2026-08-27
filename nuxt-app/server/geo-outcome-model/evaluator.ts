import { calculateBinaryMetrics, calculateRankingMetrics } from './metrics'
import { scoreWithParameters, type TrainedParameters } from './trainer'
import type { DatasetMember, EvaluationBundle, SplitAssignment } from './types'

function evaluateRows(parameters: TrainedParameters, rows: readonly DatasetMember[]): { binary: ReturnType<typeof calculateBinaryMetrics>, ranking: ReturnType<typeof calculateRankingMetrics> } {
  const scores = rows.map(row => scoreWithParameters(parameters, row.featureVector.values.map(value => value.value)))
  return { binary: calculateBinaryMetrics(rows.map(row => row.label), scores), ranking: calculateRankingMetrics(rows, scores) }
}
function select(members: readonly DatasetMember[], fingerprints: readonly string[]): DatasetMember[] {
  const set = new Set(fingerprints)
  return members.filter(member => set.has(member.observationFingerprint)).sort((a, b) => a.observationFingerprint.localeCompare(b.observationFingerprint))
}

export function evaluateModel(parameters: TrainedParameters, members: readonly DatasetMember[], split: SplitAssignment, taskType: 'citation_selection' | 'structural_readiness_auxiliary' = 'citation_selection'): EvaluationBundle {
  const validation = evaluateRows(parameters, select(members, split.validation))
  const test = evaluateRows(parameters, select(members, split.test))
  const siteHoldout = evaluateRows(parameters, select(members, split.siteHoldout))
  const queryHoldout = evaluateRows(parameters, select(members, split.queryHoldout))
  const temporalHoldout = evaluateRows(parameters, select(members, split.temporalHoldout))
  return { validation: validation.binary, test: test.binary, siteHoldout: siteHoldout.binary, queryHoldout: queryHoldout.binary, temporalHoldout: temporalHoldout.binary, rankingValidation: validation.ranking, rankingTest: test.ranking, rankingTemporalHoldout: temporalHoldout.ranking, evaluationScope: taskType === 'structural_readiness_auxiliary' ? 'structural_auxiliary' : 'citation_selection' }
}

import { createGeoContentEvaluationCase } from './canonical'
import type { GeoContentEvaluationCandidateInput, GeoContentEvaluationCase } from './types'

export function evaluateGeoContentCandidate(value: unknown): GeoContentEvaluationCase {
  return createGeoContentEvaluationCase(value)
}

export type { GeoContentEvaluationCandidateInput }

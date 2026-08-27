import { candidateSetReviewSchema, reviewCandidateSet, type CandidateSetReviewResult } from '../../geo-outcome-model/candidate-authority'
import type { GeoOutcomeDrizzleDatabase } from '../../geo-outcome-model/repository-drizzle'

/** Injectable application boundary used by the owner route and strict Drizzle contract tests. */
export async function executeCandidateSetReviewMutation(input: { ownerUserId: number, reviewerUserId: number, body: unknown, database: GeoOutcomeDrizzleDatabase }): Promise<CandidateSetReviewResult> {
  const parsed = candidateSetReviewSchema.safeParse(input.body)
  if (!parsed.success) throw new Error('Invalid candidate-set review input.')
  return reviewCandidateSet(input.database, input.ownerUserId, input.reviewerUserId, parsed.data)
}

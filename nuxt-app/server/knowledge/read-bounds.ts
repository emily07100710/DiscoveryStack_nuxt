/** Optional limits leave existing callers unchanged; preview callers use a limit-plus-one sentinel. */
export const KNOWLEDGE_MAX_BOUNDED_READ = 2_001

export function knowledgeReadLimit(limit: number | undefined): number | undefined {
  if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1 || limit > KNOWLEDGE_MAX_BOUNDED_READ)) {
    throw new Error('Knowledge read limit is outside the bounded range.')
  }
  return limit
}

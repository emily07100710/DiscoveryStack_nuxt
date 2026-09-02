import { executeVisibilityProbeBatch } from './runner'
import type { ObservationCandidate, ProbeBatchBlockedResult, ProbeBatchResult, VisibilityProbeAdapter, VisibilityProbeIdempotencyRegistry, VisibilityProbePlan } from './types'
import { persistProviderObservationCandidate, type VisibilityWorkflowRepository } from '../llm-visibility/service'
import { createDefaultCitationHeadFetch, type CitationHeadFetchOptions } from '../llm-visibility/citation-freshness'

export type PersistedProviderObservation = { probeId: string, requestFingerprint: string, runId: number, observationId: number }

export function createEphemeralVisibilityProbeIdempotencyRegistry(): VisibilityProbeIdempotencyRegistry {
  const records = new Map<string, { identityKey: string, result: import('./types').ProbeExecutionResult }>()
  const inProgress = new Map<string, { identityKey: string, claimToken: string }>()
  let token = 0
  return {
    async claim(input) {
      const stored = records.get(input.requestFingerprint)
      if (stored) return stored.identityKey === input.identityKey ? { status: 'replay', record: { requestFingerprint: input.requestFingerprint, identityKey: stored.identityKey, result: stored.result } } : { status: 'collision' }
      const active = inProgress.get(input.requestFingerprint)
      if (active) return active.identityKey === input.identityKey ? { status: 'in_progress' } : { status: 'collision' }
      const claimToken = `visibility-claim-${++token}`
      inProgress.set(input.requestFingerprint, { identityKey: input.identityKey, claimToken })
      return { status: 'acquired', claimToken }
    },
    async complete(input) {
      const active = inProgress.get(input.requestFingerprint)
      if (!active || active.identityKey !== input.identityKey || active.claimToken !== input.claimToken) throw new Error('IDEMPOTENCY_REGISTRY_FAILURE')
      inProgress.delete(input.requestFingerprint)
      records.set(input.requestFingerprint, { identityKey: input.identityKey, result: { ...input.result, replayed: false } })
    },
    async release(input) {
      const active = inProgress.get(input.requestFingerprint)
      if (!active || active.identityKey !== input.identityKey || active.claimToken !== input.claimToken) throw new Error('IDEMPOTENCY_REGISTRY_FAILURE')
      inProgress.delete(input.requestFingerprint)
    },
  }
}
export type ProviderObservationRuntimeResult = {
  batch: ProbeBatchResult | ProbeBatchBlockedResult
  persisted: PersistedProviderObservation[]
  persistenceFailures: Array<{ probeId: string, requestFingerprint: string, code: 'PERSISTENCE_FAILED' }>
}

function expectedScopeMatches(plan: VisibilityProbePlan, ownerScopeKey: string): boolean {
  return plan.ownerScopeKey === ownerScopeKey && plan.probes.every(probe => probe.ownerScopeKey === ownerScopeKey)
}

function numericIdentity(value: string): number | null {
  if (!/^\d{1,12}$/u.test(value)) return null
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null
}

export async function executeAndPersistProviderObservations(input: {
  ownerUserId: number
  ownerScopeKey: string
  plan: VisibilityProbePlan
  adapters: Record<string, VisibilityProbeAdapter>
  idempotencyRegistry: VisibilityProbeIdempotencyRegistry
  repository: VisibilityWorkflowRepository
  concurrency?: number
  abortSignal?: AbortSignal
  now?: Date
  headFetch?: CitationHeadFetchOptions
}): Promise<ProviderObservationRuntimeResult> {
  if (!Number.isSafeInteger(input.ownerUserId) || input.ownerUserId < 1 || !expectedScopeMatches(input.plan, input.ownerScopeKey)) {
    return { batch: { status: 'blocked', reasonCodes: ['OWNER_SCOPE_MISMATCH'], results: [], counts: { completed: 0, blocked: 0, failed: 0, retryable: 0 } }, persisted: [], persistenceFailures: [] }
  }
  const batch = await executeVisibilityProbeBatch({ plan: input.plan, adapters: input.adapters, idempotencyRegistry: input.idempotencyRegistry, ...(input.concurrency === undefined ? {} : { concurrency: input.concurrency }), ...(input.abortSignal === undefined ? {} : { abortSignal: input.abortSignal }) })
  if (batch.status === 'blocked') return { batch, persisted: [], persistenceFailures: [] }
  const headFetch = input.headFetch ?? createDefaultCitationHeadFetch()
  const persisted: PersistedProviderObservation[] = []
  const persistenceFailures: Array<{ probeId: string, requestFingerprint: string, code: 'PERSISTENCE_FAILED' }> = []
  for (const result of batch.results) {
    const candidate: ObservationCandidate | undefined = result.candidate
    if (result.status !== 'completed' || !candidate) continue
    try {
      const projectId = numericIdentity(candidate.projectId)
      const queryId = numericIdentity(candidate.queryId)
      if (projectId === null || queryId === null) throw new Error('PERSISTENCE_IDENTITY_MAPPING_FAILED')
      const committed = await persistProviderObservationCandidate(input.repository, input.ownerUserId, { ...candidate, projectId, queryId }, input.now || new Date(), { headFetch })
      persisted.push({ probeId: candidate.probeId, requestFingerprint: candidate.requestFingerprint, runId: committed.runId, observationId: committed.observationId })
    } catch {
      persistenceFailures.push({ probeId: candidate.probeId, requestFingerprint: candidate.requestFingerprint, code: 'PERSISTENCE_FAILED' })
    }
  }
  return { batch, persisted, persistenceFailures }
}

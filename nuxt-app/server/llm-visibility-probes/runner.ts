import { analyzeProviderObservation } from './analyzer'
import { normalizeProbe, normalizeCanonicalHash } from './normalization'
import { classifyVisibilityProbeFailure } from './retry-policy'
import {
  PROBE_PROVIDERS,
  type AdapterFailure,
  type ExecuteVisibilityProbeBatchInput,
  type IdempotencyRecord,
  type ProbeBatchBlockedResult,
  type ProbeBatchResult,
  type ProbeExecutionResult,
  type ProbeFailureKind,
  type VisibilityProbe,
  type VisibilityProbeAdapter,
  type VisibilityProbePlan,
} from './types'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function read(record: Record<string, unknown>, key: string): unknown {
  try { return record[key] } catch { throw new Error('UNSAFE_INPUT') }
}

function blockedResult(probe: VisibilityProbe, reasonCode: string): ProbeExecutionResult {
  return { probeId: probe.probeId, requestFingerprint: probe.requestFingerprint, status: 'blocked', replayed: false, failure: { retryable: false, nextDelayCategory: 'none', reasonCode } }
}

function failureResult(probe: VisibilityProbe, error: unknown): ProbeExecutionResult {
  const decision = classifyVisibilityProbeFailure(error)
  return { probeId: probe.probeId, requestFingerprint: probe.requestFingerprint, status: decision.retryable ? 'retryable' : 'failed', replayed: false, failure: decision }
}

function validAdapter(value: unknown): value is VisibilityProbeAdapter {
  return isRecord(value) && typeof value.adapterKey === 'string' && typeof value.provider === 'string' && typeof value.modelLabel === 'string' && typeof value.execute === 'function'
}

function validatePlan(value: unknown): { plan: VisibilityProbePlan } | { reasonCode: string } {
  if (!isRecord(value)) return { reasonCode: 'MALFORMED_PLAN' }
  try {
    if (read(value, 'status') !== 'planned' || !Array.isArray(read(value, 'probes')) || !isRecord(read(value, 'project'))) return { reasonCode: 'MALFORMED_PLAN' }
    const probesRaw = read(value, 'probes')
    const maximumProbes = read(value, 'maximumProbes')
    if (!Array.isArray(probesRaw) || probesRaw.length > 50 || typeof maximumProbes !== 'number' || !Number.isInteger(maximumProbes) || maximumProbes < 1 || maximumProbes > 50 || probesRaw.length > maximumProbes) return { reasonCode: 'MAXIMUM_PROBES_EXCEEDED' }
    const probes = probesRaw.map(item => normalizeProbe(item))
    const fingerprints = new Set<string>()
    for (const probe of probes) {
      normalizeCanonicalHash(probe.requestFingerprint, 'INVALID_REQUEST_FINGERPRINT')
      if (fingerprints.has(probe.requestFingerprint)) return { reasonCode: 'DUPLICATE_REQUEST_FINGERPRINT' }
      fingerprints.add(probe.requestFingerprint)
    }
    const plan = value as unknown as VisibilityProbePlan
    return { plan: { ...plan, probes } }
  } catch (error: unknown) {
    return { reasonCode: error instanceof Error && error.message ? error.message : 'MALFORMED_PLAN' }
  }
}

function validateRunnerInput(value: unknown): { input: ExecuteVisibilityProbeBatchInput } | { reasonCode: string } {
  if (!isRecord(value)) return { reasonCode: 'MALFORMED_RUNNER_INPUT' }
  try {
    const planResult = validatePlan(read(value, 'plan'))
    if ('reasonCode' in planResult) return planResult
    const adapters = read(value, 'adapters')
    const registry = read(value, 'idempotencyRegistry')
    if (!isRecord(adapters) || !isRecord(registry) || typeof read(registry, 'get') !== 'function' || typeof read(registry, 'record') !== 'function') return { reasonCode: 'MALFORMED_RUNNER_INPUT' }
    const concurrency = read(value, 'concurrency')
    if (concurrency !== undefined && (typeof concurrency !== 'number' || !Number.isInteger(concurrency) || concurrency < 1 || concurrency > 5)) return { reasonCode: 'INVALID_CONCURRENCY' }
    return { input: { plan: planResult.plan, adapters: adapters as Record<string, VisibilityProbeAdapter>, concurrency: (concurrency as number | undefined) || 1, idempotencyRegistry: registry as unknown as ExecuteVisibilityProbeBatchInput['idempotencyRegistry'], abortSignal: read(value, 'abortSignal') as AbortSignal | undefined } }
  } catch (error: unknown) {
    return { reasonCode: error instanceof Error && error.message ? error.message : 'MALFORMED_RUNNER_INPUT' }
  }
}

function batchBlocked(reasonCode: string): ProbeBatchBlockedResult {
  return { status: 'blocked', reasonCodes: [reasonCode], results: [], counts: { completed: 0, blocked: 0, failed: 0, retryable: 0 } }
}

async function executeOne(probe: VisibilityProbe, input: ExecuteVisibilityProbeBatchInput): Promise<ProbeExecutionResult> {
  const target = input.plan.providerTargets.find(candidate => candidate.provider === probe.provider && candidate.modelLabel === probe.modelLabel && candidate.adapterKey === probe.adapterKey)
  if (!target) return blockedResult(probe, 'ADAPTER_TARGET_MISMATCH')
  let existing: IdempotencyRecord | null = null
  try { existing = await input.idempotencyRegistry.get(probe.requestFingerprint) } catch { return blockedResult(probe, 'IDEMPOTENCY_REGISTRY_FAILURE') }
  if (existing) {
    if (existing.identityKey !== probe.identityKey) return blockedResult(probe, 'IDENTITY_COLLISION')
    if (existing.result.status === 'completed') return { ...existing.result, replayed: true }
  }
  const adapter = input.adapters[probe.adapterKey]
  if (!validAdapter(adapter) || adapter.provider !== probe.provider || adapter.modelLabel !== probe.modelLabel || adapter.adapterKey !== probe.adapterKey) return blockedResult(probe, 'ADAPTER_MISMATCH')
  if (input.abortSignal?.aborted) return failureResult(probe, { failureKind: 'timeout' as ProbeFailureKind })
  let adapterResult: Awaited<ReturnType<VisibilityProbeAdapter['execute']>>
  try {
    adapterResult = await adapter.execute({ probeIdentity: { probeId: probe.probeId, requestFingerprint: probe.requestFingerprint, ownerScopeKey: probe.ownerScopeKey, projectId: probe.projectId, queryId: probe.queryId, provider: probe.provider, modelLabel: probe.modelLabel }, normalizedPrompt: probe.normalizedPrompt, locale: probe.locale, timeoutMs: target.timeoutMs, abortSignal: input.abortSignal })
  } catch (error: unknown) {
    return failureResult(probe, error)
  }
  if (!adapterResult || typeof adapterResult !== 'object') return blockedResult(probe, 'MALFORMED_ADAPTER_RESPONSE')
  if (adapterResult.ok === false) {
    const safeFailure: AdapterFailure = { ok: false, failureKind: adapterResult.failureKind, retryable: adapterResult.retryable, code: typeof adapterResult.code === 'string' ? adapterResult.code.slice(0, 80) : 'ADAPTER_FAILURE', httpStatus: adapterResult.httpStatus }
    return failureResult(probe, safeFailure)
  }
  const analysis = analyzeProviderObservation({ probe, project: input.plan.project, target, response: adapterResult })
  if (analysis.status !== 'completed') return { ...blockedResult(probe, analysis.reasonCodes[0] || 'PROVIDER_OBSERVATION_INVALID'), failure: { retryable: false, nextDelayCategory: 'none', reasonCode: analysis.reasonCodes[0] || 'PROVIDER_OBSERVATION_INVALID' } }
  const result: ProbeExecutionResult = { probeId: probe.probeId, requestFingerprint: probe.requestFingerprint, status: 'completed', replayed: false, candidate: analysis.candidate }
  try { await input.idempotencyRegistry.record({ requestFingerprint: probe.requestFingerprint, identityKey: probe.identityKey, result }) } catch { return blockedResult(probe, 'IDEMPOTENCY_REGISTRY_FAILURE') }
  return result
}

function counts(results: ProbeExecutionResult[]): ProbeBatchResult['counts'] {
  return {
    completed: results.filter(result => result.status === 'completed').length,
    blocked: results.filter(result => result.status === 'blocked').length,
    failed: results.filter(result => result.status === 'failed').length,
    retryable: results.filter(result => result.status === 'retryable').length,
  }
}

export async function executeVisibilityProbeBatch(input: unknown): Promise<ProbeBatchResult | ProbeBatchBlockedResult> {
  const validated = validateRunnerInput(input)
  if ('reasonCode' in validated) return batchBlocked(validated.reasonCode)
  const { plan, concurrency = 1 } = validated.input
  const results = new Array<ProbeExecutionResult>(plan.probes.length)
  let nextIndex = 0
  const worker = async () => {
    while (true) {
      const index = nextIndex++
      if (index >= plan.probes.length) return
      const probe = plan.probes[index]
      if (!probe) continue
      try { results[index] = await executeOne(probe, validated.input) } catch { results[index] = blockedResult(probe, 'PROBE_EXECUTION_FAILURE') }
    }
  }
  const workerCount = Math.min(concurrency, Math.max(1, plan.probes.length))
  await Promise.all(Array.from({ length: workerCount }, () => worker()))
  const stableResults = results.filter((result): result is ProbeExecutionResult => Boolean(result))
  return { status: 'completed', results: stableResults, counts: counts(stableResults) }
}

export function isSupportedProbeProvider(value: unknown): value is typeof PROBE_PROVIDERS[number] {
  return typeof value === 'string' && (PROBE_PROVIDERS as readonly string[]).includes(value)
}

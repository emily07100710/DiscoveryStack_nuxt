import {
  hasExactKeys,
  normalizeAdapterFailure,
  normalizeAdapterSuccessResponse,
  normalizeOpaqueIdentifier,
  normalizeVisibilityProbePlan,
  validateStoredIdempotencyRecord,
} from './normalization'
import { analyzeProviderObservation } from './analyzer'
import { classifyVisibilityProbeFailure } from './retry-policy'
import {
  PROBE_PROVIDERS,
  type AdapterFailure,
  type IdempotencyClaimResult,
  type ProbeBatchBlockedResult,
  type ProbeBatchResult,
  type ProbeExecutionResult,
  type ProbeFailureKind,
  type VisibilityProbe,
  type VisibilityProbeAdapter,
  type VisibilityProbeIdempotencyRegistry,
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

function isSupportedProvider(value: unknown): value is typeof PROBE_PROVIDERS[number] {
  return typeof value === 'string' && (PROBE_PROVIDERS as readonly string[]).includes(value)
}

function validAdapter(value: unknown, key: string): value is VisibilityProbeAdapter {
  if (!isRecord(value)) return false
  try {
    return read(value, 'adapterKey') === key
      && typeof read(value, 'adapterKey') === 'string'
      && isSupportedProvider(read(value, 'provider'))
      && typeof read(value, 'modelLabel') === 'string'
      && Boolean(read(value, 'modelLabel'))
      && typeof read(value, 'execute') === 'function'
  } catch { return false }
}

function validAbortSignal(value: unknown): value is AbortSignal {
  if (value === undefined) return true
  if (!isRecord(value)) return false
  try { return typeof read(value, 'aborted') === 'boolean' && typeof read(value, 'addEventListener') === 'function' } catch { return false }
}

function validRegistry(value: unknown): value is VisibilityProbeIdempotencyRegistry {
  if (!isRecord(value)) return false
  try {
    return typeof read(value, 'claim') === 'function' && typeof read(value, 'complete') === 'function' && typeof read(value, 'release') === 'function'
  } catch { return false }
}

function normalizeAdapters(value: unknown): Record<string, VisibilityProbeAdapter> {
  if (!isRecord(value)) throw new Error('MALFORMED_RUNNER_INPUT')
  let keys: (string | symbol)[]
  try { keys = Reflect.ownKeys(value) } catch { throw new Error('MALFORMED_RUNNER_INPUT') }
  if (keys.some(key => typeof key !== 'string')) throw new Error('MALFORMED_RUNNER_INPUT')
  const adapters: Record<string, VisibilityProbeAdapter> = {}
  for (const key of keys as string[]) {
    const adapter = read(value, key)
    if (!validAdapter(adapter, key)) throw new Error('MALFORMED_ADAPTER')
    adapters[key] = adapter
  }
  return adapters
}

type SafeClaimResult = Exclude<IdempotencyClaimResult, { status: 'replay' }> | { status: 'replay', record: unknown }

function normalizeClaimResult(value: unknown): SafeClaimResult {
  if (!isRecord(value)) throw new Error('IDEMPOTENCY_REGISTRY_FAILURE')
  const status = read(value, 'status')
  if (status === 'acquired') {
    if (!hasExactKeys(value, ['status', 'claimToken'])) throw new Error('IDEMPOTENCY_REGISTRY_FAILURE')
    return { status: 'acquired', claimToken: normalizeOpaqueIdentifier(read(value, 'claimToken'), 160, 'IDEMPOTENCY_REGISTRY_FAILURE') }
  }
  if (status === 'replay') {
    if (!hasExactKeys(value, ['status', 'record'])) throw new Error('IDEMPOTENCY_REGISTRY_FAILURE')
    return { status: 'replay', record: read(value, 'record') }
  }
  if (status === 'in_progress') {
    if (!hasExactKeys(value, ['status'])) throw new Error('IDEMPOTENCY_REGISTRY_FAILURE')
    return { status: 'in_progress' }
  }
  if (status === 'collision') {
    if (!hasExactKeys(value, ['status'])) throw new Error('IDEMPOTENCY_REGISTRY_FAILURE')
    return { status: 'collision' }
  }
  throw new Error('IDEMPOTENCY_REGISTRY_FAILURE')
}

function validateRunnerInput(value: unknown): { input: { plan: VisibilityProbePlan, adapters: Record<string, VisibilityProbeAdapter>, concurrency: number, idempotencyRegistry: VisibilityProbeIdempotencyRegistry, abortSignal?: AbortSignal } } | { reasonCode: string } {
  if (!isRecord(value) || !hasExactKeys(value, ['plan', 'adapters', 'idempotencyRegistry'], ['concurrency', 'abortSignal'])) return { reasonCode: 'MALFORMED_RUNNER_INPUT' }
  try {
    const plan = normalizeVisibilityProbePlan(read(value, 'plan'))
    const adapters = normalizeAdapters(read(value, 'adapters'))
    const registryValue = read(value, 'idempotencyRegistry')
    if (!validRegistry(registryValue)) return { reasonCode: 'MALFORMED_RUNNER_INPUT' }
    const concurrencyValue = read(value, 'concurrency')
    if (concurrencyValue !== undefined && (typeof concurrencyValue !== 'number' || !Number.isInteger(concurrencyValue) || concurrencyValue < 1 || concurrencyValue > 5)) return { reasonCode: 'INVALID_CONCURRENCY' }
    const abortSignal = read(value, 'abortSignal')
    if (!validAbortSignal(abortSignal)) return { reasonCode: 'MALFORMED_RUNNER_INPUT' }
    return { input: { plan, adapters, concurrency: concurrencyValue === undefined ? 1 : concurrencyValue, idempotencyRegistry: registryValue, ...(abortSignal === undefined ? {} : { abortSignal }) } }
  } catch (error: unknown) {
    return { reasonCode: error instanceof Error && ['MALFORMED_PLAN', 'MALFORMED_PLAN_STATUS', 'ENGINE_VERSION_MISMATCH', 'MALFORMED_PLAN_LIMITATION', 'INVALID_MAXIMUM_PROBES', 'MALFORMED_PROJECT', 'MALFORMED_PROVIDER_TARGET_LIST', 'MALFORMED_PROVIDER_TARGET', 'PAUSED_PROVIDER_TARGET', 'DUPLICATE_PROVIDER_TARGET', 'INVALID_PROBE_COUNT', 'MALFORMED_PROBE', 'INVALID_PROBE_ID', 'INVALID_REQUEST_FINGERPRINT', 'PROBE_OWNER_SCOPE_MISMATCH', 'PROBE_PROJECT_MISMATCH', 'PROBE_LOCALE_MISMATCH', 'PROBE_WINDOW_MISMATCH', 'PROBE_ENGINE_VERSION_MISMATCH', 'PROBE_GOVERNANCE_MISMATCH', 'PROBE_TARGET_MISMATCH', 'PROBE_TARGET_NOT_ELIGIBLE', 'PROBE_IDENTITY_KEY_MISMATCH', 'PROBE_REQUEST_FINGERPRINT_MISMATCH', 'PROBE_ID_MISMATCH', 'DUPLICATE_REQUEST_FINGERPRINT', 'DUPLICATE_PROBE_ID', 'DUPLICATE_IDENTITY_KEY', 'INVALID_PLAN_FINGERPRINT', 'PLAN_FINGERPRINT_MISMATCH'].includes(error.message) ? error.message : 'MALFORMED_RUNNER_INPUT' }
  }
}

function batchBlocked(reasonCode: string): ProbeBatchBlockedResult {
  return { status: 'blocked', reasonCodes: [reasonCode], results: [], counts: { completed: 0, blocked: 0, failed: 0, retryable: 0 } }
}

async function releaseClaim(input: { registry: VisibilityProbeIdempotencyRegistry, probe: VisibilityProbe, claimToken: string }): Promise<void> {
  try {
    await input.registry.release({ requestFingerprint: input.probe.requestFingerprint, identityKey: input.probe.identityKey, claimToken: input.claimToken })
  } catch {
    throw new Error('IDEMPOTENCY_REGISTRY_FAILURE')
  }
}

function adapterValidationReason(error: unknown): string {
  const safeReasons = new Set(['MALFORMED_ADAPTER_RESPONSE', 'MALFORMED_RESPONSE', 'CITATION_VALIDATION_FAILURE', 'MALFORMED_RESPONSE_METADATA', 'MALFORMED_PROVIDER_REQUEST_ID'])
  return error instanceof Error && safeReasons.has(error.message) ? error.message : 'MALFORMED_ADAPTER_RESPONSE'
}

function targetForProbe(plan: VisibilityProbePlan, probe: VisibilityProbe) {
  const targets = plan.providerTargets.filter(target => target.provider === probe.provider && target.modelLabel === probe.modelLabel && target.adapterKey === probe.adapterKey)
  if (targets.length !== 1 || targets[0]!.status !== 'active' || !targets[0]!.allowedLocales.includes(probe.locale)) return null
  return targets[0]!
}

async function executeOne(probe: VisibilityProbe, input: { plan: VisibilityProbePlan, adapters: Record<string, VisibilityProbeAdapter>, idempotencyRegistry: VisibilityProbeIdempotencyRegistry, abortSignal?: AbortSignal }): Promise<ProbeExecutionResult> {
  const target = targetForProbe(input.plan, probe)
  if (!target) return blockedResult(probe, 'ADAPTER_TARGET_MISMATCH')
  const adapter = input.adapters[probe.adapterKey]
  if (!validAdapter(adapter, probe.adapterKey) || adapter.provider !== probe.provider || adapter.modelLabel !== probe.modelLabel) return blockedResult(probe, 'ADAPTER_MISMATCH')
  if (input.abortSignal?.aborted) return failureResult(probe, { failureKind: 'timeout' as ProbeFailureKind })

  let claim: SafeClaimResult
  try {
    claim = normalizeClaimResult(await input.idempotencyRegistry.claim({ requestFingerprint: probe.requestFingerprint, identityKey: probe.identityKey }))
  } catch {
    return blockedResult(probe, 'IDEMPOTENCY_REGISTRY_FAILURE')
  }
  if (claim.status === 'collision') return blockedResult(probe, 'IDENTITY_COLLISION')
  if (claim.status === 'in_progress') return { ...failureResult(probe, { failureKind: 'timeout' as ProbeFailureKind }), failure: { retryable: true, nextDelayCategory: 'short', reasonCode: 'IDEMPOTENCY_IN_PROGRESS_RETRYABLE' } }
  if (claim.status === 'replay') {
    try {
      const stored = validateStoredIdempotencyRecord(claim.record, { plan: input.plan, probe, target })
      return { ...stored.result, replayed: true }
    } catch {
      return blockedResult(probe, 'IDEMPOTENCY_REPLAY_INVALID')
    }
  }

  const claimToken = claim.claimToken
  if (input.abortSignal?.aborted) {
    try { await releaseClaim({ registry: input.idempotencyRegistry, probe, claimToken }) } catch { return blockedResult(probe, 'IDEMPOTENCY_REGISTRY_FAILURE') }
    return failureResult(probe, { failureKind: 'timeout' as ProbeFailureKind })
  }
  try {
    const rawAdapterResult = await adapter.execute({
      probeIdentity: { probeId: probe.probeId, requestFingerprint: probe.requestFingerprint, ownerScopeKey: probe.ownerScopeKey, projectId: probe.projectId, queryId: probe.queryId, provider: probe.provider, modelLabel: probe.modelLabel },
      normalizedPrompt: probe.normalizedPrompt,
      locale: probe.locale,
      timeoutMs: target.timeoutMs,
      abortSignal: input.abortSignal,
    })
    if (input.abortSignal?.aborted) {
      await releaseClaim({ registry: input.idempotencyRegistry, probe, claimToken })
      return failureResult(probe, { failureKind: 'timeout' as ProbeFailureKind })
    }
    if (!isRecord(rawAdapterResult)) throw new Error('MALFORMED_ADAPTER_RESPONSE')
    let normalizedAdapterResult: Awaited<ReturnType<typeof normalizeAdapterSuccessResponse>> | Awaited<ReturnType<typeof normalizeAdapterFailure>>
    try {
      normalizedAdapterResult = read(rawAdapterResult, 'ok') === true
        ? normalizeAdapterSuccessResponse(rawAdapterResult)
        : normalizeAdapterFailure(rawAdapterResult)
    } catch (error: unknown) {
      await releaseClaim({ registry: input.idempotencyRegistry, probe, claimToken })
      return blockedResult(probe, adapterValidationReason(error))
    }
    if (normalizedAdapterResult.ok === false) {
      const safeFailure: AdapterFailure = { ok: false, failureKind: normalizedAdapterResult.failureKind as ProbeFailureKind, retryable: normalizedAdapterResult.retryable, code: normalizedAdapterResult.code, ...(normalizedAdapterResult.httpStatus === undefined ? {} : { httpStatus: normalizedAdapterResult.httpStatus }) }
      const result = failureResult(probe, safeFailure)
      await releaseClaim({ registry: input.idempotencyRegistry, probe, claimToken })
      return result
    }
    const analysis = analyzeProviderObservation({ plan: input.plan, probeId: probe.probeId, response: normalizedAdapterResult })
    if (analysis.status !== 'completed') {
      await releaseClaim({ registry: input.idempotencyRegistry, probe, claimToken })
      return { ...blockedResult(probe, analysis.reasonCodes[0] || 'PROVIDER_OBSERVATION_INVALID'), failure: { retryable: false, nextDelayCategory: 'none', reasonCode: analysis.reasonCodes[0] || 'PROVIDER_OBSERVATION_INVALID' } }
    }
    const result: ProbeExecutionResult = { probeId: probe.probeId, requestFingerprint: probe.requestFingerprint, status: 'completed', replayed: false, candidate: analysis.candidate }
    try {
      await input.idempotencyRegistry.complete({ requestFingerprint: probe.requestFingerprint, identityKey: probe.identityKey, claimToken, result })
    } catch {
      try { await releaseClaim({ registry: input.idempotencyRegistry, probe, claimToken }) } catch { return blockedResult(probe, 'IDEMPOTENCY_REGISTRY_FAILURE') }
      return blockedResult(probe, 'IDEMPOTENCY_REGISTRY_FAILURE')
    }
    return result
  } catch (error: unknown) {
    try { await releaseClaim({ registry: input.idempotencyRegistry, probe, claimToken }) } catch { return blockedResult(probe, 'IDEMPOTENCY_REGISTRY_FAILURE') }
    if (error instanceof Error && error.message === 'IDEMPOTENCY_REGISTRY_FAILURE') return blockedResult(probe, 'IDEMPOTENCY_REGISTRY_FAILURE')
    if (error instanceof Error && (error.message === 'MALFORMED_ADAPTER_RESPONSE' || error.message === 'UNSAFE_INPUT')) return blockedResult(probe, 'MALFORMED_ADAPTER_RESPONSE')
    return failureResult(probe, error)
  }
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
  const { plan, concurrency, adapters, idempotencyRegistry, abortSignal } = validated.input
  const results = new Array<ProbeExecutionResult>(plan.probes.length)
  let nextIndex = 0
  const worker = async () => {
    while (true) {
      const index = nextIndex++
      if (index >= plan.probes.length) return
      const probe = plan.probes[index]
      if (!probe) continue
      try { results[index] = await executeOne(probe, { plan, adapters, idempotencyRegistry, abortSignal }) } catch { results[index] = blockedResult(probe, 'PROBE_EXECUTION_FAILURE') }
    }
  }
  const workerCount = Math.min(concurrency, plan.probes.length)
  await Promise.all(Array.from({ length: workerCount }, () => worker()))
  const stableResults = results.filter((result): result is ProbeExecutionResult => Boolean(result))
  return { status: 'completed', results: stableResults, counts: counts(stableResults) }
}

export function isSupportedProbeProvider(value: unknown): value is typeof PROBE_PROVIDERS[number] {
  return isSupportedProvider(value)
}

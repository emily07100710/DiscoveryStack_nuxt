import { describe, expect, it, vi } from 'vitest'
import {
  analyzeProviderObservation,
  buildEvidenceLocator,
  buildVisibilityProbePlan,
  classifyVisibilityProbeFailure,
  executeVisibilityProbeBatch,
  normalizeVisibilityProbePlan,
  type AdapterFailure,
  type ObservationCandidate,
  type ProbeFailureKind,
  type VisibilityProbe,
  type VisibilityProbePlan,
} from '../server/llm-visibility-probes'
import { importObservationSnapshot } from '../server/llm-visibility/service'
import { observationInputSchema, ownerManualObservationImportSchema, type ObservationInput } from '../server/llm-visibility/contracts'
import { syntheticAdapter, syntheticPlanInput, syntheticProject, syntheticQuery, syntheticSuccess, syntheticTarget, SyntheticRegistry } from './fixtures/llm-visibility-probes/fixtures'

function planned(overrides: Parameters<typeof syntheticPlanInput>[0] = {}): VisibilityProbePlan {
  const result = buildVisibilityProbePlan(syntheticPlanInput(overrides))
  expect(result.status).toBe('planned')
  if (result.status !== 'planned') throw new Error('expected plan')
  return result.plan
}

function firstProbe(overrides: Parameters<typeof syntheticPlanInput>[0] = {}): { plan: VisibilityProbePlan, probe: VisibilityProbe } {
  const plan = planned(overrides)
  const probe = plan.probes[0]
  if (!probe) throw new Error('expected probe')
  return { plan, probe }
}

function responseInput(overrides: Parameters<typeof syntheticPlanInput>[0] = {}, response: unknown = syntheticSuccess()) {
  const { plan, probe } = firstProbe(overrides)
  return { plan, probeId: probe.probeId, response }
}

function completedCandidate(input = responseInput()) {
  const result = analyzeProviderObservation(input)
  expect(result.status).toBe('completed')
  if (result.status !== 'completed') throw new Error('expected candidate')
  return result.candidate
}

function candidateResult(result: Awaited<ReturnType<typeof executeVisibilityProbeBatch>>, index = 0) {
  const item = result.results[index]
  if (!item) throw new Error('expected result')
  return item
}

const planMalformedInputs: unknown[] = [null, [], 'plan', 42, { ownerScopeKey: 'scope' }]
const failureCases: Array<[string, unknown, boolean, string]> = [
  ['invalid input', { failureKind: 'invalid_input' as ProbeFailureKind }, false, 'INVALID_INPUT_NOT_RETRYABLE'],
  ['scope mismatch', { failureKind: 'owner_project_query_mismatch' as ProbeFailureKind }, false, 'OWNER_PROJECT_QUERY_MISMATCH_NOT_RETRYABLE'],
  ['unsupported locale', { failureKind: 'unsupported_locale' as ProbeFailureKind }, false, 'UNSUPPORTED_LOCALE_NOT_RETRYABLE'],
  ['adapter mismatch', { failureKind: 'adapter_mismatch' as ProbeFailureKind }, false, 'ADAPTER_MISMATCH_NOT_RETRYABLE'],
  ['response too large', { failureKind: 'response_too_large' as ProbeFailureKind }, false, 'RESPONSE_TOO_LARGE_NOT_RETRYABLE'],
  ['malformed response', { failureKind: 'malformed_response' as ProbeFailureKind }, false, 'MALFORMED_RESPONSE_NOT_RETRYABLE'],
  ['citation failure', { failureKind: 'citation_validation_failure' as ProbeFailureKind }, false, 'CITATION_VALIDATION_FAILURE_NOT_RETRYABLE'],
  ['identity collision', { failureKind: 'identity_collision' as ProbeFailureKind }, false, 'IDENTITY_COLLISION_NOT_RETRYABLE'],
  ['redirect', { failureKind: 'redirect' as ProbeFailureKind }, false, 'REDIRECT_NOT_RETRYABLE'],
  ['timeout', { failureKind: 'timeout' as ProbeFailureKind }, true, 'TIMEOUT_RETRYABLE'],
  ['network', { failureKind: 'network_unavailable' as ProbeFailureKind }, true, 'NETWORK_UNAVAILABLE_RETRYABLE'],
  ['unknown', { failureKind: 'unknown' as ProbeFailureKind }, false, 'UNKNOWN_FAILURE_NOT_RETRYABLE'],
]

describe('LLM Visibility Probe Engine V1 planning', () => {
  it('exports the fixed engine version through a planned result', () => {
    const plan = planned()
    expect(plan.engineVersion).toBe('llm_visibility_probe_engine_v1')
    expect(plan.status).toBe('planned')
  })

  it('creates one probe for one active query and provider target', () => {
    const plan = planned()
    expect(plan.probes).toHaveLength(1)
    expect(plan.probes[0]).toMatchObject({ provider: 'chatgpt', modelLabel: 'synthetic-model-1', queryId: 'query-synthetic-001', status: 'planned', limitationCode: 'provider_api_not_consumer_surface' })
  })

  it('includes owner, project, query, provider, locale and window in each probe', () => {
    const { plan, probe } = firstProbe()
    expect(probe).toMatchObject({ ownerScopeKey: plan.ownerScopeKey, projectId: plan.project.projectId, observationWindowKey: plan.observationWindowKey, locale: plan.project.locale })
    expect(probe.normalizedPrompt).toBe('Which product fits this need?')
  })

  it('does not plan google_ai_overview or manual provider targets', () => {
    const result = buildVisibilityProbePlan(syntheticPlanInput({ providerTargets: [syntheticTarget({ provider: 'google_ai_overview' as never }), syntheticTarget({ provider: 'manual_other' as never })] }))
    expect(result.status).toBe('blocked')
  })

  it('replays the same request fingerprint for the same window identity', () => {
    const first = planned()
    const second = planned()
    expect(first.planFingerprint).toBe(second.planFingerprint)
    expect(first.probes[0]?.requestFingerprint).toBe(second.probes[0]?.requestFingerprint)
    expect(first.probes[0]?.probeId).toBe(second.probes[0]?.probeId)
  })

  it('changes fingerprint when observation window changes', () => {
    expect(planned().probes[0]?.requestFingerprint).not.toBe(planned({ observationWindowKey: 'window-other' }).probes[0]?.requestFingerprint)
  })

  it('changes fingerprint when provider changes', () => {
    expect(planned().probes[0]?.requestFingerprint).not.toBe(planned({ providerTargets: [syntheticTarget({ provider: 'gemini', adapterKey: 'gemini-adapter' })] }).probes[0]?.requestFingerprint)
  })

  it('changes fingerprint when model changes', () => {
    expect(planned().probes[0]?.requestFingerprint).not.toBe(planned({ providerTargets: [syntheticTarget({ modelLabel: 'synthetic-model-2' })] }).probes[0]?.requestFingerprint)
  })

  it('changes fingerprint when query changes', () => {
    expect(planned().probes[0]?.requestFingerprint).not.toBe(planned({ activeQuerySnapshots: [syntheticQuery({ queryId: 'query-2', promptText: 'Which service fits this need?' })] }).probes[0]?.requestFingerprint)
  })

  it('uses stable provider/model/locale/query/fingerprint ordering', () => {
    const plan = planned({ providerTargets: [syntheticTarget({ provider: 'perplexity', adapterKey: 'p' }), syntheticTarget({ provider: 'chatgpt', adapterKey: 'c' })], activeQuerySnapshots: [syntheticQuery({ queryId: 'query-2', promptText: 'Second prompt?' }), syntheticQuery({ queryId: 'query-1', promptText: 'First prompt?' })], maximumProbes: 10 })
    expect(plan.probes.map(probe => `${probe.provider}:${probe.queryId}`)).toEqual(['chatgpt:query-1', 'chatgpt:query-2', 'perplexity:query-1', 'perplexity:query-2'])
  })

  it('excludes inactive queries', () => {
    const result = buildVisibilityProbePlan(syntheticPlanInput({ activeQuerySnapshots: [syntheticQuery({ active: false })] }))
    expect(result).toMatchObject({ status: 'blocked', reasonCodes: ['NO_ACTIVE_QUERIES'] })
  })

  it('excludes paused providers', () => {
    const result = buildVisibilityProbePlan(syntheticPlanInput({ providerTargets: [syntheticTarget({ status: 'paused' })] }))
    expect(result).toMatchObject({ status: 'blocked', reasonCodes: ['NO_ACTIVE_PROVIDER_TARGETS'] })
  })

  it('blocks a query whose project ID does not match the project', () => {
    const result = buildVisibilityProbePlan(syntheticPlanInput({ activeQuerySnapshots: [syntheticQuery({ projectId: 'other-project' })] }))
    expect(result).toMatchObject({ status: 'blocked', reasonCodes: ['OWNER_PROJECT_QUERY_MISMATCH'] })
  })

  it('blocks a query whose locale differs from the project locale', () => {
    const result = buildVisibilityProbePlan(syntheticPlanInput({ activeQuerySnapshots: [syntheticQuery({ locale: 'zh-hant' })] }))
    expect(result).toMatchObject({ status: 'blocked', reasonCodes: ['QUERY_LOCALE_MISMATCH'] })
  })

  it('blocks a provider target that does not allow the project locale', () => {
    const result = buildVisibilityProbePlan(syntheticPlanInput({ providerTargets: [syntheticTarget({ allowedLocales: ['zh-hant'] })] }))
    expect(result).toMatchObject({ status: 'blocked', reasonCodes: ['PROVIDER_LOCALE_MISMATCH'] })
  })

  it('blocks duplicate normalized prompts', () => {
    const result = buildVisibilityProbePlan(syntheticPlanInput({ activeQuerySnapshots: [syntheticQuery(), syntheticQuery({ queryId: 'query-2', promptText: '  WHICH  PRODUCT fits this need? ' })] }))
    expect(result).toMatchObject({ status: 'blocked', reasonCodes: ['DUPLICATE_NORMALIZED_PROMPT'] })
  })

  it('blocks duplicate provider/model/query combinations', () => {
    const target = syntheticTarget()
    const result = buildVisibilityProbePlan(syntheticPlanInput({ providerTargets: [target, { ...target }] }))
    expect(result.status).toBe('blocked')
    if (result.status === 'blocked') expect(result.reasonCodes).toContain('DUPLICATE_PROVIDER_TARGET')
  })

  it.each([[0, 'INVALID_MAXIMUM_PROBES'], [51, 'INVALID_MAXIMUM_PROBES'], [1.5, 'INVALID_MAXIMUM_PROBES']])('blocks maximumProbes %s', (maximumProbes, reasonCode) => {
    const result = buildVisibilityProbePlan(syntheticPlanInput({ maximumProbes }))
    expect(result).toMatchObject({ status: 'blocked', reasonCodes: [reasonCode] })
  })

  it('blocks more than 50 generated probes before returning a plan', () => {
    const queries = Array.from({ length: 26 }, (_, index) => syntheticQuery({ queryId: `query-${index}`, promptText: `Synthetic prompt ${index}?` }))
    const result = buildVisibilityProbePlan(syntheticPlanInput({ activeQuerySnapshots: queries, providerTargets: [syntheticTarget(), syntheticTarget({ provider: 'gemini', adapterKey: 'gemini-adapter' })], maximumProbes: 50 }))
    expect(result).toMatchObject({ status: 'blocked', reasonCodes: ['MAXIMUM_PROBES_EXCEEDED'] })
  })

  it('blocks a mismatched engine version', () => {
    const result = buildVisibilityProbePlan(syntheticPlanInput({ engineVersion: 'probe-v2' }))
    expect(result).toMatchObject({ status: 'blocked', reasonCodes: ['ENGINE_VERSION_MISMATCH'] })
  })

  it.each(planMalformedInputs)('fails closed for malformed plan input %#', input => {
    const result = buildVisibilityProbePlan(input)
    expect(result.status).toBe('blocked')
  })

  it('fails closed for a plan proxy whose keys throw', () => {
    const input = new Proxy({}, { ownKeys() { throw new Error('synthetic getter failure') } })
    expect(buildVisibilityProbePlan(input)).toMatchObject({ status: 'blocked' })
  })

  it('keeps google_ai_overview out even when cast through an unknown caller value', () => {
    const result = buildVisibilityProbePlan(syntheticPlanInput({ providerTargets: [syntheticTarget({ provider: 'google_ai_overview' as never })] }))
    expect(result.status).toBe('blocked')
  })
})

describe('LLM Visibility Probe Engine V1 analyzer', () => {
  it('returns provider_api_observation and never owner verification', () => {
    const candidate = completedCandidate()
    expect(candidate).toMatchObject({ observationMode: 'provider_api_observation', verifiedByOwner: false, status: 'completed', metricEligibility: 'secondary_only', consumerSurfaceEquivalent: false, persistenceStatus: 'not_persisted_v1', limitationCode: 'provider_api_not_consumer_surface' })
  })

  it('returns exact response hash and no raw response field', () => {
    const candidate = completedCandidate()
    expect(candidate.responseHash).toMatch(/^[a-f0-9]{64}$/)
    expect(candidate).not.toHaveProperty('responseText')
    expect(candidate).not.toHaveProperty('rawResponse')
  })

  it('counts an exact brand mention with first position', () => {
    const candidate = completedCandidate(responseInput({}, syntheticSuccess({ responseText: 'Intro text. Acme helps here.' })))
    expect(candidate.brandMentioned).toBe(true)
    expect(candidate.exactMentionCount).toBe(1)
    expect(candidate.firstMentionPosition).toBeGreaterThan(1)
  })

  it('matches an alias through the existing Unicode-aware helper', () => {
    const candidate = completedCandidate(responseInput({}, syntheticSuccess({ responseText: 'Acme Inc is mentioned once.' })))
    expect(candidate.brandMentioned).toBe(true)
    expect(candidate.exactMentionCount).toBe(1)
  })

  it('does not substring-match AcmePlus as Acme', () => {
    const candidate = completedCandidate(responseInput({}, syntheticSuccess({ responseText: 'AcmePlus is a different name.' })))
    expect(candidate.brandMentioned).toBe(false)
    expect(candidate.exactMentionCount).toBe(0)
  })

  it('counts competitors independently', () => {
    const candidate = completedCandidate(responseInput({}, syntheticSuccess({ responseText: 'Acme and RivalCo are both mentioned. RivalCo appears twice: RivalCo.' })))
    expect(candidate.competitorMentions).toMatchObject({ RivalCo: 3, OtherBrand: 0 })
  })

  it('reports no brand mention with null first position', () => {
    const candidate = completedCandidate(responseInput({}, syntheticSuccess({ responseText: 'There is no governed brand in this sentence.' })))
    expect(candidate.brandMentioned).toBe(false)
    expect(candidate.firstMentionPosition).toBeNull()
  })

  it('uses a deterministic leading excerpt without a brand mention', () => {
    const text = 'Leading synthetic response. '.repeat(80)
    const first = completedCandidate(responseInput({}, syntheticSuccess({ responseText: text })))
    const second = completedCandidate(responseInput({}, syntheticSuccess({ responseText: text })))
    expect(first.boundedExcerpt).toBe(second.boundedExcerpt)
    expect(first.boundedExcerpt.length).toBeLessThanOrEqual(1000)
    expect(first.boundedExcerpt).toBe(text.slice(0, 1000))
  })

  it('centers bounded excerpt around the first mention', () => {
    const text = `${'prefix '.repeat(200)}Acme ${'suffix '.repeat(200)}`
    const candidate = completedCandidate(responseInput({}, syntheticSuccess({ responseText: text })))
    expect(candidate.boundedExcerpt).toContain('Acme')
    expect(candidate.boundedExcerpt.length).toBeLessThanOrEqual(1000)
  })

  it('does not split a surrogate pair in the excerpt', () => {
    const text = '🙂'.repeat(1500)
    const candidate = completedCandidate(responseInput({}, syntheticSuccess({ responseText: text })))
    expect(Array.from(candidate.boundedExcerpt).length).toBe(1000)
    expect(Array.from(candidate.boundedExcerpt).join('')).toBe(candidate.boundedExcerpt)
    expect(Array.from(candidate.boundedExcerpt).every(character => character.length === 2)).toBe(true)
  })

  it('canonicalizes exact citation URLs, rejects fragments, and deduplicates', () => {
    const candidate = completedCandidate(responseInput({}, syntheticSuccess({ citationUrls: ['https://example.com/guide', 'https://example.com/guide', 'https://docs.example.net/source'] })))
    expect(candidate.citationUrls).toEqual(['https://docs.example.net/source', 'https://example.com/guide'])
    expect(analyzeProviderObservation(responseInput({}, syntheticSuccess({ citationUrls: ['https://example.com/guide#section'] })))).toMatchObject({ status: 'blocked', reasonCodes: ['CITATION_VALIDATION_FAILURE'] })
  })

  it('carries bounded provider citationDates while preserving exact-key rejection', () => {
    const url = 'https://example.com/guide'
    const candidate = completedCandidate(responseInput({}, syntheticSuccess({ citationUrls: [url], citationDates: { [url]: '2025-04-03' } })))
    expect(candidate.citationDates).toEqual({ [url]: '2025-04-03' })
    expect(analyzeProviderObservation(responseInput({}, { ...syntheticSuccess(), unexpectedDateField: '2025-04-03' }))).toMatchObject({ status: 'blocked', reasonCodes: ['MALFORMED_RESPONSE'] })
  })

  it('sets citedDomain only for exact canonical hostname', () => {
    const exact = completedCandidate(responseInput({}, syntheticSuccess({ citationUrls: ['https://example.com/guide'] })))
    const subdomain = completedCandidate(responseInput({}, syntheticSuccess({ citationUrls: ['https://www.example.com/guide'] })))
    expect(exact.citedDomain).toBe('example.com')
    expect(subdomain.citedDomain).toBeNull()
  })

  it('does not infer a citation URL from response text', () => {
    const candidate = completedCandidate(responseInput({}, syntheticSuccess({ responseText: 'See https://example.com/hidden but no citation was returned.', citationUrls: [] })))
    expect(candidate.citationUrls).toEqual([])
    expect(candidate.citedDomain).toBeNull()
  })

  it.each([
    ['http://example.com/a', 'CITATION_VALIDATION_FAILURE'],
    ['https://user:pass@example.com/a', 'CITATION_VALIDATION_FAILURE'],
    ['https://localhost/a', 'CITATION_VALIDATION_FAILURE'],
    ['https://127.0.0.1/a', 'CITATION_VALIDATION_FAILURE'],
    ['https://192.168.1.1/a', 'CITATION_VALIDATION_FAILURE'],
    ['https://example.com/a#frag', 'CITATION_VALIDATION_FAILURE'],
  ])('rejects unsafe citation %s', (citationUrl, reasonCode) => {
    const result = analyzeProviderObservation(responseInput({}, syntheticSuccess({ citationUrls: [citationUrl] })))
    expect(result).toMatchObject({ status: 'blocked', reasonCodes: [reasonCode] })
  })

  it('blocks more than 50 citation URLs', () => {
    const urls = Array.from({ length: 51 }, (_, index) => `https://source-${index}.example.net/guide`)
    expect(analyzeProviderObservation(responseInput({}, syntheticSuccess({ citationUrls: urls })))).toMatchObject({ status: 'blocked', reasonCodes: ['CITATION_VALIDATION_FAILURE'] })
  })

  it('blocks a response above the target byte limit', () => {
    const input = responseInput({ providerTargets: [syntheticTarget({ maximumResponseBytes: 10 })] }, syntheticSuccess({ responseText: 'This response is over ten bytes.' }))
    expect(analyzeProviderObservation(input)).toMatchObject({ status: 'blocked', reasonCodes: ['RESPONSE_TOO_LARGE'] })
  })

  it('canonicalizes observedAt to UTC ISO', () => {
    const candidate = completedCandidate(responseInput({}, syntheticSuccess({ observedAt: '2026-08-24T08:00:00+08:00' })))
    expect(candidate.observedAt).toBe('2026-08-24T00:00:00.000Z')
  })

  it('keeps provider request ID bounded and opaque', () => {
    const candidate = completedCandidate(responseInput({}, syntheticSuccess({ providerRequestId: 'opaque-request-123' })))
    expect(candidate.providerRequestId).toBe('opaque-request-123')
  })

  it('blocks a request ID containing unsafe punctuation', () => {
    const result = analyzeProviderObservation(responseInput({}, syntheticSuccess({ providerRequestId: 'request/with-slash' })))
    expect(result).toMatchObject({ status: 'blocked', reasonCodes: ['MALFORMED_PROVIDER_REQUEST_ID'] })
  })

  it('preserves only bounded response metadata allowlist fields', () => {
    const candidate = completedCandidate(responseInput({}, syntheticSuccess({ responseMetadata: { finishReason: 'stop', inputTokens: 1, outputTokens: 2, totalTokens: 3 } })))
    expect(candidate.provenance.responseMetadata).toEqual({ finishReason: 'stop', inputTokens: 1, outputTokens: 2, totalTokens: 3 })
  })

  it('blocks response metadata secret fields', () => {
    const result = analyzeProviderObservation(responseInput({}, syntheticSuccess({ responseMetadata: { apiKey: 'synthetic-secret' } as never })))
    expect(result).toMatchObject({ status: 'blocked', reasonCodes: ['MALFORMED_RESPONSE_METADATA'] })
  })

  it.each([null, [], 'response', { ok: true }, { ok: false, failureKind: 'timeout' }])('fails closed for malformed response %#', response => {
    expect(analyzeProviderObservation(responseInput({}, response))).toMatchObject({ status: 'blocked' })
  })

  it('blocks an adapter response provider mismatch', () => {
    const result = analyzeProviderObservation(responseInput({}, syntheticSuccess({ provider: 'gemini' })))
    expect(result).toMatchObject({ status: 'blocked', reasonCodes: ['PROVIDER_MODEL_MISMATCH'] })
  })

  it('blocks an adapter response model mismatch', () => {
    const result = analyzeProviderObservation(responseInput({}, syntheticSuccess({ modelLabel: 'another-model' })))
    expect(result).toMatchObject({ status: 'blocked', reasonCodes: ['PROVIDER_MODEL_MISMATCH'] })
  })

  it('blocks a response whose success flag is not true', () => {
    expect(analyzeProviderObservation(responseInput({}, { ...syntheticSuccess(), ok: false }))).toMatchObject({ status: 'blocked', reasonCodes: ['MALFORMED_RESPONSE'] })
  })

  it('uses a bounded evidence locator without raw response text', () => {
    const candidate = completedCandidate()
    expect(candidate.evidenceLocator).toContain(candidate.provider)
    expect(candidate.evidenceLocator).not.toContain('Acme is one option')
  })
})

describe('LLM Visibility Probe Engine V1 bounded runner', () => {
  it('executes an injected mock adapter and returns one completed result', async () => {
    const plan = planned()
    const calls: unknown[] = []
    const registry = new SyntheticRegistry()
    const adapter = syntheticAdapter({ onCall: input => calls.push(input) })
    const result = await executeVisibilityProbeBatch({ plan, adapters: { [adapter.adapterKey]: adapter }, idempotencyRegistry: registry })
    expect(result).toMatchObject({ status: 'completed', counts: { completed: 1, blocked: 0, failed: 0, retryable: 0 } })
    expect(candidateResult(result).candidate?.observationMode).toBe('provider_api_observation')
    expect(calls).toHaveLength(1)
  })

  it('passes only bounded probe identity, prompt, locale, timeout and abort signal to adapter', async () => {
    const plan = planned()
    let received: Record<string, unknown> | undefined
    const adapter = syntheticAdapter({ onCall: input => { received = input as Record<string, unknown> } })
    await executeVisibilityProbeBatch({ plan, adapters: { [adapter.adapterKey]: adapter }, idempotencyRegistry: new SyntheticRegistry() })
    expect(Object.keys(received || {}).sort()).toEqual(['abortSignal', 'locale', 'normalizedPrompt', 'probeIdentity', 'timeoutMs'])
    expect(received).not.toHaveProperty('apiKey')
    expect(received).not.toHaveProperty('authorization')
    expect(received?.probeIdentity).toEqual(expect.objectContaining({ provider: 'chatgpt', modelLabel: 'synthetic-model-1' }))
  })

  it('does not call an absent adapter', async () => {
    const result = await executeVisibilityProbeBatch({ plan: planned(), adapters: {}, idempotencyRegistry: new SyntheticRegistry() })
    expect(result).toMatchObject({ counts: { completed: 0, blocked: 1 } })
  })

  it('blocks adapter provider mismatch without calling it', async () => {
    const execute = vi.fn(async () => syntheticSuccess())
    const plan = planned()
    const adapter = { adapterKey: 'synthetic-adapter-1', provider: 'gemini' as const, modelLabel: 'synthetic-model-1', execute }
    const result = await executeVisibilityProbeBatch({ plan, adapters: { [adapter.adapterKey]: adapter }, idempotencyRegistry: new SyntheticRegistry() })
    expect(result).toMatchObject({ counts: { blocked: 1 } })
    expect(execute).not.toHaveBeenCalled()
  })

  it('blocks unknown adapter key without fallback to another provider', async () => {
    const execute = vi.fn(async () => syntheticSuccess())
    const plan = planned()
    const adapter = syntheticAdapter({ adapterKey: 'other-adapter', onCall: execute })
    const result = await executeVisibilityProbeBatch({ plan, adapters: { [adapter.adapterKey]: adapter }, idempotencyRegistry: new SyntheticRegistry() })
    expect(result).toMatchObject({ counts: { blocked: 1 } })
    expect(execute).not.toHaveBeenCalled()
  })

  it('keeps provider response mismatch as a blocked independent result', async () => {
    const adapter = syntheticAdapter({ result: syntheticSuccess({ provider: 'gemini' }) })
    const result = await executeVisibilityProbeBatch({ plan: planned(), adapters: { [adapter.adapterKey]: adapter }, idempotencyRegistry: new SyntheticRegistry() })
    expect(result).toMatchObject({ counts: { blocked: 1, completed: 0 } })
  })

  it.each([
    ['timeout', { ok: false, failureKind: 'timeout' as ProbeFailureKind, retryable: true, code: 'TIMEOUT' }, 'retryable'],
    ['network', { ok: false, failureKind: 'network_unavailable' as ProbeFailureKind, retryable: true, code: 'NETWORK' }, 'retryable'],
    ['429', { ok: false, failureKind: 'http_error' as ProbeFailureKind, retryable: true, code: 'HTTP_429', httpStatus: 429 }, 'retryable'],
    ['500', { ok: false, failureKind: 'http_error' as ProbeFailureKind, retryable: true, code: 'HTTP_500', httpStatus: 500 }, 'retryable'],
    ['401', { ok: false, failureKind: 'http_error' as ProbeFailureKind, retryable: false, code: 'HTTP_401', httpStatus: 401 }, 'failed'],
    ['409', { ok: false, failureKind: 'http_error' as ProbeFailureKind, retryable: false, code: 'HTTP_409', httpStatus: 409 }, 'failed'],
  ])('classifies adapter %s without retrying in the same batch', async (_label, failure, status) => {
    const adapter = syntheticAdapter({ result: failure as AdapterFailure })
    const result = await executeVisibilityProbeBatch({ plan: planned(), adapters: { [adapter.adapterKey]: adapter }, idempotencyRegistry: new SyntheticRegistry() })
    expect(candidateResult(result).status).toBe(status)
    expect(result.counts).toMatchObject(status === 'retryable' ? { retryable: 1 } : { failed: 1 })
  })

  it('keeps partial failures independent from successful probes', async () => {
    const plan = planned({ activeQuerySnapshots: [syntheticQuery({ queryId: 'query-1', promptText: 'First synthetic question?' }), syntheticQuery({ queryId: 'query-2', promptText: 'Second synthetic question?' })], providerTargets: [syntheticTarget(), syntheticTarget({ provider: 'gemini', adapterKey: 'gemini-adapter' })], maximumProbes: 10 })
    const calls: string[] = []
    const adapter = syntheticAdapter({ onCall: input => calls.push((input as { probeIdentity: { queryId: string } }).probeIdentity.queryId), result: syntheticSuccess() })
    const failingAdapter = syntheticAdapter({ provider: 'gemini', adapterKey: 'gemini-adapter', result: { ok: false, failureKind: 'timeout', retryable: true, code: 'TIMEOUT' } })
    const result = await executeVisibilityProbeBatch({ plan, adapters: { [adapter.adapterKey]: adapter, [failingAdapter.adapterKey]: failingAdapter }, idempotencyRegistry: new SyntheticRegistry(), concurrency: 2 })
    expect(result.counts.completed).toBe(2)
    expect(result.counts.retryable).toBe(2)
    expect(calls).toHaveLength(2)
  })

  it('returns stable result order even with concurrency five', async () => {
    const queries = Array.from({ length: 5 }, (_, index) => syntheticQuery({ queryId: `query-${index}`, promptText: `Stable prompt ${index}?` }))
    const plan = planned({ activeQuerySnapshots: queries, maximumProbes: 10 })
    const adapter = syntheticAdapter()
    const result = await executeVisibilityProbeBatch({ plan, adapters: { [adapter.adapterKey]: adapter }, idempotencyRegistry: new SyntheticRegistry(), concurrency: 5 })
    expect(result.results.map(item => item.probeId)).toEqual(plan.probes.map(probe => probe.probeId))
  })

  it.each([0, 6, 1.5, -1])('blocks invalid concurrency %s', async concurrency => {
    const result = await executeVisibilityProbeBatch({ plan: planned(), adapters: {}, idempotencyRegistry: new SyntheticRegistry(), concurrency })
    expect(result).toMatchObject({ status: 'blocked', reasonCodes: ['INVALID_CONCURRENCY'] })
  })

  it('defaults concurrency to one', async () => {
    let inFlight = 0
    let maxInFlight = 0
    const adapter = syntheticAdapter({ onCall: async () => { inFlight += 1; maxInFlight = Math.max(maxInFlight, inFlight); await Promise.resolve(); inFlight -= 1 } })
    await executeVisibilityProbeBatch({ plan: planned({ activeQuerySnapshots: [syntheticQuery({ queryId: 'one', promptText: 'One?' }), syntheticQuery({ queryId: 'two', promptText: 'Two?' })], maximumProbes: 10 }), adapters: { [adapter.adapterKey]: adapter }, idempotencyRegistry: new SyntheticRegistry() })
    expect(maxInFlight).toBe(1)
  })

  it('replays a completed idempotency record without calling the adapter', async () => {
    const plan = planned()
    const registry = new SyntheticRegistry()
    const firstAdapter = syntheticAdapter()
    await executeVisibilityProbeBatch({ plan, adapters: { [firstAdapter.adapterKey]: firstAdapter }, idempotencyRegistry: registry })
    const execute = vi.fn(async () => syntheticSuccess({ responseText: 'Should not execute.' }))
    const replayAdapter = { ...firstAdapter, execute }
    const replay = await executeVisibilityProbeBatch({ plan, adapters: { [replayAdapter.adapterKey]: replayAdapter }, idempotencyRegistry: registry })
    expect(candidateResult(replay).replayed).toBe(true)
    expect(execute).not.toHaveBeenCalled()
  })

  it('blocks an idempotency fingerprint collision before adapter execution', async () => {
    const plan = planned()
    const execute = vi.fn(async () => syntheticSuccess())
    const registry = { claim: vi.fn(async () => ({ status: 'collision' as const })), complete: vi.fn(async () => undefined), release: vi.fn(async () => undefined) }
    const result = await executeVisibilityProbeBatch({ plan, adapters: { 'synthetic-adapter-1': { ...syntheticAdapter(), execute } }, idempotencyRegistry: registry })
    expect(result).toMatchObject({ counts: { blocked: 1 } })
    expect(candidateResult(result).failure?.reasonCode).toBe('IDENTITY_COLLISION')
    expect(execute).not.toHaveBeenCalled()
  })

  it('blocks a tampered identity key before the atomic claim', async () => {
    const plan = planned()
    const execute = vi.fn(async () => syntheticSuccess())
    const tamperedPlan = { ...plan, probes: [{ ...plan.probes[0]!, identityKey: 'different-identity' }] }
    const registry = new SyntheticRegistry()
    const result = await executeVisibilityProbeBatch({ plan: tamperedPlan, adapters: { 'synthetic-adapter-1': { ...syntheticAdapter(), execute } }, idempotencyRegistry: registry })
    expect(result.status).toBe('blocked')
    expect(execute).not.toHaveBeenCalled()
  })

  it('blocks duplicate request fingerprints inside a validated plan', async () => {
    const plan = planned()
    const result = await executeVisibilityProbeBatch({ plan: { ...plan, probes: [plan.probes[0]!, plan.probes[0]!] }, adapters: { 'synthetic-adapter-1': syntheticAdapter() }, idempotencyRegistry: new SyntheticRegistry(), concurrency: 2 })
    expect(result).toMatchObject({ status: 'blocked', reasonCodes: ['DUPLICATE_REQUEST_FINGERPRINT'] })
  })

  it('does not leak idempotency state between injected registries', async () => {
    const plan = planned()
    const firstCalls = vi.fn()
    const secondCalls = vi.fn()
    const firstAdapter = syntheticAdapter({ onCall: firstCalls })
    const secondAdapter = syntheticAdapter({ onCall: secondCalls })
    await executeVisibilityProbeBatch({ plan, adapters: { [firstAdapter.adapterKey]: firstAdapter }, idempotencyRegistry: new SyntheticRegistry() })
    await executeVisibilityProbeBatch({ plan, adapters: { [secondAdapter.adapterKey]: secondAdapter }, idempotencyRegistry: new SyntheticRegistry() })
    expect(firstCalls).toHaveBeenCalledTimes(1)
    expect(secondCalls).toHaveBeenCalledTimes(1)
  })

  it('does not call an adapter after an injected abort signal is already aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    const execute = vi.fn(async () => syntheticSuccess())
    const adapter = { ...syntheticAdapter(), execute }
    const result = await executeVisibilityProbeBatch({ plan: planned(), adapters: { [adapter.adapterKey]: adapter }, idempotencyRegistry: new SyntheticRegistry(), abortSignal: controller.signal })
    expect(result).toMatchObject({ counts: { retryable: 1 } })
    expect(execute).not.toHaveBeenCalled()
  })

  it('passes the injected abort signal to the adapter', async () => {
    const controller = new AbortController()
    let receivedSignal: AbortSignal | undefined
    const adapter = syntheticAdapter({ onCall: input => { receivedSignal = (input as { abortSignal?: AbortSignal }).abortSignal } })
    await executeVisibilityProbeBatch({ plan: planned(), adapters: { [adapter.adapterKey]: adapter }, idempotencyRegistry: new SyntheticRegistry(), abortSignal: controller.signal })
    expect(receivedSignal).toBe(controller.signal)
  })

  it('fails closed when the registry claim operation throws', async () => {
    const registry = { claim: vi.fn(async () => { throw new Error('synthetic registry failure') }), complete: vi.fn(async () => undefined), release: vi.fn(async () => undefined) }
    const result = await executeVisibilityProbeBatch({ plan: planned(), adapters: { 'synthetic-adapter-1': syntheticAdapter() }, idempotencyRegistry: registry })
    expect(result).toMatchObject({ counts: { blocked: 1 } })
    expect(candidateResult(result).failure?.reasonCode).toBe('IDEMPOTENCY_REGISTRY_FAILURE')
  })

  it('fails closed when completing a result throws and releases the claim', async () => {
    const release = vi.fn(async () => undefined)
    const registry = { claim: vi.fn(async () => ({ status: 'acquired' as const, claimToken: 'claim-test' })), complete: vi.fn(async () => { throw new Error('synthetic registry write failure') }), release }
    const result = await executeVisibilityProbeBatch({ plan: planned(), adapters: { 'synthetic-adapter-1': syntheticAdapter() }, idempotencyRegistry: registry })
    expect(result).toMatchObject({ counts: { blocked: 1 } })
    expect(candidateResult(result).failure?.reasonCode).toBe('IDEMPOTENCY_REGISTRY_FAILURE')
    expect(release).toHaveBeenCalledTimes(1)
  })

  it('converts an adapter thrown error into bounded retry metadata without raw error', async () => {
    const adapter = { ...syntheticAdapter(), execute: vi.fn(async () => { throw Object.assign(new Error('secret raw error'), { code: 'ETIMEDOUT' }) }) }
    const result = await executeVisibilityProbeBatch({ plan: planned(), adapters: { [adapter.adapterKey]: adapter }, idempotencyRegistry: new SyntheticRegistry() })
    expect(result).toMatchObject({ counts: { retryable: 1 } })
    expect(candidateResult(result).failure).not.toHaveProperty('message')
    expect(candidateResult(result).failure).not.toHaveProperty('stack')
  })

  it('accepts at most five workers for a valid concurrency', async () => {
    const plan = planned({ activeQuerySnapshots: [syntheticQuery({ queryId: 'q1', promptText: 'q1?' }), syntheticQuery({ queryId: 'q2', promptText: 'q2?' }), syntheticQuery({ queryId: 'q3', promptText: 'q3?' })], maximumProbes: 10 })
    const result = await executeVisibilityProbeBatch({ plan, adapters: { 'synthetic-adapter-1': syntheticAdapter() }, idempotencyRegistry: new SyntheticRegistry(), concurrency: 5 })
    expect(result.counts.completed).toBe(3)
  })

  it('returns explicit counts for every result category', async () => {
    const result = await executeVisibilityProbeBatch({ plan: planned(), adapters: {}, idempotencyRegistry: new SyntheticRegistry() })
    expect(result.counts).toEqual({ completed: 0, blocked: 1, failed: 0, retryable: 0 })
  })
})

describe('LLM Visibility Probe Engine V1 retry policy', () => {
  it.each(failureCases)('classifies %s with no unbounded retry', (_label, error, retryable, reasonCode) => {
    const decision = classifyVisibilityProbeFailure(error)
    expect(decision).toEqual(expect.objectContaining({ retryable, reasonCode }))
    if (retryable) expect(decision.nextDelayCategory).not.toBe('none')
    else expect(decision.nextDelayCategory).toBe('none')
  })

  it.each([[400, false], [401, false], [403, false], [404, false], [409, false], [422, false], [429, true], [500, true], [503, true], [599, true]])('classifies HTTP %s as retryable=%s', (httpStatus, retryable) => {
    expect(classifyVisibilityProbeFailure({ failureKind: 'http_error', httpStatus })).toMatchObject({ retryable })
  })

  it('classifies AbortError as a timeout without exposing the error', () => {
    const decision = classifyVisibilityProbeFailure({ name: 'AbortError', message: 'raw secret' })
    expect(decision).toEqual({ retryable: true, nextDelayCategory: 'medium', reasonCode: 'TIMEOUT_RETRYABLE' })
    expect(decision).not.toHaveProperty('message')
  })

  it('classifies common network codes as short retryable', () => {
    for (const code of ['ENETUNREACH', 'ECONNREFUSED', 'ECONNRESET']) expect(classifyVisibilityProbeFailure({ code })).toMatchObject({ retryable: true, nextDelayCategory: 'short' })
  })

  it('does not sleep or return a duration', () => {
    const decision = classifyVisibilityProbeFailure({ failureKind: 'timeout' })
    expect(decision).not.toHaveProperty('delayMs')
    expect(decision).not.toHaveProperty('sleep')
  })

  it('fails closed for arbitrary unknown values', () => {
    expect(classifyVisibilityProbeFailure(Symbol('unknown'))).toEqual({ retryable: false, nextDelayCategory: 'none', reasonCode: 'UNKNOWN_FAILURE_NOT_RETRYABLE' })
  })
})

describe('LLM Visibility Probe Engine V1 contract safety', () => {
  it('candidate cannot pass the existing owner manual import schema', () => {
    const candidate = completedCandidate()
    expect(ownerManualObservationImportSchema.safeParse(candidate).success).toBe(false)
  })

  it('candidate does not set verifiedByOwner to true', () => {
    expect(completedCandidate().verifiedByOwner).toBe(false)
  })

  it('candidate remains secondary_only and not persisted in V1', () => {
    expect(completedCandidate()).toMatchObject({ metricEligibility: 'secondary_only', persistenceStatus: 'not_persisted_v1' })
  })

  it('candidate explicitly states it is not consumer surface equivalent', () => {
    expect(completedCandidate()).toMatchObject({ consumerSurfaceEquivalent: false, limitationCode: 'provider_api_not_consumer_surface' })
  })

  it('candidate contains no credential or raw response fields', () => {
    const candidate = completedCandidate()
    const serialized = JSON.stringify(candidate)
    expect(serialized).not.toMatch(/Bearer-secret|api[_-]?key|authorization|responseText|rawResponse/i)
    expect(serialized).not.toContain('synthetic-secret')
  })

  it('existing manual import remains provider-mode fail closed before repository access', async () => {
    const repository = {
      getProject: vi.fn(async () => null), getQuery: vi.fn(async () => null), getRun: vi.fn(async () => null), findRunByFingerprint: vi.fn(async () => null), hasObservation: vi.fn(async () => false), commitObservation: vi.fn(async () => ({ runId: 1, observationId: 1 })),
    }
    const providerInput = observationInputSchema.parse({ projectId: 1, queryId: 2, provider: 'chatgpt', modelLabel: 'mock', observationMode: 'provider_api_observation', status: 'completed', observedAt: '2026-08-24T00:00:00.000Z', requestFingerprint: 'b'.repeat(64), limitationCode: 'provider_api_not_consumer_surface', brandMentioned: false, exactMentionCount: 0, firstMentionPosition: null, citedDomain: null, citationUrls: [], competitorMentions: {}, boundedExcerpt: 'synthetic excerpt', responseHash: 'c'.repeat(64), evidenceLocator: 'synthetic-locator', reviewerNote: 'synthetic', verifiedByOwner: true }) as ObservationInput
    await expect(importObservationSnapshot(repository, 7, providerInput, new Date('2026-08-24T01:00:00.000Z'))).rejects.toMatchObject({ statusCode: 422 })
    expect(repository.getProject).not.toHaveBeenCalled()
    expect(repository.commitObservation).not.toHaveBeenCalled()
  })

  it('existing manual schema accepts manual mode but rejects provider mode', () => {
    const manualLike = { observationMode: 'manual_verified', status: 'completed', verifiedByOwner: true }
    const providerLike = { observationMode: 'provider_api_observation', status: 'completed', verifiedByOwner: true }
    expect(ownerManualObservationImportSchema.safeParse(manualLike).success).toBe(false)
    expect(ownerManualObservationImportSchema.safeParse(providerLike).success).toBe(false)
  })

  it('keeps limitation code explicit in every completed candidate', () => {
    expect(completedCandidate().limitationCode).toBe('provider_api_not_consumer_surface')
  })

  it('keeps provider request reference bounded and not raw request body', () => {
    const candidate = completedCandidate()
    expect(candidate.providerRequestId).toBe('request-synthetic-001')
    expect(JSON.stringify(candidate)).not.toContain(candidate.boundedExcerpt.repeat(2))
  })

  it('does not import or call the existing importObservationSnapshot path from the new runner', () => {
    const source = executeVisibilityProbeBatch.toString()
    expect(source).not.toContain('importObservationSnapshot')
  })

  it('keeps the candidate type free of dashboard primary metric claims', () => {
    const candidate = completedCandidate()
    expect(candidate).not.toHaveProperty('searchRanking')
    expect(candidate).not.toHaveProperty('traffic')
    expect(candidate).not.toHaveProperty('conversion')
    expect(candidate).not.toHaveProperty('revenue')
    expect(candidate).not.toHaveProperty('roi')
  })
})


describe('LLM Visibility Probe Engine V1 trust-boundary hardening', () => {
  async function runWithPlan(plan: unknown, execute: ReturnType<typeof vi.fn> = vi.fn(async () => syntheticSuccess()), registry: unknown = new SyntheticRegistry()) {
    return executeVisibilityProbeBatch({ plan, adapters: { 'synthetic-adapter-1': { ...syntheticAdapter(), execute } }, idempotencyRegistry: registry })
  }

  function replayRecord(plan: VisibilityProbePlan, candidateOverrides: Record<string, unknown> = {}, resultOverrides: Record<string, unknown> = {}, recordOverrides: Record<string, unknown> = {}) {
    const probe = plan.probes[0]!
    const candidate = { ...completedCandidate({ plan, probeId: probe.probeId, response: syntheticSuccess() }), ...candidateOverrides }
    return {
      requestFingerprint: plan.probes[0]!.requestFingerprint,
      identityKey: plan.probes[0]!.identityKey,
      result: { probeId: probe.probeId, requestFingerprint: probe.requestFingerprint, status: 'completed', replayed: false, candidate, ...resultOverrides },
      ...recordOverrides,
    }
  }

  function replayRegistry(record: unknown) {
    return { claim: vi.fn(async () => ({ status: 'replay' as const, record })), complete: vi.fn(async () => undefined), release: vi.fn(async () => undefined) }
  }

  it('blocks a normalizedPrompt tamper while preserving old fingerprints', async () => {
    const plan = planned()
    const execute = vi.fn(async () => syntheticSuccess())
    const tampered = { ...plan, probes: [{ ...plan.probes[0]!, normalizedPrompt: 'tampered prompt' }] }
    const result = await runWithPlan(tampered, execute)
    expect(result.status).toBe('blocked')
    expect(execute).not.toHaveBeenCalled()
  })

  it('blocks a non-SHA planFingerprint before adapter execution', async () => {
    const execute = vi.fn(async () => syntheticSuccess())
    const result = await runWithPlan({ ...planned(), planFingerprint: 'not-a-sha' }, execute)
    expect(result).toMatchObject({ status: 'blocked', reasonCodes: ['INVALID_PLAN_FINGERPRINT'] })
    expect(execute).not.toHaveBeenCalled()
  })

  it.each([
    ['requestFingerprint', { requestFingerprint: 'b'.repeat(64) }],
    ['probeId', { probeId: 'c'.repeat(64) }],
    ['identityKey', { identityKey: 'tampered-identity' }],
    ['ownerScopeKey', { ownerScopeKey: 'tampered-scope' }],
    ['projectId', { projectId: 'tampered-project' }],
    ['queryId', { queryId: 'tampered-query' }],
    ['provider', { provider: 'gemini' }],
    ['modelLabel', { modelLabel: 'tampered-model' }],
    ['adapterKey', { adapterKey: 'tampered-adapter' }],
    ['locale', { locale: 'zh-hant' }],
    ['observationWindowKey', { observationWindowKey: 'tampered-window' }],
    ['engineVersion', { provenance: { engineVersion: 'tampered-engine', observationMode: 'provider_api_observation', consumerSurfaceEquivalent: false } }],
  ])('blocks tampered probe lineage: %s', async (_label, patch) => {
    const plan = planned()
    const execute = vi.fn(async () => syntheticSuccess())
    const tampered = { ...plan, probes: [{ ...plan.probes[0]!, ...patch }] }
    const result = await runWithPlan(tampered, execute)
    expect(result.status).toBe('blocked')
    expect(execute).not.toHaveBeenCalled()
  })

  it('blocks changed project brand data while retaining the old plan fingerprint', async () => {
    const plan = planned()
    const result = await runWithPlan({ ...plan, project: { ...plan.project, brandName: 'Other Brand' } })
    expect(result.status).toBe('blocked')
  })

  it.each([
    ['timeoutMs', { timeoutMs: 1 }],
    ['maximumResponseBytes', { maximumResponseBytes: 1 }],
  ])('blocks changed target %s while retaining the old plan fingerprint', async (_label, patch) => {
    const plan = planned()
    const target = plan.providerTargets[0]!
    const result = await runWithPlan({ ...plan, providerTargets: [{ ...target, ...patch }] })
    expect(result.status).toBe('blocked')
  })

  it('blocks a paused target in a supplied plan', async () => {
    const plan = planned()
    const result = await runWithPlan({ ...plan, providerTargets: [{ ...plan.providerTargets[0]!, status: 'paused' }] })
    expect(result).toMatchObject({ status: 'blocked', reasonCodes: ['PAUSED_PROVIDER_TARGET'] })
  })

  it('blocks a target whose locale no longer allows the probe', async () => {
    const plan = planned()
    const result = await runWithPlan({ ...plan, providerTargets: [{ ...plan.providerTargets[0]!, allowedLocales: ['zh-hant'] }] })
    expect(result).toMatchObject({ status: 'blocked', reasonCodes: ['PROBE_TARGET_NOT_ELIGIBLE'] })
  })

  it('blocks an empty probes array and never returns completed with zero counts', async () => {
    const plan = planned()
    const result = await runWithPlan({ ...plan, probes: [] })
    expect(result).toMatchObject({ status: 'blocked', counts: { completed: 0, blocked: 0, failed: 0, retryable: 0 }, results: [] })
  })

  it('blocks an unknown plan key', async () => {
    const result = await runWithPlan({ ...planned(), credential: 'unexpected' })
    expect(result).toMatchObject({ status: 'blocked', reasonCodes: ['MALFORMED_PLAN'] })
  })

  it('blocks an enumerable symbol on a plan', async () => {
    const plan = { ...planned() }
    Object.defineProperty(plan, Symbol('unexpected'), { enumerable: true, value: 'unexpected' })
    const result = await runWithPlan(plan)
    expect(result).toMatchObject({ status: 'blocked', reasonCodes: ['MALFORMED_PLAN'] })
  })

  it('returns bounded blocked output for a throwing plan getter', async () => {
    const plan = { ...planned() }
    Object.defineProperty(plan, 'planFingerprint', { enumerable: true, get() { throw new Error('secret getter stack') } })
    const result = await runWithPlan(plan)
    expect(result.status).toBe('blocked')
    expect(JSON.stringify(result)).not.toContain('secret getter stack')
  })

  it('rejects direct analyzer input that tries to inject project or target', () => {
    const { plan, probe } = firstProbe()
    const result = analyzeProviderObservation({ plan, probeId: probe.probeId, project: syntheticProject(), target: syntheticTarget(), response: syntheticSuccess() })
    expect(result).toMatchObject({ status: 'blocked', reasonCodes: ['MALFORMED_ANALYSIS_INPUT'] })
  })

  it.each([
    '2026-08-24',
    '2026-08-24T00:00:00',
    '2026-02-30T00:00:00Z',
    '',
    42,
  ])('blocks strict timestamp violation %s', observedAt => {
    const result = analyzeProviderObservation(responseInput({}, syntheticSuccess({ observedAt: observedAt as string })))
    expect(result).toMatchObject({ status: 'blocked', reasonCodes: ['MALFORMED_RESPONSE'] })
  })

  it('canonicalizes a timezone-bearing timestamp to UTC', () => {
    const candidate = completedCandidate(responseInput({}, syntheticSuccess({ observedAt: '2026-08-24T08:00:00+08:00' })))
    expect(candidate.observedAt).toBe('2026-08-24T00:00:00.000Z')
  })

  it('canonicalizes a negative timezone offset without reversing its sign', () => {
    const candidate = completedCandidate(responseInput({}, syntheticSuccess({ observedAt: '2026-08-24T08:30:00-05:30' })))
    expect(candidate.observedAt).toBe('2026-08-24T14:00:00.000Z')
  })

  it.each(['2026-08-24T00:00:00+14:01', '2026-08-24T00:00:00-15:00'])('blocks an out-of-range ISO offset %s', observedAt => {
    expect(analyzeProviderObservation(responseInput({}, syntheticSuccess({ observedAt })))).toMatchObject({ status: 'blocked', reasonCodes: ['MALFORMED_RESPONSE'] })
  })

  it('accepts normal multiline provider text while rejecting unsafe control bytes', () => {
    const completed = completedCandidate(responseInput({}, syntheticSuccess({ responseText: 'First paragraph.\n\nAcme is cited in the second paragraph.\tUseful detail.' })))
    expect(completed.brandMentioned).toBe(true)
    expect(completed.boundedExcerpt).toContain('Acme')
    expect(analyzeProviderObservation(responseInput({}, syntheticSuccess({ responseText: 'unsafe\u0000response' })))).toMatchObject({ status: 'blocked', reasonCodes: ['MALFORMED_RESPONSE'] })
  })

  it('uses one canonical code-point surface for whitespace-normalized mention positions and excerpts', () => {
    const candidate = completedCandidate(responseInput({}, syntheticSuccess({ responseText: 'Prefix     text\n\nACME appears here.' })))
    expect(candidate.firstMentionPosition).toBe(13)
    expect(candidate.boundedExcerpt).toBe('Prefix text ACME appears here.')
  })

  it.each([
    ['verifiedByOwner', { verifiedByOwner: true }],
    ['metricEligibility', { metricEligibility: 'primary' }],
    ['persistenceStatus', { persistenceStatus: 'persisted' }],
  ])('rejects forged candidate governance field %s during replay', async (_label, patch) => {
    const plan = planned()
    const result = await runWithPlan(plan, vi.fn(async () => syntheticSuccess()), replayRegistry(replayRecord(plan, patch)))
    expect(result).toMatchObject({ status: 'completed', counts: { blocked: 1 } })
    expect(candidateResult(result).failure?.reasonCode).toBe('IDEMPOTENCY_REPLAY_INVALID')
  })

  it.each([
    ['probeId', { probeId: 'd'.repeat(64) }],
    ['requestFingerprint', { requestFingerprint: 'e'.repeat(64) }],
    ['projectId', { projectId: 'wrong-project' }],
    ['provider', { provider: 'gemini' }],
    ['modelLabel', { modelLabel: 'wrong-model' }],
  ])('rejects replay candidate lineage tamper %s', async (_label, patch) => {
    const plan = planned()
    const result = await runWithPlan(plan, vi.fn(async () => syntheticSuccess()), replayRegistry(replayRecord(plan, patch)))
    expect(result).toMatchObject({ counts: { blocked: 1 } })
    expect(candidateResult(result).replayed).toBe(false)
    expect(candidateResult(result).failure?.reasonCode).toBe('IDEMPOTENCY_REPLAY_INVALID')
  })

  it('validates a complete replay and does not call the adapter', async () => {
    const plan = planned()
    const execute = vi.fn(async () => syntheticSuccess())
    const result = await runWithPlan(plan, execute, replayRegistry(replayRecord(plan)))
    expect(candidateResult(result).replayed).toBe(true)
    expect(execute).not.toHaveBeenCalled()
  })

  it('returns bounded retryable output for an in-progress atomic claim', async () => {
    const execute = vi.fn(async () => syntheticSuccess())
    const registry = { claim: vi.fn(async () => ({ status: 'in_progress' as const })), complete: vi.fn(async () => undefined), release: vi.fn(async () => undefined) }
    const result = await runWithPlan(planned(), execute, registry)
    expect(result).toMatchObject({ counts: { retryable: 1 } })
    expect(candidateResult(result).failure).toEqual({ retryable: true, nextDelayCategory: 'short', reasonCode: 'IDEMPOTENCY_IN_PROGRESS_RETRYABLE' })
    expect(execute).not.toHaveBeenCalled()
  })

  it('uses an atomic claim so concurrent duplicate batches call the adapter exactly once', async () => {
    const plan = planned()
    const registry = new SyntheticRegistry()
    let callCount = 0
    let releaseAdapter!: () => void
    const gate = new Promise<void>(resolve => { releaseAdapter = resolve })
    const adapter = syntheticAdapter({ onCall: async () => { callCount += 1; await gate } })
    const input = { plan, adapters: { [adapter.adapterKey]: adapter }, idempotencyRegistry: registry, concurrency: 1 }
    const first = executeVisibilityProbeBatch(input)
    await new Promise(resolve => setTimeout(resolve, 0))
    const second = executeVisibilityProbeBatch(input)
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(callCount).toBe(1)
    releaseAdapter()
    const [firstResult, secondResult] = await Promise.all([first, second])
    expect(callCount).toBe(1)
    expect([firstResult, secondResult].some(result => result.status === 'completed' && result.results[0]?.status === 'completed' && result.results[0]?.replayed === false)).toBe(true)
    expect([firstResult, secondResult].some(result => result.status === 'completed' && result.results[0]?.status === 'retryable' && result.results[0]?.failure?.reasonCode === 'IDEMPOTENCY_IN_PROGRESS_RETRYABLE')).toBe(true)
  })

  it('enforces the target timeout even when an injected adapter does not implement its own timer', async () => {
    const plan = planned({ providerTargets: [syntheticTarget({ timeoutMs: 10 })] })
    let receivedSignal: AbortSignal | undefined
    const adapter = syntheticAdapter({
      onCall: async input => {
        receivedSignal = (input as { abortSignal?: AbortSignal }).abortSignal
        await new Promise<void>(() => undefined)
      },
    })
    const result = await executeVisibilityProbeBatch({ plan, adapters: { [adapter.adapterKey]: adapter }, idempotencyRegistry: new SyntheticRegistry() })
    expect(candidateResult(result)).toMatchObject({ status: 'retryable', failure: { reasonCode: 'TIMEOUT_RETRYABLE' } })
    expect(receivedSignal?.aborted).toBe(true)
  })

  it('does not call the adapter for a claim collision', async () => {
    const execute = vi.fn(async () => syntheticSuccess())
    const registry = { claim: vi.fn(async () => ({ status: 'collision' as const })), complete: vi.fn(async () => undefined), release: vi.fn(async () => undefined) }
    const result = await runWithPlan(planned(), execute, registry)
    expect(result).toMatchObject({ counts: { blocked: 1 } })
    expect(candidateResult(result).failure?.reasonCode).toBe('IDENTITY_COLLISION')
    expect(execute).not.toHaveBeenCalled()
  })

  it('converts release exceptions to bounded registry failure without raw error', async () => {
    const adapter = syntheticAdapter({ result: { ok: false, failureKind: 'timeout', retryable: true, code: 'TIMEOUT' } })
    const registry = { claim: vi.fn(async () => ({ status: 'acquired' as const, claimToken: 'claim-test' })), complete: vi.fn(async () => undefined), release: vi.fn(async () => { throw new Error('secret release stack') }) }
    const result = await executeVisibilityProbeBatch({ plan: planned(), adapters: { [adapter.adapterKey]: adapter }, idempotencyRegistry: registry })
    expect(result).toMatchObject({ counts: { blocked: 1 } })
    expect(candidateResult(result).failure?.reasonCode).toBe('IDEMPOTENCY_REGISTRY_FAILURE')
    expect(JSON.stringify(result)).not.toContain('secret release stack')
  })

  it('blocks response extra keys before analysis', () => {
    const response = { ...syntheticSuccess(), credential: 'unexpected' }
    const result = analyzeProviderObservation(responseInput({}, response))
    expect(result).toMatchObject({ status: 'blocked', reasonCodes: ['MALFORMED_RESPONSE'] })
  })

  it('blocks inconsistent response token metadata', () => {
    const result = analyzeProviderObservation(responseInput({}, syntheticSuccess({ responseMetadata: { inputTokens: 1, outputTokens: 2, totalTokens: 99 } })))
    expect(result).toMatchObject({ status: 'blocked', reasonCodes: ['MALFORMED_RESPONSE_METADATA'] })
  })

  it('blocks a response metadata enumerable symbol', () => {
    const metadata = { inputTokens: 1 }
    Object.defineProperty(metadata, Symbol('metadata'), { enumerable: true, value: 2 })
    const result = analyzeProviderObservation(responseInput({}, syntheticSuccess({ responseMetadata: metadata as never })))
    expect(result).toMatchObject({ status: 'blocked', reasonCodes: ['MALFORMED_RESPONSE_METADATA'] })
  })

  it('bounds a throwing response metadata getter', () => {
    const metadata = {}
    Object.defineProperty(metadata, 'inputTokens', { enumerable: true, get() { throw new Error('secret metadata stack') } })
    const result = analyzeProviderObservation(responseInput({}, syntheticSuccess({ responseMetadata: metadata as never })))
    expect(result).toMatchObject({ status: 'blocked' })
    expect(JSON.stringify(result)).not.toContain('secret metadata stack')
  })

  it('uses the complete response hash in the evidence locator', () => {
    const candidate = completedCandidate()
    expect(candidate.evidenceLocator).toBe(buildEvidenceLocator(planned().probes[0]!, candidate.responseHash))
    expect(candidate.evidenceLocator.endsWith(candidate.responseHash)).toBe(true)
  })

  it('keeps evidence locators distinct when only the hash suffix differs', () => {
    const probe = planned().probes[0]!
    const left = buildEvidenceLocator(probe, `${'a'.repeat(16)}${'b'.repeat(48)}`)
    const right = buildEvidenceLocator(probe, `${'a'.repeat(16)}${'c'.repeat(48)}`)
    expect(left).not.toBe(right)
  })

  it('uses a code-point position and excerpt around a brand after 400 emoji', () => {
    const responseText = `${'🙂'.repeat(400)} Acme appears after emoji.`
    const candidate = completedCandidate(responseInput({}, syntheticSuccess({ responseText })))
    expect(candidate.brandMentioned).toBe(true)
    expect(candidate.firstMentionPosition).toBe(402)
    expect(candidate.boundedExcerpt).toContain('Acme')
    expect(Array.from(candidate.boundedExcerpt).length).toBeLessThanOrEqual(1000)
  })

  it('produces identical plan fingerprints and ordering for canonical input array reorder', () => {
    const project = { ...syntheticProject(), brandAliases: ['Acme Inc', 'Acme Corporation'], competitorBrands: ['RivalCo', 'OtherBrand'] }
    const reversedProject = { ...project, brandAliases: [...project.brandAliases].reverse(), competitorBrands: [...project.competitorBrands].reverse() }
    const queries = [syntheticQuery({ queryId: 'query-1', promptText: 'First question?' }), syntheticQuery({ queryId: 'query-2', promptText: 'Second question?' })]
    const reversedQueries = [...queries].reverse()
    const targetOne = syntheticTarget({ allowedLocales: ['en', 'zh-hant'] })
    const targetTwo = syntheticTarget({ provider: 'gemini', modelLabel: 'gemini-model', adapterKey: 'gemini-adapter', allowedLocales: ['zh-hant', 'en'] })
    const first = planned({ project, activeQuerySnapshots: queries, providerTargets: [targetOne, targetTwo], maximumProbes: 10 })
    const second = planned({ project: reversedProject, activeQuerySnapshots: reversedQueries, providerTargets: [targetTwo, targetOne], maximumProbes: 10 })
    expect(second.planFingerprint).toBe(first.planFingerprint)
    expect(second.probes.map(probe => probe.probeId)).toEqual(first.probes.map(probe => probe.probeId))
  })

  it('blocks a runner top-level credential-like extra key', async () => {
    const plan = planned()
    const execute = vi.fn(async () => syntheticSuccess())
    const result = await executeVisibilityProbeBatch({ plan, adapters: { 'synthetic-adapter-1': syntheticAdapter({ execute } as never) }, idempotencyRegistry: new SyntheticRegistry(), authorization: 'unexpected' } as unknown)
    expect(result).toMatchObject({ status: 'blocked', reasonCodes: ['MALFORMED_RUNNER_INPUT'] })
    expect(execute).not.toHaveBeenCalled()
  })

  it('keeps completed candidates unable to pass the owner manual import schema after hardening', () => {
    const candidate = completedCandidate()
    expect(ownerManualObservationImportSchema.safeParse(candidate).success).toBe(false)
  })
})

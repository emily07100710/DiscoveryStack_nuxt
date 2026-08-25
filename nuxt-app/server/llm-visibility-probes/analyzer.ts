import {
  analyzeMentionFields,
  buildBoundedExcerpt,
  buildEvidenceLocator,
  byteLength,
  hashText,
  hasExactKeys,
  normalizeAdapterSuccessResponse,
  normalizeCanonicalHash,
  normalizeObservationCandidate,
  normalizeVisibilityProbePlan,
  resolveCitedDomain,
} from './normalization'
import { PROBE_LIMITATION_CODE, type ObservationCandidate, type ProbeAnalysisInput, type ProbeAnalysisResult, type ProviderTarget, type VisibilityProbe, type VisibilityProbePlan } from './types'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function read(record: Record<string, unknown>, key: string): unknown {
  try { return record[key] } catch { throw new Error('UNSAFE_INPUT') }
}

function blocked(reasonCodes: string[]): ProbeAnalysisResult {
  return { status: 'blocked', reasonCodes: [...new Set(reasonCodes)], limitationCode: 'provider_observation_invalid' }
}

const PLAN_SAFE_REASONS = new Set([
  'MALFORMED_PLAN', 'MALFORMED_PLAN_STATUS', 'ENGINE_VERSION_MISMATCH', 'MALFORMED_PLAN_LIMITATION', 'INVALID_MAXIMUM_PROBES',
  'MALFORMED_PROJECT', 'MALFORMED_PROVIDER_TARGET_LIST', 'MALFORMED_PROVIDER_TARGET', 'PAUSED_PROVIDER_TARGET', 'DUPLICATE_PROVIDER_TARGET',
  'INVALID_PROBE_COUNT', 'MALFORMED_PROBE', 'INVALID_PROBE_ID', 'INVALID_REQUEST_FINGERPRINT', 'PROBE_OWNER_SCOPE_MISMATCH',
  'PROBE_PROJECT_MISMATCH', 'PROBE_LOCALE_MISMATCH', 'PROBE_WINDOW_MISMATCH', 'PROBE_ENGINE_VERSION_MISMATCH', 'PROBE_GOVERNANCE_MISMATCH',
  'PROBE_TARGET_MISMATCH', 'PROBE_TARGET_NOT_ELIGIBLE', 'PROBE_IDENTITY_KEY_MISMATCH', 'PROBE_REQUEST_FINGERPRINT_MISMATCH',
  'PROBE_ID_MISMATCH', 'DUPLICATE_REQUEST_FINGERPRINT', 'DUPLICATE_PROBE_ID', 'DUPLICATE_IDENTITY_KEY', 'INVALID_PLAN_FINGERPRINT',
  'PLAN_FINGERPRINT_MISMATCH',
])

const RESPONSE_SAFE_REASONS = new Set([
  'MALFORMED_RESPONSE', 'RESPONSE_TOO_LARGE', 'CITATION_VALIDATION_FAILURE', 'MALFORMED_RESPONSE_METADATA', 'MALFORMED_PROVIDER_REQUEST_ID',
  'INVALID_RESPONSE_HASH', 'MALFORMED_CANDIDATE', 'CANDIDATE_LINEAGE_MISMATCH', 'CANDIDATE_GOVERNANCE_MISMATCH', 'UNSAFE_INPUT',
])

function safePlanReason(error: unknown): string {
  return error instanceof Error && PLAN_SAFE_REASONS.has(error.message) ? error.message : 'MALFORMED_PLAN'
}

function safeResponseReason(error: unknown): string {
  return error instanceof Error && RESPONSE_SAFE_REASONS.has(error.message) ? error.message : 'MALFORMED_RESPONSE'
}

function locateProbe(plan: VisibilityProbePlan, probeId: string): VisibilityProbe {
  const matches = plan.probes.filter(probe => probe.probeId === probeId)
  if (matches.length !== 1) throw new Error('PROBE_NOT_FOUND')
  return matches[0]!
}

function locateTarget(plan: VisibilityProbePlan, probe: VisibilityProbe): ProviderTarget {
  const matches = plan.providerTargets.filter(target => target.provider === probe.provider && target.modelLabel === probe.modelLabel && target.adapterKey === probe.adapterKey)
  if (matches.length !== 1 || matches[0]!.status !== 'active' || !matches[0]!.allowedLocales.includes(probe.locale)) throw new Error('PROBE_TARGET_NOT_ELIGIBLE')
  return matches[0]!
}

export function analyzeProviderObservation(input: unknown): ProbeAnalysisResult {
  if (!isRecord(input) || !hasExactKeys(input, ['plan', 'probeId', 'response'])) return blocked(['MALFORMED_ANALYSIS_INPUT'])
  let plan: VisibilityProbePlan
  let probeId: string
  try {
    plan = normalizeVisibilityProbePlan(read(input, 'plan'))
    probeId = normalizeCanonicalHash(read(input, 'probeId'), 'INVALID_PROBE_ID')
  } catch (error: unknown) {
    return blocked([safePlanReason(error)])
  }
  let probe: VisibilityProbe
  let target: ProviderTarget
  try {
    probe = locateProbe(plan, probeId)
    target = locateTarget(plan, probe)
  } catch (error: unknown) {
    return blocked([error instanceof Error && error.message === 'PROBE_TARGET_NOT_ELIGIBLE' ? 'PROBE_TARGET_NOT_ELIGIBLE' : 'PROBE_NOT_FOUND'])
  }
  try {
    const response = normalizeAdapterSuccessResponse(read(input, 'response'))
    if (response.provider !== probe.provider || response.provider !== target.provider || response.modelLabel !== probe.modelLabel || response.modelLabel !== target.modelLabel) return blocked(['PROVIDER_MODEL_MISMATCH'])
    if (byteLength(response.responseText) > target.maximumResponseBytes) throw new Error('RESPONSE_TOO_LARGE')
    const responseHash = hashText(response.responseText)
    normalizeCanonicalHash(responseHash, 'INVALID_RESPONSE_HASH')
    const mentions = analyzeMentionFields(response.responseText, plan.project)
    const candidate: ObservationCandidate = {
      probeId: probe.probeId,
      requestFingerprint: probe.requestFingerprint,
      planFingerprint: plan.planFingerprint,
      ownerScopeKey: plan.ownerScopeKey,
      projectId: plan.project.projectId,
      queryId: probe.queryId,
      provider: probe.provider,
      modelLabel: probe.modelLabel,
      observationWindowKey: plan.observationWindowKey,
      observationMode: 'provider_api_observation',
      verifiedByOwner: false,
      status: 'completed',
      metricEligibility: 'secondary_only',
      consumerSurfaceEquivalent: false,
      limitationCode: PROBE_LIMITATION_CODE,
      persistenceStatus: 'not_persisted_v1',
      responseHash,
      boundedExcerpt: buildBoundedExcerpt(response.responseText, plan.project),
      ...mentions,
      citationUrls: response.citationUrls,
      citedDomain: resolveCitedDomain(response.citationUrls, plan.project.canonicalWebsiteDomain),
      ...(response.providerRequestId === undefined ? {} : { providerRequestId: response.providerRequestId }),
      evidenceLocator: buildEvidenceLocator(probe, responseHash),
      observedAt: response.observedAt,
      provenance: {
        adapterKey: target.adapterKey,
        engineVersion: plan.engineVersion,
        ...(response.responseMetadata === undefined ? {} : { responseMetadata: response.responseMetadata }),
      },
    }
    return { status: 'completed', candidate: normalizeObservationCandidate(candidate, { plan, probe, target }) }
  } catch (error: unknown) {
    return blocked([safeResponseReason(error)])
  }
}

export type { ProbeAnalysisInput }

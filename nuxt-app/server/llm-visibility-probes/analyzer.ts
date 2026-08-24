import {
  analyzeMentionFields,
  buildBoundedExcerpt,
  buildEvidenceLocator,
  byteLength,
  hashText,
  normalizeCanonicalHash,
  normalizeCitationUrls,
  normalizeObservedAt,
  normalizeProviderRequestId,
  normalizeResponseMetadata,
  resolveCitedDomain,
} from './normalization'
import { PROBE_LIMITATION_CODE, type ObservationCandidate, type ProbeAnalysisResult, type ProjectIdentity, type ProviderTarget, type VisibilityProbe } from './types'

type ProviderSuccessInput = {
  probe: VisibilityProbe
  project: ProjectIdentity
  target: ProviderTarget
  response: unknown
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function read(record: Record<string, unknown>, key: string): unknown {
  try { return record[key] } catch { throw new Error('MALFORMED_RESPONSE') }
}

function blocked(reasonCodes: string[]): ProbeAnalysisResult {
  return { status: 'blocked', reasonCodes: [...new Set(reasonCodes)].sort(), limitationCode: 'provider_observation_invalid' }
}

function candidateKeys(value: Record<string, unknown>): boolean {
  const allowed = new Set(['ok', 'provider', 'modelLabel', 'responseText', 'citationUrls', 'observedAt', 'providerRequestId', 'responseMetadata'])
  try {
    const keys = Object.keys(value)
    const symbols = Object.getOwnPropertySymbols(value).filter(symbol => Object.prototype.propertyIsEnumerable.call(value, symbol))
    return symbols.length === 0 && keys.every(key => allowed.has(key))
  } catch { return false }
}

function safeReason(error: unknown): string {
  if (!(error instanceof Error)) return 'MALFORMED_RESPONSE'
  const allowed = new Set(['MALFORMED_RESPONSE', 'RESPONSE_TOO_LARGE', 'CITATION_VALIDATION_FAILURE', 'MALFORMED_RESPONSE_METADATA', 'MALFORMED_PROVIDER_REQUEST_ID', 'INVALID_RESPONSE_HASH'])
  return allowed.has(error.message) ? error.message : 'MALFORMED_RESPONSE'
}

export function analyzeProviderObservation(input: unknown): ProbeAnalysisResult {
  if (!isRecord(input)) return blocked(['MALFORMED_ANALYSIS_INPUT'])
  let probe: VisibilityProbe
  let project: ProjectIdentity
  let target: ProviderTarget
  let response: unknown
  try {
    probe = read(input, 'probe') as VisibilityProbe
    project = read(input, 'project') as ProjectIdentity
    target = read(input, 'target') as ProviderTarget
    response = read(input, 'response')
  } catch { return blocked(['MALFORMED_ANALYSIS_INPUT']) }
  if (!isRecord(response) || !candidateKeys(response) || read(response, 'ok') !== true) return blocked(['MALFORMED_RESPONSE'])
  try {
    if (read(response, 'provider') !== probe.provider || read(response, 'provider') !== target.provider || read(response, 'modelLabel') !== probe.modelLabel || read(response, 'modelLabel') !== target.modelLabel) return blocked(['PROVIDER_MODEL_MISMATCH'])
    const responseText = read(response, 'responseText')
    if (typeof responseText !== 'string' || !responseText || responseText !== responseText.normalize('NFKC')) throw new Error('MALFORMED_RESPONSE')
    if (byteLength(responseText) > target.maximumResponseBytes) throw new Error('RESPONSE_TOO_LARGE')
    const responseHash = hashText(responseText)
    normalizeCanonicalHash(responseHash, 'INVALID_RESPONSE_HASH')
    const citationUrls = normalizeCitationUrls(read(response, 'citationUrls'))
    const observedAt = normalizeObservedAt(read(response, 'observedAt'))
    const providerRequestId = normalizeProviderRequestId(read(response, 'providerRequestId'))
    const responseMetadata = normalizeResponseMetadata(read(response, 'responseMetadata'))
    const mentions = analyzeMentionFields(responseText, project)
    const boundedExcerpt = buildBoundedExcerpt(responseText, project)
    const candidate: ObservationCandidate = {
      probeId: probe.probeId,
      requestFingerprint: probe.requestFingerprint,
      projectId: probe.projectId,
      queryId: probe.queryId,
      provider: probe.provider,
      modelLabel: probe.modelLabel,
      observationMode: 'provider_api_observation',
      verifiedByOwner: false,
      status: 'completed',
      metricEligibility: 'secondary_only',
      consumerSurfaceEquivalent: false,
      limitationCode: PROBE_LIMITATION_CODE,
      persistenceStatus: 'not_persisted_v1',
      responseHash,
      boundedExcerpt,
      ...mentions,
      citationUrls,
      citedDomain: resolveCitedDomain(citationUrls, project.canonicalWebsiteDomain),
      providerRequestId,
      evidenceLocator: buildEvidenceLocator(probe, responseHash),
      observedAt,
      provenance: { adapterKey: target.adapterKey, engineVersion: probe.provenance.engineVersion, responseMetadata },
    }
    return { status: 'completed', candidate }
  } catch (error: unknown) {
    return blocked([safeReason(error)])
  }
}

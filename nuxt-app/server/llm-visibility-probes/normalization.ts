import { createHash } from 'node:crypto'
import { canonicalBrandKey } from '../llm-visibility/service'
import { canonicalizePublicHttps, canonicalHostname, normalizedPromptHash } from '../llm-visibility/guards'
import { countBrandMentions, countCompetitorMentions, normalizeMatchText } from '../llm-visibility/matching'
import {
  PROBE_ENGINE_VERSION,
  PROBE_LIMITATION_CODE,
  PROBE_LOCALES,
  PROBE_PROVIDERS,
  PROBE_TARGET_STATUSES,
  type AdapterResponseMetadata,
  type ObservationCandidate,
  type ProbeLocale,
  type ProbePlanInput,
  type ProbeProvider,
  type ProjectIdentity,
  type ProviderTarget,
  type QuerySnapshot,
  type VisibilityProbe,
} from './types'

export const MAX_PROBES = 50
export const MAX_PROVIDER_TARGETS = 12
export const MAX_QUERY_SNAPSHOTS = 100
export const MAX_RESPONSE_METADATA_KEYS = 4
export const MAX_EXCERPT_CHARS = 1000
export const MIN_TIMEOUT_MS = 1
export const MAX_TIMEOUT_MS = 120_000
export const MIN_RESPONSE_BYTES = 1
export const MAX_RESPONSE_BYTES = 2_000_000

export type NormalizationFailure = { reasonCode: string }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function ownKeys(value: object): string[] {
  try { return Object.keys(value) } catch { throw new Error('unsafe_object') }
}

function ownSymbols(value: object): symbol[] {
  try { return Object.getOwnPropertySymbols(value).filter(symbol => Object.prototype.propertyIsEnumerable.call(value, symbol)) } catch { throw new Error('unsafe_object') }
}

function read(value: Record<string, unknown>, key: string): unknown {
  try { return value[key] } catch { throw new Error('unsafe_getter') }
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = ownKeys(value).sort()
  return ownSymbols(value).length === 0 && keys.length === expected.length && keys.every((key, index) => key === [...expected].sort()[index])
}

function normalizeText(value: unknown, maxLength: number, reasonCode: string): string {
  if (typeof value !== 'string') throw new Error(reasonCode)
  const normalized = value.normalize('NFKC').trim().replace(/\s+/gu, ' ')
  if (!normalized || normalized.length > maxLength || /[\u0000-\u001f\u007f]/u.test(normalized)) throw new Error(reasonCode)
  return normalized
}

export function normalizeOpaqueIdentifier(value: unknown, maxLength = 160, reasonCode = 'INVALID_IDENTIFIER'): string {
  if (typeof value !== 'string' || value !== value.normalize('NFKC') || value !== value.trim()) throw new Error(reasonCode)
  if (!value || value.length > maxLength || /[\u0000-\u001f\u007f]/u.test(value) || /[\s@/\\?#()[\]{}<>"']/u.test(value)) throw new Error(reasonCode)
  return value
}

export function normalizeCanonicalHash(value: unknown, reasonCode = 'INVALID_HASH'): string {
  if (typeof value !== 'string') throw new Error(reasonCode)
  if (!/^[a-f0-9]{64}$/u.test(value)) throw new Error(/^[a-f0-9]{64}$/u.test(value.toLowerCase()) ? 'NON_CANONICAL_HASH' : reasonCode)
  return value
}

export function normalizePrompt(value: unknown): string {
  return normalizeText(value, 2000, 'INVALID_PROMPT')
}

export function hashText(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function stableSerialize(value: unknown, seen = new Set<object>()): string {
  if (value === null) return 'null'
  if (typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('NON_FINITE_CANONICAL_VALUE')
    return JSON.stringify(value)
  }
  if (typeof value !== 'object') throw new Error('INVALID_CANONICAL_VALUE')
  if (seen.has(value)) throw new Error('CYCLIC_CANONICAL_VALUE')
  seen.add(value)
  let result: string
  if (Array.isArray(value)) {
    result = `[${value.map(item => stableSerialize(item, seen)).join(',')}]`
  } else {
    const record = value as Record<string, unknown>
    result = `{${ownKeys(record).sort().map(key => `${JSON.stringify(key)}:${stableSerialize(read(record, key), seen)}`).join(',')}}`
  }
  seen.delete(value)
  return result
}

export function canonicalFingerprint(value: unknown): string {
  return hashText(stableSerialize(value))
}

function normalizeLocale(value: unknown, reasonCode = 'UNSUPPORTED_LOCALE'): ProbeLocale {
  if (typeof value !== 'string' || !(PROBE_LOCALES as readonly string[]).includes(value)) throw new Error(reasonCode)
  return value as ProbeLocale
}

function normalizeProvider(value: unknown): ProbeProvider {
  if (typeof value !== 'string' || !(PROBE_PROVIDERS as readonly string[]).includes(value)) throw new Error('UNSUPPORTED_PROVIDER')
  return value as ProbeProvider
}

function normalizeProject(value: unknown): ProjectIdentity {
  if (!isRecord(value) || !exactKeys(value, ['projectId', 'canonicalWebsiteDomain', 'brandName', 'brandAliases', 'competitorBrands', 'locale'])) throw new Error('MALFORMED_PROJECT')
  const projectId = normalizeOpaqueIdentifier(read(value, 'projectId'), 120, 'MALFORMED_PROJECT')
  const canonicalWebsiteDomain = canonicalHostname(normalizeText(read(value, 'canonicalWebsiteDomain'), 253, 'MALFORMED_PROJECT'))
  const brandName = normalizeText(read(value, 'brandName'), 160, 'MALFORMED_PROJECT')
  const brandAliases = normalizeStringList(read(value, 'brandAliases'), 30, 160, 'MALFORMED_PROJECT')
  const competitorBrands = normalizeStringList(read(value, 'competitorBrands'), 30, 160, 'MALFORMED_PROJECT')
  const brandKeys = new Set([canonicalBrandKey(brandName), ...brandAliases.map(canonicalBrandKey)])
  if (competitorBrands.some(competitor => brandKeys.has(canonicalBrandKey(competitor)))) throw new Error('BRAND_COMPETITOR_COLLISION')
  return { projectId, canonicalWebsiteDomain, brandName, brandAliases, competitorBrands, locale: normalizeLocale(read(value, 'locale'), 'MALFORMED_PROJECT') }
}

function normalizeStringList(value: unknown, maxItems: number, maxLength: number, reasonCode: string): string[] {
  if (!Array.isArray(value) || value.length > maxItems) throw new Error(reasonCode)
  const result = value.map(item => normalizeText(item, maxLength, reasonCode))
  const keys = result.map(canonicalBrandKey)
  if (new Set(keys).size !== keys.length) throw new Error(reasonCode)
  return result
}

function normalizeProviderTarget(value: unknown): ProviderTarget {
  if (!isRecord(value) || !exactKeys(value, ['provider', 'modelLabel', 'adapterKey', 'status', 'allowedLocales', 'maximumResponseBytes', 'timeoutMs'])) throw new Error('MALFORMED_PROVIDER_TARGET')
  const allowedLocalesRaw = read(value, 'allowedLocales')
  if (!Array.isArray(allowedLocalesRaw) || !allowedLocalesRaw.length || allowedLocalesRaw.length > PROBE_LOCALES.length) throw new Error('MALFORMED_PROVIDER_TARGET')
  const allowedLocales = allowedLocalesRaw.map(item => normalizeLocale(item))
  if (new Set(allowedLocales).size !== allowedLocales.length) throw new Error('MALFORMED_PROVIDER_TARGET')
  const maximumResponseBytes = read(value, 'maximumResponseBytes')
  const timeoutMs = read(value, 'timeoutMs')
  if (typeof maximumResponseBytes !== 'number' || !Number.isInteger(maximumResponseBytes) || maximumResponseBytes < MIN_RESPONSE_BYTES || maximumResponseBytes > MAX_RESPONSE_BYTES) throw new Error('MALFORMED_PROVIDER_TARGET')
  if (typeof timeoutMs !== 'number' || !Number.isInteger(timeoutMs) || timeoutMs < MIN_TIMEOUT_MS || timeoutMs > MAX_TIMEOUT_MS) throw new Error('MALFORMED_PROVIDER_TARGET')
  const status = read(value, 'status')
  if (typeof status !== 'string' || !(PROBE_TARGET_STATUSES as readonly string[]).includes(status)) throw new Error('MALFORMED_PROVIDER_TARGET')
  return {
    provider: normalizeProvider(read(value, 'provider')),
    modelLabel: normalizeText(read(value, 'modelLabel'), 160, 'MALFORMED_PROVIDER_TARGET'),
    adapterKey: normalizeOpaqueIdentifier(read(value, 'adapterKey'), 120, 'MALFORMED_PROVIDER_TARGET'),
    status: status as ProviderTarget['status'],
    allowedLocales,
    maximumResponseBytes,
    timeoutMs,
  }
}

function normalizeQuerySnapshot(value: unknown): QuerySnapshot {
  if (!isRecord(value) || !exactKeys(value, ['queryId', 'projectId', 'promptText', 'promptHash', 'intent', 'locale', 'active'])) throw new Error('MALFORMED_QUERY')
  const promptText = normalizePrompt(read(value, 'promptText'))
  const promptHash = normalizeCanonicalHash(read(value, 'promptHash'), 'INVALID_PROMPT_HASH')
  if (promptHash !== normalizedPromptHash(promptText)) throw new Error('PROMPT_HASH_MISMATCH')
  if (typeof read(value, 'active') !== 'boolean') throw new Error('MALFORMED_QUERY')
  return {
    queryId: normalizeOpaqueIdentifier(read(value, 'queryId'), 120, 'MALFORMED_QUERY'),
    projectId: normalizeOpaqueIdentifier(read(value, 'projectId'), 120, 'MALFORMED_QUERY'),
    promptText,
    promptHash,
    intent: normalizeText(read(value, 'intent'), 120, 'MALFORMED_QUERY'),
    locale: normalizeLocale(read(value, 'locale')),
    active: read(value, 'active') as boolean,
  }
}

export function normalizeProbePlanInput(value: unknown): ProbePlanInput {
  if (!isRecord(value) || !exactKeys(value, ['ownerScopeKey', 'project', 'activeQuerySnapshots', 'providerTargets', 'observationWindowKey', 'maximumProbes', 'engineVersion'])) throw new Error('MALFORMED_PLAN_INPUT')
  const maximumProbes = read(value, 'maximumProbes')
  if (typeof maximumProbes !== 'number' || !Number.isInteger(maximumProbes) || maximumProbes < 1 || maximumProbes > MAX_PROBES) throw new Error('INVALID_MAXIMUM_PROBES')
  const activeQuerySnapshots = read(value, 'activeQuerySnapshots')
  const providerTargets = read(value, 'providerTargets')
  if (!Array.isArray(activeQuerySnapshots) || activeQuerySnapshots.length > MAX_QUERY_SNAPSHOTS) throw new Error('MALFORMED_QUERY_LIST')
  if (!Array.isArray(providerTargets) || providerTargets.length > MAX_PROVIDER_TARGETS) throw new Error('MALFORMED_PROVIDER_TARGET_LIST')
  const project = normalizeProject(read(value, 'project'))
  const queries = activeQuerySnapshots.map(normalizeQuerySnapshot)
  const targets = providerTargets.map(normalizeProviderTarget)
  if (queries.some(query => query.projectId !== project.projectId)) throw new Error('OWNER_PROJECT_QUERY_MISMATCH')
  if (targets.some(target => target.provider === 'chatgpt' && target.modelLabel.length === 0)) throw new Error('MALFORMED_PROVIDER_TARGET')
  return {
    ownerScopeKey: normalizeOpaqueIdentifier(read(value, 'ownerScopeKey'), 160, 'MALFORMED_PLAN_INPUT'),
    project,
    activeQuerySnapshots: queries,
    providerTargets: targets,
    observationWindowKey: normalizeOpaqueIdentifier(read(value, 'observationWindowKey'), 160, 'MALFORMED_PLAN_INPUT'),
    maximumProbes,
    engineVersion: normalizeOpaqueIdentifier(read(value, 'engineVersion'), 120, 'MALFORMED_PLAN_INPUT'),
  }
}

export function canonicalProbeIdentity(probe: Pick<VisibilityProbe, 'ownerScopeKey' | 'projectId' | 'queryId' | 'provider' | 'modelLabel' | 'locale' | 'observationWindowKey'>, promptHash: string, engineVersion: string): string {
  return canonicalFingerprint({ engineVersion, ownerScopeKey: probe.ownerScopeKey, projectId: probe.projectId, queryId: probe.queryId, queryHash: promptHash, provider: probe.provider, modelLabel: probe.modelLabel, locale: probe.locale, observationWindowKey: probe.observationWindowKey })
}

export function normalizeProbe(value: unknown): VisibilityProbe {
  if (!isRecord(value) || !exactKeys(value, ['probeId', 'requestFingerprint', 'identityKey', 'ownerScopeKey', 'projectId', 'queryId', 'provider', 'modelLabel', 'adapterKey', 'locale', 'normalizedPrompt', 'observationWindowKey', 'limitationCode', 'provenance', 'status'])) throw new Error('MALFORMED_PROBE')
  const provenance = read(value, 'provenance')
  if (!isRecord(provenance) || !exactKeys(provenance, ['engineVersion', 'observationMode', 'consumerSurfaceEquivalent']) || read(provenance, 'observationMode') !== 'provider_api_observation' || read(provenance, 'consumerSurfaceEquivalent') !== false) throw new Error('MALFORMED_PROBE')
  if (read(value, 'status') !== 'planned' || read(value, 'limitationCode') !== PROBE_LIMITATION_CODE) throw new Error('MALFORMED_PROBE')
  return {
    probeId: normalizeCanonicalHash(read(value, 'probeId'), 'INVALID_PROBE_ID'),
    requestFingerprint: normalizeCanonicalHash(read(value, 'requestFingerprint'), 'INVALID_REQUEST_FINGERPRINT'),
    identityKey: normalizeOpaqueIdentifier(read(value, 'identityKey'), 500, 'MALFORMED_PROBE'),
    ownerScopeKey: normalizeOpaqueIdentifier(read(value, 'ownerScopeKey'), 160, 'MALFORMED_PROBE'),
    projectId: normalizeOpaqueIdentifier(read(value, 'projectId'), 120, 'MALFORMED_PROBE'),
    queryId: normalizeOpaqueIdentifier(read(value, 'queryId'), 120, 'MALFORMED_PROBE'),
    provider: normalizeProvider(read(value, 'provider')),
    modelLabel: normalizeText(read(value, 'modelLabel'), 160, 'MALFORMED_PROBE'),
    adapterKey: normalizeOpaqueIdentifier(read(value, 'adapterKey'), 120, 'MALFORMED_PROBE'),
    locale: normalizeLocale(read(value, 'locale')),
    normalizedPrompt: normalizePrompt(read(value, 'normalizedPrompt')),
    observationWindowKey: normalizeOpaqueIdentifier(read(value, 'observationWindowKey'), 160, 'MALFORMED_PROBE'),
    limitationCode: PROBE_LIMITATION_CODE,
    provenance: { engineVersion: normalizeOpaqueIdentifier(read(provenance, 'engineVersion'), 120, 'MALFORMED_PROBE'), observationMode: 'provider_api_observation', consumerSurfaceEquivalent: false },
    status: 'planned',
  }
}

export function normalizeProviderRequestId(value: unknown): string | undefined {
  if (value === undefined) return undefined
  return normalizeOpaqueIdentifier(value, 160, 'MALFORMED_PROVIDER_REQUEST_ID')
}

export function normalizeResponseMetadata(value: unknown): AdapterResponseMetadata | undefined {
  if (value === undefined) return undefined
  if (!isRecord(value) || ownSymbols(value).length || ownKeys(value).some(key => !['finishReason', 'inputTokens', 'outputTokens', 'totalTokens'].includes(key)) || ownKeys(value).length > MAX_RESPONSE_METADATA_KEYS) throw new Error('MALFORMED_RESPONSE_METADATA')
  const result: AdapterResponseMetadata = {}
  for (const key of ownKeys(value)) {
    const item = read(value, key)
    if (key === 'finishReason') {
      result.finishReason = normalizeOpaqueIdentifier(item, 80, 'MALFORMED_RESPONSE_METADATA')
    } else {
      if (typeof item !== 'number' || !Number.isInteger(item) || item < 0 || item > 10_000_000) throw new Error('MALFORMED_RESPONSE_METADATA')
      result[key as 'inputTokens' | 'outputTokens' | 'totalTokens'] = item
    }
  }
  return result
}

export function normalizeObservedAt(value: unknown): string {
  if (typeof value !== 'string' || value !== value.trim()) throw new Error('MALFORMED_RESPONSE')
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) throw new Error('MALFORMED_RESPONSE')
  return date.toISOString()
}

export function normalizeCitationUrls(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 50) throw new Error('CITATION_VALIDATION_FAILURE')
  const canonical: string[] = []
  for (const item of value) {
    if (typeof item !== 'string' || item !== item.trim() || /[\u0000-\u001f\u007f]/u.test(item)) throw new Error('CITATION_VALIDATION_FAILURE')
    let parsed: URL
    try { parsed = new URL(item) } catch { throw new Error('CITATION_VALIDATION_FAILURE') }
    if (parsed.hash) throw new Error('CITATION_VALIDATION_FAILURE')
    try { canonical.push(canonicalizePublicHttps(item).url) } catch { throw new Error('CITATION_VALIDATION_FAILURE') }
  }
  return [...new Set(canonical)].sort((left, right) => left.localeCompare(right))
}

export function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength
}

export function buildBoundedExcerpt(responseText: string, project: ProjectIdentity): string {
  const codePoints = Array.from(responseText)
  const mentions = countBrandMentions(responseText, project.brandName, project.brandAliases)
  if (!mentions.mentioned) return codePoints.slice(0, MAX_EXCERPT_CHARS).join('')
  const first = Math.max(0, (mentions.firstMentionPosition || 1) - 1)
  const start = Math.max(0, first - 350)
  return codePoints.slice(start, start + MAX_EXCERPT_CHARS).join('')
}

export function analyzeMentionFields(responseText: string, project: ProjectIdentity): Pick<ObservationCandidate, 'brandMentioned' | 'exactMentionCount' | 'firstMentionPosition' | 'competitorMentions'> {
  const brand = countBrandMentions(responseText, project.brandName, project.brandAliases)
  return { brandMentioned: brand.mentioned, exactMentionCount: brand.exactMentionCount, firstMentionPosition: brand.firstMentionPosition, competitorMentions: countCompetitorMentions(responseText, project.competitorBrands) }
}

export function resolveCitedDomain(citationUrls: string[], canonicalWebsiteDomain: string): string | null {
  let canonicalDomain: string
  try { canonicalDomain = canonicalHostname(canonicalWebsiteDomain) } catch { return null }
  const matching = citationUrls.find(url => {
    try { return new URL(url).hostname.toLowerCase() === canonicalDomain } catch { return false }
  })
  return matching ? canonicalDomain : null
}

export function buildEvidenceLocator(probe: VisibilityProbe, responseHash: string): string {
  return `${probe.provider}:${probe.probeId}:${responseHash.slice(0, 16)}`
}

export function normalizeObservationCandidate(value: unknown): ObservationCandidate {
  if (!isRecord(value)) throw new Error('MALFORMED_CANDIDATE')
  const responseHash = normalizeCanonicalHash(read(value, 'responseHash'), 'INVALID_RESPONSE_HASH')
  const boundedExcerpt = normalizeText(read(value, 'boundedExcerpt'), MAX_EXCERPT_CHARS, 'MALFORMED_CANDIDATE')
  if (byteLength(boundedExcerpt) > 16_000) throw new Error('MALFORMED_CANDIDATE')
  const citationUrls = normalizeCitationUrls(read(value, 'citationUrls'))
  const competitorMentions = read(value, 'competitorMentions')
  if (!isRecord(competitorMentions)) throw new Error('MALFORMED_CANDIDATE')
  return { ...value as ObservationCandidate, responseHash, boundedExcerpt, citationUrls, competitorMentions: Object.fromEntries(Object.entries(competitorMentions).map(([key, count]) => [key, typeof count === 'number' && Number.isInteger(count) && count >= 0 ? count : (() => { throw new Error('MALFORMED_CANDIDATE') })()])) }
}

export const PROBE_ENGINE_VERSION_DEFAULT = PROBE_ENGINE_VERSION

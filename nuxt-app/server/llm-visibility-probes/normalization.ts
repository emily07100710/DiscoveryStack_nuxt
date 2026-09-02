import { createHash } from 'node:crypto'
import { canonicalBrandKey } from '../llm-visibility/service'
import { canonicalizePublicHttps, canonicalHostname, normalizedPromptHash } from '../llm-visibility/guards'
import { normalizeCitationSourceDate } from '../llm-visibility/citation-freshness'
import {
  PROBE_ENGINE_VERSION,
  PROBE_LIMITATION_CODE,
  PROBE_LOCALES,
  PROBE_PROVIDERS,
  PROBE_TARGET_STATUSES,
  type AdapterResponseMetadata,
  type AdapterSuccess,
  type IdempotencyRecord,
  type ObservationCandidate,
  type ProbeAnalysisResult,
  type ProbeLocale,
  type ProbePlanInput,
  type ProbeProvider,
  type ProjectIdentity,
  type ProviderTarget,
  type QuerySnapshot,
  type VisibilityProbe,
  type VisibilityProbePlan,
} from './types'

export const MAX_PROBES = 50
export const MAX_PROVIDER_TARGETS = 12
export const MAX_QUERY_SNAPSHOTS = 100
export const MAX_PROJECT_COMPETITOR_TERMS = 30
export const MAX_RESPONSE_METADATA_KEYS = 4
export const MAX_EXCERPT_CHARS = 1000
export const MAX_EXCERPT_BYTES = 16_000
export const MIN_TIMEOUT_MS = 1
export const MAX_TIMEOUT_MS = 120_000
export const MIN_RESPONSE_BYTES = 1
export const MAX_RESPONSE_BYTES = 2_000_000
export const MAX_PROVIDER_REQUEST_ID_LENGTH = 160
export const MAX_TOKEN_COUNT = 10_000_000

const DISALLOWED_RESPONSE_CONTROLS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u

export type NormalizationFailure = { reasonCode: string }

const PLAN_KEYS = ['status', 'engineVersion', 'ownerScopeKey', 'project', 'observationWindowKey', 'maximumProbes', 'providerTargets', 'probes', 'planFingerprint', 'limitationCode'] as const
const PLAN_BODY_KEYS = ['engineVersion', 'ownerScopeKey', 'project', 'observationWindowKey', 'maximumProbes', 'providerTargets', 'probes', 'limitationCode'] as const
const PROJECT_KEYS = ['projectId', 'canonicalWebsiteDomain', 'brandName', 'brandAliases', 'competitorBrands', 'locale'] as const
const QUERY_KEYS = ['queryId', 'projectId', 'promptText', 'promptHash', 'intent', 'locale', 'active'] as const
const TARGET_KEYS = ['provider', 'modelLabel', 'adapterKey', 'status', 'allowedLocales', 'maximumResponseBytes', 'timeoutMs'] as const
const PROBE_KEYS = ['probeId', 'requestFingerprint', 'identityKey', 'ownerScopeKey', 'projectId', 'queryId', 'provider', 'modelLabel', 'adapterKey', 'locale', 'normalizedPrompt', 'observationWindowKey', 'limitationCode', 'provenance', 'status'] as const
const PROBE_PROVENANCE_KEYS = ['engineVersion', 'observationMode', 'consumerSurfaceEquivalent'] as const
const RESPONSE_REQUIRED_KEYS = ['ok', 'provider', 'modelLabel', 'responseText', 'citationUrls', 'observedAt'] as const
const RESPONSE_OPTIONAL_KEYS = ['providerRequestId', 'responseMetadata', 'citationDates'] as const
const FAILURE_REQUIRED_KEYS = ['ok', 'failureKind', 'retryable', 'code'] as const
const FAILURE_OPTIONAL_KEYS = ['httpStatus'] as const
const CANDIDATE_REQUIRED_KEYS = [
  'probeId', 'requestFingerprint', 'planFingerprint', 'ownerScopeKey', 'projectId', 'queryId', 'provider', 'modelLabel',
  'observationWindowKey', 'observationMode', 'verifiedByOwner', 'status', 'metricEligibility', 'consumerSurfaceEquivalent',
  'limitationCode', 'persistenceStatus', 'responseHash', 'boundedExcerpt', 'brandMentioned', 'exactMentionCount',
  'firstMentionPosition', 'competitorMentions', 'citationUrls', 'citedDomain', 'evidenceLocator', 'observedAt', 'provenance',
] as const
const CANDIDATE_OPTIONAL_KEYS = ['providerRequestId', 'citationDates'] as const
const CANDIDATE_PROVENANCE_REQUIRED_KEYS = ['adapterKey', 'engineVersion'] as const
const CANDIDATE_PROVENANCE_OPTIONAL_KEYS = ['responseMetadata'] as const
const RESPONSE_METADATA_KEYS = ['finishReason', 'inputTokens', 'outputTokens', 'totalTokens'] as const

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function ownKeys(value: object): (string | symbol)[] {
  try { return Reflect.ownKeys(value) } catch { throw new Error('UNSAFE_INPUT') }
}

function read(record: Record<string, unknown>, key: string): unknown {
  try { return record[key] } catch { throw new Error('UNSAFE_INPUT') }
}

export function compareCanonicalStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function sortedKeys(keys: readonly string[]): string[] {
  return [...keys].sort(compareCanonicalStrings)
}

export function hasExactKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
  let keys: (string | symbol)[]
  try { keys = ownKeys(value) } catch { return false }
  if (keys.some(key => typeof key !== 'string')) return false
  const actual = keys as string[]
  const allowed = new Set([...required, ...optional])
  if (actual.some(key => !allowed.has(key))) return false
  const requiredSet = new Set(required)
  return requiredSet.size === required.length && required.every(key => actual.includes(key)) && new Set(actual).size === actual.length
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
  if (!/^[a-f0-9]{64}/u.test(value) || value.length !== 64) {
    if (typeof value === 'string' && value.length === 64 && /^[A-F0-9]{64}$/u.test(value)) throw new Error('NON_CANONICAL_HASH')
    throw new Error(reasonCode)
  }
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
    const keys = ownKeys(record)
    if (keys.some(key => typeof key !== 'string')) throw new Error('INVALID_CANONICAL_VALUE')
    result = `{${(keys as string[]).sort(compareCanonicalStrings).map(key => `${JSON.stringify(key)}:${stableSerialize(read(record, key), seen)}`).join(',')}}`
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

function normalizeStringList(value: unknown, maxItems: number, maxLength: number, reasonCode: string): string[] {
  if (!Array.isArray(value) || value.length > maxItems) throw new Error(reasonCode)
  const result = value.map(item => normalizeText(item, maxLength, reasonCode))
  const keys = result.map(canonicalBrandKey)
  if (new Set(keys).size !== keys.length) throw new Error(reasonCode)
  return result.sort((left, right) => compareCanonicalStrings(canonicalBrandKey(left), canonicalBrandKey(right)) || compareCanonicalStrings(left, right))
}

function normalizeProject(value: unknown): ProjectIdentity {
  if (!isRecord(value) || !hasExactKeys(value, PROJECT_KEYS)) throw new Error('MALFORMED_PROJECT')
  const projectId = normalizeOpaqueIdentifier(read(value, 'projectId'), 120, 'MALFORMED_PROJECT')
  const canonicalWebsiteDomain = canonicalHostname(normalizeText(read(value, 'canonicalWebsiteDomain'), 253, 'MALFORMED_PROJECT'))
  const brandName = normalizeText(read(value, 'brandName'), 160, 'MALFORMED_PROJECT')
  const brandKey = canonicalBrandKey(brandName)
  const brandAliases = normalizeStringList(read(value, 'brandAliases'), 30, 160, 'MALFORMED_PROJECT').filter(alias => canonicalBrandKey(alias) !== brandKey)
  const competitorBrands = normalizeStringList(read(value, 'competitorBrands'), MAX_PROJECT_COMPETITOR_TERMS, 160, 'MALFORMED_PROJECT')
  const brandKeys = new Set([brandKey, ...brandAliases.map(canonicalBrandKey)])
  if (competitorBrands.some(competitor => brandKeys.has(canonicalBrandKey(competitor)))) throw new Error('BRAND_COMPETITOR_COLLISION')
  return { projectId, canonicalWebsiteDomain, brandName, brandAliases, competitorBrands, locale: normalizeLocale(read(value, 'locale'), 'MALFORMED_PROJECT') }
}

function normalizeProviderTarget(value: unknown): ProviderTarget {
  if (!isRecord(value) || !hasExactKeys(value, TARGET_KEYS)) throw new Error('MALFORMED_PROVIDER_TARGET')
  const allowedLocalesRaw = read(value, 'allowedLocales')
  if (!Array.isArray(allowedLocalesRaw) || !allowedLocalesRaw.length || allowedLocalesRaw.length > PROBE_LOCALES.length) throw new Error('MALFORMED_PROVIDER_TARGET')
  const allowedLocales = allowedLocalesRaw.map(item => normalizeLocale(item)).sort(compareCanonicalStrings)
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
  if (!isRecord(value) || !hasExactKeys(value, QUERY_KEYS)) throw new Error('MALFORMED_QUERY')
  const promptText = normalizePrompt(read(value, 'promptText'))
  const promptHash = normalizeCanonicalHash(read(value, 'promptHash'), 'INVALID_PROMPT_HASH')
  if (promptHash !== normalizedPromptHash(promptText)) throw new Error('PROMPT_HASH_MISMATCH')
  const active = read(value, 'active')
  if (typeof active !== 'boolean') throw new Error('MALFORMED_QUERY')
  return {
    queryId: normalizeOpaqueIdentifier(read(value, 'queryId'), 120, 'MALFORMED_QUERY'),
    projectId: normalizeOpaqueIdentifier(read(value, 'projectId'), 120, 'MALFORMED_QUERY'),
    promptText,
    promptHash,
    intent: normalizeText(read(value, 'intent'), 120, 'MALFORMED_QUERY'),
    locale: normalizeLocale(read(value, 'locale')),
    active,
  }
}

export function normalizeProbePlanInput(value: unknown): ProbePlanInput {
  if (!isRecord(value) || !hasExactKeys(value, ['ownerScopeKey', 'project', 'activeQuerySnapshots', 'providerTargets', 'observationWindowKey', 'maximumProbes', 'engineVersion'])) throw new Error('MALFORMED_PLAN_INPUT')
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
  return canonicalFingerprint({
    engineVersion,
    ownerScopeKey: probe.ownerScopeKey,
    projectId: probe.projectId,
    queryId: probe.queryId,
    queryHash: promptHash,
    provider: probe.provider,
    modelLabel: probe.modelLabel,
    locale: probe.locale,
    observationWindowKey: probe.observationWindowKey,
  })
}

function normalizeProbeProvenance(value: unknown): VisibilityProbe['provenance'] {
  if (!isRecord(value) || !hasExactKeys(value, PROBE_PROVENANCE_KEYS)) throw new Error('MALFORMED_PROBE')
  if (read(value, 'engineVersion') !== PROBE_ENGINE_VERSION || read(value, 'observationMode') !== 'provider_api_observation' || read(value, 'consumerSurfaceEquivalent') !== false) throw new Error('MALFORMED_PROBE')
  return { engineVersion: PROBE_ENGINE_VERSION, observationMode: 'provider_api_observation', consumerSurfaceEquivalent: false }
}

export function normalizeProbe(value: unknown): VisibilityProbe {
  if (!isRecord(value) || !hasExactKeys(value, PROBE_KEYS)) throw new Error('MALFORMED_PROBE')
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
    provenance: normalizeProbeProvenance(read(value, 'provenance')),
    status: 'planned',
  }
}

function targetIdentity(target: ProviderTarget): string {
  return `${target.provider}|${target.modelLabel}|${target.adapterKey}`
}

function probeSort(left: VisibilityProbe, right: VisibilityProbe): number {
  return compareCanonicalStrings(left.provider, right.provider)
    || compareCanonicalStrings(left.modelLabel, right.modelLabel)
    || compareCanonicalStrings(left.locale, right.locale)
    || compareCanonicalStrings(left.queryId, right.queryId)
    || compareCanonicalStrings(left.requestFingerprint, right.requestFingerprint)
}

function targetSort(left: ProviderTarget, right: ProviderTarget): number {
  return compareCanonicalStrings(left.provider, right.provider)
    || compareCanonicalStrings(left.modelLabel, right.modelLabel)
    || compareCanonicalStrings(left.adapterKey, right.adapterKey)
}

export function buildCanonicalPlanBody(plan: Pick<VisibilityProbePlan, 'engineVersion' | 'ownerScopeKey' | 'project' | 'observationWindowKey' | 'maximumProbes' | 'providerTargets' | 'probes' | 'limitationCode'>) {
  return {
    engineVersion: plan.engineVersion,
    ownerScopeKey: plan.ownerScopeKey,
    project: plan.project,
    observationWindowKey: plan.observationWindowKey,
    maximumProbes: plan.maximumProbes,
    providerTargets: [...plan.providerTargets].sort(targetSort),
    probes: [...plan.probes].sort(probeSort),
    limitationCode: plan.limitationCode,
  }
}

function validatePlanProbeLineage(plan: Omit<VisibilityProbePlan, 'planFingerprint'>, probe: VisibilityProbe): void {
  if (probe.ownerScopeKey !== plan.ownerScopeKey) throw new Error('PROBE_OWNER_SCOPE_MISMATCH')
  if (probe.projectId !== plan.project.projectId) throw new Error('PROBE_PROJECT_MISMATCH')
  if (probe.locale !== plan.project.locale) throw new Error('PROBE_LOCALE_MISMATCH')
  if (probe.observationWindowKey !== plan.observationWindowKey) throw new Error('PROBE_WINDOW_MISMATCH')
  if (probe.provenance.engineVersion !== plan.engineVersion) throw new Error('PROBE_ENGINE_VERSION_MISMATCH')
  if (probe.status !== 'planned' || probe.limitationCode !== PROBE_LIMITATION_CODE || probe.provenance.observationMode !== 'provider_api_observation' || probe.provenance.consumerSurfaceEquivalent !== false) throw new Error('PROBE_GOVERNANCE_MISMATCH')
  const target = plan.providerTargets.find(item => item.provider === probe.provider && item.modelLabel === probe.modelLabel && item.adapterKey === probe.adapterKey)
  if (!target) throw new Error('PROBE_TARGET_MISMATCH')
  if (target.status !== 'active' || !target.allowedLocales.includes(plan.project.locale)) throw new Error('PROBE_TARGET_NOT_ELIGIBLE')
  const identityKey = `${probe.provider}|${probe.modelLabel}|${probe.queryId}|${probe.locale}`
  const expectedRequestFingerprint = canonicalProbeIdentity({
    ownerScopeKey: plan.ownerScopeKey,
    projectId: plan.project.projectId,
    queryId: probe.queryId,
    provider: probe.provider,
    modelLabel: probe.modelLabel,
    locale: probe.locale,
    observationWindowKey: plan.observationWindowKey,
  }, normalizedPromptHash(probe.normalizedPrompt), plan.engineVersion)
  const expectedProbeId = canonicalFingerprint({ identityKey, requestFingerprint: expectedRequestFingerprint })
  if (probe.identityKey !== identityKey) throw new Error('PROBE_IDENTITY_KEY_MISMATCH')
  if (probe.requestFingerprint !== expectedRequestFingerprint) throw new Error('PROBE_REQUEST_FINGERPRINT_MISMATCH')
  if (probe.probeId !== expectedProbeId) throw new Error('PROBE_ID_MISMATCH')
}

export function normalizeVisibilityProbePlan(value: unknown): VisibilityProbePlan {
  if (!isRecord(value) || !hasExactKeys(value, PLAN_KEYS)) throw new Error('MALFORMED_PLAN')
  if (read(value, 'status') !== 'planned') throw new Error('MALFORMED_PLAN_STATUS')
  if (read(value, 'engineVersion') !== PROBE_ENGINE_VERSION) throw new Error('ENGINE_VERSION_MISMATCH')
  if (read(value, 'limitationCode') !== PROBE_LIMITATION_CODE) throw new Error('MALFORMED_PLAN_LIMITATION')
  const maximumProbes = read(value, 'maximumProbes')
  if (typeof maximumProbes !== 'number' || !Number.isInteger(maximumProbes) || maximumProbes < 1 || maximumProbes > MAX_PROBES) throw new Error('INVALID_MAXIMUM_PROBES')
  const project = normalizeProject(read(value, 'project'))
  const ownerScopeKey = normalizeOpaqueIdentifier(read(value, 'ownerScopeKey'), 160, 'MALFORMED_PLAN')
  const observationWindowKey = normalizeOpaqueIdentifier(read(value, 'observationWindowKey'), 160, 'MALFORMED_PLAN')
  const providerTargetsRaw = read(value, 'providerTargets')
  const probesRaw = read(value, 'probes')
  if (!Array.isArray(providerTargetsRaw) || !providerTargetsRaw.length || providerTargetsRaw.length > MAX_PROVIDER_TARGETS) throw new Error('MALFORMED_PROVIDER_TARGET_LIST')
  if (!Array.isArray(probesRaw) || !probesRaw.length || probesRaw.length > MAX_PROBES || probesRaw.length > maximumProbes) throw new Error('INVALID_PROBE_COUNT')
  const providerTargets = providerTargetsRaw.map(normalizeProviderTarget)
  if (providerTargets.some(target => target.status !== 'active')) throw new Error('PAUSED_PROVIDER_TARGET')
  const targetIdentities = new Set<string>()
  for (const target of providerTargets) {
    const identity = targetIdentity(target)
    if (targetIdentities.has(identity)) throw new Error('DUPLICATE_PROVIDER_TARGET')
    targetIdentities.add(identity)
  }
  const probes = probesRaw.map(normalizeProbe)
  const planWithoutFingerprint: Omit<VisibilityProbePlan, 'planFingerprint'> = {
    status: 'planned',
    engineVersion: PROBE_ENGINE_VERSION,
    ownerScopeKey,
    project,
    observationWindowKey,
    maximumProbes,
    providerTargets: providerTargets.sort(targetSort),
    probes,
    limitationCode: PROBE_LIMITATION_CODE,
  }
  const requestFingerprints = new Set<string>()
  const probeIds = new Set<string>()
  const identityKeys = new Set<string>()
  for (const probe of probes) {
    validatePlanProbeLineage(planWithoutFingerprint, probe)
    if (requestFingerprints.has(probe.requestFingerprint)) throw new Error('DUPLICATE_REQUEST_FINGERPRINT')
    if (probeIds.has(probe.probeId)) throw new Error('DUPLICATE_PROBE_ID')
    if (identityKeys.has(probe.identityKey)) throw new Error('DUPLICATE_IDENTITY_KEY')
    requestFingerprints.add(probe.requestFingerprint)
    probeIds.add(probe.probeId)
    identityKeys.add(probe.identityKey)
  }
  const normalizedPlan: VisibilityProbePlan = {
    ...planWithoutFingerprint,
    probes: [...probes].sort(probeSort),
    planFingerprint: normalizeCanonicalHash(read(value, 'planFingerprint'), 'INVALID_PLAN_FINGERPRINT'),
  }
  const expectedPlanFingerprint = canonicalFingerprint(buildCanonicalPlanBody(normalizedPlan))
  if (normalizedPlan.planFingerprint !== expectedPlanFingerprint) throw new Error('PLAN_FINGERPRINT_MISMATCH')
  return normalizedPlan
}

export function normalizeProviderRequestId(value: unknown): string | undefined {
  if (value === undefined) return undefined
  return normalizeOpaqueIdentifier(value, MAX_PROVIDER_REQUEST_ID_LENGTH, 'MALFORMED_PROVIDER_REQUEST_ID')
}

export function normalizeResponseMetadata(value: unknown): AdapterResponseMetadata | undefined {
  if (value === undefined) return undefined
  if (!isRecord(value) || !hasExactKeys(value, [], RESPONSE_METADATA_KEYS) || ownKeys(value).length > MAX_RESPONSE_METADATA_KEYS) throw new Error('MALFORMED_RESPONSE_METADATA')
  const result: AdapterResponseMetadata = {}
  for (const key of ownKeys(value)) {
    if (typeof key !== 'string') throw new Error('MALFORMED_RESPONSE_METADATA')
    const item = read(value, key)
    if (key === 'finishReason') {
      result.finishReason = normalizeOpaqueIdentifier(item, 80, 'MALFORMED_RESPONSE_METADATA')
    } else {
      if (typeof item !== 'number' || !Number.isInteger(item) || item < 0 || item > MAX_TOKEN_COUNT) throw new Error('MALFORMED_RESPONSE_METADATA')
      result[key as 'inputTokens' | 'outputTokens' | 'totalTokens'] = item
    }
  }
  if (result.inputTokens !== undefined && result.outputTokens !== undefined && result.totalTokens !== undefined && result.totalTokens !== result.inputTokens + result.outputTokens) throw new Error('MALFORMED_RESPONSE_METADATA')
  return result
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28
  return [4, 6, 9, 11].includes(month) ? 30 : 31
}

const STRICT_TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/u

export function normalizeObservedAt(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value !== value.trim()) throw new Error('MALFORMED_RESPONSE')
  const match = STRICT_TIMESTAMP.exec(value)
  if (!match) throw new Error('MALFORMED_RESPONSE')
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const hour = Number(match[4])
  const minute = Number(match[5])
  const second = Number(match[6])
  const timezone = match[8]!
  const offsetHours = timezone === 'Z' ? 0 : Number(timezone.slice(1, 3))
  const offsetMinutes = timezone === 'Z' ? 0 : Number(timezone.slice(4))
  const offset = timezone === 'Z' ? 0 : (offsetHours * 60 + offsetMinutes) * (timezone.startsWith('-') ? -1 : 1)
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month) || hour > 23 || minute > 59 || second > 59 || offsetHours > 14 || offsetMinutes > 59 || offsetHours === 14 && offsetMinutes !== 0) throw new Error('MALFORMED_RESPONSE')
  const milliseconds = Number((match[7] || '0').padEnd(3, '0').slice(0, 3))
  const base = new Date(Date.UTC(2000, month - 1, day, hour, minute, second, milliseconds))
  base.setUTCFullYear(year)
  const utc = base.getTime() - offset * 60_000
  const date = new Date(utc)
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
  return [...new Set(canonical)].sort(compareCanonicalStrings)
}

export function normalizeCitationDates(value: unknown, citationUrls: string[]): Record<string, string> | undefined {
  if (value === undefined) return undefined
  if (!isRecord(value)) throw new Error('CITATION_VALIDATION_FAILURE')
  const keys = ownKeys(value)
  if (keys.some(key => typeof key !== 'string') || keys.length > 50) throw new Error('CITATION_VALIDATION_FAILURE')
  const allowed = new Set(citationUrls)
  const normalized: Record<string, string> = {}
  for (const rawKey of keys as string[]) {
    let key: string
    try { key = canonicalizePublicHttps(rawKey).url } catch { throw new Error('CITATION_VALIDATION_FAILURE') }
    if (!allowed.has(key) || normalized[key] !== undefined) throw new Error('CITATION_VALIDATION_FAILURE')
    const date = normalizeCitationSourceDate(read(value, rawKey))
    if (!date) throw new Error('CITATION_VALIDATION_FAILURE')
    normalized[key] = date
  }
  return Object.fromEntries(Object.entries(normalized).sort(([left], [right]) => compareCanonicalStrings(left, right)))
}

export function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength
}

function normalizeAnalysisSurface(value: string): string {
  return value.normalize('NFKC').replace(/\s+/gu, ' ').trim()
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function requiresTokenBoundary(value: string): boolean {
  return /[a-z0-9]/iu.test(value)
}

function findAnalysisMatches(text: string, aliases: string[]): Array<{ start: number, end: number, alias: string }> {
  const normalizedText = normalizeAnalysisSurface(text)
  const candidates: Array<{ start: number, end: number, alias: string }> = []
  const normalizedAliases = [...new Set(aliases.map(normalizeAnalysisSurface).filter(Boolean))].sort((left, right) => {
    const byLength = right.length - left.length
    return byLength || compareCanonicalStrings(left, right)
  })
  for (const alias of normalizedAliases) {
    const escaped = escapeRegExp(alias).replace(/\s+/gu, '\\s+')
    const pattern = requiresTokenBoundary(alias) ? `(^|[^\\p{L}\\p{N}])(${escaped})(?=$|[^\\p{L}\\p{N}])` : `(${escaped})`
    const expression = new RegExp(pattern, 'giu')
    for (const match of normalizedText.matchAll(expression)) {
      const prefixLength = requiresTokenBoundary(alias) ? (match[1]?.length || 0) : 0
      const utf16Start = (match.index || 0) + prefixLength
      const before = Array.from(normalizedText.slice(0, utf16Start)).length
      const aliasCodePoints = Array.from(alias).length
      candidates.push({ start: before, end: before + aliasCodePoints, alias })
    }
  }
  return candidates
    .sort((left, right) => left.start - right.start || right.end - left.end || compareCanonicalStrings(left.alias, right.alias))
    .filter((candidate, index, all) => !all.slice(0, index).some(previous => candidate.start < previous.end && candidate.end > previous.start))
}

export function buildBoundedExcerpt(responseText: string, project: ProjectIdentity): string {
  const analysisSurface = normalizeAnalysisSurface(responseText)
  const codePoints = Array.from(analysisSurface)
  const mentions = findAnalysisMatches(analysisSurface, [project.brandName, ...project.brandAliases])
  if (!mentions.length) return codePoints.slice(0, MAX_EXCERPT_CHARS).join('')
  const first = mentions[0]!.start
  const start = Math.max(0, first - 350)
  return codePoints.slice(start, start + MAX_EXCERPT_CHARS).join('')
}

export function analyzeMentionFields(responseText: string, project: ProjectIdentity): Pick<ObservationCandidate, 'brandMentioned' | 'exactMentionCount' | 'firstMentionPosition' | 'competitorMentions'> {
  const brandMatches = findAnalysisMatches(responseText, [project.brandName, ...project.brandAliases])
  const competitorMentions = Object.fromEntries(
    [...project.competitorBrands].sort((left, right) => compareCanonicalStrings(canonicalBrandKey(left), canonicalBrandKey(right))).map(competitor => [competitor, findAnalysisMatches(responseText, [competitor]).length]),
  )
  return {
    brandMentioned: brandMatches.length > 0,
    exactMentionCount: brandMatches.length,
    firstMentionPosition: brandMatches.length ? brandMatches[0]!.start + 1 : null,
    competitorMentions,
  }
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
  return `${probe.provider}:${probe.probeId}:${responseHash}`
}

function normalizeBoundedExcerpt(value: unknown): string {
  if (typeof value !== 'string' || !value || value !== value.normalize('NFKC') || DISALLOWED_RESPONSE_CONTROLS.test(value)) throw new Error('MALFORMED_CANDIDATE')
  if (Array.from(value).length > MAX_EXCERPT_CHARS || byteLength(value) > MAX_EXCERPT_BYTES) throw new Error('MALFORMED_CANDIDATE')
  return value
}

function normalizeNonNegativeInteger(value: unknown, reasonCode: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > MAX_EXCERPT_CHARS * 10) throw new Error(reasonCode)
  return value
}

function normalizeCompetitorMentions(value: unknown, project: ProjectIdentity): Record<string, number> {
  if (!isRecord(value) || !hasExactKeys(value, project.competitorBrands)) throw new Error('MALFORMED_CANDIDATE')
  const result: Record<string, number> = {}
  for (const competitor of project.competitorBrands) result[competitor] = normalizeNonNegativeInteger(read(value, competitor), 'MALFORMED_CANDIDATE')
  return result
}

function normalizeCandidateProvenance(value: unknown, target: ProviderTarget): ObservationCandidate['provenance'] {
  if (!isRecord(value) || !hasExactKeys(value, CANDIDATE_PROVENANCE_REQUIRED_KEYS, CANDIDATE_PROVENANCE_OPTIONAL_KEYS)) throw new Error('MALFORMED_CANDIDATE')
  if (read(value, 'adapterKey') !== target.adapterKey || read(value, 'engineVersion') !== PROBE_ENGINE_VERSION) throw new Error('CANDIDATE_LINEAGE_MISMATCH')
  const responseMetadata = normalizeResponseMetadata(read(value, 'responseMetadata'))
  return responseMetadata === undefined
    ? { adapterKey: target.adapterKey, engineVersion: PROBE_ENGINE_VERSION }
    : { adapterKey: target.adapterKey, engineVersion: PROBE_ENGINE_VERSION, responseMetadata }
}

export type CandidateValidationContext = { plan: VisibilityProbePlan, probe: VisibilityProbe, target: ProviderTarget }

export function normalizeObservationCandidate(value: unknown, context: CandidateValidationContext): ObservationCandidate {
  if (!isRecord(value) || !hasExactKeys(value, CANDIDATE_REQUIRED_KEYS, CANDIDATE_OPTIONAL_KEYS)) throw new Error('MALFORMED_CANDIDATE')
  const { plan, probe, target } = context
  const probeId = normalizeCanonicalHash(read(value, 'probeId'), 'INVALID_PROBE_ID')
  const requestFingerprint = normalizeCanonicalHash(read(value, 'requestFingerprint'), 'INVALID_REQUEST_FINGERPRINT')
  const planFingerprint = normalizeCanonicalHash(read(value, 'planFingerprint'), 'INVALID_PLAN_FINGERPRINT')
  if (probeId !== probe.probeId || requestFingerprint !== probe.requestFingerprint || planFingerprint !== plan.planFingerprint) throw new Error('CANDIDATE_LINEAGE_MISMATCH')
  if (read(value, 'ownerScopeKey') !== plan.ownerScopeKey || read(value, 'projectId') !== plan.project.projectId || read(value, 'queryId') !== probe.queryId || read(value, 'provider') !== probe.provider || read(value, 'modelLabel') !== probe.modelLabel || read(value, 'observationWindowKey') !== plan.observationWindowKey) throw new Error('CANDIDATE_LINEAGE_MISMATCH')
  if (read(value, 'observationMode') !== 'provider_api_observation' || read(value, 'verifiedByOwner') !== false || read(value, 'status') !== 'completed' || read(value, 'metricEligibility') !== 'secondary_only' || read(value, 'consumerSurfaceEquivalent') !== false || read(value, 'limitationCode') !== PROBE_LIMITATION_CODE || read(value, 'persistenceStatus') !== 'not_persisted_v1') throw new Error('CANDIDATE_GOVERNANCE_MISMATCH')
  const responseHash = normalizeCanonicalHash(read(value, 'responseHash'), 'INVALID_RESPONSE_HASH')
  const boundedExcerpt = normalizeBoundedExcerpt(read(value, 'boundedExcerpt'))
  const brandMentioned = read(value, 'brandMentioned')
  if (typeof brandMentioned !== 'boolean') throw new Error('MALFORMED_CANDIDATE')
  const exactMentionCount = normalizeNonNegativeInteger(read(value, 'exactMentionCount'), 'MALFORMED_CANDIDATE')
  const firstMentionPosition = read(value, 'firstMentionPosition')
  if (brandMentioned && (typeof firstMentionPosition !== 'number' || !Number.isInteger(firstMentionPosition) || firstMentionPosition < 1 || firstMentionPosition > MAX_RESPONSE_BYTES)) throw new Error('MALFORMED_CANDIDATE')
  if (!brandMentioned && firstMentionPosition !== null) throw new Error('MALFORMED_CANDIDATE')
  if (!brandMentioned && exactMentionCount !== 0) throw new Error('MALFORMED_CANDIDATE')
  if (brandMentioned && exactMentionCount < 1) throw new Error('MALFORMED_CANDIDATE')
  const competitorMentions = normalizeCompetitorMentions(read(value, 'competitorMentions'), plan.project)
  const rawCitationUrls = read(value, 'citationUrls')
  const citationUrls = normalizeCitationUrls(rawCitationUrls)
  if (!Array.isArray(rawCitationUrls) || rawCitationUrls.length !== citationUrls.length || rawCitationUrls.some((url, index) => url !== citationUrls[index])) throw new Error('MALFORMED_CANDIDATE')
  const citedDomain = read(value, 'citedDomain')
  if (citedDomain !== null && typeof citedDomain !== 'string') throw new Error('MALFORMED_CANDIDATE')
  const expectedCitedDomain = resolveCitedDomain(citationUrls, plan.project.canonicalWebsiteDomain)
  if (citedDomain !== expectedCitedDomain) throw new Error('MALFORMED_CANDIDATE')
  const observedAt = normalizeObservedAt(read(value, 'observedAt'))
  if (observedAt !== read(value, 'observedAt')) throw new Error('MALFORMED_RESPONSE')
  const evidenceLocator = read(value, 'evidenceLocator')
  if (evidenceLocator !== buildEvidenceLocator(probe, responseHash)) throw new Error('MALFORMED_CANDIDATE')
  const providerRequestId = normalizeProviderRequestId(read(value, 'providerRequestId'))
  const citationDates = normalizeCitationDates(read(value, 'citationDates'), citationUrls)
  const provenance = normalizeCandidateProvenance(read(value, 'provenance'), target)
  return {
    probeId,
    requestFingerprint,
    planFingerprint,
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
    boundedExcerpt,
    brandMentioned,
    exactMentionCount,
    firstMentionPosition: brandMentioned ? firstMentionPosition as number : null,
    competitorMentions,
    citationUrls,
    ...(citationDates === undefined ? {} : { citationDates }),
    citedDomain: expectedCitedDomain,
    ...(providerRequestId === undefined ? {} : { providerRequestId }),
    evidenceLocator: buildEvidenceLocator(probe, responseHash),
    observedAt,
    provenance,
  }
}

export function normalizeAdapterSuccessResponse(value: unknown): AdapterSuccess {
  if (!isRecord(value) || !hasExactKeys(value, RESPONSE_REQUIRED_KEYS, RESPONSE_OPTIONAL_KEYS) || read(value, 'ok') !== true) throw new Error('MALFORMED_RESPONSE')
  const provider = normalizeProvider(read(value, 'provider'))
  const modelLabel = normalizeText(read(value, 'modelLabel'), 160, 'MALFORMED_RESPONSE')
  const responseText = read(value, 'responseText')
  if (typeof responseText !== 'string' || !responseText || responseText !== responseText.normalize('NFKC') || DISALLOWED_RESPONSE_CONTROLS.test(responseText)) throw new Error('MALFORMED_RESPONSE')
  const citationUrls = normalizeCitationUrls(read(value, 'citationUrls'))
  const citationDates = normalizeCitationDates(read(value, 'citationDates'), citationUrls)
  const observedAt = normalizeObservedAt(read(value, 'observedAt'))
  const providerRequestId = normalizeProviderRequestId(read(value, 'providerRequestId'))
  const responseMetadata = normalizeResponseMetadata(read(value, 'responseMetadata'))
  return {
    ok: true,
    provider,
    modelLabel,
    responseText,
    citationUrls,
    ...(citationDates === undefined ? {} : { citationDates }),
    observedAt,
    ...(providerRequestId === undefined ? {} : { providerRequestId }),
    ...(responseMetadata === undefined ? {} : { responseMetadata }),
  }
}

export function normalizeAdapterFailure(value: unknown): { ok: false, failureKind: string, retryable: boolean, code: string, httpStatus?: number } {
  if (!isRecord(value) || !hasExactKeys(value, FAILURE_REQUIRED_KEYS, FAILURE_OPTIONAL_KEYS) || read(value, 'ok') !== false) throw new Error('MALFORMED_ADAPTER_RESPONSE')
  const failureKind = read(value, 'failureKind')
  const retryable = read(value, 'retryable')
  const code = read(value, 'code')
  const httpStatus = read(value, 'httpStatus')
  if (typeof failureKind !== 'string' || typeof retryable !== 'boolean' || typeof code !== 'string' || !code || code.length > 80 || /[\u0000-\u001f\u007f]/u.test(code)) throw new Error('MALFORMED_ADAPTER_RESPONSE')
  if (httpStatus !== undefined && (typeof httpStatus !== 'number' || !Number.isInteger(httpStatus) || httpStatus < 100 || httpStatus > 599)) throw new Error('MALFORMED_ADAPTER_RESPONSE')
  return httpStatus === undefined ? { ok: false, failureKind, retryable, code } : { ok: false, failureKind, retryable, code, httpStatus }
}

export function validateStoredIdempotencyRecord(value: unknown, context: CandidateValidationContext): IdempotencyRecord {
  if (!isRecord(value) || !hasExactKeys(value, ['requestFingerprint', 'identityKey', 'result'])) throw new Error('MALFORMED_IDEMPOTENCY_RECORD')
  const requestFingerprint = normalizeCanonicalHash(read(value, 'requestFingerprint'), 'INVALID_REQUEST_FINGERPRINT')
  const identityKey = normalizeOpaqueIdentifier(read(value, 'identityKey'), 500, 'MALFORMED_IDEMPOTENCY_RECORD')
  if (requestFingerprint !== context.probe.requestFingerprint || identityKey !== context.probe.identityKey) throw new Error('IDEMPOTENCY_LINEAGE_MISMATCH')
  const resultValue = read(value, 'result')
  if (!isRecord(resultValue) || !hasExactKeys(resultValue, ['probeId', 'requestFingerprint', 'status', 'replayed', 'candidate'])) throw new Error('MALFORMED_IDEMPOTENCY_RECORD')
  if (read(resultValue, 'status') !== 'completed' || read(resultValue, 'replayed') !== false) throw new Error('MALFORMED_IDEMPOTENCY_RECORD')
  const resultProbeId = normalizeCanonicalHash(read(resultValue, 'probeId'), 'INVALID_PROBE_ID')
  const resultFingerprint = normalizeCanonicalHash(read(resultValue, 'requestFingerprint'), 'INVALID_REQUEST_FINGERPRINT')
  if (resultProbeId !== context.probe.probeId || resultFingerprint !== context.probe.requestFingerprint) throw new Error('IDEMPOTENCY_LINEAGE_MISMATCH')
  const candidate = normalizeObservationCandidate(read(resultValue, 'candidate'), context)
  return { requestFingerprint, identityKey, result: { probeId: resultProbeId, requestFingerprint: resultFingerprint, status: 'completed', replayed: false, candidate } }
}

export const PROBE_ENGINE_VERSION_DEFAULT = PROBE_ENGINE_VERSION

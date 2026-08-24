import {
  buildCanonicalPlanBody,
  canonicalFingerprint,
  canonicalProbeIdentity,
  compareCanonicalStrings,
  normalizeProbePlanInput,
  normalizePrompt,
  normalizeVisibilityProbePlan,
  MAX_PROBES,
  PROBE_ENGINE_VERSION_DEFAULT,
} from './normalization'
import {
  PROBE_LIMITATION_CODE,
  type ProbePlanResult,
  type ProviderTarget,
  type QuerySnapshot,
  type VisibilityProbe,
  type VisibilityProbePlan,
} from './types'

function blocked(reasonCodes: string[]): ProbePlanResult {
  return { status: 'blocked', reasonCodes: [...new Set(reasonCodes)].sort(compareCanonicalStrings), limitationCode: 'probe_plan_invalid' }
}

function stableTargetOrder(left: ProviderTarget, right: ProviderTarget): number {
  return compareCanonicalStrings(left.provider, right.provider)
    || compareCanonicalStrings(left.modelLabel, right.modelLabel)
    || compareCanonicalStrings(left.adapterKey, right.adapterKey)
}

function stableQueryOrder(left: QuerySnapshot, right: QuerySnapshot): number {
  return compareCanonicalStrings(left.locale, right.locale)
    || compareCanonicalStrings(left.queryId, right.queryId)
    || compareCanonicalStrings(left.promptHash, right.promptHash)
}

function stableProbeOrder(left: VisibilityProbe, right: VisibilityProbe): number {
  return compareCanonicalStrings(left.provider, right.provider)
    || compareCanonicalStrings(left.modelLabel, right.modelLabel)
    || compareCanonicalStrings(left.locale, right.locale)
    || compareCanonicalStrings(left.queryId, right.queryId)
    || compareCanonicalStrings(left.requestFingerprint, right.requestFingerprint)
}

export function buildVisibilityProbePlan(input: unknown): ProbePlanResult {
  let normalized: ReturnType<typeof normalizeProbePlanInput>
  try { normalized = normalizeProbePlanInput(input) } catch (error: unknown) {
    const reasonCode = error instanceof Error && error.message ? error.message : 'MALFORMED_PLAN_INPUT'
    return blocked([reasonCode])
  }
  if (normalized.engineVersion !== PROBE_ENGINE_VERSION_DEFAULT) return blocked(['ENGINE_VERSION_MISMATCH'])
  const activeQueries = normalized.activeQuerySnapshots.filter(query => query.active).sort(stableQueryOrder)
  const activeTargets = normalized.providerTargets.filter(target => target.status === 'active').sort(stableTargetOrder)
  if (!activeQueries.length) return blocked(['NO_ACTIVE_QUERIES'])
  if (!activeTargets.length) return blocked(['NO_ACTIVE_PROVIDER_TARGETS'])
  const reasons: string[] = []
  const seenPromptHashes = new Set<string>()
  for (const query of activeQueries) {
    if (query.locale !== normalized.project.locale) reasons.push('QUERY_LOCALE_MISMATCH')
    if (seenPromptHashes.has(query.promptHash)) reasons.push('DUPLICATE_NORMALIZED_PROMPT')
    seenPromptHashes.add(query.promptHash)
  }
  const eligibleTargets = activeTargets.filter(target => target.allowedLocales.includes(normalized.project.locale))
  if (eligibleTargets.length !== activeTargets.length) reasons.push('PROVIDER_LOCALE_MISMATCH')
  const seenTargetIdentities = new Set<string>()
  for (const target of eligibleTargets) {
    const targetIdentity = `${target.provider}|${target.modelLabel}|${target.adapterKey}`
    if (seenTargetIdentities.has(targetIdentity)) reasons.push('DUPLICATE_PROVIDER_TARGET')
    seenTargetIdentities.add(targetIdentity)
  }
  if (reasons.length) return blocked(reasons)

  const probes: VisibilityProbe[] = []
  const seenCombinations = new Set<string>()
  for (const target of eligibleTargets) {
    for (const query of activeQueries) {
      const normalizedPrompt = normalizePrompt(query.promptText)
      const identityKey = `${target.provider}|${target.modelLabel}|${query.queryId}|${query.locale}`
      if (seenCombinations.has(identityKey)) return blocked(['DUPLICATE_PROVIDER_MODEL_QUERY'])
      seenCombinations.add(identityKey)
      const probeBase = {
        ownerScopeKey: normalized.ownerScopeKey,
        projectId: normalized.project.projectId,
        queryId: query.queryId,
        provider: target.provider,
        modelLabel: target.modelLabel,
        locale: query.locale,
        observationWindowKey: normalized.observationWindowKey,
      }
      const requestFingerprint = canonicalProbeIdentity(probeBase, query.promptHash, normalized.engineVersion)
      const probeId = canonicalFingerprint({ identityKey, requestFingerprint })
      probes.push({
        probeId,
        requestFingerprint,
        identityKey,
        ownerScopeKey: normalized.ownerScopeKey,
        projectId: normalized.project.projectId,
        queryId: query.queryId,
        provider: target.provider,
        modelLabel: target.modelLabel,
        adapterKey: target.adapterKey,
        locale: query.locale,
        normalizedPrompt,
        observationWindowKey: normalized.observationWindowKey,
        limitationCode: PROBE_LIMITATION_CODE,
        provenance: { engineVersion: normalized.engineVersion as typeof PROBE_ENGINE_VERSION_DEFAULT, observationMode: 'provider_api_observation', consumerSurfaceEquivalent: false },
        status: 'planned',
      })
    }
  }
  probes.sort(stableProbeOrder)
  if (!probes.length) return blocked(['NO_VALID_PROBES'])
  if (probes.length > MAX_PROBES || probes.length > normalized.maximumProbes) return blocked(['MAXIMUM_PROBES_EXCEEDED'])
  const planBody = buildCanonicalPlanBody({
    engineVersion: normalized.engineVersion as typeof PROBE_ENGINE_VERSION_DEFAULT,
    ownerScopeKey: normalized.ownerScopeKey,
    project: normalized.project,
    observationWindowKey: normalized.observationWindowKey,
    maximumProbes: normalized.maximumProbes,
    providerTargets: activeTargets,
    probes,
    limitationCode: PROBE_LIMITATION_CODE,
  })
  const plan: VisibilityProbePlan = {
    status: 'planned',
    ...planBody,
    planFingerprint: canonicalFingerprint(planBody),
  }
  try {
    return { status: 'planned', plan: normalizeVisibilityProbePlan(plan) }
  } catch (error: unknown) {
    const reasonCode = error instanceof Error && error.message ? error.message : 'MALFORMED_PLAN'
    return blocked([reasonCode])
  }
}

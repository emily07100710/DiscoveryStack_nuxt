import { capabilityFor } from './capability-matrix'
import { cloneAndFreeze, fingerprint } from './canonical'
import { exactKeys, isPlainObject, normalizeId, normalizeHash, normalizeOpaqueReference } from './normalization'
import { validateRoutingPlan } from './planner'
import { GEOFlow_PINNED_SOURCE_SHA } from './types'
import type { Capability, FirstPartyProjectionIntent, GeoflowProjectionIntent, ProjectionIntent, ProjectionSet, ProjectionValidationResult, RouteIntent, RoutingPlan } from './types'

const FIRST_PARTY_PROJECTION_KEYS = ['projection', 'planFingerprint', 'routeId', 'targetId', 'siteIdentity', 'sourcePublicationIdentity', 'destinationPublicationIdentity', 'draftId', 'reviewId', 'evidenceSnapshotHash', 'contentHash', 'contentType', 'language', 'executor', 'executorAuthority', 'credentialReference', 'framework', 'transport', 'targetUrl'] as const
const GEOFLOW_PROJECTION_KEYS = ['projection', 'planFingerprint', 'routeId', 'targetId', 'siteIdentity', 'sourcePublicationIdentity', 'destinationPublicationIdentity', 'draftId', 'reviewId', 'evidenceSnapshotHash', 'contentHash', 'contentType', 'language', 'executor', 'executorAuthority', 'credentialReference', 'framework', 'transport', 'targetUrl', 'serviceReference', 'geoflowSourceSha'] as const

function verifiedPlan(value: unknown): RoutingPlan {
  const result = validateRoutingPlan(value)
  if (!result.valid) throw new Error(`invalid routing plan: ${result.reasonCodes.join('; ')}`)
  return result.plan
}

function invalidProjection(...reasonCodes: string[]): ProjectionValidationResult {
  return { valid: false, projection: null, reasonCodes }
}

function assertCapability(route: RouteIntent, projection: 'first_party' | 'geoflow'): Capability {
  const capability = capabilityFor(route.framework, route.transport)
  if (!capability || capability.executor !== route.executor || capability.authority !== route.executorAuthority || capability.projection !== projection) throw new Error('route capability does not match projection')
  return capability
}

function common(route: RouteIntent, plan: RoutingPlan) {
  return {
    planFingerprint: plan.planFingerprint,
    routeId: route.routeId,
    targetId: route.targetId,
    siteIdentity: route.siteIdentity,
    sourcePublicationIdentity: route.sourcePublicationIdentity,
    destinationPublicationIdentity: route.destinationPublicationIdentity,
    draftId: route.draftId,
    reviewId: route.reviewId,
    evidenceSnapshotHash: route.evidenceSnapshotHash,
    contentHash: route.contentHash,
    contentType: route.contentType,
    language: route.language,
    framework: route.framework,
    transport: route.transport,
    executor: route.executor,
    executorAuthority: route.executorAuthority,
    credentialReference: route.credentialReference,
  }
}

export function projectFirstParty(value: unknown): readonly FirstPartyProjectionIntent[] {
  const plan = verifiedPlan(value)
  const intents = plan.routes.filter((route) => capabilityFor(route.framework, route.transport)?.projection === 'first_party').map((route) => {
    const capability = assertCapability(route, 'first_party')
    if (route.framework !== 'astro' && route.framework !== 'nuxt') throw new Error('non-first-party route entered first-party projection')
    let transport: FirstPartyProjectionIntent['transport']
    if (route.transport === 'first_party_git' || route.transport === 'first_party_signed_api') transport = route.transport
    else throw new Error('invalid first-party transport')
    let executor: FirstPartyProjectionIntent['executor']
    if (route.executor === 'first_party_git' || route.executor === 'first_party_signed_api') executor = route.executor
    else throw new Error('invalid first-party executor')
    if (capability.authority !== 'discoverystack_first_party') throw new Error('invalid first-party authority')
    if (route.targetUrl === null) throw new Error('first-party target URL is missing')
    const intent: FirstPartyProjectionIntent = {
      projection: 'first_party',
      ...common(route, plan),
      framework: route.framework,
      transport,
      executor,
      executorAuthority: 'discoverystack_first_party',
      targetUrl: route.targetUrl,
    }
    return cloneAndFreeze(intent)
  })
  return Object.freeze(intents)
}

export function projectGeoflow(value: unknown): readonly GeoflowProjectionIntent[] {
  const plan = verifiedPlan(value)
  const intents = plan.routes.filter((route) => capabilityFor(route.framework, route.transport)?.projection === 'geoflow').map((route) => {
    const capability = assertCapability(route, 'geoflow')
    if (route.framework === 'astro' || route.framework === 'nuxt') throw new Error('first-party route entered GEOFlow projection')
    let transport: GeoflowProjectionIntent['transport']
    if (route.transport === 'wordpress_rest' || route.transport === 'geoflow_agent' || route.transport === 'generic_http' || route.transport === 'geoflow_local') transport = route.transport
    else throw new Error('invalid GEOFlow transport')
    let executor: GeoflowProjectionIntent['executor']
    if (route.executor === 'wordpress_rest' || route.executor === 'geoflow_agent' || route.executor === 'generic_http' || route.executor === 'geoflow_local') executor = route.executor
    else throw new Error('invalid GEOFlow executor')
    if (capability.authority !== 'geoflow_content_engine') throw new Error('invalid GEOFlow authority')
    const intent: GeoflowProjectionIntent = {
      projection: 'geoflow',
      ...common(route, plan),
      framework: route.framework,
      transport,
      executor,
      executorAuthority: 'geoflow_content_engine',
      targetUrl: route.targetUrl,
      serviceReference: route.serviceReference,
      geoflowSourceSha: GEOFlow_PINNED_SOURCE_SHA,
    }
    return cloneAndFreeze(intent)
  })
  return Object.freeze(intents)
}

export function projectPlan(value: unknown): ProjectionSet {
  const plan = verifiedPlan(value)
  return cloneAndFreeze({ firstParty: projectFirstParty(plan), geoflow: projectGeoflow(plan) }) as ProjectionSet
}

function normalizedProjection(value: Record<string, unknown>, plan: RoutingPlan): ProjectionIntent | null {
  if (value.projection === 'first_party') {
    if (!exactKeys(value, FIRST_PARTY_PROJECTION_KEYS)) return null
    const route = plan.routes.find((candidate) => candidate.routeId === value.routeId)
    if (!route || capabilityFor(route.framework, route.transport)?.projection !== 'first_party') return null
    if (value.planFingerprint !== plan.planFingerprint) return null
    if (typeof value.routeId !== 'string' || typeof value.targetId !== 'string' || typeof value.siteIdentity !== 'string' || typeof value.sourcePublicationIdentity !== 'string' || typeof value.destinationPublicationIdentity !== 'string' || typeof value.draftId !== 'string' || typeof value.reviewId !== 'string' || typeof value.contentType !== 'string' || typeof value.language !== 'string' || typeof value.framework !== 'string' || typeof value.transport !== 'string' || typeof value.executor !== 'string' || typeof value.executorAuthority !== 'string' || typeof value.targetUrl !== 'string') return null
    normalizeId(value.routeId, 'projection.routeId')
    normalizeId(value.targetId, 'projection.targetId')
    normalizeId(value.siteIdentity, 'projection.siteIdentity')
    normalizeId(value.sourcePublicationIdentity, 'projection.sourcePublicationIdentity')
    normalizeId(value.destinationPublicationIdentity, 'projection.destinationPublicationIdentity')
    normalizeId(value.draftId, 'projection.draftId')
    normalizeId(value.reviewId, 'projection.reviewId')
    normalizeHash(value.evidenceSnapshotHash, 'projection.evidenceSnapshotHash')
    normalizeHash(value.contentHash, 'projection.contentHash')
    normalizeId(value.contentType, 'projection.contentType')
    normalizeId(value.language, 'projection.language')
    normalizeOpaqueReference(value.credentialReference, 'projection.credentialReference')
    if (value.executor !== route.executor || value.executorAuthority !== route.executorAuthority || value.targetId !== route.targetId || value.siteIdentity !== route.siteIdentity || value.sourcePublicationIdentity !== route.sourcePublicationIdentity || value.destinationPublicationIdentity !== route.destinationPublicationIdentity || value.draftId !== route.draftId || value.reviewId !== route.reviewId || value.evidenceSnapshotHash !== route.evidenceSnapshotHash || value.contentHash !== route.contentHash || value.contentType !== route.contentType || value.language !== route.language || value.framework !== route.framework || value.transport !== route.transport || value.targetUrl !== route.targetUrl || value.credentialReference !== route.credentialReference) return null
    return value as unknown as ProjectionIntent
  }
  if (value.projection === 'geoflow') {
    if (!exactKeys(value, GEOFLOW_PROJECTION_KEYS)) return null
    const route = plan.routes.find((candidate) => candidate.routeId === value.routeId)
    if (!route || capabilityFor(route.framework, route.transport)?.projection !== 'geoflow') return null
    if (value.planFingerprint !== plan.planFingerprint) return null
    if (typeof value.routeId !== 'string' || typeof value.targetId !== 'string' || typeof value.siteIdentity !== 'string' || typeof value.sourcePublicationIdentity !== 'string' || typeof value.destinationPublicationIdentity !== 'string' || typeof value.draftId !== 'string' || typeof value.reviewId !== 'string' || typeof value.contentType !== 'string' || typeof value.language !== 'string' || typeof value.framework !== 'string' || typeof value.transport !== 'string' || typeof value.executor !== 'string' || typeof value.executorAuthority !== 'string') return null
    normalizeId(value.routeId, 'projection.routeId')
    normalizeId(value.targetId, 'projection.targetId')
    normalizeId(value.siteIdentity, 'projection.siteIdentity')
    normalizeId(value.sourcePublicationIdentity, 'projection.sourcePublicationIdentity')
    normalizeId(value.destinationPublicationIdentity, 'projection.destinationPublicationIdentity')
    normalizeId(value.draftId, 'projection.draftId')
    normalizeId(value.reviewId, 'projection.reviewId')
    normalizeHash(value.evidenceSnapshotHash, 'projection.evidenceSnapshotHash')
    normalizeHash(value.contentHash, 'projection.contentHash')
    normalizeId(value.contentType, 'projection.contentType')
    normalizeId(value.language, 'projection.language')
    normalizeOpaqueReference(value.credentialReference, 'projection.credentialReference')
    if (value.executor !== route.executor || value.executorAuthority !== route.executorAuthority || value.targetId !== route.targetId || value.siteIdentity !== route.siteIdentity || value.sourcePublicationIdentity !== route.sourcePublicationIdentity || value.destinationPublicationIdentity !== route.destinationPublicationIdentity || value.draftId !== route.draftId || value.reviewId !== route.reviewId || value.evidenceSnapshotHash !== route.evidenceSnapshotHash || value.contentHash !== route.contentHash || value.contentType !== route.contentType || value.language !== route.language || value.framework !== route.framework || value.transport !== route.transport || value.targetUrl !== route.targetUrl || value.serviceReference !== route.serviceReference || value.geoflowSourceSha !== GEOFlow_PINNED_SOURCE_SHA || value.credentialReference !== route.credentialReference) return null
    return value as unknown as ProjectionIntent
  }
  return null
}

export function validateProjectionIntent(planValue: unknown, value: unknown): ProjectionValidationResult {
  try {
    const plan = verifiedPlan(planValue)
    if (!isPlainObject(value)) return invalidProjection('PROJECTION_SHAPE_INVALID')
    const normalized = normalizedProjection(value, plan)
    if (!normalized) return invalidProjection('PROJECTION_BINDING_INVALID')
    const expected = normalized.projection === 'first_party'
      ? projectFirstParty(plan).find((intent) => intent.routeId === normalized.routeId)
      : projectGeoflow(plan).find((intent) => intent.routeId === normalized.routeId)
    if (!expected || fingerprint(expected) !== fingerprint(normalized)) return invalidProjection('PROJECTION_FINGERPRINT_MISMATCH')
    return { valid: true, projection: cloneAndFreeze(expected), reasonCodes: [] }
  } catch {
    return invalidProjection('PROJECTION_RUNTIME_VALIDATION_FAILED')
  }
}

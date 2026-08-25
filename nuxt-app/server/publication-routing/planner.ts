import { MAX_TARGETS, MIN_TARGETS, SHA256_PATTERN } from './constants'
import { PUBLICATION_ROUTING_VERSION } from './types'
import { canonicalJson, fingerprint, planFingerprint, routeIdFor, routeIdentityKey } from './canonical'
import { capabilityFor } from './capability-matrix'
import { exactKeys, isPlainObject, normalizeDraft, normalizeId, normalizeIdempotencyKey, normalizeLineage, normalizeOpaqueReference, normalizeTarget, type NormalizedTarget } from './normalization'
import { guardTarget } from './target-guard'
import type { CreateRoutingPlanInput, RouteIntent, RoutingPlan, RoutingPlanValidationResult } from './types'

const PLAN_KEYS = ['version', 'status', 'plannedAt', 'metadata', 'routes', 'planFingerprint', 'idempotencyKey'] as const
const ROUTE_KEYS = ['ownerIdentity', 'clientIdentity', 'productionPlanId', 'deliverableId', 'draftId', 'reviewId', 'evidenceSnapshotHash', 'contentHash', 'contentType', 'language', 'sourcePublicationIdentity', 'geoflowSourceSha', 'routeId', 'targetId', 'siteIdentity', 'framework', 'transport', 'executor', 'executorAuthority', 'targetUrl', 'serviceReference', 'credentialReference', 'destinationPublicationIdentity', 'status'] as const

function invalidInput(message: string): never {
  throw new Error(message)
}

function invalidPlan(...reasonCodes: string[]): RoutingPlanValidationResult {
  return { valid: false, plan: null, reasonCodes }
}

function isEpoch(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function sameJson(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right)
}

function targetCanonicalKey(target: NormalizedTarget, normalizedUrl: string | null, normalizedServiceReference: string | null): string {
  return canonicalJson({ target: normalizedUrl ?? normalizedServiceReference })
}

function validateRoute(value: unknown, metadata: RoutingPlan['metadata']): RouteIntent | null {
  if (!isPlainObject(value) || !exactKeys(value, ROUTE_KEYS)) return null
  const route = value as unknown as RouteIntent
  const normalizedRouteId = normalizeId(route.routeId, 'routeId')
  if (route.status !== 'planned') return null
  const lineage = normalizeLineage({
    ownerIdentity: route.ownerIdentity,
    clientIdentity: route.clientIdentity,
    productionPlanId: route.productionPlanId,
    deliverableId: route.deliverableId,
    draftId: route.draftId,
    reviewId: route.reviewId,
    evidenceSnapshotHash: route.evidenceSnapshotHash,
    contentHash: route.contentHash,
    contentType: route.contentType,
    language: route.language,
    sourcePublicationIdentity: route.sourcePublicationIdentity,
    geoflowSourceSha: route.geoflowSourceSha,
  }, 'route')
  if (!sameJson(lineage, metadata)) return null
  const targetId = normalizeId(route.targetId, 'route.targetId')
  const siteIdentity = normalizeId(route.siteIdentity, 'route.siteIdentity')
  const sourcePublicationIdentity = normalizeId(route.sourcePublicationIdentity, 'route.sourcePublicationIdentity')
  const destinationPublicationIdentity = normalizeId(route.destinationPublicationIdentity, 'route.destinationPublicationIdentity')
  const credentialReference = normalizeOpaqueReference(route.credentialReference, 'route.credentialReference')
  if (typeof route.targetUrl !== 'string' && route.targetUrl !== null) return null
  if (typeof route.serviceReference !== 'string' && route.serviceReference !== null) return null
  const capability = capabilityFor(route.framework, route.transport)
  if (!capability || route.executor !== capability.executor || route.executorAuthority !== capability.authority) return null
  const target: NormalizedTarget = {
    targetId,
    siteIdentity,
    framework: route.framework,
    transport: route.transport,
    targetUrl: route.targetUrl,
    serviceReference: route.serviceReference,
    credentialReference,
    destinationPublicationIdentity,
  }
  const guard = guardTarget(target)
  if (!guard.valid || guard.normalizedUrl !== route.targetUrl || guard.normalizedServiceReference !== route.serviceReference) return null
  const normalizedRoute: RouteIntent = {
    ...lineage,
    routeId: normalizedRouteId,
    targetId,
    siteIdentity,
    framework: route.framework,
    transport: route.transport,
    executor: capability.executor,
    executorAuthority: capability.authority,
    targetUrl: route.targetUrl,
    serviceReference: route.serviceReference,
    credentialReference: credentialReference as RouteIntent['credentialReference'],
    destinationPublicationIdentity,
    status: 'planned',
  }
  if (routeIdFor(normalizedRoute) !== normalizedRouteId) return null
  return normalizedRoute
}

export function validateRoutingPlan(value: unknown): RoutingPlanValidationResult {
  try {
    if (!isPlainObject(value) || !exactKeys(value, PLAN_KEYS)) return invalidPlan('PLAN_SHAPE_INVALID')
    const candidate = value as unknown as RoutingPlan
    if (candidate.version !== PUBLICATION_ROUTING_VERSION) return invalidPlan('PLAN_VERSION_INVALID')
    if (candidate.status !== 'planned') return invalidPlan('PLAN_STATUS_INVALID')
    if (!isEpoch(candidate.plannedAt)) return invalidPlan('PLAN_PLANNED_AT_INVALID')
    if (!Array.isArray(candidate.routes) || candidate.routes.length < MIN_TARGETS || candidate.routes.length > MAX_TARGETS) return invalidPlan('PLAN_ROUTE_COUNT_INVALID')
    const metadata = normalizeLineage(candidate.metadata, 'metadata')
    const idempotencyKey = normalizeIdempotencyKey(candidate.idempotencyKey)
    if (typeof candidate.planFingerprint !== 'string' || !SHA256_PATTERN.test(candidate.planFingerprint)) return invalidPlan('PLAN_FINGERPRINT_INVALID')
    const routes: RouteIntent[] = []
    const routeIds = new Set<string>()
    const routeIdentities = new Set<string>()
    const siteDestinations = new Set<string>()
    for (const rawRoute of candidate.routes) {
      const route = validateRoute(rawRoute, metadata)
      if (!route) return invalidPlan('PLAN_ROUTE_INVALID')
      const routeIdentity = routeIdentityKey(route)
      const siteDestination = `${route.siteIdentity}\u0000${route.destinationPublicationIdentity}`
      if (routeIds.has(route.routeId)) return invalidPlan('PLAN_ROUTE_ID_DUPLICATE')
      if (routeIdentities.has(routeIdentity)) return invalidPlan('PLAN_ROUTE_IDENTITY_DUPLICATE')
      if (siteDestinations.has(siteDestination)) return invalidPlan('PLAN_SITE_DESTINATION_DUPLICATE')
      routeIds.add(route.routeId)
      routeIdentities.add(routeIdentity)
      siteDestinations.add(siteDestination)
      routes.push(route)
    }
    const ordered = [...routes].sort((left, right) => {
      const leftKey = routeIdentityKey(left)
      const rightKey = routeIdentityKey(right)
      return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0
    })
    if (!ordered.every((route, index) => sameJson(route, routes[index]))) return invalidPlan('PLAN_ROUTE_ORDER_INVALID')
    const normalizedPlanBody = { version: PUBLICATION_ROUTING_VERSION, status: 'planned' as const, plannedAt: candidate.plannedAt, metadata, routes }
    if (planFingerprint(normalizedPlanBody) !== candidate.planFingerprint) return invalidPlan('PLAN_FINGERPRINT_MISMATCH')
    const normalizedPlan: RoutingPlan = { ...normalizedPlanBody, planFingerprint: candidate.planFingerprint, idempotencyKey }
    canonicalJson(normalizedPlan)
    return { valid: true, plan: normalizedPlan, reasonCodes: [] }
  } catch {
    return invalidPlan('PLAN_RUNTIME_VALIDATION_FAILED')
  }
}

export function createRoutingPlan(input: CreateRoutingPlanInput): RoutingPlan {
  if (!isPlainObject(input) || !exactKeys(input, ['draft', 'targets', 'plannedAt', 'idempotencyKey'], ['draft', 'targets', 'plannedAt'])) invalidInput('input has unknown or missing fields')
  if (!isEpoch(input.plannedAt)) invalidInput('plannedAt must be a non-negative epoch millisecond integer')
  if (!Array.isArray(input.targets)) invalidInput('targets must be an array')
  if (input.targets.length < MIN_TARGETS || input.targets.length > MAX_TARGETS) invalidInput(`targets must contain ${MIN_TARGETS}–${MAX_TARGETS} entries`)
  const draft = normalizeDraft(input.draft)
  const normalizedTargets: Array<{ target: NormalizedTarget; url: string | null; serviceReference: string | null }> = []
  const canonicalTargets = new Set<string>()
  const siteDestinationKeys = new Set<string>()
  for (const rawTarget of input.targets) {
    const target = normalizeTarget(rawTarget)
    const capability = capabilityFor(target.framework, target.transport)
    if (!capability) invalidInput(`unsupported capability combination: ${String(target.framework)}/${String(target.transport)}`)
    const guard = guardTarget(target)
    if (!guard.valid) invalidInput(`target ${target.targetId} blocked: ${guard.reasonCodes.join('; ')}`)
    const normalizedUrl = guard.normalizedUrl
    const normalizedServiceReference = guard.normalizedServiceReference
    const canonicalTarget = targetCanonicalKey(target, normalizedUrl, normalizedServiceReference)
    if (canonicalTargets.has(canonicalTarget)) invalidInput(`duplicate canonical target: ${target.targetId}`)
    canonicalTargets.add(canonicalTarget)
    const siteDestinationKey = `${target.siteIdentity}\u0000${target.destinationPublicationIdentity}`
    if (siteDestinationKeys.has(siteDestinationKey)) invalidInput(`duplicate site destination identity: ${target.siteIdentity}/${target.destinationPublicationIdentity}`)
    siteDestinationKeys.add(siteDestinationKey)
    normalizedTargets.push({ target, url: normalizedUrl, serviceReference: normalizedServiceReference })
  }
  const routes: RouteIntent[] = normalizedTargets
    .map(({ target, url, serviceReference }) => {
      const capability = capabilityFor(target.framework, target.transport)
      if (!capability) invalidInput('capability disappeared during planning')
      const route: RouteIntent = {
        ...draft.lineage,
        routeId: 'route_pending',
        targetId: target.targetId,
        siteIdentity: target.siteIdentity,
        framework: target.framework,
        transport: target.transport,
        executor: capability.executor,
        executorAuthority: capability.authority,
        targetUrl: url,
        serviceReference,
        credentialReference: target.credentialReference as RouteIntent['credentialReference'],
        destinationPublicationIdentity: target.destinationPublicationIdentity,
        status: 'planned',
      }
      return { ...route, routeId: routeIdFor(route) }
    })
    .sort((left, right) => {
      const leftKey = routeIdentityKey(left)
      const rightKey = routeIdentityKey(right)
      return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0
    })
  const metadata = { ...draft.lineage }
  const planBody = { version: PUBLICATION_ROUTING_VERSION, status: 'planned' as const, plannedAt: input.plannedAt, metadata, routes }
  const computedFingerprint = planFingerprint(planBody)
  const idempotencyKey = input.idempotencyKey === undefined
    ? `publication-routing-v2:${fingerprint(planBody)}`
    : normalizeIdempotencyKey(input.idempotencyKey)
  const plan: RoutingPlan = { ...planBody, planFingerprint: computedFingerprint, idempotencyKey }
  const verified = validateRoutingPlan(plan)
  if (!verified.valid) invalidInput(`created plan failed verification: ${verified.reasonCodes.join('; ')}`)
  return verified.plan
}

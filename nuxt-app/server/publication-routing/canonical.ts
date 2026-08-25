import { createHash } from 'node:crypto'
import { PUBLICATION_ROUTING_VERSION } from './types'
import type { CanonicalValue, RouteIntent, RoutingPlan } from './types'

export function compareCodeUnits(left: string, right: string): number {
  if (left < right) return -1
  if (left > right) return 1
  return 0
}

function canonicalizeValue(value: unknown, stack: WeakSet<object>): CanonicalValue {
  if (value === null) return null
  if (typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('non-finite number cannot be canonicalized')
    return Object.is(value, -0) ? 0 : value
  }
  if (typeof value !== 'object') throw new Error(`unsupported canonical value type: ${typeof value}`)
  if (stack.has(value)) throw new Error('circular value cannot be canonicalized')
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null && !Array.isArray(value)) throw new Error('only plain objects can be canonicalized')
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key === 'symbol') throw new Error('symbol keys cannot be canonicalized')
  }
  stack.add(value)
  try {
    if (Array.isArray(value)) {
      const keys = Object.keys(value)
      for (let index = 0; index < value.length; index += 1) {
        if (!keys.includes(String(index))) throw new Error('sparse arrays cannot be canonicalized')
      }
      if (keys.some((key) => !/^\d+$/.test(key) || Number(key) >= value.length)) throw new Error('array extra fields cannot be canonicalized')
      return value.map((entry) => canonicalizeValue(entry, stack))
    }
    const record = value as Record<string, unknown>
    const keys = Object.keys(record).sort(compareCodeUnits)
    const result: Record<string, CanonicalValue> = {}
    for (const key of keys) {
      const entry = record[key]
      if (entry === undefined) throw new Error(`undefined value at ${key}`)
      result[key] = canonicalizeValue(entry, stack)
    }
    return result
  } finally {
    stack.delete(value)
  }
}

export function canonicalize(value: unknown): CanonicalValue {
  return canonicalizeValue(value, new WeakSet<object>())
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value))
}

export function cloneCanonical<T>(value: T): T {
  return canonicalize(value) as T
}

export function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const key of Reflect.ownKeys(value as object)) {
      deepFreeze((value as Record<PropertyKey, unknown>)[key])
    }
    Object.freeze(value)
  }
  return value
}

export function cloneAndFreeze<T>(value: T): T {
  return deepFreeze(cloneCanonical(value))
}

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

export function fingerprint(value: unknown): string {
  return sha256Hex(canonicalJson(value))
}

export function routeIdentityKey(route: Pick<RouteIntent, 'siteIdentity' | 'destinationPublicationIdentity' | 'targetId'>): string {
  return canonicalJson({ siteIdentity: route.siteIdentity, destinationPublicationIdentity: route.destinationPublicationIdentity, targetId: route.targetId })
}

export function routeSeedPayload(route: Pick<RouteIntent, 'targetId' | 'siteIdentity' | 'framework' | 'transport' | 'targetUrl' | 'serviceReference' | 'sourcePublicationIdentity' | 'destinationPublicationIdentity' | 'ownerIdentity' | 'clientIdentity' | 'productionPlanId' | 'deliverableId' | 'draftId' | 'reviewId' | 'evidenceSnapshotHash' | 'contentHash' | 'contentType' | 'language' | 'geoflowSourceSha'>): CanonicalValue {
  return canonicalize({
    version: PUBLICATION_ROUTING_VERSION,
    lineage: {
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
    },
    targetId: route.targetId,
    siteIdentity: route.siteIdentity,
    framework: route.framework,
    transport: route.transport,
    targetUrl: route.targetUrl,
    serviceReference: route.serviceReference,
    sourcePublicationIdentity: route.sourcePublicationIdentity,
    destinationPublicationIdentity: route.destinationPublicationIdentity,
  })
}

export function routeIdFor(route: Parameters<typeof routeSeedPayload>[0]): string {
  return `route_${fingerprint(routeSeedPayload(route))}`
}

export function planCanonicalPayload(plan: Pick<RoutingPlan, 'version' | 'plannedAt' | 'metadata' | 'routes'>): CanonicalValue {
  return canonicalize({
    version: plan.version,
    plannedAt: plan.plannedAt,
    metadata: plan.metadata,
    routes: plan.routes,
  })
}

export function planFingerprint(plan: Pick<RoutingPlan, 'version' | 'plannedAt' | 'metadata' | 'routes'>): string {
  return fingerprint(planCanonicalPayload(plan))
}

export function isPlanReplay(existing: Pick<RoutingPlan, 'idempotencyKey' | 'planFingerprint'>, candidate: Pick<RoutingPlan, 'idempotencyKey' | 'planFingerprint'>): boolean {
  return existing.idempotencyKey === candidate.idempotencyKey && existing.planFingerprint === candidate.planFingerprint
}

export function isIdempotencyCollision(existing: Pick<RoutingPlan, 'idempotencyKey' | 'planFingerprint'>, candidate: Pick<RoutingPlan, 'idempotencyKey' | 'planFingerprint'>): boolean {
  return existing.idempotencyKey === candidate.idempotencyKey && existing.planFingerprint !== candidate.planFingerprint
}

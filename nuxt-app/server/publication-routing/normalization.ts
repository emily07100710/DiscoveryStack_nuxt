import {
  MAX_CONTENT_BYTES,
  MAX_IDEMPOTENCY_KEY_LENGTH,
  MAX_ID_LENGTH,
  MAX_LABEL_LENGTH,
  MAX_OPAQUE_REFERENCE_LENGTH,
  OPAQUE_REFERENCE_PATTERN,
  REFERENCE_SECRET_PATTERN,
  SHA256_PATTERN,
} from './constants'
import { GEOFlow_PINNED_SOURCE_SHA } from './types'
import { sha256Hex } from './canonical'
import type { Identity, PublicationDraft, PublicationTargetInput, RouteLineage } from './types'

export interface NormalizedDraft {
  readonly lineage: RouteLineage
  readonly content: string
}

export interface NormalizedTarget {
  readonly targetId: string
  readonly siteIdentity: string
  readonly framework: PublicationTargetInput['framework']
  readonly transport: PublicationTargetInput['transport']
  readonly targetUrl: string | null
  readonly serviceReference: string | null
  readonly credentialReference: string
  readonly destinationPublicationIdentity: string
}

export function isObject(value: unknown): value is object {
  return value !== null && typeof value === 'object'
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!isObject(value) || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

export function exactKeys(value: object, allowed: readonly string[], required: readonly string[] = allowed): boolean {
  const ownKeys = Reflect.ownKeys(value)
  if (ownKeys.some((key) => typeof key !== 'string')) return false
  const keys = ownKeys as string[]
  const allowedSet = new Set(allowed)
  const requiredSet = new Set(required)
  return keys.every((key) => allowedSet.has(key)) && new Set(keys).size === keys.length && [...requiredSet].every((key) => keys.includes(key))
}

function controlCharacter(value: string): boolean {
  return /[\u0000-\u001f\u007f-\u009f]/u.test(value)
}

function hasUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1)
      if (next < 0xdc00 || next > 0xdfff) return true
      index += 1
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true
    }
  }
  return false
}

export function normalizeMarkdownContent(value: unknown): string {
  if (typeof value !== 'string') throw new Error('content must be a string')
  if (value.length === 0) throw new Error('content must not be empty')
  if (hasUnpairedSurrogate(value)) throw new Error('content must not contain unpaired UTF-16 surrogates')
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code === 0x09 || code === 0x0a) continue
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) throw new Error('content must not contain disallowed control characters')
  }
  if (Buffer.byteLength(value, 'utf8') > MAX_CONTENT_BYTES) throw new Error('content exceeds UTF-8 byte limit')
  return value
}

export function normalizeBoundedString(value: unknown, field: string, maximum: number, minimum = 1): string {
  if (typeof value !== 'string') throw new Error(`${field} must be a string`)
  if (controlCharacter(value)) throw new Error(`${field} must not contain control characters`)
  if (value.trim() !== value) throw new Error(`${field} must already be normalized`)
  if (value.length < minimum || value.length > maximum) throw new Error(`${field} length must be ${minimum}-${maximum}`)
  return value
}

export function normalizeRequired(value: unknown, field: string, maximum = MAX_ID_LENGTH): string {
  return normalizeBoundedString(value, field, maximum)
}

export function normalizeId(value: unknown, field: string): string {
  return normalizeBoundedString(value, field, MAX_ID_LENGTH)
}

export function normalizeLabel(value: unknown, field: string): string {
  return normalizeBoundedString(value, field, MAX_LABEL_LENGTH)
}

export function normalizeIdempotencyKey(value: unknown): string {
  return normalizeBoundedString(value, 'idempotencyKey', MAX_IDEMPOTENCY_KEY_LENGTH)
}

export function normalizeOpaqueReference(value: unknown, field: string): string {
  const normalized = normalizeBoundedString(value, field, MAX_OPAQUE_REFERENCE_LENGTH)
  if (!OPAQUE_REFERENCE_PATTERN.test(normalized)) throw new Error(`${field} must be a ref-prefixed opaque reference`)
  if (/^(?:https?|ftp):/iu.test(normalized) || normalized.includes('/') || normalized.includes('\\') || /\s/u.test(normalized)) {
    throw new Error(`${field} must not contain a URL, slash, or whitespace`)
  }
  if (REFERENCE_SECRET_PATTERN.test(normalized)) throw new Error(`${field} must not contain token or credential material`)
  return normalized
}

export function normalizeHash(value: unknown, field: string): string {
  const normalized = normalizeBoundedString(value, field, 64, 64)
  if (!SHA256_PATTERN.test(normalized)) throw new Error(`${field} must be a lowercase SHA-256 hash`)
  return normalized
}

export function normalizeIdentity(value: unknown, field: string): Identity {
  if (!isPlainObject(value) || !exactKeys(value, ['id', 'label'], ['id'])) throw new Error(`${field} has an invalid shape`)
  const identity: { id?: unknown; label?: unknown } = value
  const result: Identity = { id: normalizeId(identity.id, `${field}.id`) }
  if (Object.prototype.hasOwnProperty.call(value, 'label')) return { ...result, label: normalizeLabel(identity.label, `${field}.label`) }
  return result
}

const LINEAGE_KEYS = ['ownerIdentity', 'clientIdentity', 'productionPlanId', 'deliverableId', 'draftId', 'reviewId', 'evidenceSnapshotHash', 'contentHash', 'contentType', 'language', 'sourcePublicationIdentity', 'geoflowSourceSha'] as const

export function normalizeLineage(value: unknown, field = 'metadata'): RouteLineage {
  if (!isPlainObject(value) || !exactKeys(value, LINEAGE_KEYS)) throw new Error(`${field} has unknown or missing fields`)
  const lineage = value as Record<string, unknown>
  const sourceSha = normalizeBoundedString(lineage.geoflowSourceSha, `${field}.geoflowSourceSha`, 40, 40)
  if (sourceSha !== GEOFlow_PINNED_SOURCE_SHA) throw new Error('GEOFlow source SHA is not pinned')
  return {
    ownerIdentity: normalizeIdentity(lineage.ownerIdentity, `${field}.ownerIdentity`),
    clientIdentity: normalizeIdentity(lineage.clientIdentity, `${field}.clientIdentity`),
    productionPlanId: normalizeId(lineage.productionPlanId, `${field}.productionPlanId`),
    deliverableId: normalizeId(lineage.deliverableId, `${field}.deliverableId`),
    draftId: normalizeId(lineage.draftId, `${field}.draftId`),
    reviewId: normalizeId(lineage.reviewId, `${field}.reviewId`),
    evidenceSnapshotHash: normalizeHash(lineage.evidenceSnapshotHash, `${field}.evidenceSnapshotHash`),
    contentHash: normalizeHash(lineage.contentHash, `${field}.contentHash`),
    contentType: normalizeId(lineage.contentType, `${field}.contentType`),
    language: normalizeId(lineage.language, `${field}.language`),
    sourcePublicationIdentity: normalizeId(lineage.sourcePublicationIdentity, `${field}.sourcePublicationIdentity`),
    geoflowSourceSha: GEOFlow_PINNED_SOURCE_SHA,
  }
}

export function normalizeDraft(value: unknown): NormalizedDraft {
  if (!isPlainObject(value)) throw new Error('draft must be a plain object')
  const allowed = ['ownerIdentity', 'clientIdentity', 'productionPlanId', 'deliverableId', 'draftId', 'reviewId', 'draftStage', 'reviewDecision', 'riskGateStatus', 'evidenceSnapshotHash', 'contentHash', 'content', 'contentType', 'language', 'sourcePublicationIdentity', 'geoflowSourceSha'] as const
  if (!exactKeys(value, allowed)) throw new Error('draft has unknown or missing fields')
  const draft = value as unknown as PublicationDraft
  if (draft.draftStage !== 'optimized') throw new Error('draft must be optimized')
  if (draft.reviewDecision !== 'approved_for_delivery') throw new Error('draft must be approved_for_delivery')
  if (draft.riskGateStatus !== 'passed') throw new Error('risk gate must be passed')
  const content = normalizeMarkdownContent(draft.content)
  const contentHash = normalizeHash(draft.contentHash, 'contentHash')
  if (sha256Hex(content) !== contentHash) throw new Error('contentHash does not match exact content')
  const lineage = normalizeLineage({
    ownerIdentity: draft.ownerIdentity,
    clientIdentity: draft.clientIdentity,
    productionPlanId: draft.productionPlanId,
    deliverableId: draft.deliverableId,
    draftId: draft.draftId,
    reviewId: draft.reviewId,
    evidenceSnapshotHash: draft.evidenceSnapshotHash,
    contentHash,
    contentType: draft.contentType,
    language: draft.language,
    sourcePublicationIdentity: draft.sourcePublicationIdentity,
    geoflowSourceSha: draft.geoflowSourceSha,
  }, 'draft')
  return { lineage, content }
}

export function normalizeTarget(value: unknown): NormalizedTarget {
  if (!isPlainObject(value)) throw new Error('target must be a plain object')
  const allowed = ['targetId', 'siteIdentity', 'framework', 'transport', 'targetUrl', 'serviceReference', 'credentialReference', 'destinationPublicationIdentity', 'enabled', 'authority', 'executor'] as const
  const required = ['targetId', 'siteIdentity', 'framework', 'transport', 'targetUrl', 'serviceReference', 'credentialReference', 'destinationPublicationIdentity', 'enabled'] as const
  if (!exactKeys(value, allowed, required)) throw new Error('target has unknown or missing fields')
  const target = value as unknown as PublicationTargetInput
  if (target.enabled !== true) throw new Error('enabled must be true')
  if (Object.prototype.hasOwnProperty.call(value, 'authority')) throw new Error('caller cannot specify executor authority')
  if (Object.prototype.hasOwnProperty.call(value, 'executor')) throw new Error('caller cannot specify executor')
  if (target.targetUrl !== null && typeof target.targetUrl !== 'string') throw new Error('targetUrl must be string or null')
  if (target.serviceReference !== null && typeof target.serviceReference !== 'string') throw new Error('serviceReference must be string or null')
  return {
    targetId: normalizeId(target.targetId, 'targetId'),
    siteIdentity: normalizeId(target.siteIdentity, 'siteIdentity'),
    framework: target.framework,
    transport: target.transport,
    targetUrl: target.targetUrl,
    serviceReference: target.serviceReference,
    credentialReference: normalizeOpaqueReference(target.credentialReference, 'credentialReference'),
    destinationPublicationIdentity: normalizeId(target.destinationPublicationIdentity, 'destinationPublicationIdentity'),
  }
}

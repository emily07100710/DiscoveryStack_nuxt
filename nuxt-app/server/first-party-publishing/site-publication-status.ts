import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import type { FirstPartyFetch, FirstPartyPublishTarget, NonceProvider, ServerCredentialResolver, ValidatedFirstPartyTarget } from './types'
import { isOpaqueReference } from './normalization'
import { isPublicHttpsOrigin, validateFirstPartyPublishTarget } from './target-guard'

export const SITE_PUBLICATION_STATUS_VERSION = 'ds-site-publication-status-v1' as const
export const SITE_PUBLICATION_STATUS_PATH = '/api/first-party/publication-status' as const
const MAX_BODY_BYTES = 4_096
const MAX_CLOCK_SKEW_MS = 300_000
const NONCE_PATTERN = /^[A-Za-z0-9_.:-]{8,128}$/u
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u

export interface SitePublicationStatusQuery {
  readonly publicationId: string
  readonly contentHash: string
  readonly postId: string
}

export interface SitePublicationObservation {
  readonly version: typeof SITE_PUBLICATION_STATUS_VERSION
  readonly targetId: string
  readonly targetOrigin: string
  readonly publicationId: string
  readonly contentHash: string
  readonly postId: string
  readonly receiptScope: 'site_publication_observation'
  readonly receiptIsCurrentState: false
  readonly state: 'published' | 'private' | 'archived'
  readonly postVersion: number
  readonly publishedVersion: number | null
  readonly receivedDocumentHash: string | null
  readonly publishedDocumentHash: string | null
  readonly hasUnpublishedChanges: boolean
  readonly publishedAt: string | null
  readonly observedAt: string
  readonly nonce: string
  /** This compares the receiver's current received and published document hashes, not DS source Markdown. */
  readonly documentState: 'in_sync' | 'changed' | 'unverifiable' | 'not_published'
}

export interface SitePublicationStatusDependencies {
  readonly fetchImpl: FirstPartyFetch
  readonly serverCredentialResolver: ServerCredentialResolver
  readonly nonceProvider: NonceProvider
  readonly now: Date
  readonly serverNowProvider?: () => Date
  readonly timeoutMs?: number
}

export type SitePublicationStatusFailureCode =
  | 'INVALID_INPUT' | 'TARGET_NOT_ALLOWED' | 'CREDENTIAL_UNAVAILABLE' | 'NONCE_INVALID'
  | 'INVALID_TIMESTAMP' | 'REQUEST_TOO_LARGE' | 'FETCH_UNAVAILABLE' | 'REMOTE_UNAVAILABLE'
  | 'RESPONSE_TOO_LARGE' | 'RESPONSE_INVALID' | 'SIGNATURE_INVALID' | 'REMOTE_IDENTITY_MISMATCH'

export type SitePublicationStatusResult =
  | { readonly status: 'verified'; readonly observation: SitePublicationObservation; readonly responseFingerprint: string }
  | { readonly status: 'blocked'; readonly code: SitePublicationStatusFailureCode; readonly reasons: readonly string[] }

type SitePublicationStatusRequest = {
  readonly version: typeof SITE_PUBLICATION_STATUS_VERSION
  readonly targetId: string
  readonly ownerScopeKey: string
  readonly publicationId: string
  readonly contentHash: string
  readonly postId: string
  readonly timestamp: string
  readonly nonce: string
}

const RESPONSE_KEYS = new Set([
  'version', 'targetId', 'targetOrigin', 'publicationId', 'contentHash', 'postId',
  'receiptScope', 'receiptIsCurrentState', 'state', 'postVersion', 'publishedVersion',
  'receivedDocumentHash', 'publishedDocumentHash', 'hasUnpublishedChanges', 'publishedAt',
  'observedAt', 'nonce',
])

function blocked(code: SitePublicationStatusFailureCode, reason: string): SitePublicationStatusResult {
  return { status: 'blocked', code, reasons: [reason] }
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function isHash(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value)
}

function validIso(value: unknown): value is string {
  if (typeof value !== 'string' || !ISO_UTC.test(value)) return false
  const time = Date.parse(value)
  return Number.isFinite(time) && new Date(time).toISOString() === value
}

function exactDataRecord(value: unknown, expectedKeys?: Set<string>): Record<string, unknown> | null {
  try {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) return null
    const keys = Reflect.ownKeys(value)
    if (keys.some(key => typeof key !== 'string')) return null
    const stringKeys = keys as string[]
    if (expectedKeys && (stringKeys.length !== expectedKeys.size || stringKeys.some(key => !expectedKeys.has(key)))) return null
    const descriptors = Object.getOwnPropertyDescriptors(value)
    const record: Record<string, unknown> = Object.create(null) as Record<string, unknown>
    for (const key of stringKeys) {
      const descriptor = descriptors[key]
      if (!descriptor || !('value' in descriptor) || descriptor.enumerable !== true) return null
      record[key] = descriptor.value
    }
    return record
  } catch {
    return null
  }
}

/** Structural validator for persisted observations. It does not authenticate a remote response. */
export function normalizeSitePublicationObservation(value: unknown): SitePublicationObservation | null {
  const raw = exactDataRecord(value, RESPONSE_KEYS)
  if (!raw || raw.version !== SITE_PUBLICATION_STATUS_VERSION
    || !isOpaqueReference(raw.targetId) || !isOpaqueReference(raw.publicationId) || !isOpaqueReference(raw.postId)
    || typeof raw.nonce !== 'string' || !NONCE_PATTERN.test(raw.nonce) || !isHash(raw.contentHash)
    || typeof raw.targetOrigin !== 'string' || !isPublicHttpsOrigin(raw.targetOrigin) || new URL(raw.targetOrigin).origin !== raw.targetOrigin || raw.receiptScope !== 'site_publication_observation'
    || raw.receiptIsCurrentState !== false || typeof raw.state !== 'string' || !['published', 'private', 'archived'].includes(raw.state)
    || !Number.isSafeInteger(raw.postVersion) || (raw.postVersion as number) < 1
    || !(raw.publishedVersion === null || (Number.isSafeInteger(raw.publishedVersion) && (raw.publishedVersion as number) >= 1))
    || !(raw.receivedDocumentHash === null || isHash(raw.receivedDocumentHash))
    || !(raw.publishedDocumentHash === null || isHash(raw.publishedDocumentHash))
    || typeof raw.hasUnpublishedChanges !== 'boolean' || !validIso(raw.observedAt)
    || !(raw.publishedAt === null || validIso(raw.publishedAt))) return null

  const state = raw.state as SitePublicationObservation['state']
  const postVersion = raw.postVersion as number
  const publishedVersion = raw.publishedVersion as number | null
  const receivedDocumentHash = raw.receivedDocumentHash as string | null
  const publishedDocumentHash = raw.publishedDocumentHash as string | null
  const publishedAt = raw.publishedAt as string | null
  let documentState: SitePublicationObservation['documentState']

  if (state === 'published') {
    if (publishedVersion === null || publishedVersion < 2 || publishedVersion > postVersion
      || (publishedAt !== null && publishedAt > raw.observedAt)
      || raw.hasUnpublishedChanges !== (publishedVersion !== postVersion)) return null
    documentState = receivedDocumentHash === null || publishedDocumentHash === null
      ? 'unverifiable'
      : receivedDocumentHash === publishedDocumentHash ? 'in_sync' : 'changed'
  } else {
    if (publishedVersion !== null || publishedDocumentHash !== null || publishedAt !== null || raw.hasUnpublishedChanges !== false) return null
    documentState = 'not_published'
  }

  return {
    version: SITE_PUBLICATION_STATUS_VERSION,
    targetId: raw.targetId,
    targetOrigin: raw.targetOrigin,
    publicationId: raw.publicationId,
    contentHash: raw.contentHash,
    postId: raw.postId,
    receiptScope: 'site_publication_observation',
    receiptIsCurrentState: false,
    state,
    postVersion,
    publishedVersion,
    receivedDocumentHash,
    publishedDocumentHash,
    hasUnpublishedChanges: raw.hasUnpublishedChanges,
    publishedAt,
    observedAt: raw.observedAt,
    nonce: raw.nonce,
    documentState,
  }
}

function signature(secret: string, fields: readonly string[]): string {
  return createHmac('sha256', secret).update(fields.join('\n'), 'utf8').digest('hex')
}

function signatureMatches(actual: unknown, expected: string): boolean {
  if (typeof actual !== 'string' || !/^[a-f0-9]{64}$/u.test(actual)) return false
  const actualBytes = Buffer.from(actual, 'hex')
  const expectedBytes = Buffer.from(expected, 'hex')
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes)
}

function responseSignatureHeader(headers: Readonly<Record<string, string | undefined>> | undefined): string | undefined {
  if (!headers) return undefined
  for (const [name, value] of Object.entries(headers)) if (name.toLowerCase() === 'x-ds-status-signature') return value
  return undefined
}

function isBoundedOpaque(value: unknown): value is string {
  return isOpaqueReference(value, 128)
}

/** Read-only signed query. It never publishes, retries, mutates a remote post, or grants learning authority. */
export async function checkFirstPartySitePublication(
  input: SitePublicationStatusQuery,
  target: FirstPartyPublishTarget,
  dependencies: SitePublicationStatusDependencies,
): Promise<SitePublicationStatusResult> {
  try {
    const guarded = validateFirstPartyPublishTarget(target)
    if (guarded.status !== 'valid' || guarded.target.framework !== 'nextjs'
      || guarded.target.transport !== 'first_party_signed_api' || guarded.target.status !== 'active' || !guarded.target.executionEnabled) {
      return blocked('TARGET_NOT_ALLOWED', 'publication status requires an active, enabled Next.js signed-API target')
    }
    const validatedTarget: ValidatedFirstPartyTarget = guarded.target
    const query = exactDataRecord(input, new Set(['publicationId', 'contentHash', 'postId']))
    if (!query || !isBoundedOpaque(query.publicationId) || !isBoundedOpaque(query.postId) || !isHash(query.contentHash)) {
      return blocked('INVALID_INPUT', 'publication status query identity is invalid')
    }
    if (typeof dependencies.fetchImpl !== 'function') return blocked('FETCH_UNAVAILABLE', 'publication status fetch is unavailable')
    if (typeof dependencies.serverCredentialResolver !== 'function' || typeof dependencies.nonceProvider !== 'function') return blocked('CREDENTIAL_UNAVAILABLE', 'publication status credentials are unavailable')
    if (!(dependencies.now instanceof Date) || !Number.isFinite(dependencies.now.getTime())) return blocked('INVALID_TIMESTAMP', 'publication status clock is invalid')
    const serverNow = dependencies.serverNowProvider?.() ?? dependencies.now
    if (!(serverNow instanceof Date) || !Number.isFinite(serverNow.getTime())
      || Math.abs(serverNow.getTime() - dependencies.now.getTime()) > MAX_CLOCK_SKEW_MS) return blocked('INVALID_TIMESTAMP', 'publication status request time is outside the allowed clock window')
    const timeoutMs = dependencies.timeoutMs ?? 15_000
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) return blocked('INVALID_INPUT', 'publication status timeout is outside policy')

    const resolved = await dependencies.serverCredentialResolver(validatedTarget.credentialReference)
    if (!resolved.ok || typeof resolved.value !== 'string' || resolved.value.length < 32 || resolved.value.length > 1_024 || /[\u0000-\u0020\u007f]/u.test(resolved.value)) {
      return blocked('CREDENTIAL_UNAVAILABLE', 'publication status credential could not be resolved')
    }
    const nonce = dependencies.nonceProvider()
    if (typeof nonce !== 'string' || !NONCE_PATTERN.test(nonce)) return blocked('NONCE_INVALID', 'publication status nonce is invalid')
    const timestamp = dependencies.now.toISOString()
    const request: SitePublicationStatusRequest = {
      version: SITE_PUBLICATION_STATUS_VERSION,
      targetId: validatedTarget.targetId,
      ownerScopeKey: validatedTarget.ownerScopeKey,
      publicationId: query.publicationId,
      contentHash: query.contentHash,
      postId: query.postId,
      timestamp,
      nonce,
    }
    const rawRequest = JSON.stringify(request)
    if (Buffer.byteLength(rawRequest, 'utf8') > MAX_BODY_BYTES) return blocked('REQUEST_TOO_LARGE', 'publication status request exceeds the byte limit')
    const origin = validatedTarget.targetOrigin
    const requestSignature = signature(resolved.value, [SITE_PUBLICATION_STATUS_VERSION, 'request', 'POST', SITE_PUBLICATION_STATUS_PATH, origin, sha256(rawRequest), timestamp, nonce])
    const url = `${origin}${SITE_PUBLICATION_STATUS_PATH}`
    const response = await dependencies.fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-ds-status-signature': requestSignature },
      body: rawRequest,
      redirect: 'manual',
      timeoutMs,
    })
    if (response.status !== 200) return blocked('REMOTE_UNAVAILABLE', 'publication status receiver did not return the required status')
    const rawResponse = await response.text()
    if (typeof rawResponse !== 'string' || Buffer.byteLength(rawResponse, 'utf8') > MAX_BODY_BYTES) return blocked('RESPONSE_TOO_LARGE', 'publication status response exceeds the byte limit')
    const responseSignature = responseSignatureHeader(response.headers)
    const expectedResponseSignature = signature(resolved.value, [
      SITE_PUBLICATION_STATUS_VERSION, 'response', 'POST', SITE_PUBLICATION_STATUS_PATH, origin,
      sha256(rawRequest), sha256(rawResponse), timestamp, nonce,
    ])
    if (!signatureMatches(responseSignature, expectedResponseSignature)) return blocked('SIGNATURE_INVALID', 'publication status response signature is invalid')
    let parsed: unknown
    try { parsed = JSON.parse(rawResponse) } catch { return blocked('RESPONSE_INVALID', 'publication status response is not valid JSON') }
    const observation = normalizeSitePublicationObservation(parsed)
    if (!observation || observation.targetId !== validatedTarget.targetId || observation.targetOrigin !== origin
      || observation.publicationId !== query.publicationId || observation.contentHash !== query.contentHash
      || observation.postId !== query.postId || observation.nonce !== nonce
      || Math.abs(Date.parse(observation.observedAt) - serverNow.getTime()) > MAX_CLOCK_SKEW_MS) {
      return blocked('REMOTE_IDENTITY_MISMATCH', 'publication status response does not match the signed target and query')
    }
    const responseFingerprint = sha256(`${rawRequest}\n${rawResponse}\n${responseSignature}`)
    return { status: 'verified', observation, responseFingerprint }
  } catch {
    return blocked('REMOTE_UNAVAILABLE', 'publication status could not be verified')
  }
}

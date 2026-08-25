import type { GeoFlowRequest, GeoFlowResponse, LineageVerification, ReasonCode, ValidationFailure, ValidationResult, ValidationSuccess } from './types'
import { validateGeoFlowRequest, validateGeoFlowResponse } from './schemas'

function success<T>(value: T): ValidationSuccess<T> { return { ok: true, value } }
function failure(reason: ReasonCode, path = '$'): ValidationFailure { return { ok: false, reason, issues: [{ path, code: reason }] } }

/** Stable local identity used to bind an external article to one calendar entry/deliverable pair. */
export function deriveExternalArticleKey(request: Pick<GeoFlowRequest, 'calendarEntryId' | 'deliverableId'>): string {
  return `article-${request.calendarEntryId}-${request.deliverableId}`
}

export function verifyGeoFlowLineage(requestInput: unknown, responseInput: unknown): ValidationResult<LineageVerification> {
  const request = validateGeoFlowRequest(requestInput)
  if (!request.ok) return request
  const response = validateGeoFlowResponse(responseInput, request.value)
  if (!response.ok) return response
  const expectedArticleKey = deriveExternalArticleKey(request.value)
  if (response.value.externalArticleKey !== expectedArticleKey) return failure('IDENTITY_MISMATCH', '$.externalArticleKey')
  if (response.value.draftIdentity.externalArticleKey !== expectedArticleKey) return failure('IDENTITY_MISMATCH', '$.draftIdentity.externalArticleKey')
  if (response.value.status === 'published' && response.value.providerProvenance.mode === 'provider' && response.value.providerProvenance.fallbackReason !== null) return failure('UNTRUSTED_PUBLISHED_RESULT', '$.providerProvenance.fallbackReason')
  return success({ request: request.value, response: response.value })
}

export function verifyPublishedGeoFlowLineage(requestInput: unknown, responseInput: unknown): ValidationResult<LineageVerification> {
  const verified = verifyGeoFlowLineage(requestInput, responseInput)
  if (!verified.ok) return verified
  if (verified.value.response.status !== 'published') return failure('UNTRUSTED_PUBLISHED_RESULT', '$.status')
  return verified
}

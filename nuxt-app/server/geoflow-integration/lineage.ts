import type { GeoFlowRequest, LineageVerification, ReasonCode, ValidationFailure, ValidationResult, ValidationSuccess } from './types'
import { validateGeoFlowRequest, validateGeoFlowResponse } from './schemas'

function success<T>(value: T): ValidationSuccess<T> { return { ok: true, value } }
function failure(reason: ReasonCode, path = '$'): ValidationFailure { return { ok: false, reason, issues: [{ path, code: reason }] } }

/** Stable generation identity; publication authority remains in DiscoveryStack delivery. */
export function deriveExternalArticleKey(request: Pick<GeoFlowRequest, 'calendarEntryId' | 'deliverableId'>): string {
  return `article-${request.calendarEntryId}-${request.deliverableId}`
}

export function verifyGeoFlowLineage(requestInput: unknown, responseInput: unknown): ValidationResult<LineageVerification> {
  const request = validateGeoFlowRequest(requestInput); if (!request.ok) return request
  const response = validateGeoFlowResponse(responseInput, request.value); if (!response.ok) return response
  if (response.value.status === 'draft_ready' || response.value.status === 'review_required') {
    const expectedArticleKey = deriveExternalArticleKey(request.value)
    if (response.value.externalArticleKey !== expectedArticleKey || response.value.draftIdentity.externalArticleKey !== expectedArticleKey) return failure('IDENTITY_MISMATCH', '$.externalArticleKey')
  }
  return success({ request: request.value, response: response.value })
}

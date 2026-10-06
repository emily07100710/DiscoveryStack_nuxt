import { createError } from 'h3'
import { fingerprint } from '../geo-outcome-model/canonical'
import { assertPublicHttpsUrl } from '../content-operations/normalization'
import type { LearningAuthority, LearningAuthoritySelector } from '../site-evidence/learning-crawler'
import type { LearningScope } from './types'

export function learningError(code: string, message = '學習資料的授權或證據尚未就緒。', statusCode = 409): never {
  throw createError({ statusCode, statusMessage: message, data: { code } })
}
export function authorizationFingerprint(row: LearningScope['authorization']): string {
  return fingerprint({ contractVersion: 'learning-source-authorization-v1', ownerUserId: row.ownerUserId, clientId: row.clientId, sourceId: row.sourceId, authorizedOrigin: row.authorizedOrigin, rightsBasis: row.rightsBasis, rightsEvidenceHash: row.rightsEvidenceHash, consentVersion: row.consentVersion, consentReceiptHash: row.consentReceiptHash, approvedAt: row.approvedAt.toISOString(), expiresAt: row.expiresAt.toISOString(), retentionDays: row.retentionDays })
}
export function sourcePolicyReady(scope: Pick<LearningScope, 'client' | 'source'>, now: Date): boolean {
  const { client, source } = scope
  if (client.status !== 'active' || source.ownerUserId !== client.ownerUserId || source.allowedUse !== 'training_candidate' || source.reviewStatus !== 'approved' || source.termsStatus !== 'allows_training' || source.robotsStatus !== 'reviewed_allow' || source.copyrightRisk !== 'low' || source.piiStatus !== 'none_detected' || source.removedAt || source.removalRequestedAt || (source.retentionUntil && source.retentionUntil <= now)) return false
  try {
    const url = new URL(assertPublicHttpsUrl(source.canonicalUrl || source.sourceUrl, 'Learning source'))
    return url.origin === new URL(client.canonicalSiteOrigin).origin
  } catch { return false }
}
export function resolveLearningAuthority(scope: LearningScope | null, selector: LearningAuthoritySelector, now: Date): LearningAuthority | null {
  if (!scope) return null
  const { authorization: row, client, source } = scope
  try {
    if (!Number.isFinite(now.getTime()) || row.ownerUserId !== selector.ownerUserId || row.clientId !== selector.clientId || row.sourceId !== selector.sourceId || client.id !== row.clientId || client.ownerUserId !== row.ownerUserId || source.id !== row.sourceId || !sourcePolicyReady(scope, now)) return null
    if (row.status !== 'active' || row.revokedAt || row.approvedAt > now || row.expiresAt <= now || row.approvedAt >= row.expiresAt || !/^[a-f0-9]{64}$/.test(row.consentReceiptHash) || !/^[a-f0-9]{64}$/.test(row.rightsEvidenceHash) || !/^[A-Za-z0-9_.:-]{1,80}$/.test(row.consentVersion) || !Number.isSafeInteger(row.retentionDays) || row.retentionDays < 1 || row.retentionDays > 30 || authorizationFingerprint(row) !== row.authorizationFingerprint) return null
    const sourceUrl = assertPublicHttpsUrl(source.canonicalUrl || source.sourceUrl, 'Learning source')
    const origin = new URL(sourceUrl).origin
    if (origin !== row.authorizedOrigin || origin !== new URL(client.canonicalSiteOrigin).origin || (row.rightsBasis !== 'owner_authorized' && !source.licenceReference)) return null
    return { ownerUserId: row.ownerUserId, clientId: row.clientId, sourceId: row.sourceId, sourceUrl, sourceFingerprint: fingerprint(source), authorizedHost: new URL(origin).hostname, authorizationStatus: 'active', rightsBasis: row.rightsBasis, rightsReviewStatus: 'approved', allowModelImprovement: true, consentVersion: row.consentVersion, consentReceiptHash: row.consentReceiptHash, approvedAt: row.approvedAt, expiresAt: row.expiresAt, revokedAt: null, sourceStatus: 'training_candidate', termsAllowTraining: true, piiReviewStatus: 'none_detected', retentionActive: true, removalRequested: false }
  } catch { return null }
}

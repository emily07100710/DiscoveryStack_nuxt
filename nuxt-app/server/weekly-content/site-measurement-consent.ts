import { stableFingerprint } from '../content-operations/normalization'
import type { WeeklyContentRepository } from './repository'
import { weeklyConsentAllowsPublication } from './publication-guard'

/** Exact publication lineage supplied by the server-side draft-receipt reader. */
export type ConsumedWeeklyPublicationContext = {
  readonly status: 'draft_received'
  readonly ownerUserId: number
  readonly clientId: number
  readonly entryId: number
  readonly jobId: number
  readonly draftId: number
  readonly draftVersion: number
  readonly contentType: string
  readonly language: string
  readonly contentHash: string
  readonly evidenceSnapshotHash: string
  readonly targetId: number
  readonly targetConfigurationFingerprint: string
  readonly startedAt: Date
  readonly authorityReference: string | null
  readonly reviewId: number | null
  /** Present only when the exact machine-authority row was resolved; never inferred from the attempt. */
  readonly machineAuthorization?: {
    readonly authorizationFingerprint: string
    readonly status: string
    readonly revokedAt: Date | null
  }
}

export type SiteMeasurementConsentResult =
  | { readonly status: 'verified'; readonly authorityFingerprint: string }
  | { readonly status: 'blocked'; readonly reason: 'invalid_input' | 'identity_changed' | 'client_not_opted_in' | 'config_inactive' | 'binding_inactive' | 'request_missing_or_changed' | 'consent_missing_or_changed' | 'draft_or_policy_changed' | 'repository_unavailable' }

const HASH = /^[a-f0-9]{64}$/u
const validId = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) > 0
const validHash = (value: unknown): value is string => typeof value === 'string' && HASH.test(value)

/**
 * Revalidate the customer article-consent lineage for a consumed publication attempt.
 * This is an observation/measurement eligibility check only: it never reserves a publish,
 * renews a machine lease, or upgrades draft_received to publication authority.
 */
export async function revalidateConsumedWeeklyPublicationConsent(input: {
  readonly ownerUserId: number
  readonly clientId: number
  readonly entryId: number
  readonly attempt: ConsumedWeeklyPublicationContext
  readonly now: Date
  readonly repository: WeeklyContentRepository
}): Promise<SiteMeasurementConsentResult> {
  const blocked = (reason: Exclude<SiteMeasurementConsentResult, { status: 'verified' }>['reason']): SiteMeasurementConsentResult => ({ status: 'blocked', reason })
  const { attempt, now, repository } = input
  if (!input || !validId(input.ownerUserId) || !validId(input.clientId) || !validId(input.entryId) || !attempt
    || attempt.ownerUserId !== input.ownerUserId || attempt.clientId !== input.clientId || attempt.entryId !== input.entryId
    || !validId(attempt.jobId) || !validId(attempt.draftId) || !validId(attempt.draftVersion) || !validId(attempt.targetId)
    || typeof attempt.contentType !== 'string' || !attempt.contentType || typeof attempt.language !== 'string' || !attempt.language
    || !validHash(attempt.contentHash) || !validHash(attempt.evidenceSnapshotHash) || !validHash(attempt.targetConfigurationFingerprint)
    || !(attempt.startedAt instanceof Date) || !Number.isFinite(attempt.startedAt.getTime())
    || !(now instanceof Date) || !Number.isFinite(now.getTime()) || attempt.startedAt.getTime() > now.getTime()) return blocked('invalid_input')

  // Manual owner-reviewed attempts have a reviewId and no machine row. V4 attempts must
  // carry the actual resolved terminal row; never synthesize a draft_received state.
  const manualAuthority = attempt.reviewId !== null && validId(attempt.reviewId) && attempt.authorityReference === null && attempt.machineAuthorization === undefined
  const machineAuthority = attempt.reviewId === null && attempt.machineAuthorization !== undefined
    && attempt.machineAuthorization.status === 'draft_received' && attempt.machineAuthorization.revokedAt === null
    && attempt.machineAuthorization.authorizationFingerprint === attempt.authorityReference
    && validHash(attempt.machineAuthorization.authorizationFingerprint)
  if (attempt.status !== 'draft_received' || (!manualAuthority && !machineAuthority)
    || (attempt.authorityReference !== null && (typeof attempt.authorityReference !== 'string' || attempt.authorityReference.length > 160))) return blocked('identity_changed')

  try {
    const [client, config, binding, draft, request] = await Promise.all([
      repository.findClient(input.ownerUserId, input.clientId),
      repository.getConfig(input.ownerUserId, input.clientId),
      repository.getBinding(input.ownerUserId, input.clientId),
      repository.getDraft(input.ownerUserId, input.clientId, input.entryId, now),
      repository.findLatestRequestForEntry(input.ownerUserId, input.clientId, input.entryId),
    ])
    if (!client || client.ownerUserId !== input.ownerUserId || client.id !== input.clientId || client.status !== 'active') return blocked('identity_changed')
    if (client.requireCustomerApproval !== true) return blocked('client_not_opted_in')
    if (!config || config.ownerUserId !== input.ownerUserId || config.clientId !== input.clientId || config.status !== 'active'
      || config.cadenceDays !== 7 || config.publicationTargetId !== attempt.targetId) return blocked('config_inactive')
    if (!binding || binding.ownerUserId !== input.ownerUserId || binding.clientId !== input.clientId || binding.status !== 'active') return blocked('binding_inactive')
    if (!draft || draft.client.ownerUserId !== input.ownerUserId || draft.client.id !== input.clientId || draft.client.requireCustomerApproval !== true
      || draft.entryId !== input.entryId || draft.jobId !== attempt.jobId || draft.draftId !== attempt.draftId || draft.draftVersion !== attempt.draftVersion
      || draft.contentType !== attempt.contentType || draft.language !== attempt.language || draft.contentHash !== attempt.contentHash
      || draft.evidenceSnapshotHash !== attempt.evidenceSnapshotHash || draft.riskGateStatus !== 'passed') return blocked('draft_or_policy_changed')
    const target = draft.target
    const policy = draft.policy
    if (!target || target.id !== attempt.targetId || target.ownerUserId !== input.ownerUserId || target.clientId !== input.clientId
      || target.status !== 'active' || target.executionEnabled !== true || target.configurationFingerprint !== attempt.targetConfigurationFingerprint
      || !policy || policy.ownerUserId !== input.ownerUserId || policy.authorizedByOwnerUserId !== input.ownerUserId
      || policy.clientId !== input.clientId || policy.publicationTargetId !== attempt.targetId || policy.status !== 'enabled'
      || policy.policyVersion !== 'governed-autopilot-policy-v4' || policy.cadenceDays !== 7 || policy.revokedAt !== null
      || policy.expiresAt.getTime() <= now.getTime() || policy.policyId !== config.policyId
      || policy.configurationFingerprint !== config.policyConfigurationFingerprint) return blocked('draft_or_policy_changed')
    if (!request || request.ownerUserId !== input.ownerUserId || request.clientId !== input.clientId || request.entryId !== input.entryId
      || request.jobId !== attempt.jobId || request.draftId !== attempt.draftId || request.draftVersion !== attempt.draftVersion
      || request.contentType !== attempt.contentType || request.language !== attempt.language || request.contentHash !== attempt.contentHash
      || request.evidenceSnapshotHash !== attempt.evidenceSnapshotHash || request.publicationTargetId !== attempt.targetId
      || request.targetConfigurationFingerprint !== attempt.targetConfigurationFingerprint
      || request.configurationFingerprint !== config.configurationFingerprint || request.policyId !== policy.policyId
      || request.policyConfigurationFingerprint !== policy.configurationFingerprint || request.bindingId !== binding.id
      || request.bindingFingerprint !== binding.bindingFingerprint || request.status !== 'approved'
      || request.createdAt.getTime() > attempt.startedAt.getTime() || request.expiresAt.getTime() <= attempt.startedAt.getTime()) return blocked('request_missing_or_changed')
    const consent = await repository.latestConsent(request.id)
    if (!consent || consent.requestRowId !== request.id || consent.ownerUserId !== input.ownerUserId || consent.clientId !== input.clientId
      || consent.decision !== 'approved' || consent.createdAt.getTime() > attempt.startedAt.getTime() || !validHash(consent.consentFingerprint)) return blocked('consent_missing_or_changed')

    // Match the consent as it was valid at the immutable reservation time. Current opt-in,
    // binding, target, policy, source and draft checks above prevent stale/withdrawn context.
    // Deliberately ignore draft.machineAuthorizationValid: a consumed short lease is not authority.
    if (!weeklyConsentAllowsPublication(request, consent, config, binding, draft, attempt.startedAt)) return blocked('request_missing_or_changed')

    const authorityFingerprint = stableFingerprint({
      version: 'weekly-site-measurement-consent-v1',
      ownerUserId: input.ownerUserId,
      clientId: input.clientId,
      entryId: input.entryId,
      jobId: attempt.jobId,
      draftId: attempt.draftId,
      draftVersion: attempt.draftVersion,
      contentType: attempt.contentType,
      language: attempt.language,
      contentHash: attempt.contentHash,
      evidenceSnapshotHash: attempt.evidenceSnapshotHash,
      targetId: attempt.targetId,
      targetConfigurationFingerprint: attempt.targetConfigurationFingerprint,
      configFingerprint: config.configurationFingerprint,
      policyId: policy.policyId,
      policyFingerprint: policy.configurationFingerprint,
      bindingId: binding.id,
      bindingFingerprint: binding.bindingFingerprint,
      requestFingerprint: request.requestFingerprint,
      consentFingerprint: consent.consentFingerprint,
      startedAt: attempt.startedAt.toISOString(),
      authorityReference: attempt.authorityReference,
      reviewId: attempt.reviewId,
      machineAuthorizationFingerprint: machineAuthority ? attempt.machineAuthorization!.authorizationFingerprint : null,
    })
    return { status: 'verified', authorityFingerprint }
  } catch {
    return blocked('repository_unavailable')
  }
}

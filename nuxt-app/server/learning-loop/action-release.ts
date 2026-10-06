import { createHash } from 'node:crypto'
import { fingerprint } from '../geo-outcome-model/canonical'
import { createContentOperationsRepository, type ContentOperationsRepository } from '../content-operations/repository'
import type { DeliveredPublication } from '../content-operations/types'
import { projectDeliveredPublicationReceipt } from '../intervention-loop/delivered-publication-receipt'
import { bindPublicationRepositoryChangeSet } from './publication-action'
import { resolveLearningAuthority } from './authority'
import { DrizzleLearningLoopRepository } from './repository'
import type { LearningLoopRepository } from './types'
import { validatePersistedPublicationIdentity } from '../content-operations/publication-identity'

const record = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value))
type Dependencies = { operations?: ContentOperationsRepository; learning?: LearningLoopRepository; now?: () => Date }

async function resolveBinding(ownerUserId: number, delivered: DeliveredPublication, operations: ContentOperationsRepository) {
  const { publicationAttempt: attempt, publicationTarget: target, draft, entry } = delivered
  const client = await operations.findClient(ownerUserId, delivered.calendar.clientId)
  const receipt = projectDeliveredPublicationReceipt(ownerUserId, client, delivered)
  if (!receipt || !attempt?.artifactFingerprint || !target || target.transport !== 'first_party_git' || typeof draft.title !== 'string' || typeof draft.body !== 'string' || typeof entry.publicationContentHash !== 'string' || typeof target.defaultBranch !== 'string') return null
  // The repository resolver joins the current draft and target; also require every redundant
  // publication identity column to agree before accepting its append-only event projection.
  if (draft.jobId !== delivered.job.id || entry.jobId !== delivered.job.id || entry.draftId !== draft.id
    || attempt.evidenceSnapshotHash !== entry.evidenceSnapshotHash
    || attempt.publicationContentHash !== entry.publicationContentHash
    || attempt.publicationId !== `publication-${entry.id}`
    || attempt.publicationSlug !== entry.publicationSlug || attempt.publicationPath !== entry.publicationPath
    || entry.publicationTargetId !== target.id || delivered.publicationIdentity?.publicationId !== attempt.publicationId
    || delivered.publicationIdentity?.slug !== attempt.publicationSlug || delivered.publicationIdentity?.path !== attempt.publicationPath
    || delivered.publicationIdentity?.identityFingerprint !== entry.publicationIdentityFingerprint) return null
  const persistedIdentity = validatePersistedPublicationIdentity({
    clientId: delivered.calendar.clientId, entryId: entry.id, targetId: target.targetId,
    targetOrigin: target.targetOrigin, contentRoot: target.contentRoot,
    contentType: entry.contentType as 'article' | 'faq' | 'service_page',
    language: entry.language as 'en' | 'zh-hant', title: draft.title,
    ownerScopeKey: `owner-${ownerUserId}`,
    existingIdentity: delivered.publicationIdentity!,
  })
  if (!persistedIdentity.ok || persistedIdentity.identity.publicationId !== attempt.publicationId || persistedIdentity.identity.slug !== attempt.publicationSlug || persistedIdentity.identity.path !== attempt.publicationPath) return null
  const identity = { ownerUserId, entryId: entry.id, draftId: draft.id, draftVersion: draft.version, draftContentHash: draft.contentHash, evidenceSnapshotHash: entry.evidenceSnapshotHash, targetId: target.id, receiptFingerprint: receipt.receiptFingerprint, publicationContentHash: entry.publicationContentHash, artifactFingerprint: attempt.artifactFingerprint }
  const publisherTarget = { targetId: target.targetId, ownerScopeKey: `owner-${createHash('sha256').update(String(ownerUserId), 'utf8').digest('hex').slice(0, 32)}`, repositoryOwner: target.repositoryOwner, repositoryName: target.repositoryName, defaultBranch: target.defaultBranch }
  const matches = (await operations.listEvents(ownerUserId, entry.id)).flatMap(event => {
    if (event.ownerUserId !== ownerUserId || event.clientId !== delivered.calendar.clientId || event.calendarId !== entry.calendarId || event.entryId !== entry.id || event.runId !== delivered.publicationRun?.id || event.draftId !== draft.id || event.contentHash !== entry.publicationContentHash || event.evidenceSnapshotHash !== entry.evidenceSnapshotHash || event.eventType !== 'publication_delivered' || !record(event.metadata)) return []
    const metadata = event.metadata
    const snapshot = metadata.learningSnapshot
    if (metadata.schemaVersion !== 'content-publication-delivered-lineage-v1' || metadata.attemptId !== attempt.id || metadata.attemptNumber !== attempt.attemptNumber
      || metadata.draftId !== draft.id || metadata.jobId !== delivered.job.id || metadata.targetId !== target.id
      || metadata.publicationId !== `deliverable-${delivered.deliverable.id}` || metadata.publicationSlug !== attempt.publicationSlug
      || metadata.publicationPath !== attempt.publicationPath || metadata.productionDeliverableId !== delivered.deliverable.id
      || metadata.contentType !== entry.contentType || metadata.language !== entry.language
      || metadata.remoteState !== attempt.remoteState || metadata.remoteRevision !== attempt.remoteRevision
      || !record(snapshot) || snapshot.contractVersion !== 'publication-learning-snapshot-v1'
      || snapshot.draftId !== draft.id || snapshot.draftVersion !== draft.version || snapshot.draftContentHash !== draft.contentHash
      || snapshot.targetId !== target.id || snapshot.publicationContentHash !== entry.publicationContentHash
      || snapshot.receiptFingerprint !== receipt.receiptFingerprint || !record(metadata.repositoryAction)) return []
    const repositoryAction = metadata.repositoryAction
    const binding = bindPublicationRepositoryChangeSet({ identity, target: publisherTarget, path: attempt.publicationPath, title: draft.title as string, body: draft.body as string, changeSet: repositoryAction.changeSet })
    return binding && Date.parse(binding.changeSet.readAt) <= receipt.deliveredAt.getTime() && fingerprint(binding) === fingerprint(repositoryAction) ? [{ binding, receipt, clientId: delivered.calendar.clientId, eventId: event.id }] : []
  })
  return matches.length === 1 ? matches[0]! : null
}

/** A current, owner-resolved auxiliary action record. Repository state never becomes live-page proof. */
export async function resolvePublicationActionEvidence(ownerUserId: number, entryId: number, deps: Dependencies = {}) {
  const operations = deps.operations || createContentOperationsRepository(), learning = deps.learning || new DrizzleLearningLoopRepository(), readNow = deps.now || (() => new Date())
  const publication = await operations.resolveDeliveredPublication(ownerUserId, entryId)
  const first = publication ? await resolveBinding(ownerUserId, publication, operations) : null
  if (!first || first.receipt.deliveredAt > readNow()) return null
  let authorityProjection: { authorizationFingerprint: string; sourceFingerprint: string; consentReceiptHash: string; piiStatus: 'reviewed_clean' } | null = null
  let grantId: number | null = null
  for (const grant of (await learning.listAuthorizations(ownerUserId)).filter(row => row.clientId === first.clientId)) {
    const scope = await learning.getScope(ownerUserId, grant.id), now = readNow()
    const authority = resolveLearningAuthority(scope, { ownerUserId, clientId: first.clientId, sourceId: grant.sourceId }, now)
    if (authority && scope && scope.authorization.authorizedOrigin === new URL(first.receipt.publicationUrl).origin && first.receipt.deliveredAt >= scope.authorization.approvedAt && first.receipt.deliveredAt <= now && first.receipt.deliveredAt.getTime() + scope.authorization.retentionDays * 86400000 > now.getTime()) {
      authorityProjection = { authorizationFingerprint: scope.authorization.authorizationFingerprint, sourceFingerprint: authority.sourceFingerprint, consentReceiptHash: scope.authorization.consentReceiptHash, piiStatus: 'reviewed_clean' }; grantId = grant.id; break
    }
  }
  // Every response/export is a use: re-resolve both exact delivered identity and the live grant.
  const currentPublication = await operations.resolveDeliveredPublication(ownerUserId, entryId)
  const current = currentPublication ? await resolveBinding(ownerUserId, currentPublication, operations) : null
  if (!current || current.receipt.deliveredAt > readNow() || fingerprint(current) !== fingerprint(first)) return null
  if (grantId !== null && authorityProjection) {
    const scope = await learning.getScope(ownerUserId, grantId), now = readNow()
    const authority = scope ? resolveLearningAuthority(scope, { ownerUserId, clientId: first.clientId, sourceId: scope.authorization.sourceId }, now) : null
    if (!scope || !authority || scope.authorization.authorizationFingerprint !== authorityProjection.authorizationFingerprint || authority.sourceFingerprint !== authorityProjection.sourceFingerprint || current.receipt.deliveredAt.getTime() + scope.authorization.retentionDays * 86400000 <= now.getTime()) authorityProjection = null
  }
  const body = { contractVersion: 'publication-action-evidence-v1' as const, publicationReceiptFingerprint: current.receipt.receiptFingerprint, binding: current.binding, authority: authorityProjection, liveBeforeState: 'unknown' as const, modelTrainingAllowed: false as const, primaryCitationLabelAllowed: false as const, reasonCodes: ['repository_diff_is_not_live_before_after', 'observational_action_admission_not_established', ...(!authorityProjection ? ['current_learning_authority_required'] : [])] }
  return { ...body, evidenceFingerprint: fingerprint(body) }
}

export type PublicationActionEvidence = NonNullable<Awaited<ReturnType<typeof resolvePublicationActionEvidence>>>

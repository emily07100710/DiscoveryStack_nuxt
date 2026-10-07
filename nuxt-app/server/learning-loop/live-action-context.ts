import { createHash } from 'node:crypto'
import type { ContentOperationsRepository, WorkspaceEntryLineage } from '../content-operations/repository'
import { matchesPublishedV4DeliveredAuthority } from '../content-operations/repository'
import type { ContentOperationPublicationAttemptRow, ContentOperationPublicationTargetRow } from '../content-operations/types'
import { buildPublicationIdentity, validatePersistedPublicationIdentity } from '../content-operations/publication-identity'
import { resolvePublicationPublicUrl } from '../content-operations/publication-public-url'
import { contentFingerprint } from '../seo-geo-core/riskGate'
import { fingerprint } from '../geo-outcome-model/canonical'
import { projectExpectedLiveDocument, type LiveDocumentInput, type LivePageProjection } from './live-page-projection'

const sha = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex')
const hash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
const record = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value))

export type LiveActionContext = {
  ownerUserId: number
  entryId: number
  clientId: number
  attempt: ContentOperationPublicationAttemptRow
  target: ContentOperationPublicationTargetRow
  lineage: WorkspaceEntryLineage
  publicationUrl: string
  publicationUrlHash: string
  publicationIdentityFingerprint: string
  expected: LivePageProjection
  contextFingerprint: string
}

/** URLs, titles, draft IDs and success assertions are loaded only from the owner-scoped ledger. */
export async function resolveLiveActionContext(ownerUserId: number, entryId: number, attemptId: number, operations: ContentOperationsRepository): Promise<LiveActionContext | null> {
  if (![ownerUserId, entryId, attemptId].every(id => Number.isSafeInteger(id) && id > 0)) return null
  const lineage = await operations.resolveWorkspaceEntry(ownerUserId, entryId)
  const matching = (await operations.listPublicationAttempts(ownerUserId, entryId)).filter(row => row.id === attemptId)
  const attempt = matching.length === 1 ? matching[0]! : null
  if (!lineage?.job || !lineage.draft || !attempt || !['planned', 'delivered'].includes(attempt.status) || attempt.mode !== 'execute') return null
  const { entry, calendar, client, job, draft, deliverable, review, riskGate } = lineage
  const target = await operations.findPublicationTarget(ownerUserId, attempt.targetId)
  if (!target || target.ownerUserId !== ownerUserId || target.clientId !== client.id || target.status !== 'active' || target.revokedAt || !target.executionEnabled
    || !['first_party_git', 'first_party_signed_api'].includes(target.transport) || !hash(target.configurationFingerprint)
    || entry.id !== entryId || entry.ownerUserId !== ownerUserId || client.ownerUserId !== ownerUserId || client.status !== 'active'
    || calendar.ownerUserId !== ownerUserId || calendar.clientId !== client.id || entry.calendarId !== calendar.id
    || job.ownerUserId !== ownerUserId || entry.jobId !== job.id || entry.draftId !== draft.id || draft.jobId !== job.id
    || job.productionPlanId !== calendar.productionPlanId || job.productionDeliverableId !== deliverable.id || deliverable.id !== entry.productionDeliverableId
    || job.evidenceSnapshotHash !== entry.evidenceSnapshotHash || job.strategyRecommendationId !== entry.strategyRecommendationId
    || attempt.ownerUserId !== ownerUserId || attempt.clientId !== client.id || attempt.entryId !== entryId
    || attempt.contentHash !== draft.contentHash || attempt.evidenceSnapshotHash !== entry.evidenceSnapshotHash
    || entry.contentHash !== draft.contentHash || draft.safetyStatus !== 'passed' || !record(draft.provenance) || draft.provenance.stage !== 'optimized'
    || typeof draft.title !== 'string' || typeof draft.body !== 'string' || contentFingerprint(draft.title, draft.body) !== draft.contentHash
    || sha(draft.body) !== attempt.publicationContentHash || !hash(attempt.publicationContentHash)
    || !riskGate || riskGate.draftId !== draft.id || riskGate.evidenceSnapshotHash !== entry.evidenceSnapshotHash || riskGate.status !== 'passed') return null

  let reviewIdentity: string
  if (attempt.authorityReference) {
    if (hash(attempt.authorityReference)) {
      const authorization = await operations.findMachineAuthorization(ownerUserId, entryId, attempt.authorityReference)
      if (attempt.status === 'delivered') {
        if (!matchesPublishedV4DeliveredAuthority(authorization, { ownerUserId, clientId: client.id, entryId, jobId: job.id, draftId: draft.id, targetId: target.id, contentHash: draft.contentHash, evidenceSnapshotHash: entry.evidenceSnapshotHash, authorityReference: attempt.authorityReference })) return null
      } else if (!authorization || authorization.status !== 'executing' || authorization.revokedAt || authorization.ownerUserId !== ownerUserId || authorization.clientId !== client.id || authorization.entryId !== entryId || authorization.jobId !== job.id || authorization.draftId !== draft.id || authorization.publicationTargetId !== target.id || authorization.contentHash !== draft.contentHash || authorization.evidenceSnapshotHash !== entry.evidenceSnapshotHash) return null
    } else if (!/^ref-autopilot-[A-Za-z0-9._:-]{1,140}$/.test(attempt.authorityReference)) return null
    reviewIdentity = attempt.authorityReference
  } else {
    if (!review || review.reviewerUserId !== ownerUserId || review.jobId !== job.id || review.draftId !== draft.id || review.evidenceSnapshotHash !== entry.evidenceSnapshotHash || review.decision !== 'approved_for_delivery') return null
    reviewIdentity = `review-${review.id}`
  }

  const identityInput = { clientId: client.id, entryId, targetId: target.targetId, targetOrigin: target.targetOrigin, contentRoot: target.contentRoot, contentType: entry.contentType, language: entry.language, title: draft.title, ownerScopeKey: `owner-${ownerUserId}` }
  // A title revision must not silently change the canonical page's persisted slug.
  const identity = entry.publicationTargetId === target.id && entry.publicationIdentityFingerprint && entry.publicationSlug && entry.publicationPath
    ? validatePersistedPublicationIdentity({ ...identityInput, existingIdentity: { publicationId: `publication-${entryId}`, slug: entry.publicationSlug, path: entry.publicationPath, identityFingerprint: entry.publicationIdentityFingerprint } })
    : buildPublicationIdentity(identityInput)
  if (!identity.ok || attempt.publicationId !== identity.identity.publicationId || attempt.publicationSlug !== identity.identity.slug || attempt.publicationPath !== identity.identity.path) return null
  const publicPage = resolvePublicationPublicUrl({ ownerUserId, client, entry, target, identity: identity.identity, publicationUrl: attempt.publicationUrl })
  if (!publicPage.configured) return null
  const input: LiveDocumentInput = { publicationId: `deliverable-${deliverable.id}`, draftId: `draft-${draft.id}`, reviewId: reviewIdentity, contentHash: attempt.publicationContentHash, evidenceSnapshotHash: entry.evidenceSnapshotHash, title: draft.title, body: draft.body }
  const expected = projectExpectedLiveDocument(input, publicPage.publicationUrl)
  if (!expected) return null
  const publicationUrlHash = sha(publicPage.publicationUrl)
  const body = {
    contractVersion: 'learning-live-action-context-v1', ownerUserId, clientId: client.id, entryId, attemptId,
    runId: attempt.runId, targetId: target.id, targetConfigurationFingerprint: target.configurationFingerprint,
    draftId: draft.id, draftVersion: draft.version, draftContentHash: draft.contentHash,
    publicationContentHash: attempt.publicationContentHash, evidenceSnapshotHash: entry.evidenceSnapshotHash,
    publicationIdentityFingerprint: identity.identity.identityFingerprint, publicationUrlHash,
    expectedProjectionFingerprint: expected.projectionFingerprint, reviewIdentityFingerprint: fingerprint(reviewIdentity), riskGateId: riskGate.id,
  }
  return { ownerUserId, entryId, clientId: client.id, attempt, target, lineage, publicationUrl: publicPage.publicationUrl, publicationUrlHash, publicationIdentityFingerprint: identity.identity.identityFingerprint, expected, contextFingerprint: fingerprint(body) }
}

/** Each target's exact durable delivered attempt/event is authority even if other routes are pending. */
export async function resolveLiveActionReceipt(context: LiveActionContext, operations: ContentOperationsRepository, now: Date) {
  const { attempt, lineage, ownerUserId, entryId, target } = context
  if (attempt.status !== 'delivered' || !hash(attempt.receiptFingerprint) || !hash(attempt.artifactFingerprint) || !(attempt.completedAt instanceof Date) || !Number.isFinite(attempt.completedAt.getTime()) || attempt.completedAt > now || !attempt.publicationUrl || attempt.publicationUrl !== context.publicationUrl) return null
  const run = (await operations.listRuns(ownerUserId, entryId)).find(row => row.id === attempt.runId)
  if (!run || run.ownerUserId !== ownerUserId || run.entryId !== entryId || run.stage !== 'publication' || !['succeeded', 'retry_wait', 'blocked', 'failed'].includes(run.state)) return null
  const events = (await operations.listEvents(ownerUserId, entryId)).filter(event => {
    if (event.ownerUserId !== ownerUserId || event.clientId !== context.clientId || event.entryId !== entryId || event.calendarId !== lineage.calendar.id || event.runId !== run.id || event.draftId !== lineage.draft!.id || event.contentHash !== attempt.publicationContentHash || event.evidenceSnapshotHash !== attempt.evidenceSnapshotHash || !['publication_delivered', 'publication_route_delivered'].includes(event.eventType) || !record(event.metadata)) return false
    const metadata = event.metadata
    if (metadata.schemaVersion !== 'content-publication-delivered-lineage-v1' || metadata.attemptId !== attempt.id || metadata.publicationId !== (event.eventType === 'publication_delivered' ? `deliverable-${lineage.deliverable.id}` : attempt.publicationId) || metadata.targetId !== target.id || metadata.jobId !== lineage.job!.id || metadata.draftId !== lineage.draft!.id || metadata.productionDeliverableId !== lineage.deliverable.id || metadata.publicationSlug !== attempt.publicationSlug || metadata.publicationPath !== attempt.publicationPath || !record(metadata.learningSnapshot)) return false
    const snapshot = metadata.learningSnapshot
    return snapshot.contractVersion === 'publication-learning-snapshot-v1' && snapshot.draftId === lineage.draft!.id && snapshot.draftVersion === lineage.draft!.version && snapshot.draftContentHash === lineage.draft!.contentHash && snapshot.targetId === target.id && snapshot.publicationContentHash === attempt.publicationContentHash && snapshot.receiptFingerprint === attempt.receiptFingerprint
  })
  if (events.length !== 1) return null
  return { receiptFingerprint: attempt.receiptFingerprint, deliveredAt: attempt.completedAt, eventId: events[0]!.id, receiptIdentityFingerprint: fingerprint({ contractVersion: 'learning-live-action-formal-receipt-v1', contextFingerprint: context.contextFingerprint, attemptId: attempt.id, artifactFingerprint: attempt.artifactFingerprint, receiptFingerprint: attempt.receiptFingerprint, deliveredAt: attempt.completedAt.toISOString(), eventId: events[0]!.id }) }
}

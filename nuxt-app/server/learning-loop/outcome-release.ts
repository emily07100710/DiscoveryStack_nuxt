import { createContentOperationsRepository, type ContentOperationsRepository } from '../content-operations/repository'
import { projectDeliveredPublicationReceipt } from '../intervention-loop/delivered-publication-receipt'
import { assessPublishedContentOutcome } from '../outcome-learning/engine'
import { buildContentLearningDataset, scanOutcomeLearningPii } from '../outcome-learning/content-learning-runtime'
import { OUTCOME_DATA_CONTRACT_VERSION } from '../outcome-learning/policy-catalog'
import { fingerprint } from '../geo-outcome-model/canonical'
import { resolveLearningAuthority } from './authority'
import { DrizzleLearningLoopRepository } from './repository'
import type { LearningLoopRepository } from './types'
import { projectEffectPublicationTiming } from './effect-publication-metadata'
import type { EffectPublicationMetadata } from './effect-trainer'

type Dependencies = { operations?: ContentOperationsRepository; repository?: LearningLoopRepository; now?: Date | (() => Date) }
const record = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value))

/** Fresh consent + fresh formal receipt + recomputed assessment, never a historical browser checkbox. */
export async function buildGovernedContentOutcomeRelease(ownerUserId: number, dependencies: Dependencies = {}) {
  const readNow = () => typeof dependencies.now === 'function' ? dependencies.now() : dependencies.now || new Date()
  const operations = dependencies.operations || createContentOperationsRepository(), repository = dependencies.repository || new DrizzleLearningLoopRepository(), now = readNow()
  const grants = await repository.listAuthorizations(ownerUserId), outcomes = await operations.listOutcomes(ownerUserId, 500)
  const initialScopes = new Map<number, Awaited<ReturnType<LearningLoopRepository['getScope']>>>()
  type CandidateRecord = Parameters<typeof buildContentLearningDataset>[0]['records'][number]
  type CandidateLineage = { candidateInputFingerprint: string; receiptFingerprint: string; authorizationFingerprint: string; sourceFingerprint: string }
  const records: CandidateRecord[] = [], lineage: CandidateLineage[] = []
  const publicationTiming: Array<Omit<EffectPublicationMetadata, 'candidateFingerprint'> | null> = []
  const staged: Array<{ record: CandidateRecord; lineage: CandidateLineage; authorizationId: number; clientId: number; sourceId: number; entryId: number; draftId: number; draftVersion: number; evidenceSnapshotHash: string; publicationFingerprint: string; outcomeFingerprint: string; outcomeId: number; outcomeIdempotencyKey: string; outcomeRecordFingerprint: string; measuredAt: Date }> = []
  const blocked: Array<{ outcomeFingerprint: string; reasonCode: string }> = []
  for (const outcome of outcomes.slice(0, 500)) {
    const outcomeFingerprint = fingerprint({ entryId: outcome.entryId, assessmentFingerprint: outcome.assessmentFingerprint, receiptFingerprint: outcome.publicationReceiptFingerprint })
    const reject = (reasonCode: string) => blocked.push({ outcomeFingerprint, reasonCode })
    const current = await operations.resolveDeliveredPublication(ownerUserId, outcome.entryId)
    const client = current ? await operations.findClient(ownerUserId, current.calendar.clientId) : null
    const delivered = current ? projectDeliveredPublicationReceipt(ownerUserId, client, current) : null
    if (outcome.ownerUserId !== ownerUserId || !delivered || !current || delivered.targetId !== outcome.targetId || delivered.receiptFingerprint !== outcome.publicationReceiptFingerprint || delivered.contentHash !== outcome.contentHash || current.draft?.id !== outcome.draftId || current.entry.evidenceSnapshotHash !== outcome.evidenceSnapshotHash) { reject('CURRENT_PUBLICATION_LINEAGE_REQUIRED'); continue }
    let scope = null, authority = null
    for (const grant of grants.filter(row => row.clientId === current.calendar.clientId)) {
      if (!initialScopes.has(grant.id)) initialScopes.set(grant.id, await repository.getScope(ownerUserId, grant.id))
      const candidate = initialScopes.get(grant.id) || null
      const resolved = resolveLearningAuthority(candidate, { ownerUserId, clientId: grant.clientId, sourceId: grant.sourceId }, now)
      if (candidate && resolved && new URL(delivered.publicationUrl).origin === candidate.authorization.authorizedOrigin) { scope = candidate; authority = resolved; break }
    }
    if (!scope || !authority || !(outcome.measuredAt instanceof Date) || !Number.isFinite(outcome.measuredAt.getTime()) || outcome.measuredAt > now || outcome.measuredAt < scope.authorization.approvedAt || outcome.measuredAt.getTime() + scope.authorization.retentionDays * 86400000 <= now.getTime()) { reject('CURRENT_LEARNING_CONSENT_REQUIRED'); continue }
    const historical = outcome.assessmentSnapshot
    if (!record(historical) || !record(historical.publication) || historical.publication.contentHash !== current.entry.contentHash || historical.publication.draftId !== String(current.draft?.id) || historical.publication.draftVersion !== String(current.draft?.version) || historical.publication.publishedAt !== delivered.deliveredAt.toISOString()) { reject('EXACT_ASSESSMENT_IDENTITY_REQUIRED'); continue }
    const request = { publication: historical.publication, baselineMeasurements: outcome.baselineSnapshot, followUpMeasurements: outcome.followUpSnapshot, dataContractVersion: OUTCOME_DATA_CONTRACT_VERSION }
    let assessment
    try { assessment = assessPublishedContentOutcome(request) } catch { reject('INVALID_ASSESSMENT'); continue }
    if (assessment.assessmentFingerprint !== outcome.assessmentFingerprint || fingerprint(assessment) !== fingerprint(historical)) { reject('ASSESSMENT_FINGERPRINT_MISMATCH'); continue }
    const consent = { consentStatus: 'granted' as const, consentVersion: scope.authorization.consentVersion, consentedAt: scope.authorization.approvedAt.toISOString(), consentAllowedUses: ['model_improvement', 'evaluation'], consentRevokedAt: null, rightsConfirmed: true }
    const pii = scanOutcomeLearningPii({ outcomeRequest: request, assessment })
    if (pii.status !== 'none_detected') { reject('PII_REVIEW_BLOCKED'); continue }
    // Public numeric, hash-only projections have a reviewed source card; no customer/contact payload is copied.
    staged.push({ record: { outcomeRequest: request, assessment, consent, piiScanStatus: pii.status }, lineage: { candidateInputFingerprint: fingerprint(request), receiptFingerprint: delivered.receiptFingerprint, authorizationFingerprint: scope.authorization.authorizationFingerprint, sourceFingerprint: authority.sourceFingerprint }, authorizationId: scope.authorization.id, clientId: current.calendar.clientId, sourceId: scope.authorization.sourceId, entryId: outcome.entryId, draftId: outcome.draftId, draftVersion: current.draft!.version, evidenceSnapshotHash: outcome.evidenceSnapshotHash, publicationFingerprint: fingerprint(delivered), outcomeFingerprint, outcomeId: outcome.id, outcomeIdempotencyKey: outcome.idempotencyKey, outcomeRecordFingerprint: fingerprint(outcome), measuredAt: outcome.measuredAt })
  }
  // Processing earlier rows may take time: do not export consent or receipts that changed meanwhile.
  for (const candidate of staged) {
    const current = await operations.resolveDeliveredPublication(ownerUserId, candidate.entryId)
    const client = current ? await operations.findClient(ownerUserId, current.calendar.clientId) : null
    const delivered = current ? projectDeliveredPublicationReceipt(ownerUserId, client, current) : null
    const outcome = await operations.findOutcomeByIdempotency(ownerUserId, candidate.outcomeIdempotencyKey)
    const scope = await repository.getScope(ownerUserId, candidate.authorizationId), checkedAt = readNow()
    const authority = resolveLearningAuthority(scope, { ownerUserId, clientId: candidate.clientId, sourceId: candidate.sourceId }, checkedAt)
    if (!scope || !authority || scope.authorization.authorizationFingerprint !== candidate.lineage.authorizationFingerprint || authority.sourceFingerprint !== candidate.lineage.sourceFingerprint || !delivered || fingerprint(delivered) !== candidate.publicationFingerprint || current?.draft?.id !== candidate.draftId || current.draft.version !== candidate.draftVersion || current.calendar.clientId !== candidate.clientId || current.entry.evidenceSnapshotHash !== candidate.evidenceSnapshotHash || !outcome || outcome.ownerUserId !== ownerUserId || outcome.id !== candidate.outcomeId || fingerprint(outcome) !== candidate.outcomeRecordFingerprint || candidate.measuredAt > checkedAt || candidate.measuredAt < scope.authorization.approvedAt || candidate.measuredAt.getTime() + scope.authorization.retentionDays * 86400000 <= checkedAt.getTime()) {
      blocked.push({ outcomeFingerprint: candidate.outcomeFingerprint, reasonCode: 'LINEAGE_CHANGED_BEFORE_RELEASE' }); continue
    }
    records.push(candidate.record); lineage.push(candidate.lineage)
    publicationTiming.push(projectEffectPublicationTiming({ ownerUserId, receiptFingerprint: delivered.receiptFingerprint, assessment: candidate.record.assessment as Parameters<typeof projectEffectPublicationTiming>[0]['assessment'], baselineMeasurements: outcome.baselineSnapshot, followUpMeasurements: outcome.followUpSnapshot, measuredAt: candidate.measuredAt, checkedAt }))
  }
  const dataset = buildContentLearningDataset({ records })
  // Bind each admitted candidate to its server-reloaded receipt/source/consent lineage.
  // Candidate fingerprints alone are checksums, not authorisation proofs.
  const admittedLineage = dataset.candidateResults.flatMap((candidate, index) => candidate.candidateStatus === 'eligible' && lineage[index] ? [{ candidateFingerprint: candidate.candidateFingerprint, lineageFingerprint: fingerprint(lineage[index]) }] : [])
  const publicationMetadataEntries = dataset.candidateResults.flatMap((candidate, index) => candidate.candidateStatus === 'eligible' && publicationTiming[index] ? [{ candidateFingerprint: candidate.candidateFingerprint, ...publicationTiming[index]! }] : [])
  const metadataBlocked = dataset.candidateResults.flatMap((candidate, index) => candidate.candidateStatus === 'eligible' && !publicationTiming[index] ? [{ candidateFingerprint: candidate.candidateFingerprint, reasonCode: 'EXACT_GSC_PUBLICATION_TIMING_REQUIRED' }] : [])
  const finalNow = readNow()
  const projection = { contractVersion: 'governed-content-outcome-release-v1', generatedAt: finalNow.toISOString(), taskType: 'content_effect_direction' as const, citationTrainingEligible: false as const, dataset, lineage, admittedLineage, publicationMetadataEntries, metadataBlocked, blocked, limitations: ['directional_observational_not_causal', 'search_and_analytics_are_not_ai_citation_labels', 'current_consent_rechecked_on_every_release', 'publication_consent_does_not_grant_training_consent'] }
  return { ...projection, releaseFingerprint: fingerprint(projection) }
}

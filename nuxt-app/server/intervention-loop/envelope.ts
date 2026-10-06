import { createError } from 'h3'
import { computePrePostResult, PRE_POST_CAUSAL_STATEMENT } from './assessment'
import { compareInterventionMeasurements } from './measurement-comparisons'
import { fingerprint } from './normalization'
import { sha256Hex } from '../site-evidence/normalization'
import type { InterventionLoopDependencies } from './dependencies'
import type { ExperimentResult, Intervention, InterventionEvent, InterventionMeasurement } from './types'
import type { PublicationActionEvidence } from '../learning-loop/action-release'

export const INTERVENTION_ENVELOPE_VERSION = 'intervention-envelope-v1' as const
type PublicationBinding = 'verified' | 'missing' | 'stale' | 'unavailable' | 'not_applicable'
const hash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value)

function validEvent(row: InterventionEvent) {
  return row.evidenceFingerprint === fingerprint({ interventionId: row.interventionId, eventType: row.eventType, fromStatus: row.fromStatus, toStatus: row.toStatus, occurredAt: row.occurredAt, evidence: row.evidence })
}

export async function resolveInterventionEnvelope(input: {
  intervention: Intervention
  events: InterventionEvent[]
  measurements: InterventionMeasurement[]
  results: ExperimentResult[]
}, deps: InterventionLoopDependencies, policySnapshot?: { minimumSampleSize: number }) {
  const { intervention: row, events, measurements, results } = input
  // Hashes are checksums, not authority. All inputs are reloaded through the owner-scoped repository.
  if ([...events, ...measurements, ...results].some(child => child.ownerUserId !== row.ownerUserId || child.interventionId !== row.id)) {
    throw createError({ statusCode: 409, statusMessage: '關聯證據與這筆改動不一致，請重新整理。', data: { code: 'INTERVENTION_LINEAGE_MISMATCH' } })
  }
  const policy = policySnapshot || await deps.repository.getPolicy(row.ownerUserId) || { minimumSampleSize: 30 }
  const comparisons = compareInterventionMeasurements(row, measurements)
  const computed = computePrePostResult(row, measurements, policy)
  const currentResult = [...results].sort((a, b) => b.id - a.id).find(result => result.resultKind === 'pre_post' && result.resultFingerprint === computed.resultFingerprint)
  const deployedEvents = events.filter(event => event.eventType === 'deployed' && validEvent(event))
  const receiptEvent = deployedEvents.find(event => event.evidence.source === 'publication_receipt' && hash(event.evidence.receiptFingerprint) && event.evidence.contentHash === row.deployedContentHash)
  const receiptFingerprint = receiptEvent && hash(receiptEvent.evidence.receiptFingerprint) ? receiptEvent.evidence.receiptFingerprint : null
  let publicationBinding: PublicationBinding = row.deployEvidenceSource === 'publication_receipt' ? 'missing' : 'not_applicable'
  if (row.deployEvidenceSource === 'publication_receipt' && row.entryId && receiptFingerprint) {
    if (!deps.deliveredPublications.resolveDeliveredPublication) publicationBinding = 'unavailable'
    else {
      try {
        const publication = await deps.deliveredPublications.resolveDeliveredPublication(row.ownerUserId, row.entryId)
        publicationBinding = publication && publication.entryId === row.entryId && publication.targetId === row.targetId
          && publication.publicationUrl === row.normalizedUrl && publication.contentHash === row.deployedContentHash
          && publication.receiptFingerprint === receiptFingerprint && publication.deliveredAt.getTime() === row.deployedAt?.getTime() ? 'verified' : 'stale'
      } catch { publicationBinding = 'unavailable' }
    }
  }
  const beforeKnown = hash(row.baselineContentHash) && row.baselineCapturedAt !== null
    && row.baselineHashSource !== 'content_operations' && (!row.deployedAt || row.baselineCapturedAt < row.deployedAt)
    && events.some(event => event.eventType === 'baseline_captured' && validEvent(event) && event.evidence.contentHash === row.baselineContentHash)
  const recrawlKnown = row.recrawlStatus === 'confirmed' && row.deployedAt !== null && row.recrawlConfirmedAt !== null && row.recrawlConfirmedAt >= row.deployedAt
  let actionEvidence: PublicationActionEvidence | null = null
  if (publicationBinding === 'verified' && row.entryId && deps.deliveredPublications.resolvePublicationActionEvidence) {
    try {
      const evidence = await deps.deliveredPublications.resolvePublicationActionEvidence(row.ownerUserId, row.entryId, () => deps.clock.now())
      if (evidence?.publicationReceiptFingerprint === receiptFingerprint) actionEvidence = evidence
    } catch { /* a publication audit must remain available during learning-authority outages */ }
  }
  const limitations = new Set([...computed.limitations, 'observational_not_causal', 'attribution_not_established', 'concurrent_changes_not_recorded', actionEvidence ? 'repository_diff_is_not_live_before_after' : 'immutable_change_set_not_recorded'])
  if (!beforeKnown) limitations.add('baseline_unknown')
  if (!recrawlKnown) limitations.add('recrawl_not_confirmed')
  if (row.deployEvidenceSource === 'publication_receipt' && publicationBinding !== 'verified') limitations.add(`publication_binding_${publicationBinding}`)
  if (events.some(event => !validEvent(event))) limitations.add('event_fingerprint_mismatch')
  if (results.length && !currentResult) limitations.add('assessment_stale')
  const publicationCurrent = row.deployEvidenceSource !== 'publication_receipt' || publicationBinding === 'verified'
  const assessmentCurrent = Boolean(currentResult && recrawlKnown && publicationCurrent && !limitations.has('event_fingerprint_mismatch') && row.status !== 'cancelled')
  const searchScopes = comparisons.filter(group => group.source === 'google_search_console')
  const selected = searchScopes.length === 1 && searchScopes[0]!.status === 'comparable' ? searchScopes[0]! : null
  const learningReasons = ['aggregate_is_not_citation_ground_truth', ...(actionEvidence ? actionEvidence.reasonCodes : ['immutable_change_set_not_recorded']), ...(!actionEvidence?.authority ? ['consent_authority_not_bound', 'pii_review_not_bound'] : [])]
  if (!assessmentCurrent || computed.signal === 'insufficient_data') learningReasons.push('comparable_outcome_not_ready')
  if (publicationBinding !== 'verified') learningReasons.push('exact_publication_authority_not_bound')
  const body = {
    schemaVersion: INTERVENTION_ENVELOPE_VERSION,
    identity: {
      interventionId: row.id,
      ownerKey: sha256Hex(`intervention-loop:${row.ownerUserId}`),
      siteKey: fingerprint({ ownerUserId: row.ownerUserId, host: row.siteHost }),
      pageKey: row.urlHash,
      inputFingerprint: row.inputFingerprint,
      createdAt: row.registeredAt,
    },
    before: {
      availability: beforeKnown ? 'known' as const : 'unknown' as const,
      contentHash: beforeKnown ? row.baselineContentHash : null,
      capturedAt: beforeKnown ? row.baselineCapturedAt : null,
      source: beforeKnown ? row.baselineHashSource : null,
      unknownReason: beforeKnown ? null : 'baseline_not_proven_before_publication',
    },
    intervention: {
      status: row.status,
      type: row.interventionType,
      // Free-text summaries/hypotheses are not training data; exact units cannot be inferred from them.
      summaryFingerprint: fingerprint(row.changeSummary),
      hypothesisFingerprint: row.hypothesis ? fingerprint(row.hypothesis) : null,
      changeSet: actionEvidence ? { status: 'recorded_repository_revision' as const, changeSetId: actionEvidence.binding.changeSet.changeSetId, beforeHash: actionEvidence.binding.changeSet.before.bodyHash, afterHash: actionEvidence.binding.changeSet.after.bodyHash, comparisonKind: 'repository_revision_diff' as const, liveBeforeState: 'unknown' as const, bindingFingerprint: actionEvidence.binding.bindingFingerprint, units: [{ type: 'title', ...actionEvidence.binding.changeSet.titleChange }, ...actionEvidence.binding.changeSet.paragraphChanges.map(unit => ({ type: 'paragraph', ...unit }))] } : { status: 'not_recorded' as const, changeSetId: null, units: [] },
      deployedAt: row.deployedAt,
      contentHash: hash(row.deployedContentHash) ? row.deployedContentHash : null,
      evidenceLevel: row.deployEvidenceLevel,
      evidenceSource: row.deployEvidenceSource,
      publication: { entryId: row.entryId, targetId: row.targetId, receiptFingerprint, binding: publicationBinding },
    },
    after: {
      recrawl: { status: recrawlKnown ? 'confirmed' as const : 'unknown' as const, confirmedAt: recrawlKnown ? row.recrawlConfirmedAt : null, source: recrawlKnown ? row.recrawlSource : null },
      measurements: comparisons.map(({ phases: _phases, ...group }) => group),
      assessment: {
        status: assessmentCurrent ? 'current' as const : results.length ? 'stale' as const : 'not_assessed' as const,
        resultId: currentResult?.id || null,
        fingerprint: currentResult?.resultFingerprint || null,
        signal: assessmentCurrent ? computed.signal : 'insufficient_data' as const,
      },
    },
    confidence: {
      percentage: null,
      controlDesign: 'pre_post_observational' as const,
      sampleSize: { before: selected?.baseline.sampleSize ?? null, after: selected?.followUp.sampleSize ?? null },
      observedDays: { before: selected?.baseline.observedDays ?? null, after: selected?.followUp.observedDays ?? null },
      minimumSampleSize: policy.minimumSampleSize,
      limitations: [...limitations].sort(),
      causalStatement: PRE_POST_CAUSAL_STATEMENT,
    },
    learning: {
      status: 'blocked' as const,
      allowedUses: ['owner_operational_review'] as const,
      modelTrainingAllowed: false,
      primaryCitationLabelAllowed: false,
      reasonCodes: learningReasons.sort(),
      deidentificationVersion: 'intervention-hash-only-v1',
      // Existing consent/candidate-set/evidence governance must be separately server-resolved.
      candidateAuthority: actionEvidence?.authority ? 'current_auxiliary_review_only' as const : 'not_bound' as const,
      authorityFingerprint: actionEvidence?.authority ? fingerprint(actionEvidence.authority) : null,
    },
    eventReferences: [...events].sort((a, b) => a.id - b.id).map(event => ({ id: event.id, eventType: event.eventType, occurredAt: event.occurredAt, fingerprint: event.evidenceFingerprint })),
  }
  return { ...body, envelopeFingerprint: fingerprint(body) }
}

export type InterventionEnvelope = Awaited<ReturnType<typeof resolveInterventionEnvelope>>

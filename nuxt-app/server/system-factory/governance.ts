import { fingerprint, SystemFactoryError } from './canonical'

export type AggregateOutcomeAdmission = { ownerId: string; clientId: string; websiteId: string; systemTenantId: string; consentReceiptFingerprint: string; piiAdmissionReceiptFingerprint: string; purpose: 'geo_aggregate_outcome_evaluation'; retentionUntil: string; aggregationWindow: { start: string; end: string }; numerator: number; denominator: number; source: string; limitations: string[] }

export function admitAggregateOutcome(input: AggregateOutcomeAdmission): AggregateOutcomeAdmission & { admissionFingerprint: string; privateRecordsIncluded: false; predictionIsVerifiedOutcome: false } {
  for (const value of [input.consentReceiptFingerprint, input.piiAdmissionReceiptFingerprint]) if (!/^[a-f0-9]{64}$/u.test(value)) throw new SystemFactoryError('OUTCOME_GOVERNANCE', 'Aggregate outcome requires consent and PII admission receipts.')
  if (input.purpose !== 'geo_aggregate_outcome_evaluation' || !Number.isSafeInteger(input.numerator) || !Number.isSafeInteger(input.denominator) || input.numerator < 0 || input.denominator < 1 || input.numerator > input.denominator) throw new SystemFactoryError('OUTCOME_GOVERNANCE', 'Aggregate outcome has an invalid purpose or denominator.')
  if (Date.parse(input.aggregationWindow.start) >= Date.parse(input.aggregationWindow.end) || Date.parse(input.retentionUntil) <= Date.parse(input.aggregationWindow.end)) throw new SystemFactoryError('OUTCOME_GOVERNANCE', 'Aggregate outcome time window or retention is invalid.')
  if (!input.limitations.length) throw new SystemFactoryError('OUTCOME_GOVERNANCE', 'Aggregate outcome must state its limitations.')
  return { ...input, admissionFingerprint: fingerprint(input), privateRecordsIncluded: false, predictionIsVerifiedOutcome: false }
}

export function createFrappeContentTargetProjection(input: { ownerId: string; clientId: string; websiteId: string; systemTenantId: string; contentOperationTargetId: string; contentHash: string; evidenceSnapshotHash: string }) {
  if (![input.contentHash, input.evidenceSnapshotHash].every(value => /^[a-f0-9]{64}$/u.test(value))) throw new SystemFactoryError('CONTENT_LINEAGE', 'Content projection requires exact content and evidence fingerprints.')
  const projection = { schemaVersion: 'frappe-content-target-projection-v1', ...input, executionEnabled: false as const, routeAuthority: 'content_operations_publication_routing' as const, requiresRiskGate: true as const, requiresReviewOrAutopilotPolicy: true as const, requiresPublicationReceipt: true as const }
  return { ...projection, projectionFingerprint: fingerprint(projection) }
}

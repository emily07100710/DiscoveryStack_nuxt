import { z } from 'zod'

export const GEO_ADMISSION_PAGE_SIZE = 25
export const GEO_ADMISSION_MAX_CANDIDATES = 100

export const admissionWorkspaceQuerySchema = z.object({
  cursor: z.string().max(64).optional(),
  sourceRecordId: z.string().regex(/^[1-9]\d{0,14}$/u).optional(),
}).strict()

export const admissionIntakeSchema = z.object({
  idempotencyKey: z.string().regex(/^[A-Za-z0-9._:-]{8,128}$/u),
  sourceRecordId: z.number().int().positive().safe(),
  candidateUrl: z.string().trim().min(1).max(2048),
}).strict()

export type AdmissionIntakeInput = z.infer<typeof admissionIntakeSchema>
export type AdmissionFeatureOrigin = 'exact_publication_draft' | 'unknown_external'
export type AdmissionObservationStatus = 'not_admitted' | 'pending' | 'verified' | 'revoked' | 'ambiguous'

export interface AdmissionObservationSummary {
  observationFingerprint: string
  candidatePageIdentityHash: string
  contentHash: string
  citationStatus: 'cited' | 'not_cited' | 'unknown'
  citationPosition: number | null
  verificationStatus: 'verified' | 'unverified' | 'stale' | 'ambiguous' | 'revoked'
  consentStatus: 'approved' | 'revoked' | 'unknown'
  piiStatus: 'clean' | 'contains_pii' | 'unknown'
  featureOrigin: AdmissionFeatureOrigin
  missingFeatureCount: number
}

export interface AdmissionCandidateAuthoritySummary {
  candidatePageIdentityHash: string
  canonicalPageHash: string
  websiteIdentityHash: string
  candidateSetFingerprint: string
  authorityBasis: 'manual_owner_attested_v1' | 'discovery_stack_publication_receipt_v1'
  citationStatus: 'cited' | 'not_cited'
  observation: AdmissionObservationSummary | null
}

export interface AdmissionCandidateSetSummary {
  decisionId: string
  candidateSetFingerprint: string
  decision: 'approve' | 'revoke'
  memberCount: number
  createdAt: string
}

export interface AdmissionSourceSummary {
  sourceRecordId: number
  provider: string
  model: string
  locale: string
  observedAt: string
  responseHash: string
  citationCount: number
  eligible: boolean
  reasonCodes: string[]
}

export interface AdmissionSelectedSource extends AdmissionSourceSummary {
  citations: Array<{
    candidateUrl: string
    candidatePageIdentityHash: string
    citationPosition: number
    observation: AdmissionObservationSummary | null
  }>
  candidateSets: AdmissionCandidateSetSummary[]
  candidateAuthorities: AdmissionCandidateAuthoritySummary[]
  intakeEnabled: boolean
}

export interface AdmissionWorkspace {
  sources: AdmissionSourceSummary[]
  nextCursor: string | null
  selectedSource: AdmissionSelectedSource | null
}

export interface AdmissionIntakeResponse {
  status: 'success'
  observation: AdmissionObservationSummary & {
    sourceRecordId: number
    governanceIndependent: true
    trainingAdmission: false
    productionActivation: false
    replayed: boolean
  }
}

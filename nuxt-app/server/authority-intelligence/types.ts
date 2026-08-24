export const authoritySourceTypes = [
  'peer_reviewed_paper',
  'preprint_repository',
  'government',
  'standards_body',
  'academic_institution',
  'professional_association',
  'first_party_expert',
  'industry_publication',
  'news',
  'commercial_blog',
  'community',
  'social',
] as const

export type AuthoritySourceType = (typeof authoritySourceTypes)[number]

export const authorityPurposes = [
  'research_reference',
  'content_citation',
  'evidence_support',
  'model_evaluation',
  'model_training',
] as const

export type AuthorityPurpose = (typeof authorityPurposes)[number]

export const authorityDecisionStatuses = [
  'approved',
  'review_required',
  'not_ready',
  'blocked',
] as const

export type AuthorityDecisionStatus = (typeof authorityDecisionStatuses)[number]

export interface AuthoritySourceCandidate {
  sourceId: string
  sourceName: string
  sourceUrl: string
  publisherDomain: string
  title: string
  sourceType: typeof authoritySourceTypes[number]
  sectors: string[]
  topics: string[]
  locale: 'en' | 'zh-hant' | 'multilingual'
  jurisdiction: string | null
  publisher: string
  publishedAt: string | null
  updatedAt: string | null
  capturedAt: string
  licenceStatus:
    | 'verified_permissive'
    | 'verified_restricted'
    | 'unknown'
    | 'not_applicable'
  termsStatus:
    | 'allows_research'
    | 'allows_citation'
    | 'allows_automation'
    | 'prohibits_automation'
    | 'unknown'
  robotsStatus:
    | 'reviewed_allow'
    | 'reviewed_restrict'
    | 'unavailable'
    | 'not_applicable'
    | 'unreviewed'
  copyrightRisk:
    | 'low'
    | 'medium'
    | 'high'
    | 'blocked'
    | 'unreviewed'
  piiStatus:
    | 'none_detected'
    | 'possible'
    | 'restricted'
    | 'unreviewed'
  accessMethod:
    | 'manual'
    | 'official_api'
    | 'licensed_feed'
    | 'public_web'
  evidenceLocator: string
  sourceHash: string
}

export interface AuthorityPolicyRequest {
  purpose: typeof authorityPurposes[number]
  clientSector: string
  contentTopics: string[]
  targetLocale: 'en' | 'zh-hant'
  targetJurisdiction: string | null
  workflowMode: 'manual_review' | 'automated_ingestion'
  asOf: string
  candidate: AuthoritySourceCandidate
}

export interface AuthorityPolicyDecision {
  status: typeof authorityDecisionStatuses[number]
  authorityTier:
    | 'primary'
    | 'high'
    | 'contextual'
    | 'weak'
    | 'ineligible'
  allowedPurposes: Array<typeof authorityPurposes[number]>
  matchedSectors: string[]
  matchedTopics: string[]
  reasonCodes: string[]
  limitations: string[]
  policyVersion: 'authority-source-policy-v1'
  sourceId: string
  sourceHash: string
  decisionFingerprint: string
}

export interface AuthoritySelectionResult {
  status: 'ready' | 'not_ready' | 'rejected'
  selected: AuthorityPolicyDecision[]
  reviewRequired: AuthorityPolicyDecision[]
  blocked: AuthorityPolicyDecision[]
  limitations: string[]
  policyVersion: 'authority-source-policy-v1'
  selectionFingerprint: string
}

export interface AuthoritySourceSelectionRequest {
  purpose: typeof authorityPurposes[number]
  clientSector: string
  contentTopics: string[]
  targetLocale: 'en' | 'zh-hant'
  targetJurisdiction: string | null
  workflowMode: 'manual_review' | 'automated_ingestion'
  asOf: string
  candidates: AuthoritySourceCandidate[]
  maxSelected: number
}

export type AuthorityTier = AuthorityPolicyDecision['authorityTier']
export type AuthorityWorkflowMode = AuthorityPolicyRequest['workflowMode']
export type AuthorityLocale = AuthorityPolicyRequest['targetLocale']

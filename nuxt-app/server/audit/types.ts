export const AUDIT_ANALYZER_VERSION = 'audit-manual-v1'
export const EXTRACTION_VERSION = 'manual-observation-v1'
export const CLASSIFIER_VERSION = 'friction-rules-v1'
export const LABEL_TAXONOMY_VERSION = 'journey-friction-v1'
export const LABEL_CONTRACT_VERSION = 'audit-review-v1'
export const TRAINING_FEATURE_CONTRACT_VERSION = 'journey-features-v1'
export const DATASET_VERSION = 'journey-dataset-v1'
export const SPLIT_VERSION = 'journey-split-v1'

export const journeyStages = ['discovery', 'understanding', 'response', 'progression', 'conversion'] as const
export type JourneyStage = typeof journeyStages[number]

export const journeyTaxonomy = [
  { id: 'discovery', definition: 'Whether a qualified question can reach an appropriate public page.', evidenceBoundary: 'Public technical and content signals only.' },
  { id: 'understanding', definition: 'Whether the public promise, method and fit can be understood.', evidenceBoundary: 'Public service-language and page-structure signals only.' },
  { id: 'response', definition: 'Whether a visitor can locate a clear enquiry or human-response route.', evidenceBoundary: 'Public CTA and contact-route signals only.' },
  { id: 'progression', definition: 'Whether the visible next step follows naturally from understanding.', evidenceBoundary: 'Public CTA, booking and contact-route signals only.' },
  { id: 'conversion', definition: 'Whether an authorised first-party outcome can be measured.', evidenceBoundary: 'Never inferred from public pages; requires explicit authorised first-party evidence.' },
] as const satisfies ReadonlyArray<{ id: JourneyStage, definition: string, evidenceBoundary: string }>

export type AuditScopePolicy = {
  maxPages: number
  maxDiscoveryDepth: number
  includePaths: string[]
  excludePaths: string[]
  sitemap: 'include' | 'skip' | 'only'
  allowSubdomains: boolean
  allowExternalLinks: boolean
  ignoreQueryParameters: boolean
  onlyMainContent: boolean
  maxConcurrency: number
  authorization: { confirmed: true, policyVersion: 'public-audit-consent-v1' }
}

export const defaultAuditScope: Omit<AuditScopePolicy, 'authorization'> = {
  maxPages: 20,
  maxDiscoveryDepth: 2,
  includePaths: [],
  excludePaths: ['^/wp-admin', '^/login', '^/account', '^/cart', '^/checkout', '^/search', '^/api'],
  sitemap: 'include',
  allowSubdomains: false,
  allowExternalLinks: false,
  ignoreQueryParameters: true,
  onlyMainContent: true,
  maxConcurrency: 1,
}

export type ClassifiableObservation = { id: number, observationKey: string, valueText: string | null, evidenceQuote: string | null, sourceUrl: string }
export type ClassifierEvidence = { observationKey: string, evidenceQuote?: string, sourceUrl: string, weight: number }
export type FrictionAssessmentDraft = { journeyStage: JourneyStage, priorityRank: number, score: number, assessmentStatus: 'supported' | 'insufficient_evidence' | 'needs_review', summary: string, evidence: ClassifierEvidence[], observationIds: number[], requiresHumanReview: true }

export type TrainingFeatureVector = {
  contractVersion: typeof TRAINING_FEATURE_CONTRACT_VERSION
  language: 'en' | 'zh-hant'
  observationCount: number
  distinctPageCount: number
  binarySignalCounts: Record<string, { true: number, false: number, other: number }>
  assessmentSnapshot: Array<{ stage: JourneyStage, status: FrictionAssessmentDraft['assessmentStatus'], score: number }>
}

import type { ReasonCode } from './reason-codes'

export const CONTENT_QUALITY_CONTRACT_VERSION = 'geo-content-quality-v1' as const
export const PROMPT_PACK_VERSION = 'geo-content-quality-prompt-pack-v1' as const
export const PROVIDER_OUTPUT_VERSION = 'geo-content-quality-output-v1' as const
export const RETRIEVAL_VERSION = 'geo-content-quality-retrieval-v1' as const
export const GOVERNANCE_RULES_VERSION = 'geo-content-quality-governance-v1' as const
export const LEXICAL_RETRIEVAL_SCORE_BASIS = 'deterministic_lexical_overlap_v1' as const

export const CONTENT_TYPES = ['article', 'faq', 'service_page'] as const
export type ContentType = typeof CONTENT_TYPES[number]
export const LANGUAGES = ['zh-hant', 'en'] as const
export type ContentLanguage = typeof LANGUAGES[number]
export const INDUSTRY_RISKS = ['general', 'medical', 'legal', 'financial'] as const
export type IndustryRisk = typeof INDUSTRY_RISKS[number]
export const REVIEW_STATUS = ['approved'] as const
export type ReviewStatus = typeof REVIEW_STATUS[number]
export const CLAIM_TYPES = ['factual', 'quantitative', 'comparative', 'high_risk', 'interpretation', 'opinion', 'process', 'call_to_action'] as const
export type ClaimType = typeof CLAIM_TYPES[number]
export const SOURCE_TYPES = ['first_party', 'authority', 'research', 'documentation', 'regulatory', 'other'] as const
export type SourceType = typeof SOURCE_TYPES[number]
export const QUALITY_STATUSES = ['passed', 'needs_human_review', 'blocked'] as const
export type QualityStatus = typeof QUALITY_STATUSES[number]
export const PROMPT_SECTION_IDS = ['ROLE_AND_NON_NEGOTIABLE_RULES', 'CONTENT_BRIEF_JSON', 'SELECTED_GEO_RULES_JSON', 'RETRIEVED_APPROVED_EVIDENCE_JSON', 'CLAIM_AND_CITATION_CONTRACT', 'CONTENT_STRUCTURE_REQUIREMENTS', 'OUTPUT_JSON_SCHEMA', 'QUALITY_AND_HUMAN_REVIEW_BOUNDARY', 'REQUEST_FINGERPRINTS'] as const
export type PromptSectionId = typeof PROMPT_SECTION_IDS[number]

export type ProviderProvenance = {
  provider: string
  model: string
  requestId: string
  providerVersion: string
  generationMode: string
  requestedAt: string
  generatedAt: string
}

export type ApprovedEvidenceChunk = {
  sourceId: string
  artifactId: string
  chunkId: string
  sourceType: SourceType
  title: string
  locator: string
  artifactHash: string
  chunkHash: string
  corpusSnapshotHash: string
  evidenceSnapshotHash: string
  reviewedText: string
  approvedPurposes: string[]
  capturedAt: string
  reviewStatus: ReviewStatus
}

export type AuthoritySource = {
  sourceId: string
  artifactId: string
  title: string
  locator: string
  sourceHash: string
  capturedAt: string
  reviewStatus: ReviewStatus
}

export type RetrievalPlan = {
  retrievalVersion: typeof RETRIEVAL_VERSION
  queryFingerprint: string
  corpusSnapshotHash: string
  evidenceSnapshotHash: string
  topK: number
  allowedSourceIds: string[]
  allowedArtifactIds: string[]
  requiredPurposes: string[]
}

export type ContentQualityInput = {
  contractVersion: typeof CONTENT_QUALITY_CONTRACT_VERSION
  ownerUserId: string
  clientId: string
  briefId: string
  jobId: string
  topic: string
  workingTitle: string
  primaryQuestion: string
  contentType: ContentType
  language: ContentLanguage
  industryRisk: IndustryRisk
  audience: string
  brandVoice: string
  goals: string[]
  constraints: string[]
  selectedRuleIds: string[]
  evidenceSnapshotHash: string
  approvedEvidenceChunks: ApprovedEvidenceChunk[]
  authoritySources: AuthoritySource[]
  retrievalPlan: RetrievalPlan
  providerProvenance: ProviderProvenance
  requestedAt: string
}

export type PromptSection = { id: PromptSectionId, content: string, contentHash: string }

export type PromptPack = {
  packVersion: typeof PROMPT_PACK_VERSION
  governanceRulesVersion: typeof GOVERNANCE_RULES_VERSION
  promptFingerprint: string
  contentQualityFingerprint: string
  sections: PromptSection[]
  finalPrompt: string
  limitations: string[]
}

export type PromptPackResult =
  | { status: 'ready', promptPack: PromptPack, reasonCodes: [] }
  | { status: 'blocked', promptPack: null, reasonCodes: ReasonCode[] }

export type RetrievalCandidate = { chunk: ApprovedEvidenceChunk, limitations?: string[] }
export type RetrievedEvidenceChunk = ApprovedEvidenceChunk & { matchedTokenCount: number, queryTokenCount: number, relevanceRatio: number, scoreBasis: typeof LEXICAL_RETRIEVAL_SCORE_BASIS, limitations: string[] }
export type RetrievalResult = { status: 'ready' | 'not_ready' | 'blocked', retrievalVersion: typeof RETRIEVAL_VERSION, queryFingerprint: string, retrievalFingerprint: string | null, corpusSnapshotHash: string, evidenceSnapshotHash: string, chunks: RetrievedEvidenceChunk[], reasonCodes: ReasonCode[], limitations: string[] }

export type ProviderClaim = { claimId: string, text: string, claimType: ClaimType, bodyLocator: string, citationIds: string[] }
export type ProviderCitation = { citationId: string, sourceId: string, artifactId: string, chunkId: string, chunkHash: string, artifactHash: string, sourceLocator: string }
export type FaqPair = { question: string, answer: string, citationIds: string[] }
export type ParagraphIdentity = { paragraphIndex: number, normalizedText: string, paragraphHash: string, citationMarkerIds: string[] }
export type ParagraphBinding = { paragraphIndex: number, paragraphHash: string, claimType: ClaimType, citationIds: string[] }

export type ProviderOutput = {
  outputVersion: typeof PROVIDER_OUTPUT_VERSION
  title: string
  summary: string
  body: string
  bodyHash: string
  faqPairs: FaqPair[]
  claims: ProviderClaim[]
  citations: ProviderCitation[]
  appliedRuleIds: string[]
  limitations: string[]
  paragraphBindings: ParagraphBinding[]
  provider: string
  model: string
  requestId: string
  requestedAt: string
  generatedAt: string
  promptFingerprint: string
  contentQualityFingerprint: string
  retrievalFingerprint: string
  responseHash: string
}

export type ProviderOutputValidationContext = { promptPack?: PromptPack, retrievalResult?: RetrievalResult }
export type ProviderOutputValidationResult =
  | { status: 'valid', output: ProviderOutput, reasonCodes: [] }
  | { status: 'invalid', output: null, reasonCodes: ReasonCode[] }

export type MarkdownFaqPair = { question: string, answer: string }
export type MarkdownStructureReport = {
  titleHeading: string | null
  headingLevels: number[]
  h2Count: number
  h3Count: number
  headingLevelJump: boolean
  emptySection: boolean
  duplicateNormalizedHeadings: string[]
  firstMeaningfulParagraph: string | null
  directAnswerFirst: boolean
  duplicateParagraphs: string[]
  faqSectionFound: boolean
  faqPairs: MarkdownFaqPair[]
  duplicateFaqQuestions: string[]
  citationMarkerCount: number
  citationMarkerPlacementValid: boolean
  conclusionOrCtaFound: boolean
  templateFillerFound: boolean
  simplifiedChineseFound: boolean
  meaningfulParagraphCount: number
  paragraphs: ParagraphIdentity[]
}
export type MarkdownStructureResult =
  | { status: 'valid', report: MarkdownStructureReport, reasonCodes: [] }
  | { status: 'invalid', report: MarkdownStructureReport, reasonCodes: ReasonCode[] }

export type CoverageMetric = { metricName: 'deterministic heuristic / coverage metric', applicable: boolean, numerator: number, denominator: number, ratio: number | null, reasonCodes: string[] }
export type StructureChecks = { directAnswer: boolean, headingHierarchy: boolean, emptySections: boolean, duplicateHeadings: boolean, duplicateParagraphs: boolean, faqIntegrity: boolean, citationPlacement: boolean, conclusionOrCta: boolean, workingTitleMatchesH1: boolean, topicOverlap: boolean, paragraphBindings: boolean, claimSafety: boolean, selectedRuleChecks: boolean }
export type QualityGateResult = { status: QualityStatus, reasonCodes: ReasonCode[], sourceCoverage: CoverageMetric, claimCoverage: CoverageMetric, citationCoverage: CoverageMetric, goalCoverage: CoverageMetric, structureChecks: StructureChecks, limitations: string[], humanReviewRequired: true }
export type QualityGateInput = { qualityInput: unknown, providerOutput: unknown, markdown?: unknown, retrievalResult?: unknown, promptPack?: unknown }

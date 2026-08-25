import type { ReasonCode } from './reason-codes'

export const CONTENT_QUALITY_CONTRACT_VERSION = 'geo-content-quality-v1' as const
export const PROMPT_PACK_VERSION = 'geo-content-quality-prompt-pack-v1' as const
export const PROVIDER_OUTPUT_VERSION = 'geo-content-quality-output-v1' as const
export const RETRIEVAL_VERSION = 'geo-content-quality-retrieval-v1' as const
export const GOVERNANCE_RULES_VERSION = 'geo-content-quality-governance-v1' as const

export const CONTENT_TYPES = ['article', 'faq', 'service_page'] as const
export type ContentType = typeof CONTENT_TYPES[number]
export const LANGUAGES = ['zh-hant', 'en'] as const
export type ContentLanguage = typeof LANGUAGES[number]
export const INDUSTRY_RISKS = ['general', 'medical', 'legal', 'financial'] as const
export type IndustryRisk = typeof INDUSTRY_RISKS[number]
export const REVIEW_STATUS = ['approved'] as const
export type ReviewStatus = typeof REVIEW_STATUS[number]
export const CLAIM_TYPES = ['factual', 'quantitative', 'comparative', 'medical', 'legal', 'financial', 'opinion', 'process'] as const
export type ClaimType = typeof CLAIM_TYPES[number]
export const SOURCE_TYPES = ['first_party', 'authority', 'research', 'documentation', 'regulatory', 'other'] as const
export type SourceType = typeof SOURCE_TYPES[number]
export const QUALITY_STATUSES = ['passed', 'needs_human_review', 'blocked'] as const
export type QualityStatus = typeof QUALITY_STATUSES[number]
export const PROMPT_SECTION_IDS = ['SYSTEM_GOVERNANCE', 'CONTENT_BRIEF', 'BRAND_CONTEXT', 'APPROVED_EVIDENCE', 'AUTHORITY_SOURCES', 'SELECTED_GEO_RULES', 'PROHIBITED_CLAIMS', 'OUTPUT_CONTRACT', 'FINAL_INSTRUCTION'] as const
export type PromptSectionId = typeof PROMPT_SECTION_IDS[number]

export type ProviderProvenance = {
  provider: string
  model: string
  providerVersion: string
  generationMode: string
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

export type PromptSection = {
  id: PromptSectionId
  content: string
  contentHash: string
}

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

export type RetrievalCandidate = {
  chunk: ApprovedEvidenceChunk
  scoreBasis: string
  limitations: string[]
}

export type RetrievedEvidenceChunk = ApprovedEvidenceChunk & {
  scoreBasis: string
  limitations: string[]
}

export type RetrievalResult = {
  status: 'ready' | 'not_ready' | 'blocked'
  retrievalVersion: typeof RETRIEVAL_VERSION
  corpusSnapshotHash: string
  evidenceSnapshotHash: string
  chunks: RetrievedEvidenceChunk[]
  reasonCodes: ReasonCode[]
  limitations: string[]
}

export type ProviderClaim = {
  claimId: string
  text: string
  claimType: ClaimType
  bodyLocator: string
  citationIds: string[]
}

export type ProviderCitation = {
  citationId: string
  sourceId: string
  artifactId: string
  chunkId: string
  chunkHash: string
}

export type FaqPair = {
  question: string
  answer: string
  citationIds: string[]
}

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
}

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
}

export type MarkdownStructureResult =
  | { status: 'valid', report: MarkdownStructureReport, reasonCodes: [] }
  | { status: 'invalid', report: MarkdownStructureReport, reasonCodes: ReasonCode[] }

export type CoverageMetric = {
  metricName: 'deterministic heuristic / coverage metric'
  numerator: number
  denominator: number
  ratio: number
}

export type StructureChecks = {
  directAnswer: boolean
  headingHierarchy: boolean
  emptySections: boolean
  duplicateHeadings: boolean
  duplicateParagraphs: boolean
  faqIntegrity: boolean
  citationPlacement: boolean
  conclusionOrCta: boolean
}

export type QualityGateResult = {
  status: QualityStatus
  reasonCodes: ReasonCode[]
  sourceCoverage: CoverageMetric
  claimCoverage: CoverageMetric
  citationCoverage: CoverageMetric
  structureChecks: StructureChecks
  limitations: string[]
}

export type QualityGateInput = {
  qualityInput: unknown
  providerOutput: unknown
  markdown: unknown
  retrievalResult?: unknown
}

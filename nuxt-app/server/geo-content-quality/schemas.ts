import { z } from 'zod'
import { CONTENT_QUALITY_CONTRACT_VERSION, CONTENT_TYPES, INDUSTRY_RISKS, LANGUAGES, RETRIEVAL_VERSION, REVIEW_STATUS, SOURCE_TYPES } from './types'

export const SHA256_HEX = /^[a-f0-9]{64}$/u
export const ISO_TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/u

const boundedId = z.string().min(1).max(160).regex(/^[A-Za-z0-9._:-]+$/u)
const safeText = z.string().min(1).max(10000)
const topicText = z.string().min(1).max(500)
const titleText = z.string().min(1).max(300)
const questionText = z.string().min(1).max(500)
const strictTimestamp = z.string().regex(ISO_TIMESTAMP)
const sha256 = z.string().regex(SHA256_HEX)
const publicHttpsLocator = z.string().url().refine(value => {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && !url.username && !url.password && !url.hash && (!url.port || url.port === '443')
  } catch {
    return false
  }
}, { message: 'locator must be a public HTTPS URL without credentials, fragment, or non-443 port' })

export const providerProvenanceSchema = z.object({
  provider: boundedId,
  model: boundedId,
  requestId: boundedId,
  providerVersion: boundedId,
  generationMode: boundedId,
  requestedAt: strictTimestamp,
  generatedAt: strictTimestamp,
}).strict()

export const approvedEvidenceChunkSchema = z.object({
  sourceId: boundedId,
  artifactId: boundedId,
  chunkId: boundedId,
  sourceType: z.enum(SOURCE_TYPES),
  title: safeText,
  locator: publicHttpsLocator,
  artifactHash: sha256,
  chunkHash: sha256,
  corpusSnapshotHash: sha256,
  evidenceSnapshotHash: sha256,
  reviewedText: z.string().min(1).max(12000),
  approvedPurposes: z.array(boundedId).min(1).max(12),
  capturedAt: strictTimestamp,
  reviewStatus: z.enum(REVIEW_STATUS),
}).strict().superRefine((value, context) => {
  if (!value.approvedPurposes.includes('content_draft')) context.addIssue({ code: 'custom', path: ['approvedPurposes'], message: 'content_draft purpose is required' })
})

export const authoritySourceSchema = z.object({
  sourceId: boundedId,
  artifactId: boundedId,
  title: safeText,
  locator: publicHttpsLocator,
  sourceHash: sha256,
  capturedAt: strictTimestamp,
  reviewStatus: z.enum(REVIEW_STATUS),
}).strict()

export const retrievalPlanSchema = z.object({
  retrievalVersion: z.literal(RETRIEVAL_VERSION),
  queryFingerprint: sha256,
  corpusSnapshotHash: sha256,
  evidenceSnapshotHash: sha256,
  topK: z.number().int().min(1).max(20),
  allowedSourceIds: z.array(boundedId).max(100),
  allowedArtifactIds: z.array(boundedId).max(100),
  requiredPurposes: z.array(boundedId).min(1).max(12),
}).strict()

export const contentQualityInputSchema = z.object({
  contractVersion: z.literal(CONTENT_QUALITY_CONTRACT_VERSION),
  ownerUserId: boundedId,
  clientId: boundedId,
  briefId: boundedId,
  jobId: boundedId,
  topic: topicText,
  workingTitle: titleText,
  primaryQuestion: questionText,
  contentType: z.enum(CONTENT_TYPES),
  language: z.enum(LANGUAGES),
  industryRisk: z.enum(INDUSTRY_RISKS),
  audience: safeText,
  brandVoice: safeText,
  goals: z.array(safeText).min(1).max(20),
  constraints: z.array(safeText).max(20),
  selectedRuleIds: z.array(boundedId).min(1).max(40),
  evidenceSnapshotHash: sha256,
  approvedEvidenceChunks: z.array(approvedEvidenceChunkSchema).max(100),
  authoritySources: z.array(authoritySourceSchema).max(50),
  retrievalPlan: retrievalPlanSchema,
  providerProvenance: providerProvenanceSchema,
  requestedAt: strictTimestamp,
}).strict()

export type ContentQualityInputShape = z.infer<typeof contentQualityInputSchema>

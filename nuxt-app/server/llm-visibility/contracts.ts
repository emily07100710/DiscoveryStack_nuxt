import { z } from 'zod'
import { VISIBILITY_SAMPLE_LIMITATION_CODES } from './statistics'

export const visibilityProviders = ['chatgpt', 'gemini', 'perplexity', 'google_ai_overview', 'manual_other'] as const
export const visibilityModes = ['manual_verified', 'provider_api_observation'] as const
export const visibilityRunStatuses = ['queued', 'completed', 'blocked', 'failed'] as const
export const visibilityLocales = ['en', 'zh-hant'] as const

const boundedLabel = (max: number) => z.string().trim().min(1).max(max)
const boundedIdentity = (max: number) => z.union([boundedLabel(max), z.number().int().positive()])
const hash = z.string().trim().regex(/^[a-f0-9]{64}$/i, '必須是 64 字元 SHA-256 hex。').transform(value => value.toLowerCase())

export const projectInputSchema = z.object({
  name: boundedLabel(160),
  canonicalWebsiteUrl: boundedLabel(2048),
  locale: z.enum(visibilityLocales),
  brandName: boundedLabel(160),
  brandAliases: z.array(boundedLabel(160)).max(30).default([]),
  competitorBrands: z.array(boundedLabel(160)).max(30).default([]),
}).strict()

export const queryInputSchema = z.object({
  projectId: z.number().int().positive(),
  promptText: boundedLabel(2000),
  intent: boundedLabel(120),
  locale: z.enum(visibilityLocales),
  active: z.boolean().default(true),
}).strict()

export const visibilityQueryUpdateSchema = z.object({
  promptText: boundedLabel(2000).optional(),
  active: z.boolean().optional(),
}).strict().refine(value => value.promptText !== undefined || value.active !== undefined, '至少需要一個可更新欄位。')

const competitorShape = {
  name: boundedLabel(160),
  aliases: z.array(boundedLabel(160)).max(20).default([]),
  domain: z.string().trim().min(1).max(253).nullable().default(null),
} as const

export const visibilityCompetitorCreateSchema = z.object(competitorShape).strict()
export const visibilityCompetitorUpdateSchema = z.object({
  name: competitorShape.name.optional(),
  aliases: z.array(boundedLabel(160)).max(20).optional(),
  domain: z.string().trim().min(1).max(253).nullable().optional(),
  active: z.boolean().optional(),
}).strict().refine(value => Object.values(value).some(item => item !== undefined), '至少需要一個可更新欄位。')

const observationInputShape = {
  projectId: z.number().int().positive(),
  queryId: z.number().int().positive(),
  runId: z.number().int().positive().optional(),
  provider: z.enum(visibilityProviders),
  modelLabel: boundedLabel(160),
  observedAt: z.string().datetime({ offset: true }),
  requestFingerprint: hash,
  limitationCode: boundedLabel(120),
  brandMentioned: z.boolean(),
  exactMentionCount: z.number().int().min(0).max(10000),
  firstMentionPosition: z.number().int().positive().max(1000000).nullable(),
  citedDomain: z.string().trim().max(253).nullable().default(null),
  citationUrls: z.array(boundedLabel(2048)).max(50).default([]),
  competitorMentions: z.record(boundedLabel(160), z.number().int().min(0).max(10000)).refine(value => Object.keys(value).length <= 30, '競品項目最多 30 筆。'),
  boundedExcerpt: z.string().trim().min(1).max(1000),
  responseHash: hash,
  evidenceLocator: boundedLabel(1000),
  reviewerNote: boundedLabel(2000),
} as const

function validateObservationConsistency(value: { brandMentioned: boolean, exactMentionCount: number, firstMentionPosition: number | null }, context: z.RefinementCtx) {
  if (value.brandMentioned !== (value.exactMentionCount > 0)) context.addIssue({ code: 'custom', path: ['brandMentioned'], message: 'brandMentioned 必須與 exactMentionCount 一致。' })
  if (value.brandMentioned !== (value.firstMentionPosition !== null)) context.addIssue({ code: 'custom', path: ['firstMentionPosition'], message: '提及品牌時必須提供首次位置，未提及時必須為 null。' })
}

/** Broad persisted/metrics contract retained for pure mocked provider-mode tests and future schema compatibility. */
export const observationInputSchema = z.object({
  ...observationInputShape,
  observationMode: z.enum(visibilityModes),
  status: z.enum(visibilityRunStatuses),
  verifiedByOwner: z.literal(true),
}).strict().superRefine(validateObservationConsistency)

/** Owner import is an untrusted pending snapshot. Authority is added only by the review ledger. */
export const ownerManualObservationImportSchema = z.object({
  ...observationInputShape,
}).strict().superRefine(validateObservationConsistency)

export const ownerManualObservationReviewSchema = z.object({
  idempotencyKey: boundedLabel(128),
  decision: z.enum(['approve', 'revoke']),
  reason: boundedLabel(500),
}).strict()

/** Provider API observations are bounded secondary evidence and never owner-verified consumer-surface truth. */
export const visibilityProviderTargetSchema = z.object({
  provider: z.enum(['chatgpt', 'gemini', 'perplexity']),
  modelLabel: boundedLabel(160),
  adapterKey: boundedLabel(120),
  allowedLocales: z.array(z.enum(visibilityLocales)).min(1).max(2),
  maximumResponseBytes: z.number().int().min(1).max(2_000_000).default(120_000),
  timeoutMs: z.number().int().min(1_000).max(120_000).default(30_000),
}).strict()

export const providerObservationRunInputSchema = z.object({
  projectId: z.number().int().positive(),
  queryIds: z.array(z.number().int().positive()).min(1).max(100),
  observationWindowKey: boundedLabel(160),
  maximumProbes: z.number().int().min(1).max(50).default(50),
  providerTargets: z.array(visibilityProviderTargetSchema).min(1).max(12),
}).strict()

export const providerObservationCandidateSchema = z.object({
  ...observationInputShape,
  probeId: boundedLabel(256),
  projectId: boundedIdentity(128),
  queryId: boundedIdentity(128),
  observationMode: z.literal('provider_api_observation'),
  status: z.literal('completed'),
  verifiedByOwner: z.literal(false),
  metricEligibility: z.literal('secondary_only'),
  consumerSurfaceEquivalent: z.literal(false),
  persistenceStatus: z.literal('persisted_secondary_only'),
  planFingerprint: hash,
  ownerScopeKey: boundedLabel(256),
  observationWindowKey: boundedLabel(160),
  providerRequestId: boundedLabel(256).optional(),
  citationDates: z.record(boundedLabel(2048), z.string().regex(/^\d{4}-\d{2}-\d{2}$/u)).refine(value => Object.keys(value).length <= 50, 'citationDates 最多 50 筆。').optional(),
  provenance: z.object({
    adapterKey: boundedLabel(160),
    engineVersion: boundedLabel(120),
    responseMetadata: z.object({
      finishReason: boundedLabel(80).optional(),
      inputTokens: z.number().int().min(0).max(1_000_000).optional(),
      outputTokens: z.number().int().min(0).max(1_000_000).optional(),
      totalTokens: z.number().int().min(0).max(1_000_000).optional(),
    }).strict().optional(),
  }).strict(),
}).strict().superRefine(validateObservationConsistency)

export type ProjectInput = z.infer<typeof projectInputSchema>
export type QueryInput = z.infer<typeof queryInputSchema>
export type VisibilityQueryUpdate = z.infer<typeof visibilityQueryUpdateSchema>
export type VisibilityCompetitorCreate = z.infer<typeof visibilityCompetitorCreateSchema>
export type VisibilityCompetitorUpdate = z.infer<typeof visibilityCompetitorUpdateSchema>
export type ObservationInput = z.infer<typeof observationInputSchema>
export type OwnerManualObservationImport = z.infer<typeof ownerManualObservationImportSchema>
export type OwnerManualObservationReview = z.infer<typeof ownerManualObservationReviewSchema>
export type ProviderObservationRunInput = z.infer<typeof providerObservationRunInputSchema>
export type ProviderObservationCandidate = z.infer<typeof providerObservationCandidateSchema>
export type PersistableObservationInput = Omit<ObservationInput, 'verifiedByOwner'> & { verifiedByOwner: boolean }
export type VisibilityProvider = typeof visibilityProviders[number]
export type VisibilityMode = typeof visibilityModes[number]

export class VisibilityContractError extends Error {
  constructor(public readonly statusCode: 400 | 404 | 409 | 422 | 503, message: string) {
    super(message)
    this.name = 'VisibilityContractError'
  }
}

export const VISIBILITY_LIMITATIONS = [
  'V1 primary metrics 只接受 durable owner review ledger 核准且未撤銷的 manual snapshot；provider_api_observation 雖可保存為 secondary-only evidence，仍不等同 consumer ChatGPT、Gemini、Perplexity 或 Google AI Overviews 介面的真實曝光。',
  '此模組不量測搜尋排名，也不提供流量、轉換、營收或 ROI 保證。',
  'provider_api_observation 可保存為明確標記的 secondary-only observation，但永遠不是 owner-verified evidence、consumer UI truth 或 primary manual_verified 指標。',
  '主要指標只使用符合期間且 review ledger 為 approved 的 manual observation rows；observedQueries 是其中不重複的 active query 數，比例則以 observation rows 為分母。',
  'V1 沒有 consumer UI scraping、自動登入或隱藏 bypass；provider observation runtime 只透過明確注入的 provider adapter 執行，沒有 adapter／credential 時 fail-closed。',
] as const

export const VISIBILITY_LIMITATION_CODES = [
  ...VISIBILITY_SAMPLE_LIMITATION_CODES,
  'provider_api_not_consumer_surface',
  'prompt_version_mismatch',
] as const

import { z } from 'zod'

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

/** The only runtime import contract in V1: an owner-verified manual snapshot that is already complete. */
export const ownerManualObservationImportSchema = z.object({
  ...observationInputShape,
  observationMode: z.literal('manual_verified'),
  status: z.literal('completed'),
  verifiedByOwner: z.literal(true),
}).strict().superRefine(validateObservationConsistency)

/** Provider API observations are bounded secondary evidence and never owner-verified consumer-surface truth. */
export const providerObservationRunInputSchema = z.object({
  projectId: z.number().int().positive(),
  queryIds: z.array(z.number().int().positive()).min(1).max(100),
  observationWindowKey: boundedLabel(160),
  maximumProbes: z.number().int().min(1).max(50).default(50),
  providerTargets: z.array(z.object({
    provider: z.enum(['chatgpt', 'gemini', 'perplexity']),
    modelLabel: boundedLabel(160),
    adapterKey: boundedLabel(160),
    allowedLocales: z.array(z.enum(visibilityLocales)).min(1).max(2),
    maximumResponseBytes: z.number().int().min(1).max(2_000_000).default(120_000),
    timeoutMs: z.number().int().min(1_000).max(120_000).default(30_000),
  }).strict()).min(1).max(12),
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
export type ObservationInput = z.infer<typeof observationInputSchema>
export type OwnerManualObservationImport = z.infer<typeof ownerManualObservationImportSchema>
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
  'V1 primary metrics 只接受 owner 人工核對的 manual_verified snapshot；provider_api_observation 雖可保存為 secondary-only evidence，仍不等同 consumer ChatGPT、Gemini、Perplexity 或 Google AI Overviews 介面的真實曝光。',
  '此模組不量測搜尋排名，也不提供流量、轉換、營收或 ROI 保證。',
  'provider_api_observation 可保存為明確標記的 secondary-only observation，但永遠不是 owner-verified evidence、consumer UI truth 或 primary manual_verified 指標。',
  '主要指標只使用符合期間的 manual_verified observation rows；observedQueries 是其中不重複的 active query 數，比例則以 observation rows 為分母。',
  'V1 沒有 consumer UI scraping、自動登入或隱藏 bypass；provider observation runtime 只透過明確注入的 provider adapter 執行，沒有 adapter／credential 時 fail-closed。',
] as const

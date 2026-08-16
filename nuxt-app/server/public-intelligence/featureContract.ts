import { z } from 'zod'

const boundedText = (min: number, max: number) => z.string().trim().min(min).max(max)
const booleanSignals = z.object({ primaryCta: z.boolean(), serviceRouting: z.boolean(), expertContact: z.boolean(), insights: z.boolean(), trustSignals: z.boolean(), priceOrEstimator: z.boolean(), faqOrGuidedTopics: z.boolean() })

export const publicArtifactTypes = ['page_manifest', 'structural_features', 'topic_map', 'entity_map', 'semantic_features', 'technical_seo', 'derived_excerpt', 'human_annotation'] as const

export const publicFeatureContractSchema = z.discriminatedUnion('artifactType', [
  z.object({ artifactType: z.literal('page_manifest'), fieldData: z.object({ pageType: z.enum(['home', 'service', 'insight', 'case', 'contact', 'pricing', 'faq', 'other']), hierarchyDepth: z.number().int().min(0).max(12), language: z.string().trim().min(2).max(24), market: z.string().trim().min(2).max(80).nullable().optional() }) }),
  z.object({ artifactType: z.literal('structural_features'), fieldData: z.object({ signals: booleanSignals, primaryJourneyStage: z.enum(['discovery', 'understanding', 'response', 'progression', 'conversion']), navigationDepth: z.number().int().min(0).max(12), serviceRoutes: z.number().int().min(0).max(100) }) }),
  z.object({ artifactType: z.literal('topic_map'), fieldData: z.object({ topics: z.array(boundedText(2, 120)).min(1).max(30), searchIntents: z.array(z.enum(['informational', 'commercial', 'transactional', 'navigational'])).min(1).max(4), primaryTopic: boundedText(2, 160) }) }),
  z.object({ artifactType: z.literal('entity_map'), fieldData: z.object({ entities: z.array(z.object({ name: boundedText(1, 200), type: z.enum(['organisation', 'person', 'service', 'industry', 'location', 'product', 'concept']), relationship: boundedText(2, 180) })).min(1).max(50) }) }),
  z.object({ artifactType: z.literal('semantic_features'), fieldData: z.object({ semanticSummary: boundedText(40, 3000), intentVector: z.array(z.number().min(-1).max(1)).min(1).max(4096).optional(), embeddingModel: z.string().trim().max(120).nullable().optional() }) }),
  z.object({ artifactType: z.literal('technical_seo'), fieldData: z.object({ hasH1: z.boolean(), canonicalPresent: z.boolean(), indexability: z.enum(['indexable', 'noindex', 'unknown']), schemaTypes: z.array(boundedText(2, 120)).max(30), internalLinkCount: z.number().int().min(0).max(10000), languageSignal: z.string().trim().min(2).max(24).nullable().optional() }) }),
  z.object({ artifactType: z.literal('derived_excerpt'), fieldData: z.object({ excerptPurpose: z.enum(['positioning', 'service_definition', 'cta_pattern', 'faq_answer', 'technical_signal', 'other']), wordCount: z.number().int().min(1).max(5000) }) }),
  z.object({ artifactType: z.literal('human_annotation'), fieldData: z.object({ annotationKind: z.enum(['strategy_interpretation', 'taxonomy_label', 'quality_note', 'policy_note']), observation: boundedText(8, 3000), reviewerConfidence: z.number().int().min(1).max(5) }) }),
])

export const publicArtifactInputSchema = z.object({
  sourceId: z.number().int().positive(),
  sourceUrl: z.string().url().max(2048),
  canonicalUrl: z.string().url().max(2048).nullable().optional().default(null),
  artifactText: z.string().trim().max(20_000).nullable().optional().default(null),
  sourceLocator: boundedText(2, 1024),
  sourceSpanHash: z.string().regex(/^[a-f0-9]{64}$/i, 'Use a SHA-256 hash of the reviewed source span.'),
  language: z.string().trim().max(24).nullable().optional().default(null),
  extractionMethod: z.enum(['manual', 'public_api', 'policy_approved_fetch', 'human_annotation']),
  requestedUse: z.enum(['research_only', 'evaluation_candidate', 'training_candidate']),
  retentionUntil: z.string().datetime().nullable().optional().default(null),
}).and(publicFeatureContractSchema)

export type PublicArtifactInput = z.infer<typeof publicArtifactInputSchema>

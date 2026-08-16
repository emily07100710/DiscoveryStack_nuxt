import { z } from 'zod'

export const SEO_GEO_LABEL_TAXONOMY_VERSION = 'seo-geo-journey-v1'

export const JOURNEY_STAGES = ['discovery', 'understanding', 'response', 'progression', 'conversion'] as const

const boundedText = (min: number, max: number) => z.string().trim().min(min).max(max)
const uniqueValues = <T extends readonly [string, ...string[]]>(values: T, min: number, max: number) => z.array(z.enum(values)).min(min).max(max).superRefine((items, context) => {
  if (new Set(items).size !== items.length) context.addIssue({ code: 'custom', message: 'Labels in the same dimension must be unique.' })
})

export const seoGeoMultilabelSchema = z.object({
  annotationKind: z.literal('seo_geo_multilabel'),
  annotationVersion: z.literal(SEO_GEO_LABEL_TAXONOMY_VERSION),
  primaryJourneyStage: z.enum(JOURNEY_STAGES),
  journeyStages: uniqueValues(JOURNEY_STAGES, 1, 5),
  searchIntents: uniqueValues(['informational', 'commercial', 'transactional', 'navigational'] as const, 1, 4),
  contentTypes: uniqueValues(['home', 'service', 'product', 'pricing', 'faq', 'case_study', 'editorial', 'comparison', 'contact', 'tool', 'other'] as const, 1, 4),
  audienceRoles: uniqueValues(['buyer', 'researcher', 'decision_maker', 'practitioner', 'technical_evaluator', 'local_visitor', 'existing_customer', 'media_or_partner'] as const, 1, 5),
  topicClusters: z.array(boundedText(2, 120)).min(1).max(12).superRefine((items, context) => {
    if (new Set(items.map(item => item.toLowerCase())).size !== items.length) context.addIssue({ code: 'custom', message: 'Topic clusters must be unique.' })
  }),
  entitySignals: z.array(z.object({ name: boundedText(1, 160), type: z.enum(['organisation', 'service', 'product', 'industry', 'location', 'concept']), relationship: boundedText(2, 180) })).min(1).max(20),
  geoSignals: uniqueValues(['global', 'country', 'region', 'city_or_local', 'multilingual', 'not_applicable'] as const, 1, 3),
  citationReadiness: uniqueValues(['named_author_or_owner', 'first_party_expertise', 'dated_or_current', 'source_links', 'structured_data', 'contact_or_location', 'insufficient_evidence'] as const, 1, 7),
  technicalSeoSignals: uniqueValues(['title_present', 'h1_present', 'canonical_present', 'indexable', 'structured_data', 'internal_routing', 'language_signal', 'performance_not_observed'] as const, 1, 8),
  frictionSignals: uniqueValues(['unclear_value', 'weak_cta', 'missing_contact_route', 'missing_trust_signal', 'missing_next_step', 'information_overload', 'no_material_friction_observed'] as const, 1, 7),
  actionPriority: z.enum(['critical', 'high', 'medium', 'low', 'monitor']),
  annotationRationale: boundedText(16, 2_000),
  reviewerConfidence: z.number().int().min(1).max(5),
})

export type SeoGeoMultilabel = z.infer<typeof seoGeoMultilabelSchema>

export type SeoGeoTrainingTargets = {
  journeyStage: SeoGeoMultilabel['primaryJourneyStage']
  searchIntents: SeoGeoMultilabel['searchIntents']
  contentTypes: SeoGeoMultilabel['contentTypes']
  audienceRoles: SeoGeoMultilabel['audienceRoles']
  geoSignals: SeoGeoMultilabel['geoSignals']
  citationReadiness: SeoGeoMultilabel['citationReadiness']
  technicalSeoSignals: SeoGeoMultilabel['technicalSeoSignals']
  frictionSignals: SeoGeoMultilabel['frictionSignals']
  actionPriority: SeoGeoMultilabel['actionPriority']
}

/**
 * Creates only the model input. Deliberately excludes every human label,
 * annotation rationale, confidence score and review decision to prevent target leakage.
 */
export function buildSeoGeoTrainingText(input: { artifactText: string | null, language: string | null }) {
  const text = String(input.artifactText || '').replace(/\s+/g, ' ').trim()
  if (!text) return ''
  const language = String(input.language || '').trim()
  return language ? `[language=${language}]\n${text}` : text
}

export function toSeoGeoTrainingTargets(input: SeoGeoMultilabel): SeoGeoTrainingTargets {
  return {
    journeyStage: input.primaryJourneyStage,
    searchIntents: input.searchIntents,
    contentTypes: input.contentTypes,
    audienceRoles: input.audienceRoles,
    geoSignals: input.geoSignals,
    citationReadiness: input.citationReadiness,
    technicalSeoSignals: input.technicalSeoSignals,
    frictionSignals: input.frictionSignals,
    actionPriority: input.actionPriority,
  }
}

import { and, eq, isNull } from 'drizzle-orm'
import { getDatabase } from '../server/database/index.ts'
import { publicIntelligenceArtifacts, publicIntelligenceSources } from '../server/database/schema.ts'
import { createOwnerPublicArtifact, reviewOwnerPublicArtifact } from '../server/public-intelligence/repository.ts'
import { seoGeoMultilabelSchema } from '../server/public-intelligence/seoGeoTaxonomy.ts'

const annotation = {
  structuralArtifactId: 1440001,
  sourceUrl: 'https://developers.google.com/search/docs/crawling-indexing/javascript/dynamic-rendering?hl=en',
  sourceLocator: 'human-review:batch-28:dynamic-rendering',
  artifactText: 'Treat dynamic rendering only as a limited workaround when public JavaScript-generated content is not available to crawlers. Prefer server-side rendering, static rendering, or hydration for a long-term solution. If a renderer is needed, identify crawler capability, route eligible requests to a server-rendered version, preserve similar content for users and crawlers, and limit rollout by page where justified. Balance rendered HTML exposure against renderer complexity and resource cost; serving materially different crawler content is a cloaking risk, and a workaround does not guarantee indexing or a displayed result.',
  qualityNote: '人工閱讀 Dynamic Rendering 文件：摘要保留 workaround 定位、SSR/static/hydration 優先順序、crawler capability、renderer routing、per-page rollout、resource trade-off 與 cloaking boundary；不含 PII，不將 rendering 合規表述為收錄或排名保證。',
  labels: {
    annotationKind: 'seo_geo_multilabel', annotationVersion: 'seo-geo-journey-v1', primaryJourneyStage: 'conversion',
    journeyStages: ['conversion', 'progression', 'response'], searchIntents: ['informational', 'commercial'], contentTypes: ['editorial', 'tool'], audienceRoles: ['practitioner', 'technical_evaluator', 'decision_maker'],
    topicClusters: ['dynamic rendering', 'server-side rendering', 'hydration', 'crawler capability', 'rendered HTML', 'cloaking boundary'],
    entitySignals: [
      { name: 'Dynamic rendering', type: 'concept', relationship: 'Acts only as a workaround when JavaScript-generated public content is unavailable to a crawler.' },
      { name: 'Google Search', type: 'service', relationship: 'Processes rendered page content but does not make dynamic rendering a long-term recommendation.' },
      { name: 'Server-side rendering', type: 'concept', relationship: 'Is a preferred long-term rendering alternative to a bot-targeted workaround.' },
    ],
    geoSignals: ['global', 'not_applicable'], citationReadiness: ['first_party_expertise', 'dated_or_current', 'source_links'], technicalSeoSignals: ['title_present', 'h1_present', 'canonical_present', 'indexable', 'internal_routing', 'performance_not_observed'], frictionSignals: ['information_overload', 'missing_next_step'], actionPriority: 'high',
    annotationRationale: '本頁將 JavaScript content availability、renderer routing、long-term rendering alternatives 及 cloaking boundary 映射為 conversion-path technical decision，提供可治理的可見度修正信號而不虛構 indexing 或 ranking 保證。', reviewerConfidence: 5,
  },
}

const database = getDatabase()
if (!database) throw new Error('database_unavailable')

const [source] = await database.select({ id: publicIntelligenceSources.id, ownerUserId: publicIntelligenceSources.ownerUserId, retentionUntil: publicIntelligenceSources.retentionUntil }).from(publicIntelligenceSources).where(and(
  eq(publicIntelligenceSources.sourceName, 'Google Search Central Documentation（CC BY 4.0）'), eq(publicIntelligenceSources.reviewStatus, 'approved'), eq(publicIntelligenceSources.allowedUse, 'training_candidate'), eq(publicIntelligenceSources.robotsStatus, 'reviewed_allow'), eq(publicIntelligenceSources.termsStatus, 'allows_training'), eq(publicIntelligenceSources.copyrightRisk, 'low'), eq(publicIntelligenceSources.piiStatus, 'none_detected'), isNull(publicIntelligenceSources.removedAt),
)).limit(1)
if (!source) throw new Error('approved_google_search_central_source_not_found')

const [structural] = await database.select({ id: publicIntelligenceArtifacts.id, sourceSpanHash: publicIntelligenceArtifacts.sourceSpanHash, qualityStatus: publicIntelligenceArtifacts.qualityStatus, piiStatus: publicIntelligenceArtifacts.piiStatus }).from(publicIntelligenceArtifacts).where(and(
  eq(publicIntelligenceArtifacts.id, annotation.structuralArtifactId), eq(publicIntelligenceArtifacts.sourceId, source.id), eq(publicIntelligenceArtifacts.artifactType, 'structural_features'), eq(publicIntelligenceArtifacts.sourceUrl, annotation.sourceUrl), isNull(publicIntelligenceArtifacts.removedAt),
)).limit(1)
if (!structural?.sourceSpanHash) throw new Error(`batch_28_structural_artifact_not_found:${annotation.structuralArtifactId}`)
if (structural.piiStatus !== 'none_detected') throw new Error(`batch_28_pii_not_clear:${annotation.structuralArtifactId}`)
if (structural.qualityStatus !== 'passed') await reviewOwnerPublicArtifact({ ownerUserId: source.ownerUserId, artifactId: structural.id, qualityStatus: 'passed', qualityNote: annotation.qualityNote })

const labels = seoGeoMultilabelSchema.parse(annotation.labels)
const [existing] = await database.select({ id: publicIntelligenceArtifacts.id, qualityStatus: publicIntelligenceArtifacts.qualityStatus }).from(publicIntelligenceArtifacts).where(and(
  eq(publicIntelligenceArtifacts.sourceId, source.id), eq(publicIntelligenceArtifacts.artifactType, 'human_annotation'), eq(publicIntelligenceArtifacts.sourceUrl, annotation.sourceUrl), isNull(publicIntelligenceArtifacts.removedAt),
)).limit(1)
const human = existing || await createOwnerPublicArtifact({ ownerUserId: source.ownerUserId, sourceId: source.id, sourceUrl: annotation.sourceUrl, canonicalUrl: annotation.sourceUrl, artifactType: 'human_annotation', artifactText: annotation.artifactText, sourceLocator: annotation.sourceLocator, sourceSpanHash: structural.sourceSpanHash, fieldData: labels, language: 'en', extractionMethod: 'human_annotation', requestedUse: 'training_candidate', retentionUntil: source.retentionUntil })
if (human.qualityStatus !== 'passed') await reviewOwnerPublicArtifact({ ownerUserId: source.ownerUserId, artifactId: human.id, qualityStatus: 'passed', qualityNote: annotation.qualityNote })
console.log(JSON.stringify({ sourceUrl: annotation.sourceUrl, structuralArtifactId: structural.id, humanAnnotationId: human.id, primaryJourneyStage: labels.primaryJourneyStage, status: existing ? 'retained_existing' : 'passed' }))

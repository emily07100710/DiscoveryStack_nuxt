import { and, eq, isNull } from 'drizzle-orm'
import { getDatabase } from '../server/database/index.ts'
import { publicIntelligenceArtifacts, publicIntelligenceSources } from '../server/database/schema.ts'
import { createOwnerPublicArtifact, reviewOwnerPublicArtifact } from '../server/public-intelligence/repository.ts'
import { seoGeoMultilabelSchema } from '../server/public-intelligence/seoGeoTaxonomy.ts'

const annotation = {
  structuralArtifactId: 1200001,
  sourceUrl: 'https://developers.google.com/search/docs/crawling-indexing/indexable-file-types?hl=en',
  sourceLocator: 'human-review:batch-23:indexable-file-types',
  artifactText: 'Diagnose whether a text, document, image, or video asset is technically indexable by starting with the Content-Type HTTP header that Google receives. If the header is missing or incorrect, Google may use the extension or re-parse the resource, so remediation should verify delivery metadata before assuming a format is unsupported. Separate flat text formats, encoded document containers, and media formats when planning crawlable assets, and use the filetype operator only as a scoped discovery query for supported file types. Treat supported type lists as technical eligibility signals rather than a guarantee that a particular file will be indexed or surfaced.',
  qualityNote: '人工閱讀 File types indexable by Google：內容聚焦 Content-Type、extension fallback、re-parsing、flat／encoded／media format 類別與 filetype operator；摘要保留技術決策邊界，不將支援格式解釋為收錄保證，且不含 PII。',
  labels: {
    annotationKind: 'seo_geo_multilabel',
    annotationVersion: 'seo-geo-journey-v1',
    primaryJourneyStage: 'response',
    journeyStages: ['response', 'understanding', 'progression'],
    searchIntents: ['informational', 'navigational'],
    contentTypes: ['editorial', 'tool'],
    audienceRoles: ['practitioner', 'technical_evaluator'],
    topicClusters: ['indexable file types', 'Content-Type', 'crawlable documents', 'media indexing', 'filetype operator'],
    entitySignals: [
      { name: 'Content-Type HTTP header', type: 'concept', relationship: 'Primary delivery signal used to determine how Google interprets a crawled file.' },
      { name: 'Google Search', type: 'service', relationship: 'Indexes supported file content after crawling, without guaranteeing any individual asset will appear.' },
      { name: 'filetype operator', type: 'concept', relationship: 'Supports a scoped Search query for a chosen file type or extension.' },
    ],
    geoSignals: ['global', 'not_applicable'],
    citationReadiness: ['first_party_expertise', 'dated_or_current', 'source_links'],
    technicalSeoSignals: ['title_present', 'h1_present', 'canonical_present', 'indexable', 'internal_routing', 'performance_not_observed'],
    frictionSignals: ['unclear_value', 'missing_next_step', 'information_overload'],
    actionPriority: 'medium',
    annotationRationale: '本頁提供 file format、delivery metadata 與 crawlable asset 的診斷界線，適合把 technical indexability evidence 轉為 response 旅程中的檢查與修正優先序，不承諾支援格式必定被索引。',
    reviewerConfidence: 5,
  },
}

const database = getDatabase()
if (!database) throw new Error('database_unavailable')

const [source] = await database.select({ id: publicIntelligenceSources.id, ownerUserId: publicIntelligenceSources.ownerUserId, retentionUntil: publicIntelligenceSources.retentionUntil }).from(publicIntelligenceSources).where(and(
  eq(publicIntelligenceSources.sourceName, 'Google Search Central Documentation（CC BY 4.0）'),
  eq(publicIntelligenceSources.reviewStatus, 'approved'),
  eq(publicIntelligenceSources.allowedUse, 'training_candidate'),
  eq(publicIntelligenceSources.robotsStatus, 'reviewed_allow'),
  eq(publicIntelligenceSources.termsStatus, 'allows_training'),
  eq(publicIntelligenceSources.copyrightRisk, 'low'),
  eq(publicIntelligenceSources.piiStatus, 'none_detected'),
  isNull(publicIntelligenceSources.removedAt),
)).limit(1)

if (!source) throw new Error('approved_google_search_central_source_not_found')

const [structural] = await database.select({ id: publicIntelligenceArtifacts.id, sourceSpanHash: publicIntelligenceArtifacts.sourceSpanHash, qualityStatus: publicIntelligenceArtifacts.qualityStatus, piiStatus: publicIntelligenceArtifacts.piiStatus }).from(publicIntelligenceArtifacts).where(and(
  eq(publicIntelligenceArtifacts.id, annotation.structuralArtifactId),
  eq(publicIntelligenceArtifacts.sourceId, source.id),
  eq(publicIntelligenceArtifacts.artifactType, 'structural_features'),
  eq(publicIntelligenceArtifacts.sourceUrl, annotation.sourceUrl),
  isNull(publicIntelligenceArtifacts.removedAt),
)).limit(1)

if (!structural?.sourceSpanHash) throw new Error(`batch_23_structural_artifact_not_found:${annotation.structuralArtifactId}`)
if (structural.piiStatus !== 'none_detected') throw new Error(`batch_23_pii_not_clear:${annotation.structuralArtifactId}`)
if (structural.qualityStatus !== 'passed') await reviewOwnerPublicArtifact({ ownerUserId: source.ownerUserId, artifactId: structural.id, qualityStatus: 'passed', qualityNote: annotation.qualityNote })

const labels = seoGeoMultilabelSchema.parse(annotation.labels)
const [existing] = await database.select({ id: publicIntelligenceArtifacts.id, qualityStatus: publicIntelligenceArtifacts.qualityStatus }).from(publicIntelligenceArtifacts).where(and(
  eq(publicIntelligenceArtifacts.sourceId, source.id),
  eq(publicIntelligenceArtifacts.artifactType, 'human_annotation'),
  eq(publicIntelligenceArtifacts.sourceUrl, annotation.sourceUrl),
  isNull(publicIntelligenceArtifacts.removedAt),
)).limit(1)

const human = existing || await createOwnerPublicArtifact({
  ownerUserId: source.ownerUserId,
  sourceId: source.id,
  sourceUrl: annotation.sourceUrl,
  canonicalUrl: annotation.sourceUrl,
  artifactType: 'human_annotation',
  artifactText: annotation.artifactText,
  sourceLocator: annotation.sourceLocator,
  sourceSpanHash: structural.sourceSpanHash,
  fieldData: labels,
  language: 'en',
  extractionMethod: 'human_annotation',
  requestedUse: 'training_candidate',
  retentionUntil: source.retentionUntil,
})

if (human.qualityStatus !== 'passed') await reviewOwnerPublicArtifact({ ownerUserId: source.ownerUserId, artifactId: human.id, qualityStatus: 'passed', qualityNote: annotation.qualityNote })
console.log(JSON.stringify({ sourceUrl: annotation.sourceUrl, structuralArtifactId: structural.id, humanAnnotationId: human.id, primaryJourneyStage: labels.primaryJourneyStage, status: existing ? 'retained_existing' : 'passed' }))

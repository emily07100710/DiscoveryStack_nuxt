import { and, eq, isNull } from 'drizzle-orm'
import { getDatabase } from '../server/database/index.ts'
import { publicIntelligenceArtifacts, publicIntelligenceSources } from '../server/database/schema.ts'
import { createOwnerPublicArtifact, reviewOwnerPublicArtifact } from '../server/public-intelligence/repository.ts'
import { seoGeoMultilabelSchema } from '../server/public-intelligence/seoGeoTaxonomy.ts'

const annotation = {
  structuralArtifactId: 1140001,
  sourceUrl: 'https://developers.google.com/search/docs/appearance/google-images?hl=en',
  sourceLocator: 'human-review:batch-21:google-images-seo',
  artifactText: 'Make images discoverable across Google Images, Discover, and text-result image surfaces without treating visibility as guaranteed. Use standard image elements with an accessible src path instead of relying only on CSS images so Google can find the resource, and make responsive markup retain a usable src fallback. For a site using a separate image CDN, verify both domains when applying image sitemaps. Choose supported image formats, describe the image with useful adjacent content and alt text, and balance image quality with page performance. Align image landing-page metadata with page-level discovery signals: describe the representative image in structured data when applicable, and use an Open Graph image and relevant title or snippet guidance for sharing and result previews. Monitor appearance in Search Console and make images part of a people-first page rather than an isolated decorative asset.',
  qualityNote: '人工閱讀 Google Image SEO Best Practices：涵蓋 Google Images、Discover 與 text-result image surfaces；標準 img src、responsive src fallback、image sitemap／CDN verification、supported formats、周邊內容與 alt text、quality／performance、structured data、Open Graph image、title／snippet guidance 及 Search Console monitoring。去識別摘要與 reviewed source span 一致，未含 PII。',
  labels: {
    annotationKind: 'seo_geo_multilabel',
    annotationVersion: 'seo-geo-journey-v1',
    primaryJourneyStage: 'discovery',
    journeyStages: ['discovery', 'understanding', 'progression'],
    searchIntents: ['informational'],
    contentTypes: ['editorial', 'tool'],
    audienceRoles: ['practitioner', 'technical_evaluator', 'decision_maker'],
    topicClusters: ['Google Images SEO', 'image discoverability', 'image sitemap', 'responsive image markup', 'image metadata', 'image performance'],
    entitySignals: [
      { name: 'Google Images', type: 'service', relationship: 'Uses crawlable image resources and page context to surface images in discovery-oriented Search experiences.' },
      { name: 'Image sitemap', type: 'concept', relationship: 'Communicates image URLs and requires verified ownership when images are served from a separate CDN domain.' },
      { name: 'Open Graph image', type: 'concept', relationship: 'Provides a shareable representative image that can complement page-level preview metadata.' },
    ],
    geoSignals: ['global', 'not_applicable'],
    citationReadiness: ['first_party_expertise', 'dated_or_current', 'source_links', 'structured_data'],
    technicalSeoSignals: ['title_present', 'h1_present', 'canonical_present', 'indexable', 'structured_data', 'internal_routing', 'performance_not_observed'],
    frictionSignals: ['unclear_value', 'missing_next_step', 'information_overload'],
    actionPriority: 'medium',
    annotationRationale: '本頁以可爬取 image markup、image sitemap、頁面語意、preview metadata 與 performance trade-off 支持跨圖片搜尋與內容預覽的 discovery 改善；不把任一欄位或 sitemap 描述為曝光保證。',
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

if (!structural?.sourceSpanHash) throw new Error(`batch_21_structural_artifact_not_found:${annotation.structuralArtifactId}`)
if (structural.piiStatus !== 'none_detected') throw new Error(`batch_21_pii_not_clear:${annotation.structuralArtifactId}`)
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

import { and, eq, isNull } from 'drizzle-orm'
import { getDatabase } from '../server/database/index.ts'
import { publicIntelligenceArtifacts, publicIntelligenceSources } from '../server/database/schema.ts'
import { createOwnerPublicArtifact, reviewOwnerPublicArtifact } from '../server/public-intelligence/repository.ts'
import { seoGeoMultilabelSchema } from '../server/public-intelligence/seoGeoTaxonomy.ts'

const annotations = [
  {
    structuralArtifactId: 720001,
    sourceUrl: 'https://developers.google.com/search/docs/crawling-indexing/sitemaps/news-sitemap?hl=en',
    artifactText: 'Use a News sitemap to communicate recent article URLs and news-specific metadata to Google Search when fresh editorial content needs reliable discovery. Keep the file limited to URLs published in the most recent two days, remove older news tags instead of preserving stale history, and split files when the article-tag limit is reached. Supply an exact publication name, a supported language value, a standards-compliant publication time, and a title that matches the visible article headline. Validate XML and update the sitemap when stories change, then use Search Console and crawl/indexing evidence to diagnose discovery or eligibility issues. A News sitemap is a structured discovery signal, not a guarantee that every article will be indexed or displayed in a news surface.',
    sourceLocator: 'human-review:batch-14:news-sitemap',
    qualityNote: '人工閱讀官方文件：涵蓋 recent two-day news URL 範圍、freshness updates、empty sitemap warning、publication name/language、publication date、title accuracy、News sitemap split constraint 與 Search Console troubleshooting。摘要與 reviewed source span 一致，未含 PII。',
    labels: {
      annotationKind: 'seo_geo_multilabel', annotationVersion: 'seo-geo-journey-v1', primaryJourneyStage: 'response', journeyStages: ['discovery', 'response', 'progression'], searchIntents: ['informational'], contentTypes: ['editorial', 'tool'], audienceRoles: ['practitioner', 'technical_evaluator', 'decision_maker'], topicClusters: ['news sitemap', 'fresh content', 'article discovery', 'XML validation', 'publication metadata', 'Search Console'], entitySignals: [{ name: 'News sitemap', type: 'concept', relationship: 'Communicates recent news article URLs and publication metadata for crawler discovery.' }, { name: 'Google Search', type: 'service', relationship: 'May use valid sitemap and page signals to discover eligible article content.' }, { name: 'Search Console', type: 'service', relationship: 'Supplies diagnostic evidence for sitemap processing and search visibility issues.' }], geoSignals: ['global', 'multilingual'], citationReadiness: ['first_party_expertise', 'dated_or_current', 'source_links'], technicalSeoSignals: ['indexable', 'internal_routing', 'structured_data', 'performance_not_observed'], frictionSignals: ['missing_next_step', 'information_overload'], actionPriority: 'high', annotationRationale: '本頁將 freshness、publication metadata、XML constraints、diagnosis 與 non-guarantee 串成新聞內容的可驗證 discovery/response 流程，適合訓練多語內容營運情境。', reviewerConfidence: 5,
    },
  },
  {
    structuralArtifactId: 720002,
    sourceUrl: 'https://developers.google.com/search/docs/crawling-indexing/sitemaps/image-sitemaps?hl=en',
    artifactText: 'Use an Image sitemap extension to make important visual assets easier for Google Search to discover, especially when images are introduced through JavaScript or are hosted separately from the primary page. Add image locations to an existing sitemap or provide a separate image sitemap, and ensure each image URL is reachable to Googlebot with the applicable robots and host controls. When images are served from a CDN or another domain, verify that host in Search Console so the sitemap association is valid. Keep image entries focused on current discoverable assets, validate the XML, and investigate crawl or coverage signals rather than assuming that a submitted image will appear in Search. Deprecated image metadata fields should not be treated as current ranking or display requirements.',
    sourceLocator: 'human-review:batch-14:image-sitemap',
    qualityNote: '人工閱讀官方文件：涵蓋 JavaScript-discovered images、combined/separate sitemap、image location requirement、cross-domain/CDN Search Console verification、robots accessibility、deprecated image metadata fields 與 troubleshooting。摘要與 reviewed source span 一致，未含 PII。',
    labels: {
      annotationKind: 'seo_geo_multilabel', annotationVersion: 'seo-geo-journey-v1', primaryJourneyStage: 'discovery', journeyStages: ['discovery', 'progression', 'response'], searchIntents: ['informational', 'commercial'], contentTypes: ['editorial', 'tool'], audienceRoles: ['practitioner', 'technical_evaluator', 'decision_maker'], topicClusters: ['image sitemap', 'visual discovery', 'JavaScript images', 'CDN verification', 'robots accessibility', 'image indexing'], entitySignals: [{ name: 'Image sitemap', type: 'concept', relationship: 'Adds image locations to sitemap data for visual asset discovery.' }, { name: 'Googlebot', type: 'service', relationship: 'Requires access to image URLs under the applicable robots and host controls.' }, { name: 'Search Console', type: 'service', relationship: 'Verifies cross-domain image-host ownership and provides diagnostic evidence.' }], geoSignals: ['global', 'not_applicable'], citationReadiness: ['first_party_expertise', 'dated_or_current', 'source_links'], technicalSeoSignals: ['indexable', 'internal_routing', 'performance_not_observed'], frictionSignals: ['missing_trust_signal', 'missing_next_step'], actionPriority: 'medium', annotationRationale: '本頁將 image discovery、JavaScript/CDN topology、host verification、robots access 與 XML evidence 連結為內容可見度工作流，適合訓練 discovery-stage 的視覺資產 SEO 決策。', reviewerConfidence: 5,
    },
  },
]

const database = getDatabase()
if (!database) throw new Error('database_unavailable')

const [source] = await database
  .select({ id: publicIntelligenceSources.id, ownerUserId: publicIntelligenceSources.ownerUserId, retentionUntil: publicIntelligenceSources.retentionUntil })
  .from(publicIntelligenceSources)
  .where(and(
    eq(publicIntelligenceSources.sourceName, 'Google Search Central Documentation（CC BY 4.0）'),
    eq(publicIntelligenceSources.reviewStatus, 'approved'),
    eq(publicIntelligenceSources.allowedUse, 'training_candidate'),
    eq(publicIntelligenceSources.robotsStatus, 'reviewed_allow'),
    eq(publicIntelligenceSources.termsStatus, 'allows_training'),
    eq(publicIntelligenceSources.copyrightRisk, 'low'),
    eq(publicIntelligenceSources.piiStatus, 'none_detected'),
    isNull(publicIntelligenceSources.removedAt),
  ))
  .limit(1)

if (!source) throw new Error('approved_google_search_central_source_not_found')

for (const annotation of annotations) {
  const [structural] = await database
    .select({ id: publicIntelligenceArtifacts.id, sourceSpanHash: publicIntelligenceArtifacts.sourceSpanHash, qualityStatus: publicIntelligenceArtifacts.qualityStatus, piiStatus: publicIntelligenceArtifacts.piiStatus })
    .from(publicIntelligenceArtifacts)
    .where(and(
      eq(publicIntelligenceArtifacts.id, annotation.structuralArtifactId),
      eq(publicIntelligenceArtifacts.sourceId, source.id),
      eq(publicIntelligenceArtifacts.artifactType, 'structural_features'),
      eq(publicIntelligenceArtifacts.sourceUrl, annotation.sourceUrl),
      isNull(publicIntelligenceArtifacts.removedAt),
    ))
    .limit(1)

  if (!structural?.sourceSpanHash) throw new Error(`batch_14_structural_artifact_not_found:${annotation.structuralArtifactId}`)
  if (structural.piiStatus !== 'none_detected') throw new Error(`batch_14_pii_not_clear:${annotation.structuralArtifactId}`)
  if (structural.qualityStatus !== 'passed') {
    await reviewOwnerPublicArtifact({ ownerUserId: source.ownerUserId, artifactId: structural.id, qualityStatus: 'passed', qualityNote: annotation.qualityNote })
  }

  const labels = seoGeoMultilabelSchema.parse(annotation.labels)
  const [existing] = await database
    .select({ id: publicIntelligenceArtifacts.id, qualityStatus: publicIntelligenceArtifacts.qualityStatus })
    .from(publicIntelligenceArtifacts)
    .where(and(
      eq(publicIntelligenceArtifacts.sourceId, source.id),
      eq(publicIntelligenceArtifacts.artifactType, 'human_annotation'),
      eq(publicIntelligenceArtifacts.sourceUrl, annotation.sourceUrl),
      eq(publicIntelligenceArtifacts.sourceSpanHash, structural.sourceSpanHash),
      isNull(publicIntelligenceArtifacts.removedAt),
    ))
    .limit(1)

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

  if (human.qualityStatus !== 'passed') {
    await reviewOwnerPublicArtifact({ ownerUserId: source.ownerUserId, artifactId: human.id, qualityStatus: 'passed', qualityNote: annotation.qualityNote })
  }
  console.log(JSON.stringify({ sourceUrl: annotation.sourceUrl, structuralArtifactId: structural.id, humanAnnotationId: human.id, primaryJourneyStage: labels.primaryJourneyStage, status: 'passed' }))
}

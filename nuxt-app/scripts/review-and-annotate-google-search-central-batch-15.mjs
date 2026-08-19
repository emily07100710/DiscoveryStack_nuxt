import { and, eq, isNull } from 'drizzle-orm'
import { getDatabase } from '../server/database/index.ts'
import { publicIntelligenceArtifacts, publicIntelligenceSources } from '../server/database/schema.ts'
import { createOwnerPublicArtifact, reviewOwnerPublicArtifact } from '../server/public-intelligence/repository.ts'
import { seoGeoMultilabelSchema } from '../server/public-intelligence/seoGeoTaxonomy.ts'

const annotations = [
  {
    structuralArtifactId: 780001,
    sourceUrl: 'https://developers.google.com/search/docs/crawling-indexing',
    artifactText: 'Use the crawling and indexing topic map to decide which technical controls govern how Google Search finds, parses, indexes, or excludes a site’s content. The map connects file types, logical URL structure, sitemaps, crawler management, robots.txt, canonicalization, mobile and JavaScript behavior, metadata, removals, and site moves. Treat it as an implementation and diagnosis guide: select the control that matches the problem, validate crawler access and page signals, then inspect Search Console evidence rather than assuming a change guarantees crawling, indexing, ranking, or display. For foundational context, pair the technical topic with an understanding of how Search works.',
    sourceLocator: 'human-review:batch-15:crawling-indexing-overview',
    qualityNote: '人工閱讀官方文件：涵蓋 file types、URL structure、sitemaps、crawler management、robots.txt、canonicalization、mobile／JavaScript、metadata、removals 與 site moves 的 crawling/indexing topic map。摘要與 reviewed source span 一致，未含 PII。',
    labels: {
      annotationKind: 'seo_geo_multilabel', annotationVersion: 'seo-geo-journey-v1', primaryJourneyStage: 'discovery', journeyStages: ['discovery', 'understanding', 'progression'], searchIntents: ['informational', 'commercial'], contentTypes: ['editorial', 'tool'], audienceRoles: ['researcher', 'practitioner', 'technical_evaluator', 'decision_maker'], topicClusters: ['crawling and indexing overview', 'technical SEO controls', 'content discovery', 'canonicalization', 'sitemaps', 'crawler management'], entitySignals: [{ name: 'Google Search', type: 'service', relationship: 'Finds and parses site content through documented crawl and indexing controls.' }, { name: 'Search Console', type: 'service', relationship: 'Provides inspection and diagnostic evidence after implementation.' }, { name: 'Crawling and indexing', type: 'concept', relationship: 'Organizes technical decisions that affect content discovery and eligibility.' }], geoSignals: ['global', 'not_applicable'], citationReadiness: ['first_party_expertise', 'dated_or_current', 'source_links'], technicalSeoSignals: ['indexable', 'internal_routing', 'canonical_present', 'performance_not_observed'], frictionSignals: ['information_overload', 'missing_next_step'], actionPriority: 'medium', annotationRationale: '此官方 topic map 將 SEO/GEO content visibility 的多項技術控制與可驗證診斷流程整合，適合訓練 discovery 到 progression 的決策路徑。', reviewerConfidence: 5,
    },
  },
  {
    structuralArtifactId: 780002,
    sourceUrl: 'https://developers.google.com/search/docs/crawling-indexing/block-indexing?hl=en',
    artifactText: 'Use noindex in an HTML meta tag or an X-Robots-Tag HTTP response header when a page or non-HTML resource must be removed from Google Search indexing. Googlebot must be allowed to crawl the resource so it can see the rule; blocking the URL in robots.txt can prevent that and leave a linked URL visible. Choose the page-level mechanism that fits the content type, do not put noindex in robots.txt, and verify what Googlebot received with URL Inspection. Account for recrawl delay, use the Page Indexing report to monitor extraction, and choose a separate removal process only when fast temporary suppression is needed. Noindex controls indexing eligibility, not a guaranteed instantaneous outcome across all search engines.',
    sourceLocator: 'human-review:batch-15:block-indexing-noindex',
    qualityNote: '人工閱讀官方文件：涵蓋 noindex meta／X-Robots-Tag、robots.txt interaction、non-HTML resource、Googlebot access、URL Inspection、Page Indexing report、recrawl delay 與 removal boundary。摘要與 reviewed source span 一致，未含 PII。',
    labels: {
      annotationKind: 'seo_geo_multilabel', annotationVersion: 'seo-geo-journey-v1', primaryJourneyStage: 'response', journeyStages: ['response', 'progression'], searchIntents: ['informational'], contentTypes: ['tool', 'editorial'], audienceRoles: ['practitioner', 'technical_evaluator', 'decision_maker'], topicClusters: ['noindex', 'X-Robots-Tag', 'robots.txt interaction', 'indexing control', 'URL Inspection', 'Page Indexing report'], entitySignals: [{ name: 'noindex', type: 'concept', relationship: 'Controls indexing eligibility when it is visible to a crawler that supports the rule.' }, { name: 'Googlebot', type: 'service', relationship: 'Must access the resource to extract a meta or HTTP noindex rule.' }, { name: 'URL Inspection', type: 'service', relationship: 'Verifies the response and HTML received during crawling.' }], geoSignals: ['global', 'not_applicable'], citationReadiness: ['first_party_expertise', 'dated_or_current', 'source_links'], technicalSeoSignals: ['indexable', 'internal_routing', 'performance_not_observed'], frictionSignals: ['missing_next_step', 'information_overload'], actionPriority: 'high', annotationRationale: '本頁將 noindex 實作、robots conflict、crawler visibility、diagnosis、recrawl 與 temporary-removal boundary 編織為可驗證的 SEO incident response，適合訓練 response-stage 行動優先度。', reviewerConfidence: 5,
    },
  },
]

const database = getDatabase()
if (!database) throw new Error('database_unavailable')

const [source] = await database.select({ id: publicIntelligenceSources.id, ownerUserId: publicIntelligenceSources.ownerUserId, retentionUntil: publicIntelligenceSources.retentionUntil }).from(publicIntelligenceSources).where(and(eq(publicIntelligenceSources.sourceName, 'Google Search Central Documentation（CC BY 4.0）'), eq(publicIntelligenceSources.reviewStatus, 'approved'), eq(publicIntelligenceSources.allowedUse, 'training_candidate'), eq(publicIntelligenceSources.robotsStatus, 'reviewed_allow'), eq(publicIntelligenceSources.termsStatus, 'allows_training'), eq(publicIntelligenceSources.copyrightRisk, 'low'), eq(publicIntelligenceSources.piiStatus, 'none_detected'), isNull(publicIntelligenceSources.removedAt))).limit(1)
if (!source) throw new Error('approved_google_search_central_source_not_found')

for (const annotation of annotations) {
  const [structural] = await database.select({ id: publicIntelligenceArtifacts.id, sourceSpanHash: publicIntelligenceArtifacts.sourceSpanHash, qualityStatus: publicIntelligenceArtifacts.qualityStatus, piiStatus: publicIntelligenceArtifacts.piiStatus }).from(publicIntelligenceArtifacts).where(and(eq(publicIntelligenceArtifacts.id, annotation.structuralArtifactId), eq(publicIntelligenceArtifacts.sourceId, source.id), eq(publicIntelligenceArtifacts.artifactType, 'structural_features'), eq(publicIntelligenceArtifacts.sourceUrl, annotation.sourceUrl), isNull(publicIntelligenceArtifacts.removedAt))).limit(1)
  if (!structural?.sourceSpanHash) throw new Error(`batch_15_structural_artifact_not_found:${annotation.structuralArtifactId}`)
  if (structural.piiStatus !== 'none_detected') throw new Error(`batch_15_pii_not_clear:${annotation.structuralArtifactId}`)
  if (structural.qualityStatus !== 'passed') await reviewOwnerPublicArtifact({ ownerUserId: source.ownerUserId, artifactId: structural.id, qualityStatus: 'passed', qualityNote: annotation.qualityNote })
  const labels = seoGeoMultilabelSchema.parse(annotation.labels)
  const [existing] = await database.select({ id: publicIntelligenceArtifacts.id, qualityStatus: publicIntelligenceArtifacts.qualityStatus }).from(publicIntelligenceArtifacts).where(and(eq(publicIntelligenceArtifacts.sourceId, source.id), eq(publicIntelligenceArtifacts.artifactType, 'human_annotation'), eq(publicIntelligenceArtifacts.sourceUrl, annotation.sourceUrl), eq(publicIntelligenceArtifacts.sourceSpanHash, structural.sourceSpanHash), isNull(publicIntelligenceArtifacts.removedAt))).limit(1)
  const human = existing || await createOwnerPublicArtifact({ ownerUserId: source.ownerUserId, sourceId: source.id, sourceUrl: annotation.sourceUrl, canonicalUrl: annotation.sourceUrl, artifactType: 'human_annotation', artifactText: annotation.artifactText, sourceLocator: annotation.sourceLocator, sourceSpanHash: structural.sourceSpanHash, fieldData: labels, language: 'en', extractionMethod: 'human_annotation', requestedUse: 'training_candidate', retentionUntil: source.retentionUntil })
  if (human.qualityStatus !== 'passed') await reviewOwnerPublicArtifact({ ownerUserId: source.ownerUserId, artifactId: human.id, qualityStatus: 'passed', qualityNote: annotation.qualityNote })
  console.log(JSON.stringify({ sourceUrl: annotation.sourceUrl, structuralArtifactId: structural.id, humanAnnotationId: human.id, primaryJourneyStage: labels.primaryJourneyStage, status: 'passed' }))
}

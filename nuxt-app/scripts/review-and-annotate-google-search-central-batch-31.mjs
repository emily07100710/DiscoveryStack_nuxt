import { and, eq, isNull } from 'drizzle-orm'
import { getDatabase } from '../server/database/index.ts'
import { publicIntelligenceArtifacts, publicIntelligenceSources } from '../server/database/schema.ts'
import { createOwnerPublicArtifact, reviewOwnerPublicArtifact } from '../server/public-intelligence/repository.ts'
import { seoGeoMultilabelSchema } from '../server/public-intelligence/seoGeoTaxonomy.ts'

const annotations = [
  {
    structuralArtifactId: 1620001,
    sourceUrl: 'https://developers.google.com/search/docs/crawling-indexing/sitemaps/large-sitemaps?hl=en',
    sourceLocator: 'human-review:batch-31:large-sitemaps',
    artifactText: 'When a sitemap exceeds documented limits, split it into smaller sitemap files and use a sitemap index to submit the collection. Keep referenced sitemaps on the same site and within the permitted directory hierarchy unless cross-site submission is configured. Treat sitemap index metadata such as last modification time as a crawl-scheduling signal, and use Search Console troubleshooting when implementation errors arise. A sitemap helps communicate page inventory and metadata, but it does not guarantee crawling, indexing, ranking, or a particular search appearance.',
    qualityNote: '人工閱讀 Large sitemaps：摘要保留 split strategy、sitemap index、same-site/directory constraints、lastmod 與 troubleshooting，並保留 sitemap 不保證爬取、收錄、排名或顯示的邊界；未含 PII。',
    labels: {
      annotationKind: 'seo_geo_multilabel', annotationVersion: 'seo-geo-journey-v1', primaryJourneyStage: 'progression',
      journeyStages: ['progression', 'response', 'understanding'], searchIntents: ['informational', 'commercial'], contentTypes: ['tool', 'editorial'], audienceRoles: ['practitioner', 'technical_evaluator', 'decision_maker'],
      topicClusters: ['sitemap index', 'large sitemap management', 'crawl scheduling', 'site hierarchy', 'Search Console troubleshooting'],
      entitySignals: [
        { name: 'Sitemap index', type: 'concept', relationship: 'Lists multiple sitemap files so a site can manage a page inventory that exceeds one file limit.' },
        { name: 'Sitemap', type: 'concept', relationship: 'Communicates page and metadata inventory without guaranteeing crawling, indexing, ranking, or display.' },
        { name: 'Google Search Console', type: 'service', relationship: 'Provides a submission and troubleshooting context for sitemap implementation.' },
      ],
      geoSignals: ['global', 'not_applicable'], citationReadiness: ['first_party_expertise', 'dated_or_current', 'source_links', 'structured_data'], technicalSeoSignals: ['title_present', 'h1_present', 'canonical_present', 'indexable', 'structured_data', 'internal_routing', 'performance_not_observed'], frictionSignals: ['information_overload', 'missing_next_step', 'unclear_value'], actionPriority: 'medium',
      annotationRationale: '本頁將 sitemap index 的檔案治理、site hierarchy 與 troubleshooting 映射為 progression-stage 的可執行技術維護訊號，同時保留 sitemap 對搜尋結果沒有保證的界線。', reviewerConfidence: 5,
    },
  },
  {
    structuralArtifactId: 1620002,
    sourceUrl: 'https://developers.google.com/search/docs/crawling-indexing/canonicalization?hl=en',
    sourceLocator: 'human-review:batch-31:canonicalization',
    artifactText: 'Canonicalization selects a representative URL from duplicate or very similar pages so search systems can generally show one version. Duplicate URLs can arise from region, device, protocol, filtering, sorting, or accidental site variants. Signals such as HTTPS, redirects, sitemap inclusion, and rel canonical can express a preference, but the search system may choose a different canonical because the preference is a hint rather than a rule. Keep duplicate-page management focused on clear user experience, crawl efficiency, and content-quality evaluation instead of treating a canonical annotation as a guaranteed search outcome.',
    qualityNote: '人工閱讀 Canonicalization：摘要保留 representative URL、duplicate causes、HTTPS/redirect/sitemap/rel canonical signals、hint-not-rule 與 user experience/crawl efficiency，未含 PII，且不把 canonical 表述為保證。',
    labels: {
      annotationKind: 'seo_geo_multilabel', annotationVersion: 'seo-geo-journey-v1', primaryJourneyStage: 'response',
      journeyStages: ['response', 'progression', 'understanding'], searchIntents: ['informational', 'commercial'], contentTypes: ['editorial', 'tool'], audienceRoles: ['practitioner', 'technical_evaluator', 'decision_maker', 'researcher'],
      topicClusters: ['URL canonicalization', 'duplicate content', 'representative URL', 'canonical hints', 'crawl efficiency'],
      entitySignals: [
        { name: 'Canonical URL', type: 'concept', relationship: 'Is the representative URL selected from duplicate or very similar content pages.' },
        { name: 'rel canonical', type: 'concept', relationship: 'Expresses a canonical preference that search systems may treat as a hint rather than a rule.' },
        { name: 'Google Search', type: 'service', relationship: 'Clusters duplicate pages and can choose a different canonical based on collected signals and search-user usefulness.' },
      ],
      geoSignals: ['global', 'multilingual', 'not_applicable'], citationReadiness: ['first_party_expertise', 'dated_or_current', 'source_links', 'structured_data'], technicalSeoSignals: ['title_present', 'h1_present', 'canonical_present', 'indexable', 'structured_data', 'internal_routing', 'language_signal', 'performance_not_observed'], frictionSignals: ['unclear_value', 'information_overload', 'missing_next_step'], actionPriority: 'high',
      annotationRationale: '本頁提供 duplicate URL 的成因、canonical preference 的非決定性與使用者體驗／crawl efficiency 影響，適合作為 response-stage 的技術診斷與修正依據。', reviewerConfidence: 5,
    },
  },
]

const database = getDatabase()
if (!database) throw new Error('database_unavailable')

const [source] = await database.select({ id: publicIntelligenceSources.id, ownerUserId: publicIntelligenceSources.ownerUserId, retentionUntil: publicIntelligenceSources.retentionUntil }).from(publicIntelligenceSources).where(and(
  eq(publicIntelligenceSources.sourceName, 'Google Search Central Documentation（CC BY 4.0）'), eq(publicIntelligenceSources.reviewStatus, 'approved'), eq(publicIntelligenceSources.allowedUse, 'training_candidate'), eq(publicIntelligenceSources.robotsStatus, 'reviewed_allow'), eq(publicIntelligenceSources.termsStatus, 'allows_training'), eq(publicIntelligenceSources.copyrightRisk, 'low'), eq(publicIntelligenceSources.piiStatus, 'none_detected'), isNull(publicIntelligenceSources.removedAt),
)).limit(1)
if (!source) throw new Error('approved_google_search_central_source_not_found')

for (const annotation of annotations) {
  const [structural] = await database.select({ id: publicIntelligenceArtifacts.id, sourceSpanHash: publicIntelligenceArtifacts.sourceSpanHash, qualityStatus: publicIntelligenceArtifacts.qualityStatus, piiStatus: publicIntelligenceArtifacts.piiStatus }).from(publicIntelligenceArtifacts).where(and(
    eq(publicIntelligenceArtifacts.id, annotation.structuralArtifactId), eq(publicIntelligenceArtifacts.sourceId, source.id), eq(publicIntelligenceArtifacts.artifactType, 'structural_features'), eq(publicIntelligenceArtifacts.sourceUrl, annotation.sourceUrl), isNull(publicIntelligenceArtifacts.removedAt),
  )).limit(1)
  if (!structural?.sourceSpanHash) throw new Error(`batch_31_structural_artifact_not_found:${annotation.structuralArtifactId}`)
  if (structural.piiStatus !== 'none_detected') throw new Error(`batch_31_pii_not_clear:${annotation.structuralArtifactId}`)
  if (structural.qualityStatus !== 'passed') await reviewOwnerPublicArtifact({ ownerUserId: source.ownerUserId, artifactId: structural.id, qualityStatus: 'passed', qualityNote: annotation.qualityNote })

  const labels = seoGeoMultilabelSchema.parse(annotation.labels)
  const [existing] = await database.select({ id: publicIntelligenceArtifacts.id, qualityStatus: publicIntelligenceArtifacts.qualityStatus }).from(publicIntelligenceArtifacts).where(and(
    eq(publicIntelligenceArtifacts.sourceId, source.id), eq(publicIntelligenceArtifacts.artifactType, 'human_annotation'), eq(publicIntelligenceArtifacts.sourceUrl, annotation.sourceUrl), isNull(publicIntelligenceArtifacts.removedAt),
  )).limit(1)
  const human = existing || await createOwnerPublicArtifact({ ownerUserId: source.ownerUserId, sourceId: source.id, sourceUrl: annotation.sourceUrl, canonicalUrl: annotation.sourceUrl, artifactType: 'human_annotation', artifactText: annotation.artifactText, sourceLocator: annotation.sourceLocator, sourceSpanHash: structural.sourceSpanHash, fieldData: labels, language: 'en', extractionMethod: 'human_annotation', requestedUse: 'training_candidate', retentionUntil: source.retentionUntil })
  if (human.qualityStatus !== 'passed') await reviewOwnerPublicArtifact({ ownerUserId: source.ownerUserId, artifactId: human.id, qualityStatus: 'passed', qualityNote: annotation.qualityNote })
  console.log(JSON.stringify({ sourceUrl: annotation.sourceUrl, structuralArtifactId: structural.id, humanAnnotationId: human.id, primaryJourneyStage: labels.primaryJourneyStage, status: existing ? 'retained_existing' : 'passed' }))
}

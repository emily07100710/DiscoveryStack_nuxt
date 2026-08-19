import { and, eq, inArray, isNull } from 'drizzle-orm'
import { getDatabase } from '../server/database/index.ts'
import { publicIntelligenceArtifacts, publicIntelligenceSources } from '../server/database/schema.ts'
import { createOwnerPublicArtifact, reviewOwnerPublicArtifact } from '../server/public-intelligence/repository.ts'
import { seoGeoMultilabelSchema } from '../server/public-intelligence/seoGeoTaxonomy.ts'

const annotations = [
  {
    sourceUrl: 'https://developers.google.com/search/docs/appearance/structured-data/search-gallery?hl=en',
    artifactText: 'Google Search supports structured data features for page contexts including ecommerce, organizations, sports, jobs, entertainment, news, food, education, and science. Supported rich-result types include Article, Breadcrumb, Event, Job posting, Local business, Organization, Product, Q&A, Recipe, Video, and others. Use the implementation guide for a feature and the Rich Results Test to preview most features, while recognizing that the actual Search appearance can differ.',
    sourceLocator: 'human-review:batch-07:structured-data-search-gallery',
    qualityNote: '人工閱讀官方文件：列出 Google 支援的 structured-data feature、產業與頁面情境、rich-result eligibility、implementation guide 與 Rich Results Test preview，且明示實際 Search appearance 可能不同；資料與 reviewed source span 一致，未含 PII。',
    labels: {
      annotationKind: 'seo_geo_multilabel', annotationVersion: 'seo-geo-journey-v1', primaryJourneyStage: 'discovery', journeyStages: ['discovery', 'understanding', 'progression', 'conversion'], searchIntents: ['informational', 'commercial', 'transactional'], contentTypes: ['product', 'service', 'editorial'], audienceRoles: ['buyer', 'researcher', 'decision_maker', 'practitioner', 'technical_evaluator'], topicClusters: ['structured data features', 'rich results', 'Search appearance', 'ecommerce SEO', 'local business SEO', 'Rich Results Test'], entitySignals: [{ name: 'Google Search', type: 'organisation', relationship: 'May present eligible structured page information using supported rich-result features.' }, { name: 'Rich Results Test', type: 'service', relationship: 'Lets implementers validate markup and preview most supported Search features.' }, { name: 'Structured data', type: 'concept', relationship: 'Machine-readable content information that can make a page eligible for richer Search appearances.' }], geoSignals: ['global', 'city_or_local'], citationReadiness: ['named_author_or_owner', 'first_party_expertise', 'dated_or_current', 'source_links', 'structured_data'], technicalSeoSignals: ['title_present', 'h1_present', 'indexable', 'structured_data', 'internal_routing', 'language_signal'], frictionSignals: ['information_overload'], actionPriority: 'high', annotationRationale: '本頁以一份具產業與網頁情境的 feature catalogue 連結 rich-result discovery、商業搜尋意圖、implementation path 與 preview limitation，適合訓練 discovery-stage 的 SEO/GEO 機會探索與優先級分類。', reviewerConfidence: 5,
    },
  },
  {
    sourceUrl: 'https://developers.google.com/search/docs/appearance/structured-data/breadcrumb?hl=en',
    artifactText: 'Breadcrumb markup indicates a page’s position in a site hierarchy and can help users understand and explore the site in Search. Implement required properties, validate with the Rich Results Test, deploy accessible pages that are not blocked by robots.txt, noindex, or login requirements, verify with URL Inspection, allow time for recrawl, submit a sitemap for future changes, and monitor rich-result status after deployments or template changes.',
    sourceLocator: 'human-review:batch-07:breadcrumb-structured-data',
    qualityNote: '人工閱讀官方文件：涵蓋 hierarchy navigation、multiple trails、required markup、Rich Results Test、crawl/index accessibility、URL Inspection、recrawl、sitemap、Search Console monitoring 與 troubleshooting；資料與 reviewed source span 一致，未含 PII。',
    labels: {
      annotationKind: 'seo_geo_multilabel', annotationVersion: 'seo-geo-journey-v1', primaryJourneyStage: 'progression', journeyStages: ['understanding', 'response', 'progression', 'conversion'], searchIntents: ['informational', 'commercial'], contentTypes: ['service', 'editorial', 'tool'], audienceRoles: ['buyer', 'decision_maker', 'practitioner', 'technical_evaluator'], topicClusters: ['BreadcrumbList', 'site hierarchy', 'structured data validation', 'Rich Results Test', 'URL Inspection', 'rich result monitoring'], entitySignals: [{ name: 'BreadcrumbList', type: 'concept', relationship: 'Structured representation of a page’s navigational hierarchy.' }, { name: 'Rich Results Test', type: 'service', relationship: 'Validates structured data before deployment.' }, { name: 'URL Inspection', type: 'service', relationship: 'Verifies how Google accesses a deployed page.' }], geoSignals: ['global', 'multilingual'], citationReadiness: ['named_author_or_owner', 'first_party_expertise', 'dated_or_current', 'source_links', 'structured_data'], technicalSeoSignals: ['title_present', 'h1_present', 'indexable', 'structured_data', 'internal_routing', 'language_signal'], frictionSignals: ['missing_next_step'], actionPriority: 'high', annotationRationale: '本頁將導覽資訊架構、schema 實作、crawl/index accessibility、部署驗證、sitemap 與 release monitoring 組成可執行流程，適合訓練 progression-stage 的技術 SEO 與搜尋導覽效益判斷。', reviewerConfidence: 5,
    },
  },
]

const database = getDatabase()
if (!database) throw new Error('database_unavailable')
const [source] = await database.select({ id: publicIntelligenceSources.id, ownerUserId: publicIntelligenceSources.ownerUserId, retentionUntil: publicIntelligenceSources.retentionUntil }).from(publicIntelligenceSources).where(and(
  eq(publicIntelligenceSources.sourceName, 'Google Search Central Documentation（CC BY 4.0）'), eq(publicIntelligenceSources.reviewStatus, 'approved'), eq(publicIntelligenceSources.allowedUse, 'training_candidate'), eq(publicIntelligenceSources.robotsStatus, 'reviewed_allow'), eq(publicIntelligenceSources.termsStatus, 'allows_training'), eq(publicIntelligenceSources.copyrightRisk, 'low'), eq(publicIntelligenceSources.piiStatus, 'none_detected'), isNull(publicIntelligenceSources.removedAt),
)).limit(1)
if (!source) throw new Error('approved_google_search_central_source_not_found')

const urls = annotations.map(({ sourceUrl }) => sourceUrl)
const structuralRows = await database.select({ id: publicIntelligenceArtifacts.id, sourceUrl: publicIntelligenceArtifacts.sourceUrl, sourceSpanHash: publicIntelligenceArtifacts.sourceSpanHash, qualityStatus: publicIntelligenceArtifacts.qualityStatus, piiStatus: publicIntelligenceArtifacts.piiStatus }).from(publicIntelligenceArtifacts).where(and(eq(publicIntelligenceArtifacts.sourceId, source.id), eq(publicIntelligenceArtifacts.artifactType, 'structural_features'), inArray(publicIntelligenceArtifacts.sourceUrl, urls), isNull(publicIntelligenceArtifacts.removedAt)))
if (structuralRows.length !== annotations.length) throw new Error(`expected_${annotations.length}_structural_artifacts_found_${structuralRows.length}`)

for (const annotation of annotations) {
  const structural = structuralRows.find(row => row.sourceUrl === annotation.sourceUrl)
  if (!structural?.sourceSpanHash) throw new Error(`structural_span_missing:${annotation.sourceUrl}`)
  if (structural.piiStatus !== 'none_detected') throw new Error(`structural_pii_not_clear:${annotation.sourceUrl}`)
  if (structural.qualityStatus !== 'passed') await reviewOwnerPublicArtifact({ ownerUserId: source.ownerUserId, artifactId: structural.id, qualityStatus: 'passed', qualityNote: annotation.qualityNote })
  const labels = seoGeoMultilabelSchema.parse(annotation.labels)
  const [existing] = await database.select({ id: publicIntelligenceArtifacts.id, qualityStatus: publicIntelligenceArtifacts.qualityStatus }).from(publicIntelligenceArtifacts).where(and(eq(publicIntelligenceArtifacts.sourceId, source.id), eq(publicIntelligenceArtifacts.artifactType, 'human_annotation'), eq(publicIntelligenceArtifacts.sourceUrl, annotation.sourceUrl), eq(publicIntelligenceArtifacts.sourceSpanHash, structural.sourceSpanHash), isNull(publicIntelligenceArtifacts.removedAt))).limit(1)
  const human = existing || await createOwnerPublicArtifact({ ownerUserId: source.ownerUserId, sourceId: source.id, sourceUrl: annotation.sourceUrl, canonicalUrl: annotation.sourceUrl, artifactType: 'human_annotation', artifactText: annotation.artifactText, sourceLocator: annotation.sourceLocator, sourceSpanHash: structural.sourceSpanHash, fieldData: labels, language: 'en', extractionMethod: 'human_annotation', requestedUse: 'training_candidate', retentionUntil: source.retentionUntil })
  if (human.qualityStatus !== 'passed') await reviewOwnerPublicArtifact({ ownerUserId: source.ownerUserId, artifactId: human.id, qualityStatus: 'passed', qualityNote: annotation.qualityNote })
  console.log(JSON.stringify({ sourceUrl: annotation.sourceUrl, structuralArtifactId: structural.id, humanAnnotationId: human.id, primaryJourneyStage: labels.primaryJourneyStage, status: 'passed' }))
}

import { and, eq, isNull } from 'drizzle-orm'
import { getDatabase } from '../server/database/index.ts'
import { publicIntelligenceArtifacts, publicIntelligenceSources } from '../server/database/schema.ts'
import { createOwnerPublicArtifact, reviewOwnerPublicArtifact } from '../server/public-intelligence/repository.ts'
import { seoGeoMultilabelSchema } from '../server/public-intelligence/seoGeoTaxonomy.ts'

const annotations = [
  {
    structuralArtifactId: 1740001,
    sourceUrl: 'https://developers.google.com/search/docs/appearance/structured-data/recipe?hl=en',
    sourceLocator: 'human-review:batch-33:recipe-structured-data',
    artifactText: 'Recipe structured data can help describe an eligible public recipe page for Google Search and Google Images. Keep recipe markup aligned with the visible recipe, use ItemList on a genuine collection summary when appropriate, validate the implementation, confirm crawl access through URL Inspection, and maintain discovery signals through sitemaps. Markup indicates eligibility for search enhancements, not a guarantee of crawling, indexing, ranking, or a particular displayed result, so the public recipe content must remain useful without rich-result treatment.',
    qualityNote: '人工閱讀 Recipe structured data：摘要保留 visible-content alignment、Recipe/ItemList、image crawlability、validation、URL Inspection、sitemap 維護與 rich-result non-guarantee；未含 PII。',
    labels: {
      annotationKind: 'seo_geo_multilabel', annotationVersion: 'seo-geo-journey-v1', primaryJourneyStage: 'conversion',
      journeyStages: ['conversion', 'discovery', 'understanding'], searchIntents: ['informational', 'commercial'], contentTypes: ['product', 'editorial', 'service'], audienceRoles: ['buyer', 'researcher', 'practitioner', 'technical_evaluator'],
      topicClusters: ['recipe structured data', 'ItemList', 'recipe discovery', 'rich result eligibility', 'image crawlability'],
      entitySignals: [
        { name: 'Recipe markup', type: 'concept', relationship: 'Describes visible public recipe content for eligible search enhancements.' },
        { name: 'ItemList', type: 'concept', relationship: 'Summarizes a genuine collection page that can point people to detailed recipe pages.' },
        { name: 'URL Inspection', type: 'service', relationship: 'Helps verify that Google can access a deployed public recipe page.' },
      ],
      geoSignals: ['global', 'not_applicable'], citationReadiness: ['first_party_expertise', 'dated_or_current', 'source_links', 'structured_data'], technicalSeoSignals: ['title_present', 'h1_present', 'canonical_present', 'indexable', 'structured_data', 'internal_routing', 'performance_not_observed'], frictionSignals: ['missing_trust_signal', 'missing_next_step', 'information_overload'], actionPriority: 'medium',
      annotationRationale: '本頁把可驗證的 recipe markup、collection routing、crawl access 與內容一致性連結至 discovery 至 conversion 的使用者旅程，並保留搜尋外觀非保證界線。', reviewerConfidence: 5,
    },
  },
  {
    structuralArtifactId: 1740002,
    sourceUrl: 'https://developers.google.com/search/docs/appearance/structured-data/software-app?hl=en',
    sourceLocator: 'human-review:batch-33:software-application-structured-data',
    artifactText: 'SoftwareApplication structured data can describe app details on a public app page, including the app name, offers, price, currency, rating or review, category, and operating system. Add accurate visible information, validate markup, remedy policy or manual-action issues, and use Search Console context to investigate implementation problems. Structured data supports eligibility for a richer result but does not guarantee crawling, indexing, ranking, or a displayed search feature; keep the app page accurate and useful for people independently of markup.',
    qualityNote: '人工閱讀 SoftwareApplication structured data：摘要保留 app detail、price/currency、rating/review、category/OS、validation、manual-action remediation 與 rich-result non-guarantee；未含 PII。',
    labels: {
      annotationKind: 'seo_geo_multilabel', annotationVersion: 'seo-geo-journey-v1', primaryJourneyStage: 'conversion',
      journeyStages: ['conversion', 'discovery', 'response'], searchIntents: ['informational', 'commercial'], contentTypes: ['product', 'service', 'editorial'], audienceRoles: ['buyer', 'decision_maker', 'practitioner', 'technical_evaluator'],
      topicClusters: ['software application structured data', 'app offers', 'price currency', 'app review', 'rich result eligibility'],
      entitySignals: [
        { name: 'SoftwareApplication', type: 'product', relationship: 'Represents a public software app whose details can be described with structured data.' },
        { name: 'Rich Results Test', type: 'service', relationship: 'Validates structured data implementation before public deployment.' },
        { name: 'Manual action', type: 'concept', relationship: 'Signals that non-compliant markup may be ignored even if syntax appears valid.' },
      ],
      geoSignals: ['global', 'not_applicable'], citationReadiness: ['first_party_expertise', 'source_links', 'structured_data', 'insufficient_evidence'], technicalSeoSignals: ['title_present', 'h1_present', 'canonical_present', 'indexable', 'structured_data', 'internal_routing', 'performance_not_observed'], frictionSignals: ['missing_trust_signal', 'unclear_value', 'missing_next_step'], actionPriority: 'medium',
      annotationRationale: '本頁提供 app information、validation 與 compliance remediation 的可審核訊號，可訓練產品頁在 discovery、response 與 conversion 的技術與內容邊界。', reviewerConfidence: 5,
    },
  },
  {
    structuralArtifactId: 1740003,
    sourceUrl: 'https://developers.google.com/search/docs/appearance/structured-data/carousel?hl=en',
    sourceLocator: 'human-review:batch-33:carousel-itemlist-structured-data',
    artifactText: 'Carousel structured data supports an eligible mobile host carousel for cards from the same site when ItemList is combined with a supported content type such as Course, Movie, Recipe, or Restaurant. A site can model the collection as a summary page with detail pages or an all-in-one page, then validate markup, verify crawl accessibility through URL Inspection, allow time for recrawling, and maintain sitemaps. Markup cannot control unrelated multi-site carousel features and does not guarantee a particular search result display.',
    qualityNote: '人工閱讀 Carousel ItemList structured data：摘要保留 same-site host carousel、supported content types、summary/detail vs all-in-one、validation、crawl access、sitemap 與 non-guarantee；未含 PII。',
    labels: {
      annotationKind: 'seo_geo_multilabel', annotationVersion: 'seo-geo-journey-v1', primaryJourneyStage: 'discovery',
      journeyStages: ['discovery', 'understanding', 'conversion'], searchIntents: ['informational', 'commercial'], contentTypes: ['editorial', 'product', 'service'], audienceRoles: ['researcher', 'buyer', 'practitioner', 'technical_evaluator'],
      topicClusters: ['host carousel', 'ItemList', 'collection architecture', 'detail pages', 'mobile search appearance'],
      entitySignals: [
        { name: 'Host carousel', type: 'concept', relationship: 'Is an eligible same-site interactive search appearance built from supported content types.' },
        { name: 'ItemList', type: 'concept', relationship: 'Organizes a public collection so list items can point to detailed content pages.' },
        { name: 'Sitemap', type: 'concept', relationship: 'Helps communicate future changes after public content and structured data are deployed.' },
      ],
      geoSignals: ['global', 'not_applicable'], citationReadiness: ['first_party_expertise', 'dated_or_current', 'source_links', 'structured_data'], technicalSeoSignals: ['title_present', 'h1_present', 'canonical_present', 'indexable', 'structured_data', 'internal_routing', 'performance_not_observed'], frictionSignals: ['information_overload', 'missing_next_step', 'unclear_value'], actionPriority: 'medium',
      annotationRationale: '本頁將 information architecture、same-site collection routing、mobile search appearance 與 structured-data validation 連結成可審核的 discovery-stage SEO/GEO 樣本。', reviewerConfidence: 5,
    },
  },
  {
    structuralArtifactId: 1740004,
    sourceUrl: 'https://developers.google.com/search/docs/crawling-indexing/canonicalization-troubleshooting?hl=en',
    sourceLocator: 'human-review:batch-33:canonicalization-troubleshooting',
    artifactText: 'Canonicalization troubleshooting starts by comparing Google-selected and preferred canonical URLs through URL Inspection and considering what is useful for people arriving from Search. Content differences can take time to re-evaluate, and request indexing is quota-limited. Diagnose localized variants with hreflang, incorrect canonical or redirect signals, server misconfiguration, soft 404 responses, compromised-page injections, syndication, and copycat content. A stated canonical is a preference rather than a guarantee, so remediation should combine accurate public content, correct technical signals, and appropriate ownership or removal actions.',
    qualityNote: '人工閱讀 Fix canonicalization issues：摘要保留 URL Inspection、content difference、re-evaluation delay、quota、hreflang、canonical/redirect/server/soft-404/hacked/syndication/copycat diagnoses 與 preference non-guarantee；未含 PII。',
    labels: {
      annotationKind: 'seo_geo_multilabel', annotationVersion: 'seo-geo-journey-v1', primaryJourneyStage: 'response',
      journeyStages: ['response', 'progression', 'understanding'], searchIntents: ['informational', 'navigational'], contentTypes: ['editorial', 'service', 'product'], audienceRoles: ['practitioner', 'technical_evaluator', 'decision_maker', 'researcher'],
      topicClusters: ['canonical troubleshooting', 'URL Inspection', 'hreflang', 'duplicate cluster', 'server misconfiguration'],
      entitySignals: [
        { name: 'Canonical URL', type: 'concept', relationship: 'Represents a preferred URL signal that Google may evaluate differently based on page quality and clustering.' },
        { name: 'URL Inspection', type: 'service', relationship: 'Supports checking Google-selected canonical context before remediation.' },
        { name: 'hreflang', type: 'concept', relationship: 'Helps distinguish substantially similar localized variants for different regional users.' },
      ],
      geoSignals: ['global', 'country', 'multilingual'], citationReadiness: ['first_party_expertise', 'dated_or_current', 'source_links', 'structured_data'], technicalSeoSignals: ['title_present', 'h1_present', 'canonical_present', 'indexable', 'internal_routing', 'language_signal', 'performance_not_observed'], frictionSignals: ['information_overload', 'missing_trust_signal', 'missing_next_step'], actionPriority: 'high',
      annotationRationale: '本頁提供 canonical response 的診斷順序、localized context、technical remediation 與非決定性邊界，適合訓練發現後的技術修復優先度。', reviewerConfidence: 5,
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
  if (!structural?.sourceSpanHash) throw new Error(`batch_33_structural_artifact_not_found:${annotation.structuralArtifactId}`)
  if (structural.piiStatus !== 'none_detected') throw new Error(`batch_33_pii_not_clear:${annotation.structuralArtifactId}`)
  if (structural.qualityStatus !== 'passed') await reviewOwnerPublicArtifact({ ownerUserId: source.ownerUserId, artifactId: structural.id, qualityStatus: 'passed', qualityNote: annotation.qualityNote })

  const labels = seoGeoMultilabelSchema.parse(annotation.labels)
  const [existing] = await database.select({ id: publicIntelligenceArtifacts.id, qualityStatus: publicIntelligenceArtifacts.qualityStatus }).from(publicIntelligenceArtifacts).where(and(
    eq(publicIntelligenceArtifacts.sourceId, source.id), eq(publicIntelligenceArtifacts.artifactType, 'human_annotation'), eq(publicIntelligenceArtifacts.sourceUrl, annotation.sourceUrl), isNull(publicIntelligenceArtifacts.removedAt),
  )).limit(1)
  const human = existing || await createOwnerPublicArtifact({ ownerUserId: source.ownerUserId, sourceId: source.id, sourceUrl: annotation.sourceUrl, canonicalUrl: annotation.sourceUrl, artifactType: 'human_annotation', artifactText: annotation.artifactText, sourceLocator: annotation.sourceLocator, sourceSpanHash: structural.sourceSpanHash, fieldData: labels, language: 'en', extractionMethod: 'human_annotation', requestedUse: 'training_candidate', retentionUntil: source.retentionUntil })
  if (human.qualityStatus !== 'passed') await reviewOwnerPublicArtifact({ ownerUserId: source.ownerUserId, artifactId: human.id, qualityStatus: 'passed', qualityNote: annotation.qualityNote })
  console.log(JSON.stringify({ sourceUrl: annotation.sourceUrl, structuralArtifactId: structural.id, humanAnnotationId: human.id, primaryJourneyStage: labels.primaryJourneyStage, status: existing ? 'retained_existing' : 'passed' }))
}

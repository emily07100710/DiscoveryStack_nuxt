import { and, eq, isNull } from 'drizzle-orm'
import { getDatabase } from '../server/database/index.ts'
import { publicIntelligenceArtifacts, publicIntelligenceSources } from '../server/database/schema.ts'
import { createOwnerPublicArtifact, reviewOwnerPublicArtifact } from '../server/public-intelligence/repository.ts'
import { seoGeoMultilabelSchema } from '../server/public-intelligence/seoGeoTaxonomy.ts'

const annotations = [
  {
    structuralArtifactId: 1020001,
    sourceUrl: 'https://developers.google.com/search/docs/appearance/title-link?hl=en',
    sourceLocator: 'human-review:batch-19:title-link',
    artifactText: 'Treat a title link as a search-result preview that helps a searcher judge why a page is relevant before clicking. Give every page a concise, descriptive, distinct title and avoid keyword stuffing or repeated boilerplate across comparable URLs. Align the title with the visible primary heading and the page language or writing system, then make the main heading visually unambiguous. Google can generate a result title from the title element, visible text, headings, og:title, anchor text, links to the page, or WebSite structured data, so a declared title is a strong signal rather than a manual override. Keep crawl and index controls conceptually separate: robots disallow can prevent crawling but does not always prevent indexing; use noindex when the URL should not be indexed. After a substantive change, allow time for recrawl and reprocessing instead of treating a request as a guaranteed immediate result update.',
    qualityNote: '人工閱讀官方 title links 文件：涵蓋 unique descriptive title、anti-keyword-stuffing、H1 prominence、language/script alignment、title-link candidate sources、robots/noindex distinction與 recrawl/reprocessing expectation。去識別摘要僅保留文件中的可泛化 SEO/GEO 洞察，未含 PII。',
    labels: {
      annotationKind: 'seo_geo_multilabel', annotationVersion: 'seo-geo-journey-v1', primaryJourneyStage: 'discovery', journeyStages: ['discovery', 'understanding', 'response'], searchIntents: ['informational', 'commercial'], contentTypes: ['editorial', 'tool'], audienceRoles: ['practitioner', 'technical_evaluator', 'decision_maker'], topicClusters: ['title link optimization', 'search-result preview', 'heading hierarchy', 'language alignment', 'index control boundary'], entitySignals: [{ name: 'Google Search', type: 'service', relationship: 'Generates title links automatically from multiple page and web signals.' }, { name: 'HTML title element', type: 'concept', relationship: 'Provides a preferred concise, distinct description of a page for search-result presentation.' }, { name: 'H1 heading', type: 'concept', relationship: 'Helps identify the primary visible title when its prominence is unambiguous.' }, { name: 'noindex', type: 'concept', relationship: 'Prevents indexing where crawl disallow alone may not prevent a URL from appearing.' }], geoSignals: ['global', 'multilingual', 'not_applicable'], citationReadiness: ['first_party_expertise', 'dated_or_current', 'source_links', 'structured_data'], technicalSeoSignals: ['title_present', 'h1_present', 'canonical_present', 'indexable', 'structured_data', 'language_signal'], frictionSignals: ['unclear_value', 'information_overload', 'missing_next_step'], actionPriority: 'medium', annotationRationale: '本頁將 title、heading、language 與 index-control 訊號連結到使用者在 SERP 的首次判斷；核心是 discovery，並明確排除 title 或 recrawl 可保證展示結果的錯誤推論。', reviewerConfidence: 5,
    },
  },
  {
    structuralArtifactId: 1020002,
    sourceUrl: 'https://developers.google.com/search/docs/appearance/snippet?hl=en',
    sourceLocator: 'human-review:batch-19:snippet',
    artifactText: 'Treat a snippet as a query-sensitive preview of page content, not as a field that can be manually forced for one result. Google primarily derives it from visible page content and may choose a meta description only when that gives a more accurate summary. Create unique, page-specific descriptions for critical URLs and use readable, diverse programmatic descriptions for large database-driven sites; avoid keyword strings that do not explain the page. Keep useful details together where they help a searcher decide whether the result meets the need. Where disclosure must be limited, use nosnippet, max-snippet, or data-nosnippet rather than deleting useful content. To support Read more deep links, keep relevant content visible to people, preserve the URL hash on load, and avoid script behavior that resets a user away from the linked section.',
    qualityNote: '人工閱讀官方 snippets 文件：涵蓋 query-sensitive snippet generation、meta description、unique/page-specific and programmatic descriptions、nosnippet/max-snippet/data-nosnippet與 Read more deep-link visibility、hash 與 scrolling constraints。去識別摘要與 reviewed source span 一致，未含 PII。',
    labels: {
      annotationKind: 'seo_geo_multilabel', annotationVersion: 'seo-geo-journey-v1', primaryJourneyStage: 'discovery', journeyStages: ['discovery', 'understanding'], searchIntents: ['informational', 'commercial'], contentTypes: ['editorial', 'tool'], audienceRoles: ['practitioner', 'technical_evaluator', 'decision_maker'], topicClusters: ['search-result snippets', 'meta descriptions', 'page-specific summaries', 'snippet visibility controls', 'deep-link accessibility'], entitySignals: [{ name: 'Google Search', type: 'service', relationship: 'Selects query-sensitive snippets primarily from visible page content and sometimes from a meta description.' }, { name: 'Meta description', type: 'concept', relationship: 'Can supply a more accurate page summary but does not guarantee a selected snippet.' }, { name: 'data-nosnippet', type: 'concept', relationship: 'Excludes bounded page portions from a search-result snippet without removing the page.' }, { name: 'Read more deep link', type: 'concept', relationship: 'Depends on visible target content and stable hash navigation to lead a searcher to the intended section.' }], geoSignals: ['global', 'not_applicable'], citationReadiness: ['first_party_expertise', 'dated_or_current', 'source_links'], technicalSeoSignals: ['title_present', 'h1_present', 'canonical_present', 'indexable', 'internal_routing'], frictionSignals: ['unclear_value', 'no_material_friction_observed'], actionPriority: 'medium', annotationRationale: '本頁涵蓋結果摘要與可達區段如何支援搜尋者的首次理解與點擊判斷，primary journey 為 discovery；標註保留 snippet 自動選擇與非保證性邊界。', reviewerConfidence: 5,
    },
  },
]

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

for (const annotation of annotations) {
  const [structural] = await database.select({ id: publicIntelligenceArtifacts.id, sourceSpanHash: publicIntelligenceArtifacts.sourceSpanHash, qualityStatus: publicIntelligenceArtifacts.qualityStatus, piiStatus: publicIntelligenceArtifacts.piiStatus }).from(publicIntelligenceArtifacts).where(and(
    eq(publicIntelligenceArtifacts.id, annotation.structuralArtifactId),
    eq(publicIntelligenceArtifacts.sourceId, source.id),
    eq(publicIntelligenceArtifacts.artifactType, 'structural_features'),
    eq(publicIntelligenceArtifacts.sourceUrl, annotation.sourceUrl),
    isNull(publicIntelligenceArtifacts.removedAt),
  )).limit(1)
  if (!structural?.sourceSpanHash) throw new Error(`batch_19_structural_artifact_not_found:${annotation.structuralArtifactId}`)
  if (structural.piiStatus !== 'none_detected') throw new Error(`batch_19_pii_not_clear:${annotation.structuralArtifactId}`)
  if (structural.qualityStatus !== 'passed') await reviewOwnerPublicArtifact({ ownerUserId: source.ownerUserId, artifactId: structural.id, qualityStatus: 'passed', qualityNote: annotation.qualityNote })
  const labels = seoGeoMultilabelSchema.parse(annotation.labels)
  const [existing] = await database.select({ id: publicIntelligenceArtifacts.id, qualityStatus: publicIntelligenceArtifacts.qualityStatus }).from(publicIntelligenceArtifacts).where(and(
    eq(publicIntelligenceArtifacts.sourceId, source.id),
    eq(publicIntelligenceArtifacts.artifactType, 'human_annotation'),
    eq(publicIntelligenceArtifacts.sourceUrl, annotation.sourceUrl),
    eq(publicIntelligenceArtifacts.qualityStatus, 'passed'),
    isNull(publicIntelligenceArtifacts.removedAt),
  )).limit(1)
  if (existing) {
    console.log(JSON.stringify({ sourceUrl: annotation.sourceUrl, structuralArtifactId: structural.id, humanAnnotationId: existing.id, primaryJourneyStage: labels.primaryJourneyStage, status: 'retained_existing' }))
    continue
  }
  const human = await createOwnerPublicArtifact({ ownerUserId: source.ownerUserId, sourceId: source.id, sourceUrl: annotation.sourceUrl, canonicalUrl: annotation.sourceUrl, artifactType: 'human_annotation', artifactText: annotation.artifactText, sourceLocator: annotation.sourceLocator, sourceSpanHash: structural.sourceSpanHash, fieldData: labels, language: 'en', extractionMethod: 'human_annotation', requestedUse: 'training_candidate', retentionUntil: source.retentionUntil })
  if (human.qualityStatus !== 'passed') await reviewOwnerPublicArtifact({ ownerUserId: source.ownerUserId, artifactId: human.id, qualityStatus: 'passed', qualityNote: annotation.qualityNote })
  console.log(JSON.stringify({ sourceUrl: annotation.sourceUrl, structuralArtifactId: structural.id, humanAnnotationId: human.id, primaryJourneyStage: labels.primaryJourneyStage, status: 'passed' }))
}

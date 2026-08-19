import { and, eq, inArray, isNull } from 'drizzle-orm'
import { getDatabase } from '../server/database/index.ts'
import { publicIntelligenceArtifacts, publicIntelligenceSources } from '../server/database/schema.ts'
import { createOwnerPublicArtifact, reviewOwnerPublicArtifact } from '../server/public-intelligence/repository.ts'
import { seoGeoMultilabelSchema } from '../server/public-intelligence/seoGeoTaxonomy.ts'

const annotations = [
  {
    sourceUrl: 'https://developers.google.com/search/docs/fundamentals/ai-optimization-guide?hl=en',
    artifactText: 'Google describes optimization for generative AI features as SEO: retrieval-augmented generation and query fan-out rely on core Search systems and current web pages. Website owners should create unique, people-first non-commodity content, preserve crawlability and clear technical structure, reduce duplicates, support useful local or ecommerce details, and measure visibility in Search Console. Meeting requirements does not guarantee crawling, indexing, or serving in generative experiences.',
    sourceLocator: 'human-review:batch-06:generative-ai-optimization',
    qualityNote: '人工閱讀官方文件：涵蓋 RAG、query fan-out、AEO/GEO 與 SEO 關係、獨特可靠內容、technical crawlability、JavaScript、page experience、local/ecommerce details、Search Console 與不保證展示；資料與 reviewed source span 一致，未含 PII。',
    labels: {
      annotationKind: 'seo_geo_multilabel', annotationVersion: 'seo-geo-journey-v1', primaryJourneyStage: 'progression', journeyStages: ['discovery', 'understanding', 'progression', 'conversion'], searchIntents: ['informational', 'commercial'], contentTypes: ['editorial', 'service'], audienceRoles: ['buyer', 'decision_maker', 'practitioner', 'technical_evaluator'], topicClusters: ['generative AI search', 'retrieval augmented generation', 'query fan-out', 'people-first content', 'technical SEO', 'GEO and AEO'], entitySignals: [{ name: 'Google Search', type: 'organisation', relationship: 'Uses core ranking and quality systems to surface relevant indexed pages in generative search features.' }, { name: 'Retrieval-augmented generation', type: 'concept', relationship: 'Grounds generated responses in retrieved current web pages.' }, { name: 'Search Console', type: 'service', relationship: 'Supports visibility measurement and technical issue diagnosis.' }], geoSignals: ['global', 'city_or_local'], citationReadiness: ['named_author_or_owner', 'first_party_expertise', 'dated_or_current', 'source_links'], technicalSeoSignals: ['title_present', 'h1_present', 'indexable', 'internal_routing', 'language_signal', 'performance_not_observed'], frictionSignals: ['information_overload'], actionPriority: 'high', annotationRationale: '本頁直接連結 SEO、GEO/AEO、生成式搜尋可見性、技術可抓取性、獨特內容與商品／在地商家資料，並明確保留 eligibility 不保證展示的限制，適合訓練 progression-stage SEO/GEO 行動洞察。', reviewerConfidence: 5,
    },
  },
  {
    sourceUrl: 'https://developers.google.com/search/docs/monitor-debug/search-console-start?hl=en',
    artifactText: 'Search Console helps site owners understand Search performance and improve relevant traffic. Verify ownership, inspect index coverage errors and warnings, submit and monitor sitemaps where useful, and use query, page, country, impression, and click reports to diagnose declines. The platform also exposes manual actions, removals, site migrations, rich-result implementation issues, URL Inspection, security issues, and Core Web Vitals.',
    sourceLocator: 'human-review:batch-06:search-console-start',
    qualityNote: '人工閱讀官方文件：完整說明 ownership、Index Coverage、sitemap、performance metrics、manual actions、removals、migration、rich-result status、URL Inspection、security 與 Core Web Vitals；資料與 reviewed source span 一致，未含 PII。',
    labels: {
      annotationKind: 'seo_geo_multilabel', annotationVersion: 'seo-geo-journey-v1', primaryJourneyStage: 'response', journeyStages: ['understanding', 'response', 'progression'], searchIntents: ['informational', 'navigational'], contentTypes: ['tool', 'editorial'], audienceRoles: ['practitioner', 'technical_evaluator', 'existing_customer', 'decision_maker'], topicClusters: ['Search Console', 'index coverage', 'search performance reporting', 'URL Inspection', 'Core Web Vitals', 'structured data debugging'], entitySignals: [{ name: 'Search Console', type: 'service', relationship: 'Provides verified site owners with reports and tools for crawling, indexing, performance, and issue diagnosis.' }, { name: 'URL Inspection', type: 'service', relationship: 'Provides page-level index status and live URL testing.' }, { name: 'Core Web Vitals', type: 'concept', relationship: 'Reports field-data page experience signals.' }], geoSignals: ['global', 'country'], citationReadiness: ['named_author_or_owner', 'first_party_expertise', 'dated_or_current', 'source_links'], technicalSeoSignals: ['title_present', 'h1_present', 'indexable', 'structured_data', 'internal_routing', 'language_signal'], frictionSignals: ['missing_next_step'], actionPriority: 'high', annotationRationale: '本頁將發現流量或索引問題後的驗證、診斷、報表解讀與修復工具串成具體回應流程，並納入頁面、查詢、國家、rich results、安全與效能訊號，適合訓練 response-stage 優先度判斷。', reviewerConfidence: 5,
    },
  },
  {
    sourceUrl: 'https://developers.google.com/crawling/docs/crawlers-fetchers/overview-google-crawlers?hl=en',
    artifactText: 'Google distinguishes common crawlers that respect robots.txt, special-case crawlers used under specific agreements, and user-triggered fetchers. Its crawling infrastructure may use distributed US egress, HTTP/1.1 or HTTP/2, gzip/deflate/Brotli, a default 15 MB file limit, and ETag or Last-Modified caching. Site operators should manage host load appropriately and verify Google crawlers through user-agent, source IP, and reverse DNS rather than relying on the header alone.',
    sourceLocator: 'human-review:batch-06:google-crawlers-overview',
    qualityNote: '人工閱讀官方文件：區分 crawler/fetcher 類型、robots、protocol、compression、檔案大小、host load、HTTP cache 與 user-agent/IP/reverse DNS verification；資料與 reviewed source span 一致，未含 PII。',
    labels: {
      annotationKind: 'seo_geo_multilabel', annotationVersion: 'seo-geo-journey-v1', primaryJourneyStage: 'understanding', journeyStages: ['discovery', 'understanding', 'progression'], searchIntents: ['informational'], contentTypes: ['editorial', 'tool'], audienceRoles: ['practitioner', 'technical_evaluator', 'decision_maker'], topicClusters: ['Googlebot', 'robots.txt', 'crawler verification', 'HTTP caching', 'crawl host load', 'crawler protocols'], entitySignals: [{ name: 'Google crawlers', type: 'service', relationship: 'Discover and scan web content under documented protocol, robots, and capacity behavior.' }, { name: 'robots.txt', type: 'concept', relationship: 'Controls common crawler access for automatic crawling.' }, { name: 'ETag', type: 'concept', relationship: 'Preferred HTTP cache validator for crawled content freshness.' }], geoSignals: ['global', 'country'], citationReadiness: ['named_author_or_owner', 'first_party_expertise', 'dated_or_current', 'source_links'], technicalSeoSignals: ['title_present', 'h1_present', 'indexable', 'internal_routing', 'language_signal', 'performance_not_observed'], frictionSignals: ['no_material_friction_observed'], actionPriority: 'medium', annotationRationale: '本頁提供 crawler identity、robots、傳輸協定、檔案限制、host capacity、cache 與驗證的第一方技術事實，適合訓練 understanding-stage 的技術 SEO、可抓取性與誤判 crawler 身分風險辨識。', reviewerConfidence: 5,
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

const urls = annotations.map(({ sourceUrl }) => sourceUrl)
const structuralRows = await database.select({ id: publicIntelligenceArtifacts.id, sourceUrl: publicIntelligenceArtifacts.sourceUrl, sourceSpanHash: publicIntelligenceArtifacts.sourceSpanHash, qualityStatus: publicIntelligenceArtifacts.qualityStatus, piiStatus: publicIntelligenceArtifacts.piiStatus }).from(publicIntelligenceArtifacts).where(and(
  eq(publicIntelligenceArtifacts.sourceId, source.id),
  eq(publicIntelligenceArtifacts.artifactType, 'structural_features'),
  inArray(publicIntelligenceArtifacts.sourceUrl, urls),
  isNull(publicIntelligenceArtifacts.removedAt),
))
if (structuralRows.length !== annotations.length) throw new Error(`expected_${annotations.length}_structural_artifacts_found_${structuralRows.length}`)

for (const annotation of annotations) {
  const structural = structuralRows.find(row => row.sourceUrl === annotation.sourceUrl)
  if (!structural?.sourceSpanHash) throw new Error(`structural_span_missing:${annotation.sourceUrl}`)
  if (structural.piiStatus !== 'none_detected') throw new Error(`structural_pii_not_clear:${annotation.sourceUrl}`)

  if (structural.qualityStatus !== 'passed') {
    await reviewOwnerPublicArtifact({ ownerUserId: source.ownerUserId, artifactId: structural.id, qualityStatus: 'passed', qualityNote: annotation.qualityNote })
  }

  const labels = seoGeoMultilabelSchema.parse(annotation.labels)
  const [existing] = await database.select({ id: publicIntelligenceArtifacts.id, qualityStatus: publicIntelligenceArtifacts.qualityStatus }).from(publicIntelligenceArtifacts).where(and(
    eq(publicIntelligenceArtifacts.sourceId, source.id),
    eq(publicIntelligenceArtifacts.artifactType, 'human_annotation'),
    eq(publicIntelligenceArtifacts.sourceUrl, annotation.sourceUrl),
    eq(publicIntelligenceArtifacts.sourceSpanHash, structural.sourceSpanHash),
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
  if (human.qualityStatus !== 'passed') {
    await reviewOwnerPublicArtifact({ ownerUserId: source.ownerUserId, artifactId: human.id, qualityStatus: 'passed', qualityNote: annotation.qualityNote })
  }
  console.log(JSON.stringify({ sourceUrl: annotation.sourceUrl, structuralArtifactId: structural.id, humanAnnotationId: human.id, primaryJourneyStage: labels.primaryJourneyStage, status: 'passed' }))
}

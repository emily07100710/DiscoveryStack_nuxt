import { and, eq, inArray, isNull } from 'drizzle-orm'
import { getDatabase } from '../server/database/index.ts'
import { publicIntelligenceArtifacts, publicIntelligenceSources } from '../server/database/schema.ts'
import { createOwnerPublicArtifact, reviewOwnerPublicArtifact } from '../server/public-intelligence/repository.ts'
import { seoGeoMultilabelSchema } from '../server/public-intelligence/seoGeoTaxonomy.ts'

const annotations = [
  {
    sourceUrl: 'https://developers.google.com/search/docs/fundamentals/how-search-works?hl=en',
    artifactText: 'Google Search discovers URLs, crawls and renders accessible pages, indexes their text and metadata, clusters duplicates around a canonical, and serves results using relevance signals such as language, location, and device. Crawl, indexing, and ranking are not guaranteed.',
    sourceLocator: 'human-review:batch-04:how-search-works',
    qualityNote: '人工閱讀官方文件：內容完整、具體說明 crawling、indexing、serving、canonical 與可及性限制；與來源 URL 及 reviewed span 一致。',
    labels: {
      annotationKind: 'seo_geo_multilabel', annotationVersion: 'seo-geo-journey-v1', primaryJourneyStage: 'understanding', journeyStages: ['discovery', 'understanding', 'response'], searchIntents: ['informational'], contentTypes: ['editorial'], audienceRoles: ['researcher', 'practitioner', 'technical_evaluator'], topicClusters: ['Google Search lifecycle', 'crawling and indexing', 'canonicalization', 'search visibility diagnostics'], entitySignals: [{ name: 'Google Search', type: 'organisation', relationship: 'Explains the automated search lifecycle for website owners.' }, { name: 'Googlebot', type: 'product', relationship: 'Crawler that discovers and fetches accessible pages.' }, { name: 'Canonical URL', type: 'concept', relationship: 'Representative page selected from a cluster of similar content.' }], geoSignals: ['global'], citationReadiness: ['named_author_or_owner', 'first_party_expertise', 'dated_or_current', 'source_links'], technicalSeoSignals: ['title_present', 'h1_present', 'indexable', 'internal_routing', 'language_signal'], frictionSignals: ['no_material_friction_observed'], actionPriority: 'high', annotationRationale: '本頁以官方第一方說明串連 URL discovery、rendering、索引、canonical 與 SERP serving，適合訓練網站擁有者從基礎理解延伸至可及性與診斷問題的多階段 SEO 判斷。', reviewerConfidence: 5,
    },
  },
  {
    sourceUrl: 'https://developers.google.com/search/docs/appearance/structured-data/sd-policies?hl=en',
    artifactText: 'Structured data can make a page eligible for rich results but does not guarantee display. Markup must be accessible, accurately represent visible main content, use required and relevant properties, avoid misleading claims, and keep linked images crawlable and indexable.',
    sourceLocator: 'human-review:batch-04:structured-data-guidelines',
    qualityNote: '人工閱讀官方文件：內容包含 structured-data technical／quality guidelines、rich-result eligibility 與 manual-action 風險；未發現 PII 或授權外內容。',
    labels: {
      annotationKind: 'seo_geo_multilabel', annotationVersion: 'seo-geo-journey-v1', primaryJourneyStage: 'progression', journeyStages: ['understanding', 'progression', 'response'], searchIntents: ['informational'], contentTypes: ['editorial'], audienceRoles: ['practitioner', 'technical_evaluator', 'decision_maker'], topicClusters: ['structured data quality', 'rich result eligibility', 'schema markup compliance', 'Search Console manual actions'], entitySignals: [{ name: 'Google Search', type: 'organisation', relationship: 'Defines rich-result eligibility and policy requirements.' }, { name: 'Structured data', type: 'concept', relationship: 'Machine-readable page representation assessed for correctness and quality.' }, { name: 'Rich results', type: 'concept', relationship: 'Search appearance feature enabled but not guaranteed by compliant markup.' }], geoSignals: ['global'], citationReadiness: ['named_author_or_owner', 'first_party_expertise', 'dated_or_current', 'source_links'], technicalSeoSignals: ['title_present', 'h1_present', 'indexable', 'internal_routing', 'language_signal'], frictionSignals: ['no_material_friction_observed'], actionPriority: 'high', annotationRationale: '本頁是由理解走向實作與回應問題的政策型文件：它把 syntax、可爬性、可見內容、完整性與不保證展示清楚分開，可支援結構化資料合規與 SERP appearance 的多標籤預測。', reviewerConfidence: 5,
    },
  },
  {
    sourceUrl: 'https://developers.google.com/search/docs/crawling-indexing/links-crawlable?hl=en',
    artifactText: 'Google can reliably crawl links expressed as anchor elements with resolvable href values. Descriptive anchor text and contextual internal links help people and Google understand destinations, while qualified external links may use nofollow, sponsored, or ugc when appropriate.',
    sourceLocator: 'human-review:batch-04:links-crawlable',
    qualityNote: '人工閱讀官方文件：包含可爬連結 HTML、anchor text、internal-link discovery 與 external-link qualification 的完整指引；內容與 reviewed source span 相符。',
    labels: {
      annotationKind: 'seo_geo_multilabel', annotationVersion: 'seo-geo-journey-v1', primaryJourneyStage: 'progression', journeyStages: ['discovery', 'understanding', 'progression'], searchIntents: ['informational'], contentTypes: ['editorial'], audienceRoles: ['practitioner', 'technical_evaluator', 'researcher'], topicClusters: ['crawlable links', 'anchor text', 'internal linking', 'link qualification'], entitySignals: [{ name: 'Google Search', type: 'organisation', relationship: 'Uses links for URL discovery and relevance understanding.' }, { name: 'HTML anchor element', type: 'concept', relationship: 'Preferred crawlable link implementation using a resolvable href.' }, { name: 'Internal links', type: 'concept', relationship: 'Help users and crawlers discover related site content.' }], geoSignals: ['global'], citationReadiness: ['named_author_or_owner', 'first_party_expertise', 'dated_or_current', 'source_links'], technicalSeoSignals: ['title_present', 'h1_present', 'indexable', 'internal_routing', 'language_signal'], frictionSignals: ['no_material_friction_observed'], actionPriority: 'high', annotationRationale: '本頁提供可直接落地的 technical SEO 實作與可讀性準則，將 discoverability、anchor context 與 link attributes 連結到網站使用者旅程中的內容尋找與資訊理解。', reviewerConfidence: 5,
    },
  },
  {
    sourceUrl: 'https://developers.google.com/search/docs/crawling-indexing/mobile/mobile-sites-mobile-first-indexing?hl=en',
    artifactText: 'Google uses the mobile page version for indexing and ranking. Responsive design is recommended, and mobile and desktop versions should preserve equivalent primary content, metadata, structured data, crawlable resources, accessible media, and error behavior.',
    sourceLocator: 'human-review:batch-04:mobile-first-indexing',
    qualityNote: '人工閱讀官方文件：包含 mobile-first indexing、responsive／dynamic／separate URL 架構、content parity、metadata、structured data、media 與 troubleshooting；內容完整且不含 PII。',
    labels: {
      annotationKind: 'seo_geo_multilabel', annotationVersion: 'seo-geo-journey-v1', primaryJourneyStage: 'response', journeyStages: ['progression', 'response'], searchIntents: ['informational'], contentTypes: ['editorial'], audienceRoles: ['practitioner', 'technical_evaluator', 'decision_maker'], topicClusters: ['mobile-first indexing', 'responsive design', 'mobile content parity', 'mobile SEO troubleshooting'], entitySignals: [{ name: 'Google Search', type: 'organisation', relationship: 'Indexes and ranks using the smartphone-crawled mobile version.' }, { name: 'Smartphone agent', type: 'product', relationship: 'Crawler context used to retrieve mobile content.' }, { name: 'Responsive design', type: 'concept', relationship: 'Recommended mobile site configuration for shared HTML and URL.' }], geoSignals: ['global'], citationReadiness: ['named_author_or_owner', 'first_party_expertise', 'dated_or_current', 'source_links'], technicalSeoSignals: ['title_present', 'h1_present', 'indexable', 'internal_routing', 'language_signal'], frictionSignals: ['no_material_friction_observed'], actionPriority: 'high', annotationRationale: '本頁同時覆蓋實作與故障排查：使用者在發現 mobile visibility 或 indexing 異常時，可從 content parity、robots、metadata、schema、media 與 separate URL 行為找到回應路徑。', reviewerConfidence: 5,
    },
  },
  {
    sourceUrl: 'https://developers.google.com/search/docs/essentials?hl=en',
    artifactText: 'Google Search Essentials groups eligibility and performance guidance into technical requirements, spam policies, and people-first best practices. It emphasizes useful content, user language in prominent page elements, crawlable links, appropriate content-format guidance, and appearance controls.',
    sourceLocator: 'human-review:batch-04:search-essentials',
    qualityNote: '人工閱讀官方文件：內容完整整理 technical requirements、spam policies 與 people-first best practices，適合作為 SEO 起點；與來源 URL 和 reviewed span 一致。',
    labels: {
      annotationKind: 'seo_geo_multilabel', annotationVersion: 'seo-geo-journey-v1', primaryJourneyStage: 'discovery', journeyStages: ['discovery', 'understanding', 'progression'], searchIntents: ['informational'], contentTypes: ['editorial'], audienceRoles: ['researcher', 'practitioner', 'decision_maker'], topicClusters: ['Google Search Essentials', 'technical eligibility', 'spam policies', 'people-first content'], entitySignals: [{ name: 'Google Search', type: 'organisation', relationship: 'Sets the published framework for web-content eligibility and performance guidance.' }, { name: 'Google Search Essentials', type: 'concept', relationship: 'Framework combining technical requirements, spam policies, and best practices.' }, { name: 'Spam policies', type: 'concept', relationship: 'Policies that can reduce visibility or omit a page or site from Search.' }], geoSignals: ['global'], citationReadiness: ['named_author_or_owner', 'first_party_expertise', 'dated_or_current', 'source_links'], technicalSeoSignals: ['title_present', 'h1_present', 'indexable', 'internal_routing', 'language_signal'], frictionSignals: ['no_material_friction_observed'], actionPriority: 'high', annotationRationale: '本頁為網站擁有者提供最初的探索框架，再導向 technical eligibility、內容品質、crawlability 與 appearance 控制；其明確的三分法適合支援 discovery 與後續 SEO 行動優先度判斷。', reviewerConfidence: 5,
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

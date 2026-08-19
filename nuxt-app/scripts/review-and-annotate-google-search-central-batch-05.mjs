import { and, eq, inArray, isNull } from 'drizzle-orm'
import { getDatabase } from '../server/database/index.ts'
import { publicIntelligenceArtifacts, publicIntelligenceSources } from '../server/database/schema.ts'
import { createOwnerPublicArtifact, reviewOwnerPublicArtifact } from '../server/public-intelligence/repository.ts'
import { seoGeoMultilabelSchema } from '../server/public-intelligence/seoGeoTaxonomy.ts'

const annotations = [
  {
    sourceUrl: 'https://developers.google.com/search/docs/appearance/structured-data/product?hl=en',
    artifactText: 'Product structured data can help eligible product pages present price, availability, shipping, returns, ratings, and review information in Google Search, Images, and Lens. Use product snippets for editorial review pages and merchant listings for pages where customers can purchase. Combining complete page markup with a Merchant Center feed can improve Google’s understanding and verification, but rich experiences are not guaranteed.',
    sourceLocator: 'human-review:batch-05:product-structured-data',
    qualityNote: '人工閱讀官方文件：完整區分 product snippets 與 merchant listings，涵蓋可購買頁面、商品資料、Merchant Center feed、eligibility 與不保證展示；資料與 reviewed source span 一致，未含 PII。',
    labels: {
      annotationKind: 'seo_geo_multilabel', annotationVersion: 'seo-geo-journey-v1', primaryJourneyStage: 'conversion', journeyStages: ['understanding', 'progression', 'conversion'], searchIntents: ['informational', 'commercial', 'transactional'], contentTypes: ['product', 'editorial'], audienceRoles: ['buyer', 'decision_maker', 'practitioner', 'technical_evaluator'], topicClusters: ['product structured data', 'merchant listings', 'product snippets', 'shopping search visibility', 'Merchant Center feed'], entitySignals: [{ name: 'Google Search', type: 'organisation', relationship: 'May present eligible product information in richer search experiences.' }, { name: 'Product structured data', type: 'concept', relationship: 'Machine-readable product, offer, price, availability, shipping, return, and review information.' }, { name: 'Merchant Center', type: 'service', relationship: 'Product-feed source that can complement page structured data.' }], geoSignals: ['global'], citationReadiness: ['named_author_or_owner', 'first_party_expertise', 'dated_or_current', 'source_links', 'structured_data'], technicalSeoSignals: ['title_present', 'h1_present', 'indexable', 'structured_data', 'internal_routing', 'language_signal'], frictionSignals: ['no_material_friction_observed'], actionPriority: 'high', annotationRationale: '本頁將購買頁與編輯型商品評測的 markup 需求分開，並連結商品資料完整度、Search appearance eligibility、Merchant Center verification 與使用者的價格／庫存／運送決策，適合訓練 conversion-oriented SEO/GEO 多維洞察。', reviewerConfidence: 5,
    },
  },
  {
    sourceUrl: 'https://developers.google.com/search/docs/crawling-indexing/ask-google-to-recrawl?hl=en',
    artifactText: 'After adding or changing a page, a verified Search Console property owner or full user can request indexing with URL Inspection for a few URLs, while larger URL sets should use a sitemap. Crawling can take days or weeks, repeated requests do not accelerate it, and a request does not guarantee inclusion; monitor progress with Index Status or URL Inspection.',
    sourceLocator: 'human-review:batch-05:ask-google-to-recrawl',
    qualityNote: '人工閱讀官方文件：具體說明 URL Inspection、property permission、recrawl 速度與不保證 inclusion、監測方法及 sitemap 的大量 URL 用途；資料與 reviewed source span 一致，未含 PII。',
    labels: {
      annotationKind: 'seo_geo_multilabel', annotationVersion: 'seo-geo-journey-v1', primaryJourneyStage: 'response', journeyStages: ['understanding', 'response', 'progression'], searchIntents: ['informational'], contentTypes: ['editorial', 'tool'], audienceRoles: ['practitioner', 'technical_evaluator', 'existing_customer'], topicClusters: ['URL Inspection', 'recrawl requests', 'indexing monitoring', 'sitemap submission', 'Search Console permissions'], entitySignals: [{ name: 'Google Search', type: 'organisation', relationship: 'Crawls and decides inclusion independently of an indexing request.' }, { name: 'URL Inspection tool', type: 'service', relationship: 'Search Console tool used to request indexing for a small number of managed URLs.' }, { name: 'Sitemap', type: 'concept', relationship: 'Discovery signal intended for larger groups of URLs.' }], geoSignals: ['global'], citationReadiness: ['named_author_or_owner', 'first_party_expertise', 'dated_or_current', 'source_links'], technicalSeoSignals: ['title_present', 'h1_present', 'indexable', 'internal_routing', 'language_signal'], frictionSignals: ['missing_next_step'], actionPriority: 'high', annotationRationale: '本頁對已發布或已變更內容的索引延遲提供可驗證回應流程，明確區分權限、個別 URL、批量 sitemap、監控及無法保證快速收錄的限制，適合訓練 response-stage 的診斷與行動優先度判斷。', reviewerConfidence: 5,
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

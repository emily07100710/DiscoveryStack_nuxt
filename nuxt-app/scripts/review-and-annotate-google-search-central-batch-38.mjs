import { and, eq, isNull } from 'drizzle-orm'
import { getDatabase } from '../server/database/index.ts'
import { publicIntelligenceArtifacts, publicIntelligenceSources } from '../server/database/schema.ts'
import { createOwnerPublicArtifact, reviewOwnerPublicArtifact } from '../server/public-intelligence/repository.ts'
import { seoGeoMultilabelSchema } from '../server/public-intelligence/seoGeoTaxonomy.ts'

const annotations = [
  {
    structuralArtifactId: 2010001,
    sourceUrl: 'https://developers.google.com/search/docs/appearance/top-places-list',
    sourceLocator: 'human-review:batch-38:top-places-list',
    artifactText: 'Google Search can surface a Top Places List when a query implies a ranked set of local businesses or places. Site owners cannot submit a list directly or guarantee that one will appear, but can improve the underlying business information with accurate location signals, relevant page content, and consistent structured data where it applies. The feature is generated automatically and should be understood as a search-appearance outcome rather than a manual placement control.',
    qualityNote: '人工閱讀 Top Places List：摘要保留 local-intent search appearance、位置與商家資訊訊號、自動產生與非保證呈現的邊界；官方頁尾標示 CC BY 4.0，PII extractor v4 為 none_detected。',
    labels: {
      annotationKind: 'seo_geo_multilabel', annotationVersion: 'seo-geo-journey-v1', primaryJourneyStage: 'progression',
      journeyStages: ['discovery', 'understanding', 'progression'], searchIntents: ['informational', 'commercial'], contentTypes: ['service', 'editorial'], audienceRoles: ['local_visitor', 'practitioner', 'decision_maker', 'technical_evaluator'],
      topicClusters: ['top places list', 'local search appearance', 'business information', 'location signals', 'automated search features'],
      entitySignals: [
        { name: 'Top Places List', type: 'concept', relationship: 'Represents an automatically generated Search feature for queries about ranked local places or businesses.' },
        { name: 'Google Search', type: 'service', relationship: 'Determines whether a Top Places List is useful to show and does not offer direct submission control.' },
        { name: 'Local business information', type: 'concept', relationship: 'Provides location and relevance signals that can support accurate local-search understanding.' },
      ],
      geoSignals: ['global', 'city_or_local'], citationReadiness: ['first_party_expertise', 'dated_or_current', 'source_links'], technicalSeoSignals: ['title_present', 'h1_present', 'canonical_present', 'indexable', 'structured_data', 'internal_routing', 'language_signal', 'performance_not_observed'], frictionSignals: ['missing_trust_signal', 'information_overload'], actionPriority: 'medium',
      annotationRationale: '此頁把本地搜尋意圖、地點／商家資訊與自動化 search appearance 的非保證邊界轉為可執行的內容與資訊訊號治理，適合 progression 多維標註。', reviewerConfidence: 5,
    },
  },
  {
    structuralArtifactId: 2010002,
    sourceUrl: 'https://developers.google.com/search/docs/appearance/structured-data/speakable',
    sourceLocator: 'human-review:batch-38:speakable',
    artifactText: 'Speakable structured data identifies short sections of eligible news content that may be suitable for text-to-speech surfaces. It requires valid markup, crawlable and indexable pages, clear user-visible content, and an understanding that markup does not guarantee a rich presentation. Publishers should validate implementation, monitor indexing, keep language and market constraints in view, and treat the feature as an accessibility-oriented enhancement rather than a substitute for useful page structure.',
    qualityNote: '人工閱讀 Speakable structured data：摘要保留 TTS eligible sections、crawl/index requirements、visible-content parity、驗證與非保證呈現、語言與市場限制；官方頁尾標示 CC BY 4.0，PII extractor v4 為 none_detected。',
    labels: {
      annotationKind: 'seo_geo_multilabel', annotationVersion: 'seo-geo-journey-v1', primaryJourneyStage: 'understanding',
      journeyStages: ['discovery', 'understanding', 'response'], searchIntents: ['informational'], contentTypes: ['editorial', 'service'], audienceRoles: ['practitioner', 'technical_evaluator', 'researcher', 'media_or_partner'],
      topicClusters: ['speakable markup', 'text to speech', 'structured data', 'accessibility', 'news content', 'rich-result eligibility'],
      entitySignals: [
        { name: 'Speakable structured data', type: 'concept', relationship: 'Identifies concise content sections that can be considered for speech-oriented search surfaces.' },
        { name: 'Google Search', type: 'service', relationship: 'Evaluates valid structured data and page eligibility without guaranteeing a particular presentation.' },
        { name: 'Rich Results Test', type: 'service', relationship: 'Helps validate markup implementation before monitoring crawler-visible page processing.' },
      ],
      geoSignals: ['global', 'country', 'multilingual'], citationReadiness: ['first_party_expertise', 'dated_or_current', 'source_links', 'structured_data'], technicalSeoSignals: ['title_present', 'h1_present', 'canonical_present', 'indexable', 'structured_data', 'internal_routing', 'language_signal', 'performance_not_observed'], frictionSignals: ['information_overload', 'missing_trust_signal'], actionPriority: 'medium',
      annotationRationale: '此頁以可朗讀內容、資料標記驗證、可檢索性與呈現非保證的邊界，提供內容與技術團隊理解 voice-oriented search appearance 的多維樣本。', reviewerConfidence: 5,
    },
  },
  {
    structuralArtifactId: 2010003,
    sourceUrl: 'https://developers.google.com/search/docs/appearance/package-tracking',
    sourceLocator: 'human-review:batch-38:package-tracking',
    artifactText: 'Package tracking in Google Search can retrieve shipment status from an eligible company API when people search with a package identifier. The program is not accepting new partners, and operational availability matters: the API is expected to respond quickly and consistently or the information may stop displaying. The integration distinguishes permitted shipping status fields from sender and recipient personal data, and it treats search appearance as conditional on service reliability rather than a guaranteed customer-facing placement.',
    qualityNote: '人工閱讀 Package tracking Early Adopters Program：摘要保留 API-based tracking、program availability、response-time reliability、allowed delivery fields、recipient/sender personal-data prohibition與非保證呈現；官方頁尾標示 CC BY 4.0，PII extractor v4 為 none_detected。',
    labels: {
      annotationKind: 'seo_geo_multilabel', annotationVersion: 'seo-geo-journey-v1', primaryJourneyStage: 'conversion',
      journeyStages: ['understanding', 'response', 'conversion'], searchIntents: ['informational', 'transactional'], contentTypes: ['service', 'tool'], audienceRoles: ['existing_customer', 'practitioner', 'technical_evaluator', 'decision_maker'],
      topicClusters: ['package tracking', 'shipment status API', 'service reliability', 'customer journey', 'personal data boundaries', 'search appearance'],
      entitySignals: [
        { name: 'Package tracking', type: 'service', relationship: 'Provides shipment-status information through an eligible carrier or merchant API for package-related searches.' },
        { name: 'Tracking API', type: 'service', relationship: 'Must meet responsiveness and availability expectations for status information to remain displayable.' },
        { name: 'Google Search', type: 'service', relationship: 'May display eligible package information while enforcing data and operational requirements.' },
      ],
      geoSignals: ['global', 'country', 'region'], citationReadiness: ['first_party_expertise', 'dated_or_current', 'source_links'], technicalSeoSignals: ['title_present', 'h1_present', 'canonical_present', 'indexable', 'structured_data', 'internal_routing', 'language_signal', 'performance_not_observed'], frictionSignals: ['missing_trust_signal', 'missing_next_step'], actionPriority: 'high',
      annotationRationale: '此頁連結搜尋中的即時配送資訊、可靠服務水準與資料最小化界線，能標註既有客戶查詢如何走向交易後服務與信任維護的 conversion 旅程。', reviewerConfidence: 5,
    },
  },
  {
    structuralArtifactId: 2010004,
    sourceUrl: 'https://developers.google.com/search/docs/appearance/structured-data/shipping-policy',
    sourceLocator: 'human-review:batch-38:shipping-policy',
    artifactText: 'Merchant shipping policy structured data lets an organization describe standard delivery cost, destination, handling time, and transit conditions so Google Search can understand shipping information alongside eligible products. Implementation starts with required properties and follows general structured-data and Search Essentials guidance, then uses validation and URL Inspection before rollout. Markup must match an accessible policy page and may support richer presentation, but passing validation or publishing markup does not guarantee a Search feature will appear.',
    qualityNote: '人工閱讀 Merchant shipping policy ShippingService structured data：摘要保留 organization-level shipping policy、cost/time/destination conditions、Search Essentials、Rich Results Test、URL Inspection、accessible policy page 與非保證 rich presentation；官方頁尾標示 CC BY 4.0，PII extractor v4 為 none_detected。',
    labels: {
      annotationKind: 'seo_geo_multilabel', annotationVersion: 'seo-geo-journey-v1', primaryJourneyStage: 'conversion',
      journeyStages: ['discovery', 'progression', 'conversion'], searchIntents: ['informational', 'commercial', 'transactional'], contentTypes: ['product', 'service', 'pricing'], audienceRoles: ['buyer', 'decision_maker', 'practitioner', 'technical_evaluator', 'existing_customer'],
      topicClusters: ['merchant shipping policy', 'ShippingService', 'delivery cost', 'delivery time', 'structured data validation', 'product search appearance'],
      entitySignals: [
        { name: 'ShippingService', type: 'concept', relationship: 'Models organization-level shipping conditions such as destination, cost, handling and transit time.' },
        { name: 'Rich Results Test', type: 'service', relationship: 'Validates structured-data implementation before deployment and crawl verification.' },
        { name: 'URL Inspection tool', type: 'service', relationship: 'Checks whether Google can access and process a deployed policy page.' },
      ],
      geoSignals: ['global', 'country', 'region'], citationReadiness: ['first_party_expertise', 'dated_or_current', 'source_links', 'structured_data'], technicalSeoSignals: ['title_present', 'h1_present', 'canonical_present', 'indexable', 'structured_data', 'internal_routing', 'language_signal', 'performance_not_observed'], frictionSignals: ['unclear_value', 'missing_trust_signal', 'missing_next_step'], actionPriority: 'high',
      annotationRationale: '此頁把運費與到貨時效等購買決策資訊連至可驗證的 structured data、可存取政策頁和 rollout 檢查，適合作為多受眾 conversion 標註。', reviewerConfidence: 5,
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

  if (!structural?.sourceSpanHash) throw new Error(`batch_38_structural_artifact_not_found:${annotation.structuralArtifactId}`)
  if (structural.piiStatus !== 'none_detected') throw new Error(`batch_38_pii_not_clear:${annotation.structuralArtifactId}`)
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
  console.log(JSON.stringify({ sourceUrl: annotation.sourceUrl, structuralArtifactId: structural.id, humanAnnotationId: human.id, primaryJourneyStage: labels.primaryJourneyStage, status: existing ? 'retained_existing' : 'passed' }))
}

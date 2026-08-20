import { and, eq, isNull } from 'drizzle-orm'
import { getDatabase } from '../server/database/index.ts'
import { publicIntelligenceArtifacts, publicIntelligenceSources } from '../server/database/schema.ts'
import { createOwnerPublicArtifact, reviewOwnerPublicArtifact } from '../server/public-intelligence/repository.ts'
import { seoGeoMultilabelSchema } from '../server/public-intelligence/seoGeoTaxonomy.ts'

const annotations = [
  {
    structuralArtifactId: 2280001,
    sourceUrl: 'https://developers.google.com/search/docs/appearance/structured-data/paywalled-content',
    sourceLocator: 'human-review:batch-43:paywalled-content',
    artifactText: 'To make eligible paywalled content understandable in Google Search, mark the restricted sections with appropriate structured data while keeping the page accessible to Googlebot through flexible sampling or a metered approach. Match markup to the visible restricted content, avoid cloaking, validate implementation, ensure crawl and index access, and remember that eligibility for a Search feature does not guarantee a result appearance. Use access-control metadata as a truthful description of content availability rather than as a substitute for user-focused content and clear subscription information.',
    qualityNote: '人工閱讀 Paywalled content structured data：摘要保留 flexible sampling／metered access、restricted-section markup、Googlebot access、visible-content parity、anti-cloaking、validation、crawl/index eligibility 與 Search display non-guarantee；官方頁尾 CC BY 4.0，PII extractor v4 為 none_detected。',
    labels: {
      annotationKind: 'seo_geo_multilabel', annotationVersion: 'seo-geo-journey-v1', primaryJourneyStage: 'conversion',
      journeyStages: ['understanding', 'progression', 'conversion'], searchIntents: ['informational', 'commercial'], contentTypes: ['service', 'editorial'], audienceRoles: ['decision_maker', 'practitioner', 'technical_evaluator', 'existing_customer'],
      topicClusters: ['paywalled content markup', 'flexible sampling', 'metered access', 'Googlebot access', 'content visibility parity', 'subscription conversion'],
      entitySignals: [
        { name: 'Paywalled content structured data', type: 'concept', relationship: 'Describes restricted page sections so Google Search can understand legitimate subscription access conditions.' },
        { name: 'Googlebot', type: 'service', relationship: 'Needs controlled access to eligible marked content without a different crawler-only experience.' },
        { name: 'Google Search', type: 'service', relationship: 'Can evaluate compliant access-control markup but does not guarantee a particular result treatment.' },
      ],
      geoSignals: ['global', 'multilingual'], citationReadiness: ['first_party_expertise', 'dated_or_current', 'source_links', 'structured_data'], technicalSeoSignals: ['title_present', 'h1_present', 'canonical_present', 'indexable', 'structured_data', 'internal_routing', 'language_signal', 'performance_not_observed'], frictionSignals: ['missing_trust_signal', 'information_overload', 'no_material_friction_observed'], actionPriority: 'high',
      annotationRationale: '此頁把受限內容的透明描述、爬蟲存取、結構化標記、反偽裝與訂閱轉換期待管理連成可驗證的技術與使用者旅程樣本。', reviewerConfidence: 5,
    },
  },
  {
    structuralArtifactId: 2280002,
    sourceUrl: 'https://developers.google.com/search/docs/appearance/core-web-vitals',
    sourceLocator: 'human-review:batch-43:core-web-vitals',
    artifactText: 'Core Web Vitals report field measurements for loading performance, visual stability and interaction responsiveness. Evaluate them together with broader page-experience factors, use Search Console and performance tools to diagnose URL groups, distinguish laboratory data from real-user field data, and prioritize user-visible problems rather than treating any single metric as a ranking guarantee. Improve the underlying page experience, then monitor trend changes over an appropriate collection window before attributing Search performance changes.',
    qualityNote: '人工閱讀 Core Web Vitals and Google Search results：摘要保留 field versus lab data、loading／visual stability／interaction metrics、Search Console diagnosis、URL group prioritization、user-focused page experience、monitoring window 與無單一排名保證；官方頁尾 CC BY 4.0，PII extractor v4 為 none_detected。',
    labels: {
      annotationKind: 'seo_geo_multilabel', annotationVersion: 'seo-geo-journey-v1', primaryJourneyStage: 'progression',
      journeyStages: ['understanding', 'response', 'progression'], searchIntents: ['informational', 'commercial'], contentTypes: ['tool', 'service', 'editorial'], audienceRoles: ['practitioner', 'technical_evaluator', 'decision_maker', 'researcher'],
      topicClusters: ['Core Web Vitals', 'field and lab data', 'loading performance', 'visual stability', 'interaction responsiveness', 'Search Console diagnostics'],
      entitySignals: [
        { name: 'Core Web Vitals', type: 'concept', relationship: 'Summarizes user-centered field measurements for page loading, layout stability and interaction responsiveness.' },
        { name: 'Search Console', type: 'service', relationship: 'Surfaces URL groups and field-data trends for page-experience investigation.' },
        { name: 'Google Search', type: 'service', relationship: 'Uses many signals and does not make a single Core Web Vital a guaranteed ranking outcome.' },
      ],
      geoSignals: ['global', 'multilingual'], citationReadiness: ['first_party_expertise', 'dated_or_current', 'source_links', 'structured_data'], technicalSeoSignals: ['title_present', 'h1_present', 'canonical_present', 'indexable', 'internal_routing', 'language_signal', 'performance_not_observed'], frictionSignals: ['information_overload', 'missing_next_step', 'no_material_friction_observed'], actionPriority: 'high',
      annotationRationale: '此頁讓模型連結以使用者為中心的效能量測、資料來源差異、URL 群組診斷與變更後觀測，避免將單一指標誤當成排名保證。', reviewerConfidence: 5,
    },
  },
  {
    structuralArtifactId: 2280003,
    sourceUrl: 'https://developers.google.com/search/docs/appearance/enable-web-stories?hl=pt-br',
    sourceLocator: 'human-review:batch-43:enable-web-stories',
    artifactText: 'A Web Story should be a complete, standalone visual narrative with crawlable AMP pages, descriptive metadata, a poster image and accessible links. Make each story discoverable through normal site navigation and a sitemap, use valid canonical and indexability signals, avoid obstructive overlays, and publish original content that meets Google policies. Track search visibility after publication while recognizing that meeting technical requirements does not guarantee a specific Search or Discover placement.',
    qualityNote: '人工閱讀 Enable Web Stories on Google：摘要保留 standalone visual narrative、AMP／metadata／poster image、normal navigation、sitemap、canonical/indexability、accessible links、policy compliance、Search/Discover monitoring 與 non-guarantee；官方頁尾 CC BY 4.0，PII extractor v4 為 none_detected。',
    labels: {
      annotationKind: 'seo_geo_multilabel', annotationVersion: 'seo-geo-journey-v1', primaryJourneyStage: 'discovery',
      journeyStages: ['discovery', 'understanding', 'progression'], searchIntents: ['informational', 'navigational'], contentTypes: ['editorial', 'service'], audienceRoles: ['practitioner', 'technical_evaluator', 'media_or_partner', 'decision_maker'],
      topicClusters: ['Web Stories discovery', 'visual narrative', 'AMP crawlability', 'story metadata', 'sitemap and navigation', 'Search Discover visibility'],
      entitySignals: [
        { name: 'Web Stories', type: 'concept', relationship: 'Provides a visual story format that requires complete standalone content and crawlable implementation.' },
        { name: 'Sitemap', type: 'concept', relationship: 'Helps communicate story URLs for discovery without guaranteeing Search inclusion.' },
        { name: 'Google Discover', type: 'service', relationship: 'May surface eligible policy-compliant content but does not promise placement.' },
      ],
      geoSignals: ['global', 'multilingual'], citationReadiness: ['first_party_expertise', 'dated_or_current', 'source_links', 'structured_data'], technicalSeoSignals: ['title_present', 'h1_present', 'canonical_present', 'indexable', 'internal_routing', 'language_signal', 'performance_not_observed'], frictionSignals: ['information_overload', 'weak_cta', 'no_material_friction_observed'], actionPriority: 'high',
      annotationRationale: '此頁將視覺內容的完整敘事、技術可檢索性、導覽／Sitemap 發現與 Search/Discover 的不保證呈現規則整合為 discovery 樣本。', reviewerConfidence: 5,
    },
  },
  {
    structuralArtifactId: 2280004,
    sourceUrl: 'https://developers.google.com/search/docs/appearance/web-stories-content-policy?hl=es',
    sourceLocator: 'human-review:batch-43:web-stories-content-policy',
    artifactText: 'Web Stories content must follow Google Search policies and prioritize original, useful storytelling. Avoid deceptive previews, misleading titles, scraped or low-value material, intrusive interstitials, unsupported claims and content that creates a poor or unsafe experience. Keep the primary story content accessible, align promotional elements with the narrative, and use policy review as a quality-control step before investigating a visibility problem in Search or Discover.',
    qualityNote: '人工閱讀 Web Stories content policies：摘要保留 original/useful story requirement、deceptive preview／misleading title／scraped low-value content prohibition、intrusive interstitials、unsafe experience、content accessibility、promotional alignment 與 Search/Discover policy review；官方頁尾 CC BY 4.0，PII extractor v4 為 none_detected。',
    labels: {
      annotationKind: 'seo_geo_multilabel', annotationVersion: 'seo-geo-journey-v1', primaryJourneyStage: 'response',
      journeyStages: ['understanding', 'response', 'conversion'], searchIntents: ['informational', 'commercial'], contentTypes: ['editorial', 'service'], audienceRoles: ['practitioner', 'decision_maker', 'media_or_partner', 'technical_evaluator'],
      topicClusters: ['Web Stories policy', 'original content quality', 'misleading preview prevention', 'intrusive interstitials', 'Search Discover eligibility', 'publisher governance'],
      entitySignals: [
        { name: 'Web Stories content policy', type: 'concept', relationship: 'Defines quality and safety constraints for eligible visual stories in Google Search experiences.' },
        { name: 'Google Search', type: 'service', relationship: 'Applies policy assessments to determine whether content can remain eligible for Search experiences.' },
        { name: 'Google Discover', type: 'service', relationship: 'Can surface compliant content but does not assure audience reach or traffic.' },
      ],
      geoSignals: ['global', 'multilingual'], citationReadiness: ['first_party_expertise', 'dated_or_current', 'source_links', 'structured_data'], technicalSeoSignals: ['title_present', 'h1_present', 'canonical_present', 'indexable', 'internal_routing', 'language_signal', 'performance_not_observed'], frictionSignals: ['missing_trust_signal', 'information_overload', 'no_material_friction_observed'], actionPriority: 'high',
      annotationRationale: '此頁把內容品質政策轉為具體的信任、可近性與呈現風險診斷訊號，適合訓練模型先以治理規則回應可見性問題。', reviewerConfidence: 5,
    },
  },
  {
    structuralArtifactId: 2310001,
    sourceUrl: 'https://developers.google.com/search/docs/appearance/structured-data/factcheck?hl=zh-tw',
    sourceLocator: 'human-review:batch-43:claimreview-structured-data',
    artifactText: 'ClaimReview structured data is intended for publishers that visibly fact-check a specific claim. Mark up only a claim and assessment that readers can inspect on the page, identify the claimant and fact-checking organization accurately, use a clear rating explanation, and follow relevant structured-data and content policies. Validate markup before launch and monitor Search tools afterwards, while recognizing that structured-data eligibility does not guarantee a rich result or override the need for transparent editorial evidence.',
    qualityNote: '人工閱讀 ClaimReview structured data：摘要保留 visible claim and assessment、claimant／fact-check organization identification、clear rating explanation、structured-data and content policies、validation、Search monitoring、editorial transparency 與 rich-result non-guarantee；官方頁尾 CC BY 4.0，PII extractor v4 為 none_detected。',
    labels: {
      annotationKind: 'seo_geo_multilabel', annotationVersion: 'seo-geo-journey-v1', primaryJourneyStage: 'response',
      journeyStages: ['understanding', 'response', 'conversion'], searchIntents: ['informational', 'commercial'], contentTypes: ['editorial', 'service', 'tool'], audienceRoles: ['researcher', 'practitioner', 'technical_evaluator', 'media_or_partner'],
      topicClusters: ['ClaimReview markup', 'visible evidence', 'fact-check transparency', 'structured data policy', 'rich result eligibility', 'editorial trust'],
      entitySignals: [
        { name: 'ClaimReview', type: 'concept', relationship: 'Represents a visible fact-check assessment of a specific claim with accountable publisher context.' },
        { name: 'Google Search', type: 'service', relationship: 'Can evaluate valid ClaimReview markup for enhanced presentation without guaranteeing display.' },
        { name: 'Rich Results Test', type: 'service', relationship: 'Supports pre-launch validation of eligible structured-data implementation.' },
      ],
      geoSignals: ['global', 'multilingual'], citationReadiness: ['first_party_expertise', 'dated_or_current', 'source_links', 'structured_data'], technicalSeoSignals: ['title_present', 'h1_present', 'canonical_present', 'indexable', 'structured_data', 'internal_routing', 'language_signal', 'performance_not_observed'], frictionSignals: ['missing_trust_signal', 'information_overload', 'no_material_friction_observed'], actionPriority: 'high',
      annotationRationale: '此頁能訓練模型將可見證據、發行者責任、標記驗證與結果呈現的不保證界線連結為可信內容的回應與治理訊號。', reviewerConfidence: 5,
    },
  },
  {
    structuralArtifactId: 2340001,
    sourceUrl: 'https://developers.google.com/search/docs/crawling-indexing/troubleshoot-crawling-errors',
    sourceLocator: 'human-review:batch-43:troubleshoot-crawling-errors',
    artifactText: 'When Googlebot has crawling problems, diagnose the specific path before changing the site. Use Crawl Stats and URL Inspection to distinguish availability failures, pages that should be crawled but are not, insufficient crawl capacity, inefficient URL inventories and over-crawling. Resolve host overload and access issues using appropriate server responses and durable technical fixes, then monitor crawl behavior over time. Better availability helps Google access pages, but it does not by itself guarantee a ranking improvement.',
    qualityNote: '人工閱讀 Troubleshoot crawling errors：摘要保留 availability、not-crawled pages、crawl capacity、URL inventory efficiency、over-crawling、Crawl Stats、URL Inspection、host overload、server response 與 ranking non-guarantee；官方頁尾 CC BY 4.0，PII extractor v4 為 none_detected。',
    labels: {
      annotationKind: 'seo_geo_multilabel', annotationVersion: 'seo-geo-journey-v1', primaryJourneyStage: 'response',
      journeyStages: ['understanding', 'response', 'progression'], searchIntents: ['informational', 'commercial'], contentTypes: ['tool', 'service', 'editorial'], audienceRoles: ['practitioner', 'technical_evaluator', 'existing_customer', 'decision_maker'],
      topicClusters: ['crawl error diagnosis', 'Googlebot availability', 'Crawl Stats', 'URL Inspection', 'host overload', 'crawl efficiency'],
      entitySignals: [
        { name: 'Googlebot', type: 'service', relationship: 'Requests site resources and produces crawl evidence used to diagnose access and capacity problems.' },
        { name: 'Crawl Stats report', type: 'service', relationship: 'Shows crawler requests and availability patterns for site-level troubleshooting.' },
        { name: 'URL Inspection', type: 'service', relationship: 'Helps evaluate a specific URL when diagnosing crawl and indexing behavior.' },
      ],
      geoSignals: ['global', 'multilingual'], citationReadiness: ['first_party_expertise', 'dated_or_current', 'source_links', 'structured_data'], technicalSeoSignals: ['title_present', 'h1_present', 'canonical_present', 'indexable', 'internal_routing', 'language_signal', 'performance_not_observed'], frictionSignals: ['information_overload', 'missing_next_step', 'no_material_friction_observed'], actionPriority: 'high',
      annotationRationale: '此頁建立從症狀分流、工具證據、主機與 URL 效率修復到後續觀測的診斷路徑，適合作為技術 SEO 回應與推進樣本。', reviewerConfidence: 5,
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

  if (!structural?.sourceSpanHash) throw new Error(`batch_43_structural_artifact_not_found:${annotation.structuralArtifactId}`)
  if (structural.piiStatus !== 'none_detected') throw new Error(`batch_43_pii_not_clear:${annotation.structuralArtifactId}`)
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

  let human = existing
  if (!human) {
    try {
      human = await createOwnerPublicArtifact({
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
    } catch (error) {
      if (error?.statusCode === 422 && String(error?.statusMessage).includes('active human annotation already exists for this source document')) {
        console.log(JSON.stringify({ sourceUrl: annotation.sourceUrl, structuralArtifactId: structural.id, status: 'skipped_canonical_duplicate' }))
        continue
      }
      throw error
    }
  }

  if (human.qualityStatus !== 'passed') {
    await reviewOwnerPublicArtifact({ ownerUserId: source.ownerUserId, artifactId: human.id, qualityStatus: 'passed', qualityNote: annotation.qualityNote })
  }
  console.log(JSON.stringify({ sourceUrl: annotation.sourceUrl, structuralArtifactId: structural.id, humanAnnotationId: human.id, primaryJourneyStage: labels.primaryJourneyStage, status: existing ? 'retained_existing' : 'passed' }))
}

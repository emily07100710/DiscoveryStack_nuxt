import { and, eq, isNull } from 'drizzle-orm'
import { getDatabase } from '../server/database/index.ts'
import { publicIntelligenceArtifacts, publicIntelligenceSources } from '../server/database/schema.ts'
import { createOwnerPublicArtifact, reviewOwnerPublicArtifact } from '../server/public-intelligence/repository.ts'
import { seoGeoMultilabelSchema } from '../server/public-intelligence/seoGeoTaxonomy.ts'

const annotations = [
  {
    structuralArtifactId: 2220001,
    sourceUrl: 'https://developers.google.com/search/docs/appearance/structured-data/intro-structured-data?hl=fr',
    sourceLocator: 'human-review:batch-42:introduction-to-structured-data',
    artifactText: 'Google Search can use page-level structured data to understand content and make a page eligible for enhanced Search presentation. Use accurate markup that describes visible content, prefer maintainable JSON-LD when appropriate, include required and complete recommended properties, validate before launch with Rich Results Test, then monitor post-deployment status reports and URL Inspection. Structured data is an eligibility signal, not a guarantee of a rich result; compare before-and-after Search Console performance on stable pages to assess impact.',
    qualityNote: '人工閱讀 Introduction to structured data markup in Google Search：摘要保留 page-content parity、JSON-LD／Microdata／RDFa、required versus recommended properties、Rich Results Test、post-deployment monitoring、Search Console measurement與 rich-result non-guarantee；官方頁尾 CC BY 4.0，PII extractor v4 為 none_detected。',
    labels: {
      annotationKind: 'seo_geo_multilabel', annotationVersion: 'seo-geo-journey-v1', primaryJourneyStage: 'conversion',
      journeyStages: ['discovery', 'understanding', 'conversion'], searchIntents: ['informational', 'commercial'], contentTypes: ['service', 'tool', 'editorial'], audienceRoles: ['researcher', 'practitioner', 'technical_evaluator', 'decision_maker'],
      topicClusters: ['structured data introduction', 'JSON-LD implementation', 'rich result eligibility', 'visible content parity', 'Rich Results Test validation', 'Search Console measurement'],
      entitySignals: [
        { name: 'Google Search structured data', type: 'concept', relationship: 'Provides standardized page-level clues that can make correctly implemented content eligible for enhanced Search presentation.' },
        { name: 'Rich Results Test', type: 'service', relationship: 'Validates structured data before launch and helps surface implementation errors.' },
        { name: 'Search Console', type: 'service', relationship: 'Supports post-deployment status monitoring and URL-level performance comparison.' },
      ],
      geoSignals: ['global', 'multilingual'], citationReadiness: ['first_party_expertise', 'dated_or_current', 'source_links', 'structured_data'], technicalSeoSignals: ['title_present', 'h1_present', 'canonical_present', 'indexable', 'structured_data', 'internal_routing', 'language_signal', 'performance_not_observed'], frictionSignals: ['information_overload', 'no_material_friction_observed'], actionPriority: 'high',
      annotationRationale: '此頁將標記的內容真實性、技術格式、驗證、部署後監測與可衡量成效串為搜尋呈現改善的轉換路徑，且明確保留 eligibility 不等於顯示保證的界線。', reviewerConfidence: 5,
    },
  },
  {
    structuralArtifactId: 2220002,
    sourceUrl: 'https://developers.google.com/search/docs/monitor-debug/google-analytics-search-console?hl=ko',
    sourceLocator: 'human-review:batch-42:search-console-google-analytics-seo',
    artifactText: 'Search Console measures Search-result impressions, clicks, queries and CTR before a person reaches a website, while Google Analytics measures on-site sessions, engagement and conversions. Combine both in a controlled dashboard using matched date, country and device filters, expect clicks and sessions to differ because their systems differ, use Search Console as the source of truth for Search performance, then investigate query, page, country and device patterns before changing content. Use data trends rather than a single metric to diagnose organic-traffic changes.',
    qualityNote: '人工閱讀 Using Search Console and Google Analytics data for SEO：摘要保留 pre-click／on-site measurement distinction、clicks versus sessions discrepancy、matched filters、Looker Studio dashboard、country/device/page/query diagnosis與 Search Console source-of-truth boundary；官方頁尾 CC BY 4.0，PII extractor v4 為 none_detected。',
    labels: {
      annotationKind: 'seo_geo_multilabel', annotationVersion: 'seo-geo-journey-v1', primaryJourneyStage: 'response',
      journeyStages: ['understanding', 'response', 'progression'], searchIntents: ['informational', 'commercial'], contentTypes: ['tool', 'editorial', 'service'], audienceRoles: ['researcher', 'decision_maker', 'practitioner', 'technical_evaluator'],
      topicClusters: ['Search Console and Analytics', 'organic traffic measurement', 'clicks and sessions', 'Looker Studio dashboard', 'country device analysis', 'conversion attribution'],
      entitySignals: [
        { name: 'Google Search Console', type: 'service', relationship: 'Provides Search-result discovery metrics and is the source of truth for Search performance.' },
        { name: 'Google Analytics', type: 'service', relationship: 'Measures on-site visitor sessions, engagement and conversion behavior after a visit.' },
        { name: 'Looker Studio', type: 'service', relationship: 'Combines selected Search Console and Analytics metrics with matched filters for trend analysis.' },
      ],
      geoSignals: ['global', 'country', 'multilingual'], citationReadiness: ['first_party_expertise', 'dated_or_current', 'source_links', 'structured_data'], technicalSeoSignals: ['title_present', 'h1_present', 'canonical_present', 'indexable', 'internal_routing', 'language_signal', 'performance_not_observed'], frictionSignals: ['information_overload', 'no_material_friction_observed'], actionPriority: 'high',
      annotationRationale: '此頁提供從曝光到站內行為的多來源量測與 discrepancy 排查規則，能訓練模型區分指標定義、控制比較條件並以頁面、查詢、國家與裝置證據回應流量問題。', reviewerConfidence: 5,
    },
  },
  {
    structuralArtifactId: 2220003,
    sourceUrl: 'https://developers.google.com/search/docs/appearance/structured-data/education-qa',
    sourceLocator: 'human-review:batch-42:education-qa-structured-data',
    artifactText: 'Education Q&A structured data can help eligible flashcard pages appear in an education Q&A carousel where available. Use Quiz, Question and Answer markup only on detailed pages with visible education questions and answers, distinguish a flashcard page from a user-submitted Q&A page, validate with Rich Results Test, confirm crawl and index access with URL Inspection, avoid robots.txt, noindex and login blocks, then submit a sitemap and monitor Search Console after deployment. Availability varies by language and region, and eligibility does not guarantee display.',
    qualityNote: '人工閱讀 Education Q&A structured data：摘要保留 Quiz／Question／Answer、flashcard versus QAPage 分流、visible-content requirement、language/region availability、Rich Results Test、URL Inspection、crawl/index access、sitemap、Search Console與 rich-result non-guarantee；官方頁尾 CC BY 4.0，PII extractor v4 為 none_detected。',
    labels: {
      annotationKind: 'seo_geo_multilabel', annotationVersion: 'seo-geo-journey-v1', primaryJourneyStage: 'discovery',
      journeyStages: ['discovery', 'understanding', 'conversion'], searchIntents: ['informational', 'commercial'], contentTypes: ['service', 'tool', 'editorial'], audienceRoles: ['researcher', 'practitioner', 'technical_evaluator', 'decision_maker'],
      topicClusters: ['education Q&A markup', 'Quiz Question Answer schema', 'flashcard discovery', 'rich result carousel', 'language region availability', 'structured data validation'],
      entitySignals: [
        { name: 'Education Q&A carousel', type: 'service', relationship: 'Can surface eligible education flashcard content in supported Search experiences.' },
        { name: 'Quiz structured data', type: 'concept', relationship: 'Describes visible flashcard questions and accepted answers for an eligible detailed page.' },
        { name: 'URL Inspection tool', type: 'service', relationship: 'Checks crawler access before a publisher requests recrawling after deployment.' },
      ],
      geoSignals: ['global', 'country', 'multilingual'], citationReadiness: ['first_party_expertise', 'dated_or_current', 'source_links', 'structured_data'], technicalSeoSignals: ['title_present', 'h1_present', 'canonical_present', 'indexable', 'structured_data', 'internal_routing', 'language_signal', 'performance_not_observed'], frictionSignals: ['missing_trust_signal', 'information_overload', 'no_material_friction_observed'], actionPriority: 'high',
      annotationRationale: '此頁將教育內容的問題型態、visible-content 可信度、結構化標記、區域語言可用性與技術驗證結合，適合作為支援多維搜尋發現與 GEO 可用性判斷的樣本。', reviewerConfidence: 5,
    },
  },
  {
    structuralArtifactId: 2220004,
    sourceUrl: 'https://developers.google.com/search/docs/crawling-indexing/sitemaps/build-sitemap?hl=es',
    sourceLocator: 'human-review:batch-42:build-and-submit-sitemap',
    artifactText: 'A sitemap helps Google discover site URLs but does not guarantee crawling or indexing. Build an XML, RSS, Atom or text sitemap with absolute canonical URLs, correct UTF-8 encoding, accurate lastmod values and compliant file size and URL-count limits; split large inventories with a sitemap index. Keep sitemap locations within allowed site scope, generate them through a CMS when appropriate, submit through Search Console or its API, optionally reference them in robots.txt, and monitor processing errors after changes.',
    qualityNote: '人工閱讀 Build and submit a sitemap：摘要保留 sitemap formats、absolute canonical URLs、UTF-8、lastmod accuracy、50MB/50,000 limits、sitemap index、scope／ownership、CMS generation、Search Console/API/robots.txt submission與 discovery non-guarantee；官方頁尾 CC BY 4.0，PII extractor v4 為 none_detected。',
    labels: {
      annotationKind: 'seo_geo_multilabel', annotationVersion: 'seo-geo-journey-v1', primaryJourneyStage: 'progression',
      journeyStages: ['understanding', 'progression', 'conversion'], searchIntents: ['informational', 'commercial'], contentTypes: ['tool', 'service', 'editorial'], audienceRoles: ['practitioner', 'technical_evaluator', 'decision_maker', 'researcher'],
      topicClusters: ['XML sitemap construction', 'canonical URL discovery', 'sitemap index scaling', 'lastmod accuracy', 'Search Console submission', 'crawl indexing monitoring'],
      entitySignals: [
        { name: 'Sitemap', type: 'concept', relationship: 'Communicates a structured inventory of canonical URLs to support discovery without guaranteeing index inclusion.' },
        { name: 'Search Console', type: 'service', relationship: 'Accepts sitemap submission and reports sitemap processing or URL discovery issues.' },
        { name: 'Sitemaps API', type: 'service', relationship: 'Automates sitemap submission and update workflows for eligible site owners.' },
      ],
      geoSignals: ['global', 'multilingual'], citationReadiness: ['first_party_expertise', 'dated_or_current', 'source_links', 'structured_data'], technicalSeoSignals: ['title_present', 'h1_present', 'canonical_present', 'indexable', 'internal_routing', 'language_signal', 'performance_not_observed'], frictionSignals: ['information_overload', 'missing_next_step', 'no_material_friction_observed'], actionPriority: 'high',
      annotationRationale: '此頁以可擴充的 URL inventory、canonical 一致性、提交通道與處理監測支援實作推進，並清楚區分 discovery hint 與 crawl/index 結果。', reviewerConfidence: 5,
    },
  },
  {
    structuralArtifactId: 2220005,
    sourceUrl: 'https://developers.google.com/search/docs/appearance/favicon-in-search?hl=de',
    sourceLocator: 'human-review:batch-42:favicon-in-search',
    artifactText: 'A site can define a favicon for Search by placing an allowed icon reference on its home page. Keep the icon URL stable, make the asset crawlable by Googlebot and Googlebot-Image, use a square brand-representative icon that meets supported size guidance, and avoid inappropriate or misleading imagery. A favicon applies at hostname scope rather than to selected subdirectories; updates can take time and Google may not display an icon despite valid implementation.',
    qualityNote: '人工閱讀 Define a favicon to show in search results：摘要保留 home-page link relation、hostname scope、Googlebot/Googlebot-Image access、stable URL、square sizing、brand representation、policy boundaries、crawling delay與 display non-guarantee；官方頁尾 CC BY 4.0，PII extractor v4 為 none_detected。',
    labels: {
      annotationKind: 'seo_geo_multilabel', annotationVersion: 'seo-geo-journey-v1', primaryJourneyStage: 'discovery',
      journeyStages: ['discovery', 'understanding', 'conversion'], searchIntents: ['informational', 'navigational'], contentTypes: ['service', 'editorial'], audienceRoles: ['researcher', 'practitioner', 'technical_evaluator', 'decision_maker'],
      topicClusters: ['favicon in Search', 'brand recognition', 'Googlebot-Image access', 'hostname scope', 'stable asset URL', 'search appearance policy'],
      entitySignals: [
        { name: 'Favicon', type: 'concept', relationship: 'Provides a compact visual brand signal for a site in eligible Search-result experiences.' },
        { name: 'Googlebot-Image', type: 'service', relationship: 'Must be able to crawl the favicon asset for Search to evaluate it.' },
        { name: 'Google Search', type: 'service', relationship: 'May render a valid favicon at hostname scope but does not guarantee display timing.' },
      ],
      geoSignals: ['global', 'multilingual'], citationReadiness: ['first_party_expertise', 'dated_or_current', 'source_links', 'structured_data'], technicalSeoSignals: ['title_present', 'h1_present', 'canonical_present', 'indexable', 'internal_routing', 'language_signal', 'performance_not_observed'], frictionSignals: ['missing_trust_signal', 'weak_cta', 'no_material_friction_observed'], actionPriority: 'medium',
      annotationRationale: '此頁將品牌辨識、bot asset access、hostname scope 與使用者期待管理整合為可驗證的搜尋呈現規則，適合作為 navigational discovery 樣本。', reviewerConfidence: 5,
    },
  },
  {
    structuralArtifactId: 2220006,
    sourceUrl: 'https://developers.google.com/search/docs/appearance/google-discover?hl=zh-cn',
    sourceLocator: 'human-review:batch-42:discover-and-your-website',
    artifactText: 'Google Discover may surface indexed, policy-compliant content based on a person’s interests, but inclusion and traffic are not guaranteed. Create helpful people-first content, use compelling accurate headlines and high-quality large images with appropriate preview controls, keep visual metadata consistent, and avoid misleading clickbait. Use the Discover performance report to examine clicks, impressions and CTR across time, then separate audience-interest volatility from indexing, policy, SafeSearch or manual-action issues before changing content.',
    qualityNote: '人工閱讀 Discover and your website：摘要保留 indexed/policy-compliant eligibility、people-first content、headline/image/max-image-preview guidance、metadata consistency、non-guarantee、interest volatility、SafeSearch/manual actions與 Discover report metrics；官方頁尾 CC BY 4.0，PII extractor v4 為 none_detected。',
    labels: {
      annotationKind: 'seo_geo_multilabel', annotationVersion: 'seo-geo-journey-v1', primaryJourneyStage: 'understanding',
      journeyStages: ['discovery', 'understanding', 'response'], searchIntents: ['informational', 'commercial'], contentTypes: ['editorial', 'service', 'tool'], audienceRoles: ['researcher', 'decision_maker', 'practitioner', 'media_or_partner'],
      topicClusters: ['Google Discover', 'people-first content', 'headline and image quality', 'max image preview', 'Discover performance report', 'traffic volatility diagnosis'],
      entitySignals: [
        { name: 'Google Discover', type: 'service', relationship: 'May surface eligible indexed content according to audience interests without traffic guarantees.' },
        { name: 'Discover performance report', type: 'service', relationship: 'Measures clicks, impressions and CTR for eligible Discover traffic over time.' },
        { name: 'SafeSearch', type: 'concept', relationship: 'Represents a policy-related factor that can affect content availability and traffic patterns.' },
      ],
      geoSignals: ['global', 'multilingual'], citationReadiness: ['first_party_expertise', 'dated_or_current', 'source_links', 'structured_data'], technicalSeoSignals: ['title_present', 'h1_present', 'canonical_present', 'indexable', 'internal_routing', 'language_signal', 'performance_not_observed'], frictionSignals: ['unclear_value', 'missing_trust_signal', 'information_overload', 'no_material_friction_observed'], actionPriority: 'medium',
      annotationRationale: '此頁同時呈現 audience-interest discovery、內容與視覺品質、metadata controls、效果量測及異常歸因，能訓練模型在非保證分發環境中區分內容改善與政策或興趣波動。', reviewerConfidence: 5,
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

  if (!structural?.sourceSpanHash) throw new Error(`batch_42_structural_artifact_not_found:${annotation.structuralArtifactId}`)
  if (structural.piiStatus !== 'none_detected') throw new Error(`batch_42_pii_not_clear:${annotation.structuralArtifactId}`)
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

import { and, eq, isNull } from 'drizzle-orm'
import { getDatabase } from '../server/database/index.ts'
import { publicIntelligenceArtifacts, publicIntelligenceSources } from '../server/database/schema.ts'
import { createOwnerPublicArtifact, reviewOwnerPublicArtifact } from '../server/public-intelligence/repository.ts'
import { seoGeoMultilabelSchema } from '../server/public-intelligence/seoGeoTaxonomy.ts'

const annotations = [
  {
    structuralArtifactId: 1830001,
    sourceUrl: 'https://developers.google.com/search/docs/fundamentals/how-search-works?hl=pt-br',
    sourceLocator: 'human-review:batch-35:how-search-works',
    artifactText: 'Google Search discovers URLs through links and sitemaps, then crawls accessible pages, processes content and key metadata during indexing, and serves results programmatically. Site teams should distinguish crawling, indexing, canonical selection, and serving because each can fail for different access, rendering, content-quality, or metadata reasons. Signals such as language, local relevance, and usability may affect the context in which a canonical page is served, but following documented practices does not guarantee crawling, indexing, ranking, or display.',
    qualityNote: '人工閱讀 In-depth guide to how Google Search works：摘要保留 URL discovery、crawling、rendering、indexing、canonicalization、serving、語言／在地信號與非保證界線；官方頁尾標示 CC BY 4.0，PII extractor v4 為 none_detected。',
    labels: {
      annotationKind: 'seo_geo_multilabel', annotationVersion: 'seo-geo-journey-v1', primaryJourneyStage: 'understanding',
      journeyStages: ['understanding', 'response', 'progression'], searchIntents: ['informational'], contentTypes: ['editorial', 'service'], audienceRoles: ['researcher', 'practitioner', 'technical_evaluator', 'decision_maker'],
      topicClusters: ['search lifecycle', 'URL discovery', 'Googlebot crawling', 'indexing diagnostics', 'canonical selection', 'search serving'],
      entitySignals: [
        { name: 'Google Search', type: 'service', relationship: 'Defines the documented lifecycle from discovering a URL through serving a result.' },
        { name: 'Googlebot', type: 'concept', relationship: 'Represents the crawler that retrieves accessible web content for processing.' },
        { name: 'Canonical page', type: 'concept', relationship: 'Explains the representative page selected from a cluster of substantially similar content.' },
      ],
      geoSignals: ['global', 'multilingual'], citationReadiness: ['first_party_expertise', 'dated_or_current', 'source_links'], technicalSeoSignals: ['title_present', 'h1_present', 'canonical_present', 'indexable', 'internal_routing', 'language_signal', 'performance_not_observed'], frictionSignals: ['information_overload'], actionPriority: 'medium',
      annotationRationale: '此頁以搜尋生命週期建立技術判讀順序，讓網站團隊能將 crawl、index、canonical 與 serve 的問題分開回應，並保留結果不保證的界線。', reviewerConfidence: 5,
    },
  },
  {
    structuralArtifactId: 1830002,
    sourceUrl: 'https://developers.google.com/search/docs/appearance?hl=pl',
    sourceLocator: 'human-review:batch-35:search-appearance-overview',
    artifactText: 'Google Search appearance guidance organizes the features that can affect how a website is represented in results, including titles, snippets, images, video, site names, translated results, and business details. Structured data gives Google explicit information about a page and can support eligible rich-result features across multiple content types. Teams should select only features that fit their content and implementation rather than treating markup as a promise of a specific search display.',
    qualityNote: '人工閱讀 Overview of Search appearance topics：摘要保留 appearance feature map、structured data 與 eligibility 邊界；官方頁尾標示 CC BY 4.0，PII extractor v4 為 none_detected。',
    labels: {
      annotationKind: 'seo_geo_multilabel', annotationVersion: 'seo-geo-journey-v1', primaryJourneyStage: 'discovery',
      journeyStages: ['discovery', 'understanding', 'progression'], searchIntents: ['informational', 'navigational'], contentTypes: ['editorial', 'service'], audienceRoles: ['researcher', 'practitioner', 'technical_evaluator', 'decision_maker'],
      topicClusters: ['search appearance', 'structured data', 'rich result eligibility', 'titles and snippets', 'content feature selection'],
      entitySignals: [
        { name: 'Google Search appearance', type: 'concept', relationship: 'Groups the documented result features that a content team may evaluate for fit.' },
        { name: 'Structured data', type: 'concept', relationship: 'Provides machine-readable page information that can support eligible search features.' },
        { name: 'Rich results', type: 'concept', relationship: 'Represents feature eligibility rather than a guaranteed presentation outcome.' },
      ],
      geoSignals: ['global', 'multilingual'], citationReadiness: ['first_party_expertise', 'dated_or_current', 'source_links', 'structured_data'], technicalSeoSignals: ['title_present', 'h1_present', 'canonical_present', 'indexable', 'structured_data', 'internal_routing', 'language_signal', 'performance_not_observed'], frictionSignals: ['information_overload', 'missing_next_step'], actionPriority: 'medium',
      annotationRationale: '此頁適合作為從結果外觀需求發現到結構化資料實作理解的連結，並清楚將 feature eligibility 與實際曝光結果分離。', reviewerConfidence: 5,
    },
  },
  {
    structuralArtifactId: 1830003,
    sourceUrl: 'https://developers.google.com/search/docs/essentials?hl=ja',
    sourceLocator: 'human-review:batch-35:google-search-essentials',
    artifactText: 'Google Search Essentials separates minimum technical requirements, spam policies, and key best practices for content that may be eligible to appear in Search. It emphasizes helpful people-first content, language that matches how users search, crawlable links, descriptive page elements, and feature-specific guidance for media, structured data, and JavaScript. Meeting requirements or adopting best practices does not guarantee crawling, indexing, serving, or a particular ranking outcome.',
    qualityNote: '人工閱讀 Google Search Essentials：摘要保留 technical requirements、spam policies、people-first content、crawlable links、metadata／media／JavaScript guidance 與非保證界線；官方頁尾標示 CC BY 4.0，PII extractor v4 為 none_detected。',
    labels: {
      annotationKind: 'seo_geo_multilabel', annotationVersion: 'seo-geo-journey-v1', primaryJourneyStage: 'progression',
      journeyStages: ['discovery', 'understanding', 'progression'], searchIntents: ['informational'], contentTypes: ['editorial', 'service'], audienceRoles: ['practitioner', 'technical_evaluator', 'decision_maker', 'researcher'],
      topicClusters: ['Search Essentials', 'technical requirements', 'spam policies', 'people-first content', 'crawlable links', 'search best practices'],
      entitySignals: [
        { name: 'Google Search Essentials', type: 'concept', relationship: 'Provides a policy and implementation framework for search-eligible public web content.' },
        { name: 'Spam policies', type: 'concept', relationship: 'Defines practices that may reduce visibility or remove content from results.' },
        { name: 'Crawlable links', type: 'concept', relationship: 'Connects page architecture to URL discovery and access for crawlers.' },
      ],
      geoSignals: ['global', 'multilingual'], citationReadiness: ['first_party_expertise', 'dated_or_current', 'source_links'], technicalSeoSignals: ['title_present', 'h1_present', 'canonical_present', 'indexable', 'structured_data', 'internal_routing', 'language_signal', 'performance_not_observed'], frictionSignals: ['missing_trust_signal', 'information_overload'], actionPriority: 'high',
      annotationRationale: '此頁把技術條件、內容品質與政策風險轉為可執行的網站改善脈絡，適合標註使用者從理解原則進展至落地實作的旅程。', reviewerConfidence: 5,
    },
  },
  {
    structuralArtifactId: 1830004,
    sourceUrl: 'https://developers.google.com/search/docs/monitor-debug/search-console-start',
    sourceLocator: 'human-review:batch-35:search-console-start',
    artifactText: 'Search Console helps website owners observe how Google crawls, indexes, and serves a site, then prioritize follow-up work. A practical starting sequence is to verify site ownership, inspect page discovery and indexing issues, optionally submit a sitemap, and monitor performance by queries, pages, and countries. The guidance maps common needs to reports for indexing, URL inspection, structured data, security, manual actions, migrations, and real-user page experience.',
    qualityNote: '人工閱讀 Get started with Search Console：摘要保留 ownership verification、indexing／sitemap／performance monitoring、query/page/country breakdown 與 report-based diagnostics；官方頁尾標示 CC BY 4.0，PII extractor v4 為 none_detected。',
    labels: {
      annotationKind: 'seo_geo_multilabel', annotationVersion: 'seo-geo-journey-v1', primaryJourneyStage: 'response',
      journeyStages: ['understanding', 'response', 'progression'], searchIntents: ['informational', 'navigational'], contentTypes: ['service', 'editorial', 'tool'], audienceRoles: ['practitioner', 'technical_evaluator', 'decision_maker', 'existing_customer'],
      topicClusters: ['Search Console onboarding', 'indexing reports', 'URL inspection', 'sitemap monitoring', 'search performance', 'technical diagnostics'],
      entitySignals: [
        { name: 'Search Console', type: 'service', relationship: 'Provides reports and tools for checking crawling, indexing, search performance, and site health.' },
        { name: 'URL Inspection tool', type: 'service', relationship: 'Supports page-level diagnosis of index status and loaded resources.' },
        { name: 'Search performance report', type: 'concept', relationship: 'Supports monitoring trends by query, page, and country.' },
      ],
      geoSignals: ['global', 'country', 'multilingual'], citationReadiness: ['first_party_expertise', 'dated_or_current', 'source_links', 'structured_data'], technicalSeoSignals: ['title_present', 'h1_present', 'canonical_present', 'indexable', 'structured_data', 'internal_routing', 'language_signal', 'performance_not_observed'], frictionSignals: ['information_overload', 'missing_next_step'], actionPriority: 'high',
      annotationRationale: '此頁將診斷意圖導向具體 Search Console 報表與行動，為技術或行銷團隊從問題辨識進入可回應、可監測工作流程的核心樣本。', reviewerConfidence: 5,
    },
  },
  {
    structuralArtifactId: 1830005,
    sourceUrl: 'https://developers.google.com/search/docs/monitor-debug/debugging-search-traffic-drops',
    sourceLocator: 'human-review:batch-35:debugging-search-traffic-drops',
    artifactText: 'When organic Search traffic declines, teams should distinguish algorithmic changes, technical access problems, security or spam issues, seasonality, changing demand, and site migrations before changing content. Search Console comparisons by dates, queries, pages, countries, devices, and search appearance help separate click and impression patterns, while index and URL inspection reports help locate technical causes. Persistent position changes should be assessed with user-focused content review and measured follow-up rather than radical reactive edits.',
    qualityNote: '人工閱讀 Debugging drops in Google Search traffic：摘要保留 traffic-drop cause categories、Search Console comparison dimensions、index／URL inspection diagnostics、seasonality 與避免過度反應的界線；官方頁尾標示 CC BY 4.0，PII extractor v4 為 none_detected。',
    labels: {
      annotationKind: 'seo_geo_multilabel', annotationVersion: 'seo-geo-journey-v1', primaryJourneyStage: 'response',
      journeyStages: ['understanding', 'response', 'progression'], searchIntents: ['informational'], contentTypes: ['editorial', 'service', 'tool'], audienceRoles: ['decision_maker', 'practitioner', 'technical_evaluator', 'researcher'],
      topicClusters: ['traffic drop diagnosis', 'search performance analysis', 'technical SEO issues', 'seasonality', 'algorithmic updates', 'site migration'],
      entitySignals: [
        { name: 'Search Console Performance report', type: 'concept', relationship: 'Supports comparative analysis of clicks, impressions, queries, pages, countries, and devices.' },
        { name: 'URL Inspection tool', type: 'service', relationship: 'Helps investigate page-level indexing conditions when a traffic decline is localized.' },
        { name: 'Google Trends', type: 'service', relationship: 'Helps differentiate site-specific traffic loss from broader changes in search demand.' },
      ],
      geoSignals: ['global', 'country', 'multilingual'], citationReadiness: ['first_party_expertise', 'dated_or_current', 'source_links'], technicalSeoSignals: ['title_present', 'h1_present', 'canonical_present', 'indexable', 'internal_routing', 'language_signal', 'performance_not_observed'], frictionSignals: ['information_overload', 'missing_next_step'], actionPriority: 'high',
      annotationRationale: '此頁提供從異常流量訊號到可驗證診斷步驟的回應框架，並強化以趨勢與技術證據取代單一排名或直覺式修正的使用者旅程洞察。', reviewerConfidence: 5,
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
    eq(publicIntelligenceArtifacts.id, annotation.structuralArtifactId), eq(publicIntelligenceArtifacts.sourceId, source.id), eq(publicIntelligenceArtifacts.artifactType, 'structural_features'), eq(publicIntelligenceArtifacts.sourceUrl, annotation.sourceUrl), isNull(publicIntelligenceArtifacts.removedAt),
  )).limit(1)
  if (!structural?.sourceSpanHash) throw new Error(`batch_35_structural_artifact_not_found:${annotation.structuralArtifactId}`)
  if (structural.piiStatus !== 'none_detected') throw new Error(`batch_35_pii_not_clear:${annotation.structuralArtifactId}`)
  if (structural.qualityStatus !== 'passed') await reviewOwnerPublicArtifact({ ownerUserId: source.ownerUserId, artifactId: structural.id, qualityStatus: 'passed', qualityNote: annotation.qualityNote })

  const labels = seoGeoMultilabelSchema.parse(annotation.labels)
  const [existing] = await database.select({ id: publicIntelligenceArtifacts.id, qualityStatus: publicIntelligenceArtifacts.qualityStatus }).from(publicIntelligenceArtifacts).where(and(
    eq(publicIntelligenceArtifacts.sourceId, source.id), eq(publicIntelligenceArtifacts.artifactType, 'human_annotation'), eq(publicIntelligenceArtifacts.sourceUrl, annotation.sourceUrl), isNull(publicIntelligenceArtifacts.removedAt),
  )).limit(1)
  const human = existing || await createOwnerPublicArtifact({ ownerUserId: source.ownerUserId, sourceId: source.id, sourceUrl: annotation.sourceUrl, canonicalUrl: annotation.sourceUrl, artifactType: 'human_annotation', artifactText: annotation.artifactText, sourceLocator: annotation.sourceLocator, sourceSpanHash: structural.sourceSpanHash, fieldData: labels, language: 'en', extractionMethod: 'human_annotation', requestedUse: 'training_candidate', retentionUntil: source.retentionUntil })
  if (human.qualityStatus !== 'passed') await reviewOwnerPublicArtifact({ ownerUserId: source.ownerUserId, artifactId: human.id, qualityStatus: 'passed', qualityNote: annotation.qualityNote })
  console.log(JSON.stringify({ sourceUrl: annotation.sourceUrl, structuralArtifactId: structural.id, humanAnnotationId: human.id, primaryJourneyStage: labels.primaryJourneyStage, status: existing ? 'retained_existing' : 'passed' }))
}

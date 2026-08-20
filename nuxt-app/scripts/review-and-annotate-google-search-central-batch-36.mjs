import { and, eq, isNull } from 'drizzle-orm'
import { getDatabase } from '../server/database/index.ts'
import { publicIntelligenceArtifacts, publicIntelligenceSources } from '../server/database/schema.ts'
import { createOwnerPublicArtifact, reviewOwnerPublicArtifact } from '../server/public-intelligence/repository.ts'
import { seoGeoMultilabelSchema } from '../server/public-intelligence/seoGeoTaxonomy.ts'

const annotations = [
  {
    structuralArtifactId: 1890001,
    sourceUrl: 'https://developers.google.com/search/docs/monitor-debug/bubble-chart-analysis?hl=hi',
    sourceLocator: 'human-review:batch-36:search-console-bubble-chart-analysis',
    artifactText: 'Google Search Console performance data can be organized as a bubble chart to compare query click-through rate, average position, clicks, country, and device context. The chart makes high-opportunity patterns visible: queries that already receive relevant clicks at lower positions, high-impression low-CTR queries, and differences between mobile and desktop behavior. Teams should inspect the underlying queries and landing pages, then improve content, titles, descriptions, headings, or relevant coverage based on evidence instead of treating a chart quadrant as an automatic ranking prescription.',
    qualityNote: '人工閱讀 Improving SEO with a Search Console bubble chart：摘要保留 query／CTR／position／clicks、country／device segmentation、opportunity quadrants 與 evidence-based content follow-up；官方頁尾標示 CC BY 4.0，PII extractor v4 為 none_detected。',
    labels: {
      annotationKind: 'seo_geo_multilabel', annotationVersion: 'seo-geo-journey-v1', primaryJourneyStage: 'response',
      journeyStages: ['understanding', 'response', 'progression', 'conversion'], searchIntents: ['informational'], contentTypes: ['editorial', 'tool', 'service'], audienceRoles: ['practitioner', 'technical_evaluator', 'decision_maker', 'researcher'],
      topicClusters: ['Search Console analytics', 'bubble chart analysis', 'click-through rate', 'average position', 'query optimization', 'device segmentation'],
      entitySignals: [
        { name: 'Search Console', type: 'service', relationship: 'Supplies the search-performance dimensions used to inspect query and page opportunities.' },
        { name: 'Looker Studio', type: 'service', relationship: 'Supports visual comparison of Search Console query metrics across filters and dimensions.' },
        { name: 'Click-through rate', type: 'concept', relationship: 'Acts as a behavioral signal that should be interpreted with position, clicks, and query relevance.' },
      ],
      geoSignals: ['global', 'country', 'multilingual'], citationReadiness: ['first_party_expertise', 'dated_or_current', 'source_links'], technicalSeoSignals: ['title_present', 'h1_present', 'canonical_present', 'indexable', 'internal_routing', 'language_signal', 'performance_not_observed'], frictionSignals: ['information_overload', 'missing_next_step'], actionPriority: 'high',
      annotationRationale: '此頁將搜尋成效資料轉為可辨識的查詢與裝置差異，讓團隊能從觀察問題進入以內容與頁面證據為依據的改善回應。', reviewerConfidence: 5,
    },
  },
  {
    structuralArtifactId: 1890002,
    sourceUrl: 'https://developers.google.com/search/docs/monitor-debug/search-operators',
    sourceLocator: 'human-review:batch-36:search-operators',
    artifactText: 'Google Search operators such as site:, filetype:, imagesize:, and src: can provide a bounded exploratory view of a website’s indexed files, images, or URL prefixes. They are useful for spotting questions such as whether a file type appears or whether a domain shows unexpected content, but operator results are constrained by indexing and retrieval limits. For dependable page-level diagnosis, site teams should use Search Console URL Inspection rather than treating an operator result as definitive index status evidence.',
    qualityNote: '人工閱讀 Overview of Google search operators：摘要保留 site/filetype/imagesize/src 用途與 indexing/retrieval limits，並將 URL Inspection 定位為較可靠的 page-level diagnosis；官方頁尾標示 CC BY 4.0，PII extractor v4 為 none_detected。',
    labels: {
      annotationKind: 'seo_geo_multilabel', annotationVersion: 'seo-geo-journey-v1', primaryJourneyStage: 'response',
      journeyStages: ['understanding', 'response'], searchIntents: ['informational', 'navigational'], contentTypes: ['editorial', 'tool'], audienceRoles: ['practitioner', 'technical_evaluator', 'researcher'],
      topicClusters: ['search operators', 'site operator', 'file type inspection', 'image discovery', 'indexing diagnostics', 'URL Inspection'],
      entitySignals: [
        { name: 'Google Search operators', type: 'service', relationship: 'Provide query syntax for exploratory inspection of indexed results and assets.' },
        { name: 'URL Inspection', type: 'service', relationship: 'Provides more reliable page-level diagnostics than retrieval-limited search-operator results.' },
        { name: 'Indexing and retrieval limits', type: 'concept', relationship: 'Explain why operator output should not be treated as a definitive coverage report.' },
      ],
      geoSignals: ['global', 'multilingual'], citationReadiness: ['first_party_expertise', 'dated_or_current', 'source_links'], technicalSeoSignals: ['title_present', 'h1_present', 'canonical_present', 'indexable', 'internal_routing', 'language_signal', 'performance_not_observed'], frictionSignals: ['missing_next_step', 'information_overload'], actionPriority: 'medium',
      annotationRationale: '此頁提供低成本的探索式檢視方法，同時清楚界定 operator 與 URL Inspection 的證據強度差異，適合標註技術診斷的回應旅程。', reviewerConfidence: 5,
    },
  },
  {
    structuralArtifactId: 1890003,
    sourceUrl: 'https://developers.google.com/search/docs/crawling-indexing/amp',
    sourceLocator: 'human-review:batch-36:amp-on-google-search',
    artifactText: 'Google Search indexes AMP pages under the same general standards as other pages. AMP content can be eligible for rich results or Web Stories when it follows feature requirements, but structured data does not guarantee a particular presentation. A site should keep AMP and canonical pages aligned in content and actions, use an understandable related URL scheme, validate AMP output, and design for responsive access across device types rather than assuming AMP is mobile-only.',
    qualityNote: '人工閱讀 About AMP on Google Search：摘要保留 AMP indexing parity、rich-result eligibility boundary、canonical content/action parity、URL clarity、validation 與 responsive device guidance；官方頁尾標示 CC BY 4.0，PII extractor v4 為 none_detected。',
    labels: {
      annotationKind: 'seo_geo_multilabel', annotationVersion: 'seo-geo-journey-v1', primaryJourneyStage: 'conversion',
      journeyStages: ['discovery', 'understanding', 'progression', 'conversion'], searchIntents: ['informational'], contentTypes: ['editorial', 'service'], audienceRoles: ['practitioner', 'technical_evaluator', 'decision_maker', 'researcher'],
      topicClusters: ['AMP SEO', 'canonical parity', 'rich result eligibility', 'structured data guidance', 'responsive design', 'URL clarity'],
      entitySignals: [
        { name: 'AMP', type: 'concept', relationship: 'Represents an implementation format that is indexed under general Search standards.' },
        { name: 'Canonical page', type: 'concept', relationship: 'Sets the expected parity of content and user actions for related AMP content.' },
        { name: 'Rich results', type: 'concept', relationship: 'Represents a conditional feature outcome rather than a guaranteed display.' },
      ],
      geoSignals: ['global', 'multilingual'], citationReadiness: ['first_party_expertise', 'dated_or_current', 'source_links', 'structured_data'], technicalSeoSignals: ['title_present', 'h1_present', 'canonical_present', 'indexable', 'structured_data', 'internal_routing', 'language_signal', 'performance_not_observed'], frictionSignals: ['missing_trust_signal', 'information_overload'], actionPriority: 'medium',
      annotationRationale: '此頁把 AMP 技術選擇連結到跨裝置內容一致性、URL 可理解性與 feature eligibility，適合描述網站團隊從技術評估走向可部署體驗的旅程。', reviewerConfidence: 5,
    },
  },
  {
    structuralArtifactId: 1890004,
    sourceUrl: 'https://developers.google.com/search/docs/crawling-indexing/amp/validate-amp',
    sourceLocator: 'human-review:batch-36:validate-amp-content',
    artifactText: 'AMP validation should combine the AMP Test Tool, Rich Results Test when relevant, and the Search Console AMP status report. When a page does not appear in Search, teams should check discoverability through links and amphtml or canonical relationships, allow Googlebot to reach the canonical page, AMP page, and referenced resources, review robots and X-Robots-Tag directives, and verify applicable structured data. Availability of a Search feature can also vary by country, so validation evidence should distinguish implementation faults from feature availability.',
    qualityNote: '人工閱讀 Validate your AMP content：摘要保留 AMP Test／Rich Results Test／AMP report、discovery、canonical/amphtml、Googlebot access、robots/X-Robots-Tag、structured data 與 country availability 邊界；官方頁尾標示 CC BY 4.0，PII extractor v4 為 none_detected。',
    labels: {
      annotationKind: 'seo_geo_multilabel', annotationVersion: 'seo-geo-journey-v1', primaryJourneyStage: 'response',
      journeyStages: ['understanding', 'response', 'progression'], searchIntents: ['informational'], contentTypes: ['editorial', 'tool', 'service'], audienceRoles: ['practitioner', 'technical_evaluator', 'decision_maker'],
      topicClusters: ['AMP validation', 'Rich Results Test', 'AMP status report', 'Googlebot access', 'robots directives', 'structured data diagnostics'],
      entitySignals: [
        { name: 'AMP Test Tool', type: 'service', relationship: 'Checks whether AMP content conforms to the expected technical format.' },
        { name: 'Rich Results Test', type: 'service', relationship: 'Helps verify parsing of applicable structured data on eligible content.' },
        { name: 'X-Robots-Tag', type: 'concept', relationship: 'Can block or alter indexing behavior when applied to canonical or AMP resources.' },
      ],
      geoSignals: ['global', 'country', 'multilingual'], citationReadiness: ['first_party_expertise', 'dated_or_current', 'source_links', 'structured_data'], technicalSeoSignals: ['title_present', 'h1_present', 'canonical_present', 'indexable', 'structured_data', 'internal_routing', 'language_signal', 'performance_not_observed'], frictionSignals: ['missing_next_step', 'information_overload'], actionPriority: 'high',
      annotationRationale: '此頁提供從 AMP 缺乏曝光到工具、可發現性、存取權限與標記條件的分層檢查順序，適合作為多維技術診斷回應樣本。', reviewerConfidence: 5,
    },
  },
  {
    structuralArtifactId: 1890005,
    sourceUrl: 'https://developers.google.com/search/docs/crawling-indexing/website-testing',
    sourceLocator: 'human-review:batch-36:minimize-ab-testing-impact',
    artifactText: 'Website A/B and multivariate testing can compare changes in page content, URLs, layout, or calls to action, but experiments should avoid misleading Googlebot or users. Search-safe practice is to avoid cloaking, use rel=canonical on alternate test URLs, prefer temporary 302 rather than permanent 301 redirects for short-lived variations, and end the experiment once a reliable result is available. These controls preserve the original page as the intended indexed representative while allowing teams to learn which user experience performs better.',
    qualityNote: '人工閱讀 Minimize A/B testing impact in Google Search：摘要保留 A/B／multivariate testing、anti-cloaking、canonical grouping、302 temporary redirect 與 limited experiment duration；官方頁尾標示 CC BY 4.0，PII extractor v4 為 none_detected。',
    labels: {
      annotationKind: 'seo_geo_multilabel', annotationVersion: 'seo-geo-journey-v1', primaryJourneyStage: 'conversion',
      journeyStages: ['response', 'progression', 'conversion'], searchIntents: ['informational', 'commercial'], contentTypes: ['editorial', 'service'], audienceRoles: ['decision_maker', 'practitioner', 'technical_evaluator', 'researcher'],
      topicClusters: ['A/B testing', 'multivariate testing', 'cloaking avoidance', 'canonical URLs', 'temporary redirects', 'conversion optimization'],
      entitySignals: [
        { name: 'A/B testing', type: 'concept', relationship: 'Compares website variations while measuring user behavior and conversion-oriented outcomes.' },
        { name: 'Canonical URL', type: 'concept', relationship: 'Identifies the preferred original page among temporary experimental URL variations.' },
        { name: 'Temporary redirect', type: 'concept', relationship: 'Signals a short-lived experiment without replacing the intended indexed page.' },
      ],
      geoSignals: ['global', 'multilingual'], citationReadiness: ['first_party_expertise', 'dated_or_current', 'source_links'], technicalSeoSignals: ['title_present', 'h1_present', 'canonical_present', 'indexable', 'internal_routing', 'language_signal', 'performance_not_observed'], frictionSignals: ['missing_trust_signal', 'missing_next_step'], actionPriority: 'high',
      annotationRationale: '此頁將轉換實驗連結到 crawler-visible consistency、canonicalization 與 temporary redirects，讓成效改善不以誤導搜尋引擎為代價。', reviewerConfidence: 5,
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
  if (!structural?.sourceSpanHash) throw new Error(`batch_36_structural_artifact_not_found:${annotation.structuralArtifactId}`)
  if (structural.piiStatus !== 'none_detected') throw new Error(`batch_36_pii_not_clear:${annotation.structuralArtifactId}`)
  if (structural.qualityStatus !== 'passed') await reviewOwnerPublicArtifact({ ownerUserId: source.ownerUserId, artifactId: structural.id, qualityStatus: 'passed', qualityNote: annotation.qualityNote })

  const labels = seoGeoMultilabelSchema.parse(annotation.labels)
  const [existing] = await database.select({ id: publicIntelligenceArtifacts.id, qualityStatus: publicIntelligenceArtifacts.qualityStatus }).from(publicIntelligenceArtifacts).where(and(
    eq(publicIntelligenceArtifacts.sourceId, source.id), eq(publicIntelligenceArtifacts.artifactType, 'human_annotation'), eq(publicIntelligenceArtifacts.sourceUrl, annotation.sourceUrl), isNull(publicIntelligenceArtifacts.removedAt),
  )).limit(1)
  const human = existing || await createOwnerPublicArtifact({ ownerUserId: source.ownerUserId, sourceId: source.id, sourceUrl: annotation.sourceUrl, canonicalUrl: annotation.sourceUrl, artifactType: 'human_annotation', artifactText: annotation.artifactText, sourceLocator: annotation.sourceLocator, sourceSpanHash: structural.sourceSpanHash, fieldData: labels, language: 'en', extractionMethod: 'human_annotation', requestedUse: 'training_candidate', retentionUntil: source.retentionUntil })
  if (human.qualityStatus !== 'passed') await reviewOwnerPublicArtifact({ ownerUserId: source.ownerUserId, artifactId: human.id, qualityStatus: 'passed', qualityNote: annotation.qualityNote })
  console.log(JSON.stringify({ sourceUrl: annotation.sourceUrl, structuralArtifactId: structural.id, humanAnnotationId: human.id, primaryJourneyStage: labels.primaryJourneyStage, status: existing ? 'retained_existing' : 'passed' }))
}

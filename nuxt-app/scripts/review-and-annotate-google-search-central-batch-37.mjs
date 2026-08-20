import { and, eq, isNull } from 'drizzle-orm'
import { getDatabase } from '../server/database/index.ts'
import { publicIntelligenceArtifacts, publicIntelligenceSources } from '../server/database/schema.ts'
import { createOwnerPublicArtifact, reviewOwnerPublicArtifact } from '../server/public-intelligence/repository.ts'
import { seoGeoMultilabelSchema } from '../server/public-intelligence/seoGeoTaxonomy.ts'

const annotations = [
  {
    structuralArtifactId: 1950001,
    sourceUrl: 'https://developers.google.com/search/docs/crawling-indexing/control-what-you-share',
    sourceLocator: 'human-review:batch-37:control-what-you-share',
    artifactText: 'Google Search content control starts by distinguishing removal from access restriction, crawl blocking, indexing control, and search-feature opt-out. Removing material from a site is the strongest way to eliminate it from Search, while confidential material needs password protection. For accessible web content, noindex prevents result inclusion, whereas robots.txt primarily limits crawler access and does not substitute for access control. Large sites can focus crawling on important content by handling duplicate or lower-value pages deliberately.',
    qualityNote: '人工閱讀 Control what you share with Google：摘要保留 removal、password protection、noindex、robots.txt、feature opt-out、duplicate/low-value content 與 crawler focus 的差異；官方頁尾標示 CC BY 4.0，PII extractor v4 為 none_detected。',
    labels: {
      annotationKind: 'seo_geo_multilabel', annotationVersion: 'seo-geo-journey-v1', primaryJourneyStage: 'progression',
      journeyStages: ['understanding', 'response', 'progression'], searchIntents: ['informational'], contentTypes: ['editorial', 'service'], audienceRoles: ['practitioner', 'technical_evaluator', 'decision_maker', 'researcher'],
      topicClusters: ['content visibility control', 'noindex', 'robots.txt', 'private content access', 'duplicate content', 'search-result removal'],
      entitySignals: [
        { name: 'noindex', type: 'concept', relationship: 'Controls whether accessible content is eligible to appear in Google Search results.' },
        { name: 'robots.txt', type: 'concept', relationship: 'Limits crawler access to selected resources but does not replace access control for confidential content.' },
        { name: 'Google Search', type: 'service', relationship: 'Represents the search surface where site owners manage visibility and removal outcomes.' },
      ],
      geoSignals: ['global', 'multilingual'], citationReadiness: ['first_party_expertise', 'dated_or_current', 'source_links'], technicalSeoSignals: ['title_present', 'h1_present', 'canonical_present', 'indexable', 'internal_routing', 'language_signal', 'performance_not_observed'], frictionSignals: ['missing_next_step', 'information_overload'], actionPriority: 'high',
      annotationRationale: '此頁將內容可見性控制拆成存取、爬取、索引與移除等可執行決策，適合標註網站團隊由理解風險走向治理落地的 progression 旅程。', reviewerConfidence: 5,
    },
  },
  {
    structuralArtifactId: 1950002,
    sourceUrl: 'https://developers.google.com/search/docs/appearance/publication-dates',
    sourceLocator: 'human-review:batch-37:publication-dates',
    artifactText: 'Google can estimate a page or video byline date from several signals and does not guarantee a displayed date. Publishers can provide a prominent user-visible publication or update date and align it with datePublished or dateModified structured data. Date values should be consistent, describe the page rather than an event mentioned in it, avoid future dates, and use a correct timezone when a time is supplied. Clear date signals help Search process timely content without turning any one markup field into a display guarantee.',
    qualityNote: '人工閱讀 Influence your byline dates in Google Search：摘要保留 visible date、datePublished/dateModified、multi-signal non-guarantee、consistency、timezone、future-date avoidance與 page/event date distinction；官方頁尾標示 CC BY 4.0，PII extractor v4 為 none_detected，ISO 日期時間範例未誤判為電話。',
    labels: {
      annotationKind: 'seo_geo_multilabel', annotationVersion: 'seo-geo-journey-v1', primaryJourneyStage: 'discovery',
      journeyStages: ['discovery', 'understanding', 'progression'], searchIntents: ['informational'], contentTypes: ['editorial', 'service'], audienceRoles: ['practitioner', 'technical_evaluator', 'researcher', 'media_or_partner'],
      topicClusters: ['byline dates', 'publication dates', 'dateModified', 'structured data', 'content freshness', 'timezone consistency'],
      entitySignals: [
        { name: 'datePublished', type: 'concept', relationship: 'Provides structured publication-date information that should agree with visible page signals.' },
        { name: 'dateModified', type: 'concept', relationship: 'Provides structured update-date information when a page has been significantly revised.' },
        { name: 'Google Search', type: 'service', relationship: 'May show an estimated byline date after evaluating multiple content and markup signals.' },
      ],
      geoSignals: ['global', 'multilingual'], citationReadiness: ['first_party_expertise', 'dated_or_current', 'source_links', 'structured_data'], technicalSeoSignals: ['title_present', 'h1_present', 'canonical_present', 'indexable', 'structured_data', 'internal_routing', 'language_signal', 'performance_not_observed'], frictionSignals: ['missing_trust_signal', 'information_overload'], actionPriority: 'medium',
      annotationRationale: '此頁讓內容發布與更新時間成為可驗證的搜尋呈現訊號，同時保留多訊號估計與非保證呈現的邊界，適合 discovery 多維標註。', reviewerConfidence: 5,
    },
  },
  {
    structuralArtifactId: 1950003,
    sourceUrl: 'https://developers.google.com/search/docs/appearance/sitelinks',
    sourceLocator: 'human-review:batch-37:sitelinks',
    artifactText: 'Sitelinks are automated same-domain links that can appear under a text result when Google believes they help users reach relevant information faster. A site can improve the inputs to this process with informative compact titles and headings, logical navigation, relevant internal links with concise anchor text, and non-repetitive content. Site owners cannot demand a sitelink; if a page must not appear, removal or noindex is the appropriate control rather than assuming a manual sitelink setting exists.',
    qualityNote: '人工閱讀 Sitelinks：摘要保留 automated/non-guaranteed boundary、same-domain result grouping、titles/headings、logical site structure、internal anchor text、content repetition與 noindex/removal path；官方頁尾標示 CC BY 4.0，PII extractor v4 為 none_detected。',
    labels: {
      annotationKind: 'seo_geo_multilabel', annotationVersion: 'seo-geo-journey-v1', primaryJourneyStage: 'discovery',
      journeyStages: ['discovery', 'understanding', 'progression'], searchIntents: ['informational', 'navigational'], contentTypes: ['editorial', 'service'], audienceRoles: ['practitioner', 'technical_evaluator', 'decision_maker', 'researcher'],
      topicClusters: ['sitelinks', 'internal linking', 'anchor text', 'site navigation', 'title links', 'search appearance'],
      entitySignals: [
        { name: 'Sitelinks', type: 'concept', relationship: 'Represent automated same-domain shortcuts that may appear under a useful text result.' },
        { name: 'Internal links', type: 'concept', relationship: 'Help expose important pages and their relevance through site structure and anchor text.' },
        { name: 'Google Search', type: 'service', relationship: 'Determines whether sitelinks are useful enough to show for a result.' },
      ],
      geoSignals: ['global', 'multilingual'], citationReadiness: ['first_party_expertise', 'dated_or_current', 'source_links'], technicalSeoSignals: ['title_present', 'h1_present', 'canonical_present', 'indexable', 'internal_routing', 'language_signal', 'performance_not_observed'], frictionSignals: ['unclear_value', 'information_overload'], actionPriority: 'medium',
      annotationRationale: '此頁把搜尋結果中的網站捷徑連結到資訊架構、內部連結與使用者導覽，但不把自動化呈現誤標為保證結果，適合作為 discovery 樣本。', reviewerConfidence: 5,
    },
  },
  {
    structuralArtifactId: 1950004,
    sourceUrl: 'https://developers.google.com/search/docs/appearance/translated-results',
    sourceLocator: 'human-review:batch-37:translated-results',
    artifactText: 'Translated results can show a machine-translated title link and snippet when a result is not in the searcher’s language, while preserving access to the original result and original page. The feature can work with page JavaScript and embedded media, and publishers can monitor translated-result clicks and impressions with the Search Appearance filter in Search Console. Participation is automatic across pages, but a publisher can opt out of translation features using the notranslate robots rule as a meta tag or HTTP header.',
    qualityNote: '人工閱讀 Translated results in Google Search：摘要保留 language/perspective gap、machine-translated title/snippet、original result access、JavaScript/media behavior、Search Console monitoring與 notranslate meta/header opt-out；官方頁尾標示 CC BY 4.0，PII extractor v4 為 none_detected。',
    labels: {
      annotationKind: 'seo_geo_multilabel', annotationVersion: 'seo-geo-journey-v1', primaryJourneyStage: 'understanding',
      journeyStages: ['discovery', 'understanding', 'response'], searchIntents: ['informational'], contentTypes: ['editorial', 'service'], audienceRoles: ['practitioner', 'technical_evaluator', 'decision_maker', 'media_or_partner'],
      topicClusters: ['translated search results', 'multilingual SEO', 'notranslate', 'Search Console monitoring', 'machine translation', 'search appearance'],
      entitySignals: [
        { name: 'Translated results', type: 'concept', relationship: 'Provide a translated search-result view when the original result language differs from a user query.' },
        { name: 'notranslate', type: 'concept', relationship: 'Lets publishers opt out of translation-related Search features through robots metadata or an HTTP header.' },
        { name: 'Search Console', type: 'service', relationship: 'Provides Search Appearance reporting for translated-result clicks and impressions.' },
      ],
      geoSignals: ['global', 'country', 'multilingual'], citationReadiness: ['first_party_expertise', 'dated_or_current', 'source_links'], technicalSeoSignals: ['title_present', 'h1_present', 'canonical_present', 'indexable', 'internal_routing', 'language_signal', 'performance_not_observed'], frictionSignals: ['missing_trust_signal', 'information_overload'], actionPriority: 'medium',
      annotationRationale: '此頁以語言可近性、跨語搜尋呈現、測量與 opt-out 為中心，提供國際化內容團隊理解功能邊界與控制方法的多維樣本。', reviewerConfidence: 5,
    },
  },
  {
    structuralArtifactId: 1950005,
    sourceUrl: 'https://developers.google.com/search/docs/appearance/flexible-sampling?hl=th',
    sourceLocator: 'human-review:batch-37:flexible-sampling',
    artifactText: 'Flexible Sampling guidance distinguishes metering from lead-in access for paywalled publisher content. Metering gives a quota before subscription or registration barriers appear, while a lead-in exposes part of an article so users can evaluate its value. Publishers should test cautiously, assess referral traffic and conversion, avoid treating one quota as universally optimal, and use structured data to indicate paywalled content so Google can distinguish legitimate access controls from cloaking. The goal is to balance user experience, subscription models, and accurate crawler-visible representation.',
    qualityNote: '人工閱讀 Flexible Sampling general guidance：摘要保留 metering/lead-in、paywall UX、subscriber conversion、publisher-specific testing、referral traffic與 structured data anti-cloaking distinction；官方頁尾標示 CC BY 4.0，PII extractor v4 為 none_detected。實際 final URL 含 `hl=th`，但 canonical source identity 會移除語言參數後去重。',
    labels: {
      annotationKind: 'seo_geo_multilabel', annotationVersion: 'seo-geo-journey-v1', primaryJourneyStage: 'conversion',
      journeyStages: ['understanding', 'progression', 'conversion'], searchIntents: ['informational', 'commercial'], contentTypes: ['editorial', 'service', 'pricing'], audienceRoles: ['buyer', 'decision_maker', 'practitioner', 'technical_evaluator', 'researcher'],
      topicClusters: ['flexible sampling', 'paywalls', 'metering', 'lead-in content', 'subscription conversion', 'paywalled structured data'],
      entitySignals: [
        { name: 'Flexible Sampling', type: 'concept', relationship: 'Describes publisher access patterns that balance content exposure with subscription conversion.' },
        { name: 'Paywalled content', type: 'concept', relationship: 'Requires structured-data signaling so legitimate access restrictions are not confused with cloaking.' },
        { name: 'Google Search', type: 'service', relationship: 'Consumes crawler-visible content signals when interpreting access controls and result eligibility.' },
      ],
      geoSignals: ['global', 'multilingual'], citationReadiness: ['first_party_expertise', 'dated_or_current', 'source_links', 'structured_data'], technicalSeoSignals: ['title_present', 'h1_present', 'canonical_present', 'indexable', 'structured_data', 'internal_routing', 'language_signal', 'performance_not_observed'], frictionSignals: ['unclear_value', 'missing_trust_signal', 'missing_next_step'], actionPriority: 'high',
      annotationRationale: '此頁把付費牆可近性、內容價值溝通、訂閱轉換與 crawler-visible structured data 連成一個可實作的 conversion 旅程，同時保留實驗須因業務而異的限制。', reviewerConfidence: 5,
    },
  },
]

const database = getDatabase()
if (!database) throw new Error('database_unavailable')

const [source] = await database
  .select({ id: publicIntelligenceSources.id, ownerUserId: publicIntelligenceSources.ownerUserId, retentionUntil: publicIntelligenceSources.retentionUntil })
  .from(publicIntelligenceSources)
  .where(
    and(
      eq(publicIntelligenceSources.sourceName, 'Google Search Central Documentation（CC BY 4.0）'),
      eq(publicIntelligenceSources.reviewStatus, 'approved'),
      eq(publicIntelligenceSources.allowedUse, 'training_candidate'),
      eq(publicIntelligenceSources.robotsStatus, 'reviewed_allow'),
      eq(publicIntelligenceSources.termsStatus, 'allows_training'),
      eq(publicIntelligenceSources.copyrightRisk, 'low'),
      eq(publicIntelligenceSources.piiStatus, 'none_detected'),
      isNull(publicIntelligenceSources.removedAt),
    ),
  )
  .limit(1)

if (!source) throw new Error('approved_google_search_central_source_not_found')

for (const annotation of annotations) {
  const [structural] = await database
    .select({ id: publicIntelligenceArtifacts.id, sourceSpanHash: publicIntelligenceArtifacts.sourceSpanHash, qualityStatus: publicIntelligenceArtifacts.qualityStatus, piiStatus: publicIntelligenceArtifacts.piiStatus })
    .from(publicIntelligenceArtifacts)
    .where(
      and(
        eq(publicIntelligenceArtifacts.id, annotation.structuralArtifactId),
        eq(publicIntelligenceArtifacts.sourceId, source.id),
        eq(publicIntelligenceArtifacts.artifactType, 'structural_features'),
        eq(publicIntelligenceArtifacts.sourceUrl, annotation.sourceUrl),
        isNull(publicIntelligenceArtifacts.removedAt),
      ),
    )
    .limit(1)

  if (!structural?.sourceSpanHash) throw new Error(`batch_37_structural_artifact_not_found:${annotation.structuralArtifactId}`)
  if (structural.piiStatus !== 'none_detected') throw new Error(`batch_37_pii_not_clear:${annotation.structuralArtifactId}`)
  if (structural.qualityStatus !== 'passed') {
    await reviewOwnerPublicArtifact({ ownerUserId: source.ownerUserId, artifactId: structural.id, qualityStatus: 'passed', qualityNote: annotation.qualityNote })
  }

  const labels = seoGeoMultilabelSchema.parse(annotation.labels)
  const [existing] = await database
    .select({ id: publicIntelligenceArtifacts.id, qualityStatus: publicIntelligenceArtifacts.qualityStatus })
    .from(publicIntelligenceArtifacts)
    .where(
      and(
        eq(publicIntelligenceArtifacts.sourceId, source.id),
        eq(publicIntelligenceArtifacts.artifactType, 'human_annotation'),
        eq(publicIntelligenceArtifacts.sourceUrl, annotation.sourceUrl),
        isNull(publicIntelligenceArtifacts.removedAt),
      ),
    )
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

import { and, eq, isNull } from 'drizzle-orm'
import { getDatabase } from '../server/database/index.ts'
import { publicIntelligenceArtifacts, publicIntelligenceSources } from '../server/database/schema.ts'
import { createOwnerPublicArtifact, reviewOwnerPublicArtifact } from '../server/public-intelligence/repository.ts'
import { seoGeoMultilabelSchema } from '../server/public-intelligence/seoGeoTaxonomy.ts'

const annotations = [
  {
    structuralArtifactId: 1560001,
    sourceUrl: 'https://developers.google.com/search/docs/appearance/structured-data?hl=en',
    sourceLocator: 'human-review:batch-30:structured-data-overview',
    artifactText: 'Structured data is a standardized way to describe page content so search systems can better understand eligible information. Use the documented vocabulary and test markup before deployment, then monitor implementation quality over time. Rich-result eligibility and visible appearance depend on multiple conditions, so valid markup is not a guarantee of crawling, indexing, ranking, or a particular display. Treat structured data as a content-understanding and maintenance signal, not as a shortcut to a promised outcome.',
    qualityNote: '人工閱讀 Structured data overview：摘要保留 standardized markup、testing、monitoring 與 rich-result eligibility 的非保證邊界；未含 PII，且不把 markup 表述為排名、收錄或顯示保證。',
    labels: {
      annotationKind: 'seo_geo_multilabel', annotationVersion: 'seo-geo-journey-v1', primaryJourneyStage: 'discovery',
      journeyStages: ['discovery', 'understanding', 'response'], searchIntents: ['informational', 'commercial'], contentTypes: ['editorial', 'tool'], audienceRoles: ['researcher', 'practitioner', 'technical_evaluator', 'decision_maker'],
      topicClusters: ['structured data overview', 'search content understanding', 'rich result eligibility', 'markup testing', 'implementation monitoring'],
      entitySignals: [
        { name: 'Structured data', type: 'concept', relationship: 'Provides a standardized representation of page information for supported search features.' },
        { name: 'Google Search', type: 'service', relationship: 'May use eligible structured information to understand content and determine available search appearances.' },
        { name: 'Rich results', type: 'concept', relationship: 'Are conditional search appearances rather than a guaranteed output of valid markup.' },
      ],
      geoSignals: ['global', 'not_applicable'], citationReadiness: ['first_party_expertise', 'dated_or_current', 'source_links', 'structured_data'], technicalSeoSignals: ['title_present', 'h1_present', 'canonical_present', 'indexable', 'structured_data', 'internal_routing', 'performance_not_observed'], frictionSignals: ['information_overload', 'missing_trust_signal', 'missing_next_step'], actionPriority: 'medium',
      annotationRationale: '本頁將 structured data 的內容理解、測試與維護工作映射為 discovery-stage 的技術診斷訊號，並保留 eligibility 與實際呈現之間沒有保證的界線。', reviewerConfidence: 5,
    },
  },
  {
    structuralArtifactId: 1560002,
    sourceUrl: 'https://developers.google.com/search/docs/appearance/preferred-sources?hl=en',
    sourceLocator: 'human-review:batch-30:preferred-sources',
    artifactText: 'Preferred Sources lets eligible people choose publications they want to see more often in the Top Stories section for relevant topics. Publishers can help readers recognize a publication by using clear site names, consistent branding, and discoverable source information, but they cannot force a selection or guarantee visibility. Evaluate the feature as a reader-preference and source-identity signal, while keeping editorial quality and topic relevance central to content decisions.',
    qualityNote: '人工閱讀 Preferred Sources：摘要保留 reader preference、Top Stories、publication identity、branding 與不可強制或保證可見性的邊界；未含 PII，且不將 feature 表述為流量或排名保證。',
    labels: {
      annotationKind: 'seo_geo_multilabel', annotationVersion: 'seo-geo-journey-v1', primaryJourneyStage: 'discovery',
      journeyStages: ['discovery', 'understanding', 'conversion'], searchIntents: ['informational', 'navigational'], contentTypes: ['editorial', 'other'], audienceRoles: ['researcher', 'media_or_partner', 'decision_maker', 'practitioner'],
      topicClusters: ['preferred sources', 'Top Stories', 'publication identity', 'reader preference', 'source branding'],
      entitySignals: [
        { name: 'Preferred Sources', type: 'concept', relationship: 'Allows eligible readers to indicate publications they want to encounter more often for relevant topics.' },
        { name: 'Top Stories', type: 'concept', relationship: 'Is a search appearance context where reader-selected source preferences may be considered.' },
        { name: 'Publication identity', type: 'concept', relationship: 'Uses clear site naming and branding to help readers recognize an editorial source.' },
      ],
      geoSignals: ['global', 'not_applicable'], citationReadiness: ['named_author_or_owner', 'first_party_expertise', 'dated_or_current', 'source_links'], technicalSeoSignals: ['title_present', 'h1_present', 'canonical_present', 'indexable', 'internal_routing', 'performance_not_observed'], frictionSignals: ['unclear_value', 'missing_trust_signal', 'missing_next_step'], actionPriority: 'medium',
      annotationRationale: '本頁可支持 discovery-stage 的來源辨識、reader preference 與 editorial trust 分析，並清楚區分可協助辨識的品牌訊號與不可保證的實際曝光。', reviewerConfidence: 5,
    },
  },
  {
    structuralArtifactId: 1560003,
    sourceUrl: 'https://developers.google.com/search/docs/appearance/structured-data/article?hl=en',
    sourceLocator: 'human-review:batch-30:article-structured-data',
    artifactText: 'Article structured data can describe eligible news, blog, or sports article pages with properties such as headline, image, date, and author. Use markup that reflects the visible article and validate it before publishing. The markup can help search systems interpret an article, but it does not guarantee a rich result, indexing, ranking, or a particular search display. Keep article metadata current and aligned with the on-page editorial content.',
    qualityNote: '人工閱讀 Article structured data：摘要保留 article type、headline/image/date/author metadata、visible-content alignment、validation 與 rich-result 非保證；未含 PII，且不把 Article markup 表述為結果保證。',
    labels: {
      annotationKind: 'seo_geo_multilabel', annotationVersion: 'seo-geo-journey-v1', primaryJourneyStage: 'response',
      journeyStages: ['response', 'discovery', 'progression'], searchIntents: ['informational', 'commercial'], contentTypes: ['editorial', 'tool'], audienceRoles: ['practitioner', 'technical_evaluator', 'media_or_partner', 'decision_maker'],
      topicClusters: ['Article structured data', 'news article metadata', 'headline and image', 'visible content alignment', 'rich result eligibility'],
      entitySignals: [
        { name: 'Article structured data', type: 'concept', relationship: 'Describes supported editorial article properties for search-content understanding.' },
        { name: 'Article page', type: 'concept', relationship: 'Provides visible editorial content that markup should accurately represent.' },
        { name: 'Google Search', type: 'service', relationship: 'May interpret valid article markup without guaranteeing a particular search result appearance.' },
      ],
      geoSignals: ['global', 'not_applicable'], citationReadiness: ['named_author_or_owner', 'first_party_expertise', 'dated_or_current', 'source_links', 'structured_data'], technicalSeoSignals: ['title_present', 'h1_present', 'canonical_present', 'indexable', 'structured_data', 'internal_routing', 'performance_not_observed'], frictionSignals: ['missing_trust_signal', 'information_overload', 'missing_next_step'], actionPriority: 'high',
      annotationRationale: '本頁提供 article metadata 與 visible editorial evidence 對齊的 response-stage 技術診斷依據，並把 rich-result eligibility 保留為條件性結果而非保證。', reviewerConfidence: 5,
    },
  },
  {
    structuralArtifactId: 1560004,
    sourceUrl: 'https://developers.google.com/search/docs/appearance/structured-data/discussion-forum?hl=en',
    sourceLocator: 'human-review:batch-30:discussion-forum',
    artifactText: 'DiscussionForumPosting structured data is intended for forum-style pages where people share first-hand perspectives. Choose markup that matches the page type, preserve the full post or comment text, represent thread structure accurately, and make the marked content accessible from the page URL. Do not use this format as a substitute for Q&A, publisher-authored articles, or product reviews. Eligibility for a search feature does not guarantee that it will be shown.',
    qualityNote: '人工閱讀 DiscussionForumPosting：摘要保留 first-hand perspectives、forum／Q&A／article／review 的頁型區分、full text、threading、accessible URL 與顯示非保證；未含 PII。',
    labels: {
      annotationKind: 'seo_geo_multilabel', annotationVersion: 'seo-geo-journey-v1', primaryJourneyStage: 'understanding',
      journeyStages: ['understanding', 'discovery', 'response'], searchIntents: ['informational', 'commercial'], contentTypes: ['editorial', 'faq', 'other'], audienceRoles: ['researcher', 'practitioner', 'technical_evaluator', 'decision_maker'],
      topicClusters: ['DiscussionForumPosting', 'first-hand perspectives', 'forum thread structure', 'user-generated discussion', 'structured data eligibility'],
      entitySignals: [
        { name: 'DiscussionForumPosting', type: 'concept', relationship: 'Marks forum-style content where participants share first-hand perspectives.' },
        { name: 'Forum thread', type: 'concept', relationship: 'Requires an accurate representation of post and comment relationships.' },
        { name: 'Google Search', type: 'service', relationship: 'May use eligible discussion markup but does not guarantee a specific search appearance.' },
      ],
      geoSignals: ['global', 'not_applicable'], citationReadiness: ['first_party_expertise', 'dated_or_current', 'source_links', 'structured_data'], technicalSeoSignals: ['title_present', 'h1_present', 'canonical_present', 'indexable', 'structured_data', 'internal_routing', 'performance_not_observed'], frictionSignals: ['missing_trust_signal', 'information_overload', 'missing_next_step'], actionPriority: 'medium',
      annotationRationale: '本頁把 forum-specific evidence、thread integrity 與 page-type qualification 映射為 understanding-stage 的內容信任與結構化資料判斷，不把 eligibility 訓練成展示保證。', reviewerConfidence: 5,
    },
  },
  {
    structuralArtifactId: 1560005,
    sourceUrl: 'https://developers.google.com/search/docs/appearance/structured-data/qapage?hl=en',
    sourceLocator: 'human-review:batch-30:qapage',
    artifactText: 'QAPage structured data is for a page centered on one question with user-submitted answers. It is not intended for publisher-authored FAQ pages, pages with multiple unrelated questions, how-to articles, blog posts, or advertising. Match markup to the visible question-and-answer interaction, preserve the correct scope, and validate before publishing. Eligibility for a rich result does not guarantee that the search appearance will be shown.',
    qualityNote: '人工閱讀 QAPage：摘要保留 single question、user-submitted answers、FAQ/multi-question/how-to/blog/advertising exclusions、visible interaction alignment 與 rich-result 非保證；未含 PII。',
    labels: {
      annotationKind: 'seo_geo_multilabel', annotationVersion: 'seo-geo-journey-v1', primaryJourneyStage: 'response',
      journeyStages: ['response', 'understanding', 'progression'], searchIntents: ['informational', 'transactional'], contentTypes: ['faq', 'editorial', 'tool'], audienceRoles: ['researcher', 'practitioner', 'technical_evaluator', 'decision_maker'],
      topicClusters: ['QAPage structured data', 'single question', 'user-submitted answers', 'FAQ exclusion', 'rich result eligibility'],
      entitySignals: [
        { name: 'QAPage', type: 'concept', relationship: 'Describes a page focused on one question and its user-submitted answers.' },
        { name: 'FAQ page', type: 'concept', relationship: 'Is a distinct publisher-authored page type that should not be represented as a QAPage.' },
        { name: 'Google Search', type: 'service', relationship: 'May evaluate eligible question-and-answer markup without promising a rich result display.' },
      ],
      geoSignals: ['global', 'not_applicable'], citationReadiness: ['first_party_expertise', 'dated_or_current', 'source_links', 'structured_data'], technicalSeoSignals: ['title_present', 'h1_present', 'canonical_present', 'indexable', 'structured_data', 'internal_routing', 'performance_not_observed'], frictionSignals: ['unclear_value', 'missing_trust_signal', 'missing_next_step'], actionPriority: 'high',
      annotationRationale: '本頁提供 Q&A page-type qualification、visible user interaction 與 invalid use-case exclusion 的 response-stage remediation evidence，同時保留 rich-result 顯示並非保證。', reviewerConfidence: 5,
    },
  },
]

const database = getDatabase()
if (!database) throw new Error('database_unavailable')

const [source] = await database.select({ id: publicIntelligenceSources.id, ownerUserId: publicIntelligenceSources.ownerUserId, retentionUntil: publicIntelligenceSources.retentionUntil }).from(publicIntelligenceSources).where(and(
  eq(publicIntelligenceSources.sourceName, 'Google Search Central Documentation（CC BY 4.0）'), eq(publicIntelligenceSources.reviewStatus, 'approved'), eq(publicIntelligenceSources.allowedUse, 'training_candidate'), eq(publicIntelligenceSources.robotsStatus, 'reviewed_allow'), eq(publicIntelligenceSources.termsStatus, 'allows_training'), eq(publicIntelligenceSources.copyrightRisk, 'low'), eq(publicIntelligenceSources.piiStatus, 'none_detected'), isNull(publicIntelligenceSources.removedAt),
)).limit(1)
if (!source) throw new Error('approved_google_search_central_source_not_found')

for (const annotation of annotations) {
  const [structural] = await database.select({ id: publicIntelligenceArtifacts.id, sourceSpanHash: publicIntelligenceArtifacts.sourceSpanHash, qualityStatus: publicIntelligenceArtifacts.qualityStatus, piiStatus: publicIntelligenceArtifacts.piiStatus }).from(publicIntelligenceArtifacts).where(and(
    eq(publicIntelligenceArtifacts.id, annotation.structuralArtifactId), eq(publicIntelligenceArtifacts.sourceId, source.id), eq(publicIntelligenceArtifacts.artifactType, 'structural_features'), eq(publicIntelligenceArtifacts.sourceUrl, annotation.sourceUrl), isNull(publicIntelligenceArtifacts.removedAt),
  )).limit(1)
  if (!structural?.sourceSpanHash) throw new Error(`batch_30_structural_artifact_not_found:${annotation.structuralArtifactId}`)
  if (structural.piiStatus !== 'none_detected') throw new Error(`batch_30_pii_not_clear:${annotation.structuralArtifactId}`)
  if (structural.qualityStatus !== 'passed') await reviewOwnerPublicArtifact({ ownerUserId: source.ownerUserId, artifactId: structural.id, qualityStatus: 'passed', qualityNote: annotation.qualityNote })

  const labels = seoGeoMultilabelSchema.parse(annotation.labels)
  const [existing] = await database.select({ id: publicIntelligenceArtifacts.id, qualityStatus: publicIntelligenceArtifacts.qualityStatus }).from(publicIntelligenceArtifacts).where(and(
    eq(publicIntelligenceArtifacts.sourceId, source.id), eq(publicIntelligenceArtifacts.artifactType, 'human_annotation'), eq(publicIntelligenceArtifacts.sourceUrl, annotation.sourceUrl), isNull(publicIntelligenceArtifacts.removedAt),
  )).limit(1)
  const human = existing || await createOwnerPublicArtifact({ ownerUserId: source.ownerUserId, sourceId: source.id, sourceUrl: annotation.sourceUrl, canonicalUrl: annotation.sourceUrl, artifactType: 'human_annotation', artifactText: annotation.artifactText, sourceLocator: annotation.sourceLocator, sourceSpanHash: structural.sourceSpanHash, fieldData: labels, language: 'en', extractionMethod: 'human_annotation', requestedUse: 'training_candidate', retentionUntil: source.retentionUntil })
  if (human.qualityStatus !== 'passed') await reviewOwnerPublicArtifact({ ownerUserId: source.ownerUserId, artifactId: human.id, qualityStatus: 'passed', qualityNote: annotation.qualityNote })
  console.log(JSON.stringify({ sourceUrl: annotation.sourceUrl, structuralArtifactId: structural.id, humanAnnotationId: human.id, primaryJourneyStage: labels.primaryJourneyStage, status: existing ? 'retained_existing' : 'passed' }))
}

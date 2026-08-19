import { and, eq, isNull } from 'drizzle-orm'
import { getDatabase } from '../server/database/index.ts'
import { publicIntelligenceArtifacts, publicIntelligenceSources } from '../server/database/schema.ts'
import { createOwnerPublicArtifact, reviewOwnerPublicArtifact } from '../server/public-intelligence/repository.ts'
import { seoGeoMultilabelSchema } from '../server/public-intelligence/seoGeoTaxonomy.ts'

const annotations = [
  {
    structuralArtifactId: 1500001,
    sourceUrl: 'https://developers.google.com/search/docs/crawling-indexing/qualify-outbound-links?hl=en',
    sourceLocator: 'human-review:batch-29:qualify-outbound-links',
    artifactText: 'Qualify outbound links according to their relationship: use rel="sponsored" for paid placements, rel="ugc" for user-generated content, and rel="nofollow" when other values do not apply. Multiple rel values can be combined where appropriate. These annotations describe the link relationship for Google; they do not guarantee crawling, indexing, ranking, or a specific search result. Review paid, user-generated, and editorial linking workflows so relationship metadata stays accurate as content changes.',
    qualityNote: '人工閱讀 Qualify Outbound Links：摘要保留 sponsored、ugc、nofollow、多值 rel 與關係描述的技術範圍；不含 PII，且不將 link qualification 表述為 crawl、index 或 ranking 保證。',
    labels: {
      annotationKind: 'seo_geo_multilabel', annotationVersion: 'seo-geo-journey-v1', primaryJourneyStage: 'progression',
      journeyStages: ['progression', 'response', 'conversion'], searchIntents: ['informational', 'commercial'], contentTypes: ['editorial', 'tool'], audienceRoles: ['practitioner', 'technical_evaluator', 'decision_maker'],
      topicClusters: ['outbound link qualification', 'sponsored links', 'user-generated content', 'nofollow', 'link relationship metadata'],
      entitySignals: [
        { name: 'Google Search', type: 'service', relationship: 'Interprets link relationship metadata without promising a specific crawl or ranking outcome.' },
        { name: 'rel sponsored', type: 'concept', relationship: 'Identifies compensated placements or advertising relationships on outbound links.' },
        { name: 'rel ugc', type: 'concept', relationship: 'Identifies links within user-generated content workflows.' },
      ],
      geoSignals: ['global', 'not_applicable'], citationReadiness: ['first_party_expertise', 'dated_or_current', 'source_links'], technicalSeoSignals: ['title_present', 'h1_present', 'canonical_present', 'indexable', 'internal_routing', 'performance_not_observed'], frictionSignals: ['missing_trust_signal', 'missing_next_step'], actionPriority: 'medium',
      annotationRationale: '本頁把付費、UGC 與其他 outbound link 的 relationship metadata 映射為 content governance 與 technical SEO 維護信號，適合支持使用者旅程中的信任、合規與內容更新決策。', reviewerConfidence: 5,
    },
  },
  {
    structuralArtifactId: 1500002,
    sourceUrl: 'https://developers.google.com/search/docs/crawling-indexing/valid-page-metadata?hl=en',
    sourceLocator: 'human-review:batch-29:valid-page-metadata',
    artifactText: 'Keep page metadata valid inside the HTML head. Invalid elements can cause Google to stop reading later metadata, so review head markup before relying on titles, canonical links, robots directives, or other signals. Place supported elements in the appropriate location and remove unexpected markup that interrupts parsing. Valid metadata improves technical clarity but does not guarantee crawling, indexing, ranking, or display.',
    qualityNote: '人工閱讀 Valid Page Metadata：摘要保留 HTML head、invalid element 截斷後續 metadata 解析、title/canonical/robots 等技術邊界；不含 PII，且不將 metadata validness 表述為成效保證。',
    labels: {
      annotationKind: 'seo_geo_multilabel', annotationVersion: 'seo-geo-journey-v1', primaryJourneyStage: 'response',
      journeyStages: ['response', 'progression', 'conversion'], searchIntents: ['informational', 'commercial'], contentTypes: ['editorial', 'tool'], audienceRoles: ['practitioner', 'technical_evaluator', 'decision_maker'],
      topicClusters: ['valid page metadata', 'HTML head', 'metadata parsing', 'canonical links', 'robots directives'],
      entitySignals: [
        { name: 'HTML head', type: 'concept', relationship: 'Holds supported metadata elements whose valid placement affects subsequent parsing.' },
        { name: 'Google Search', type: 'service', relationship: 'May stop reading later metadata when invalid page-head markup interrupts parsing.' },
        { name: 'Canonical link', type: 'concept', relationship: 'Is an example of metadata that should remain reachable in a valid document head.' },
      ],
      geoSignals: ['global', 'not_applicable'], citationReadiness: ['first_party_expertise', 'dated_or_current', 'source_links'], technicalSeoSignals: ['title_present', 'h1_present', 'canonical_present', 'indexable', 'internal_routing', 'performance_not_observed'], frictionSignals: ['information_overload', 'missing_next_step'], actionPriority: 'high',
      annotationRationale: '本頁提供 metadata 解析中斷的可操作診斷證據，可映射為 response-stage technical remediation，並保留 title、canonical 與 robots 的相依關係而不虛構搜尋結果。', reviewerConfidence: 5,
    },
  },
  {
    structuralArtifactId: 1500003,
    sourceUrl: 'https://developers.google.com/search/docs/crawling-indexing/pause-online-business?hl=en',
    sourceLocator: 'human-review:batch-29:pause-online-business',
    artifactText: 'When an online business temporarily pauses, prefer a continuity plan over taking the whole site offline. Limit ordering or cart functions as needed, explain delays clearly, and keep essential pages available. Update relevant structured data and Merchant Center information where applicable. Avoid treating robots.txt, noindex, or a blanket 503 response as a simple substitute for a scoped pause; each choice can affect how pages are processed and should be reversed when operations resume.',
    qualityNote: '人工閱讀 Temporarily Pause or Disable Website：摘要保留 site continuity、cart limitation、clear delay notice、structured data/Merchant Center updates 與 503/robots/noindex 的風險邊界；不含 PII，不將暫停策略表述為收錄或交易結果保證。',
    labels: {
      annotationKind: 'seo_geo_multilabel', annotationVersion: 'seo-geo-journey-v1', primaryJourneyStage: 'conversion',
      journeyStages: ['conversion', 'response', 'progression'], searchIntents: ['commercial', 'informational'], contentTypes: ['service', 'editorial'], audienceRoles: ['buyer', 'existing_customer', 'decision_maker', 'practitioner'],
      topicClusters: ['temporary business pause', 'cart availability', 'service delay communication', 'Merchant Center', 'structured data', '503 response'],
      entitySignals: [
        { name: 'Online business', type: 'industry', relationship: 'Needs an operational continuity plan when sales or fulfilment are temporarily constrained.' },
        { name: 'Merchant Center', type: 'service', relationship: 'May need updated merchant information when a business pause changes product availability.' },
        { name: 'Structured data', type: 'concept', relationship: 'May require scoped updates to reflect the temporary business state.' },
      ],
      geoSignals: ['global', 'not_applicable'], citationReadiness: ['first_party_expertise', 'dated_or_current', 'source_links', 'structured_data'], technicalSeoSignals: ['title_present', 'h1_present', 'canonical_present', 'indexable', 'structured_data', 'internal_routing', 'performance_not_observed'], frictionSignals: ['unclear_value', 'missing_trust_signal', 'missing_next_step'], actionPriority: 'high',
      annotationRationale: '本頁連結營運暫停期間的購買／履約溝通、product availability 及 technical search controls，提供 conversion-path friction 與高優先 remediation 信號，同時保留不確定結果的技術限制。', reviewerConfidence: 5,
    },
  },
  {
    structuralArtifactId: 1500004,
    sourceUrl: 'https://developers.google.com/search/docs/crawling-indexing/remove-information?hl=en',
    sourceLocator: 'human-review:batch-29:remove-information',
    artifactText: 'Use removals tooling as a temporary measure, not as a permanent substitute for changing or restricting information at its source. For lasting removal, update or delete content, require appropriate access controls, or use noindex where it matches the intended scope. Do not rely on robots.txt alone to remove a page from search results. Choose the method that fits the content, access, and time horizon, then verify that the original page state aligns with the requested outcome.',
    qualityNote: '人工閱讀 Remove a Page Hosted on Your Site：摘要保留 temporary removals、content update/delete、access control、noindex 與 robots.txt 限制；不含 PII，且不將任何 action 表述為保證的搜尋結果移除。',
    labels: {
      annotationKind: 'seo_geo_multilabel', annotationVersion: 'seo-geo-journey-v1', primaryJourneyStage: 'response',
      journeyStages: ['response', 'progression', 'conversion'], searchIntents: ['informational', 'transactional'], contentTypes: ['editorial', 'tool'], audienceRoles: ['practitioner', 'technical_evaluator', 'decision_maker'],
      topicClusters: ['content removal', 'temporary removals', 'access control', 'noindex', 'robots.txt limitation'],
      entitySignals: [
        { name: 'Google Search removals tool', type: 'service', relationship: 'Provides a temporary visibility-control measure rather than a permanent source-content change.' },
        { name: 'Noindex', type: 'concept', relationship: 'Can express a page-level indexing preference when it fits the intended information-control scope.' },
        { name: 'Robots.txt', type: 'concept', relationship: 'Is not a standalone method for removing an already visible page from search results.' },
      ],
      geoSignals: ['global', 'not_applicable'], citationReadiness: ['first_party_expertise', 'dated_or_current', 'source_links'], technicalSeoSignals: ['title_present', 'h1_present', 'canonical_present', 'indexable', 'internal_routing', 'performance_not_observed'], frictionSignals: ['information_overload', 'missing_next_step', 'missing_trust_signal'], actionPriority: 'high',
      annotationRationale: '本頁讓資訊控制需求可映射為 response-stage 的 source correction、access control 與 noindex remediation，並區分暫時可見度處理與永久內容變更，避免訓練成錯誤保證。', reviewerConfidence: 5,
    },
  },
  {
    structuralArtifactId: 1500005,
    sourceUrl: 'https://developers.google.com/search/docs/appearance/featured-snippets?hl=en',
    sourceLocator: 'human-review:batch-29:featured-snippets',
    artifactText: 'Featured snippets are a search appearance that may summarize a page for a query. Site owners can use nosnippet, data-nosnippet, or max-snippet controls to limit eligible text where appropriate. A page can still be selected or displayed differently, and these controls do not guarantee a particular result. Evaluate snippet controls against the user-facing content goal, citation context, and click-to-section experience rather than treating them as a ranking tactic.',
    qualityNote: '人工閱讀 Featured Snippets：摘要保留 snippet appearance、nosnippet/data-nosnippet/max-snippet controls、citation context、click-to-section 與不保證性；不含 PII，且不將 snippet control 表述為排名或展示保證。',
    labels: {
      annotationKind: 'seo_geo_multilabel', annotationVersion: 'seo-geo-journey-v1', primaryJourneyStage: 'discovery',
      journeyStages: ['discovery', 'response', 'conversion'], searchIntents: ['informational', 'commercial'], contentTypes: ['editorial', 'other'], audienceRoles: ['researcher', 'practitioner', 'technical_evaluator', 'decision_maker'],
      topicClusters: ['featured snippets', 'search appearance', 'nosnippet', 'data-nosnippet', 'max-snippet', 'click-to-section'],
      entitySignals: [
        { name: 'Featured snippets', type: 'concept', relationship: 'May summarize an eligible page for a query as part of search appearance.' },
        { name: 'Google Search', type: 'service', relationship: 'Determines search appearance and may display page information differently from a site-owner expectation.' },
        { name: 'Data nosnippet', type: 'concept', relationship: 'Lets page authors identify text that should not be used for search snippets where applicable.' },
      ],
      geoSignals: ['global', 'not_applicable'], citationReadiness: ['first_party_expertise', 'dated_or_current', 'source_links'], technicalSeoSignals: ['title_present', 'h1_present', 'canonical_present', 'indexable', 'internal_routing', 'performance_not_observed'], frictionSignals: ['unclear_value', 'missing_next_step'], actionPriority: 'medium',
      annotationRationale: '本頁將 snippet eligibility 與 content-control mechanisms 映射為 discovery-stage search appearance、citation readiness 與 user-context evaluation，並明確保留不保證選取或展示的界線。', reviewerConfidence: 5,
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
  if (!structural?.sourceSpanHash) throw new Error(`batch_29_structural_artifact_not_found:${annotation.structuralArtifactId}`)
  if (structural.piiStatus !== 'none_detected') throw new Error(`batch_29_pii_not_clear:${annotation.structuralArtifactId}`)
  if (structural.qualityStatus !== 'passed') await reviewOwnerPublicArtifact({ ownerUserId: source.ownerUserId, artifactId: structural.id, qualityStatus: 'passed', qualityNote: annotation.qualityNote })

  const labels = seoGeoMultilabelSchema.parse(annotation.labels)
  const [existing] = await database.select({ id: publicIntelligenceArtifacts.id, qualityStatus: publicIntelligenceArtifacts.qualityStatus }).from(publicIntelligenceArtifacts).where(and(
    eq(publicIntelligenceArtifacts.sourceId, source.id), eq(publicIntelligenceArtifacts.artifactType, 'human_annotation'), eq(publicIntelligenceArtifacts.sourceUrl, annotation.sourceUrl), isNull(publicIntelligenceArtifacts.removedAt),
  )).limit(1)
  const human = existing || await createOwnerPublicArtifact({ ownerUserId: source.ownerUserId, sourceId: source.id, sourceUrl: annotation.sourceUrl, canonicalUrl: annotation.sourceUrl, artifactType: 'human_annotation', artifactText: annotation.artifactText, sourceLocator: annotation.sourceLocator, sourceSpanHash: structural.sourceSpanHash, fieldData: labels, language: 'en', extractionMethod: 'human_annotation', requestedUse: 'training_candidate', retentionUntil: source.retentionUntil })
  if (human.qualityStatus !== 'passed') await reviewOwnerPublicArtifact({ ownerUserId: source.ownerUserId, artifactId: human.id, qualityStatus: 'passed', qualityNote: annotation.qualityNote })
  console.log(JSON.stringify({ sourceUrl: annotation.sourceUrl, structuralArtifactId: structural.id, humanAnnotationId: human.id, primaryJourneyStage: labels.primaryJourneyStage, status: existing ? 'retained_existing' : 'passed' }))
}

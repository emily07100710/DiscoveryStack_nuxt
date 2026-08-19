import { and, eq, isNull } from 'drizzle-orm'
import { getDatabase } from '../server/database/index.ts'
import { publicIntelligenceArtifacts, publicIntelligenceSources } from '../server/database/schema.ts'
import { createOwnerPublicArtifact, reviewOwnerPublicArtifact } from '../server/public-intelligence/repository.ts'
import { seoGeoMultilabelSchema } from '../server/public-intelligence/seoGeoTaxonomy.ts'

const annotations = [
  {
    structuralArtifactId: 1260001,
    sourceUrl: 'https://developers.google.com/search/docs/appearance/video?hl=en',
    sourceLocator: 'human-review:batch-25:video-seo',
    artifactText: 'Improve video discovery by making the video discoverable in rendered HTML without fragment-only loading or user-action gates, then verify the watch page itself is indexed before interpreting video eligibility. Use a dedicated watch page where video is the primary purpose, stable unique video and thumbnail URLs, consistent metadata across supported sources, and crawlable thumbnail access. Separate feature eligibility from display guarantees, use Search Console and troubleshooting signals to diagnose coverage, and plan removal or restriction as an operational path rather than assuming implementation guarantees appearance.',
    qualityNote: '人工閱讀 Video SEO best practices：摘要保留 video discovery、watch-page indexing、stable media／thumbnail URLs、metadata consistency、feature eligibility、monitoring 與 troubleshooting 的決策邊界；不將 eligibility 表示為展示保證，且不含 PII。',
    labels: {
      annotationKind: 'seo_geo_multilabel', annotationVersion: 'seo-geo-journey-v1', primaryJourneyStage: 'discovery',
      journeyStages: ['discovery', 'response', 'progression'], searchIntents: ['informational', 'navigational'], contentTypes: ['editorial', 'tool'], audienceRoles: ['practitioner', 'technical_evaluator'],
      topicClusters: ['video SEO', 'video indexing', 'watch pages', 'video thumbnails', 'Discover visibility'],
      entitySignals: [
        { name: 'Google Search video features', type: 'service', relationship: 'May surface eligible video content across Search, Video mode, Images, and Discover without a display guarantee.' },
        { name: 'watch page', type: 'concept', relationship: 'A page where an individual video is the main content and whose indexing is required for video feature eligibility.' },
        { name: 'Search Console', type: 'service', relationship: 'Supports monitoring and troubleshooting of video visibility and indexing issues.' },
      ],
      geoSignals: ['global', 'not_applicable'], citationReadiness: ['first_party_expertise', 'dated_or_current', 'source_links'], technicalSeoSignals: ['title_present', 'h1_present', 'canonical_present', 'indexable', 'structured_data', 'internal_routing', 'performance_not_observed'], frictionSignals: ['missing_next_step', 'information_overload'], actionPriority: 'high',
      annotationRationale: '本頁提供由 rendered discovery、watch-page indexability、stable URLs、metadata consistency 到 monitoring 的多步技術決策鏈，適合 discovery journey 的診斷與改善優先序，同時保留 feature eligibility 不等於展示的限制。', reviewerConfidence: 5,
    },
  },
  {
    structuralArtifactId: 1260002,
    sourceUrl: 'https://developers.google.com/search/docs/appearance/visual-elements-gallery?hl=en',
    sourceLocator: 'human-review:batch-25:visual-elements-gallery',
    artifactText: 'Model Google Search appearance as distinct text, rich, image, video, attribution, and exploration visual elements rather than a single guaranteed result format. Connect site name, favicon, visible URL, title link, snippet, image and video assets, and structured data to the visual element each can influence. Treat device, country, query language, and query intent as contextual variation, distinguish controls from automated presentation, and use the gallery to decide which linked technical or content guidance should be investigated next.',
    qualityNote: '人工閱讀 Visual Elements gallery：摘要保留 search-result element taxonomy、attribution、text／rich／image／video result、exploration features、device／country／language variation 與可控制性邊界；不將任何元素視為保證展示，且不含 PII。',
    labels: {
      annotationKind: 'seo_geo_multilabel', annotationVersion: 'seo-geo-journey-v1', primaryJourneyStage: 'discovery',
      journeyStages: ['discovery', 'understanding', 'progression'], searchIntents: ['informational', 'navigational'], contentTypes: ['editorial', 'tool'], audienceRoles: ['practitioner', 'decision_maker'],
      topicClusters: ['search appearance', 'visual elements', 'text results', 'rich results', 'exploration features'],
      entitySignals: [
        { name: 'Google Search results', type: 'service', relationship: 'Presents text, rich, image, video, attribution, and exploration elements whose appearance varies by context.' },
        { name: 'visual element', type: 'concept', relationship: 'A user-perceivable search-result component with separate optimization guidance and automation boundaries.' },
        { name: 'structured data', type: 'concept', relationship: 'May support rich-result graphical or interactive elements but does not guarantee presentation.' },
      ],
      geoSignals: ['global', 'country', 'multilingual'], citationReadiness: ['first_party_expertise', 'dated_or_current', 'source_links'], technicalSeoSignals: ['title_present', 'h1_present', 'canonical_present', 'indexable', 'structured_data', 'internal_routing', 'language_signal', 'performance_not_observed'], frictionSignals: ['unclear_value', 'information_overload'], actionPriority: 'medium',
      annotationRationale: '本頁把 SERP 可見度拆成可辨識的 visual elements、可影響的來源訊號及自動化呈現邊界，適合 discovery journey 中將觀察到的外觀轉為後續內容與技術檢查。', reviewerConfidence: 5,
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
  if (!structural?.sourceSpanHash) throw new Error(`batch_25_structural_artifact_not_found:${annotation.structuralArtifactId}`)
  if (structural.piiStatus !== 'none_detected') throw new Error(`batch_25_pii_not_clear:${annotation.structuralArtifactId}`)
  if (structural.qualityStatus !== 'passed') await reviewOwnerPublicArtifact({ ownerUserId: source.ownerUserId, artifactId: structural.id, qualityStatus: 'passed', qualityNote: annotation.qualityNote })
  const labels = seoGeoMultilabelSchema.parse(annotation.labels)
  const [existing] = await database.select({ id: publicIntelligenceArtifacts.id, qualityStatus: publicIntelligenceArtifacts.qualityStatus }).from(publicIntelligenceArtifacts).where(and(
    eq(publicIntelligenceArtifacts.sourceId, source.id), eq(publicIntelligenceArtifacts.artifactType, 'human_annotation'), eq(publicIntelligenceArtifacts.sourceUrl, annotation.sourceUrl), isNull(publicIntelligenceArtifacts.removedAt),
  )).limit(1)
  const human = existing || await createOwnerPublicArtifact({ ownerUserId: source.ownerUserId, sourceId: source.id, sourceUrl: annotation.sourceUrl, canonicalUrl: annotation.sourceUrl, artifactType: 'human_annotation', artifactText: annotation.artifactText, sourceLocator: annotation.sourceLocator, sourceSpanHash: structural.sourceSpanHash, fieldData: labels, language: 'en', extractionMethod: 'human_annotation', requestedUse: 'training_candidate', retentionUntil: source.retentionUntil })
  if (human.qualityStatus !== 'passed') await reviewOwnerPublicArtifact({ ownerUserId: source.ownerUserId, artifactId: human.id, qualityStatus: 'passed', qualityNote: annotation.qualityNote })
  console.log(JSON.stringify({ sourceUrl: annotation.sourceUrl, structuralArtifactId: structural.id, humanAnnotationId: human.id, primaryJourneyStage: labels.primaryJourneyStage, status: existing ? 'retained_existing' : 'passed' }))
}

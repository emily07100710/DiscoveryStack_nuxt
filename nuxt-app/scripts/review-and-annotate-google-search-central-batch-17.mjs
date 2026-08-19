import { and, eq, isNull } from 'drizzle-orm'
import { getDatabase } from '../server/database/index.ts'
import { publicIntelligenceArtifacts, publicIntelligenceSources } from '../server/database/schema.ts'
import { createOwnerPublicArtifact, reviewOwnerPublicArtifact } from '../server/public-intelligence/repository.ts'
import { seoGeoMultilabelSchema } from '../server/public-intelligence/seoGeoTaxonomy.ts'

const sourceUrl = 'https://developers.google.com/search/docs/appearance/google-discover?hl=en'
const structuralArtifactId = 900001
const qualityNote = '人工閱讀官方 Discover 文件：涵蓋 indexed + policy-compliant eligibility、people-first content、避免 clickbait／sensationalism、內容時效與獨特觀點、large image 與 max-image-preview、page experience、traffic variability 及 Performance report。去識別摘要與 reviewed source span 一致，未含 PII。'
const labels = seoGeoMultilabelSchema.parse({
  annotationKind: 'seo_geo_multilabel',
  annotationVersion: 'seo-geo-journey-v1',
  primaryJourneyStage: 'discovery',
  journeyStages: ['discovery', 'understanding', 'response'],
  searchIntents: ['informational'],
  contentTypes: ['editorial', 'tool'],
  audienceRoles: ['practitioner', 'technical_evaluator', 'decision_maker', 'researcher'],
  topicClusters: ['interest-driven discovery', 'people-first content', 'search appearance', 'content preview quality', 'Discover performance monitoring', 'traffic variability'],
  entitySignals: [
    { name: 'Google Discover', type: 'service', relationship: 'Shows indexed, policy-compliant content related to a person’s interests.' },
    { name: 'Google Search Console', type: 'service', relationship: 'Provides a Discover performance report for monitoring impressions, clicks, and CTR.' },
    { name: 'People-first content', type: 'concept', relationship: 'Supports helpful discovery without misleading previews or engagement manipulation.' },
  ],
  geoSignals: ['global', 'not_applicable'],
  citationReadiness: ['first_party_expertise', 'dated_or_current', 'source_links'],
  technicalSeoSignals: ['title_present', 'h1_present', 'canonical_present', 'indexable', 'structured_data', 'performance_not_observed'],
  frictionSignals: ['unclear_value', 'missing_trust_signal', 'information_overload'],
  actionPriority: 'medium',
  annotationRationale: '本頁以內容被發現的必要條件、預覽品質與 interest-driven traffic 的不確定性為主軸，適合訓練 discovery 內容策略與可觀測性判讀；其多階段關聯保留在 understanding 與 response，但不誤稱出現保證。',
  reviewerConfidence: 5,
})

const artifactText = 'Make content eligible for an interest-driven discovery surface by ensuring the page is indexable and policy-compliant, but do not treat eligibility as a promise of distribution. Use people-first content with accurate titles, headlines, previews, and images instead of clickbait, sensationalism, or withheld context. Choose relevant, high-quality landscape imagery and use appropriate image-preview metadata when it represents the page. Produce timely, well-told, or uniquely useful information that aligns with genuine audience interests. Treat discovery traffic as supplemental rather than a dependable substitute for keyword-driven visits because interests, content types, and search systems change over time. Monitor impressions, clicks, and click-through rate in the relevant performance report before drawing conclusions about a content strategy.'

const database = getDatabase()
if (!database) throw new Error('database_unavailable')
const [source] = await database.select({ id: publicIntelligenceSources.id, ownerUserId: publicIntelligenceSources.ownerUserId, retentionUntil: publicIntelligenceSources.retentionUntil }).from(publicIntelligenceSources).where(and(eq(publicIntelligenceSources.sourceName, 'Google Search Central Documentation（CC BY 4.0）'), eq(publicIntelligenceSources.reviewStatus, 'approved'), eq(publicIntelligenceSources.allowedUse, 'training_candidate'), eq(publicIntelligenceSources.robotsStatus, 'reviewed_allow'), eq(publicIntelligenceSources.termsStatus, 'allows_training'), eq(publicIntelligenceSources.copyrightRisk, 'low'), eq(publicIntelligenceSources.piiStatus, 'none_detected'), isNull(publicIntelligenceSources.removedAt))).limit(1)
if (!source) throw new Error('approved_google_search_central_source_not_found')
const [structural] = await database.select({ id: publicIntelligenceArtifacts.id, sourceSpanHash: publicIntelligenceArtifacts.sourceSpanHash, qualityStatus: publicIntelligenceArtifacts.qualityStatus, piiStatus: publicIntelligenceArtifacts.piiStatus }).from(publicIntelligenceArtifacts).where(and(eq(publicIntelligenceArtifacts.id, structuralArtifactId), eq(publicIntelligenceArtifacts.sourceId, source.id), eq(publicIntelligenceArtifacts.artifactType, 'structural_features'), eq(publicIntelligenceArtifacts.sourceUrl, sourceUrl), isNull(publicIntelligenceArtifacts.removedAt))).limit(1)
if (!structural?.sourceSpanHash) throw new Error('batch_17_structural_artifact_not_found')
if (structural.piiStatus !== 'none_detected') throw new Error('batch_17_pii_not_clear')
if (structural.qualityStatus !== 'passed') await reviewOwnerPublicArtifact({ ownerUserId: source.ownerUserId, artifactId: structural.id, qualityStatus: 'passed', qualityNote })
const [existing] = await database.select({ id: publicIntelligenceArtifacts.id, qualityStatus: publicIntelligenceArtifacts.qualityStatus }).from(publicIntelligenceArtifacts).where(and(eq(publicIntelligenceArtifacts.sourceId, source.id), eq(publicIntelligenceArtifacts.artifactType, 'human_annotation'), eq(publicIntelligenceArtifacts.sourceUrl, sourceUrl), eq(publicIntelligenceArtifacts.sourceSpanHash, structural.sourceSpanHash), isNull(publicIntelligenceArtifacts.removedAt))).limit(1)
const human = existing || await createOwnerPublicArtifact({ ownerUserId: source.ownerUserId, sourceId: source.id, sourceUrl, canonicalUrl: sourceUrl, artifactType: 'human_annotation', artifactText, sourceLocator: 'human-review:batch-17:google-discover', sourceSpanHash: structural.sourceSpanHash, fieldData: labels, language: 'en', extractionMethod: 'human_annotation', requestedUse: 'training_candidate', retentionUntil: source.retentionUntil })
if (human.qualityStatus !== 'passed') await reviewOwnerPublicArtifact({ ownerUserId: source.ownerUserId, artifactId: human.id, qualityStatus: 'passed', qualityNote })
console.log(JSON.stringify({ sourceUrl, structuralArtifactId: structural.id, humanAnnotationId: human.id, primaryJourneyStage: labels.primaryJourneyStage, status: 'passed' }))

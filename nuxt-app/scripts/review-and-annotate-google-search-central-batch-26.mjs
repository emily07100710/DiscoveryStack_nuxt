import { and, eq, isNull } from 'drizzle-orm'
import { getDatabase } from '../server/database/index.ts'
import { publicIntelligenceArtifacts, publicIntelligenceSources } from '../server/database/schema.ts'
import { createOwnerPublicArtifact, reviewOwnerPublicArtifact } from '../server/public-intelligence/repository.ts'
import { seoGeoMultilabelSchema } from '../server/public-intelligence/seoGeoTaxonomy.ts'

const annotation = {
  structuralArtifactId: 1320001,
  sourceUrl: 'https://developers.google.com/search/docs/appearance/page-experience?hl=en',
  sourceLocator: 'human-review:batch-26:page-experience',
  artifactText: 'Assess page experience as a user-centred response workflow rather than a single ranking switch. Diagnose Core Web Vitals, secure HTTPS delivery, mobile display, advertising interference, intrusive interstitials, and whether visitors can distinguish main content. Use Search Console reports and diagnostic tools to identify the next remediation, but retain the limits that a good report score does not guarantee top ranking, ranking systems evaluate many signals, and assessment can be page-specific with some site-wide components.',
  qualityNote: '人工閱讀 Page Experience 文件：摘要保留 Core Web Vitals、HTTPS、mobile、ad／interstitial、main-content distinction、報表診斷與 ranking guarantee 限制；不含 PII，也不將單一指標表述為保證。',
  labels: {
    annotationKind: 'seo_geo_multilabel', annotationVersion: 'seo-geo-journey-v1', primaryJourneyStage: 'response',
    journeyStages: ['response', 'progression', 'conversion'], searchIntents: ['informational', 'commercial'], contentTypes: ['editorial', 'tool'], audienceRoles: ['practitioner', 'technical_evaluator', 'decision_maker'],
    topicClusters: ['page experience', 'Core Web Vitals', 'HTTPS', 'mobile usability', 'intrusive interstitials'],
    entitySignals: [
      { name: 'Google Search ranking systems', type: 'service', relationship: 'Use many signals that may reward an overall helpful page experience without a single guaranteed ranking switch.' },
      { name: 'Core Web Vitals', type: 'concept', relationship: 'A user-experience measurement family used by ranking systems but insufficient alone to guarantee a top result.' },
      { name: 'Search Console', type: 'service', relationship: 'Provides reports that support diagnosis and prioritisation of page-experience remediation.' },
    ],
    geoSignals: ['global', 'not_applicable'], citationReadiness: ['first_party_expertise', 'dated_or_current', 'source_links'], technicalSeoSignals: ['title_present', 'h1_present', 'canonical_present', 'indexable', 'performance_not_observed'], frictionSignals: ['information_overload', 'missing_next_step'], actionPriority: 'high',
    annotationRationale: '本頁將 performance、security、mobile 與 content-access friction 轉化為可監測的 response remediation，同時保留多訊號、page-specific 與不保證排名的因果邊界，適合訓練診斷與優先序輸出。', reviewerConfidence: 5,
  },
}

const database = getDatabase()
if (!database) throw new Error('database_unavailable')
const [source] = await database.select({ id: publicIntelligenceSources.id, ownerUserId: publicIntelligenceSources.ownerUserId, retentionUntil: publicIntelligenceSources.retentionUntil }).from(publicIntelligenceSources).where(and(
  eq(publicIntelligenceSources.sourceName, 'Google Search Central Documentation（CC BY 4.0）'), eq(publicIntelligenceSources.reviewStatus, 'approved'), eq(publicIntelligenceSources.allowedUse, 'training_candidate'), eq(publicIntelligenceSources.robotsStatus, 'reviewed_allow'), eq(publicIntelligenceSources.termsStatus, 'allows_training'), eq(publicIntelligenceSources.copyrightRisk, 'low'), eq(publicIntelligenceSources.piiStatus, 'none_detected'), isNull(publicIntelligenceSources.removedAt),
)).limit(1)
if (!source) throw new Error('approved_google_search_central_source_not_found')

const [structural] = await database.select({ id: publicIntelligenceArtifacts.id, sourceSpanHash: publicIntelligenceArtifacts.sourceSpanHash, qualityStatus: publicIntelligenceArtifacts.qualityStatus, piiStatus: publicIntelligenceArtifacts.piiStatus }).from(publicIntelligenceArtifacts).where(and(
  eq(publicIntelligenceArtifacts.id, annotation.structuralArtifactId), eq(publicIntelligenceArtifacts.sourceId, source.id), eq(publicIntelligenceArtifacts.artifactType, 'structural_features'), eq(publicIntelligenceArtifacts.sourceUrl, annotation.sourceUrl), isNull(publicIntelligenceArtifacts.removedAt),
)).limit(1)
if (!structural?.sourceSpanHash) throw new Error(`batch_26_structural_artifact_not_found:${annotation.structuralArtifactId}`)
if (structural.piiStatus !== 'none_detected') throw new Error(`batch_26_pii_not_clear:${annotation.structuralArtifactId}`)
if (structural.qualityStatus !== 'passed') await reviewOwnerPublicArtifact({ ownerUserId: source.ownerUserId, artifactId: structural.id, qualityStatus: 'passed', qualityNote: annotation.qualityNote })
const labels = seoGeoMultilabelSchema.parse(annotation.labels)
const [existing] = await database.select({ id: publicIntelligenceArtifacts.id, qualityStatus: publicIntelligenceArtifacts.qualityStatus }).from(publicIntelligenceArtifacts).where(and(
  eq(publicIntelligenceArtifacts.sourceId, source.id), eq(publicIntelligenceArtifacts.artifactType, 'human_annotation'), eq(publicIntelligenceArtifacts.sourceUrl, annotation.sourceUrl), isNull(publicIntelligenceArtifacts.removedAt),
)).limit(1)
const human = existing || await createOwnerPublicArtifact({ ownerUserId: source.ownerUserId, sourceId: source.id, sourceUrl: annotation.sourceUrl, canonicalUrl: annotation.sourceUrl, artifactType: 'human_annotation', artifactText: annotation.artifactText, sourceLocator: annotation.sourceLocator, sourceSpanHash: structural.sourceSpanHash, fieldData: labels, language: 'en', extractionMethod: 'human_annotation', requestedUse: 'training_candidate', retentionUntil: source.retentionUntil })
if (human.qualityStatus !== 'passed') await reviewOwnerPublicArtifact({ ownerUserId: source.ownerUserId, artifactId: human.id, qualityStatus: 'passed', qualityNote: annotation.qualityNote })
console.log(JSON.stringify({ sourceUrl: annotation.sourceUrl, structuralArtifactId: structural.id, humanAnnotationId: human.id, primaryJourneyStage: labels.primaryJourneyStage, status: existing ? 'retained_existing' : 'passed' }))
